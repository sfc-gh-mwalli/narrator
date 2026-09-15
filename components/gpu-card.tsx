"use client"

/**
 * GPU pool control and status.
 *
 * The pool runs with AUTO_RESUME = FALSE, so waking it is an explicit act and
 * jobs simply queue while it sleeps. Readiness is reported as three distinct
 * stages — pool, container, model — because a cold start takes 60-90s and
 * collapsing that into one spinner is indistinguishable from a hang.
 *
 * Suspend is offered alongside Wake deliberately: without it, every short
 * iteration burns the full 5-minute AUTO_SUSPEND_SECS window.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

type WarmupStage = "suspended" | "pool" | "container" | "model" | "ready"

interface GpuStatus {
  stage: WarmupStage
  poolState: string
  containerStatus: string | null
  workerState: string | null
  modelLoaded: boolean
  heartbeatAgeSeconds: number | null
  workerStale: boolean
  workerExpected: boolean
  queuedJobs: number
  phase: string | null
  progressDone: number | null
  progressTotal: number | null
  currentNarrationId: string | null
  liveWorkers: number
  pool: string
  serviceState: string | null
  message: string
}

interface GpuPool {
  name: string
  state: string
  instanceFamily: string
  gpu: string | null
  gpuPerNode: number
  gpuMemoryGib: number
  minNodes: number
  maxNodes: number
  gpuCapacity: number
  gpuNow: number
  currentNodes: number
  active: boolean
  comment: string | null
}

interface WarehouseOption {
  name: string
  size: string
  state: string
  autoSuspendSecs: number | null
}

interface SettingsPayload {
  gpuPool: string
  workerCount: number
  /** Explicit choice, or "" meaning inherit the session's warehouse. */
  warehouse: string
  /** What is actually in force, after the fallback. */
  effectiveWarehouse: string | null
  warehouses: WarehouseOption[]
  pools: GpuPool[]
  scale: {
    minInstances: number
    maxInstances: number
    targetInstances: number
    currentInstances: number
  } | null
}

const STAGES: { key: WarmupStage; label: string }[] = [
  { key: "pool", label: "Pool" },
  { key: "container", label: "Container" },
  { key: "model", label: "Model" },
  { key: "ready", label: "Ready" },
]

/** The worker's phase names, in terms of what is actually happening. */
const PHASE_LABELS: Record<string, string> = {
  GENERATING: "Generating takes (chunks)",
  CHECKING: "Checking takes with Whisper",
  ASSEMBLING: "Assembling and uploading audio",
}

function stageIndex(stage: WarmupStage): number {
  if (stage === "suspended") return -1
  return STAGES.findIndex((s) => s.key === stage)
}

export function GpuCard() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<GpuStatus>({
    queryKey: ["gpu"],
    queryFn: async () => {
      const r = await fetch("/api/gpu")
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to read GPU status")
      return r.json()
    },
    // Poll quickly while warming, slowly once settled — the pool state only
    // changes on an explicit action or the idle timeout.
    refetchInterval: (q) => {
      const s = q.state.data?.stage
      return s && s !== "ready" && s !== "suspended" ? 4000 : 15000
    },
  })

  const act = useMutation({
    mutationFn: async (action: "wake" | "suspend") => {
      const r = await fetch("/api/gpu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "GPU action failed")
      return r.json()
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["gpu"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  // Compute settings. Kept in a separate query from status because they change
  // only when a human changes them, so polling them on the status interval would
  // be pure waste — and because a failure to enumerate pools must not blank out
  // the status card.
  const settings = useQuery<SettingsPayload>({
    queryKey: ["settings"],
    queryFn: async () => {
      const r = await fetch("/api/settings")
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to read settings")
      return r.json()
    },
    staleTime: 30_000,
  })

  // Draft state for the two controls. Seeded from the server once loaded, then
  // owned by the user until applied — so typing is not overwritten by a refetch.
  const [draftPool, setDraftPool] = useState<string | null>(null)
  const [draftWorkers, setDraftWorkers] = useState<string | null>(null)
  const [draftWarehouse, setDraftWarehouse] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const pool = draftPool ?? settings.data?.gpuPool ?? ""
  const workers = draftWorkers ?? String(settings.data?.workerCount ?? 1)
  const chosen = settings.data?.pools.find((p) => p.name === pool) ?? null
  const workersNum = Number(workers)
  const warehouse =
    draftWarehouse ??
    settings.data?.warehouse ??
    settings.data?.effectiveWarehouse ??
    ""

  const poolDirty = Boolean(settings.data && pool !== settings.data.gpuPool)
  const workersDirty = Boolean(
    settings.data && Number.isFinite(workersNum) && workersNum !== settings.data.workerCount,
  )
  const warehouseDirty = Boolean(
    settings.data &&
      warehouse &&
      warehouse !== (settings.data.warehouse || settings.data.effectiveWarehouse),
  )
  const dirty = poolDirty || workersDirty || warehouseDirty

  const apply = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gpuPool: pool,
          workerCount: workersNum,
          warehouse,
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "Failed to apply settings")
      return j as { notes?: string[] }
    },
    onSuccess: (j) => {
      setError(null)
      setNote(j.notes?.length ? j.notes.join(" ") : "No change was needed.")
      setDraftPool(null)
      setDraftWorkers(null)
      setDraftWarehouse(null)
      qc.invalidateQueries({ queryKey: ["settings"] })
      qc.invalidateQueries({ queryKey: ["gpu"] })
    },
    onError: (e: Error) => {
      setNote(null)
      setError(e.message)
    },
  })

  const current = stageIndex(data?.stage ?? "suspended")
  const warming = data && data.stage !== "ready" && data.stage !== "suspended"

  // Which transition is underway, judged from the account's own reported state
  // rather than from the mutation.
  //
  // act.isPending covers only the HTTP round trip, which returns in about a
  // second — but a resume takes 30-60s while a node provisions and the model
  // loads. Labelling the button from act.isPending alone therefore snapped it back
  // to "Resume" almost immediately, inviting a second click on an operation that
  // was already running. `warming` is true for the whole cold start, so the label
  // stays honest until the worker is actually ready.
  //
  // act.variables holds the argument of the most recent call, which is how one
  // shared mutation can tell the two buttons apart.
  const pending = act.isPending ? act.variables : null
  const resuming = pending === "wake" || Boolean(warming)
  const suspending =
    pending === "suspend" ||
    data?.serviceState === "SUSPENDING" ||
    data?.poolState === "STOPPING"

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">GPU worker</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isLoading ? "Checking…" : data?.message}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => act.mutate("wake")}
            disabled={
              act.isPending ||
              resuming ||
              !data ||
              // Enabled whenever nothing is serving work: a suspended POOL, or a
              // suspended SERVICE on a live pool. The latter used to disable Wake,
              // which left no way to start the worker from the UI at all.
              !(data.stage === "suspended" || data.serviceState === "SUSPENDED")
            }
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {resuming ? "Resuming…" : "Resume"}
          </button>
          <button
            type="button"
            onClick={() => act.mutate("suspend")}
            disabled={
              act.isPending ||
              suspending ||
              !data ||
              (data.serviceState === "SUSPENDED" &&
                (data.poolState === "SUSPENDED" || data.poolState === "STOPPING"))
            }
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            {suspending ? "Suspending…" : "Suspend"}
          </button>
        </div>
      </div>

      {/* Warm-up stages, shown individually so a slow cold start reads as
          progress rather than a stall.

          Each chip carries a title and an explicit word ("done" / "now" /
          "waiting"), because colour alone was not decipherable: an amber "Model"
          next to a colourless "Ready" gave no clue whether something was wrong,
          loading, or simply not reached. Colour is now redundant reinforcement
          rather than the only signal, which also makes this readable for anyone
          who cannot distinguish the two hues. */}
      {(warming || data?.stage === "ready") && (
        <ol className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          {STAGES.map((s, i) => {
            const done = current > i || data?.stage === "ready"
            const active = current === i && data?.stage !== "ready"
            const state = done ? "done" : active ? "now" : "waiting"
            const title = done
              ? `${s.label}: finished`
              : active
                ? `${s.label}: in progress right now`
                : `${s.label}: not started yet`
            return (
              <li
                key={s.key}
                title={title}
                className={`rounded-full border px-2.5 py-1 ${
                  done
                    ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                    : active
                      ? "border-amber-600/40 bg-amber-600/10 text-amber-700 dark:text-amber-400"
                      : "border-transparent text-muted-foreground"
                }`}
              >
                {done ? "✓ " : active ? "• " : "◦ "}
                {s.label}
                <span className="ml-1 opacity-60">{state}</span>
              </li>
            )
          })}
        </ol>
      )}

      {/* Progress within the current phase.
          Deliberately not shown as one overall percentage: GENERATING and
          CHECKING have different per-unit costs, so combining them would produce
          a bar that stalls and then leaps. Naming the phase is more honest than
          inventing a single number. */}
      {data?.phase
        ? (() => {
            // A fraction is shown only when the denominator can be believed.
            // Workers on an older image report total=1 for per-chunk work, which
            // rendered "17/1" and a bar pinned at 100%. Rather than display a
            // number that is visibly impossible, fall back to naming the phase —
            // and note that with several workers this is ONE worker's phase, since
            // the per-narration bar in the list is the authoritative progress.
            const total = data.progressTotal ?? 0
            const done = data.progressDone ?? 0
            const sane = total > 1 && done <= total
            return (
              <div className="mt-4">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">
                    {PHASE_LABELS[data.phase] ?? data.phase}
                    {(data.liveWorkers ?? 0) > 1 ? (
                      <span className="ml-1 font-normal text-muted-foreground">
                        (1 of {data.liveWorkers} workers)
                      </span>
                    ) : null}
                  </span>
                  {sane ? (
                    <span className="font-mono text-muted-foreground">
                      {done}/{total}
                    </span>
                  ) : null}
                </div>
                {sane ? (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-600 transition-[width] duration-500"
                      style={{
                        width: `${Math.min(100, Math.round((100 * done) / total))}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>
            )
          })()
        : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Pool</dt>
          <dd className="font-mono">{data?.poolState ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Container</dt>
          <dd className="font-mono">{data?.containerStatus ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Worker</dt>
          <dd className="font-mono">
            {data?.workerState ?? (data ? "not running" : "—")}
            {/* Only a fault when a worker is supposed to be alive. With the pool
                suspended there is nothing to hear from, so flagging the silence
                was pure noise — it read as a crash after a deliberate suspend. */}
            {data?.workerStale && data?.workerExpected ? (
              <span
                className="text-amber-700 dark:text-amber-400"
                title={`No heartbeat for ${data.heartbeatAgeSeconds ?? "?"}s. The worker writes one every few seconds while working, so this means it is not responding.`}
              >
                {" "}
                no heartbeat {data.heartbeatAgeSeconds ?? "?"}s
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Queued jobs</dt>
          <dd className="font-mono">{data?.queuedJobs ?? 0}</dd>
        </div>
      </dl>

      {data?.stage === "suspended" && (
        <p className="mt-3 text-xs text-muted-foreground">
          Resuming bills a 5-minute minimum, and the pool auto-suspends after 5
          minutes idle. Submitting work while suspended is safe — it queues.
        </p>
      )}

      {/* Compute settings: which GPU pool, and how many workers.

          Deliberately two independent controls. Worker count is NOT derived from
          the pool's GPU capacity, because a pool's MAX_NODES is a spending ceiling
          rather than a target — with MIN_NODES=1 and MAX_NODES=4 it is entirely
          reasonable to run one worker most of the time. Capacity is reported
          beside the field instead, so the number is an informed choice. */}
      <div className="mt-4 border-t pt-3">
      {/* A two-column grid rather than a flex-wrap row.
          
          The previous layout put all three fields, the Apply button and the worker
          count in one wrapping flex row, so "0/2 running · 2 pending" wrapped to
          wherever there happened to be space — which was beside the Query warehouse
          label, describing a field it has nothing to do with. A fixed grid keeps
          each field in a known cell, and the worker count now sits inside the
          Workers cell where it belongs. */}
        <div className="grid items-start gap-x-6 gap-y-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">GPU compute pool</span>
            <select
              value={pool}
              disabled={!settings.data || apply.isPending}
              onChange={(e) => setDraftPool(e.target.value)}
              className="h-8 min-w-52 rounded-md border bg-background px-2 text-sm disabled:opacity-40"
            >
              {settings.data?.pools.length ? (
                settings.data.pools.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} — {p.gpuPerNode}×{p.gpu ?? p.instanceFamily}
                    {p.maxNodes > 1 ? ` up to ${p.maxNodes} nodes` : ""}
                  </option>
                ))
              ) : (
                <option value="">
                  {settings.isLoading ? "Loading…" : "No GPU pools found"}
                </option>
              )}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Workers</span>
              <input
                type="number"
                min={1}
                step={1}
                value={workers}
                disabled={!settings.data || apply.isPending}
                onChange={(e) => setDraftWorkers(e.target.value)}
                className="h-8 w-20 rounded-md border bg-background px-2 text-sm disabled:opacity-40"
              />
            </label>
            {data && settings.data ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {/* "Pending" only when the service is actually trying to start
                    them. A suspended service has target_instances set and current
                    at zero, which is not pending — it is stopped, and reporting
                    "3 pending" implied work was underway when nothing was. */}
                {data.serviceState === "SUSPENDED"
                  ? `${settings.data.workerCount} configured · suspended`
                  : `${data.liveWorkers}/${settings.data.workerCount} running${
                      settings.data.scale &&
                      settings.data.scale.currentInstances <
                        settings.data.scale.targetInstances
                        ? ` · ${settings.data.scale.targetInstances - settings.data.scale.currentInstances} pending`
                        : ""
                    }`}
              </span>
            ) : null}
          </div>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Query warehouse</span>
            <select
              value={warehouse}
              disabled={!settings.data || apply.isPending}
              onChange={(e) => setDraftWarehouse(e.target.value)}
              className="h-8 min-w-44 rounded-md border bg-background px-2 text-sm disabled:opacity-40"
            >
              {settings.data?.warehouses.length ? (
                settings.data.warehouses.map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name}
                    {w.size ? ` — ${w.size.toLowerCase()}` : ""}
                  </option>
                ))
              ) : (
                <option value="">
                  {settings.isLoading ? "Loading…" : "No warehouses visible"}
                </option>
              )}
            </select>
          </label>

        </div>

        {/* One worker pins one GPU because the service spec requests
            nvidia.com/gpu: 1 per instance, so GPU count is the real ceiling.

            The two limits behave differently, and the difference is worth stating
            because it is not what most people expect. Asking for more workers than
            the pool could EVER host is refused outright by Snowflake — the ALTER
            fails and the service is left exactly as it was, so nothing goes pending
            and nothing breaks. Asking for more than are available RIGHT NOW but
            within the pool's node ceiling is accepted, and those instances stay
            pending while Snowflake provisions nodes. Both verified against this
            account. */}
        {chosen ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {chosen.name} has {chosen.gpuNow} GPU
            {chosen.gpuNow === 1 ? "" : "s"} available now
            {chosen.gpuCapacity > chosen.gpuNow
              ? `, and up to ${chosen.gpuCapacity} if it scales to its ${chosen.maxNodes}-node limit`
              : ""}
            . One worker uses one GPU.{" "}
            {chosen.gpuCapacity > chosen.gpuNow
              ? `Asking for ${chosen.gpuNow + 1}-${chosen.gpuCapacity} is allowed, and the extra workers stay pending until nodes are added. `
              : ""}
            More than {chosen.gpuCapacity} is refused outright and leaves the service
            unchanged.
            {poolDirty
              ? " Changing the pool recreates the worker service — a cold start of 30-60s, and it is refused while a job is in flight."
              : ""}
          </p>
        ) : null}

        {/* The warehouse only runs the worker's own bookkeeping — claiming jobs,
            heartbeats, reading and writing rows. The GPU does the generation, so
            size buys nothing here and an extra-small existing warehouse is the
            right answer. Said plainly because the instinct is to size up. */}
        {settings.data && !settings.data.warehouse && settings.data.effectiveWarehouse ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Using {settings.data.effectiveWarehouse}, inherited from this session
            because no warehouse has been chosen. The worker only runs small queries
            on it — job claims, heartbeats and row updates — so the smallest one you
            have is fine.
          </p>
        ) : null}

        {warehouseDirty ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Changing the warehouse restarts the worker: a service only picks up a new
            QUERY_WAREHOUSE when it starts. Refused while a job is in flight.
          </p>
        ) : null}

        {data?.serviceState === "SUSPENDED" && workersDirty ? (
          <p className="mt-2 text-xs text-muted-foreground">
            The worker service is suspended, so this count is stored and takes effect
            when you press Resume. Changing it will not start anything by itself.
          </p>
        ) : null}

        {/* Apply sits on its own row, after the notes that explain what applying
            will do. It previously shared the field row, which both crowded the
            fields and put it above the warnings about cold starts and restarts. */}
        <div className="mt-3 flex items-center gap-3 border-t pt-3">
          <button
            type="button"
            onClick={() => apply.mutate()}
            disabled={
              !dirty || apply.isPending || !Number.isInteger(workersNum) || workersNum < 1
            }
            className="h-8 rounded-md border px-3 text-sm font-medium disabled:opacity-40"
          >
            {apply.isPending ? "Applying…" : "Apply"}
          </button>
          {dirty && !apply.isPending ? (
            <span className="text-xs text-amber-600 dark:text-amber-500">
              Unsaved changes
            </span>
          ) : null}
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  )
}
