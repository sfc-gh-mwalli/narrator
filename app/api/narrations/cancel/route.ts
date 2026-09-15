import { cancelNarration } from "@/lib/narrator"

/** POST /api/narrations/cancel — asks the worker to stop a generation.
 *
 * Separate from DELETE on /api/narrations because they are different intents with
 * different preconditions: cancel applies only while a narration is in flight,
 * delete only once it is not. Overloading one verb would make both harder to
 * reason about and would let a mistyped call destroy finished audio.
 *
 * Returns CANCELLING when a worker has to notice the flag, or CANCELLED when the
 * job had not started and could be retired immediately.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const narrationId = String((body as any)?.narrationId ?? "").trim()
    if (!narrationId) {
      return Response.json({ error: "narrationId is required." }, { status: 400 })
    }

    const { state } = await cancelNarration(narrationId)
    return Response.json({ cancelled: true, state })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/narrations/cancel] failed", e)
    const msg = e instanceof Error ? e.message : "Could not cancel that narration."
    // "already ready/failed" and "no longer exists" are races the UI can hit by
    // clicking Cancel just as a job finishes. That is the caller's state being
    // out of date, not a server fault, so it must not read as a 500.
    const clientFault = /no longer exists|already |no job is attached/.test(msg)
    return Response.json({ error: msg }, { status: clientFault ? 409 : 500 })
  }
}
