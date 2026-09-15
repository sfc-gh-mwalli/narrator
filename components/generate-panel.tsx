"use client"

/**
 * Generate narrations and play them back.
 *
 * A narration is one script -> one Extended call -> one file. There is no
 * directive grammar and no segmentation of our own: script text is passed
 * through verbatim.
 *
 * Sections of a talk are separate narrations sharing a `project`, played in
 * order. That adapts to how long a live demo actually runs, which a single file
 * with baked-in gaps cannot.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { lintScript } from "@/lib/script-lint"

interface Speaker {
  speakerId: string
  name: string
  state: string
}

type VaryAxis = "cfgWeight" | "temperature" | "exaggeration"

interface Narration {
  narrationId: string
  project: string | null
  title: string
  speakerId: string
  speakerName: string | null
  audioPath: string | null
  format: string | null
  durationMs: number | null
  state: "DRAFT" | "QUEUED" | "GENERATING" | "READY" | "FAILED" | "CANCELLED"
  createdOn: string | null
  job: { state: string; failureReason: string | null } | null
  // Needed to reload a past take into the form. The script has always been
  // persisted; it simply was not sent to the client before.
  scriptText: string
  exaggeration: number | null
  temperature: number | null
  cfgWeight: number | null
  takesPerChunk: number | null
  chunksTotal: number | null
  chunksReady: number | null
  chunksGenerating: number | null
  waitingBehind: number | null
}

export function GeneratePanel() {
  const qc = useQueryClient()
  const [speakerId, setSpeakerId] = useState("")
  const [project, setProject] = useState("")
  const [title, setTitle] = useState("")
  const [script, setScript] = useState("")
  // Recomputed on every keystroke. Pure string work on a script-sized input, so it
  // is far cheaper than the debounce machinery avoiding it would cost.
  const findings = lintScript(script)
  const [cfgWeight, setCfgWeight] = useState(0.5)
  const [temperature, setTemperature] = useState(0.8)
  const [exaggeration, setExaggeration] = useState(0.5)
  // Defaults chosen from measurement, not taste: see sql/05_takes_per_chunk.sql.
  const [takesPerChunk, setTakesPerChunk] = useState(3)
  const [variants, setVariants] = useState(1)
  const [varyBy, setVaryBy] = useState<VaryAxis>("cfgWeight")
  const [varyStep, setVaryStep] = useState(0.1)
  const [error, setError] = useState<string | null>(null)

  const speakers = useQuery<Speaker[]>({
    queryKey: ["speakers"],
    queryFn: async () => {
      const r = await fetch("/api/speakers")
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load speakers")
      return r.json()
    },
  })

  const narrations = useQuery<Narration[]>({
    queryKey: ["narrations"],
    queryFn: async () => {
      const r = await fetch("/api/narrations")
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load narrations")
      return r.json()
    },
    refetchInterval: (q) =>
      q.state.data?.some((n) => ["QUEUED", "GENERATING"].includes(n.state)) ? 5000 : false,
  })

  /** Worker progress, for the bar on the in-flight row.
   *
   * Shares the ["gpu"] query key with GpuCard, so react-query dedupes this into
   * a single request rather than two components polling the same endpoint. Polled
   * faster than the narration list because it is the thing that actually moves. */
  const gpu = useQuery<{
    phase: string | null
    progressDone: number | null
    progressTotal: number | null
    currentNarrationId: string | null
  }>({
    queryKey: ["gpu"],
    queryFn: async () => {
      const r = await fetch("/api/gpu")
      if (!r.ok) throw new Error("Failed to load worker status")
      return r.json()
    },
    refetchInterval: () =>
      narrations.data?.some((n) => ["QUEUED", "GENERATING"].includes(n.state))
        ? 3000
        : false,
  })

  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/narrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speakerId,
          project: project.trim() || null,
          title: title.trim(),
          scriptText: script,
          format: "mp3",
          cfgWeight,
          temperature,
          exaggeration,
          takesPerChunk,
          variants,
          varyBy,
          varyStep,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to queue narration")
      return r.json()
    },
    onSuccess: () => {
      setError(null)
      // Deliberately NOT clearing the script or title. A generation takes
      // minutes, and the main reason to submit twice is to re-run the SAME text
      // at different slider settings — wiping the field made the one thing worth
      // keeping the one thing you lost. Leaving it also means a failed submit
      // never costs you your text.
      qc.invalidateQueries({ queryKey: ["narrations"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  /** Pull a previous narration's script and settings back into the form.
   *
   * The script has always been stored in NARRATIONS.script_text; it just was not
   * read back, so text that left the textarea looked unrecoverable. This makes
   * every past take a starting point for the next one.
   */
  function reuse(n: Narration) {
    setSpeakerId(n.speakerId)
    setProject(n.project ?? "")
    setTitle(n.title)
    setScript(n.scriptText)
    if (n.cfgWeight !== null) setCfgWeight(n.cfgWeight)
    if (n.temperature !== null) setTemperature(n.temperature)
    if (n.exaggeration !== null) setExaggeration(n.exaggeration)
    if (n.takesPerChunk !== null) setTakesPerChunk(n.takesPerChunk)
    setError(null)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  /** The exact values the sweep will use, so the cost is visible before submitting. */
  const sweepPreview = useMemo(() => {
    const base = { cfgWeight, temperature, exaggeration }[varyBy]
    const bounds = {
      cfgWeight: [0, 1],
      temperature: [0.05, 1.5],
      exaggeration: [0, 2],
    }[varyBy]
    const mid = (variants - 1) / 2
    return Array.from({ length: variants }, (_, i) =>
      Math.min(bounds[1], Math.max(bounds[0], base + (i - mid) * varyStep)).toFixed(2),
    ).join(" / ")
  }, [cfgWeight, temperature, exaggeration, varyBy, varyStep, variants])

  /** Wall-clock estimate for 5 minutes of audio.
   *
   * Fitted to two measured A10G runs rather than extrapolated from one:
   *   3.8s audio, 1 take  -> 21s wall
   *   243.4s audio, 1 take -> 282s wall
   * which solves to ~17s fixed overhead plus ~1.09x realtime per take. The fixed
   * part is mostly loading and unloading the Whisper model once per job; it
   * dominates a short clip (which is why a 4s test looked like RTF 5.6) and is
   * negligible on a real script. Ignoring it overestimated a 5-minute job by
   * about 45%. */
  const estimatedMinutes = useMemo(() => {
    const secs = 17 + 300 * 1.089 * takesPerChunk * variants
    const mins = secs / 60
    return mins < 60 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} hr`
  }, [takesPerChunk, variants])

  const remove = useMutation({
    mutationFn: async (n: Narration) => {
      const r = await fetch(
        `/api/narrations?narrationId=${encodeURIComponent(n.narrationId)}`,
        { method: "DELETE" },
      )
      if (!r.ok) throw new Error((await r.json()).error ?? "Delete failed")
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["narrations"] })
    },
    onError: (e: Error) => setError(e.message),
  })


  const cancel = useMutation({
    mutationFn: async (n: Narration) => {
      const r = await fetch("/api/narrations/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrationId: n.narrationId }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "Cancel failed")
      return (await r.json()) as { state: string }
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["narrations"] })
      // The GPU card owns the progress bar, and cancelling changes what it should
      // be showing, so refresh it rather than waiting out its poll interval.
      qc.invalidateQueries({ queryKey: ["gpu"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const ready = speakers.data?.filter((s) => s.state === "READY") ?? []

  // Group by project so a talk's sections sit together in order.
  const grouped = useMemo(() => {
    const g = new Map<string, Narration[]>()
    for (const n of narrations.data ?? []) {
      const key = n.project ?? "(no project)"
      if (!g.has(key)) g.set(key, [])
      g.get(key)!.push(n)
    }
    return [...g.entries()]
  }, [narrations.data])

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold tracking-tight">Generate narration</h2>

      {ready.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No enrolled voices yet — enroll one above first.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Voice</span>
              <select
                value={speakerId}
                onChange={(e) => setSpeakerId(e.target.value)}
                className="min-w-44 rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Select…</option>
                {ready.map((s) => (
                  <option key={s.speakerId} value={s.speakerId}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Project (talk)</span>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="e.g. Q3 Architecture Review"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Section title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Section 1 — Intro"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Script</span>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={6}
              placeholder="Paste the narration script for this section… Use [pause:2s] to hold for a demo action."
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
            />
          </label>

          {/* Preflight lint. Every finding here is something that costs a
              multi-minute GPU run to discover otherwise, which is the entire
              argument for showing it before submit.

              Warnings never block: the model is not deterministic and none of these
              patterns is certain to fail, so refusing a submit on a heuristic would
              be worse than a slightly worse take — especially now that a single
              chunk can be repaired without redoing the narration. A malformed pause
              tag is the one error, because it is a typo whose consequence is silent:
              it gets read aloud. */}
          {findings.length > 0 && (
            <ul className="flex flex-col gap-1.5 rounded-md border border-amber-600/30 bg-amber-600/5 p-2.5 text-xs">
              {findings.map((f, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    className={
                      f.severity === "error"
                        ? "font-medium text-red-500"
                        : "font-medium text-amber-700 dark:text-amber-400"
                    }
                  >
                    {f.severity === "error" ? "Fix" : "Note"}
                  </span>
                  <span className="text-muted-foreground">
                    {f.message}
                    {f.excerpt ? (
                      <span className="ml-1 font-mono text-foreground/70">
                        “{f.excerpt}”
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-xs font-medium">
              Voice tuning — adjust if the clone doesn&apos;t sound like you
            </summary>
            <div className="mt-3 flex flex-wrap gap-5">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  CFG weight: {cfgWeight.toFixed(2)}
                </span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={cfgWeight}
                  onChange={(e) => setCfgWeight(Number(e.target.value))}
                  className="w-40"
                />
                <span className="text-[11px] text-muted-foreground">
                  Pacing, not voice likeness. 0.5 is the default; Resemble
                  recommend ~0.3 when the reference speaker talks fast, which
                  gives slower, more deliberate delivery. Exaggeration speeds
                  speech up, so raise that and lower this together.</span>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  Temperature: {temperature.toFixed(2)}
                </span>
                <input
                  type="range" min={0.05} max={1.5} step={0.05}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-40"
                />
                <span className="text-[11px] text-muted-foreground">
                  Lower is steadier and more faithful; higher varies more.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  Exaggeration: {exaggeration.toFixed(2)}
                </span>
                <input
                  type="range" min={0} max={2} step={0.05}
                  value={exaggeration}
                  onChange={(e) => setExaggeration(Number(e.target.value))}
                  className="w-40"
                />
                <span className="text-[11px] text-muted-foreground">
                  0 flat · 0.5 default · 1 normal · 2 exaggerated.
                </span>
              </label>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Each setting is stored with the narration, so you can compare runs.
            </p>
          </details>

          {/* Quality / throughput. Separate from voice tuning above because these
              two do not change how the voice sounds — they change how much compute
              is spent and how many results you get back. */}
          <details className="mt-3 rounded-md border p-3">
            <summary className="cursor-pointer text-xs font-medium">
              Quality &amp; run time — takes per chunk, variants
            </summary>

            <div className="mt-3 flex flex-wrap gap-6">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  Takes per chunk: {takesPerChunk}
                </span>
                <input
                  type="range" min={1} max={6} step={1}
                  value={takesPerChunk}
                  onChange={(e) => setTakesPerChunk(Number(e.target.value))}
                  className="w-40"
                />
                <span className="text-[11px] text-muted-foreground">
                  Each chunk is generated this many times and Whisper keeps the
                  best. About 11% of takes come out with a wrong or dropped word,
                  and a narration is only as good as its worst chunk — so on a
                  5-minute script 1 take is ~11% likely to be clean, 3 takes
                  ~97.5%. Cost is linear: doubling this doubles the run time.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  Variants: {variants}
                </span>
                <input
                  type="range" min={1} max={5} step={1}
                  value={variants}
                  onChange={(e) => setVariants(Number(e.target.value))}
                  className="w-40"
                />
                <span className="text-[11px] text-muted-foreground">
                  Queue several complete narrations in one go, then pick the one
                  that sounds most like you. Whisper only scores wording, never
                  voice likeness, so that judgement is yours.
                </span>
              </label>

              {variants > 1 && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Vary which setting</span>
                  <select
                    value={varyBy}
                    onChange={(e) => setVaryBy(e.target.value as VaryAxis)}
                    className="rounded-md border bg-background px-2 py-1 text-sm"
                  >
                    <option value="cfgWeight">CFG weight (pacing)</option>
                    <option value="temperature">Temperature</option>
                    <option value="exaggeration">Exaggeration</option>
                  </select>
                  <span className="mt-1 text-muted-foreground">
                    Step: {varyStep.toFixed(2)}
                  </span>
                  <input
                    type="range" min={0.05} max={0.3} step={0.05}
                    value={varyStep}
                    onChange={(e) => setVaryStep(Number(e.target.value))}
                    className="w-40"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Only one setting is swept, so any difference you hear is
                    attributable to it. Your own value stays in the middle:{" "}
                    <span className="font-mono">{sweepPreview}</span>
                  </span>
                </label>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Roughly{" "}
              <span className="font-medium">{estimatedMinutes}</span> of GPU time
              for 5 minutes of audio ({takesPerChunk} take
              {takesPerChunk === 1 ? "" : "s"} × {variants} variant
              {variants === 1 ? "" : "s"}). The pool bills while it works.
            </p>
          </details>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => submit.mutate()}
              disabled={
                submit.isPending || !speakerId || !title.trim() || !script.trim()
              }
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
            >
              {submit.isPending ? "Queueing…" : "Generate"}
            </button>
            <span className="text-xs text-muted-foreground">
              Queued immediately; a worker picks it up when available.
            </span>
          </div>
        </div>
      )}

      {/* narrations, grouped by project */}
      {grouped.length > 0 && (
        <div className="mt-6 space-y-5">
          {grouped.map(([proj, items]) => (
            <div key={proj}>
              <h3 className="text-xs font-medium text-muted-foreground">{proj}</h3>
              <ul className="mt-2 space-y-2">
                {items.map((n) => (
                  <li
                    key={n.narrationId}
                    className="flex flex-wrap items-center gap-3 rounded-md border p-2.5"
                  >
                    <span className="text-sm font-medium">{n.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {n.speakerName ?? "—"}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        n.state === "READY"
                          ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                          : n.state === "FAILED"
                            ? "bg-red-600/10 text-red-600 dark:text-red-400"
                            : n.state === "CANCELLED"
                              ? "bg-muted text-muted-foreground"
                              : "bg-amber-600/10 text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {/* A narration is marked GENERATING the moment PLAN finishes
                          splitting the script, which is before any chunk work has
                          started. With work queued ahead of it, that reads
                          "GENERATING · 0/18" and looks frozen — it isn't
                          generating, it is waiting. The chunk rows are the only
                          place the truth lives, so the label is derived from them. */}
                      {n.state === "GENERATING" &&
                      (n.chunksTotal ?? 0) > 0 &&
                      (n.chunksReady ?? 0) === 0 &&
                      (n.chunksGenerating ?? 0) === 0
                        ? "WAITING"
                        : n.state}
                    </span>

                    {/* Progress, preferring the narration's own chunk rows over
                        worker heartbeats.

                        Chunk rows are the only source that stays correct with more
                        than one worker: each worker heartbeats about the single
                        chunk it holds and knows nothing of the others, so its
                        done/total would jump around and under-report. The rows
                        also survive a worker restart. The heartbeat is kept as a
                        fallback for the window after submit but before PLAN has
                        split the script, when no chunk rows exist yet. */}
                    {/* Nothing in flight and nothing done: say what it is waiting
                        for. Chunk jobs are claimed oldest-first, so an older
                        unfinished narration takes every worker until it drains. */}
                    {n.state === "GENERATING" &&
                    (n.chunksTotal ?? 0) > 0 &&
                    (n.chunksReady ?? 0) === 0 &&
                    (n.chunksGenerating ?? 0) === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {(n.waitingBehind ?? 0) > 0
                          ? `queued behind ${n.waitingBehind} narration${n.waitingBehind === 1 ? "" : "s"} · ${n.chunksTotal} chunks planned`
                          : `waiting for a worker · ${n.chunksTotal} chunks planned`}
                      </span>
                    ) : null}

                    {n.state === "GENERATING"
                      ? (() => {
                          const byChunks = (n.chunksTotal ?? 0) > 0
                          const done = byChunks
                            ? (n.chunksReady ?? 0)
                            : (gpu.data?.progressDone ?? 0)
                          const total = byChunks
                            ? (n.chunksTotal ?? 0)
                            : (gpu.data?.progressTotal ?? 0)
                          const mine =
                            byChunks ||
                            gpu.data?.currentNarrationId === n.narrationId
                          if (!total || !mine) return null
                          // Handled by the "queued behind" line above.
                          if (byChunks && done === 0 && (n.chunksGenerating ?? 0) === 0)
                            return null
                          return (
                            <span className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                <span
                                  className="block h-full rounded-full bg-amber-600 transition-[width] duration-500"
                                  style={{
                                    width: `${Math.min(100, Math.round((100 * done) / total))}%`,
                                  }}
                                />
                              </span>
                              <span className="font-mono">
                                {byChunks
                                  ? `chunk ${done}/${total}`
                                  : `${String(gpu.data?.phase ?? "").toLowerCase()} ${done}/${total}`}
                              </span>
                            </span>
                          )
                        })()
                      : null}

                    {/* Cancel, not Delete, while in flight. A single worker means
                        one long job blocks every other one, and the only previous
                        way out was restarting the service — which also threw away
                        the 30-60s model load. */}
                    {(n.state === "QUEUED" || n.state === "GENERATING") && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Stop generating "${n.title}"? Audio produced so far is discarded.`,
                            )
                          ) {
                            cancel.mutate(n)
                          }
                        }}
                        disabled={cancel.isPending}
                        title="Ask the worker to stop. It checks between chunks, so this takes a few seconds."
                        className="ml-auto rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-40"
                      >
                        {cancel.isPending ? "Cancelling…" : "Cancel"}
                      </button>
                    )}

                    {/* Streamed through the app, not a presigned S3 URL: inside
                        SPCS those resolve to the SPCS access point, which denies
                        browser fetches. The player was greying out because its
                        source could not be read. */}
                    {n.state === "READY" && (
                      <>
                        <audio
                          controls
                          preload="none"
                          src={`/api/narrations/audio?id=${encodeURIComponent(n.narrationId)}`}
                          className="h-9"
                        />
                        <a
                          href={`/api/narrations/audio?id=${encodeURIComponent(n.narrationId)}&download=1`}
                          className="text-xs underline"
                        >
                          Download
                        </a>
                      </>
                    )}

                    {n.state === "FAILED" && n.job?.failureReason && (
                      <span className="text-xs text-red-500">
                        {n.job.failureReason.slice(0, 160)}
                      </span>
                    )}

                    {/* Settings are shown because titles are not unique: the whole
                        point of re-running is to compare the same script at
                        different values, so the values are what tell takes apart. */}
                    <span className="ml-auto flex items-center gap-2">
                      {n.cfgWeight !== null && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          cfg {n.cfgWeight} · temp {n.temperature} · exag {n.exaggeration}
                          {n.takesPerChunk ? ` · ${n.takesPerChunk} takes` : ""}
                          {n.durationMs ? ` · ${(n.durationMs / 1000).toFixed(1)}s` : ""}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => reuse(n)}
                        title="Load this script and its settings back into the form"
                        className="rounded-md border px-2.5 py-1 text-xs"
                      >
                        Reuse script
                      </button>
                      {/* Deleting is irreversible and the audio took minutes to
                          make, so it asks first. In-flight narrations are refused
                          server-side; the button is disabled here too so the
                          rejection is not the way you find that out. */}
                      <button
                        type="button"
                        disabled={
                          remove.isPending ||
                          n.state === "QUEUED" ||
                          n.state === "GENERATING"
                        }
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete "${n.title}" and its audio file? This cannot be undone.`,
                            )
                          ) {
                            remove.mutate(n)
                          }
                        }}
                        title={
                          n.state === "QUEUED" || n.state === "GENERATING"
                            ? "Still generating — wait for it to finish"
                            : "Delete this narration and its audio"
                        }
                        className="rounded-md border border-red-500/40 px-2.5 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-40 dark:text-red-400"
                      >
                        Delete
                      </button>
                    </span>

                    {/* Per-chunk inspector and repair.
                        Collapsed by default and fetched only when opened, so a list
                        of thirty narrations does not fire thirty queries. */}
                    {(n.chunksTotal ?? 0) > 0 && (
                      <ChunkInspector
                        narrationId={n.narrationId}
                        title={n.title}
                        busy={n.state === "QUEUED" || n.state === "GENERATING"}
                        onError={setError}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  )
}

interface ChunkRow {
  chunkIndex: number
  audioPath: string | null
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
  unpassed: boolean
}

/** Chunk-level detail with selective regeneration.
 *
 * This exists because the unit of badness is a chunk, not a narration. Before this,
 * one bad sentence in eighteen meant regenerating all eighteen — paying for
 * seventeen good chunks and risking that a previously good one came back worse.
 *
 * Chunks that no take could validate are pre-selected on open, because they are the
 * ones repair is actually for. Everything else is opt-in: a low score that PASSED
 * validation is usually fine, and regenerating it is as likely to make it worse.
 */
function ChunkInspector({
  narrationId,
  title,
  busy,
  onError,
}: {
  narrationId: string
  title: string
  busy: boolean
  onError: (m: string | null) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<number> | null>(null)
  // Which chunk is expanded for listening, and its presigned URL. One at a time:
  // several <audio> elements would let two chunks play over each other, and the
  // point of auditioning is to hear one thing clearly.
  const [playing, setPlaying] = useState<number | null>(null)

  // The <audio> src points at our own streaming route, not a presigned URL.
  //
  // A presigned URL is unusable from SPCS: it resolves to the SPCS S3 access
  // point, which denies external callers, so the browser gets a 403 and renders
  // greyed-out controls reading 0:00 — audio that looks broken for a reason
  // nothing in the UI can show. /api/narrations/chunk-audio relays the bytes over
  // the app's own authenticated origin instead, which is how narration playback
  // has always worked.
  //
  // Pointing src directly at the route also removes the fetch-then-set-URL dance:
  // the browser streams it, honours Range for seeking, and reports its own errors.
  const chunkSrc = (i: number) =>
    `/api/narrations/chunk-audio?narrationId=${encodeURIComponent(narrationId)}&chunk=${i}`

  function audition(i: number) {
    setPlaying(playing === i ? null : i)
  }

  const chunks = useQuery<ChunkRow[]>({
    queryKey: ["chunks", narrationId],
    enabled: open,
    queryFn: async () => {
      const r = await fetch(
        `/api/narrations/chunks?narrationId=${encodeURIComponent(narrationId)}`,
      )
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to read chunks")
      return r.json()
    },
    refetchInterval: busy ? 5000 : false,
  })

  // Default the selection to the chunks that failed validation, once, on load.
  const selected =
    picked ??
    new Set((chunks.data ?? []).filter((c) => c.unpassed).map((c) => c.chunkIndex))

  const toggle = (i: number) => {
    const next = new Set(selected)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setPicked(next)
  }

  const repair = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/narrations/chunks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrationId, chunkIndexes: [...selected] }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "Repair failed")
      return j
    },
    onSuccess: () => {
      onError(null)
      setPicked(null)
      qc.invalidateQueries({ queryKey: ["narrations"] })
      qc.invalidateQueries({ queryKey: ["chunks", narrationId] })
      qc.invalidateQueries({ queryKey: ["gpu"] })
    },
    onError: (e: Error) => onError(e.message),
  })

  const failing = (chunks.data ?? []).filter((c) => c.unpassed).length

  return (
    <details
      className="mt-1 w-full"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Chunks
        {failing > 0 ? (
          <span className="ml-1 text-amber-700 dark:text-amber-400">
            — {failing} with no passing take
          </span>
        ) : null}
      </summary>

      {chunks.isLoading && (
        <p className="mt-2 text-xs text-muted-foreground">Loading chunks…</p>
      )}

      {chunks.data && (
        <div className="mt-2 flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {chunks.data.map((c) => (
              <li
                key={c.chunkIndex}
                className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${
                  c.unpassed ? "border-amber-600/40 bg-amber-600/5" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.chunkIndex)}
                  disabled={busy || repair.isPending}
                  onChange={() => toggle(c.chunkIndex)}
                  className="mt-0.5"
                />
                <span className="w-8 shrink-0 font-mono text-muted-foreground">
                  {c.chunkIndex}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.text}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                    {c.state}
                    {c.durationMs ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : ""}
                    {/* A score of 0 with no failure reason means the metrics were
                        never recorded, which is not the same as a bad chunk. */}
                    {c.score !== null && (c.score > 0 || c.unpassed)
                      ? ` · score ${c.score.toFixed(3)}`
                      : " · score not recorded"}
                    {c.attempt > 0 ? ` · attempt ${c.attempt + 1}` : ""}
                    {c.pauseAfterMs ? ` · pause ${c.pauseAfterMs}ms` : ""}
                  </span>
                  {c.failureReason ? (
                    <span className="mt-0.5 block text-[11px] text-amber-700 dark:text-amber-400">
                      {c.failureReason}
                    </span>
                  ) : null}

                  {/* Auditioning is the only way to catch the failure mode scores
                      cannot see: a take can score 1.000 and still contain a loud
                      non-speech run, because Whisper compares transcripts and
                      babble transcribes to nothing. */}
                  {c.audioPath ? (
                    <span className="mt-1 block">
                      <button
                        type="button"
                        onClick={() => audition(c.chunkIndex)}
                        className="rounded-md border px-2 py-0.5 text-[11px] font-medium"
                      >
                        {playing === c.chunkIndex ? "Hide" : "Listen"}
                      </button>
                      {playing === c.chunkIndex ? (
                        <audio
                          src={chunkSrc(c.chunkIndex)}
                          controls
                          autoPlay
                          preload="metadata"
                          className="mt-1 block h-8 w-full max-w-md"
                        />
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || repair.isPending || selected.size === 0}
              onClick={() => {
                if (
                  window.confirm(
                    `Regenerate ${selected.size} chunk(s) of "${title}" and reassemble?`,
                  )
                ) {
                  repair.mutate()
                }
              }}
              title={
                busy
                  ? "Still generating — wait for it to finish"
                  : "Regenerate only the selected chunks, then rejoin the audio"
              }
              className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40"
            >
              {repair.isPending
                ? "Queueing…"
                : `Regenerate ${selected.size} chunk${selected.size === 1 ? "" : "s"}`}
            </button>
            <span className="text-[11px] text-muted-foreground">
              Only the selected chunks are generated again; the rest keep their audio.
              Each repair uses a new seed, so a retry is genuinely a different take.
            </span>
          </div>
        </div>
      )}
    </details>
  )
}
