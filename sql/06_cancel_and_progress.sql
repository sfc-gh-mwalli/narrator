-- Cancellation and progress reporting.
--
-- Two problems this solves:
--
-- 1. A running job could only be stopped by restarting the whole service, which
--    kills the container and wastes the model load. A single worker means one
--    long job blocks everyone, so cancel has to work in-place.
--
-- 2. The worker wrote a heartbeat only between jobs. Generation is a single
--    blocking call, so during any run longer than HEARTBEAT_STALE_SECONDS (60)
--    the UI declared the worker stale and reported "it may have crashed" —
--    precisely while it was working hardest. The same write now carries progress,
--    so the UI can show "chunk 7 of 15" instead of an opaque spinner.

-- Set by the UI; read by the worker at each chunk and each validation step.
ALTER TABLE NARRATOR.APP.JOBS
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN DEFAULT FALSE
  COMMENT 'UI sets this; the worker checks it at chunk boundaries and aborts.';

ALTER TABLE NARRATOR.APP.JOBS
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMP_LTZ
  COMMENT 'When cancel was requested, for measuring how long cancellation takes.';

-- Progress, written by the worker on every heartbeat during generation.
-- phase is GENERATING (producing takes), CHECKING (Whisper validation), or
-- ASSEMBLING (concat, normalise, encode). done/total are within the phase, so a
-- caller must not treat them as a single global percentage.
ALTER TABLE NARRATOR.APP.WORKER_STATUS
  ADD COLUMN IF NOT EXISTS phase VARCHAR
  COMMENT 'GENERATING | CHECKING | ASSEMBLING | NULL when idle.';

ALTER TABLE NARRATOR.APP.WORKER_STATUS
  ADD COLUMN IF NOT EXISTS progress_done NUMBER
  COMMENT 'Units finished within the current phase.';

ALTER TABLE NARRATOR.APP.WORKER_STATUS
  ADD COLUMN IF NOT EXISTS progress_total NUMBER
  COMMENT 'Total units in the current phase.';

ALTER TABLE NARRATOR.APP.WORKER_STATUS
  ADD COLUMN IF NOT EXISTS current_job_id VARCHAR
  COMMENT 'Job being worked on, so the UI can attach progress to the right row.';
