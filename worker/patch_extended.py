#!/usr/bin/env python3
"""Build-time patch for Chatterbox-TTS-Extended's take-selection logic.

THIRD-PARTY NOTICE
------------------
The match strings in this file are excerpts of Chatterbox-TTS-Extended, taken
verbatim so the edits can locate the code they replace:

    Chatterbox-TTS-Extended — MIT License — Copyright (c) 2025 Resemble AI
    https://github.com/petermg/Chatterbox-TTS-Extended

The MIT licence requires that notice to travel with the excerpted code. Its
full text is reproduced in the NOTICE file at the root of this repository.
Everything else in this file is Narrator's own work under Narrator's licence.

WHY THIS EXISTS
---------------
Extended generates N candidate takes per chunk, transcribes each with Whisper,
and scores it against the source text with difflib.SequenceMatcher. It then
throws the scores away:

    if score >= 0.85:
        chunk_validations[chunk_idx].append((cand['duration'], cand['path']))
    ...
    best_path = sorted(chunk_validations[chunk_idx], key=lambda x: x[0])[0][1]

The score is only a pass/fail gate; among everything that passes, selection is
by SHORTEST DURATION. A take that skips words IS shorter, so the tie-break
actively prefers dropouts. At a 0.85 gate a ~50-word chunk can lose ~8 words
and still pass.

Measured on a real 15-chunk run (narration 8e448db9):

    chunk  1: takes 0.938 / 0.710 / 0.979  ->  shipped 0.938   (9-word dropout)
    chunk 10: takes 0.933 / 0.880 / 0.933  ->  shipped 0.880   (10-word dropout)

5 of 15 chunks discarded a strictly better take. Whisper was right every time;
the selector overrode it. Raising num_candidates makes this WORSE, because each
extra take is another chance to draw a shorter clip that clears 0.85.

Upstream's intent for "shortest" was to avoid trailing hallucinated audio, which
is a genuine Chatterbox failure mode. We keep that intent as a tie-break among
takes whose scores are within an epsilon of the best, rather than as the primary
key.

WHAT THIS CHANGES
-----------------
1. Record the Whisper score alongside duration in chunk_validations.
2. Select the highest-scoring take; break near-ties by shortest duration.
3. Make both gates configurable, defaulting the first pass to 0.95 (was 0.85)
   so word-dropping takes are classified as failures and enter the repair pass
   instead of being shipped.

Nothing here can make generation fail: a chunk with no passing take still falls
back to the best available candidate, so a narration is always produced.

The upstream commit is pinned in the Dockerfile, and every edit below asserts
its exact expected match count. If upstream drifts, the build fails loudly
rather than silently producing unpatched audio.
"""

import os
import sys

CONST_ANCHOR = "from concurrent.futures import ThreadPoolExecutor, as_completed\n"

CONST_BLOCK = '''
# --- Narrator patch: quality gate + best-take selection (patch_extended.py) --
import os as _narr_os
# First-pass gate. Upstream 0.85 lets ~15% of a chunk's words go missing.
_NARRATOR_PASS = float(_narr_os.environ.get("NARRATOR_WHISPER_PASS", "0.95"))
# Repair-pass gate, applied to regenerated takes for chunks that failed above.
_NARRATOR_RETRY = float(_narr_os.environ.get("NARRATOR_WHISPER_RETRY_PASS", "0.95"))
# Scores within this much of the best count as tied; shortest then wins, which
# preserves upstream's defence against trailing hallucinated audio.
_NARRATOR_TIE = float(_narr_os.environ.get("NARRATOR_SCORE_TIE_EPS", "0.01"))

# A take is defective when it contains a stretch of audio that is both LONG and
# LOUD while containing no recognised speech. Both conditions are required, and
# the "loud" half is what makes this safe.
#
# Why: the Whisper text score has a blind spot. A take can emit seconds of
# non-speech babble and still score 1.000, because the score compares
# TRANSCRIPTS and babble transcribes to nothing. Measured on a real narration the
# offending region peaked at -17.4 dBFS against median speech of -17.9 dBFS --
# as loud as the voice itself, so no gate or denoiser can remove it afterwards.
#
# Why loudness and not just duration: duration alone would also condemn takes
# where the MODEL produced a legitimately long quiet pause, which is exactly the
# phrasing we want to keep. Measured levels in one narration, against -17.9 dBFS
# speech:
#     5.0s growl        -34.0 dBFS   defect
#     2.6s growl        -37.2 dBFS   defect
#     quiet sentence gap -45.4 dBFS  legitimate
#     inserted [pause]  -inf         legitimate, by construction
# Growls sit within ~20 dB of speech; real pauses are far below it. So the test
# is "no speech, long, and not quiet".
#
# This also settles what happens once [pause:Xs] exists: pause tags force a chunk
# boundary and the silence is inserted at ASSEMBLY, so it is never inside a take
# that this check ever sees -- and even if it were, digital silence could not
# satisfy the loudness condition.
_NARRATOR_MAX_GAP = float(_narr_os.environ.get("NARRATOR_MAX_SPEECH_GAP", "1.0"))
# How far below the take's own speech level a non-speech run must be to count as
# a genuine pause rather than an artifact.
_NARRATOR_GAP_QUIET_DB = float(_narr_os.environ.get("NARRATOR_GAP_QUIET_DB", "25"))

# path -> (seconds, dB below that take's speech level) for the worst non-speech
# run. A dict keyed by path rather than an extra return value, so
# whisper_check_mp keeps its 3-tuple contract and neither call site changes.
_NARRATOR_GAPS = {}

# chunk_index -> (score, duration_s, gap_seconds, gap_quiet_db) for the take that
# was actually selected. process_text_for_tts returns only file paths, so without
# this the caller cannot record WHY a chunk turned out the way it did, and the
# only evidence would be container logs that rotate and vanish on suspend.
_NARRATOR_SELECTION = {}

# chunk indices where NO take passed validation and the best failing take was
# shipped instead. Kept separate from _NARRATOR_SELECTION rather than folded into
# it as a flag, so the tuple's shape stays the same for every existing reader.
#
# This exists because "score 0" was previously indistinguishable from "no take
# passed": upstream's fallback branch loads the best failing candidate and returns
# without recording anything, so the caller defaulted to zeros and a genuinely bad
# chunk looked identical to a measurement that never ran. Repair needs to know the
# difference — those are exactly the chunks worth regenerating.
_NARRATOR_UNPASSED = set()


def _narrator_rms_db(samples):
    import numpy as _np
    if samples is None or len(samples) == 0:
        return -120.0
    return float(20.0 * _np.log10(max(float(_np.sqrt(_np.mean(_np.square(samples)))), 1e-10)))


def _narrator_worst_gap(path, segs):
    """Longest non-speech run in `path`, and how far below speech it sits.

    Returns (seconds, db_below_speech). db_below_speech is large for a genuine
    pause and small for babble. Failure returns (0, 99) so a measurement problem
    can never condemn a take.
    """
    try:
        import soundfile as _sf
        import numpy as _np
        data, sr = _sf.read(path, dtype="float32", always_2d=False)
        if getattr(data, "ndim", 1) > 1:
            data = data.mean(axis=1)
        total = len(data) / float(sr)

        spans, prev = [], 0.0
        for s in segs:
            if float(s.start) > prev:
                spans.append((prev, float(s.start)))
            prev = float(s.end)
        if total > prev:
            spans.append((prev, total))
        if not spans:
            return (0.0, 99.0)

        worst = max(spans, key=lambda ab: ab[1] - ab[0])
        speech = _np.concatenate(
            [data[int(float(s.start) * sr):int(float(s.end) * sr)] for s in segs]
        ) if segs else None
        gap_db = _narrator_rms_db(data[int(worst[0] * sr):int(worst[1] * sr)])
        speech_db = _narrator_rms_db(speech)
        return (worst[1] - worst[0], speech_db - gap_db)
    except Exception as exc:
        print(f"[narrator] gap measurement failed for {path}: {exc}")
        return (0.0, 99.0)


class _NarratorCancelled(BaseException):
    """Raised to abort generation when the caller requests cancellation.

    Deliberately derived from BaseException, not Exception: Extended wraps whole
    phases in `except Exception` blocks that log and continue, which would
    swallow a normal exception and let a cancelled job run to completion.
    """


# Set by the worker via adapter.set_progress_callback(). Signature:
#     cb(phase: str, done: int, total: int) -> bool | None
# Returning False requests cancellation. Progress reporting must never be able
# to fail a job, so callback errors are logged and ignored — but a False return
# is honoured, since that is an explicit instruction rather than a fault.
_NARRATOR_PROGRESS_CB = None


def _narrator_progress(phase, done, total):
    cb = _NARRATOR_PROGRESS_CB
    if cb is None:
        return
    try:
        keep_going = cb(phase, done, total)
    except Exception as exc:  # noqa: BLE001 - progress must not break generation
        print(f"[narrator] progress callback failed ({phase} {done}/{total}): {exc}")
        return
    if keep_going is False:
        raise _NarratorCancelled(f"cancelled during {phase} at {done}/{total}")


# Cancellation needs a second, cheaper hook that can be called far more often
# than the progress one. Checking only between completed chunks is not enough:
# every chunk is submitted to the ThreadPoolExecutor up front, so raising from the
# as_completed loop exits the `with` block and shutdown(wait=True) then waits for
# EVERY submitted future. Measured on a 6-chunk job, cancel took 207 seconds; on a
# 15-chunk job it would wait out the entire generation phase. Checking before each
# individual take instead means in-flight chunks abort within one take and
# not-yet-started ones abort immediately.
_NARRATOR_CANCEL_CB = None


def _narrator_check_cancelled():
    cb = _NARRATOR_CANCEL_CB
    if cb is None:
        return
    try:
        stop = cb()
    except Exception as exc:  # noqa: BLE001 - never fail a job over a failed check
        print(f"[narrator] cancel check failed: {exc}")
        return
    if stop:
        raise _NarratorCancelled("cancelled before generating a take")


# ---------------------------------------------------------------------------
'''

# (old, new, expected_count)
EDITS = [
    # 1. Carry the score through, so selection can use it. Two call sites (the
    #    first-pass loop and the repair loop) differ only in indentation, so
    #    match on the call itself.
    (
        ".append((cand['duration'], cand['path']))",
        ".append((score, cand['duration'], cand['path']))",
        2,
    ),
    # 2. Both gates become configurable.
    ("if score >= 0.85:", "if score >= _NARRATOR_PASS:", 1),
    ("if score >= 0.95:", "if score >= _NARRATOR_RETRY:", 1),
    # 3. The actual bug: select on score, not duration.
    (
        "                        best_path = sorted(chunk_validations[chunk_idx], key=lambda x: x[0])[0][1]\n",
        "                        # NARRATOR PATCH: upstream sorted by DURATION and took [0], the\n"
        "                        # shortest clip, which silently prefers takes that SKIP WORDS.\n"
        "                        # Select on Whisper score; use duration only to break near-ties.\n"
        "                        #\n"
        "                        # First discard takes containing a long run of LOUD\n"
        "                        # non-speech. The text score cannot see those: babble\n"
        "                        # transcribes to nothing, so a take with seconds of\n"
        "                        # growling still scores 1.000. Loudness is required as well\n"
        "                        # as length, so a long QUIET pause — the model's own\n"
        "                        # phrasing, which we want — is never treated as a defect.\n"
        "                        # Only discard when a clean alternative exists, so this can\n"
        "                        # never leave a chunk with nothing to ship.\n"
        "                        _passers = chunk_validations[chunk_idx]\n"
        "                        def _narr_ok(p):\n"
        "                            _l, _q = _NARRATOR_GAPS.get(p, (0.0, 99.0))\n"
        "                            return _l <= _NARRATOR_MAX_GAP or _q >= _NARRATOR_GAP_QUIET_DB\n"
        "                        _clean = [t for t in _passers if _narr_ok(t[2])]\n"
        "                        if _clean and len(_clean) < len(_passers):\n"
        '                            print(f"[narrator] chunk {chunk_idx}: dropped "\n'
        '                                  f"{len(_passers) - len(_clean)} take(s) for loud "\n'
        '                                  f"non-speech runs")\n'
        "                        _pool = _clean or _passers\n"
        "                        _top = max(s for s, _d, _p in _pool)\n"
        "                        _tied = [(d, p) for s, d, p in _pool if s >= _top - _NARRATOR_TIE]\n"
        "                        best_path = min(_tied, key=lambda x: x[0])[1]\n"
        "                        _chosen_d = min(_tied, key=lambda x: x[0])[0]\n"
        "                        _chosen_g = _NARRATOR_GAPS.get(best_path, (0.0, 99.0))\n"
        "                        _NARRATOR_SELECTION[chunk_idx] = (\n"
        "                            _top, _chosen_d, _chosen_g[0], _chosen_g[1])\n"
        "                        print(f\"[narrator] chunk {chunk_idx}: chose score={_top:.3f} \"\n"
        "                              f\"dur={_chosen_d:.2f}s gap={_chosen_g[0]:.1f}s/{_chosen_g[1]:.0f}dB \"\n"
        "                              f\"from {[(round(s, 3), round(d, 2), _NARRATOR_GAPS.get(p, (0.0, 99.0))) for s, d, p in _passers]}\")\n",
        1,
    ),
    # 4. Progress + cancellation during chunk generation. This is the parallel
    #    branch, which is the live path on CUDA (parallel_workers defaults to 4),
    #    and it already tracks completed/total_chunks for its own log line.
    #    Raising here exits the ThreadPoolExecutor context, which waits for the
    #    few in-flight chunks before propagating — so cancellation lands within
    #    roughly one chunk rather than instantly. That is the honest trade for
    #    not hard-killing a process mid-write.
    (
        '                    print(f"\\033[36m[PROGRESS] Generated chunk {completed}/{total_chunks} ({percent}%)\\033[0m")\n',
        '                    print(f"\\033[36m[PROGRESS] Generated chunk {completed}/{total_chunks} ({percent}%)\\033[0m")\n'
        '                    _narrator_progress("GENERATING", completed, total_chunks)\n',
        1,
    ),
    # 5. Same for the sequential branch, so behaviour does not silently change if
    #    parallelism is ever turned off (e.g. running on CPU).
    (
        "                chunk_candidate_map[idx] = candidates\n"
        "\n"
        "        # -------- WHISPER VALIDATION --------\n",
        "                chunk_candidate_map[idx] = candidates\n"
        '                _narrator_progress("GENERATING", idx + 1, len(sentence_groups))\n'
        "\n"
        "        # -------- WHISPER VALIDATION --------\n",
        1,
    ),
    # 6. Progress + cancellation during Whisper validation. This phase is a
    #    meaningful fraction of the wall time (one transcription per take), and
    #    it is where cancellation responds fastest, since each step is short.
    (
        "                # Initial sequential Whisper validation\n"
        "                for chunk_idx, cand in all_candidates:\n"
        "                    candidate_path = cand['path']\n",
        "                # Initial sequential Whisper validation\n"
        "                _narrator_checked = 0\n"
        "                for chunk_idx, cand in all_candidates:\n"
        "                    _narrator_checked += 1\n"
        '                    _narrator_progress("CHECKING", _narrator_checked, len(all_candidates))\n'
        "                    candidate_path = cand['path']\n",
        1,
    ),
    # 7. Per-take cancellation check. Both generation helpers have an identical
    #    candidate/attempt loop, so this patches each of them. This is what makes
    #    cancel land in seconds rather than at the end of the generation phase.
    (
        "                candidate_seed = derive_seed(this_seed, idx, cand_idx, attempt)\n",
        "                _narrator_check_cancelled()\n"
        "                candidate_seed = derive_seed(this_seed, idx, cand_idx, attempt)\n",
        2,
    ),
    # 8. Measure the largest internal non-speech gap while transcribing. The
    #    segment timestamps are already computed and were being discarded.
    (
        '            transcribed = "".join([seg.text for seg in segments]).strip().lower()\n',
        "            _narr_segs = list(segments)\n"
        '            transcribed = "".join([seg.text for seg in _narr_segs]).strip().lower()\n'
        "            # Worst non-speech run: how long, and how far below this take's own\n"
        "            # speech level. Both are needed — a long QUIET run is a legitimate\n"
        "            # pause, a long LOUD one is babble the text score cannot see.\n"
        "            _narr_g_len, _narr_g_quiet = _narrator_worst_gap(candidate_path, _narr_segs)\n"
        "            _NARRATOR_GAPS[candidate_path] = (_narr_g_len, _narr_g_quiet)\n"
        "            if _narr_g_len > _NARRATOR_MAX_GAP and _narr_g_quiet < _NARRATOR_GAP_QUIET_DB:\n"
        '                print(f"[narrator] {os.path.basename(candidate_path)}: "\n'
        '                      f"{_narr_g_len:.1f}s of loud non-speech "\n'
        '                      f"({_narr_g_quiet:.0f} dB under speech) — artifact")\n',
        1,
    ),
    # 9. Keep Whisper resident across calls.
    #
    #    Extended loads Whisper inside process_text_for_tts and deletes it at the
    #    end. That was invisible when a whole narration was one call, but per-chunk
    #    jobs make it one load per chunk: measured ~11.8s each, 213s of pure
    #    overhead on an 18-chunk narration whose generation took 580s.
    #
    #    Cached by (model, backend, device) so a config change still reloads.
    (
        "def load_whisper_backend(model_name, use_faster_whisper, device):\n",
        "_NARRATOR_WHISPER_CACHE = {}\n"
        "\n"
        "\n"
        "def load_whisper_backend(model_name, use_faster_whisper, device):\n"
        "    # NARRATOR PATCH: reuse an already-loaded model.\n"
        "    _narr_key = (model_name, bool(use_faster_whisper), device)\n"
        "    _narr_hit = _NARRATOR_WHISPER_CACHE.get(_narr_key)\n"
        "    if _narr_hit is not None:\n"
        '        print(f"[narrator] reusing resident Whisper {_narr_key}")\n'
        "        return _narr_hit\n"
        "    _narr_m = _narrator_load_whisper_uncached(model_name, use_faster_whisper, device)\n"
        "    _NARRATOR_WHISPER_CACHE[_narr_key] = _narr_m\n"
        "    return _narr_m\n"
        "\n"
        "\n"
        "def _narrator_load_whisper_uncached(model_name, use_faster_whisper, device):\n",
        1,
    ),
    # 10. Do not delete the model we now cache. Freeing the CUDA cache between
    #     phases is still worth doing.
    (
        "                    del whisper_model\n"
        "                    if torch.cuda.is_available():\n"
        "                        torch.cuda.empty_cache()\n"
        "                    gc.collect()\n"
        '                    print("\\033[32m[DEBUG] Whisper model deleted and VRAM cache cleared.\\033[0m")\n',
        "                    # NARRATOR PATCH: the model is cached and reused, so dropping\n"
        "                    # this reference would force a reload on the next chunk.\n"
        "                    if torch.cuda.is_available():\n"
        "                        torch.cuda.empty_cache()\n"
        "                    gc.collect()\n"
        '                    print("[narrator] kept Whisper resident; cleared CUDA cache")\n',
        1,
    ),
    # 11. Record the "nothing passed" fallback.
    #
    #     Upstream picks the best FAILING take here and ships it without recording
    #     anything, so a chunk that no take could validate arrived at the caller
    #     indistinguishable from a chunk whose metrics were never measured — both
    #     surfaced as score 0.0. That is the one case a human most needs to see,
    #     and it is also precisely the input per-chunk repair needs.
    #
    #     The selection is recorded with the real (failing) score, and the chunk
    #     index is added to _NARRATOR_UNPASSED so the caller can tell "0.91, failed"
    #     apart from "not measured".
    (
        "                            best_failed = max(chunk_failed_candidates[chunk_idx], key=lambda x: x[0])\n",
        "                            best_failed = max(chunk_failed_candidates[chunk_idx], key=lambda x: x[0])\n"
        "                            _NARRATOR_UNPASSED.add(chunk_idx)\n"
        "                            _narr_g = _NARRATOR_GAPS.get(best_failed[1], (0.0, 99.0))\n"
        "                            _NARRATOR_SELECTION[chunk_idx] = (\n"
        "                                float(best_failed[0]), 0.0, _narr_g[0], _narr_g[1])\n",
        1,
    ),
    # 12. Canonicalise numbers before comparing script to transcript.
    #
    #     Whisper writes spoken numbers as digits, so a script that spells them out
    #     mismatches its own correct audio: "one hundred sixty five million" against
    #     "165 million" scores 0.70 on a take that said every word. Observed as a
    #     reproducible 0.921 on real content — identical across two runs with
    #     different seeds and different exaggeration, which is what proved it was
    #     deterministic rather than a generation defect. It cost three wasted takes
    #     plus a retry on every run.
    #
    #     Both sides go through the same function, so any incidental mangling
    #     ("one of a set" -> "1 of a set") is symmetric and harmless. Decimals are
    #     protected across punctuation stripping, which would otherwise turn "1.2"
    #     into "12" and make 1.2 million canonicalise to twelve million.
    (
        "def normalize_for_compare_all_punct(text):\n"
        "    text = re.sub(r'[\u2013\u2014-]', ' ', text)\n"
        '    text = re.sub(rf"[{re.escape(string.punctuation)}]", \'\', text)\n'
        "    text = re.sub(r'\\s+', ' ', text)\n"
        "    return text.lower().strip()\n",
        "def normalize_for_compare_all_punct(text):\n"
        "    text = narrator_protect_decimals(text)\n"
        "    text = re.sub(r'[\u2013\u2014-]', ' ', text)\n"
        '    text = re.sub(rf"[{re.escape(string.punctuation)}]", \'\', text)\n'
        "    text = re.sub(r'\\s+', ' ', text)\n"
        "    text = narrator_restore_decimals(text.lower().strip())\n"
        "    return narrator_canon_numbers(text)\n",
        1,
    ),
    # 13. Numbers must match EXACTLY, alongside the fuzzy text score.
    #
    #     Edit 12 canonicalises numbers so a spoken form matches a digit form. That
    #     fixes the false failure but creates a false PASS: canonical numbers are
    #     compact, so "265000000" against "165000000" differs by one character in
    #     several hundred and a take that misread a figure scores 0.996. Measured.
    #
    #     A misread number is the worst possible defect in a narration about data —
    #     it is confident, plausible and invisible. So numbers are compared as an
    #     ordered list, exactly, and a mismatch caps the score below any usable
    #     threshold. Capped rather than zeroed so the "best failing take" fallback
    #     can still rank candidates meaningfully.
    (
        "        score = difflib.SequenceMatcher(\n"
        "            None,\n"
        "            normalize_for_compare_all_punct(transcribed),\n"
        "            normalize_for_compare_all_punct(target_text.strip().lower())\n"
        "        ).ratio()\n",
        "        _narr_a = normalize_for_compare_all_punct(transcribed)\n"
        "        _narr_b = normalize_for_compare_all_punct(target_text.strip().lower())\n"
        "        score = difflib.SequenceMatcher(None, _narr_a, _narr_b).ratio()\n"
        "        _narr_na, _narr_nb = narrator_numbers(_narr_a), narrator_numbers(_narr_b)\n"
        "        if _narr_na != _narr_nb:\n"
        "            score = min(score, 0.5)\n"
        '            print(f"[narrator] number mismatch: said {_narr_na}, script has "\n'
        '                  f"{_narr_nb} — capping score at {score:.3f}")\n',
        1,
    ),
]

def _apply(path: str, edits, const_block: str = "", sentinel: str = "") -> int:
    """Apply exact-match edits to one file, asserting every occurrence count."""
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()

    if sentinel and sentinel in src:
        print(f"[patch_extended] {path} already patched; nothing to do.")
        return 0

    if const_block:
        if src.count(CONST_ANCHOR) != 1:
            print(
                f"[patch_extended] FATAL: import anchor found "
                f"{src.count(CONST_ANCHOR)} times in {path}, expected exactly 1. "
                f"Upstream has drifted from the pinned commit.",
                file=sys.stderr,
            )
            return 1
        src = src.replace(CONST_ANCHOR, CONST_ANCHOR + const_block, 1)

    for old, new, expected in edits:
        found = src.count(old)
        if found != expected:
            print(
                f"[patch_extended] FATAL: expected {expected} occurrence(s) of\n"
                f"    {old.strip()[:90]}\n"
                f"  but found {found} in {path}. Upstream has drifted from the "
                f"pinned commit.",
                file=sys.stderr,
            )
            return 1
        src = src.replace(old, new)
        print(f"[patch_extended] applied ({found}x): {old.strip()[:70]}")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)

    # Fail the build on a syntax error rather than at the first generation.
    import py_compile

    try:
        py_compile.compile(path, doraise=True)
    except py_compile.PyCompileError as exc:
        print(f"[patch_extended] FATAL: {path} does not compile:\n{exc}", file=sys.stderr)
        return 1

    print(f"[patch_extended] OK: {path} patched and compiles.")
    return 0


def _numnorm_source() -> str:
    """The number canonicaliser, read from numnorm.py at build time.

    Injected into Chatter.py rather than imported, so the patched file has no new
    import dependency and cannot break on sys.path differences between the build
    container and the runtime container. Read from the file rather than duplicated
    here so there is one source of truth and the unit tests exercise exactly the
    code that ships.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "numnorm.py"), encoding="utf-8") as fh:
        src = fh.read()
    # Strip the module docstring and __future__ import: the destination already has
    # its own, and a __future__ import is only legal at the top of a file.
    src = src.replace("from __future__ import annotations\n", "")
    return "\n# --- injected from numnorm.py ---\n" + src


def main(root: str) -> int:
    """Patch Chatter.py.

    Accepts either the Extended root directory or a direct path to Chatter.py.

    An earlier revision also patched the vendored model's generate_batch() to
    produce takes in one batched pass. That was removed rather than left disabled:
    generate_batch is unfinished upstream (its CFG duplication uses a block layout
    while the embedding path assumes an interleaved one, and a branch meant to
    expand the conditioning batch is an empty `pass`), so making it work means
    rewriting classifier-free guidance in core model code with nothing to validate
    against. Carrying dead code that can never run is worse than not having it.
    """
    chatter = os.path.join(root, "Chatter.py") if os.path.isdir(root) else root
    return _apply(
        chatter, EDITS, CONST_BLOCK + _numnorm_source(), sentinel="_NARRATOR_PASS"
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/opt/extended"))
