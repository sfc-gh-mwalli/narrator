-- Separate the raw enrollment upload from its normalised derivative.
--
-- Previously the worker OVERWROTE ENROLLMENT_TAKES.audio_path, replacing
-- 'raw/<upload-uuid>.wav' with 'processed/<take-id>.wav'. One column held two
-- different things at two points in time, which caused three problems:
--
--   1. Orphaned files. Once overwritten, the raw upload path was unrecoverable
--      from the database, so deleting a voice could not clean up its raw files
--      and they accumulated on @ENROLLMENT_AUDIO forever.
--
--   2. Non-idempotent retries. handle_enroll reads audio_path to find its input.
--      On a second run — a manual retry, or a requeue by the orphaned-job reaper —
--      it would read the PROCESSED path and run loudnorm over already-normalised
--      audio, quietly producing a different reference clip than the first attempt.
--
--   3. A fragile take lookup. createTakeAndJob recovers the generated take_id with
--      WHERE audio_path = <raw path>, which only works while that value is still
--      the raw one.
--
-- After this migration audio_path is IMMUTABLE and always the raw upload;
-- processed_path holds the derived clip.
--
-- NOTE on legacy rows: takes enrolled before this change already had audio_path
-- overwritten, so their raw path is gone for good and cannot be backfilled. Their
-- audio_path therefore still holds a 'processed/...' value. deleteSpeaker removes
-- whatever both columns contain, so cleanup is correct either way; only the
-- unrecoverable raw files from those takes remain, and they are swept once below.

ALTER TABLE NARRATOR.APP.ENROLLMENT_TAKES
  ADD COLUMN IF NOT EXISTS processed_path VARCHAR
  COMMENT 'Normalised clip derived from audio_path by the worker (processed/<take_id>.wav)';

-- Backfill: for already-processed takes, audio_path currently holds the processed
-- path, so copy it across. This makes processed_path correct for legacy rows even
-- though their audio_path cannot be restored to the raw value.
UPDATE NARRATOR.APP.ENROLLMENT_TAKES
   SET processed_path = audio_path
 WHERE processed_path IS NULL
   AND audio_path LIKE 'processed/%';
