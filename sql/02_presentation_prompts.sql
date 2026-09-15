-- ============================================================================
-- Narrator — Step 2 migration: presentation-style enrollment passages,
-- per-narration voice tuning knobs, and prompt labels.
-- ============================================================================
-- Why: the original passages were Harvard Sentences, chosen for phonetic
-- coverage. But a reference clip transfers DELIVERY as much as timbre, and
-- Harvard Sentences get read in a flat "reading test" voice — so the clone
-- inherited that register rather than a presenting voice. These passages are
-- written to be read the way a talk is actually narrated, while still carrying
-- broad phonetic variety.

USE ROLE SYSADMIN;
USE WAREHOUSE GENERAL_USE_WH;
USE SCHEMA NARRATOR.APP;

-- --------------------------------------------------------------------------
-- Prompt labels, so the UI can name passages instead of numbering them
-- --------------------------------------------------------------------------
ALTER TABLE ENROLLMENT_PROMPTS ADD COLUMN IF NOT EXISTS label VARCHAR;
ALTER TABLE ENROLLMENT_PROMPTS ADD COLUMN IF NOT EXISTS style VARCHAR;

UPDATE ENROLLMENT_PROMPTS
   SET label = 'Harvard Sentences ' || ordinal::VARCHAR,
       style = 'phonetic'
 WHERE label IS NULL;

-- --------------------------------------------------------------------------
-- Presentation-style passages (~30-35s each at a normal presenting pace)
-- --------------------------------------------------------------------------
INSERT INTO ENROLLMENT_PROMPTS (ordinal, label, style, text) VALUES
(10, 'Architecture overview', 'presentation',
 'So let me walk you through how this actually fits together. On the left, data lands continuously from about forty upstream systems. Nothing is transformed on the way in — we keep the raw record, because once you throw detail away, you can never get it back. The interesting part happens downstream, where each domain team owns its own models and publishes them for everyone else to build on.'),

(11, 'Live demonstration', 'presentation',
 'Now, rather than talk about this in the abstract, let me just show you. I have a query here that would have taken about nine minutes on the old platform. Watch the timer in the corner. And there it is — just under four seconds, no tuning, no indexes, no cache warming. What I want you to notice is not the speed itself, but that nobody had to plan for it.'),

(12, 'Results and takeaways', 'presentation',
 'Let me leave you with three things. First, the migration paid for itself in month seven, which was two quarters earlier than our business case assumed. Second, and this genuinely surprised us, the biggest win was not cost — it was that analysts stopped filing tickets and started answering their own questions. Third, none of this required a reorganisation. Thank you, and I am happy to take questions.');

-- --------------------------------------------------------------------------
-- Per-narration voice tuning knobs
-- --------------------------------------------------------------------------
-- These were hardcoded in the adapter, untested. Exposing them per narration so
-- the same reference clip can be A/B tested. Defaults match Chatterbox's own.
--   exaggeration : emotional intensity;  0 = flat, 1 = normal, 2 = exaggerated
--   temperature  : sampling variance;    lower = steadier, more faithful
--   cfg_weight   : guidance/pacing;      strongly affects speaker similarity
ALTER TABLE NARRATIONS ADD COLUMN IF NOT EXISTS exaggeration FLOAT DEFAULT 0.5;
ALTER TABLE NARRATIONS ADD COLUMN IF NOT EXISTS temperature  FLOAT DEFAULT 0.8;
ALTER TABLE NARRATIONS ADD COLUMN IF NOT EXISTS cfg_weight   FLOAT DEFAULT 0.5;

SELECT ordinal, label, style, LENGTH(text) AS chars,
       ROUND(REGEXP_COUNT(text, '[ ]+') + 1) AS words
  FROM ENROLLMENT_PROMPTS ORDER BY ordinal;
