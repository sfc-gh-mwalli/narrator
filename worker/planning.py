"""Script planning: pause tags and chunk boundaries.

Kept separate from the worker so it can be tested without a GPU, a model, or a
Snowflake connection — this is pure text handling and it decides the shape of
every job that follows.

Two responsibilities:

1. Parse [pause:Xs] tags out of the script and turn them into silence durations
   attached to chunk boundaries.

2. Split the remaining text into chunks using Extended's OWN chunker, so chunking
   stays byte-identical to the single-job path we have been measuring against. A
   reimplementation here would drift from it silently.

Why pauses become boundaries rather than inline text: the model cannot say a
pause, and a tag left in the text would either be spoken aloud or wreck the
Whisper score it is compared against. Making the pause a property of the boundary
also keeps intentional silence out of generated audio entirely, which is what
stops the take-level artifact check from mistaking a pause for a defect.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, List, Optional

# [pause:1.5s] / [pause:1.5] / [pause: 750ms] / [PAUSE:2S]
_PAUSE_RE = re.compile(
    r"\[\s*pause\s*:\s*(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>ms|s)?\s*\]",
    re.IGNORECASE,
)

# Guardrails. A pause under ~50ms is inaudible and usually a typo; a very long one
# is more likely a mistake than an intention, and it would silently stretch the
# narration well past the length the UI predicted.
MIN_PAUSE_MS = 50
MAX_PAUSE_MS = 30_000


@dataclass
class PlannedChunk:
    index: int
    text: str
    pause_after_ms: int


def parse_pauses(script: str) -> tuple[list[str], list[int]]:
    """Split a script on pause tags.

    Returns (segments, pauses) where pauses[i] is the silence in milliseconds
    that follows segments[i]. len(pauses) == len(segments), with a trailing 0 —
    a pause at the very end of a script is dropped, since trailing silence is the
    editor's job, not ours.
    """
    segments: list[str] = []
    pauses: list[int] = []
    pos = 0
    for m in _PAUSE_RE.finditer(script):
        segments.append(script[pos:m.start()])
        value = float(m.group("value"))
        ms = int(round(value if (m.group("unit") or "s").lower() == "ms" else value * 1000))
        pauses.append(max(MIN_PAUSE_MS, min(MAX_PAUSE_MS, ms)))
        pos = m.end()
    segments.append(script[pos:])
    pauses.append(0)

    # Drop segments that are empty once the tag is removed (e.g. two adjacent
    # tags), folding their pause into the previous boundary so the total silence
    # the author asked for is preserved.
    out_segs: list[str] = []
    out_pauses: list[int] = []
    for seg, pause in zip(segments, pauses):
        if seg.strip():
            out_segs.append(seg)
            out_pauses.append(pause)
        elif out_pauses:
            out_pauses[-1] = min(MAX_PAUSE_MS, out_pauses[-1] + pause)
        # a leading empty segment with a pause has nothing to attach to: ignore
    if not out_segs:
        return ([], [])
    out_pauses[-1] = 0
    return (out_segs, out_pauses)


def plan_chunks(script: str, chunker: Callable[[str], List[str]]) -> list[PlannedChunk]:
    """Turn a script into the ordered chunk list to generate.

    `chunker` takes one segment of prose and returns its chunks; the caller passes
    Extended's grouping so this module never duplicates that logic.

    The pause that followed a segment is attached to that segment's LAST chunk,
    which is what makes a pause always fall on a chunk boundary.
    """
    segments, pauses = parse_pauses(script)
    planned: list[PlannedChunk] = []
    for seg, pause_ms in zip(segments, pauses):
        chunks = [c for c in chunker(seg) if c and c.strip()]
        if not chunks:
            continue
        for c in chunks:
            planned.append(PlannedChunk(index=len(planned), text=c, pause_after_ms=0))
        planned[-1].pause_after_ms = pause_ms
    return planned


def strip_pause_tags(text: str) -> str:
    """Remove pause tags from text, for display or for scoring against audio."""
    return _PAUSE_RE.sub(" ", text)


def describe_plan(planned: list[PlannedChunk]) -> str:
    total_pause = sum(c.pause_after_ms for c in planned)
    return (
        f"{len(planned)} chunks, "
        f"{sum(1 for c in planned if c.pause_after_ms) } explicit pause(s) "
        f"totalling {total_pause / 1000:.1f}s"
    )
