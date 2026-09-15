import { querySnowflake, getServiceToken, getSnowflakeBaseUrl } from "@/lib/snowflake"

/**
 * Stream a file out of an internal stage, through the app.
 *
 * Extracted from the narration audio route so chunk playback gets the same
 * behaviour instead of a second, worse implementation. Every branch below exists
 * because something failed in production:
 *
 *   * GET_PRESIGNED_URL is unusable from inside SPCS. It returns a URL on the SPCS
 *     S3 access point, whose resource policy explicitly denies callers outside the
 *     service, so the URL mints successfully and then fails with AccessDenied when
 *     the browser fetches it. In the UI that shows up as an <audio> element with
 *     greyed-out controls and a 0:00 duration — the source is simply unfetchable.
 *     BUILD_SCOPED_FILE_URL returns a URL on the Snowflake account endpoint
 *     instead, which the container can fetch with its own service token.
 *
 *   * The scoped URL's host must be rewritten. It comes back as the account's
 *     PUBLIC hostname, which on a PrivateLink account is
 *     <account>.<region>.privatelink.snowflakecomputing.com — a name with no DNS
 *     inside a container. The authorisation lives in an encrypted path segment
 *     rather than a host-bound signature, so swapping the origin for the host SPCS
 *     injects is safe.
 *
 *   * Both auth schemes are tried. /api/files wants `Bearer <token>`; the SQL
 *     surface wants `Snowflake Token="<token>"`. They disagree, and which one works
 *     should not be a deploy away.
 */

const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
}

export function contentTypeFor(pathOrExt: string): string {
  const ext = (pathOrExt.split(".").pop() ?? "").toLowerCase()
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}

export interface StageStreamOptions {
  /** Fully qualified stage, e.g. "NARRATOR.APP.CHUNK_AUDIO". */
  stage: string
  /** Path within the stage. Validated before interpolation. */
  path: string
  /** Range header from the incoming request, forwarded so seeking works. */
  range?: string | null
  /** Set to force a download with this filename. */
  downloadAs?: string | null
  /** Used only for log lines, so failures are attributable. */
  label?: string
  /** Called when there is no service token (local dev), to produce a redirect. */
  localFallbackUrl?: () => Promise<string | null>
}

export async function streamStageFile(
  opts: StageStreamOptions,
): Promise<Response> {
  const { stage, path, range, downloadAs, label = "stage-audio" } = opts

  // Interpolated, not bound: BUILD_SCOPED_FILE_URL resolves its path argument at
  // compile time. Safe only because the shape is asserted first.
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Error(`refusing to build a file URL for suspicious path: ${path}`)
  }

  let token: string
  try {
    token = getServiceToken()
  } catch {
    // Local dev has no service token, and a presigned URL DOES work from a laptop
    // because there it resolves to the customer stage bucket rather than the SPCS
    // access point. Redirect rather than fail.
    const fallback = await opts.localFallbackUrl?.()
    if (!fallback) {
      return Response.json(
        { error: "Could not build an audio URL." },
        { status: 500 },
      )
    }
    return Response.redirect(fallback, 307)
  }

  const scoped = await querySnowflake(
    `SELECT BUILD_SCOPED_FILE_URL(@${stage}, '${path}') AS U`,
  )
  const scopedUrl = (scoped[0] as any)?.U
  if (!scopedUrl) {
    return Response.json(
      { error: "Could not build an audio URL." },
      { status: 500 },
    )
  }

  const internalBase = getSnowflakeBaseUrl()
  let fetchUrl = String(scopedUrl)
  if (internalBase) {
    try {
      const target = new URL(fetchUrl)
      const base = new URL(internalBase)
      if (target.host !== base.host) {
        target.protocol = base.protocol
        target.host = base.host
        fetchUrl = target.toString()
      }
    } catch {
      // Malformed base: try the URL as returned.
    }
  }

  const doFetch = (target: string, auth: string) =>
    fetch(target, {
      headers: {
        Authorization: auth,
        ...(range ? { Range: range } : {}),
      },
    })

  let upstream: Response | null = null
  let lastDetail = ""
  for (const auth of [`Bearer ${token}`, `Snowflake Token="${token}"`]) {
    try {
      const r = await doFetch(fetchUrl, auth)
      if (r.ok || r.status === 206) {
        upstream = r
        break
      }
      lastDetail = `${r.status}: ${(await r.text()).slice(0, 200)}`
    } catch (netErr) {
      console.error(new Date().toISOString(), `[${label}] fetch failed`, {
        attempted: new URL(fetchUrl).host,
        scopedHost: new URL(String(scopedUrl)).host,
        SNOWFLAKE_HOST: process.env.SNOWFLAKE_HOST ?? null,
        cause: netErr instanceof Error ? netErr.message : String(netErr),
      })
      if (fetchUrl !== String(scopedUrl)) {
        const r = await doFetch(String(scopedUrl), auth)
        if (r.ok || r.status === 206) {
          upstream = r
          break
        }
        lastDetail = `${r.status}: ${(await r.text()).slice(0, 200)}`
      } else {
        throw netErr
      }
    }
  }

  if (!upstream) {
    console.error(
      new Date().toISOString(),
      `[${label}] all auth schemes failed for ${path}`,
      lastDetail,
    )
    return Response.json(
      { error: `Could not read the audio file. ${lastDetail}` },
      { status: 502 },
    )
  }

  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(path),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": downloadAs
      ? `attachment; filename="${downloadAs.replace(/[^A-Za-z0-9._ -]/g, "_")}"`
      : "inline",
  }
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h)
    if (v) headers[h === "content-length" ? "Content-Length" : "Content-Range"] = v
  }

  return new Response(upstream.body, { status: upstream.status, headers })
}
