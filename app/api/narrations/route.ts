import {
  listNarrations,
  createNarrationAndJob,
  narrationUrl,
  getJobForRef,
  deleteNarration,
} from "@/lib/narrator"

export const dynamic = "force-dynamic"

/** GET /api/narrations            — all narrations, grouped client-side by project
 *  GET /api/narrations?url=<id>   — a presigned playback/download URL
 */
export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("url")
    if (id) {
      const url = await narrationUrl(id)
      if (!url) {
        return Response.json(
          { error: "That narration has no audio yet." },
          { status: 404 },
        )
      }
      return Response.json({ url })
    }

    const narrations = await listNarrations()
    const withJobs = await Promise.all(
      narrations.map(async (n) => ({ ...n, job: await getJobForRef(n.narrationId) })),
    )
    return Response.json(withJobs)
  } catch (e) {
    console.error(new Date().toISOString(), "[api/narrations] read failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to read narrations" },
      { status: 500 },
    )
  }
}

/**
 * POST /api/narrations — queue one narration.
 *
 * The script is passed through verbatim: there is no directive grammar and no
 * segmentation of our own. Chatterbox-TTS-Extended handles chunking to the
 * model's generation limit, candidate generation, and Whisper validation.
 *
 * Multiple sections of one talk are separate narrations sharing a `project`,
 * played back in order — which adapts to how long a live demo actually runs,
 * unlike a single file with baked-in gaps.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const title = typeof body.title === "string" ? body.title.trim() : ""
    const scriptText =
      typeof body.scriptText === "string" ? body.scriptText.trim() : ""
    const speakerId = typeof body.speakerId === "string" ? body.speakerId : ""

    if (!speakerId) {
      return Response.json({ error: "Choose a speaker." }, { status: 400 })
    }
    if (!title) {
      return Response.json({ error: "Give this narration a title." }, { status: 400 })
    }
    if (!scriptText) {
      return Response.json({ error: "The script is empty." }, { status: 400 })
    }

    // Voice tuning knobs. Clamped to Chatterbox's usable ranges so a bad value
    // can't waste a multi-minute generation.
    const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
      const n = typeof v === "number" ? v : Number(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
    }

    const project =
      typeof body.project === "string" && body.project.trim()
        ? body.project.trim()
        : null
    const format = typeof body.format === "string" ? body.format : "mp3"
    const base = {
      exaggeration: clamp(body.exaggeration, 0, 2, 0.5),
      temperature: clamp(body.temperature, 0.05, 1.5, 0.8),
      cfgWeight: clamp(body.cfgWeight, 0, 1, 0.5),
    }
    const takesPerChunk = Math.round(clamp(body.takesPerChunk, 1, 9, 3))

    // Variants: one submit, several complete narrations to audition later.
    //
    // They deliberately do NOT share settings. Re-running identical settings only
    // re-rolls the sampling seed, which explores variance within one
    // configuration; stepping a parameter explores between configurations, and
    // that is the axis that changes how much the output sounds like the speaker.
    // Exactly ONE parameter is swept so an audible difference is attributable to
    // it — varying two at once would make the comparison uninterpretable.
    const AXES = {
      cfgWeight: { lo: 0, hi: 1 },
      temperature: { lo: 0.05, hi: 1.5 },
      exaggeration: { lo: 0, hi: 2 },
    } as const
    type Axis = keyof typeof AXES
    const variants = Math.round(clamp(body.variants, 1, 5, 1))
    const varyBy: Axis =
      typeof body.varyBy === "string" && body.varyBy in AXES
        ? (body.varyBy as Axis)
        : "cfgWeight"
    const varyStep = clamp(body.varyStep, 0, 0.5, 0.1)

    // Centre the sweep on the chosen value: 3 variants at step 0.1 around 0.65
    // gives 0.55 / 0.65 / 0.75, so the user's own setting is always included
    // rather than being replaced by the sweep.
    const mid = (variants - 1) / 2
    const created: { narrationId: string; jobId: string; label: string }[] = []

    for (let i = 0; i < variants; i++) {
      const settings = { ...base }
      let label = title
      if (variants > 1) {
        const { lo, hi } = AXES[varyBy]
        const swept = Math.min(hi, Math.max(lo, base[varyBy] + (i - mid) * varyStep))
        settings[varyBy] = Number(swept.toFixed(3))
        // Name the variant after the value that distinguishes it, so the list is
        // self-describing when auditioning: "Section 1 · cfgWeight 0.55".
        label = `${title} · ${varyBy} ${settings[varyBy]}`
      }
      const r = await createNarrationAndJob({
        project,
        title: label,
        scriptText,
        speakerId,
        format,
        baseSeed:
          typeof body.baseSeed === "number" && Number.isFinite(body.baseSeed)
            ? body.baseSeed
            : undefined,
        takesPerChunk,
        ...settings,
      })
      created.push({ ...r, label })
    }

    // Single-variant callers keep the original flat shape.
    return created.length === 1
      ? Response.json({ ...created[0], created })
      : Response.json({ created, count: created.length })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/narrations] create failed", e)
    const msg = e instanceof Error ? e.message : "Failed to queue narration"
    // A stale or half-enrolled voice is the caller's mistake, not a server
    // fault, so it gets a 400 with a message the UI can show as-is.
    const clientFault = /no longer exists|not ready yet/.test(msg)
    return Response.json({ error: msg }, { status: clientFault ? 400 : 500 })
  }
}

/** Deletes a narration and its audio file.
 *
 * deleteNarration refuses while the narration is generating, which surfaces here
 * as a 409 rather than a 500: it is a legitimate "not yet", not a failure.
 */
export async function DELETE(req: Request) {
  try {
    const narrationId = new URL(req.url).searchParams.get("narrationId")
    if (!narrationId) {
      return Response.json({ error: "narrationId is required." }, { status: 400 })
    }
    await deleteNarration(narrationId)
    return Response.json({ deleted: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete narration"
    const inFlight = msg.includes("still generating")
    if (!inFlight) {
      console.error(new Date().toISOString(), "[api/narrations] delete failed", e)
    }
    return Response.json({ error: msg }, { status: inFlight ? 409 : 500 })
  }
}
