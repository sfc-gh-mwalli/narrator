import { uploadEnrollmentWav } from "@/lib/stage"
import { createTakeAndJob, listTakes, getJobForRef } from "@/lib/narrator"

export const dynamic = "force-dynamic"

/** GET /api/enroll?speakerId=... — takes for a speaker, with each one's job state. */
export async function GET(req: Request) {
  try {
    const speakerId = new URL(req.url).searchParams.get("speakerId")
    if (!speakerId) {
      return Response.json({ error: "speakerId is required" }, { status: 400 })
    }

    const takes = await listTakes(speakerId)
    const withJobs = await Promise.all(
      takes.map(async (t) => ({ ...t, job: await getJobForRef(t.takeId) })),
    )
    return Response.json(withJobs)
  } catch (e) {
    console.error(new Date().toISOString(), "[api/enroll] list failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to list takes" },
      { status: 500 },
    )
  }
}

/**
 * POST /api/enroll — multipart upload of one enrollment take.
 *
 * The audio must be lossless WAV. The browser recorder captures raw PCM via an
 * AudioWorklet and encodes WAV client-side precisely so this holds: MediaRecorder
 * would hand us lossy Opus, which quietly degrades the speaker embedding.
 *
 * Scoring happens in the worker, not here — it needs ffmpeg and the audio stack.
 * This route only lands the file and queues the job.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const speakerId = form.get("speakerId")
    const promptId = form.get("promptId")
    const file = form.get("file")

    if (typeof speakerId !== "string" || !speakerId) {
      return Response.json({ error: "speakerId is required" }, { status: 400 })
    }
    if (!(file instanceof File)) {
      return Response.json({ error: "An audio file is required" }, { status: 400 })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const { stagePath } = await uploadEnrollmentWav(bytes)

    const { takeId, jobId } = await createTakeAndJob(
      speakerId,
      typeof promptId === "string" && promptId ? promptId : null,
      stagePath,
    )

    return Response.json({ takeId, jobId, stagePath })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/enroll] upload failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to submit take" },
      { status: 500 },
    )
  }
}
