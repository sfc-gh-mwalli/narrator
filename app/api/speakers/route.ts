import {
  listSpeakers,
  createSpeaker,
  deleteSpeaker,
  renameSpeaker,
} from "@/lib/narrator"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json(await listSpeakers())
  } catch (e) {
    console.error(new Date().toISOString(), "[api/speakers] list failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to list speakers" },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  try {
    const { name } = await req.json()
    const trimmed = typeof name === "string" ? name.trim() : ""
    if (!trimmed) {
      return Response.json({ error: "A speaker name is required." }, { status: 400 })
    }

    // createSpeaker records the consent attestation in the same statement —
    // enrolling a voice without one should not be possible.
    const speakerId = await createSpeaker(trimmed)
    return Response.json({ speakerId })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/speakers] create failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to create speaker" },
      { status: 500 },
    )
  }
}

/** Deletes a voice.
 *
 * Refuses on the first attempt when narrations exist and answers 409 with the
 * count, so the client can show what would be destroyed and ask again with
 * ?cascade=true. A voice is cheap to re-enrol; the narrations made with it are
 * minutes of compute each, so they are never collateral damage of one click.
 */
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url)
    const speakerId = url.searchParams.get("speakerId")
    if (!speakerId) {
      return Response.json({ error: "speakerId is required." }, { status: 400 })
    }

    const blocked = await deleteSpeaker(speakerId, {
      cascade: url.searchParams.get("cascade") === "true",
    })
    if (blocked) {
      return Response.json(
        { needsCascade: true, narrationCount: blocked.narrationCount },
        { status: 409 },
      )
    }
    return Response.json({ deleted: true })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/speakers] delete failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to delete speaker" },
      { status: 500 },
    )
  }
}

/** Renames a voice. PATCH /api/speakers  { speakerId, name }
 *
 * Rename rather than replace: the speaker_id stays the identity, so narrations
 * already made with this voice keep playing and its reference clip does not move.
 */
export async function PATCH(req: Request) {
  try {
    const { speakerId, name } = await req.json()
    if (typeof speakerId !== "string" || !speakerId) {
      return Response.json({ error: "speakerId is required." }, { status: 400 })
    }
    if (typeof name !== "string" || !name.trim()) {
      return Response.json({ error: "A voice name is required." }, { status: 400 })
    }
    await renameSpeaker(speakerId, name)
    return Response.json({ renamed: true, name: name.trim() })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to rename voice"
    const clientFault = /required|too long|no longer exists/.test(msg)
    if (!clientFault) {
      console.error(new Date().toISOString(), "[api/speakers] rename failed", e)
    }
    return Response.json({ error: msg }, { status: clientFault ? 400 : 500 })
  }
}
