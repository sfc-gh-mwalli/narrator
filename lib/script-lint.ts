/**
 * Script lint, run at submit time.
 *
 * Every check here corresponds to a failure actually observed in this project, and
 * each one costs minutes to discover the slow way: a bad script is only visible
 * after a multi-minute GPU run, by which point the user has paid for it. Warning
 * before submit is the whole point.
 *
 * These are WARNINGS, never blocks. The model is not deterministic and none of
 * these patterns is certain to fail — refusing a submit on a heuristic would be
 * worse than a slightly worse take, since the user can always regenerate one chunk.
 * The one exception is a malformed pause tag, which is a typo with a silent
 * consequence: it is read as literal text and spoken aloud.
 */

/** Matches the pause syntax the planner accepts. Kept in sync with planning.py. */
const PAUSE_OK = /\[\s*pause\s*:\s*\d+(?:\.\d+)?\s*(?:ms|s)?\s*\]/gi

/** Anything that looks like an attempt at a directive. Used to catch near-misses
 *  such as [pause 2s], [pause:2sec] or [PAUSE=2s], which the real pattern rejects
 *  and which therefore get spoken as words. */
const BRACKETED = /\[[^\]\n]{0,40}\]/g

/** Chunking splits on sentences, then groups to at most this many characters.
 *  Must match adapter.chunk_text's group_sentences(max_chars=300). */
const MAX_CHARS = 300

export type LintSeverity = "error" | "warning"

export interface LintFinding {
  severity: LintSeverity
  /** Short machine-readable kind, for tests and for grouping in the UI. */
  kind: string
  message: string
  /** The offending text, trimmed for display. */
  excerpt?: string
}

function excerpt(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Splits into sentences the same way the worker does, approximately.
 *
 * Deliberately a rough approximation: this runs in the browser and cannot import
 * the model's tokeniser. It only needs to be good enough to flag a sentence that is
 * obviously too long, and it errs toward under-reporting rather than crying wolf.
 */
function roughSentences(text: string): string[] {
  return text
    .replace(PAUSE_OK, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function lintScript(script: string): LintFinding[] {
  const findings: LintFinding[] = []
  const text = script ?? ""
  if (!text.trim()) return findings

  // 1. Malformed pause tags. The only error-level finding: the user clearly meant a
  //    directive, and the consequence of getting it wrong is the model reading
  //    "pause 2s" out loud in the middle of the narration.
  const okSpans = [...text.matchAll(PAUSE_OK)].map((m) => m.index ?? -1)
  for (const m of text.matchAll(BRACKETED)) {
    const at = m.index ?? -1
    if (okSpans.includes(at)) continue
    const inner = m[0].slice(1, -1)
    if (!/pause/i.test(inner)) continue
    findings.push({
      severity: "error",
      kind: "bad-pause-tag",
      message:
        "This looks like a pause directive but does not match the accepted form, " +
        "so it will be spoken aloud. Use [pause:2s] or [pause:500ms].",
      excerpt: excerpt(m[0]),
    })
  }

  // 2. Dotted initialisms. "A.I." and "U.S." are read as sentence boundaries by the
  //    sentence splitter, which fragments a sentence into pieces too short to carry
  //    prosody, and the fragments then get their own takes.
  for (const m of text.matchAll(/\b(?:[A-Za-z]\.){2,}/g)) {
    findings.push({
      severity: "warning",
      kind: "dotted-initialism",
      message:
        "Dotted initialisms read as sentence ends and fragment the chunking. " +
        "Write AI, US, API without the periods.",
      excerpt: excerpt(m[0]),
    })
  }

  // 3. Sentences longer than the chunk budget. A single sentence cannot be split
  //    across chunks, so one longer than MAX_CHARS becomes an oversized chunk —
  //    which is where dropped words and non-speech runs concentrate.
  for (const s of roughSentences(text)) {
    if (s.length > MAX_CHARS) {
      findings.push({
        severity: "warning",
        kind: "long-sentence",
        message:
          `This sentence is ${s.length} characters, over the ${MAX_CHARS}-character ` +
          "chunk budget, so it cannot be split and will generate as one long chunk. " +
          "Long chunks are where word dropping concentrates. Split it.",
        excerpt: excerpt(s),
      })
    } else if (s.length > MAX_CHARS * 0.9) {
      findings.push({
        severity: "warning",
        kind: "near-max-sentence",
        message:
          `This sentence is ${s.length} characters, close to the ${MAX_CHARS} limit. ` +
          "It will likely get a chunk of its own with no room to group.",
        excerpt: excerpt(s),
      })
    }
  }

  // There is deliberately NO warning about numbers here any more.
  //
  // An earlier version advised writing digits out as words, because Whisper writes
  // spoken numbers as digits and the mismatch failed good takes. That advice is now
  // obsolete AND backwards: the validator canonicalises numbers on both sides
  // (patch edits 12 and 13), so "165 million" and "one hundred sixty five million"
  // compare equal, while a genuinely misread figure is caught by an exact
  // number-sequence check. Either spelling is now safe, and nagging about it would
  // send the user to fix something that is no longer a problem.

  return findings
}

/** Convenience: does this script have anything the user should fix first? */
export function hasBlockingFindings(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error")
}
