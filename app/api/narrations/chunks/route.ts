import { listNarrationChunks, repairNarrationChunks } from "@/lib/narrator"

export const dynamic = "force-dynamic"

/** GET /api/narrations/chunks?narrationId=… — per-chunk detail for one narration.
 *
 * Audio is NOT served here. It lives at /api/narrations/chunk-audio, which streams
 * bytes rather than returning a URL, because a presigned URL minted inside SPCS is
 * unfetchable from a browser.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const narrationId = params.get("narrationId")
    if (!narrationId) {
      return Response.json({ error: "narrationId is required." }, { status: 400 })
    }

    return Response.json(await listNarrationChunks(narrationId))
  } catch (e) {
    console.error(new Date().toISOString(), "[api/chunks] read failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to read chunks" },
      { status: 500 },
    )
  }
}

/**
 * POST /api/narrations/chunks — regenerate specific chunks, then reassemble.
 *
 * Takes `{ narrationId, chunkIndexes: number[] }`. Only the named chunks are
 * generated again; every other chunk keeps the audio it already has.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const narrationId =
      typeof body.narrationId === "string" ? body.narrationId : ""
    const raw = Array.isArray(body.chunkIndexes) ? body.chunkIndexes : []
    const chunkIndexes = [...new Set(raw.map((n: unknown) => Number(n)))] as number[]

    if (!narrationId) {
      return Response.json({ error: "narrationId is required." }, { status: 400 })
    }
    if (!chunkIndexes.length) {
      return Response.json(
        { error: "Select at least one chunk to regenerate." },
        { status: 400 },
      )
    }

    const result = await repairNarrationChunks(narrationId, chunkIndexes)
    return Response.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to queue repair"
    // "Still in flight" and "does not exist" are ordinary user-visible conditions,
    // not faults, so they are not logged as errors.
    const conflict = /in flight|no longer exists|chunks exist/i.test(msg)
    if (!conflict) {
      console.error(new Date().toISOString(), "[api/chunks] repair failed", e)
    }
    return Response.json({ error: msg }, { status: conflict ? 409 : 500 })
  }
}
