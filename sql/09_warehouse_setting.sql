-- Make the query warehouse a setting rather than a hard-coded name.
--
-- The app previously created and assumed NARRATOR_WH. That was an unnecessary
-- imposition: this workload is metadata and small DML — a few reads and writes per
-- job while the GPU does the actual work — so any existing extra-small warehouse
-- serves, and creating a dedicated one just adds an object to grant, monitor and
-- pay a separate idle window on.
--
-- Seeded from the session's own warehouse, so the app starts on whatever the
-- installer was already using and no one has to choose before anything works.
-- CURRENT_WAREHOUSE() can be NULL if this is run without one, in which case the
-- setting stays empty and the app falls back to the session default at read time.

MERGE INTO NARRATOR.APP.APP_SETTINGS t
  USING (SELECT 'warehouse' AS k, COALESCE(CURRENT_WAREHOUSE(), '') AS v) s
  ON t.setting_key = s.k
  WHEN NOT MATCHED THEN INSERT (setting_key, setting_value) VALUES (s.k, s.v);

SELECT setting_key, setting_value FROM NARRATOR.APP.APP_SETTINGS ORDER BY setting_key;
