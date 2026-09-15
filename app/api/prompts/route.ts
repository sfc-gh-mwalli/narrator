import { listPrompts } from "@/lib/narrator"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Paragraph-length, phonetically balanced passages read straight through in
    // ONE continuous take (~20-30s). Not a set of short individual sentences:
    // the model wants continuous speech, and 15-30s in one take is the sweet spot.
    return Response.json(await listPrompts())
  } catch (e) {
    console.error(new Date().toISOString(), "[api/prompts] list failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to list prompts" },
      { status: 500 },
    )
  }
}
