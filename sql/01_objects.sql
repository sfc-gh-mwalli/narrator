-- ============================================================================
-- Narrator — Step 1: Snowflake objects
-- ============================================================================
-- Single-user prototype. Everything is owned by SYSADMIN, which is also the
-- role that deploys both the SAR app (service A) and the SPCS worker
-- (service B). Cross-role grants are therefore unnecessary — ownership
-- implies the privileges the plan called for. If the services later run as
-- distinct roles, the grants at the bottom of this file must be enabled.
--
-- Snowflake does NOT enforce CHECK or FOREIGN KEY constraints. They are
-- declared here to document intent; state-value validation is application-side.
-- ============================================================================

USE ROLE SYSADMIN;
USE WAREHOUSE GENERAL_USE_WH;

CREATE DATABASE IF NOT EXISTS NARRATOR
  COMMENT = 'AI voice-cloning narration app (Chatterbox on SPCS + Next.js SAR app)';

CREATE SCHEMA IF NOT EXISTS NARRATOR.APP
  COMMENT = 'Application tables and audio stages';

CREATE SCHEMA IF NOT EXISTS NARRATOR.IMAGES
  COMMENT = 'Container image repository for the GPU worker';

USE SCHEMA NARRATOR.APP;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A cloned voice. ref_clip_path points at the accepted enrollment reference
-- on @VOICE_PROFILES once state reaches READY.
CREATE TABLE IF NOT EXISTS SPEAKERS (
    speaker_id     VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
    name           VARCHAR       NOT NULL,
    ref_clip_path  VARCHAR,
    state          VARCHAR       NOT NULL DEFAULT 'DRAFT',   -- DRAFT|ENROLLING|READY|REJECTED
    consent_at     TIMESTAMP_LTZ,                            -- attestation that the speaker consented
    created_on     TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'Enrolled speaker voices';

-- Paragraph-length, phonetically balanced passages read straight through in
-- ONE continuous take (~20-30s). Deliberately NOT individual short sentences:
-- the model wants continuous speech, and 15-30s in one take is the sweet spot.
CREATE TABLE IF NOT EXISTS ENROLLMENT_PROMPTS (
    prompt_id  VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
    ordinal    NUMBER  NOT NULL,
    text       VARCHAR NOT NULL
) COMMENT = 'Phonetically balanced enrollment passages (~20-30s read each)';

-- One row per recorded or uploaded take, with the quality scores that decide
-- acceptance. reject_reason carries a specific, distinct message per failure.
CREATE TABLE IF NOT EXISTS ENROLLMENT_TAKES (
    take_id        VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
    speaker_id     VARCHAR       NOT NULL REFERENCES SPEAKERS(speaker_id),
    prompt_id      VARCHAR       REFERENCES ENROLLMENT_PROMPTS(prompt_id),
    -- audio_path is the RAW upload and is immutable: it is the worker's input, so
    -- overwriting it would make a retry normalise its own output. processed_path
    -- holds the derived clip. Keeping both means every file a take owns stays
    -- addressable, so deleting a voice can actually clean up after itself.
    audio_path     VARCHAR,                                  -- raw/<upload-uuid>.wav
    processed_path VARCHAR,                                  -- processed/<take-id>.wav
    snr_db         FLOAT,                                    -- WADA-SNR estimate
    clip_ratio     FLOAT,
    silence_ratio  FLOAT,
    duration_ms    NUMBER,
    accepted       BOOLEAN,
    reject_reason  VARCHAR,
    created_on     TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'Enrollment takes with quality scores';

-- One narration = one script = one generated audio file. `project` groups the
-- sections of a single talk so they list and play in order.
CREATE TABLE IF NOT EXISTS NARRATIONS (
    narration_id  VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
    project       VARCHAR,
    title         VARCHAR       NOT NULL,
    script_text   VARCHAR       NOT NULL,
    speaker_id    VARCHAR       NOT NULL REFERENCES SPEAKERS(speaker_id),
    base_seed     NUMBER,
    audio_path    VARCHAR,
    format        VARCHAR,                                   -- wav|mp3|flac
    duration_ms   NUMBER,
    state         VARCHAR       NOT NULL DEFAULT 'DRAFT',     -- DRAFT|QUEUED|GENERATING|READY|FAILED
    created_on    TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'Generated narrations, grouped by project';

-- The sole coupling between service A and service B. A inserts; B claims with
-- a conditional UPDATE ... WHERE state='QUEUED' so a second worker cannot
-- double-claim. failure_reason is always populated on FAILED.
CREATE TABLE IF NOT EXISTS JOBS (
    job_id          VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
    kind            VARCHAR       NOT NULL,                  -- ENROLL|GENERATE
    ref_id          VARCHAR       NOT NULL,                  -- take_id or narration_id
    state           VARCHAR       NOT NULL DEFAULT 'QUEUED',  -- QUEUED|RUNNING|DONE|FAILED
    submitted_at    TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    started_at      TIMESTAMP_LTZ,
    finished_at     TIMESTAMP_LTZ,
    failure_reason  VARCHAR,
    worker_id       VARCHAR
) COMMENT = 'Work queue polled by the GPU worker';

-- B writes a heartbeat here every few seconds. This replaces an HTTP health
-- endpoint, since B exposes no HTTP surface at all. A reads it to distinguish
-- "model still loading" from "worker gone" (stale heartbeat_at).
CREATE TABLE IF NOT EXISTS WORKER_STATUS (
    worker_id     VARCHAR       PRIMARY KEY,
    state         VARCHAR       NOT NULL,                    -- STARTING|LOADING_MODEL|IDLE|BUSY
    model_loaded  BOOLEAN       NOT NULL DEFAULT FALSE,
    heartbeat_at  TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'Worker liveness and model-load state (replaces an HTTP health endpoint)';

-- ---------------------------------------------------------------------------
-- Stages
-- ---------------------------------------------------------------------------
-- ENCRYPTION = SNOWFLAKE_SSE is REQUIRED: server-side encryption is a
-- precondition for accessing staged files via a URL (GET_PRESIGNED_URL), which
-- is how the app serves narration audio to the browser. It is also the
-- encryption type SPCS stage-volume mounts expect.

CREATE STAGE IF NOT EXISTS ENROLLMENT_AUDIO
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY  = (ENABLE = TRUE)
  COMMENT = 'Raw and processed enrollment takes';

CREATE STAGE IF NOT EXISTS VOICE_PROFILES
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY  = (ENABLE = TRUE)
  COMMENT = 'Accepted reference clips used for cloning';

CREATE STAGE IF NOT EXISTS NARRATION_AUDIO
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY  = (ENABLE = TRUE)
  COMMENT = 'Generated narration audio';

-- ---------------------------------------------------------------------------
-- Image repository
-- ---------------------------------------------------------------------------

CREATE IMAGE REPOSITORY IF NOT EXISTS NARRATOR.IMAGES.REPO
  COMMENT = 'Chatterbox GPU worker images';

-- ---------------------------------------------------------------------------
-- Warehouse for the worker's polling loop
-- ---------------------------------------------------------------------------
-- B needs a warehouse to poll JOBS, but it does NOT need a dedicated one, and an
-- earlier revision of this script created NARRATOR_WH as though it did. That was
-- an imposition: the queries here are job claims, heartbeats and row updates while
-- the GPU does all the real work, so any existing extra-small warehouse serves,
-- and a dedicated one only adds an object to grant and monitor plus its own idle
-- billing window.
--
-- The warehouse is therefore a setting (see 08/09_*.sql and the GPU card in the
-- UI), seeded from CURRENT_WAREHOUSE() so a fresh install adopts whatever the
-- installer was already using. Uncomment the statement below ONLY for an account
-- that has no suitable warehouse at all.
--
-- CREATE WAREHOUSE IF NOT EXISTS NARRATOR_WH
--   WAREHOUSE_SIZE      = 'XSMALL'
--   AUTO_SUSPEND        = 60
--   AUTO_RESUME         = TRUE
--   INITIALLY_SUSPENDED = TRUE
--   COMMENT = 'Polling + app queries for Narrator';

-- ---------------------------------------------------------------------------
-- GPU compute pool
-- ---------------------------------------------------------------------------
-- GPU_NV_S = 1x NVIDIA A10G (~22-24GB VRAM), the cheapest GPU family available
-- in this region. AUTO_RESUME=FALSE means NOTHING wakes this implicitly: the
-- app's Wake GPU button must issue RESUME explicitly. Jobs submitted while
-- suspended simply sit QUEUED. Resuming bills a 5-minute minimum.
-- NOTE: a pool's INSTANCE_FAMILY cannot be altered. Moving to GPU_L40S_G1_8
-- later means creating a new pool and recreating the service on it.

CREATE COMPUTE POOL IF NOT EXISTS NARRATOR_GPU_POOL
  MIN_NODES           = 1
  MAX_NODES           = 1
  INSTANCE_FAMILY     = GPU_NV_S
  AUTO_RESUME         = FALSE
  INITIALLY_SUSPENDED = TRUE
  AUTO_SUSPEND_SECS   = 300
  COMMENT = 'Chatterbox TTS worker — manual resume only, minimize GPU uptime';

-- ---------------------------------------------------------------------------
-- Seed enrollment passages (Harvard Sentences, IEEE — public domain)
-- ---------------------------------------------------------------------------
-- Each passage is 8 phonetically balanced sentences, ~62 words, ~25s at a
-- normal reading pace. Read ONE passage straight through per take.

INSERT INTO ENROLLMENT_PROMPTS (ordinal, text) VALUES
(1, 'The birch canoe slid on the smooth planks. Glue the sheet to the dark blue background. It is easy to tell the depth of a well. These days a chicken leg is a rare dish. Rice is often served in round bowls. The juice of lemons makes fine punch. The box was thrown beside the parked truck. The hogs were fed chopped corn and garbage.'),
(2, 'Four hours of steady work faced us. A large size in stockings is hard to sell. The boy was there when the sun rose. A rod is used to catch pink salmon. The source of the huge river is the clear spring. Kick the ball straight and follow through. Help the woman get back to her feet. A pot of tea helps to pass the evening.'),
(3, 'Smoky fires lack flame and heat. The soft cushion broke the man''s fall. The salt breeze came across from the sea. The girl at the booth sold fifty bonds. The small pup gnawed a hole in the sock. The fish twisted and turned on the bent hook. Press the pants and sew a button on the vest. The swan dive was far short of perfect.');

-- ---------------------------------------------------------------------------
-- Cross-role grants — NOT NEEDED for this prototype
-- ---------------------------------------------------------------------------
-- Both services run as SYSADMIN, which owns every object above, so these are
-- redundant. Enable them only if A and B are later split onto separate roles.
--
-- GRANT OPERATE ON COMPUTE POOL NARRATOR_GPU_POOL TO ROLE <a_role>;
-- GRANT USAGE ON WAREHOUSE NARRATOR_WH TO ROLE <b_role>;
-- GRANT USAGE ON DATABASE NARRATOR TO ROLE <b_role>;
-- GRANT USAGE ON SCHEMA NARRATOR.APP TO ROLE <b_role>;
-- GRANT SELECT, INSERT, UPDATE ON TABLE NARRATOR.APP.JOBS TO ROLE <b_role>;
-- GRANT SELECT, INSERT, UPDATE ON TABLE NARRATOR.APP.WORKER_STATUS TO ROLE <b_role>;
-- GRANT SELECT, INSERT, UPDATE ON TABLE NARRATOR.APP.NARRATIONS TO ROLE <b_role>;
-- GRANT SELECT, INSERT, UPDATE ON TABLE NARRATOR.APP.ENROLLMENT_TAKES TO ROLE <b_role>;
-- GRANT SELECT ON TABLE NARRATOR.APP.SPEAKERS TO ROLE <b_role>;
-- GRANT READ, WRITE ON STAGE NARRATOR.APP.ENROLLMENT_AUDIO TO ROLE <b_role>;
-- GRANT READ, WRITE ON STAGE NARRATOR.APP.VOICE_PROFILES TO ROLE <b_role>;
-- GRANT READ, WRITE ON STAGE NARRATOR.APP.NARRATION_AUDIO TO ROLE <b_role>;
-- GRANT READ ON IMAGE REPOSITORY NARRATOR.IMAGES.REPO TO ROLE <b_role>;
