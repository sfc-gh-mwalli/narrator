-- Create the GPU worker service (service B). NOT run automatically: every
-- statement below either starts billing GPU credits or depends on one that does.
--
-- Cost model, because it is the whole reason this file is separate:
--   NARRATOR_GPU_POOL is GPU_NV_S, MIN_NODES=1, AUTO_RESUME=FALSE,
--   AUTO_SUSPEND_SECS=300. Credits accrue while the pool is ACTIVE, not while
--   the worker is busy — so an idle service still costs money. AUTO_SUSPEND only
--   fires when nothing is scheduled on the pool, and a service with
--   MIN_INSTANCES=1 counts as something scheduled. Leaving the service running
--   therefore pins the pool ACTIVE indefinitely.
--
--   Consequence: SUSPEND THE SERVICE when you are done, not just the pool.
--   The suspend/resume pair at the bottom is the normal daily rhythm.

-- 1. Wake the pool. Explicit by design (AUTO_RESUME=FALSE) so nothing can start
--    billing without an operator asking for it. Takes a few minutes.
--
--    Prerequisites already done: NARRATOR.APP.SPECS stage exists and
--    service-spec.yaml (pinned to narrator-worker:v2) is uploaded to it. Re-upload
--    after editing the spec:
--      snow stage copy worker/service-spec.yaml @NARRATOR.APP.SPECS/ \
--        -c <your-connection> --overwrite
ALTER COMPUTE POOL NARRATOR_GPU_POOL RESUME;

-- Wait for STATE = ACTIVE (or IDLE) before creating the service.
SHOW COMPUTE POOLS LIKE 'NARRATOR_GPU_POOL';

-- 2. Create the service from the spec on stage.
--
--    Use ALTER SERVICE ... FROM to update an existing service. Do NOT drop and
--    recreate: dropping loses the service's identity and any grants on it.
CREATE SERVICE IF NOT EXISTS NARRATOR.APP.NARRATOR_WORKER
  IN COMPUTE POOL NARRATOR_GPU_POOL
  FROM @NARRATOR.APP.SPECS
  SPECIFICATION_FILE = 'service-spec.yaml'
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1
  -- Any existing warehouse. This only runs the worker's bookkeeping, so size
  -- buys nothing; the GPU does the generation. Changeable afterwards from the
  -- GPU card, which also restarts the service so the change takes effect.
  QUERY_WAREHOUSE = GENERAL_USE_WH
  COMMENT = 'Narrator GPU TTS worker; polls NARRATOR.APP.JOBS';

-- 3. Watch it come up. Expect PENDING while the image is pulled — the image is
--    large, so the first pull is slow; that is not a hang.
SELECT SYSTEM$GET_SERVICE_STATUS('NARRATOR.APP.NARRATOR_WORKER');
SHOW SERVICE CONTAINERS IN SERVICE NARRATOR.APP.NARRATOR_WORKER;

-- 4. Logs. The worker prints its device on startup: confirm it says cuda, not
--    cpu. If it says cpu the GPU was not attached and generation will crawl —
--    check that BOTH requests and limits set nvidia.com/gpu in the spec.
SELECT SYSTEM$GET_SERVICE_LOGS('NARRATOR.APP.NARRATOR_WORKER', 0, 'worker', 200);

-- 5. Confirm the worker registered itself, which proves it reached Snowflake
--    with its OAuth token and can see the tables.
SELECT worker_id, state, model_loaded,
       TIMESTAMPDIFF('second', heartbeat_at, CURRENT_TIMESTAMP()) AS heartbeat_age_s
  FROM NARRATOR.APP.WORKER_STATUS;

-- 6. Optional: prove the whole offline path inside the container before trusting
--    it with a real job. Exercises model load, enrollment scoring, faster-whisper
--    validation and a short generation, all with no network.
--    EXECUTE SERVICE is a one-shot job, so it needs its own spec; simplest is to
--    exec into the running service instead:
--      snow spcs service execute-job ... OR temporarily set the container command
--      to ["python", "smoke_offline.py"] and read the logs.

-- 7. STOP PAYING. Suspending the service is what lets the pool auto-suspend;
--    suspending the pool as well is immediate and unambiguous.
--    ALTER SERVICE NARRATOR.APP.NARRATOR_WORKER SUSPEND;
--    ALTER COMPUTE POOL NARRATOR_GPU_POOL SUSPEND;

-- To resume for a work session:
--    ALTER COMPUTE POOL NARRATOR_GPU_POOL RESUME;
--    ALTER SERVICE NARRATOR.APP.NARRATOR_WORKER RESUME;
