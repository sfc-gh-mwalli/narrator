import { querySnowflake } from "@/lib/snowflake"
import { narrationUrl } from "@/lib/narrator"
import { streamStageFile } from "@/lib/stage-audio"

export const dynamic = "force-dynamic"

const DB = "NARRATOR.APP"

/** GET /api/narrations/audio?id=<narrationId>[&download=1]
 *
 * Streams narration audio through the app instead of handing the browser a
 * presigned S3 URL. The reasoning — and every failure that shaped it — now lives in
 * lib/stage-audio.ts, shared with chunk playback: a presigned URL minted inside
 * SPCS resolves to the SPCS access point and 403s in the browser, the scoped URL's
 * PrivateLink host has no DNS in a container, and the two Snowflake HTTP surfaces
 * disagree about the auth scheme.
 *
 * That logic was duplicated when chunk auditioning needed the same treatment. One
 * copy, exercised by both callers, is the only way it stays correct.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get("id")
    if (!id) {
      return Response.json({ error: "id is required." }, { status: 400 })
    }

    const rows = await querySnowflake(
      `SELECT audio_path, format, title FROM ${DB}.NARRATIONS WHERE narration_id = ?`,
      { binds: [id] },
    )
    const row = rows[0] as any
    if (!row?.AUDIO_PATH) {
      return Response.json(
        { error: "That narration has no audio yet." },
        { status: 404 },
      )
    }
    const path = String(row.AUDIO_PATH)
    const ext = (
      row.FORMAT ? String(row.FORMAT) : path.split(".").pop() || "mp3"
    ).toLowerCase()

    return await streamStageFile({
      stage: `${DB}.NARRATION_AUDIO`,
      path,
      range: req.headers.get("range"),
      downloadAs: url.searchParams.get("download")
        ? `${String(row.TITLE ?? "narration")}.${ext}`
        : null,
      label: "api/narrations/audio",
      localFallbackUrl: () => narrationUrl(id),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/narrations/audio] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to stream audio" },
      { status: 500 },
    )
  }
}
