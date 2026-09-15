/**
 * Narrator data access.
 *
 * Every query goes through querySnowflake / querySnowflakeLongRunning from
 * lib/snowflake.ts. All user-supplied values are passed as bind parameters —
 * never concatenated into SQL.
 *
 * Owner's rights throughout: this is a single-user prototype, and the GPU pool
 * controls in particular must work regardless of who is signed in.
 */
import { randomUUID } from "node:crypto"

import { querySnowflake } from "@/lib/snowflake"

const DB = "NARRATOR.APP"

/** The Snowflake JS driver returns TIMESTAMP columns as Date objects, not
 * strings. String(date) yields locale text that breaks both display and
 * sorting, so normalise at the boundary. */
export function toIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

/** Snowflake returns NUMBER as a JS number here, but FLOAT columns can arrive
 * as strings depending on driver settings — coerce defensively. */
function num(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = typeof val === "number" ? val : Number(val)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

export type SpeakerState = "DRAFT" | "ENROLLING" | "READY" | "REJECTED"

export interface Speaker {
  speakerId: string
  name: string
  refClipPath: string | null
  state: SpeakerState
  consentAt: string | null
  createdOn: string | null
}

export async function listSpeakers(): Promise<Speaker[]> {
  const rows = await querySnowflake(
    `SELECT speaker_id, name, ref_clip_path, state, consent_at, created_on
       FROM ${DB}.SPEAKERS
      ORDER BY created_on DESC`,
  )
  return rows.map((r: any) => ({
    speakerId: r.SPEAKER_ID,
    name: r.NAME,
    refClipPath: r.REF_CLIP_PATH ?? null,
    state: r.STATE,
    consentAt: toIso(r.CONSENT_AT),
    createdOn: toIso(r.CREATED_ON),
  }))
}

export async function listReadySpeakers(): Promise<Speaker[]> {
  return (await listSpeakers()).filter((s) => s.state === "READY")
}

/** Creates a speaker and records the consent attestation in the same step —
 * voice cloning should not be possible without one. */
export async function createSpeaker(name: string): Promise<string> {
  const rows = await querySnowflake(
    `INSERT INTO ${DB}.SPEAKERS (name, state, consent_at)
     SELECT ?, 'ENROLLING', CURRENT_TIMESTAMP()`,
    { binds: [name] },
  )
  void rows
  const created = await querySnowflake(
    `SELECT speaker_id FROM ${DB}.SPEAKERS
      WHERE name = ? ORDER BY created_on DESC LIMIT 1`,
    { binds: [name] },
  )
  return created[0]?.SPEAKER_ID
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface EnrollmentPrompt {
  promptId: string
  ordinal: number
  label: string | null
  style: string | null
  text: string
}

export async function listPrompts(): Promise<EnrollmentPrompt[]> {
  const rows = await querySnowflake(
    `SELECT prompt_id, ordinal, label, style, text
       FROM ${DB}.ENROLLMENT_PROMPTS ORDER BY ordinal`,
  )
  return rows.map((r: any) => ({
    promptId: r.PROMPT_ID,
    ordinal: num(r.ORDINAL) ?? 0,
    label: r.LABEL ?? null,
    style: r.STYLE ?? null,
    text: r.TEXT,
  }))
}

export interface EnrollmentTake {
  takeId: string
  speakerId: string
  audioPath: string | null
  /** Normalised derivative of audioPath, written by the worker. audioPath is the
   * raw upload and is never overwritten, so a take's input stays reproducible and
   * both files remain addressable for cleanup. */
  processedPath: string | null
  snrDb: number | null
  clipRatio: number | null
  silenceRatio: number | null
  durationMs: number | null
  accepted: boolean | null
  rejectReason: string | null
  createdOn: string | null
}

export async function listTakes(speakerId: string): Promise<EnrollmentTake[]> {
  const rows = await querySnowflake(
    `SELECT take_id, speaker_id, audio_path, processed_path, snr_db, clip_ratio,
            silence_ratio, duration_ms, accepted, reject_reason, created_on
       FROM ${DB}.ENROLLMENT_TAKES
      WHERE speaker_id = ?
      ORDER BY created_on DESC`,
    { binds: [speakerId] },
  )
  return rows.map((r: any) => ({
    takeId: r.TAKE_ID,
    speakerId: r.SPEAKER_ID,
    audioPath: r.AUDIO_PATH ?? null,
    processedPath: r.PROCESSED_PATH ?? null,
    snrDb: num(r.SNR_DB),
    clipRatio: num(r.CLIP_RATIO),
    silenceRatio: num(r.SILENCE_RATIO),
    durationMs: num(r.DURATION_MS),
    accepted: r.ACCEPTED === null ? null : Boolean(r.ACCEPTED),
    rejectReason: r.REJECT_REASON ?? null,
    createdOn: toIso(r.CREATED_ON),
  }))
}

/** Records an uploaded take and queues an ENROLL job for the worker. */
export async function createTakeAndJob(
  speakerId: string,
  promptId: string | null,
  stageRelPath: string,
): Promise<{ takeId: string; jobId: string }> {
  await querySnowflake(
    `INSERT INTO ${DB}.ENROLLMENT_TAKES (speaker_id, prompt_id, audio_path)
     SELECT ?, ?, ?`,
    { binds: [speakerId, promptId, stageRelPath] },
  )
  const found = await querySnowflake(
    `SELECT take_id FROM ${DB}.ENROLLMENT_TAKES
      WHERE audio_path = ? ORDER BY created_on DESC LIMIT 1`,
    { binds: [stageRelPath] },
  )
  const takeId = found[0]?.TAKE_ID
  const jobId = await enqueueJob("ENROLL", takeId)
  return { takeId, jobId }
}

// ---------------------------------------------------------------------------
// Narrations
// ---------------------------------------------------------------------------

export type NarrationState = "DRAFT" | "QUEUED" | "GENERATING" | "READY" | "FAILED"

export interface Narration {
  narrationId: string
  project: string | null
  title: string
  speakerId: string
  speakerName: string | null
  baseSeed: number | null
  audioPath: string | null
  format: string | null
  durationMs: number | null
  state: NarrationState
  createdOn: string | null
  /** The script as submitted. Surfaced so a narration can be reloaded into the
   * compose form and re-run at different settings — the text is the expensive
   * thing a user typed, and it has always been stored here, just never read. */
  scriptText: string
  exaggeration: number | null
  temperature: number | null
  cfgWeight: number | null
  /** Generations per chunk that produced this narration. Surfaced so a listed
   * narration reports how it was actually made, not today's default. */
  takesPerChunk: number | null
  /** Chunk counts, null until the PLAN job has split the script.
   *
   * These come from the chunk rows themselves rather than from worker heartbeats,
   * which matters once several workers share a narration: no single worker knows
   * the whole picture, and a heartbeat only describes the chunk that worker holds.
   * The rows are the only place the true total lives. */
  chunksTotal: number | null
  chunksReady: number | null
  /** Chunks a worker currently holds. Zero, with zero ready, means the narration is
   * planned but nothing has started — queued, not generating. The narration row says
   * GENERATING from the moment PLAN finishes, so this is the only way to tell. */
  chunksGenerating: number | null
  /** Narrations ahead of this one that still have unfinished chunks. Chunk jobs are
   * claimed oldest-first, so an older unfinished narration will consume every worker
   * before this one starts. */
  waitingBehind: number | null
}

export async function listNarrations(): Promise<Narration[]> {
  const rows = await querySnowflake(
    `SELECT n.narration_id, n.project, n.title, n.speaker_id, s.name AS speaker_name,
            n.base_seed, n.audio_path, n.format, n.duration_ms, n.state, n.created_on,
            n.script_text, n.exaggeration, n.temperature, n.cfg_weight,
            n.takes_per_chunk,
            c.total AS CHUNKS_TOTAL, c.ready AS CHUNKS_READY,
            c.generating AS CHUNKS_GENERATING, q.ahead AS WAITING_BEHIND
       FROM ${DB}.NARRATIONS n
       LEFT JOIN ${DB}.SPEAKERS s ON s.speaker_id = n.speaker_id
       LEFT JOIN (
              SELECT narration_id,
                     COUNT(*) AS total,
                     COUNT_IF(state = 'READY') AS ready,
                     COUNT_IF(state = 'GENERATING') AS generating
                FROM ${DB}.NARRATION_CHUNKS
               GROUP BY narration_id
            ) c ON c.narration_id = n.narration_id
       LEFT JOIN (
              -- Unfinished narrations older than each one, i.e. how many will be
              -- served before it. Correlated on created_on because PLAN jobs are
              -- submitted in creation order and chunk jobs inherit that ordering.
              SELECT nn.narration_id,
                     (SELECT COUNT(*)
                        FROM ${DB}.NARRATIONS o
                        JOIN ${DB}.NARRATION_CHUNKS oc ON oc.narration_id = o.narration_id
                       WHERE o.state = 'GENERATING'
                         AND o.created_on < nn.created_on
                         AND oc.state <> 'READY') AS ahead
                FROM ${DB}.NARRATIONS nn
            ) q ON q.narration_id = n.narration_id
      ORDER BY n.project NULLS LAST, n.created_on`,
  )
  return rows.map((r: any) => ({
    narrationId: r.NARRATION_ID,
    project: r.PROJECT ?? null,
    title: r.TITLE,
    speakerId: r.SPEAKER_ID,
    speakerName: r.SPEAKER_NAME ?? null,
    baseSeed: num(r.BASE_SEED),
    audioPath: r.AUDIO_PATH ?? null,
    format: r.FORMAT ?? null,
    durationMs: num(r.DURATION_MS),
    state: r.STATE,
    createdOn: toIso(r.CREATED_ON),
    scriptText: r.SCRIPT_TEXT ?? "",
    exaggeration: num(r.EXAGGERATION),
    temperature: num(r.TEMPERATURE),
    cfgWeight: num(r.CFG_WEIGHT),
    takesPerChunk: num(r.TAKES_PER_CHUNK),
    chunksTotal: num(r.CHUNKS_TOTAL),
    chunksReady: num(r.CHUNKS_READY),
    chunksGenerating: num(r.CHUNKS_GENERATING),
    waitingBehind: num(r.WAITING_BEHIND),
  }))
}

/** Creates a narration and queues a GENERATE job.
 *
 * A random base seed is assigned when none is given, so that re-running the
 * same narration reproduces the same audio (on CUDA — Chatter's set_seed does
 * not seed the MPS RNG).
 *
 * The three voice knobs are stored per narration so the same reference clip can
 * be A/B tested. They materially affect how closely the output resembles the
 * speaker, and were previously hardcoded and untested.
 *
 * `takesPerChunk` is how many times each chunk is generated before Whisper keeps
 * the best. Defects are per-take and roughly independent, so this is the main
 * defence against a dropped or garbled word; see sql/05_takes_per_chunk.sql for
 * the measured rates behind the default of 3.
 */
export async function createNarrationAndJob(input: {
  project: string | null
  title: string
  scriptText: string
  speakerId: string
  format?: string
  baseSeed?: number
  exaggeration?: number
  temperature?: number
  cfgWeight?: number
  takesPerChunk?: number
}): Promise<{ narrationId: string; jobId: string }> {
  const seed = input.baseSeed ?? Math.floor(Math.random() * 2_000_000_000)
  const format = (input.format ?? "mp3").toLowerCase()
  const exaggeration = input.exaggeration ?? 0.5
  const temperature = input.temperature ?? 0.8
  const cfgWeight = input.cfgWeight ?? 0.5
  const takesPerChunk = input.takesPerChunk ?? 3

  // Check the voice up front. The worker resolves the reference clip with
  // NARRATIONS JOIN SPEAKERS, so an unknown or half-enrolled speaker_id yields
  // zero rows and the job dies with "narration <id> not found" — a misleading
  // error that blames the narration, arrives seconds later, and leaves a FAILED
  // job plus an orphan QUEUED row behind. A caller mistake should be a 400 at
  // submit time instead.
  const speaker = await querySnowflake(
    `SELECT state FROM ${DB}.SPEAKERS WHERE speaker_id = ?`,
    { binds: [input.speakerId] },
  )
  if (speaker.length === 0) {
    throw new Error("That voice no longer exists. Pick another and try again.")
  }
  const speakerState = String((speaker[0] as any)?.STATE ?? "").toUpperCase()
  if (speakerState !== "READY") {
    throw new Error(
      `That voice is not ready yet (currently ${speakerState || "unknown"}). ` +
        `Finish enrolling it before generating.`,
    )
  }

  // The id is generated here rather than read back after the INSERT. The old
  // code recovered it with "newest row for this speaker+title", which stopped
  // being safe once the compose form began retaining the title: submitting the
  // same title twice, or generating several variants of one script, can leave two
  // candidate rows and the lookup would attach the job to the wrong one.
  const narrationId = randomUUID()

  await querySnowflake(
    `INSERT INTO ${DB}.NARRATIONS
       (narration_id, project, title, script_text, speaker_id, base_seed, format,
        state, exaggeration, temperature, cfg_weight, takes_per_chunk)
     SELECT ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?`,
    {
      binds: [
        narrationId,
        input.project,
        input.title,
        input.scriptText,
        input.speakerId,
        seed,
        format,
        exaggeration,
        temperature,
        cfgWeight,
        takesPerChunk,
      ],
    },
  )
  // PLAN, not GENERATE: the worker chunks the script, writes NARRATION_CHUNKS,
  // and fans out one GENERATE_CHUNK job per chunk plus a final ASSEMBLE. That is
  // what allows several workers to share one narration, and it is also what makes
  // [pause:Xs] possible, since a pause becomes silence inserted at assembly
  // rather than something the model is asked to perform.
  const jobId = await enqueueJob("PLAN", narrationId)
  return { narrationId, jobId }
}

/** Presigned URL for playback and download. The stage uses SNOWFLAKE_SSE, which
 * is a precondition for URL access to staged files.
 *
 * NOTE: the relative-path argument is interpolated, NOT bound. GET_PRESIGNED_URL
 * resolves that argument at COMPILE time, before bind variables are substituted,
 * so passing it via `binds` fails with "Argument 2 ... cannot be null or empty".
 * The value is validated against a strict pattern first, since interpolating into
 * SQL is only safe when the input cannot contain a quote.
 */
export async function narrationUrl(
  narrationId: string,
  expirySeconds = 3600,
): Promise<string | null> {
  const rows = await querySnowflake(
    `SELECT audio_path FROM ${DB}.NARRATIONS WHERE narration_id = ?`,
    { binds: [narrationId] },
  )
  const path = rows[0]?.AUDIO_PATH
  if (!path) return null

  // Paths are worker-generated (a UUID plus an extension), so this should always
  // pass; it exists to guarantee the interpolation below can never inject.
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Error(`refusing to build a presigned URL for suspicious path: ${path}`)
  }

  const url = await querySnowflake(
    `SELECT GET_PRESIGNED_URL(@${DB}.NARRATION_AUDIO, '${path}', ${Number(expirySeconds)}) AS URL`,
  )
  return url[0]?.URL ?? null
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobState = "QUEUED" | "RUNNING" | "DONE" | "FAILED"

export type JobKind =
  | "ENROLL"
  | "PLAN"            // split a narration into chunks and fan out chunk jobs
  | "GENERATE_CHUNK"  // generate and validate ONE chunk
  | "ASSEMBLE"        // join chunk audio, insert pauses, normalise once


export interface Job {
  jobId: string
  kind: JobKind
  refId: string
  state: JobState
  submittedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  failureReason: string | null
}

export async function enqueueJob(
  kind: JobKind,
  refId: string,
  refIndex?: number,
): Promise<string> {
  await querySnowflake(
    `INSERT INTO ${DB}.JOBS (kind, ref_id, ref_index, state)
     SELECT ?, ?, ?, 'QUEUED'`,
    { binds: [kind, refId, refIndex ?? null] },
  )
  const rows = await querySnowflake(
    `SELECT job_id FROM ${DB}.JOBS
      WHERE ref_id = ? ORDER BY submitted_at DESC LIMIT 1`,
    { binds: [refId] },
  )
  return rows[0]?.JOB_ID
}

/** The one job worth showing the user for a narration.
 *
 * Failed jobs sort first, and only then newest-first. A narration now fans out
 * into many jobs that PLAN submits in the same instant, so "newest" among them is
 * arbitrary — picking by timestamp alone would show a healthy sibling's empty
 * failure_reason and leave the UI reporting a failed narration with no cause.
 */
export async function getJobForRef(refId: string): Promise<Job | null> {
  const rows = await querySnowflake(
    `SELECT job_id, kind, ref_id, state, submitted_at, started_at, finished_at,
            failure_reason
       FROM ${DB}.JOBS
      WHERE ref_id = ?
      ORDER BY IFF(state = 'FAILED', 0, 1), submitted_at DESC
      LIMIT 1`,
    { binds: [refId] },
  )
  if (!rows.length) return null
  const r: any = rows[0]
  return {
    jobId: r.JOB_ID,
    kind: r.KIND,
    refId: r.REF_ID,
    state: r.STATE,
    submittedAt: toIso(r.SUBMITTED_AT),
    startedAt: toIso(r.STARTED_AT),
    finishedAt: toIso(r.FINISHED_AT),
    failureReason: r.FAILURE_REASON ?? null,
  }
}

export async function queueDepth(): Promise<number> {
  const rows = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.JOBS WHERE state = 'QUEUED'`,
  )
  return num(rows[0]?.N) ?? 0
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** Guard for stage paths built into SQL text.
 *
 * REMOVE resolves its stage path at compile time, exactly as GET_PRESIGNED_URL
 * does, so the path cannot be a bind parameter. Every path we pass is one we
 * generated (a UUID, or "<uuid>/reference.wav"), but this is a destructive
 * statement with an interpolated argument, so the shape is asserted rather than
 * assumed — a stray quote or space must never reach a REMOVE.
 */
function assertSafeStagePath(path: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) {
    throw new Error(`refusing to REMOVE a suspicious stage path: ${path}`)
  }
  return path
}

/** Best-effort stage cleanup. Never throws.
 *
 * Row deletion is the operation that matters: an object the user deleted must
 * disappear from the app. A leftover stage file is wasted storage, not a
 * correctness problem, and it must not be able to block the delete or leave the
 * tables half-cleaned.
 */
async function removeFromStage(stage: string, path: string): Promise<void> {
  try {
    await querySnowflake(`REMOVE @${DB}.${stage}/${assertSafeStagePath(path)}`)
  } catch (e) {
    console.warn(new Date().toISOString(), `[narrator] stage cleanup failed for @${stage}/${path}`, e)
  }
}

/** Asks the workers to stop generating a narration.
 *
 * Cooperative by design. A worker checks the flag before every take and between
 * Whisper validations, so a cancel lands within a few seconds during validation
 * and within roughly one take during generation. The alternative — killing the
 * container — throws away a 30-60s model load and takes down anything else in
 * flight, which is exactly the blunt instrument this replaces.
 *
 * A narration now fans out into many jobs (PLAN, one GENERATE_CHUNK per chunk,
 * ASSEMBLE), possibly across several workers, so this cancels ALL of them rather
 * than "the" job. Two distinct cases:
 *
 *   * QUEUED jobs have no worker to notice a flag, so they are retired here.
 *     Leaving them QUEUED with cancel_requested set would mean the next worker to
 *     come up claims them only to abort immediately.
 *   * RUNNING jobs get the flag and stop themselves.
 *
 * Returns immediately. Requesting cancel twice is harmless.
 */
export async function cancelNarration(
  narrationId: string,
): Promise<{ state: string }> {
  const rows = await querySnowflake(
    `SELECT state FROM ${DB}.NARRATIONS WHERE narration_id = ?`,
    { binds: [narrationId] },
  )
  if (!rows.length) throw new Error("That narration no longer exists.")
  const state = String((rows[0] as any)?.STATE ?? "")
  if (state !== "QUEUED" && state !== "GENERATING") {
    throw new Error(`That narration is already ${state.toLowerCase()}.`)
  }

  // Flag everything in flight. Harmless for jobs that have already finished.
  await querySnowflake(
    `UPDATE ${DB}.JOBS
        SET cancel_requested = TRUE, cancel_requested_at = CURRENT_TIMESTAMP()
      WHERE ref_id = ? AND state IN ('QUEUED', 'RUNNING')`,
    { binds: [narrationId] },
  )

  const running = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.JOBS
      WHERE ref_id = ? AND state = 'RUNNING'`,
    { binds: [narrationId] },
  )
  const stillRunning = num((running[0] as any)?.N) ?? 0

  await querySnowflake(
    `UPDATE ${DB}.JOBS
        SET state = 'FAILED', finished_at = CURRENT_TIMESTAMP(),
            failure_reason = 'cancelled before it started'
      WHERE ref_id = ? AND state = 'QUEUED'`,
    { binds: [narrationId] },
  )
  await querySnowflake(
    `UPDATE ${DB}.NARRATION_CHUNKS
        SET state = 'CANCELLED', updated_on = CURRENT_TIMESTAMP()
      WHERE narration_id = ? AND state IN ('QUEUED', 'GENERATING')`,
    { binds: [narrationId] },
  )

  // Only claim CANCELLED once nothing is still working: a running worker owns the
  // narration row and will set the final state itself when it notices the flag.
  if (stillRunning === 0) {
    await querySnowflake(
      `UPDATE ${DB}.NARRATIONS SET state = 'CANCELLED' WHERE narration_id = ?`,
      { binds: [narrationId] },
    )
    return { state: "CANCELLED" }
  }
  return { state: "CANCELLING" }
}

/** Deletes a narration, its queued/finished jobs, and its audio file.
 *
 * Refuses while the narration is in flight. A worker that is mid-generation
 * still holds the id and will UPDATE the row on completion; deleting underneath
 * it would make that write vanish silently, and the orphan reaper would then
 * requeue a job whose narration no longer exists. Cancel it first.
 */
export async function deleteNarration(narrationId: string): Promise<void> {
  const rows = await querySnowflake(
    `SELECT state, audio_path, format FROM ${DB}.NARRATIONS WHERE narration_id = ?`,
    { binds: [narrationId] },
  )
  if (!rows.length) throw new Error("That narration no longer exists.")
  const { STATE, AUDIO_PATH } = rows[0] as any

  if (STATE === "QUEUED" || STATE === "GENERATING") {
    throw new Error(
      "That narration is still generating. Wait for it to finish before deleting it.",
    )
  }

  if (AUDIO_PATH) await removeFromStage("NARRATION_AUDIO", String(AUDIO_PATH))

  // Per-chunk WAVs live under a directory named for the narration, so one REMOVE
  // clears them all. These are pure intermediates — the only reason to keep them
  // after assembly is auditioning takes, and that ends when the narration goes.
  await removeFromStage("CHUNK_AUDIO", `${narrationId}/`)

  // Every kind, not just GENERATE: a narration now owns PLAN, one GENERATE_CHUNK
  // per chunk and an ASSEMBLE. Filtering on kind would leave the rest orphaned,
  // and the orphan reaper would keep finding jobs for a narration that is gone.
  await querySnowflake(`DELETE FROM ${DB}.JOBS WHERE ref_id = ?`, {
    binds: [narrationId],
  })
  await querySnowflake(
    `DELETE FROM ${DB}.NARRATION_CHUNKS WHERE narration_id = ?`,
    { binds: [narrationId] },
  )
  await querySnowflake(`DELETE FROM ${DB}.NARRATIONS WHERE narration_id = ?`, {
    binds: [narrationId],
  })
}

/** Renames a voice.
 *
 * Only the label changes: speaker_id is the identity everywhere else (narrations,
 * takes, and the <speaker_id>/reference.wav path on @VOICE_PROFILES), so nothing
 * has to move and existing narrations keep working. That is the whole point of
 * making this cheap — comparing voices is easier when they can be named for what
 * they turned out to be rather than what you guessed when you created them.
 */
export async function renameSpeaker(speakerId: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("A voice name is required.")
  if (trimmed.length > 120) throw new Error("That name is too long (120 characters max).")

  const rows = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.SPEAKERS WHERE speaker_id = ?`,
    { binds: [speakerId] },
  )
  if ((num((rows[0] as any)?.N) ?? 0) === 0) {
    throw new Error("That voice no longer exists.")
  }

  await querySnowflake(`UPDATE ${DB}.SPEAKERS SET name = ? WHERE speaker_id = ?`, {
    binds: [trimmed, speakerId],
  })
}

export interface SpeakerDeletionBlocked {
  blocked: true
  narrationCount: number
}

/** Deletes a speaker, its enrollment takes, and its stage artefacts.
 *
 * Narrations outlive the voice that produced them, and their audio is expensive
 * — minutes of GPU or laptop time each. So a voice with narrations is NOT
 * deleted on the first attempt: the count is returned instead, and the caller
 * must opt in with `cascade`. That keeps a single click from destroying finished
 * audio while still allowing a real cleanup in two steps.
 *
 * Returns `{ blocked: true, narrationCount }` when it declined, or null when the
 * delete went through.
 */
export async function deleteSpeaker(
  speakerId: string,
  opts: { cascade?: boolean } = {},
): Promise<SpeakerDeletionBlocked | null> {
  const spk = await querySnowflake(
    `SELECT state FROM ${DB}.SPEAKERS WHERE speaker_id = ?`,
    { binds: [speakerId] },
  )
  if (!spk.length) throw new Error("That voice no longer exists.")

  // An ENROLL job in flight is the same hazard as a running generation: the
  // worker will write back take scores and a reference clip for a speaker that
  // would no longer exist.
  const busy = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.JOBS j
      WHERE j.kind = 'ENROLL' AND j.state IN ('QUEUED', 'RUNNING')
        AND j.ref_id IN (SELECT take_id FROM ${DB}.ENROLLMENT_TAKES WHERE speaker_id = ?)`,
    { binds: [speakerId] },
  )
  if ((num((busy[0] as any)?.N) ?? 0) > 0) {
    throw new Error("That voice is still being enrolled. Wait for it to finish.")
  }

  const counted = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.NARRATIONS WHERE speaker_id = ?`,
    { binds: [speakerId] },
  )
  const narrationCount = num((counted[0] as any)?.N) ?? 0
  if (narrationCount > 0 && !opts.cascade) {
    return { blocked: true, narrationCount }
  }

  // Narrations first: each owns a stage file, and deleteNarration re-checks that
  // none of them is mid-generation.
  if (narrationCount > 0) {
    const ns = await querySnowflake(
      `SELECT narration_id FROM ${DB}.NARRATIONS WHERE speaker_id = ?`,
      { binds: [speakerId] },
    )
    for (const n of ns) await deleteNarration(String((n as any).NARRATION_ID))
  }

  // Enrollment jobs are keyed by take, so they have to go before the takes do.
  // Take files are collected first, for the same reason: the paths live on the
  // rows we are about to delete.
  //
  // ENROLLMENT_AUDIO is laid out by processing stage (raw/, processed/) with flat
  // UUID filenames, NOT per speaker, so there is no prefix to remove — each file
  // is named individually. Both columns are read: audio_path is the raw upload and
  // processed_path its normalised derivative, and a take owns both files. (Takes
  // predating the split have the processed path in BOTH columns; removing the same
  // path twice is harmless, so no special case is needed.)
  const takeRows = await querySnowflake(
    `SELECT audio_path, processed_path FROM ${DB}.ENROLLMENT_TAKES WHERE speaker_id = ?`,
    { binds: [speakerId] },
  )
  const takeFiles = new Set<string>()
  for (const t of takeRows) {
    const r = t as any
    if (r.AUDIO_PATH) takeFiles.add(String(r.AUDIO_PATH))
    if (r.PROCESSED_PATH) takeFiles.add(String(r.PROCESSED_PATH))
  }
  for (const p of takeFiles) await removeFromStage("ENROLLMENT_AUDIO", p)

  await querySnowflake(
    `DELETE FROM ${DB}.JOBS
      WHERE kind = 'ENROLL'
        AND ref_id IN (SELECT take_id FROM ${DB}.ENROLLMENT_TAKES WHERE speaker_id = ?)`,
    { binds: [speakerId] },
  )
  await querySnowflake(`DELETE FROM ${DB}.ENROLLMENT_TAKES WHERE speaker_id = ?`, {
    binds: [speakerId],
  })

  // VOICE_PROFILES *is* keyed per speaker (<speaker_id>/reference.wav), verified
  // against the live stage, so one prefix remove clears it.
  await removeFromStage("VOICE_PROFILES", `${speakerId}/`)

  await querySnowflake(`DELETE FROM ${DB}.SPEAKERS WHERE speaker_id = ?`, {
    binds: [speakerId],
  })
  return null
}

export interface NarrationChunk {
  chunkIndex: number
  text: string
  pauseAfterMs: number
  state: string
  durationMs: number | null
  score: number | null
  gapSeconds: number | null
  gapQuietDb: number | null
  attempt: number
  repairReason: string | null
  failureReason: string | null
  /** Present once a take has been stored. Repaired chunks read
   * <index>_a<attempt>.wav, so this is the only reliable way to address the audio. */
  audioPath: string | null
  /** True when no take passed validation, so the shipped audio is a best-effort
   * failing take. This is the flag worth acting on — a low score that PASSED is a
   * different thing from a chunk nothing could validate. */
  unpassed: boolean
}

/** The chunks of one narration, for inspection and repair. */
export async function listNarrationChunks(
  narrationId: string,
): Promise<NarrationChunk[]> {
  const rows = await querySnowflake(
    `SELECT chunk_index, text, pause_after_ms, state, duration_ms, score,
            gap_seconds, gap_quiet_db, attempt, repair_reason, failure_reason,
            audio_path
       FROM ${DB}.NARRATION_CHUNKS
      WHERE narration_id = ?
      ORDER BY chunk_index`,
    { binds: [narrationId] },
  )
  return (rows as any[]).map((r) => ({
    chunkIndex: Number(r.CHUNK_INDEX),
    text: String(r.TEXT ?? ""),
    pauseAfterMs: Number(r.PAUSE_AFTER_MS ?? 0),
    state: String(r.STATE ?? ""),
    durationMs: num(r.DURATION_MS),
    score: num(r.SCORE),
    gapSeconds: num(r.GAP_SECONDS),
    gapQuietDb: num(r.GAP_QUIET_DB),
    attempt: num(r.ATTEMPT) ?? 0,
    repairReason: r.REPAIR_REASON ?? null,
    failureReason: r.FAILURE_REASON ?? null,
    unpassed: Boolean(r.FAILURE_REASON),
    audioPath: r.AUDIO_PATH ?? null,
  }))
}

/** Regenerates specific chunks of a narration and reassembles it.
 *
 * The point of per-chunk repair: a bad chunk previously meant regenerating the
 * whole narration, paying for seventeen good chunks to fix one. Here only the named
 * chunks are generated again, and a single ASSEMBLE re-joins them with the existing
 * audio for everything else.
 *
 * Each repaired chunk's `attempt` is incremented, which is what makes the retry
 * produce different audio — the generation seed is derived from
 * (base_seed, chunk_index, attempt), so repairing without bumping it would
 * reproduce the identical take.
 *
 * Refuses while the narration has work in flight, because the ASSEMBLE queued here
 * would otherwise race the one already queued and could join a mix of old and new
 * chunk audio.
 */
export async function repairNarrationChunks(
  narrationId: string,
  chunkIndexes: number[],
): Promise<{ repaired: number }> {
  if (!chunkIndexes.length) throw new Error("No chunks were selected.")
  if (chunkIndexes.some((i) => !Number.isInteger(i) || i < 0)) {
    throw new Error("Chunk indexes must be non-negative whole numbers.")
  }

  const exists = await querySnowflake(
    `SELECT state FROM ${DB}.NARRATIONS WHERE narration_id = ?`,
    { binds: [narrationId] },
  )
  if (!exists.length) throw new Error("That narration no longer exists.")

  const busy = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.JOBS
      WHERE ref_id = ? AND state IN ('QUEUED', 'RUNNING')`,
    { binds: [narrationId] },
  )
  if ((num((busy[0] as any)?.N) ?? 0) > 0) {
    throw new Error(
      "That narration still has work in flight. Wait for it to finish, or cancel it first.",
    )
  }

  // Verify the chunks exist before queuing anything, so a typo cannot leave a
  // narration GENERATING against jobs for chunks that were never there.
  const placeholders = chunkIndexes.map(() => "?").join(", ")
  const found = await querySnowflake(
    `SELECT chunk_index FROM ${DB}.NARRATION_CHUNKS
      WHERE narration_id = ? AND chunk_index IN (${placeholders})`,
    { binds: [narrationId, ...chunkIndexes] },
  )
  if (found.length !== chunkIndexes.length) {
    throw new Error(
      `Only ${found.length} of ${chunkIndexes.length} requested chunks exist on that narration.`,
    )
  }

  await querySnowflake(
    `UPDATE ${DB}.NARRATION_CHUNKS
        SET state = 'QUEUED',
            attempt = COALESCE(attempt, 0) + 1,
            repair_reason = 'MANUAL',
            failure_reason = NULL,
            updated_on = CURRENT_TIMESTAMP()
      WHERE narration_id = ? AND chunk_index IN (${placeholders})`,
    { binds: [narrationId, ...chunkIndexes] },
  )

  for (const i of chunkIndexes) {
    await enqueueJob("GENERATE_CHUNK", narrationId, i)
  }
  await enqueueJob("ASSEMBLE", narrationId)
  await querySnowflake(
    `UPDATE ${DB}.NARRATIONS SET state = 'GENERATING' WHERE narration_id = ?`,
    { binds: [narrationId] },
  )
  return { repaired: chunkIndexes.length }
}

/** A presigned URL for one chunk's audio, so a chunk can be auditioned.
 *
 * Scores cannot tell you a chunk sounds wrong. A take can score 1.000 and still
 * contain a loud non-speech run, because Whisper compares transcripts and babble
 * transcribes to nothing. Listening is the only way to catch that, which makes this
 * the difference between the chunk panel being informative and being actionable.
 *
 * Reads audio_path from the row rather than deriving it, because repaired chunks
 * live at <index>_a<attempt>.wav — deriving the name would always return attempt 0.
 */
export async function chunkAudioUrl(
  narrationId: string,
  chunkIndex: number,
  expirySeconds = 3600,
): Promise<string | null> {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("chunkIndex must be a non-negative whole number.")
  }
  const rows = await querySnowflake(
    `SELECT audio_path FROM ${DB}.NARRATION_CHUNKS
      WHERE narration_id = ? AND chunk_index = ?`,
    { binds: [narrationId, chunkIndex] },
  )
  const path = rows[0]?.AUDIO_PATH
  if (!path) return null

  // Worker-generated, but this is interpolated into SQL, so the shape is asserted
  // rather than assumed.
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Error(`refusing to build a presigned URL for suspicious path: ${path}`)
  }
  const url = await querySnowflake(
    `SELECT GET_PRESIGNED_URL(@${DB}.CHUNK_AUDIO, '${path}', ${Number(expirySeconds)}) AS URL`,
  )
  return url[0]?.URL ?? null
}
