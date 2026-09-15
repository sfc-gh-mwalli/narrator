/**
 * Stage upload helper.
 *
 * The Node driver's PUT command takes a local file path, not a buffer, so an
 * uploaded recording is written to a temp file and PUT from there. The
 * alternative — handing the browser a presigned upload URL — was rejected for
 * this prototype because PUT keeps the credential entirely server-side and
 * needs no extra CORS configuration.
 *
 * AUTO_COMPRESS must be FALSE: enrollment audio has to stay lossless and
 * byte-identical, and the worker reads it as a plain .wav off a stage volume
 * mount, where a .gz would simply be an unreadable file.
 */
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { querySnowflake } from "@/lib/snowflake"

export interface StageUpload {
  /** Stage-relative path, e.g. "raw/<uuid>.wav" — what gets stored in tables. */
  stagePath: string
}

/**
 * Upload a WAV to @NARRATOR.APP.ENROLLMENT_AUDIO under `raw/`.
 *
 * `subdir` becomes part of the stage path so the worker's processed output can
 * live alongside the original without collision.
 */
export async function uploadEnrollmentWav(
  bytes: Buffer,
  subdir = "raw",
): Promise<StageUpload> {
  if (!bytes?.length) throw new Error("empty upload")

  // Cheap sanity check before spending a round trip: a RIFF/WAVE header.
  const riff = bytes.subarray(0, 4).toString("ascii")
  const wave = bytes.subarray(8, 12).toString("ascii")
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(
      "Upload is not a WAV file. Enrollment audio must be lossless WAV — " +
        "compressed formats degrade the speaker embedding.",
    )
  }

  const name = `${randomUUID()}.wav`
  const dir = await mkdtemp(join(tmpdir(), "narrator-"))
  const local = join(dir, name)

  try {
    await writeFile(local, bytes)
    await querySnowflake(
      `PUT 'file://${local}' '@NARRATOR.APP.ENROLLMENT_AUDIO/${subdir}/' ` +
        `AUTO_COMPRESS = FALSE OVERWRITE = TRUE`,
    )
    return { stagePath: `${subdir}/${name}` }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
