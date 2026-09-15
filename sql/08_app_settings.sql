-- App-level settings: which GPU compute pool to run the worker on, and how many
-- workers to run.
--
-- These are app-level and not per-narration on purpose. The pool is a property of
-- the deployment, not of a piece of work: a narration cannot express a preference
-- about hardware without also being able to move a running service, and the whole
-- app shares one worker service. Storing them per narration would let two queued
-- narrations disagree about where they run, which has no coherent resolution.
--
-- A key/value table rather than a one-row table with a column per setting: adding
-- a setting is then an INSERT, not a migration, and reading one setting does not
-- depend on the shape of the others.

CREATE TABLE IF NOT EXISTS NARRATOR.APP.APP_SETTINGS (
  setting_key    STRING NOT NULL,
  setting_value  STRING,
  updated_on     TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (setting_key)
);

-- Seed the current deployment so the UI has something to show before the user
-- ever opens the settings. MERGE rather than INSERT: this script must be safe to
-- re-run, and Snowflake does not enforce the primary key above, so a plain INSERT
-- would silently create a second row for the same key on the second run.
MERGE INTO NARRATOR.APP.APP_SETTINGS t
  USING (
    SELECT 'gpu_pool' AS k, 'NARRATOR_GPU_POOL' AS v
    UNION ALL SELECT 'worker_count', '1'
  ) s
  ON t.setting_key = s.k
  WHEN NOT MATCHED THEN INSERT (setting_key, setting_value) VALUES (s.k, s.v);
