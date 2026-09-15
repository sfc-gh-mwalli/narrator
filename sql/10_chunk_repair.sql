-- Per-chunk repair support.
--
-- Adds an attempt counter to each chunk. This is what makes repair meaningful:
-- the generation seed is derived as (base_seed + chunk_index * 10007), which is
-- deliberately deterministic so a whole narration reproduces from one base_seed.
-- Regenerating a chunk with that same seed would reproduce byte-identical audio —
-- the takes would be the same takes, and a chunk that failed would fail again in
-- exactly the same way. Folding the attempt number into the seed is what lets a
-- second try actually be a different try.
--
-- Kept on the chunk rather than derived from `takes`, because `takes` counts the
-- candidates generated within one attempt and is reset by each attempt. Two
-- different questions ("how many candidates did this attempt make" vs "how many
-- times have we tried this chunk") need two columns.

ALTER TABLE NARRATOR.APP.NARRATION_CHUNKS
  ADD COLUMN IF NOT EXISTS attempt NUMBER(9,0) DEFAULT 0;

-- Why a chunk was regenerated, for the UI and for judging whether repair helps.
-- 'WHISPER' when the worker retried a failed validation itself, 'MANUAL' when a
-- human asked for it, NULL for a first pass.
ALTER TABLE NARRATOR.APP.NARRATION_CHUNKS
  ADD COLUMN IF NOT EXISTS repair_reason STRING;

-- Snowflake applied the DEFAULT to the existing rows, so every prior chunk reads
-- as attempt 0 with no backfill UPDATE needed. That is the desired result and also
-- the safe one: a backfill UPDATE would have contended with a worker that was
-- mid-narration writing to these same rows. Readers still COALESCE, cheaply, since
-- relying on add-column backfill semantics is not worth a correctness bet.

SELECT COUNT(*) AS chunks, COUNT_IF(attempt IS NULL) AS null_attempts
  FROM NARRATOR.APP.NARRATION_CHUNKS;
