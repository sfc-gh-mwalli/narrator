"""Tests for the number canonicaliser injected into Chatter.py.

Run with: python3 -m pytest worker/test_numnorm.py -q
       or: python3 worker/test_numnorm.py

This is the code that decides whether a take passed validation, so a regression here
either rejects good audio or accepts a misread figure. Both are expensive: the first
wastes GPU minutes, the second ships a narration that confidently states the wrong
number.
"""

import re
import string
import sys

from numnorm import (
    narrator_canon_numbers,
    narrator_numbers,
    narrator_protect_decimals,
    narrator_restore_decimals,
)


def norm(text):
    """Mirrors the patched normalize_for_compare_all_punct in Chatter.py.

    Kept in step with edit 12 of patch_extended.py. If that edit changes, this must.
    """
    text = narrator_protect_decimals(text)
    text = re.sub(r"[–—-]", " ", text)
    text = re.sub(rf"[{re.escape(string.punctuation)}]", "", text)
    text = re.sub(r"\s+", " ", text)
    text = narrator_restore_decimals(text.lower().strip())
    return narrator_canon_numbers(text)


# Spoken form on the left, what Whisper writes on the right. These must canonicalise
# to the same string or a correct take gets rejected.
EQUIVALENT = [
    ("one hundred sixty five million", "165 million"),
    ("one point two million", "1.2 million"),
    ("about sixty four milliseconds", "about 64 milliseconds"),
    ("one hundred and sixty five", "165"),
    ("a hundred and sixty five", "165"),
    ("sixty five", "65"),
    ("two point five", "2.5"),
    ("twelve thousand", "12000"),
    ("three billion", "3000000000"),
    ("five", "5"),
    ("nineteen", "19"),
    # Years, which parse as two groups and are rejoined.
    ("twenty twenty six", "2026"),
    ("nineteen eighty four", "1984"),
]

# Must NOT collapse to the same thing: these are different values.
DISTINCT = [
    ("one hundred sixty five million", "265 million"),
    ("one point two million", "2.2 million"),
    ("sixty five", "56"),
    ("twenty twenty six", "2025"),
]

# Text with no numbers must be untouched by canonicalisation beyond the existing
# lowercasing and punctuation stripping.
UNCHANGED = [
    "point of sale data",
    "and the answers are consistent",
    "a report finishes loading quickly",
    "the assistant works from the same semantic view",
]


def test_equivalent_forms_match():
    for spoken, digits in EQUIVALENT:
        assert norm(spoken) == norm(digits), f"{spoken!r} != {digits!r}"


def test_distinct_values_differ():
    for a, b in DISTINCT:
        assert norm(a) != norm(b), f"{a!r} wrongly equals {b!r}"


def test_non_numeric_text_survives():
    for t in UNCHANGED:
        assert norm(t) == t, f"{t!r} became {norm(t)!r}"


def test_decimal_survives_punctuation_stripping():
    # The normaliser strips punctuation, which without protection turns 1.2 into 12
    # and makes "1.2 million" canonicalise to twelve million.
    assert norm("1.2 million") == "1200000"
    assert norm("1.2") == "1.2"


def test_number_extraction_is_ordered():
    got = narrator_numbers(norm("about one point two million orders and 165 million rows"))
    assert got == ["1200000", "165000000"]


def test_years_are_not_summed():
    # 19 + 80 + 4 = 103 would be confidently wrong.
    assert norm("nineteen eighty four") == "1984"
    assert norm("twenty twenty six") == "2026"


def test_the_real_regression():
    """The chunk that failed twice in production at exactly 0.921."""
    import difflib

    script = (
        "This is the shipments summary, one of a set of standard reports, and "
        "I've chosen to break out volume by individual region. Behind "
        "these reports there is data on about one point two million orders "
        "including one hundred sixty five million rows of event history."
    )
    heard = (
        "this is the shipments summary one of a set of standard reports and i've "
        "chosen to break out volume by individual region behind these "
        "reports there is data on about 1.2 million orders including 165 million "
        "rows of event history"
    )
    a, b = norm(heard), norm(script)
    assert narrator_numbers(a) == narrator_numbers(b)
    assert difflib.SequenceMatcher(None, a, b).ratio() >= 0.95


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL  {name}: {exc}")
    print()
    print("all passed" if not failures else f"{failures} failed")
    sys.exit(1 if failures else 0)
