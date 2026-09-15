import { describe, it, expect } from "vitest"
import { lintScript, hasBlockingFindings } from "@/lib/script-lint"

const kinds = (s: string) => lintScript(s).map((f) => f.kind)

describe("lintScript", () => {
  it("passes a clean script", () => {
    expect(lintScript("This is a clean sentence. So is this one.")).toEqual([])
  })

  it("accepts valid pause tags without complaint", () => {
    for (const tag of ["[pause:2s]", "[pause:500ms]", "[ pause : 1.5 s ]", "[PAUSE:2]"]) {
      expect(kinds(`Before. ${tag} After.`)).not.toContain("bad-pause-tag")
    }
  })

  it("flags malformed pause tags as errors, since they get spoken", () => {
    for (const tag of ["[pause 2s]", "[pause:2sec]", "[PAUSE=2s]", "[pause]"]) {
      const found = lintScript(`Before. ${tag} After.`)
      expect(found.map((f) => f.kind), tag).toContain("bad-pause-tag")
      expect(hasBlockingFindings(found), tag).toBe(true)
    }
  })

  it("ignores brackets that are not pause attempts", () => {
    expect(kinds("As shown [figure 1] the result holds.")).not.toContain(
      "bad-pause-tag",
    )
  })

  it("flags dotted initialisms", () => {
    expect(kinds("We use A.I. for this.")).toContain("dotted-initialism")
    expect(kinds("Based in the U.S.A. today.")).toContain("dotted-initialism")
  })

  it("does not flag ordinary abbreviations with one period", () => {
    expect(kinds("Dr. Smith arrived.")).not.toContain("dotted-initialism")
  })

  it("flags a sentence over the chunk budget", () => {
    const long = `${"word ".repeat(70)}end.`
    expect(long.length).toBeGreaterThan(300)
    expect(kinds(long)).toContain("long-sentence")
  })

  it("flags a sentence near the budget separately", () => {
    // Between 270 and 300 characters.
    const near = `${"ab ".repeat(93)}x.`
    expect(near.length).toBeGreaterThan(270)
    expect(near.length).toBeLessThanOrEqual(300)
    expect(kinds(near)).toContain("near-max-sentence")
  })

  it("does not count pause tags toward sentence length", () => {
    const s = `${"word ".repeat(50)}end. [pause:3s]`
    const found = kinds(s)
    expect(found.filter((k) => k === "long-sentence")).toHaveLength(0)
  })

  it("no longer warns about digits, since the validator canonicalises numbers", () => {
    // Both spellings are safe now: patch edits 12/13 compare numbers by value and
    // check them exactly. Warning here would send the user to fix a non-problem.
    expect(kinds("We saw 165 and 2400 results.")).not.toContain("digits")
    expect(kinds("We saw one hundred sixty five results.")).not.toContain("digits")
  })

  it("returns no findings for empty or whitespace input", () => {
    expect(lintScript("")).toEqual([])
    expect(lintScript("   \n  ")).toEqual([])
  })

  it("treats warnings as non-blocking", () => {
    expect(hasBlockingFindings(lintScript("We use A.I. here."))).toBe(false)
  })
})
