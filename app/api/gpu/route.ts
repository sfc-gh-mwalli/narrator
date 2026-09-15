import { getGpuStatus, wakeGpu, suspendGpu } from "@/lib/gpu"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json(await getGpuStatus())
  } catch (e) {
    console.error(new Date().toISOString(), "[api/gpu] status failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to read GPU status" },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  try {
    const { action } = await req.json()

    if (action === "wake") {
      await wakeGpu()
    } else if (action === "suspend") {
      await suspendGpu()
    } else {
      return Response.json(
        { error: `Unknown action '${action}'. Expected 'wake' or 'suspend'.` },
        { status: 400 },
      )
    }

    // RESUME and SUSPEND are asynchronous; return the status immediately so the
    // UI can start polling through the warm-up stages.
    return Response.json(await getGpuStatus())
  } catch (e) {
    console.error(new Date().toISOString(), "[api/gpu] action failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "GPU action failed" },
      { status: 500 },
    )
  }
}
