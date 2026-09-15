"""
Narrator service B — TTS worker.

Polls NARRATOR.APP.JOBS, does the work, writes audio to a stage, updates the
row. No HTTP surface: service A reaches this only through the job table, which
is why no networking or external access integration is involved anywhere.

Runs in two environments from one codebase:

  * SPCS   — OAuth via the mounted session token; stages are volume mounts, so
             audio is ordinary file I/O.
  * local  — a named connection from connections.toml; stages are reached with
             PUT/GET because volume mounts don't exist off-platform.

The StageIO class below is the only thing that differs between them.
"""
from __future__ import annotations

import os
import shutil
import socket
import signal
import sys
import tempfile
import threading
import time
import traceback
import uuid
from typing import Any, Optional

import snowflake.connector

# Importing the adapter loads the TTS model, so it happens once at startup.
import adapter

# Pure text handling: pause tags and chunk boundaries. No model, no GPU.
import planning

# --- configuration ----------------------------------------------------------
def _worker_id() -> str:
    """A name unique to this service INSTANCE.

    Every instance of an SPCS service gets the same environment, so a WORKER_ID
    supplied as an env var is shared by all of them. With more than one instance
    they would all MERGE into the same WORKER_STATUS row and each would appear to
    be doing whatever the last one to write was doing — and, worse, the orphan
    reaper keys on worker_id, so one worker's heartbeat would vouch for another's
    abandoned jobs and they would never be requeued.

    The container hostname is distinct per instance, and it is what the SPCS docs
    use to give an instance its identity (there is no SNOWFLAKE_SERVICE_INSTANCE_ID
    for services — SNOWFLAKE_JOB_INDEX exists only for job services). An env-var
    WORKER_ID is still honoured as a prefix so the spec can label a deployment.
    """
    host = socket.gethostname() or f"pid{os.getpid()}"
    prefix = os.environ.get("WORKER_ID", "").strip()
    return f"{prefix}-{host}" if prefix else f"worker-{host}"


WORKER_ID = _worker_id()
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "5"))
HEARTBEAT_SECONDS = float(os.environ.get("HEARTBEAT_SECONDS", "10"))

# How stale a worker's heartbeat must be before jobs it claimed are considered
# orphaned and requeued. Generously wide relative to HEARTBEAT_SECONDS: the cost
# of reaping too eagerly is a duplicated multi-minute generation, whereas the
# cost of waiting is only that a wedged job takes longer to recover.
ORPHAN_AFTER_SECONDS = float(os.environ.get("ORPHAN_AFTER_SECONDS", "120"))

# How many times a single chunk may be generated before its best failing take is
# accepted. Three, not more: each attempt already generates `takes_per_chunk`
# candidates, so this is a ceiling of 3 x takes on ONE chunk, and a chunk that
# cannot validate in three independent attempts is very unlikely to be fixed by a
# fourth — at that point the text itself is the problem and a human should see it.
MAX_CHUNK_ATTEMPTS = int(os.environ.get("NARRATOR_MAX_CHUNK_ATTEMPTS", "3"))
REAP_EVERY_SECONDS = float(os.environ.get("REAP_EVERY_SECONDS", "60"))

DATABASE = os.environ.get("NARRATOR_DATABASE", "NARRATOR")
SCHEMA = os.environ.get("NARRATOR_SCHEMA", "APP")
# Empty means "do not ask for one". A service already runs its queries on the
# QUERY_WAREHOUSE set on the service object, so naming a warehouse here as well
# only creates a second place that has to agree — and a wrong value here fails the
# connection outright rather than falling back. Left overridable for local runs,
# where a named connection may have no default warehouse of its own.
WAREHOUSE = os.environ.get("NARRATOR_WAREHOUSE", "").strip()

# Local runs use a named connection; SPCS ignores this.
CONNECTION_NAME = os.environ.get("SNOWFLAKE_CONNECTION_NAME")

SESSION_TOKEN_PATH = "/snowflake/session/token"

# Stage volume mounts (SPCS only). When a path is absent we fall back to PUT/GET.
MOUNTS = {
    "ENROLLMENT_AUDIO": os.environ.get("MOUNT_ENROLLMENT", "/mnt/enrollment"),
    "VOICE_PROFILES": os.environ.get("MOUNT_VOICES", "/mnt/voices"),
    "NARRATION_AUDIO": os.environ.get("MOUNT_NARRATIONS", "/mnt/narrations"),
}

_shutdown = False


def _handle_signal(signum, _frame):
    global _shutdown
    print(f"[worker] signal {signum}; finishing current job then exiting", flush=True)
    _shutdown = True


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


# --- Snowflake --------------------------------------------------------------

def connect():
    if os.path.exists(SESSION_TOKEN_PATH):
        with open(SESSION_TOKEN_PATH) as fh:
            token = fh.read().strip()
        print("[worker] connecting via SPCS session token", flush=True)
        return snowflake.connector.connect(
            host=os.environ["SNOWFLAKE_HOST"],
            account=os.environ["SNOWFLAKE_ACCOUNT"],
            token=token,
            authenticator="oauth",
            database=DATABASE,
            schema=SCHEMA,
            client_session_keep_alive=True,
            **({"warehouse": WAREHOUSE} if WAREHOUSE else {}),
        )

    if CONNECTION_NAME:
        print(f"[worker] connecting via named connection '{CONNECTION_NAME}'", flush=True)
        return snowflake.connector.connect(
            connection_name=CONNECTION_NAME,
            database=DATABASE,
            schema=SCHEMA,
            client_session_keep_alive=True,
            **({"warehouse": WAREHOUSE} if WAREHOUSE else {}),
        )

    print("[worker] connecting via environment credentials", flush=True)
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        password=os.environ.get("SNOWFLAKE_PASSWORD"),
        role=os.environ.get("SNOWFLAKE_ROLE"),
        database=DATABASE,
        schema=SCHEMA,
        client_session_keep_alive=True,
        **({"warehouse": WAREHOUSE} if WAREHOUSE else {}),
    )


class StageIO:
    """Read and write stage files, whether mounted or not.

    On SPCS the stages are volume mounts and this is plain file I/O. Locally
    there are no mounts, so files move with PUT/GET through the session. Callers
    always work in terms of stage-relative paths, so the tables store the same
    values either way.
    """

    def __init__(self, conn):
        self.conn = conn
        self.scratch = tempfile.mkdtemp(prefix="narrator-stage-")
        self.mounted = {
            stage: path for stage, path in MOUNTS.items() if os.path.isdir(path)
        }
        mode = "mounted" if self.mounted else "PUT/GET"
        print(f"[worker] stage access mode: {mode}", flush=True)

    def fetch(self, stage: str, rel_path: str) -> str:
        """Return a local path holding the stage file's contents."""
        if stage in self.mounted:
            local = os.path.join(self.mounted[stage], rel_path)
            if not os.path.exists(local):
                raise FileNotFoundError(f"@{stage}/{rel_path} not found at {local}")
            return local

        dest_dir = os.path.join(self.scratch, "get", os.path.dirname(rel_path))
        os.makedirs(dest_dir, exist_ok=True)
        self.conn.cursor().execute(
            f"GET '@{DATABASE}.{SCHEMA}.{stage}/{rel_path}' 'file://{dest_dir}'"
        )
        local = os.path.join(dest_dir, os.path.basename(rel_path))
        if not os.path.exists(local):
            raise FileNotFoundError(f"GET produced no file for @{stage}/{rel_path}")
        return local

    def store(self, stage: str, local_path: str, rel_path: str) -> None:
        """Place a local file at a stage-relative path."""
        if stage in self.mounted:
            dest = os.path.join(self.mounted[stage], rel_path)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.abspath(dest) != os.path.abspath(local_path):
                # Written sequentially then closed: stage volumes support
                # neither random writes nor appends.
                shutil.copyfile(local_path, dest)
            return

        # PUT uploads under a directory and keeps the filename, so stage the file
        # under the exact basename the caller asked for.
        want_name = os.path.basename(rel_path)
        subdir = os.path.dirname(rel_path)
        staged = os.path.join(self.scratch, "put", want_name)
        os.makedirs(os.path.dirname(staged), exist_ok=True)
        if os.path.abspath(staged) != os.path.abspath(local_path):
            shutil.copyfile(local_path, staged)

        target = f"@{DATABASE}.{SCHEMA}.{stage}/{subdir}/" if subdir else f"@{DATABASE}.{SCHEMA}.{stage}/"
        self.conn.cursor().execute(
            f"PUT 'file://{staged}' '{target}' AUTO_COMPRESS = FALSE OVERWRITE = TRUE"
        )

    def local_scratch(self, name: str) -> str:
        path = os.path.join(self.scratch, "work", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path


def heartbeat(
    conn,
    state: str,
    model_loaded: bool,
    *,
    phase: Optional[str] = None,
    done: Optional[int] = None,
    total: Optional[int] = None,
    job_id: Optional[str] = None,
) -> None:
    """Publish liveness to WORKER_STATUS — this replaces an HTTP health endpoint.

    Also carries progress. Generation is one blocking call lasting many minutes,
    and this used to be written only between jobs, so the UI's 60-second
    staleness check fired during every real run and reported "it may have
    crashed" exactly when the worker was busiest. Worse, reap_orphaned_jobs()
    treats a stale heartbeat as a dead worker, so a long job was at risk of being
    requeued out from under itself. Writing from inside the generation loop fixes
    both, and the progress fields come along for free.
    """
    conn.cursor().execute(
        """
        MERGE INTO WORKER_STATUS t
        USING (SELECT %s AS worker_id) s ON t.worker_id = s.worker_id
        WHEN MATCHED THEN UPDATE SET
            state = %s, model_loaded = %s, heartbeat_at = CURRENT_TIMESTAMP(),
            phase = %s, progress_done = %s, progress_total = %s, current_job_id = %s
        WHEN NOT MATCHED THEN INSERT (worker_id, state, model_loaded, heartbeat_at,
                                      phase, progress_done, progress_total, current_job_id)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP(), %s, %s, %s, %s)
        """,
        (
            WORKER_ID,
            state, model_loaded, phase, done, total, job_id,
            WORKER_ID, state, model_loaded, phase, done, total, job_id,
        ),
    )


# A DB round trip per Whisper candidate would add real latency: a 15-chunk job at
# 3 takes makes ~60 of these calls. The monitor thread below does the writing on a
# timer instead, so the generation path only touches memory.
PROGRESS_INTERVAL_SECONDS = 10.0


def job_cancel_requested(conn, job_id: str) -> bool:
    row = conn.cursor().execute(
        "SELECT cancel_requested FROM JOBS WHERE job_id = %s", (job_id,)
    ).fetchone()
    return bool(row and row[0])


class JobMonitor:
    """Heartbeats and polls for cancellation on a timer while a job runs.

    Why a thread rather than doing this inside the progress hook: the hook only
    fires when a chunk *finishes*. Chunks run concurrently, so the first one can
    take well over a minute, and a measured run went 108 seconds with no
    heartbeat at all — long enough for the UI to declare the worker dead and for
    reap_orphaned_jobs() to consider requeueing the job. Liveness must not depend
    on how long a unit of work happens to take.

    The hook now only updates memory; this thread owns every database write and
    the cancel poll. Cancellation is latched, so once requested it is reported
    even if the poll later fails.

    Takes its OWN connection. The Snowflake connector expects one connection per
    thread, and the main thread uses its connection immediately either side of
    generation (reading the narration, then writing the result), so sharing one
    would risk interleaved use of the same session.
    """

    def __init__(self, conn, job_id: str):
        self._conn = conn
        self._job_id = job_id
        self._lock = threading.Lock()
        self._phase: Optional[str] = None
        self._done: Optional[int] = None
        self._total: Optional[int] = None
        self._cancelled = False
        self._stop = threading.Event()
        # Daemon: a hung monitor must never keep the container alive on shutdown.
        self._thread = threading.Thread(
            target=self._run, name=f"job-monitor-{job_id[:8]}", daemon=True
        )

    def start(self) -> "JobMonitor":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        # This connection belongs to the monitor alone, so closing it here is what
        # stops one session leaking per job over a long-lived container.
        try:
            self._conn.close()
        except Exception:
            pass

    def update(self, phase: str, done: int, total: int) -> None:
        """Called from the generation hook. Memory only — never blocks on I/O."""
        with self._lock:
            self._phase, self._done, self._total = phase, done, total

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def _run(self) -> None:
        # Publish immediately so there is no gap between claiming the job and the
        # first heartbeat.
        while True:
            with self._lock:
                phase, done, total = self._phase, self._done, self._total
            try:
                heartbeat(
                    self._conn, "BUSY", True,
                    phase=phase, done=done, total=total, job_id=self._job_id,
                )
                if job_cancel_requested(self._conn, self._job_id):
                    with self._lock:
                        self._cancelled = True
                    print(
                        f"[worker] cancel requested for job {self._job_id}",
                        flush=True,
                    )
                    return
            except Exception as exc:  # noqa: BLE001 - monitoring must not fail the job
                print(f"[worker] monitor update failed: {exc}", flush=True)
            if self._stop.wait(PROGRESS_INTERVAL_SECONDS):
                return


def make_progress_callback(monitor: "JobMonitor"):
    """Adapt a JobMonitor to the hook signature the patched Chatter expects.

    Returning False asks Chatter to abort. This does no I/O at all, so it is safe
    to call once per Whisper candidate.
    """

    def cb(phase: str, done: int, total: int):
        monitor.update(phase, done, total)
        return not monitor.cancelled

    return cb


# The monitor for the job currently in flight. A module global because the job
# handlers are plain functions called through a dispatch table and threading a
# monitor argument through all of them would change every signature for the sake
# of one optional phase update. Only the job loop assigns it.
CURRENT_MONITOR: Optional["JobMonitor"] = None


def report_phase(phase: str, done: int = 1, total: int = 1) -> None:
    """Let a job handler name the phase it is in. No-op when unmonitored."""
    if CURRENT_MONITOR is not None:
        CURRENT_MONITOR.update(phase, done, total)


def reap_orphaned_jobs(conn, include_own: bool = False) -> int:
    """Requeue RUNNING jobs whose owning worker has stopped heartbeating.

    A worker can die without ever running its own error handler — a native crash
    in the inference stack takes the process out with SIGSEGV, and SIGKILL is not
    catchable either. The job it had claimed then stays RUNNING forever, and
    because claim_job only looks at QUEUED rows nothing will ever pick it up
    again: the narration is wedged in GENERATING and the UI polls a state that
    will never change. So recovery cannot live in the dying process; it has to be
    a sweep done by whoever is alive.

    A job is an orphan when its worker's last heartbeat is older than
    ORPHAN_AFTER_SECONDS, or when there is no WORKER_STATUS row for it at all
    (the row is gone, or the job was claimed by a worker that never registered).
    The margin over HEARTBEAT_SECONDS is deliberately wide so a worker that is
    merely busy inside a long generation is never mistaken for a dead one.

    `include_own` additionally reaps jobs stamped with our own WORKER_ID. That
    case is invisible to the heartbeat test: WORKER_ID is stable whenever it comes
    from the environment (as it does under SPCS), so a restarted worker publishes
    a fresh heartbeat under the same id and thereby vouches for the very job its
    dead predecessor abandoned. At startup any RUNNING job bearing our id must be
    from a previous incarnation, since this process has not claimed anything yet.
    It is only ever safe to pass this before the poll loop begins.

    Returns the number of jobs requeued. Also clears the matching narrations back
    to QUEUED so the UI reflects that the work is pending again rather than in
    flight.
    """
    cur = conn.cursor()
    cur.execute(
        f"""
        UPDATE JOBS j
           SET state = 'QUEUED', worker_id = NULL, started_at = NULL,
               failure_reason = 'requeued: worker ' || COALESCE(j.worker_id, '?')
                                || ' stopped heartbeating'
         WHERE j.state = 'RUNNING'
           AND ({'j.worker_id = %s OR' if include_own else ''} NOT EXISTS (
                 SELECT 1 FROM WORKER_STATUS w
                  WHERE w.worker_id = j.worker_id
                    AND TIMESTAMPDIFF('second', w.heartbeat_at, CURRENT_TIMESTAMP())
                        <= %s))
        """,
        ((WORKER_ID, ORPHAN_AFTER_SECONDS) if include_own else (ORPHAN_AFTER_SECONDS,)),
    )
    reaped = cur.rowcount or 0
    if reaped:
        # A narration whose PLAN was requeued goes back to QUEUED, because nothing
        # downstream of it exists yet. This clause named the retired GENERATE kind
        # until the fan-out landed, which meant it silently matched nothing and an
        # orphaned PLAN left its narration stuck in GENERATING for ever.
        #
        # Only PLAN. A requeued GENERATE_CHUNK or ASSEMBLE must leave the narration
        # GENERATING: the other chunks are still valid and still being worked on, and
        # flipping the parent back to QUEUED would misreport that as not started.
        #
        # Enrollment takes need no equivalent — handle_enroll rewrites take state
        # from scratch when its job is retried.
        cur.execute(
            """
            UPDATE NARRATIONS n SET state = 'QUEUED'
             WHERE n.state = 'GENERATING'
               AND EXISTS (SELECT 1 FROM JOBS j
                            WHERE j.ref_id = n.narration_id
                              AND j.kind = 'PLAN'
                              AND j.state = 'QUEUED')
            """
        )
        print(f"[worker] reaped {reaped} orphaned job(s) back to QUEUED", flush=True)
    return reaped


def claim_job(conn) -> Optional[dict[str, Any]]:
    """Atomically claim the oldest QUEUED job, or return None.

    Snowflake has no SELECT ... FOR UPDATE, so this is an optimistic claim:
    pick a candidate, UPDATE guarded on the state still being QUEUED, and check
    the affected row count. A losing racer sees 0 rows and retries.

    ASSEMBLE jobs are held back until every chunk of their narration has finished.
    Doing it in the claim, rather than letting the handler discover it and requeue,
    matters once there are several workers: a worker that claimed a premature
    ASSEMBLE would either busy-loop on it or hand it back repeatedly while real
    chunk work waited behind it.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT job_id, kind, ref_id, ref_index FROM JOBS j
         WHERE j.state = 'QUEUED'
           AND (
                 j.kind <> 'ASSEMBLE'
                 OR NOT EXISTS (
                      SELECT 1 FROM NARRATION_CHUNKS c
                       WHERE c.narration_id = j.ref_id
                         AND c.state NOT IN ('READY', 'FAILED')
                 )
               )
         ORDER BY j.submitted_at LIMIT 1
        """
    )
    row = cur.fetchone()
    if not row:
        return None
    job_id, kind, ref_id, ref_index = row

    cur.execute(
        "UPDATE JOBS SET state = 'RUNNING', worker_id = %s, started_at = CURRENT_TIMESTAMP() "
        "WHERE job_id = %s AND state = 'QUEUED'",
        (WORKER_ID, job_id),
    )
    if cur.rowcount != 1:
        return None
    return {"job_id": job_id, "kind": kind, "ref_id": ref_id, "ref_index": ref_index}


def enqueue(
    conn,
    kind: str,
    ref_id: str,
    ref_index: Optional[int] = None,
    inherit_position: bool = False,
) -> str:
    """Queue a job. `inherit_position` keeps this chunk's place in the queue.

    Jobs are claimed oldest-first, so a retry stamped with the current time goes to
    the BACK of the queue — behind every chunk of every narration submitted since.
    Measured consequence: a narration 17/18 complete had to wait for all 18 chunks of
    a second narration before its one failed chunk could regenerate, and its ASSEMBLE
    is blocked on that chunk, so the whole narration stalled for minutes with one
    sentence outstanding.
    """
    job_id = str(uuid.uuid4())
    if inherit_position:
        # The EARLIEST job for this same chunk, so a third attempt inherits the
        # original position rather than the second attempt's. Falls back to now if
        # there is somehow no prior job, so a retry can never be lost.
        conn.cursor().execute(
            "INSERT INTO JOBS (job_id, kind, ref_id, ref_index, state, submitted_at) "
            "SELECT %s, %s, %s, %s, 'QUEUED', "
            "  COALESCE((SELECT MIN(submitted_at) FROM JOBS "
            "             WHERE ref_id = %s AND kind = %s AND ref_index = %s), "
            "           CURRENT_TIMESTAMP())",
            (job_id, kind, ref_id, ref_index, ref_id, kind, ref_index),
        )
    else:
        conn.cursor().execute(
            "INSERT INTO JOBS (job_id, kind, ref_id, ref_index, state, submitted_at) "
            "SELECT %s, %s, %s, %s, 'QUEUED', CURRENT_TIMESTAMP()",
            (job_id, kind, ref_id, ref_index),
        )
    return job_id


def finish_job(conn, job_id: str, failure_reason: Optional[str] = None) -> None:
    conn.cursor().execute(
        "UPDATE JOBS SET state = %s, finished_at = CURRENT_TIMESTAMP(), failure_reason = %s "
        "WHERE job_id = %s",
        ("FAILED" if failure_reason else "DONE", failure_reason, job_id),
    )


# --- job handlers -----------------------------------------------------------

def handle_enroll(conn, io: StageIO, take_id: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "SELECT speaker_id, audio_path FROM ENROLLMENT_TAKES WHERE take_id = %s",
        (take_id,),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"enrollment take {take_id} not found")
    speaker_id, audio_rel = row
    if not audio_rel:
        raise RuntimeError(f"enrollment take {take_id} has no audio_path")

    src = io.fetch("ENROLLMENT_AUDIO", audio_rel)
    processed_local = io.local_scratch(f"{take_id}.wav")

    scores = adapter.preprocess_enrollment(src, processed_local)
    reason = adapter.judge_take(scores)

    processed_rel = f"processed/{take_id}.wav"
    io.store("ENROLLMENT_AUDIO", processed_local, processed_rel)

    # processed_path, NOT audio_path. audio_path is the raw upload and is treated
    # as immutable: it is this handler's INPUT, so overwriting it made a re-run
    # read its own output and normalise already-normalised audio. It also stranded
    # the raw file, since nothing recorded where it had been.
    cur.execute(
        """
        UPDATE ENROLLMENT_TAKES
           SET processed_path = %s, snr_db = %s, clip_ratio = %s, silence_ratio = %s,
               duration_ms = %s, accepted = %s, reject_reason = %s
         WHERE take_id = %s
        """,
        (
            processed_rel, scores.snr_db, scores.clip_ratio, scores.silence_ratio,
            scores.duration_ms, reason is None, reason, take_id,
        ),
    )

    if reason is not None:
        print(f"[worker] take {take_id} REJECTED: {reason}", flush=True)
        return

    ref_rel = f"{speaker_id}/reference.wav"
    io.store("VOICE_PROFILES", processed_local, ref_rel)
    cur.execute(
        "UPDATE SPEAKERS SET ref_clip_path = %s, state = 'READY' WHERE speaker_id = %s",
        (ref_rel, speaker_id),
    )
    print(
        f"[worker] take {take_id} ACCEPTED "
        f"(snr={scores.snr_db}dB, {scores.duration_ms/1000:.1f}s); "
        f"speaker {speaker_id} READY",
        flush=True,
    )




def handle_plan(conn, io: StageIO, narration_id: str) -> None:
    """Split a narration into chunk rows and fan out one job per chunk.

    Chunking happens here, in Python, using Extended's own grouping via
    adapter.chunk_text(). Verified byte-identical to the single-job path on a real
    18-chunk script; reimplementing it in the app would let the two drift apart
    with no test that notices.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT script_text, takes_per_chunk, state FROM NARRATIONS WHERE narration_id = %s",
        (narration_id,),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"narration {narration_id} not found")
    script_text, takes_per_chunk, state = row
    if not (script_text or "").strip():
        raise RuntimeError("narration has an empty script")

    planned = planning.plan_chunks(script_text, adapter.chunk_text)
    if not planned:
        raise RuntimeError("script produced no chunks")

    # Re-planning must be idempotent: a reaped or retried PLAN job has to be able
    # to run again without leaving the previous attempt's rows behind.
    cur.execute("DELETE FROM NARRATION_CHUNKS WHERE narration_id = %s", (narration_id,))
    for c in planned:
        cur.execute(
            "INSERT INTO NARRATION_CHUNKS "
            "  (narration_id, chunk_index, text, pause_after_ms, state, takes, updated_on) "
            "SELECT %s, %s, %s, %s, 'QUEUED', %s, CURRENT_TIMESTAMP()",
            (narration_id, c.index, c.text, c.pause_after_ms, int(takes_per_chunk or 3)),
        )

    for c in planned:
        enqueue(conn, "GENERATE_CHUNK", narration_id, c.index)
    enqueue(conn, "ASSEMBLE", narration_id)

    cur.execute(
        "UPDATE NARRATIONS SET state = 'GENERATING' WHERE narration_id = %s",
        (narration_id,),
    )
    print(
        f"[worker] planned {narration_id}: {planning.describe_plan(planned)}",
        flush=True,
    )


def handle_generate_chunk(conn, io: StageIO, narration_id: str, chunk_index: int) -> None:
    """Generate one chunk and store its audio, score and artifact measurements."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT c.text, c.takes, n.base_seed, n.exaggeration, n.temperature,
               n.cfg_weight, s.ref_clip_path, s.state, c.attempt,
               (SELECT COUNT(*) FROM NARRATION_CHUNKS t
                 WHERE t.narration_id = c.narration_id) AS total_chunks
          FROM NARRATION_CHUNKS c
          JOIN NARRATIONS n ON n.narration_id = c.narration_id
          JOIN SPEAKERS  s ON s.speaker_id   = n.speaker_id
         WHERE c.narration_id = %s AND c.chunk_index = %s
        """,
        (narration_id, chunk_index),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"chunk {narration_id}#{chunk_index} not found")
    (text, takes, base_seed, exaggeration, temperature, cfg_weight, ref_path,
     spk_state, attempt, total_chunks) = row
    if spk_state != "READY":
        raise RuntimeError(f"speaker is {spk_state}, not READY")

    cur.execute(
        "UPDATE NARRATION_CHUNKS SET state = 'GENERATING', updated_on = CURRENT_TIMESTAMP() "
        "WHERE narration_id = %s AND chunk_index = %s",
        (narration_id, chunk_index),
    )

    local_ref = io.fetch("VOICE_PROFILES", ref_path)

    # Seed derived from the narration seed, the chunk index and the attempt number.
    #
    # The first two make a narration reproducible from one base_seed while keeping
    # chunks uncorrelated. The attempt term is what makes repair mean anything:
    # without it a regenerated chunk would draw the identical seed, produce
    # byte-identical audio, and a chunk that failed validation would fail again in
    # exactly the same way. Two different primes so that stepping the attempt can
    # never land on another chunk's seed.
    attempt_n = int(attempt or 0)
    seed = (
        int(base_seed or 0) + chunk_index * 10_007 + attempt_n * 7_919
    ) & 0x7FFFFFFF
    # "chunk N of M" for the narration, not "N of 1". The previous form passed
    # total=1 and produced nonsense like "17/1" in the UI — a leftover from when one
    # job generated the whole narration and done/total described its internal
    # progress. A per-chunk job has no internal progress worth reporting, so the
    # useful numbers are the narration's.
    report_phase("GENERATING", chunk_index + 1, int(total_chunks or 1))

    result = adapter.generate_chunk(
        text=text,
        ref_wav_path=local_ref,
        base_seed=seed,
        output_basename=f"{narration_id}_{chunk_index:04d}",
        num_candidates=int(takes or 3),
        exaggeration=float(exaggeration if exaggeration is not None else 0.5),
        temperature=float(temperature if temperature is not None else 0.8),
        cfg_weight=float(cfg_weight if cfg_weight is not None else 0.5),
    )

    # Attempt is part of the path, so a repair never overwrites the take it is
    # trying to replace. A retry is a gamble — the new take can be worse — and
    # destroying the only copy of the previous one to find that out is exactly the
    # mistake the retry logic below is careful not to make. Assembly reads
    # audio_path from the row, so the previous file simply stops being referenced
    # and is cleaned up with the narration.
    #
    # Attempt 0 keeps the original flat name so rows written before this change
    # still resolve.
    rel = (
        f"{narration_id}/{chunk_index:04d}.wav"
        if attempt_n == 0
        else f"{narration_id}/{chunk_index:04d}_a{attempt_n}.wav"
    )
    io.store("CHUNK_AUDIO", result.path, rel)

    # Retry a chunk that no take could validate, rather than raising takes on every
    # chunk. This is the cheap direction: `takes_per_chunk` multiplies cost across
    # the WHOLE narration to protect against a failure that, measured, affects
    # roughly one chunk in twenty. Retrying only the chunk that actually failed
    # costs one chunk's generation instead of eighteen.
    #
    # The audio is stored and the row is filled in FIRST, every time, even when a
    # retry is coming. A stored take that failed validation is still the best audio
    # in existence for that chunk, and if the retry also fails — or the worker dies
    # between the two — the narration can still be assembled from it. Never discard
    # the only copy of something in the hope that the next attempt is better.
    retrying = (
        not result.passed
        and result.measured
        and attempt_n + 1 < MAX_CHUNK_ATTEMPTS
    )
    next_state = "QUEUED" if retrying else "READY"

    cur.execute(
        """
        UPDATE NARRATION_CHUNKS
           SET state = %s, audio_path = %s, duration_ms = %s, score = %s,
               gap_seconds = %s, gap_quiet_db = %s, seed = %s, failure_reason = %s,
               attempt = %s, updated_on = CURRENT_TIMESTAMP()
         WHERE narration_id = %s AND chunk_index = %s
        """,
        (next_state, rel, result.duration_ms, result.score, result.gap_seconds,
         result.gap_quiet_db, seed,
         None if result.passed else f"no take passed validation (best {result.score:.3f})",
         attempt_n, narration_id, chunk_index),
    )

    if retrying:
        # attempt is bumped on the row so the requeued job derives a different seed
        # and therefore genuinely different takes.
        cur.execute(
            """
            UPDATE NARRATION_CHUNKS
               SET attempt = %s, repair_reason = 'WHISPER',
                   updated_on = CURRENT_TIMESTAMP()
             WHERE narration_id = %s AND chunk_index = %s
            """,
            (attempt_n + 1, narration_id, chunk_index),
        )
        # Inherit this job's queue position so the retry runs with its narration's
        # other chunks rather than behind everything submitted since.
        enqueue(
            conn,
            "GENERATE_CHUNK",
            narration_id,
            ref_index=chunk_index,
            inherit_position=True,
        )
        print(
            f"[worker] chunk {narration_id}#{chunk_index} no take passed "
            f"(best {result.score:.3f}); requeued as attempt {attempt_n + 1} "
            f"of {MAX_CHUNK_ATTEMPTS}",
            flush=True,
        )
        return
    print(
        f"[worker] chunk {narration_id}#{chunk_index} READY "
        f"({result.duration_ms/1000:.1f}s, score={result.score:.3f}, "
        f"gap={result.gap_seconds:.1f}s/{result.gap_quiet_db:.0f}dB, "
        f"attempt={attempt_n})",
        flush=True,
    )


def handle_assemble(conn, io: StageIO, narration_id: str) -> None:
    """Concatenate chunk audio, insert pause silence, and produce the final file.

    All loudness normalisation happens HERE, once, on the joined audio. Doing it
    per chunk would normalise each chunk to the same target independently, which
    flattens the natural level differences between sentences and can leave audible
    steps at joins.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT format FROM NARRATIONS WHERE narration_id = %s", (narration_id,)
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"narration {narration_id} not found")
    export_format = (row[0] or "mp3").lower()

    cur.execute(
        "SELECT chunk_index, audio_path, pause_after_ms, state, failure_reason "
        "  FROM NARRATION_CHUNKS WHERE narration_id = %s ORDER BY chunk_index",
        (narration_id,),
    )
    rows = cur.fetchall()
    if not rows:
        raise RuntimeError("no chunks to assemble")

    failed = [r[0] for r in rows if r[3] != "READY"]
    if failed:
        # Refusing here is deliberate: shipping a narration with chunks silently
        # missing would be worse than failing, because the gap is hard to notice
        # in four minutes of audio.
        raise RuntimeError(
            f"{len(failed)} chunk(s) did not generate: {failed[:8]}"
            + (" ..." if len(failed) > 8 else "")
        )

    report_phase("ASSEMBLING", 1, 1)
    pieces: list[tuple[str, int]] = []
    for chunk_index, audio_path, pause_ms, _state, _fr in rows:
        pieces.append((io.fetch("CHUNK_AUDIO", audio_path), int(pause_ms or 0)))

    out_local = adapter.assemble(
        pieces=pieces,
        output_basename=narration_id,
        export_format=export_format,
    )

    out_rel = f"{narration_id}.{export_format}"
    io.store("NARRATION_AUDIO", out_local, out_rel)
    duration_ms = adapter.probe_duration_ms(out_local)
    cur.execute(
        "UPDATE NARRATIONS SET audio_path = %s, format = %s, duration_ms = %s, "
        "state = 'READY' WHERE narration_id = %s",
        (out_rel, export_format, duration_ms, narration_id),
    )
    total_pause = sum(p for _f, p in pieces)
    print(
        f"[worker] narration {narration_id} READY -> {out_rel} "
        f"({len(pieces)} chunks, {duration_ms/1000:.1f}s audio, "
        f"{total_pause/1000:.1f}s inserted silence)",
        flush=True,
    )


HANDLERS = {
    "ENROLL": handle_enroll,
    "PLAN": handle_plan,
    "GENERATE_CHUNK": handle_generate_chunk,
    "ASSEMBLE": handle_assemble,
}

# Job kinds whose outcome is the state of a whole narration. GENERATE_CHUNK is
# deliberately absent: a failed chunk marks the CHUNK failed, not the narration, so
# one bad sentence does not condemn seventeen good ones.
NARRATION_KINDS = {"PLAN", "ASSEMBLE"}


def _record_outcome(
    conn,
    kind: str,
    ref_id: str,
    ref_index: Optional[int],
    state: str,
    reason: Optional[str],
) -> None:
    """Write a terminal state to whatever the job was actually working on.

    A failed GENERATE_CHUNK marks the CHUNK failed, not the narration: the other
    17 chunks may be perfectly good, and ASSEMBLE is what decides whether the
    narration can still be produced. Marking the narration here would throw away
    work that only needs one chunk regenerating.

    A cancelled chunk does mark the narration cancelled as well, because cancel is
    always a whole-narration intent — nobody cancels chunk 7 of 18 on its own.
    """
    cur = conn.cursor()
    if kind == "GENERATE_CHUNK" and ref_index is not None:
        cur.execute(
            "UPDATE NARRATION_CHUNKS SET state = %s, failure_reason = %s, "
            "updated_on = CURRENT_TIMESTAMP() "
            "WHERE narration_id = %s AND chunk_index = %s",
            (state, reason, ref_id, int(ref_index)),
        )
        if state != "CANCELLED":
            return
    if kind in NARRATION_KINDS or state == "CANCELLED":
        cur.execute(
            "UPDATE NARRATIONS SET state = %s WHERE narration_id = %s",
            (state, ref_id),
        )


# --- main loop --------------------------------------------------------------

def main() -> int:
    print(f"[worker] {WORKER_ID} starting; device={adapter.device()}", flush=True)

    conn = connect()
    io = StageIO(conn)

    # Drop long-dead worker rows. WORKER_STATUS is keyed by worker_id and the id is
    # tied to the container hostname, so every replacement container leaves its
    # predecessor's row behind, claiming whatever state it last wrote. The UI counts
    # live workers from this table, so without pruning the count only ever grows.
    #
    # Thirty minutes is far outside any legitimate heartbeat gap (HEARTBEAT_SECONDS
    # is 10), so this cannot remove a row belonging to a worker that is merely busy.
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM WORKER_STATUS "
                "WHERE heartbeat_at < DATEADD('minute', -30, CURRENT_TIMESTAMP())"
            )
    except Exception as exc:  # pragma: no cover - housekeeping must never block boot
        print(f"[worker] could not prune stale worker rows: {exc}", flush=True)

    heartbeat(conn, "LOADING_MODEL", False)

    try:
        adapter.ensure_model()
    except Exception as exc:
        print(f"[worker] FATAL: {exc}", flush=True)
        heartbeat(conn, "STARTING", False)
        return 1

    heartbeat(conn, "IDLE", True)
    print("[worker] model ready; polling for jobs", flush=True)
    last_beat = time.time()

    # Sweep once before taking any work: if the previous worker died mid-job, its
    # job is sitting in RUNNING and would otherwise never be retried. include_own
    # is safe here and only here — we have not claimed anything yet, so a RUNNING
    # job carrying our id can only belong to a dead predecessor.
    try:
        reap_orphaned_jobs(conn, include_own=True)
    except Exception as exc:
        print(f"[worker] startup reap failed: {exc}", flush=True)
    last_reap = time.time()

    while not _shutdown:
        # Reap on a timer too, so a worker that dies while this one is idle gets
        # its job recovered without waiting for a restart.
        if time.time() - last_reap >= REAP_EVERY_SECONDS:
            try:
                reap_orphaned_jobs(conn)
            except Exception as exc:
                print(f"[worker] reap failed: {exc}", flush=True)
            last_reap = time.time()

        try:
            job = claim_job(conn)
        except Exception as exc:
            print(f"[worker] claim failed: {exc}", flush=True)
            time.sleep(POLL_SECONDS)
            continue

        if job is None:
            if time.time() - last_beat >= HEARTBEAT_SECONDS:
                try:
                    heartbeat(conn, "IDLE", True)
                    last_beat = time.time()
                except Exception as exc:
                    print(f"[worker] heartbeat failed: {exc}", flush=True)
            time.sleep(POLL_SECONDS)
            continue

        job_id, kind, ref_id = job["job_id"], job["kind"], job["ref_id"]
        ref_index = job.get("ref_index")
        label = f"{kind} {job_id} (ref={ref_id}" + (
            f"#{int(ref_index)})" if ref_index is not None else ")"
        )
        print(f"[worker] claimed {label}", flush=True)
        heartbeat(conn, "BUSY", True, job_id=job_id)
        last_beat = time.time()

        handler = HANDLERS.get(kind)
        if handler is None:
            finish_job(conn, job_id, f"unknown job kind: {kind}")
            continue

        # Attach progress + cancellation for the duration of this job only. The
        # monitor gets its own connection so its thread never shares a session
        # with the main one.
        global CURRENT_MONITOR
        monitor: Optional[JobMonitor] = None
        try:
            monitor = JobMonitor(connect(), job_id).start()
            CURRENT_MONITOR = monitor
            if not adapter.set_progress_callback(
                make_progress_callback(monitor),
                cancel_cb=lambda: monitor.cancelled,
            ):
                print(
                    "[worker] WARNING: Chatter is not patched, so this job reports "
                    "no progress and cannot be cancelled mid-generation",
                    flush=True,
                )
        except Exception as exc:  # noqa: BLE001
            # A job that cannot be monitored is still a job worth running; it just
            # runs blind. Failing here would be worse than the thing it protects.
            print(f"[worker] could not start job monitor: {exc}", flush=True)

        try:
            # GENERATE_CHUNK is the only kind that addresses something smaller
            # than a whole narration, so it is the only one that needs the index.
            if kind == "GENERATE_CHUNK":
                if ref_index is None:
                    raise RuntimeError("GENERATE_CHUNK job has no ref_index")
                handler(conn, io, ref_id, int(ref_index))
            else:
                handler(conn, io, ref_id)
            finish_job(conn, job_id)
        except adapter.CANCELLED_EXCEPTION as exc:
            # Not a failure: the user asked for this. Keep the message distinct
            # from a crash so the UI can say "cancelled" rather than "failed".
            print(f"[worker] {kind} {job_id} cancelled: {exc}", flush=True)
            try:
                finish_job(conn, job_id, f"cancelled: {exc}"[:2000])
                _record_outcome(conn, kind, ref_id, ref_index, "CANCELLED", None)
            except Exception as inner:
                print(f"[worker] could not record cancellation: {inner}", flush=True)
        except Exception as exc:
            traceback.print_exc()
            reason = f"{type(exc).__name__}: {exc}"[:2000]
            try:
                finish_job(conn, job_id, reason)
                _record_outcome(conn, kind, ref_id, ref_index, "FAILED", reason)
            except Exception as inner:
                print(f"[worker] could not record failure: {inner}", flush=True)
        finally:
            adapter.clear_progress_callback()
            CURRENT_MONITOR = None
            if monitor is not None:
                monitor.stop()

        # Clears phase/progress/current_job_id as well as flipping to IDLE, so a
        # finished job cannot leave a stale progress bar on screen. Written after
        # the monitor has stopped, so it cannot be overwritten by a final tick.
        heartbeat(conn, "IDLE", True)
        last_beat = time.time()

    print("[worker] shutting down", flush=True)
    try:
        # STOPPED, not STARTING. Writing "STARTING" here left the last row claiming
        # the worker was coming up, so hours after a deliberate suspend the UI still
        # showed "STARTING" with an ever-growing heartbeat age — which reads as a
        # hung startup rather than a clean shutdown.
        heartbeat(conn, "STOPPED", False)
        conn.close()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
