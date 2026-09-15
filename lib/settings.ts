/**
 * App-level settings, and the GPU capacity facts the UI needs to make sense of
 * them.
 *
 * Two settings live here: which compute pool the worker service runs on, and how
 * many worker instances to run. They are deliberately independent.
 *
 * Worker count is NOT derived from the pool's GPU capacity. The pool's MAX_NODES is
 * a ceiling on what you are willing to spend, not a target: a pool with
 * MIN_NODES=1 and MAX_NODES=4 can legitimately be run with one worker most of the
 * time. Deriving the count would remove the only control over that, so the count
 * is asked for and the capacity is merely reported alongside it.
 */
import { querySnowflake } from "@/lib/snowflake"

const DB = "NARRATOR.APP"

export type SettingKey = "gpu_pool" | "worker_count" | "warehouse"

export const DEFAULT_SETTINGS: Record<SettingKey, string> = {
  gpu_pool: "NARRATOR_GPU_POOL",
  worker_count: "1",
  // Empty means "whatever this session is already using". The app has no business
  // insisting on a dedicated warehouse: its queries are metadata and small DML
  // while the GPU does the work, so any existing extra-small warehouse is fine.
  // 09_warehouse_setting.sql seeds this from CURRENT_WAREHOUSE() at install.
  warehouse: "",
}

export async function readSettings(): Promise<Record<SettingKey, string>> {
  const rows = await querySnowflake(
    `SELECT setting_key, setting_value FROM ${DB}.APP_SETTINGS`,
  )
  const out = { ...DEFAULT_SETTINGS }
  for (const r of rows as any[]) {
    const k = String(r.SETTING_KEY) as SettingKey
    if (k in out && r.SETTING_VALUE != null) out[k] = String(r.SETTING_VALUE)
  }
  return out
}

export async function writeSetting(
  key: SettingKey,
  value: string,
): Promise<void> {
  // MERGE, not UPDATE-then-INSERT: Snowflake does not enforce the primary key on
  // APP_SETTINGS, so a lost race between two writers would leave two rows for one
  // key and readSettings would then pick whichever the scan happened to return.
  await querySnowflake(
    `MERGE INTO ${DB}.APP_SETTINGS t
       USING (SELECT ? AS k, ? AS v) s
          ON t.setting_key = s.k
     WHEN MATCHED THEN UPDATE
          SET setting_value = s.v, updated_on = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (setting_key, setting_value) VALUES (s.k, s.v)`,
    { binds: [key, value] },
  )
}

export interface GpuPool {
  name: string
  state: string
  instanceFamily: string
  /** e.g. "NVIDIA A10G". Null for CPU-only families, which are filtered out. */
  gpu: string | null
  /** GPUs on ONE node. */
  gpuPerNode: number
  gpuMemoryGib: number
  minNodes: number
  maxNodes: number
  /** GPUs the pool can offer if it scales all the way out.
   *
   * This is the honest ceiling for worker count, because our service spec requests
   * `nvidia.com/gpu: 1` per instance — one worker pins one GPU. It is a ceiling and
   * not a promise: the pool only grows to MAX_NODES if Snowflake decides to add
   * nodes, so asking for more workers than MIN_NODES can supply may leave the
   * extra instances pending rather than running. */
  gpuCapacity: number
  /** GPUs available right now, without waiting for a node to be added.
   *
   * Derived from the pool's CURRENT node count, not from MIN_NODES. Using MIN_NODES
   * made the card claim "1 GPU available now" while two workers were demonstrably
   * running on two nodes: MIN_NODES is the floor the pool returns to when idle, not
   * what it is running at the moment. A pool that has already scaled out has that
   * capacity available with no wait, and telling the user otherwise argues with what
   * the same card shows two lines above. */
  gpuNow: number
  /** Nodes running right now, whether busy or idle. */
  currentNodes: number
  /** True for the pool the worker service is currently configured to use. */
  active: boolean
  comment: string | null
}

/** Lists the account's GPU compute pools, with per-node GPU facts joined in.
 *
 * CPU-only pools are excluded rather than shown-and-disabled: the model needs CUDA,
 * so a CPU pool is not a degraded choice but an impossible one, and offering it
 * would only invite a failed service create. This account has three CPU pools that
 * would otherwise clutter the list.
 */
export async function listGpuPools(): Promise<GpuPool[]> {
  const settings = await readSettings()

  // SHOW returns a result set that cannot be joined directly, so both are read and
  // joined in TypeScript. RESULT_SCAN could join them in SQL, but it needs the
  // query id of each SHOW and would turn one round trip into four.
  const [pools, families] = await Promise.all([
    querySnowflake("SHOW COMPUTE POOLS"),
    querySnowflake("SHOW COMPUTE POOL INSTANCE FAMILIES"),
  ])

  const byFamily = new Map<string, any>()
  for (const f of families as any[]) byFamily.set(String(f.name), f)

  const out: GpuPool[] = []
  for (const p of pools as any[]) {
    const fam = byFamily.get(String(p.instance_family))
    const gpuPerNode = Number(fam?.gpu_count ?? 0)
    if (!gpuPerNode) continue

    const minNodes = Number(p.min_nodes ?? 1)
    const maxNodes = Number(p.max_nodes ?? 1)

    // A suspended pool reports zero of everything, in which case the floor it will
    // come back to (MIN_NODES) is the honest figure. target_nodes is preferred while
    // resizing, because active+idle lags behind it during a scale-out.
    const activeNodes = Number(p.active_nodes ?? 0)
    const idleNodes = Number(p.idle_nodes ?? 0)
    const targetNodes = Number(p.target_nodes ?? 0)
    const currentNodes = Math.max(activeNodes + idleNodes, targetNodes, minNodes)
    out.push({
      name: String(p.name),
      state: String(p.state),
      instanceFamily: String(p.instance_family),
      gpu: fam?.gpu ? String(fam.gpu) : null,
      gpuPerNode,
      gpuMemoryGib: Number(fam?.gpu_memory_gib ?? 0),
      minNodes,
      maxNodes,
      gpuCapacity: gpuPerNode * maxNodes,
      gpuNow: gpuPerNode * currentNodes,
      currentNodes,
      active: String(p.name) === settings.gpu_pool,
      comment: p.comment ? String(p.comment) : null,
    })
  }
  out.sort((a, b) => b.gpuCapacity - a.gpuCapacity || a.name.localeCompare(b.name))
  return out
}

/** Warehouses the current role can use, for the settings dropdown.
 *
 * SHOW WAREHOUSES returns only what the role has access to, so this is already
 * scoped correctly without a privilege check of our own.
 */
export interface WarehouseOption {
  name: string
  size: string
  state: string
  autoSuspendSecs: number | null
}

export async function listWarehouses(): Promise<WarehouseOption[]> {
  const rows = await querySnowflake("SHOW WAREHOUSES")
  return (rows as any[])
    .map((r) => ({
      name: String(r.name),
      size: String(r.size ?? ""),
      state: String(r.state ?? ""),
      autoSuspendSecs:
        r.auto_suspend === null || r.auto_suspend === undefined
          ? null
          : Number(r.auto_suspend),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The warehouse the service should run queries on.
 *
 * Falls back to the session's own warehouse when unset, which is the behaviour that
 * makes a fresh install work without anyone choosing anything.
 */
export async function activeWarehouse(): Promise<string | null> {
  const { warehouse } = await readSettings()
  if (warehouse) return warehouse
  const rows = await querySnowflake("SELECT CURRENT_WAREHOUSE() AS W")
  const w = (rows[0] as any)?.W
  return w ? String(w) : null
}
