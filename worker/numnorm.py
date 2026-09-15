"""Canonicalise numbers in text so a spoken form and a digit form compare equal.

Whisper transcribes spoken numbers as digits. A script that spells them out
therefore mismatches its own correct audio: "one hundred sixty five million" vs
"165 million" differs by 20 characters under SequenceMatcher, which is enough to
fail a take that said every word perfectly. Observed as a reproducible 0.921 on
real content, identical across two runs with different seeds — the giveaway that it
was deterministic rather than a generation defect.

Both sides are converted to a plain numeric form rather than the transcript being
converted to words, because the wording a human chooses is not predictable
("one hundred and sixty five", "a hundred sixty-five") while the numeric value is.

Numbers are still validated: a take that says the WRONG number produces a different
value and still fails. Only the rendering is normalised away.
"""

from __future__ import annotations

import re

_NARR_UNITS = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_NARR_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
# Multipliers that scale everything accumulated before them.
_NARR_SCALES = {
    "hundred": 100, "thousand": 1_000, "million": 1_000_000,
    "billion": 1_000_000_000, "trillion": 1_000_000_000_000,
}
_NARR_NUMWORD = set(_NARR_UNITS) | set(_NARR_TENS) | set(_NARR_SCALES) | {"a", "and", "point"}

_NARR_DIGITS = re.compile(r"^\d+(?:\.\d+)?$")

# A decimal point must survive punctuation stripping. The caller's normaliser
# removes all punctuation, which silently turns "1.2" into "12" — and then
# "1.2 million" canonicalises to 12,000,000 while "one point two million" gives
# 1,200,000, so the fix for one mismatch would have created a worse one.
_NARR_DECIMAL = re.compile(r"(\d)\.(\d)")
_NARR_DOT = "\u241f"  # SYMBOL FOR UNIT SEPARATOR: not punctuation, so it is preserved


def narrator_protect_decimals(text: str) -> str:
    """Call BEFORE stripping punctuation."""
    return _NARR_DECIMAL.sub(rf"\1{_NARR_DOT}\2", text)


def narrator_restore_decimals(text: str) -> str:
    """Call AFTER stripping punctuation, before narrator_canon_numbers."""
    return text.replace(_NARR_DOT, ".")


def _narr_fmt(value: float) -> str:
    """Render a value without trailing zeros, so 1200000.0 reads as 1200000."""
    if value == int(value):
        return str(int(value))
    return repr(round(value, 6)).rstrip("0").rstrip(".")


def _narr_consume(tokens: list[str], i: int) -> tuple[str | None, int]:
    """Parse one number starting at tokens[i]. Returns (rendered, next_index).

    Returns (None, i) when tokens[i] does not begin a number, so the caller can emit
    the word unchanged.
    """
    n = len(tokens)
    # A leading digit token: consume it, then any scale words that follow, so
    # "1.2 million" and "one point two million" land on the same value.
    if _NARR_DIGITS.match(tokens[i]):
        total = float(tokens[i])
        j = i + 1
        while j < n and tokens[j] in _NARR_SCALES:
            total *= _NARR_SCALES[tokens[j]]
            j += 1
        return _narr_fmt(total), j

    if tokens[i] not in _NARR_NUMWORD or tokens[i] in {"and", "point"}:
        return None, i
    # "a" starts a number only in "a hundred" / "a thousand". Anywhere else it is the
    # article, and turning "a report" into "1 report" would be wrong — harmless when
    # applied to both sides, but it makes the canonical text hard to read in logs.
    if tokens[i] == "a" and not (
        i + 1 < n and tokens[i + 1] in _NARR_SCALES
    ):
        return None, i

    total = 0.0      # completed groups, e.g. the "two million" of "two million five"
    current = 0.0    # the group being built
    seen = False
    scaled = False   # has a scale word applied to the current group?
    j = i
    while j < n:
        t = tokens[j]
        if t in _NARR_UNITS:
            # "nineteen eighty four" must not become 19+80+4=103. A second tens- or
            # teens-magnitude word with no scale between them is a year or a digit
            # string being read in groups, not an addition. Emit what we have and
            # let the next group parse separately: "19 84" is at least honest, where
            # 103 is confidently wrong. Whisper renders these as "1984" either way,
            # so neither form matches — but a wrong number must not look right.
            if current >= 10 and not scaled and _NARR_UNITS[t] >= 10:
                break
            current += _NARR_UNITS[t]
            seen = True
        elif t in _NARR_TENS:
            if current >= 10 and not scaled:
                break
            current += _NARR_TENS[t]
            seen = True
        elif t == "hundred":
            current = (current or 1) * 100
            seen = True
            scaled = True
        elif t in _NARR_SCALES:
            # thousand/million/... scale the current group and bank it.
            total += (current or 1) * _NARR_SCALES[t]
            current = 0.0
            seen = True
            scaled = True
        elif t == "point":
            # Decimal tail: each following unit word is one digit after the point.
            frac: list[str] = []
            k = j + 1
            while k < n and tokens[k] in _NARR_UNITS:
                frac.append(str(_NARR_UNITS[tokens[k]]))
                k += 1
            if not frac:
                break
            value = total + current + float("0." + "".join(frac))
            j = k
            # A scale word after the decimal applies to the whole value.
            while j < n and tokens[j] in _NARR_SCALES:
                value *= _NARR_SCALES[tokens[j]]
                j += 1
            return _narr_fmt(value), j
        elif t in {"a", "and"}:
            # "a hundred" behaves as "one hundred"; "and" is filler. Only skip them
            # when a number is already in progress or a scale word follows, so an
            # ordinary "a" or "and" is never swallowed.
            if not (seen or (j + 1 < n and tokens[j + 1] in _NARR_SCALES)):
                break
        else:
            break
        j += 1

    if not seen:
        return None, i
    return _narr_fmt(total + current), j


_NARR_INT = re.compile(r"^\d+$")


def _narr_join_years(out: list[str]) -> list[str]:
    """Rejoin a year that was split into two groups.

    "nineteen eighty four" parses as two groups, 19 and 84, because summing them
    would give a confidently wrong 103. Two adjacent unscaled groups in 10-99 and
    0-99 are a year read in halves, so they are concatenated: 19,84 -> 1984, which
    is what Whisper writes. Without this, a script saying "twenty twenty six" could
    never match a transcript saying "2026", and the exact-number check below would
    reject every take of that chunk.
    """
    joined: list[str] = []
    i = 0
    while i < len(out):
        a = out[i]
        b = out[i + 1] if i + 1 < len(out) else None
        if (
            b is not None
            and _NARR_INT.match(a)
            and _NARR_INT.match(b)
            and 10 <= int(a) <= 99
            and 0 <= int(b) <= 99
            and len(b) <= 2
        ):
            joined.append(str(int(a) * 100 + int(b)))
            i += 2
        else:
            joined.append(a)
            i += 1
    return joined


def narrator_canon_numbers(text: str) -> str:
    """Rewrite every number, however spelled, into a plain numeric form."""
    tokens = text.split()
    out: list[str] = []
    i = 0
    while i < len(tokens):
        rendered, nxt = _narr_consume(tokens, i)
        if rendered is None:
            out.append(tokens[i])
            i += 1
        else:
            out.append(rendered)
            i = nxt
    return " ".join(_narr_join_years(out))


def narrator_numbers(text: str) -> list[str]:
    """Every number in already-canonicalised text, in order.

    Used for an exact comparison alongside the fuzzy text score. Canonicalising
    makes numbers COMPACT, so "265000000" and "165000000" differ by one character in
    several hundred and a wrong number scores 0.996 — passing a take that misread a
    figure. The fuzzy score cannot be trusted for numbers; this can.
    """
    return [t for t in text.split() if _NARR_INT.match(t) or _NARR_DIGITS.match(t)]
