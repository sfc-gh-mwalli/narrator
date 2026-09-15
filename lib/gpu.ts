/**
 * GPU pool and worker lifecycle.
 *
 * The pool is created with AUTO_RESUME = FALSE, so nothing wakes it implicitly:
 * submitting a job while it is suspended leaves that job QUEUED until someone
 * presses Wake. That is deliberate — GPU time is the dominant cost and idle
 * time dominates development.
 *
 * Readiness has THREE stages, and they must be reported separately or a 60-90s
 * cold start looks like a hang:
 *
 *   1. pool      -> SHOW COMPUTE POOLS ... until ACTIVE or IDLE
 *   2. container -> SHOW SERVICE CONTAINERS IN SERVICE ... until READY
 *   3. model     -> WORKER_STATUS.model_loaded, written by the worker itself
 *
 * Stage 3 exists because the container being up says nothing about whether
 * several GB of weights have finished loading.
 */
import { querySnowflake } from "@/lib/snowflake"
import { readSettings, writeSetting, activeWarehouse } from "@/lib/settings"

const SERVICE = "NARRATOR.APP.NARRATOR_WORKER"
const SPEC_STAGE = "NARRATOR.APP.SPECS"
const SPEC_FILE = "service-spec.yaml"
const DB = "NARRATOR.APP"

/** The pool the worker runs on, from app settings.
 *
 * Read per call rather than cached. The value changes only when a human changes
 * it, but a stale cache here would point wake/suspend at the wrong pool — leaving
 * the real one running and billing — and these calls are already one round trip
 * among several.
 *
 * Identifiers cannot be bound as parameters, so the name is interpolated and must
 * be validated first. It comes from our own settings table rather than from a
 * request, but it reaches ALTER and DROP statements, so it is checked anyway.
 */
async function activePool(): Promise<string> {
  const { gpu_pool } = await readSettings()
  return assertIdentifier(gpu_pool)
}

/** Guards an identifier that is about to be interpolated into DDL. */
export function assertIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`Not a valid Snowflake identifier: ${name}`)
  }
  return name
}

/** A heartbeat older than this means the worker is gone, not merely busy. */
const HEARTBEAT_STALE_SECONDS = 60

export type WarmupStage = "suspended" | "pool" | "container" | "model" | "ready"

export interface GpuStatus {
  stage: WarmupStage
  /** Raw compute pool state, e.g. SUSPENDED / STARTING / ACTIVE / IDLE. */
  poolState: string
  containerStatus: string | null
  workerState: string | null
  modelLoaded: boolean
  heartbeatAgeSeconds: number | null
  workerStale: boolean
  /** True only when a worker SHOULD be alive, i.e. the container is READY.
   *
   * WORKER_STATUS is a last-known-state table, not a liveness signal: the row
   * survives the container, and SPCS can SIGKILL the worker before it writes a
   * final state, so the row can claim anything indefinitely. Callers must use
   * this to decide whether a missing heartbeat is a fault or simply expected —
   * without it, a deliberately suspended pool reported "no heartbeat 7120s" as
   * though something had crashed. */
  workerExpected: boolean
  queuedJobs: number
  /** GENERATING | CHECKING | ASSEMBLING while working, else null. */
  phase: string | null
  /** Progress WITHIN the current phase — not a whole-job percentage. */
  progressDone: number | null
  progressTotal: number | null
  /** The narration being worked on, so the UI can put the bar on the right row. */
  currentNarrationId: string | null
  /** Workers with a fresh heartbeat. The UI reports this against the configured
   * count, which is how a user sees that instances are pending for want of a GPU. */
  liveWorkers: number
  /** The pool the service actually runs in, per DESCRIBE SERVICE. */
  pool: string
  /** The service's own state. SUSPENDED means no worker will start until it is
   * resumed, regardless of the pool being up. */
  serviceState: string | null
  /** Human-readable summary for the UI. */
  message: string
}

async function poolState(): Promise<string> {
  const pool = await activePool()
  const rows = await querySnowflake(`SHOW COMPUTE POOLS LIKE '${pool}'`)
  return rows[0]?.state ?? "UNKNOWN"
}

async function containerStatus(): Promise<string | null> {
  try {
    const rows = await querySnowflake(
      `SHOW SERVICE CONTAINERS IN SERVICE ${SERVICE}`,
    )
    return rows[0]?.status ?? null
  } catch {
    // The service may not exist yet, or the pool may be suspended — neither is
    // an error worth surfacing as a failure.
    return null
  }
}

/** The service's own lifecycle state, e.g. RUNNING / SUSPENDED / PENDING.
 *
 * Read separately from the container because the two answer different questions and
 * a suspended service has no containers at all. Without this, "suspended" and
 * "starting up" are indistinguishable — both show a live pool and no container —
 * and the card reported a stopped worker as though it were 30 seconds from ready.
 */
async function serviceStatus(): Promise<string | null> {
  try {
    const rows = await querySnowflake(`DESCRIBE SERVICE ${SERVICE}`)
    const r: any = rows[0]
    const v = r?.status ?? r?.STATUS
    return v ? String(v) : null
  } catch {
    return null
  }
}

async function workerStatus(): Promise<{
  state: string | null
  modelLoaded: boolean
  ageSeconds: number | null
  phase: string | null
  progressDone: number | null
  progressTotal: number | null
  currentNarrationId: string | null
  /** Workers whose heartbeat is fresh. Zero means nothing is alive. */
  liveWorkers: number
  /** Rows in WORKER_STATUS, live or not. */
  knownWorkers: number
}> {
  // Joined to JOBS so the caller learns WHICH narration is in flight. Without that
  // the UI cannot tell which row the progress belongs to, and guessing "the one
  // that is GENERATING" breaks as soon as a second narration is queued.
  //
  // Ordered by heartbeat and read in full rather than LIMIT 1, because there is a
  // row per worker instance once the count is above one. The freshest row is used
  // for the headline state and the rest are counted: a summary card cannot show
  // eight independent phases, and the aggregate — how many are alive, and is any
  // model loaded — is what the header is actually claiming.
  const rows = await querySnowflake(
    `SELECT w.state, w.model_loaded, w.phase, w.progress_done, w.progress_total,
            j.ref_id,
            DATEDIFF('second', w.heartbeat_at, CURRENT_TIMESTAMP()) AS AGE
       FROM ${DB}.WORKER_STATUS w
       LEFT JOIN ${DB}.JOBS j ON j.job_id = w.current_job_id
      ORDER BY w.heartbeat_at DESC`,
  )
  if (!rows.length) {
    return {
      state: null, modelLoaded: false, ageSeconds: null,
      phase: null, progressDone: null, progressTotal: null,
      currentNarrationId: null, liveWorkers: 0, knownWorkers: 0,
    }
  }
  const num = (v: any) => (v === null || v === undefined ? null : Number(v))
  const ageOf = (r: any) => {
    const a = num(r.AGE)
    return a !== null && Number.isFinite(a) ? a : null
  }

  const live = (rows as any[]).filter((r) => {
    const a = ageOf(r)
    return a !== null && a <= HEARTBEAT_STALE_SECONDS
  })

  // Prefer a worker that is actually doing something for the headline. With four
  // idle workers and one generating, the freshest heartbeat is as likely to be an
  // idle one, and reporting IDLE while a narration generates is simply wrong.
  const pool = live.length ? live : (rows as any[])
  const r: any = pool.find((x) => x.PHASE) ?? pool[0]

  return {
    state: r.STATE ?? null,
    modelLoaded: pool.some((x) => Boolean(x.MODEL_LOADED)),
    ageSeconds: ageOf(r),
    phase: r.PHASE ?? null,
    progressDone: num(r.PROGRESS_DONE),
    progressTotal: num(r.PROGRESS_TOTAL),
    currentNarrationId: r.REF_ID ?? null,
    liveWorkers: live.length,
    knownWorkers: rows.length,
  }
}

export async function getGpuStatus(): Promise<GpuStatus> {
  const [pool, container, worker, queued, poolName, service] = await Promise.all([
    poolState(),
    containerStatus(),
    workerStatus(),
    querySnowflake(`SELECT COUNT(*) AS N FROM ${DB}.JOBS WHERE state = 'QUEUED'`),
    activePool(),
    serviceStatus(),
  ])
  const serviceSuspended = service === "SUSPENDED"

  const queuedJobs = Number(queued[0]?.N ?? 0)
  const stale =
    worker.ageSeconds === null || worker.ageSeconds > HEARTBEAT_STALE_SECONDS

  // A worker is "expected" when something is actually hosting one. The container
  // being READY covers SPCS; a FRESH heartbeat covers a worker running on a
  // laptop during development, where there is no container at all. A stale
  // heartbeat with no container means the last worker is simply gone — that is
  // the case that must not be reported as a fault.
  const workerExpected = !serviceSuspended && (container === "READY" || !stale)

  let stage: WarmupStage
  let message: string

  // Worker health is checked FIRST, and deliberately: what matters is whether a
  // worker is available to take jobs, not whether the GPU pool is up. During
  // development the worker may be running on a laptop, in which case the pool is
  // irrelevant and reporting "GPU suspended" would be actively misleading.
  if (!stale && worker.modelLoaded) {
    stage = "ready"
    const where = pool === "ACTIVE" || pool === "IDLE" ? "on the GPU pool" : "locally"
    if (worker.state === "BUSY") {
      // Name the phase and position. "Processing a job" for fourteen minutes
      // gives no way to tell progress from a hang.
      // Only render a fraction when the denominator is meaningful. A worker running
      // an older image reports total=1 for per-chunk work, which produced "17/1" —
      // a number that cannot be right and undermines trust in the whole card. The
      // phase name alone is still useful, so degrade to that rather than to nothing.
      const total = worker.progressTotal ?? 0
      const done = worker.progressDone ?? 0
      const sane = total > 1 && done <= total
      const at = worker.phase
        ? sane
          ? ` — ${worker.phase.toLowerCase()} ${done}/${total}`
          : ` — ${worker.phase.toLowerCase()}`
        : ""
      message = `Worker is processing a job (${where})${at}.`
    } else {
      message = `Worker ready and idle (${where}).`
    }
  } else if (!stale && !worker.modelLoaded) {
    stage = "model"
    message = "Worker is up, loading the speech model — 30-60 seconds on a cold start."
  } else if (serviceSuspended) {
    // Checked BEFORE the pool and container branches. Suspending a compute pool
    // cascades to its services, but resuming the pool does NOT bring them back —
    // so a live pool with a suspended service is a normal, reachable state, and it
    // was previously reported as "Pool is up; starting worker container" for ever.
    stage = "suspended"
    message =
      queuedJobs > 0
        ? `Worker service is suspended, so nothing is running. ${queuedJobs} job(s) are queued and will start once it is woken.`
        : "Worker service is suspended. Resume to start the worker."
  } else if (pool === "SUSPENDED" || pool === "STOPPING") {
    stage = "suspended"
    message =
      queuedJobs > 0
        ? `No worker running and the GPU pool is suspended. ${queuedJobs} job(s) are queued and will run once a worker is available.`
        : "No worker running. Resume the GPU, or start a local worker."
  } else if (pool === "STARTING" || pool === "RESIZING") {
    stage = "pool"
    message = "Resuming GPU pool — provisioning a node."
  } else if (!container || container !== "READY") {
    stage = "container"
    message = container
      ? `Pool is up; starting worker container (status: ${container}).`
      : "Pool is up; starting worker container."
  } else {
    stage = "model"
    message =
      `Container is up but has not reported in for ${worker.ageSeconds ?? "?"}s ` +
      `(limit ${HEARTBEAT_STALE_SECONDS}s), so it looks stuck. Check the service logs.`
  }

  return {
    stage,
    poolState: pool,
    containerStatus: container,
    // Suppress the last-known worker state when no container is up to own it.
    // Otherwise the card shows a state left behind by a worker that stopped
    // hours ago as though it were current.
    workerState: workerExpected ? worker.state : null,
    modelLoaded: workerExpected ? worker.modelLoaded : false,
    heartbeatAgeSeconds: worker.ageSeconds,
    workerStale: stale,
    workerExpected,
    queuedJobs,
    phase: workerExpected ? worker.phase : null,
    progressDone: workerExpected ? worker.progressDone : null,
    progressTotal: workerExpected ? worker.progressTotal : null,
    currentNarrationId: workerExpected ? worker.currentNarrationId : null,
    liveWorkers: worker.liveWorkers,
    pool: poolName,
    serviceState: service,
    message,
  }
}

/** Resume the pool. Asynchronous — poll getGpuStatus() afterwards.
 *
 * Resuming bills a 5-minute minimum, so this should be a deliberate action, not
 * something triggered incidentally by page loads. */
export async function wakeGpu(): Promise<void> {
  // Pool FIRST, then the service. The service cannot start without nodes, and
  // resuming it against a suspended pool just leaves it pending.
  await querySnowflake(`ALTER COMPUTE POOL ${await activePool()} RESUME`)

  // The service must be resumed explicitly, and this is the whole reason Wake
  // exists as one button. Suspending a compute pool cascades down and suspends
  // every service in it, but resuming the pool does NOT cascade back — so a pool
  // resume on its own leaves the worker suspended indefinitely, with the pool up
  // and billing and nothing consuming it. Waking the GPU means waking the thing
  // that uses it.
  //
  // Not an error if it is already running: SPCS accepts RESUME on a running
  // service, and a spurious failure here would make Wake look broken.
  await querySnowflake(`ALTER SERVICE ${SERVICE} RESUME`)
}

/** Suspend the pool immediately rather than waiting out AUTO_SUSPEND_SECS.
 *
 * Without this, every short iteration burns the full 5-minute idle window. */
export async function suspendGpu(): Promise<void> {
  // Service first, then the pool. Suspending the pool alone would also stop the
  // service — the cascade goes that way — but doing it explicitly and in this order
  // lets the worker shut down and write its final state instead of being torn down
  // with the nodes underneath it.
  await querySnowflake(`ALTER SERVICE ${SERVICE} SUSPEND`)
  await querySnowflake(`ALTER COMPUTE POOL ${await activePool()} SUSPEND`)
}

/** Number of worker instances the service is currently configured for.
 *
 * Reads the service rather than the setting, so the UI reports what SPCS actually
 * has. target_instances is what was asked for; current_instances is what is
 * running, and the two differ while instances are pending for want of a GPU —
 * which is exactly the condition a user needs to see after asking for too many.
 */
export interface WorkerScale {
  minInstances: number
  maxInstances: number
  targetInstances: number
  currentInstances: number
}

export async function readWorkerScale(): Promise<WorkerScale | null> {
  try {
    const rows = await querySnowflake(`DESCRIBE SERVICE ${SERVICE}`)
    const r: any = rows[0]
    if (!r) return null
    return {
      minInstances: Number(r.min_instances ?? r.MIN_INSTANCES ?? 0),
      maxInstances: Number(r.max_instances ?? r.MAX_INSTANCES ?? 0),
      targetInstances: Number(r.target_instances ?? r.TARGET_INSTANCES ?? 0),
      currentInstances: Number(r.current_instances ?? r.CURRENT_INSTANCES ?? 0),
    }
  } catch {
    return null
  }
}

/** Sets the worker instance count.
 *
 * MIN and MAX are set to the same value deliberately. MIN/MAX on a service is
 * CPU-based autoscaling that adds instances when CPU exceeds 80%, and this workload
 * sits near 10% CPU while pinning a GPU at 100% — so the autoscaler would never
 * fire, and a MAX above MIN would be a control that silently does nothing. Setting
 * both makes the count mean what the user typed.
 *
 * Snowflake rejects the whole ALTER if MIN_INSTANCES exceeds what the pool can
 * hold, leaving the service untouched, and its error names the limit and the fix.
 * That message is passed through verbatim rather than pre-empted with capacity
 * arithmetic of our own: Snowflake knows the true state of the pool, and a check
 * here could only be a second opinion that goes stale.
 */
export async function setWorkerCount(count: number): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new Error("Worker count must be a whole number between 1 and 64.")
  }
  // Deliberately does NOT resume a suspended service. Waking the GPU is a separate,
  // explicit action with its own button and its own cost, and changing a number in
  // a settings row must not start billing as a side effect. When the service is
  // suspended the new count is stored on the service and takes effect on the next
  // wake; the status card says so rather than pretending workers are starting.
  await querySnowflake(
    `ALTER SERVICE ${SERVICE} SET MIN_INSTANCES = ${count} MAX_INSTANCES = ${count}`,
  )
}

/** Moves the worker service to a different compute pool.
 *
 * This drops and recreates the service, because ALTER SERVICE cannot change the
 * compute pool — it is fixed at CREATE SERVICE time, and SET accepts only
 * MIN/MAX_INSTANCES, LOG_LEVEL, AUTO_SUSPEND_SECS, MIN_READY_INSTANCES,
 * QUERY_WAREHOUSE, AUTO_RESUME, EXTERNAL_ACCESS_INTEGRATIONS and COMMENT. Every
 * other change we make goes through ALTER for good reason; this one cannot.
 *
 * The cost is a cold start: new nodes pull the image and reload several GB of
 * weights, so expect a minute or so before the worker is useful again.
 *
 * Refuses while any job is in flight. Dropping the service kills its containers
 * outright, so an in-progress narration would die with no failure written and no
 * partial audio kept — the one case where the blunt instrument is unrecoverable.
 */
export async function switchPool(pool: string): Promise<void> {
  assertIdentifier(pool)

  const pools = await querySnowflake(`SHOW COMPUTE POOLS LIKE '${pool}'`)
  if (!pools.length) throw new Error(`No compute pool named ${pool}.`)

  const busy = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.JOBS WHERE state IN ('QUEUED', 'RUNNING')`,
  )
  const n = Number((busy[0] as any)?.N ?? 0)
  if (n > 0) {
    throw new Error(
      `${n} job${n === 1 ? " is" : "s are"} still queued or running. ` +
        "Switching pools restarts the worker and would lose that work — " +
        "wait for it to finish, or cancel it first.",
    )
  }

  const { worker_count } = await readSettings()
  const count = Math.max(1, Number(worker_count) || 1)
  const warehouse = await activeWarehouse()

  // Settings first: if the CREATE below fails, the app must already agree with the
  // user about which pool it is trying to use, or the UI would keep showing the old
  // pool while no service exists at all and offer no way to retry.
  await writeSetting("gpu_pool", pool)

  await querySnowflake(`DROP SERVICE IF EXISTS ${SERVICE}`)
  await querySnowflake(
    `CREATE SERVICE ${SERVICE}
       IN COMPUTE POOL ${pool}
       FROM @${SPEC_STAGE}
       SPECIFICATION_FILE = '${SPEC_FILE}'
       MIN_INSTANCES = ${count}
       MAX_INSTANCES = ${count}
       ${warehouse ? `QUERY_WAREHOUSE = ${assertIdentifier(warehouse)}` : ""}`,
  )
}

/** Sets the warehouse the worker service runs its queries on.
 *
 * QUERY_WAREHOUSE is one of the properties ALTER SERVICE accepts, but the docs are
 * explicit that it belongs to the group that "take effect only after service is
 * restarted" — so the ALTER alone would silently leave the running worker on the
 * old warehouse. The service is therefore bounced, which costs a model reload.
 *
 * Refused while work is in flight, for the same reason as a pool switch: suspending
 * kills the containers and an in-progress narration would die without a failure
 * being recorded.
 */
export async function setWarehouse(warehouse: string): Promise<void> {
  assertIdentifier(warehouse)

  const found = await querySnowflake(`SHOW WAREHOUSES LIKE '${warehouse}'`)
  if (!found.length) throw new Error(`No warehouse named ${warehouse}.`)

  const busy = await querySnowflake(
    `SELECT COUNT(*) AS N FROM ${DB}.JOBS WHERE state IN ('QUEUED', 'RUNNING')`,
  )
  const n = Number((busy[0] as any)?.N ?? 0)
  if (n > 0) {
    throw new Error(
      `${n} job${n === 1 ? " is" : "s are"} still queued or running. ` +
        "Changing the warehouse restarts the worker and would lose that work — " +
        "wait for it to finish, or cancel it first.",
    )
  }

  await querySnowflake(
    `ALTER SERVICE ${SERVICE} SET QUERY_WAREHOUSE = ${warehouse}`,
  )
  await writeSetting("warehouse", warehouse)

  // Bounce so the new warehouse is actually in force. Suspend/resume rather than
  // drop/create: the service keeps its identity, its pool and its spec.
  await querySnowflake(`ALTER SERVICE ${SERVICE} SUSPEND`)
  await querySnowflake(`ALTER SERVICE ${SERVICE} RESUME`)
}
