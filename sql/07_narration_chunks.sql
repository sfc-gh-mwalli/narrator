-- Per-chunk unit of work.
--
-- Until now a narration was one indivisible job: one job, one worker, one GPU.
-- That capped a narration's latency at the sum of all its chunks no matter how
-- much hardware was available, because nothing could be worked on in parallel.
--
-- Proven before building this (18-chunk, 237s narration):
--   * quality is unaffected — assembling from 18 independently generated chunks
--     scored 0.9904 transcript similarity vs 0.9926 for the same script as a
--     single job, with 0 of 17 joins showing any click artifact and identical
--     short-term loudness variability (5.55 dB vs 5.48 dB)
--   * the longest single chunk was 59s, which becomes the latency floor
--   * 4 workers would finish in 214s vs 580s single-job; 6 workers in 139s
--   * decomposition costs ~11.8s per chunk in Whisper model load, which is why
--     the worker now keeps Whisper resident
--
-- A chunk is also the natural unit for everything else we wanted: per-chunk
-- progress, cancelling, repairing one bad chunk instead of rerunning 18, and
-- auditioning the takes of a single chunk.

CREATE TABLE IF NOT EXISTS NARRATOR.APP.NARRATION_CHUNKS (
    narration_id    VARCHAR        NOT NULL,
    chunk_index     NUMBER         NOT NULL,
    text            VARCHAR        NOT NULL,

    -- Silence to append AFTER this chunk, from a [pause:Xs] tag in the script.
    -- Pause tags force a chunk boundary, so a pause is always between chunks and
    -- never inside generated audio. That matters for two reasons: the model never
    -- tries to speak the tag, and the take-level "loud non-speech" artifact check
    -- can never mistake an intentional pause for a defect.
    pause_after_ms  NUMBER         DEFAULT 0,

    state           VARCHAR        DEFAULT 'QUEUED',   -- QUEUED|GENERATING|READY|FAILED
    audio_path      VARCHAR,                           -- wav on @CHUNK_AUDIO
    duration_ms     NUMBER,

    -- Why the winning take won, kept per chunk so a bad chunk can be identified
    -- without re-deriving it from logs that rotate and vanish on suspend.
    score           FLOAT,                             -- Whisper text similarity
    gap_seconds     FLOAT,                             -- longest non-speech run
    gap_quiet_db    FLOAT,                             -- how far below speech it sat
    takes           NUMBER,                            -- takes generated
    seed            NUMBER,
    failure_reason  VARCHAR,

    created_on      TIMESTAMP_LTZ  DEFAULT CURRENT_TIMESTAMP(),
    updated_on      TIMESTAMP_LTZ,

    PRIMARY KEY (narration_id, chunk_index)
);

-- Intermediate per-chunk audio. Kept as WAV, not MP3: these are concatenated at
-- assembly and re-encoding every chunk would stack generational loss for no
-- benefit. Cleaned up when the narration is deleted.
-- DIRECTORY is enabled to match NARRATION_AUDIO. Chunk audio is auditioned from
-- the UI, and serving a stage file to a browser goes through
-- BUILD_SCOPED_FILE_URL, which wants the stage catalogued.
CREATE STAGE IF NOT EXISTS NARRATOR.APP.CHUNK_AUDIO
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY  = (ENABLE = TRUE)
  COMMENT = 'Per-chunk WAV audio, intermediate between GENERATE_CHUNK and ASSEMBLE.';

-- GENERATE_CHUNK needs to identify a chunk, not just a narration.
ALTER TABLE NARRATOR.APP.JOBS
  ADD COLUMN IF NOT EXISTS ref_index NUMBER
  COMMENT 'Chunk index for GENERATE_CHUNK jobs; NULL for whole-narration jobs.';
