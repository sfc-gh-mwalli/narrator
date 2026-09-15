import {
  readSettings,
  writeSetting,
  listGpuPools,
  listWarehouses,
  activeWarehouse,
} from "@/lib/settings"
import {
  setWorkerCount,
  switchPool,
  setWarehouse,
  readWorkerScale,
} from "@/lib/gpu"

export const dynamic = "force-dynamic"

/** GET /api/settings — current settings, eligible GPU pools, and live scale. */
export async function GET() {
  try {
    const [settings, pools, scale, warehouses, effectiveWarehouse] =
      await Promise.all([
        readSettings(),
        listGpuPools(),
        readWorkerScale(),
        listWarehouses(),
        activeWarehouse(),
      ])
    return Response.json({
      gpuPool: settings.gpu_pool,
      workerCount: Number(settings.worker_count) || 1,
      // The stored value can be empty, meaning "inherit the session's warehouse".
      // Both are sent: the UI needs to show what is in force AND whether that came
      // from an explicit choice or a fallback.
      warehouse: settings.warehouse,
      effectiveWarehouse,
      warehouses,
      pools,
      scale,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/settings] read failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to read settings" },
      { status: 500 },
    )
  }
}

/**
 * POST /api/settings — change the compute pool and/or the worker count.
 *
 * The two are applied differently because SPCS treats them differently. Instance
 * count is a live ALTER. The compute pool is fixed at CREATE SERVICE time, so
 * changing it drops and recreates the service and costs a cold start — which is why
 * the pool is only touched when it actually differs from the current one.
 *
 * Ordering matters: the pool is switched FIRST, because a switch recreates the
 * service at the requested count anyway, and applying the count to a service that
 * is about to be dropped would be wasted work and could fail against the old pool's
 * capacity. Nothing else here can be ordered "wrong" without a user-visible lie.
 *
 * Errors from Snowflake are returned as-is. When a count exceeds what the pool can
 * hold, Snowflake's message names the instance family, the node limit and the two
 * ways to fix it — strictly better than anything this layer could paraphrase.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const current = await readSettings()

    const wantPool =
      typeof body.gpuPool === "string" && body.gpuPool.trim()
        ? body.gpuPool.trim().toUpperCase()
        : null
    const wantCount =
      body.workerCount === undefined || body.workerCount === null
        ? null
        : Number(body.workerCount)
    const wantWarehouse =
      typeof body.warehouse === "string" && body.warehouse.trim()
        ? body.warehouse.trim().toUpperCase()
        : null

    if (wantCount !== null && (!Number.isInteger(wantCount) || wantCount < 1)) {
      return Response.json(
        { error: "Worker count must be a whole number of at least 1." },
        { status: 400 },
      )
    }

    const notes: string[] = []
    const poolChanged = wantPool !== null && wantPool !== current.gpu_pool

    if (poolChanged) {
      // switchPool persists the setting itself and recreates the service at the
      // stored worker count, so the count is written first when both change.
      if (wantCount !== null) await writeSetting("worker_count", String(wantCount))
      await switchPool(wantPool as string)
      notes.push(
        `Worker service recreated on ${wantPool}. Expect 30-60s while the image ` +
          "is pulled and the model loads.",
      )
    } else if (wantCount !== null && wantCount !== Number(current.worker_count)) {
      await setWorkerCount(wantCount)
      await writeSetting("worker_count", String(wantCount))
      notes.push(`Worker count set to ${wantCount}.`)
    }

    // Warehouse last. A pool switch recreates the service using the stored
    // warehouse, so doing it first would restart the service twice for one Apply.
    if (
      wantWarehouse !== null &&
      wantWarehouse !== current.warehouse &&
      !poolChanged
    ) {
      await setWarehouse(wantWarehouse)
      notes.push(
        `Query warehouse set to ${wantWarehouse}. The worker was restarted, ` +
          "because a service only picks up a new warehouse when it starts.",
      )
    } else if (wantWarehouse !== null && poolChanged) {
      await writeSetting("warehouse", wantWarehouse)
    }

    const [settings, scale, effectiveWarehouse] = await Promise.all([
      readSettings(),
      readWorkerScale(),
      activeWarehouse(),
    ])
    return Response.json({
      gpuPool: settings.gpu_pool,
      workerCount: Number(settings.worker_count) || 1,
      warehouse: settings.warehouse,
      effectiveWarehouse,
      scale,
      notes,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to apply settings"
    // Snowflake's capacity refusal is expected user input, not a fault, so it is
    // not logged as an error — but it IS returned verbatim.
    const capacity = /pool can run at most|MAX_NODES|reduce MIN_INSTANCES/i.test(msg)
    const conflict = /still queued or running/i.test(msg)
    if (!capacity && !conflict) {
      console.error(new Date().toISOString(), "[api/settings] apply failed", e)
    }
    return Response.json({ error: msg }, { status: capacity || conflict ? 409 : 500 })
  }
}
