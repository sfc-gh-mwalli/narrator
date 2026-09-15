"use client"

/**
 * Enrollment: create a speaker, read ONE passage straight through, submit.
 *
 * The passage is paragraph-length by design. The model wants 15-30s of
 * continuous speech (3s floor, ~30s ceiling with diminishing returns beyond),
 * so this is deliberately not a thirty-short-prompts flow.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"

import { VoiceRecorder } from "@/components/voice-recorder"

interface Speaker {
  speakerId: string
  name: string
  state: "DRAFT" | "ENROLLING" | "READY" | "REJECTED"
  refClipPath: string | null
}

interface Prompt {
  promptId: string
  ordinal: number
  label: string | null
  style: string | null
  text: string
}

interface Take {
  takeId: string
  snrDb: number | null
  clipRatio: number | null
  silenceRatio: number | null
  durationMs: number | null
  accepted: boolean | null
  rejectReason: string | null
  createdOn: string | null
  job: { state: string; failureReason: string | null } | null
}

export function EnrollPanel() {
  const qc = useQueryClient()
  const [speakerId, setSpeakerId] = useState<string>("")
  const [newName, setNewName] = useState("")
  const [promptIdx, setPromptIdx] = useState(0)
  const [useCustom, setUseCustom] = useState(false)
  const [customText, setCustomText] = useState("")
  const [pending, setPending] = useState<{ blob: Blob; seconds: number } | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Create the blob URL once per take and revoke it afterwards. Building it
  // inline during render minted a new URL on every re-render, which reset the
  // <audio> element mid-playback and leaked the old ones.
  useEffect(() => {
    if (!pending) {
      setPendingUrl(null)
      return
    }
    const url = URL.createObjectURL(pending.blob)
    setPendingUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pending])

  const speakers = useQuery<Speaker[]>({
    queryKey: ["speakers"],
    queryFn: async () => {
      const r = await fetch("/api/speakers")
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load speakers")
      return r.json()
    },
  })

  const prompts = useQuery<Prompt[]>({
    queryKey: ["prompts"],
    queryFn: async () => {
      const r = await fetch("/api/prompts")
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load prompts")
      return r.json()
    },
  })

  const takes = useQuery<Take[]>({
    queryKey: ["takes", speakerId],
    enabled: Boolean(speakerId),
    queryFn: async () => {
      const r = await fetch(`/api/enroll?speakerId=${encodeURIComponent(speakerId)}`)
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load takes")
      return r.json()
    },
    // A take is scored by the worker, so poll while anything is outstanding.
    refetchInterval: (q) =>
      q.state.data?.some((t) => t.job && ["QUEUED", "RUNNING"].includes(t.job.state))
        ? 4000
        : false,
  })

  const createSpeaker = useMutation({
    mutationFn: async (name: string) => {
      const r = await fetch("/api/speakers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to create speaker")
      return r.json() as Promise<{ speakerId: string }>
    },
    onSuccess: ({ speakerId: id }) => {
      setNewName("")
      setError(null)
      setSpeakerId(id)
      qc.invalidateQueries({ queryKey: ["speakers"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const submitTake = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error("Nothing recorded yet.")
      const form = new FormData()
      form.set("speakerId", speakerId)
      // Custom text isn't a stored prompt, so no promptId is sent — the take is
      // still scored and used identically.
      if (!useCustom) {
        const p = prompts.data?.[promptIdx]
        if (p) form.set("promptId", p.promptId)
      }
      form.set("file", new File([pending.blob], "take.wav", { type: "audio/wav" }))

      const r = await fetch("/api/enroll", { method: "POST", body: form })
      if (!r.ok) throw new Error((await r.json()).error ?? "Upload failed")
      return r.json()
    },
    onSuccess: () => {
      setPending(null)
      setError(null)
      qc.invalidateQueries({ queryKey: ["takes", speakerId] })
      qc.invalidateQueries({ queryKey: ["speakers"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const prompt = prompts.data?.[promptIdx]
  const selected = useMemo(
    () => speakers.data?.find((s) => s.speakerId === speakerId),
    [speakers.data, speakerId],
  )

  /** Is a take currently being uploaded or scored?
   *
   * This deliberately keys off the take's JOB and not SPEAKERS.state. A speaker
   * is set to ENROLLING the moment it is created, before anything is recorded,
   * so "ENROLLING" means "not yet enrolled" rather than "working on it" — using
   * it as a progress signal would claim work was happening when none was.
   */
  const scoring = takes.data?.find(
    (t) => t.job && ["QUEUED", "RUNNING"].includes(t.job.state),
  )
  const busy = submitTake.isPending || Boolean(scoring)

  /** Refresh the speaker list when a take finishes.
   *
   * The worker flips SPEAKERS.state to READY, but the speakers query has no
   * polling of its own — so that transition was invisible until some unrelated
   * action happened to refetch it. That is why enrollment looked like it stalled:
   * the takes table updated (it polls every 4s) while the speaker's own status
   * stayed frozen. Watching the job edge is enough; no constant polling needed.
   */
  const wasScoring = useRef(false)
  useEffect(() => {
    const now = Boolean(scoring)
    if (wasScoring.current && !now) qc.invalidateQueries({ queryKey: ["speakers"] })
    wasScoring.current = now
  }, [scoring, qc])

  const renameVoice = useMutation({
    mutationFn: async (s: Speaker) => {
      const next = window.prompt(`Rename "${s.name}" to:`, s.name)
      if (next === null || !next.trim() || next.trim() === s.name) return { skipped: true }
      const r = await fetch("/api/speakers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerId: s.speakerId, name: next.trim() }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "Rename failed")
      return { skipped: false }
    },
    onSuccess: (res) => {
      if (res?.skipped) return
      setError(null)
      // Narrations show the speaker name too, so both lists need refreshing.
      qc.invalidateQueries({ queryKey: ["speakers"] })
      qc.invalidateQueries({ queryKey: ["narrations"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const deleteVoice = useMutation({
    mutationFn: async (s: Speaker) => {
      const call = (cascade: boolean) =>
        fetch(
          `/api/speakers?speakerId=${encodeURIComponent(s.speakerId)}` +
            (cascade ? "&cascade=true" : ""),
          { method: "DELETE" },
        )

      let r = await call(false)
      if (r.status === 409) {
        // The voice has narrations. Say exactly how many will be destroyed and
        // require a second, explicit yes before cascading.
        const { narrationCount } = await r.json()
        const ok = window.confirm(
          `"${s.name}" has ${narrationCount} narration${narrationCount === 1 ? "" : "s"}. ` +
            `Deleting the voice will also delete ${narrationCount === 1 ? "it" : "them"} ` +
            `and ${narrationCount === 1 ? "its" : "their"} audio.\n\nDelete anyway?`,
        )
        if (!ok) return { cancelled: true }
        r = await call(true)
      }
      if (!r.ok) throw new Error((await r.json()).error ?? "Delete failed")
      return { cancelled: false }
    },
    onSuccess: (res) => {
      if (res?.cancelled) return
      setError(null)
      setSpeakerId("")
      setPending(null)
      qc.invalidateQueries({ queryKey: ["speakers"] })
      qc.invalidateQueries({ queryKey: ["narrations"] })
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold tracking-tight">Enroll a voice</h2>

      {/* Speaker selection.
          Labelled "Re-record for" rather than "Speaker" or "Recording for": the
          dropdown does not exist to browse enrolled voices, and picking one that
          is already enrolled REPLACES its reference clip rather than adding to it
          (the worker runs UPDATE SPEAKERS SET ref_clip_path = ...). "Recording
          for" read as though takes accumulated, which is the opposite of what
          happens. Everything below is gated on this choice. */}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Re-record for</span>
          <select
            value={speakerId}
            onChange={(e) => setSpeakerId(e.target.value)}
            className="min-w-48 rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Select…</option>
            {speakers.data?.map((s) => (
              <option key={s.speakerId} value={s.speakerId}>
                {s.name}
                {s.state === "READY" ? " — enrolled" : " — not yet enrolled"}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">or create new</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => createSpeaker.mutate(newName.trim())}
            disabled={!newName.trim() || createSpeaker.isPending}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            Create
          </button>
        </div>

        {selected && (
          <button
            type="button"
            disabled={renameVoice.isPending}
            onClick={() => renameVoice.mutate(selected)}
            title="Rename this voice. Only the label changes; narrations made with it keep working."
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {renameVoice.isPending ? "Renaming…" : "Rename"}
          </button>
        )}

        {selected && (
          <button
            type="button"
            disabled={busy || deleteVoice.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete the voice "${selected.name}", its recordings and its reference clip?`,
                )
              ) {
                deleteVoice.mutate(selected)
              }
            }}
            title={
              busy
                ? "A take is still being scored — wait for it to finish"
                : `Delete ${selected.name} and all its enrollment recordings`
            }
            className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-40 dark:text-red-400"
          >
            {deleteVoice.isPending ? "Deleting…" : "Delete voice"}
          </button>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Creating a speaker records a consent attestation — cloning a voice without
        one is not supported. Selecting a voice that is already enrolled lets you
        record a better take; the newest accepted take becomes its reference clip.
      </p>

      {/* Enrollment progress.
          Previously the only message here was "ready to narrate" on READY, so the
          whole scoring phase — the part that actually takes time — showed nothing
          at all. Every state now says where the take is. */}
      {selected && (
        <div className="mt-3 rounded-md border bg-accent/20 p-2.5 text-xs">
          {busy ? (
            <span className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              {submitTake.isPending
                ? "Uploading your recording…"
                : scoring?.job?.state === "QUEUED"
                  ? "Uploaded. Waiting for the worker to pick it up…"
                  : "Scoring your take — checking length, level, noise and clipping. This takes a few seconds."}
            </span>
          ) : selected.state === "READY" ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              {selected.name} is enrolled and ready to narrate.
            </span>
          ) : takes.data?.some((t) => t.accepted === false) ? (
            <span className="text-red-600 dark:text-red-400">
              Last take was rejected — see the reason below, then record another.
            </span>
          ) : (
            <span className="text-muted-foreground">
              No accepted take yet. Read one passage straight through to enroll{" "}
              {selected.name}.
            </span>
          )}
        </div>
      )}

      {speakerId && (
        <>
          {/* passage */}
          <div className="mt-5">
            <h3 className="text-xs font-medium text-muted-foreground">
              Read this straight through, in the voice you actually present in
            </h3>

            <div className="mt-2 flex flex-wrap gap-1">
              {prompts.data?.map((p, i) => (
                <button
                  key={p.promptId}
                  type="button"
                  onClick={() => {
                    setPromptIdx(i)
                    setUseCustom(false)
                  }}
                  className={`rounded border px-2 py-0.5 text-xs ${
                    i === promptIdx && !useCustom ? "bg-accent" : ""
                  }`}
                  title={p.style ?? undefined}
                >
                  {p.label ?? `Passage ${p.ordinal}`}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setUseCustom(true)}
                className={`rounded border px-2 py-0.5 text-xs ${
                  useCustom ? "bg-accent" : ""
                }`}
              >
                Your own text
              </button>
            </div>

            {useCustom ? (
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                rows={5}
                placeholder="Paste a paragraph of your own talk script and read it as you would present it…"
                className="mt-2 w-full rounded-md border bg-background p-3 text-sm leading-relaxed"
              />
            ) : (
              <blockquote className="mt-2 rounded-md border bg-muted/40 p-3 text-sm leading-relaxed">
                {prompt?.text ?? "Loading passage…"}
              </blockquote>
            )}

            <p className="mt-1 text-xs text-muted-foreground">
              Start strong: Chatterbox builds the voice mostly from the FIRST few
              seconds — the first 6s feed its prompt conditioning and the first 10s
              its decoder reference, while total length only feeds the speaker
              embedding. So no throat-clearing or tentative lead-in; open with your
              best, most representative delivery. 30-60 seconds in one continuous
              take is plenty. The clip transfers your delivery as much as your
              timbre, so read it the way you would narrate a real talk.</p>
          </div>

          {/* recorder */}
          <div className="mt-4">
            <VoiceRecorder
              disabled={submitTake.isPending}
              onRecorded={(blob, seconds) => setPending({ blob, seconds })}
            />
          </div>

          {pending && (
            <div className="mt-4 rounded-md border-2 border-primary/40 bg-accent/30 p-3">
              <h4 className="text-xs font-semibold">
                Review your take before submitting
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Listen back for background noise, clipped words, or a rushed read.
                Re-record if anything sounds off — this clip becomes the voice.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <audio controls src={pendingUrl ?? undefined} className="h-9" />
                <span className="text-xs text-muted-foreground">
                  {pending.seconds.toFixed(1)}s · lossless WAV
                </span>
                <button
                  type="button"
                  onClick={() => submitTake.mutate()}
                  disabled={submitTake.isPending}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {submitTake.isPending ? "Submitting…" : "Submit for scoring"}
                </button>
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="rounded-md border px-3 py-1.5 text-sm"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {/* takes */}
          {!!takes.data?.length && (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1.5 text-left font-medium">Status</th>
                    <th className="py-1.5 text-right font-medium">Duration</th>
                    <th className="py-1.5 text-right font-medium">SNR</th>
                    <th className="py-1.5 text-right font-medium">Clipping</th>
                    <th className="py-1.5 text-left font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {takes.data.map((t) => {
                    const running = t.job && ["QUEUED", "RUNNING"].includes(t.job.state)
                    return (
                      <tr key={t.takeId} className="border-b last:border-0">
                        <td className="py-1.5">
                          {running
                            ? t.job?.state === "QUEUED"
                              ? "Queued"
                              : "Scoring…"
                            : t.accepted === true
                              ? "Accepted"
                              : t.accepted === false
                                ? "Rejected"
                                : (t.job?.state ?? "—")}
                        </td>
                        <td className="py-1.5 text-right font-mono">
                          {t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : "—"}
                        </td>
                        <td className="py-1.5 text-right font-mono">
                          {t.snrDb !== null ? `${t.snrDb.toFixed(1)} dB` : "—"}
                        </td>
                        <td className="py-1.5 text-right font-mono">
                          {t.clipRatio !== null
                            ? `${(t.clipRatio * 100).toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {t.rejectReason ?? t.job?.failureReason ?? ""}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* The enrollment status now lives in one block above, covering every
              state rather than only READY. */}
        </>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  )
}
