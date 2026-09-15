-- Expose takes-per-chunk as a per-narration setting.
--
-- One knob, not two. Extended has both num_candidates_per_chunk and
-- max_attempts_per_candidate, but they are the same thing: both only vary the
-- seed via derive_seed(seed, chunk, cand, attempt), and every resulting take is
-- pooled and scored together. Only their PRODUCT matters, so 3x3 and 9x1 are
-- identical in cost and in outcome. Exposing two knobs would invite someone to
-- set 3 and 3 thinking it means "3 tries, 3 fallbacks" and quietly get nine.
--
-- Why the default is 3, measured on an A10G rather than assumed:
--   Nine takes of one chunk scored 0.978 0.980 0.818 0.978 0.978 0.978 0.978
--   0.978 0.973 against the Whisper transcript. One in nine (11%) was materially
--   degraded, so defects are real and roughly independent per chunk.
--
--   A five-minute script is ~19 chunks, and a narration is only as good as its
--   worst chunk, so the risk compounds:
--     1 take/chunk  -> ~11%   chance the whole narration is clean
--     3 takes/chunk -> ~97.5% chance
--     9 takes/chunk -> ~100%, for 3x the compute
--
--   Protection saturates after 3 while cost stays linear, which is what makes 3
--   the sensible default rather than upstream's effective 9.

ALTER TABLE NARRATOR.APP.NARRATIONS
  ADD COLUMN IF NOT EXISTS takes_per_chunk NUMBER DEFAULT 3
  COMMENT 'Generations per chunk; Whisper keeps the best. Higher = fewer defects, linearly slower.';

-- Existing rows predate the setting. They were generated under Extended's
-- 3 x 3 default on CUDA, so record what they actually used rather than the new
-- default, or their stored settings would misreport how they were made.
UPDATE NARRATOR.APP.NARRATIONS
   SET takes_per_chunk = 9
 WHERE takes_per_chunk IS NULL;
