import { querySnowflake } from "@/lib/snowflake"
import { chunkAudioUrl } from "@/lib/narrator"
import { streamStageFile } from "@/lib/stage-audio"

export const dynamic = "force-dynamic"

const DB = "NARRATOR.APP"

/**
 * GET /api/narrations/chunk-audio?narrationId=…&chunk=<index>
 *
 * Streams one chunk's WAV through the app, the same way narration audio is served.
 *
 * A presigned URL cannot be used here. From inside SPCS, GET_PRESIGNED_URL returns
 * a URL on the SPCS S3 access point, whose policy denies callers outside the
 * service — so it mints fine and then 403s in the browser, which renders as an
 * <audio> element with greyed-out controls and a 0:00 duration. That is exactly the
 * symptom this route replaces, and it is documented on the narration audio route
 * too; the shared helper now carries the fix for both.
 *
 * The path comes from the chunk row rather than being derived from the index,
 * because a repaired chunk lives at <index>_a<attempt>.wav.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const narrationId = url.searchParams.get("narrationId")
    const chunk = url.searchParams.get("chunk")
    if (!narrationId || chunk === null) {
      return Response.json(
        { error: "narrationId and chunk are required." },
        { status: 400 },
      )
    }
    const idx = Number(chunk)
    if (!Number.isInteger(idx) || idx < 0) {
      return Response.json(
        { error: "chunk must be a non-negative index." },
        { status: 400 },
      )
    }

    const rows = await querySnowflake(
      `SELECT audio_path FROM ${DB}.NARRATION_CHUNKS
        WHERE narration_id = ? AND chunk_index = ?`,
      { binds: [narrationId, idx] },
    )
    const path = (rows[0] as any)?.AUDIO_PATH
    if (!path) {
      return Response.json(
        { error: "That chunk has no audio yet." },
        { status: 404 },
      )
    }

    return await streamStageFile({
      stage: `${DB}.CHUNK_AUDIO`,
      path: String(path),
      range: req.headers.get("range"),
      downloadAs: url.searchParams.get("download")
        ? `chunk-${String(idx).padStart(4, "0")}.wav`
        : null,
      label: "api/narrations/chunk-audio",
      // Local dev: a presigned URL does work from a laptop, so fall back to it.
      localFallbackUrl: () => chunkAudioUrl(narrationId, idx),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/chunk-audio] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to stream chunk audio" },
      { status: 500 },
    )
  }
}
