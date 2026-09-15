"""
Narrator adapter over Chatterbox-TTS-Extended.

This is the ONLY code that touches audio, and it is deliberately thin: it calls
Extended's pipeline functions directly, so the upstream diff is zero and there
is no fork to maintain.

Two upstream behaviours this module exists to contain:

1. Importing Chatter runs get_or_load_model() at module scope inside a
   try/except that only PRINTS on failure. So a failed model load looks like a
   successful import. ensure_model() below verifies explicitly.

2. Extended resolves ./temp and ./output relative to the CWD, and WIPES ./temp
   on every generation call. So the working directory is pinned here, and the
   pipeline is single-worker by construction.
"""
from __future__ import annotations

import math
import os
import subprocess
import sys
import wave
from dataclasses import dataclass, asdict
from typing import Optional

# Pin CWD before importing Chatter: its module-level setup and its per-call
# temp handling are both CWD-relative.
#
# EXTENDED_DIR also has to go on sys.path explicitly. os.chdir does NOT make a
# directory importable — sys.path[0] is the *script's* directory, so `import
# Chatter` only resolved before because the process happened to be launched from
# inside the Extended tree. Adding it here means the import works from any CWD
# and under any launcher, rather than depending on that coincidence.
EXTENDED_DIR = os.environ.get("EXTENDED_DIR", "/opt/extended")
if os.path.isdir(EXTENDED_DIR):
    os.chdir(EXTENDED_DIR)
    if EXTENDED_DIR not in sys.path:
        sys.path.insert(0, EXTENDED_DIR)

import numpy as np  # noqa: E402

# NOTE: this import loads the TTS model. It is slow and it is not safe to treat
# as free. The worker should import this module once, at startup.
import Chatter  # noqa: E402


# ---------------------------------------------------------------------------
# Model lifecycle
# ---------------------------------------------------------------------------

def device() -> str:
    """'cuda' on the A10G, 'mps' on Apple Silicon, else 'cpu'. Extended
    auto-detects; we only report it."""
    return Chatter.DEVICE


# --- Progress reporting and cancellation ------------------------------------
#
# Extended's process_text_for_tts() is one blocking call that internally loops
# over every chunk, so there is no natural place for a caller to observe progress
# or to bail out. patch_extended.py injects a hook into three points of that loop
# (parallel generation, sequential generation, Whisper validation); this is the
# public way to attach to it.


class Cancelled(BaseException):
    """Alias for the exception the patched Chatter raises on cancellation.

    Re-exported so worker.py can catch cancellation without reaching into
    Chatter's private names. Derived from BaseException for the reason given in
    patch_extended.py: Extended's broad `except Exception` blocks would otherwise
    swallow it and let a cancelled job finish.
    """


def _resolve_cancelled_type() -> type:
    """The patched Chatter defines the real exception; fall back if unpatched.

    An unpatched Chatter (local dev against a fresh clone) has no hook at all, in
    which case nothing can raise and the alias is never needed.
    """
    return getattr(Chatter, "_NarratorCancelled", Cancelled)


CANCELLED_EXCEPTION = _resolve_cancelled_type()


def set_progress_callback(cb, cancel_cb=None) -> bool:
    """Register progress and cancellation callbacks. Returns False if unsupported.

    `cb(phase, done, total)` is called when a chunk finishes and after each
    Whisper check; returning False from it requests cancellation.

    `cancel_cb()` is called before EVERY take and should return True to abort. It
    exists separately because chunk-completion granularity is far too coarse:
    every chunk is submitted to the thread pool up front, so aborting from the
    completion loop still waits for all of them (measured: 207s on a 6-chunk job).
    It must be cheap — no I/O.

    A False return means Chatter was not patched, which is worth surfacing rather
    than failing on: generation still works, without progress or cancellation.
    """
    if not hasattr(Chatter, "_narrator_progress"):
        return False
    Chatter._NARRATOR_PROGRESS_CB = cb
    if hasattr(Chatter, "_narrator_check_cancelled"):
        Chatter._NARRATOR_CANCEL_CB = cancel_cb
    return True


def clear_progress_callback() -> None:
    """Detach callbacks so a finished job cannot keep reporting or be cancelled."""
    if hasattr(Chatter, "_NARRATOR_PROGRESS_CB"):
        Chatter._NARRATOR_PROGRESS_CB = None
    if hasattr(Chatter, "_NARRATOR_CANCEL_CB"):
        Chatter._NARRATOR_CANCEL_CB = None


def ensure_model():
    """Load and verify the TTS model.

    Chatter's import-time load swallows exceptions, so callers must not assume
    a successful import means a usable model. Raises if the model is absent.
    """
    model = Chatter.get_or_load_model()
    if model is None:
        raise RuntimeError(
            "Chatterbox model failed to load. Chatter's import-time loader only "
            "prints on failure, so check container logs for the original error."
        )
    return model


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


# Quality-vs-throughput knobs, settable per deployment without a rebuild.
#
# These are NOT retries-on-failure. Extended's generation loop is
#     for cand in range(num_candidates):
#         for attempt in range(max_attempts):
#             generate()
#             if bypass_whisper_checking: break
# so with Whisper validation ENABLED there is no early break and the cost is
# num_candidates * max_attempts full generations, unconditionally. Upstream's
# 3 x 3 therefore means NINE generations per chunk plus nine transcriptions.
#
# Measured on an A10G: nine takes of one 13.8s chunk, wall 186s, RTF 14.3. Scores
# were 0.978 0.980 0.818 0.978 0.978 0.978 0.978 0.978 0.973 — eight clustered
# tightly but ONE was materially degraded (0.818), so roughly 11% of takes are bad
# and Whisper selection genuinely earns its keep. Nine is still wasteful: the
# marginal value collapses long before the ninth
# take. But defects are per-take and independent, and a narration is only as
# good as its worst chunk, so the risk compounds with script length: across the
# ~19 chunks of a five-minute script, one take per chunk leaves only a ~11%
# chance the whole thing is clean, while three takes raises that to ~97.5%.
# Protection then saturates while cost stays linear, which is why the fallback is
# three. In normal operation this is overridden per narration by
# NARRATIONS.takes_per_chunk; these apply only when that value is missing.
DEFAULT_NUM_CANDIDATES = _env_int("NARRATOR_NUM_CANDIDATES", 3)

# max_attempts is OVERLOADED in Extended, which makes it a trap:
#
#   1. It multiplies up-front generation. The loop is
#          for cand in range(num_candidates):
#              for attempt in range(max_attempts):
#                  generate()
#      with no early break while Whisper validation is on, so the real cost is
#      num_candidates * max_attempts takes for EVERY chunk. Measured: raising it
#      to 3 turned a 282s narration into 14+ minutes.
#   2. It also bounds the repair rounds Extended runs for chunks where no
#      candidate passed the Whisper gate.
#
# There is no way to buy (2) without paying (1) on every chunk, and paying 3x
# everywhere to repair the ~2 chunks in 15 that need it is a bad trade. So it
# stays at 1, and repair is handled by selection instead:
#
# With repair disabled and use_longest_transcript_on_fail=False, the gate value
# stops mattering at all — passers are ranked by score, and if nothing passes the
# fallback also ranks by score. Both branches therefore return the highest-scoring
# take, which is exactly the behaviour we want and what patch_extended.py makes
# possible. The gate only becomes meaningful again if repair is deliberately
# turned on later.
#
# A true per-chunk repair loop — regenerating ONLY the failed chunks instead of
# multiplying all of them — is the right long-term fix and is tracked separately.
DEFAULT_MAX_ATTEMPTS = _env_int("NARRATOR_MAX_ATTEMPTS", 1)

# Whisper size used to validate takes. "medium" is what every measurement in
# this file was taken with; changing it changes the score distribution and so
# the meaning of the pass threshold.
DEFAULT_WHISPER_MODEL = os.environ.get("NARRATOR_WHISPER_MODEL", "medium")


def generate_narration(
    script_text: str,
    ref_wav_path: str,
    base_seed: int,
    *,
    output_basename: str = "narration",
    export_format: str = "mp3",
    num_candidates: int = DEFAULT_NUM_CANDIDATES,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    validate_with_whisper: Optional[bool] = None,
    whisper_model: str = DEFAULT_WHISPER_MODEL,
    parallel_workers: int = 4,
    exaggeration: float = 0.5,
    temperature: float = 0.8,
    cfg_weight: float = 0.5,
) -> list[str]:
    """Generate one narration from a whole script. Returns output file paths.

    Extended handles chunking to Chatterbox's ~300-char generation limit,
    per-chunk candidate generation, Whisper validation of each candidate against
    the intended text, retries, and concatenation. We pass the script through
    verbatim — no directives, no segmentation of our own.

    `base_seed` feeds Extended's derive_seed(base, chunk, cand, attempt), so the
    same seed should reproduce the same audio. Verified on CUDA only: Chatter's
    set_seed() seeds the CUDA RNG but never calls torch.mps.manual_seed, so
    reproducibility does NOT hold on Apple Silicon.

    `validate_with_whisper` defaults to "only where it can actually run".
    faster-whisper is CTranslate2-based and supports CPU and CUDA but NOT MPS,
    and Chatter passes its global DEVICE straight through to the whisper loader —
    so on Apple Silicon the validation pass raises rather than degrading. Rather
    than fail a whole generation for a quality check, it is skipped off CUDA and
    the loss is logged.

    `parallel_workers` and `num_candidates` are both forced to 1 off CUDA; see
    the comments at the clamp below for why.
    """
    if not script_text or not script_text.strip():
        raise ValueError("script_text is empty")
    if not os.path.exists(ref_wav_path):
        raise FileNotFoundError(f"reference clip not found: {ref_wav_path}")

    ensure_model()

    if validate_with_whisper is None:
        validate_with_whisper = device() == "cuda"
        if not validate_with_whisper:
            print(
                f"[adapter] Whisper candidate validation DISABLED on device="
                f"{device()}: faster-whisper (CTranslate2) supports only CPU and "
                "CUDA. Generated audio will not be transcript-checked, so dropped "
                "or hallucinated words will not be caught automatically.",
                flush=True,
            )

    # Off CUDA, force single-threaded, single-candidate generation.
    #
    # parallel_workers: Extended fans chunks out over a ThreadPoolExecutor, and
    # every thread drives the SAME global MPS device. PyTorch funnels MPS work
    # through one serial dispatch queue, but Apple's AGX Metal driver is not safe
    # against that interleaving: with two chunks in flight we took a hard SIGSEGV
    # inside setComputePipelineState: called from masked_fill__mps — one thread
    # encoding while the other waited on the queue. That is a native crash, so it
    # kills the process outright with no Python traceback and no chance to fail
    # the job cleanly. One worker means one encoder and no race.
    #
    # num_candidates: candidates exist so Whisper can pick the take that best
    # matches the transcript. With validation off there is no scoring function, so
    # the extras are generated and then discarded. Extended's bypass short-circuit
    # (`if bypass_whisper_checking: break`) only exits the inner *attempt* loop,
    # not the candidate loop, so it does not save the work — we have to ask for
    # one. This is a straight ~3x speedup at zero quality cost, and it matches the
    # measured RTF of 26.3 versus ~8.8 per candidate.
    if device() != "cuda":
        if parallel_workers != 1:
            print(
                f"[adapter] parallel_workers {parallel_workers} -> 1 on device="
                f"{device()}: concurrent MPS encoding segfaults in the Metal driver.",
                flush=True,
            )
            parallel_workers = 1
        if not validate_with_whisper and num_candidates != 1:
            print(
                f"[adapter] num_candidates {num_candidates} -> 1: without Whisper "
                "validation there is nothing to choose between candidates, so the "
                "extras would be generated and thrown away.",
                flush=True,
            )
            num_candidates = 1

    produced = Chatter.process_text_for_tts(
        text=script_text,
        input_basename=output_basename,
        audio_prompt_path_input=ref_wav_path,
        # These three drive how closely the output resembles the reference.
        # exaggeration: 0 flat / 1 normal / 2 exaggerated.
        # temperature:  lower is steadier and more faithful.
        # cfg_weight:   PACING, per Resemble's own guidance — not a similarity
        #               control. Lower (~0.3) gives slower, more deliberate
        #               delivery and is recommended when the reference speaker
        #               talks fast. It also compensates for exaggeration, which
        #               speeds speech up, so the two are usually moved together.
        exaggeration_input=exaggeration,
        temperature_input=temperature,
        seed_num_input=base_seed,
        cfgw_input=cfg_weight,
        # Extended's own denoiser stays OFF because it does not work in this
        # image: pyrnnoise 0.3.8 is installed but its import raises (audiolab
        # 0.5.2 dropped the `AudioGraph` symbol it wants), and Extended swallows
        # that into _PYRNNOISE_AVAILABLE = False. Setting this True therefore
        # logged "pyrnnoise not installed; skipping denoise" and silently did
        # nothing. We denoise with ffmpeg afftdn after generation instead — see
        # _denoise_in_place.
        use_pyrnnoise=False,
        # Auto-editor stays OFF for now, deliberately. It removes artifacts by
        # cutting near-silence, so today it would eat the very pauses we want to
        # keep. It becomes safe once [pause:Xs] inserts silence in OUR layer,
        # AFTER generation: auto-editor then only ever runs inside a speech block
        # and cannot touch an inserted pause. That is precisely the failure mode
        # reported by users who added pause tags and then lost them to cleanup.
        use_auto_editor=AUTO_EDITOR_ENABLED,
        ae_threshold=AUTO_EDITOR_THRESHOLD,
        ae_margin=AUTO_EDITOR_MARGIN,
        export_formats=[export_format],
        enable_batching=True,
        to_lowercase=False,
        normalize_spacing=True,
        fix_dot_letters=True,
        remove_reference_numbers=False,
        keep_original_wav=False,
        smart_batch_short_sentences=True,
        disable_watermark=True,
        num_generations=1,
        normalize_audio=True,
        normalize_method="ebu",
        normalize_level=-18,            # broadcast-ish target for narration
        normalize_tp=-1,                # true-peak ceiling
        normalize_lra=11,
        num_candidates_per_chunk=num_candidates,
        max_attempts_per_candidate=max_attempts,
        bypass_whisper_checking=not validate_with_whisper,
        whisper_model_name=whisper_model,
        enable_parallel=parallel_workers > 1,
        num_parallel_workers=parallel_workers,
        # Last-resort rule for a chunk that failed every take AND every repair
        # round. Either way a chunk is always emitted, so this cannot turn a
        # narration into a failure — it only decides WHICH imperfect take ships.
        #
        # False picks the highest-scoring take. True picks the one with the
        # LONGEST transcript, which is the wrong proxy here: hallucinated babble
        # transcribes to lots of words and would beat a clean take that merely
        # clipped one word. Score is measured against the actual script, so it is
        # the honest ordering.
        use_longest_transcript_on_fail=False,
        sound_words_field="",
        use_faster_whisper=True,
    )

    return [_denoise_in_place(p) for p in (produced or [])]


# Silence the vocoder's inter-speech artifacts. Off by env if it ever sounds worse.
# auto-editor: cut silence inside generated chunks.
#
# Now SAFE to use, which it was not before: pauses are inserted by our own assembly
# step from generated digital silence, so auto-editor runs only over chunk audio and
# cannot eat a deliberate pause. That was the blocker.
#
# Default OFF anyway, because it is not free. auto-editor cuts EVERY run below its
# threshold, which includes the model's own quiet phrasing between clauses — the
# breaths and beats that make an exaggeration of 0.5 sound like a person rather than
# a reader. Turning it on tightens tempo everywhere as a side effect of removing the
# hiss that sits in those same gaps, and tempo is the thing that took the longest to
# tune here. The gate in DENOISE_FILTER already attenuates that hiss without moving
# anything in time.
#
# Env-driven rather than compiled in, so it can be tried with a spec edit and an
# ALTER SERVICE instead of an image rebuild.
AUTO_EDITOR_ENABLED = os.environ.get("NARRATOR_AUTO_EDITOR", "0") == "1"
# Loudness below which a run counts as silence, as a fraction of full scale. 0.06 is
# upstream's default and roughly -24 dBFS.
AUTO_EDITOR_THRESHOLD = float(os.environ.get("NARRATOR_AE_THRESHOLD", "0.06"))
# Seconds of audio kept either side of retained speech. Without a margin the cuts
# land hard against consonants and clip their attack.
AUTO_EDITOR_MARGIN = float(os.environ.get("NARRATOR_AE_MARGIN", "0.2"))

DENOISE_ENABLED = os.environ.get("NARRATOR_DENOISE", "1") == "1"
# A NOISE GATE, not a denoiser — and that distinction was established by
# measurement, not assumption. Measured on a real 242s narration, against the 24
# loud-non-speech regions located by transcript-gap analysis:
#
#   filter                          noise    speech   3 worst regions
#   (none)                          -41.6    -17.9    -37.4
#   afftdn=nr=12:nf=-40:tn=1        -42.4    -17.9    -37.4   <-- 0.8 dB, useless
#   agate threshold=0.0316          -58.2    -17.9    -46.3   <-- 16.6 dB
#   agate threshold=0.0562          -61.9    -17.9    -52.5
#   afftdn + agate                  -59.7    -17.9    -46.8   <-- afftdn adds ~0
#
# Spectral denoising did essentially nothing because these artifacts are not a
# stationary hiss: at -34 dBFS against -18 dBFS speech they sit only 16 dB down
# and are structured, speech-like babble, so afftdn classifies them as signal.
# Gating by level is the mechanism that matches the defect.
#
# threshold 0.0316 is -30 dBFS, comfortably below speech and above the artifacts.
# release=250ms keeps the gate open through natural word tails and breaths rather
# than chattering; attack=5ms costs nothing audible on onsets. The more aggressive
# -25 dBFS variant measures better but risks clipping soft speech, which no metric
# here can detect — so the conservative one is the default and this is tunable
# without a rebuild.
DENOISE_FILTER = os.environ.get(
    "NARRATOR_DENOISE_FILTER", "agate=threshold=0.0316:ratio=9:attack=5:release=250"
)


def _denoise_in_place(path: str) -> str:
    """Denoise one produced file, returning the path to use.

    Why this exists rather than Extended's use_pyrnnoise flag: pyrnnoise 0.3.8 is
    installed in the image but CANNOT be imported — it needs an `AudioGraph`
    symbol that audiolab 0.5.2 no longer exports. Extended catches that at import
    and silently sets _PYRNNOISE_AVAILABLE = False, so enabling the flag logged
    "pyrnnoise not installed; skipping denoise" and did nothing at all. The
    dependency is unpinned upstream, so pinning audiolab is a moving target.

    ffmpeg is already a hard requirement and ships afftdn, anlmdn, arnndn and
    agate, so the capability is there without touching Python dependencies.
    afftdn is chosen over arnndn because arnndn needs a model file we would have
    to vendor, and the target here is a stationary noise floor, which is exactly
    what spectral subtraction handles well.

    A failure here returns the original file rather than raising: a slightly
    hissy narration beats no narration.
    """
    if not DENOISE_ENABLED or not path or not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    out = f"{stem}.dn{ext}"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", path, "-af", DENOISE_FILTER,
    ]
    # Keep MP3 output as MP3 at a transparent-enough rate; anything else is
    # written back in its own container by letting ffmpeg infer from the suffix.
    if ext.lower() == ".mp3":
        cmd += ["-codec:a", "libmp3lame", "-q:a", "2"]
    cmd.append(out)
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if res.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < 1024:
            print(
                f"[adapter] denoise failed for {os.path.basename(path)} "
                f"(rc={res.returncode}): {res.stderr.strip()[:200]}",
                flush=True,
            )
            return path
        print(
            f"[adapter] denoised {os.path.basename(path)} with '{DENOISE_FILTER}'",
            flush=True,
        )
        return out
    except Exception as exc:  # noqa: BLE001 - never fail a job over post-processing
        print(f"[adapter] denoise error for {os.path.basename(path)}: {exc}", flush=True)
        return path


# --- Assembly constants -----------------------------------------------------
# Loudness target for the finished narration, applied ONCE over the joined audio.
NORMALIZE_I = float(os.environ.get("NARRATOR_LOUDNORM_I", "-18"))
NORMALIZE_TP = float(os.environ.get("NARRATOR_LOUDNORM_TP", "-1"))
NORMALIZE_LRA = float(os.environ.get("NARRATOR_LOUDNORM_LRA", "11"))
# Fade applied at both ends of every chunk before concatenation. Long enough to
# remove a step discontinuity at a non-zero crossing, short enough to be
# inaudible against speech.
ASSEMBLY_FADE_S = float(os.environ.get("NARRATOR_ASSEMBLY_FADE_S", "0.008"))


def _model_sample_rate() -> int:
    """Sample rate of generated chunks; inserted silence must match it exactly."""
    try:
        return int(Chatter.MODEL.sr)
    except Exception:
        return int(os.environ.get("NARRATOR_ASSEMBLY_RATE", "24000"))


# ---------------------------------------------------------------------------
# Per-chunk generation and assembly
# ---------------------------------------------------------------------------

def chunk_text(segment: str) -> list:
    """Split one segment of prose into chunks using Extended's own grouper.

    Exposed so the planner never reimplements chunking. Verified byte-identical
    to the single-job path on a real 18-chunk script; a second implementation
    would drift with nothing to catch it.
    """
    sentences = Chatter.split_into_sentences(segment)
    return Chatter.group_sentences(sentences, max_chars=300)


@dataclass
class ChunkResult:
    path: str
    duration_ms: int
    score: float
    gap_seconds: float
    gap_quiet_db: float
    # False when NO take passed Whisper validation and the best failing take was
    # shipped. Distinct from a low score: a chunk can score 0.94 and still be the
    # best of three, which is a different situation from one that passed at 0.94.
    # This is the signal per-chunk repair keys on.
    passed: bool = True
    # True when the patched selection recorded nothing at all, i.e. the metrics are
    # unknown rather than bad. Kept separate so an instrumentation failure is never
    # mistaken for a quality failure.
    measured: bool = True


def generate_chunk(
    *,
    text: str,
    ref_wav_path: str,
    base_seed: int,
    output_basename: str,
    num_candidates: int,
    exaggeration: float,
    temperature: float,
    cfg_weight: float,
) -> ChunkResult:
    """Generate ONE chunk and return its audio plus why that take was chosen.

    Deliberately routed through the same process_text_for_tts as the whole-script
    path rather than reimplementing take generation: that keeps one implementation
    of candidate generation, Whisper validation, score-first selection and the
    loud-non-speech rejection. A chunk is <= 300 chars by construction, so
    Extended's own chunker leaves it as exactly one chunk.

    Two differences from the whole-script path, both required by assembly:
      * WAV, not MP3 — these get concatenated, and re-encoding every chunk would
        stack generational loss for nothing.
      * no normalisation and no gate here. Loudness is normalised ONCE over the
        joined audio; doing it per chunk would level each chunk independently and
        flatten the natural dynamics between sentences.
    """
    ensure_model()
    Chatter._NARRATOR_SELECTION.clear()
    Chatter._NARRATOR_UNPASSED.clear()

    produced = Chatter.process_text_for_tts(
        text=text,
        input_basename=output_basename,
        audio_prompt_path_input=ref_wav_path,
        exaggeration_input=exaggeration,
        temperature_input=temperature,
        seed_num_input=base_seed,
        cfgw_input=cfg_weight,
        use_pyrnnoise=False,
        use_auto_editor=AUTO_EDITOR_ENABLED,
        ae_threshold=AUTO_EDITOR_THRESHOLD,
        ae_margin=AUTO_EDITOR_MARGIN,
        export_formats=["wav"],
        enable_batching=True,
        to_lowercase=False,
        normalize_spacing=True,
        fix_dot_letters=True,
        remove_reference_numbers=False,
        keep_original_wav=True,
        smart_batch_short_sentences=True,
        disable_watermark=True,
        num_generations=1,
        normalize_audio=False,
        normalize_method="ebu",
        normalize_level=-18,
        normalize_tp=-1,
        normalize_lra=11,
        num_candidates_per_chunk=int(num_candidates),
        max_attempts_per_candidate=1,
        bypass_whisper_checking=False,
        whisper_model_name=DEFAULT_WHISPER_MODEL,
        enable_parallel=False,
        num_parallel_workers=1,
        use_longest_transcript_on_fail=False,
        sound_words_field="",
        use_faster_whisper=True,
    )
    if not produced:
        raise RuntimeError("chunk generation produced no output")

    wav = next((p for p in produced if p.lower().endswith(".wav")), produced[0])
    # Index 0: a single chunk in, a single chunk out. Fall back to zeros rather
    # than raising — the audio is the deliverable, the metrics are diagnostics.
    _sel = Chatter._NARRATOR_SELECTION.get(0)
    measured = _sel is not None
    score, _dur_s, gap_s, gap_db = _sel if measured else (0.0, 0.0, 0.0, 99.0)
    passed = 0 not in Chatter._NARRATOR_UNPASSED
    if not passed:
        print(
            f"[adapter] no take passed validation; shipping best failing take "
            f"(score={float(score):.3f})",
            flush=True,
        )
    return ChunkResult(
        path=wav,
        duration_ms=probe_duration_ms(wav) or 0,
        score=float(score),
        gap_seconds=float(gap_s),
        gap_quiet_db=float(gap_db),
        passed=passed,
        measured=measured,
    )


def assemble(*, pieces: list, output_basename: str, export_format: str) -> str:
    """Join chunk WAVs with inserted silence, then clean and normalise once.

    `pieces` is [(wav_path, pause_after_ms), ...] in order.

    Pause silence is generated here as true digital silence rather than asking the
    model for a pause. That is the one approach that cannot carry the vocoder's
    noise floor, which is what makes model-generated silence audible as hiss --
    measured at -34 dBFS against -18 dBFS speech in a real narration.

    A short fade is applied at every join. Concatenating at a non-zero crossing
    produces a click; 8ms is inaudible as a fade but removes the discontinuity.
    Measured on 18 real chunks: 0 of 17 joins showed any click above the file's
    own 99.99th-percentile sample delta.
    """
    if not pieces:
        raise RuntimeError("nothing to assemble")

    work = os.path.join("output", f"{output_basename}_assembly")
    os.makedirs(work, exist_ok=True)
    parts: list = []

    for i, (wav_path, pause_ms) in enumerate(pieces):
        faded = os.path.join(work, f"p{i:04d}.wav")
        _run_ffmpeg([
            "-i", wav_path,
            "-af", f"afade=t=in:st=0:d={ASSEMBLY_FADE_S},"
                   f"areverse,afade=t=in:st=0:d={ASSEMBLY_FADE_S},areverse",
            faded,
        ], what=f"fade chunk {i}")
        parts.append(faded)

        if pause_ms and int(pause_ms) > 0:
            sil = os.path.join(work, f"s{i:04d}.wav")
            # anullsrc must match the speech rate and layout exactly, or the
            # concat demuxer refuses to join them.
            _run_ffmpeg([
                "-f", "lavfi",
                "-i", f"anullsrc=r={_model_sample_rate()}:cl=mono",
                "-t", f"{int(pause_ms) / 1000.0:.3f}",
                sil,
            ], what=f"silence after chunk {i}")
            parts.append(sil)

    listing = os.path.join(work, "concat.txt")
    with open(listing, "w", encoding="utf-8") as fh:
        for p in parts:
            fh.write(f"file '{os.path.abspath(p)}'\n")

    out = os.path.join("output", f"{output_basename}.{export_format}")
    filters = []
    if DENOISE_ENABLED:
        filters.append(DENOISE_FILTER)
    filters.append(f"loudnorm=I={NORMALIZE_I}:TP={NORMALIZE_TP}:LRA={NORMALIZE_LRA}")
    args = ["-f", "concat", "-safe", "0", "-i", listing, "-af", ",".join(filters)]
    if export_format == "mp3":
        args += ["-codec:a", "libmp3lame", "-q:a", "2"]
    args.append(out)
    _run_ffmpeg(args, what="assemble")
    return out


def _run_ffmpeg(args: list, *, what: str) -> None:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({what}): {res.stderr.strip()[:400]}")


# ---------------------------------------------------------------------------
# Enrollment scoring
# ---------------------------------------------------------------------------

@dataclass
class TakeScores:
    duration_ms: int
    snr_db: float
    clip_ratio: float
    silence_ratio: float
    sample_rate: int

    def as_dict(self) -> dict:
        return asdict(self)


# Thresholds. These are calibrated against the estimator below, not against a
# published metric, so they are only meaningful together. Tune with real takes.
MIN_DURATION_MS = 12_000     # below ~12s the clone degrades noticeably
# Our ceiling, not the library's. Chatterbox truncates the reference internally:
# ENC_COND_LEN = 6s feeds the T3 conditioning prompt, DEC_COND_LEN = 10s feeds the
# s3gen decoder reference, and the voice-encoder speaker embedding consumes the
# WHOLE clip (silence-trimmed, then averaged). So length past 10s is not thrown
# away, it just feeds one of three conditioning paths with diminishing returns —
# and nothing in the model objects to a long read. The previous 45s stop rejected
# a perfectly usable 55s take for a reason the library does not have.
MAX_DURATION_MS = int(os.environ.get("NARRATOR_MAX_TAKE_MS", "120000"))
MIN_SNR_DB = 20.0
MAX_CLIP_RATIO = 0.001       # 0.1% of samples at full scale is already audible
MAX_SILENCE_RATIO = 0.45
DENOISE_SNR_THRESHOLD = 28.0  # above this, denoising costs timbre and buys nothing


def _read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    """Read a WAV as float32 in [-1, 1]. Handles 16/24/32-bit PCM and float32."""
    with wave.open(path, "rb") as w:
        n_channels = w.getnchannels()
        sample_width = w.getsampwidth()
        sample_rate = w.getframerate()
        raw = w.readframes(w.getnframes())

    if sample_width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sample_width == 4:
        # Could be int32 PCM or float32. Extended emits pcm_f32le, so probe:
        as_f32 = np.frombuffer(raw, dtype="<f4")
        if np.isfinite(as_f32).all() and np.abs(as_f32).max() <= 1.5:
            data = as_f32.astype(np.float32)
        else:
            data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif sample_width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        as_i32 = (
            b[:, 0].astype(np.int32)
            | (b[:, 1].astype(np.int32) << 8)
            | (b[:, 2].astype(np.int32) << 16)
        )
        as_i32 = np.where(as_i32 & 0x800000, as_i32 - 0x1000000, as_i32)
        data = as_i32.astype(np.float32) / 8388608.0
    else:
        raise ValueError(f"unsupported sample width: {sample_width} bytes")

    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)
    return data, sample_rate


def score_take(wav_path: str) -> TakeScores:
    """Score an enrollment take.

    SNR here is a percentile-based estimate, NOT WADA-SNR: frame the signal into
    20ms frames, take the noise floor as the 10th percentile of frame RMS and the
    speech level as the 90th, and report their ratio in dB. This is chosen
    deliberately over WADA-SNR, whose faithful implementation depends on a large
    published lookup table — a subtly wrong version of a well-known algorithm
    would be worse than a simple estimator whose behaviour is fully described
    here. Thresholds above are calibrated to this estimator.
    """
    data, sr = _read_wav_mono(wav_path)
    if data.size == 0:
        raise ValueError("empty audio")

    duration_ms = int(1000 * data.size / sr)

    frame = max(1, int(0.020 * sr))
    n_frames = data.size // frame
    if n_frames < 3:
        raise ValueError("audio too short to score")
    frames = data[: n_frames * frame].reshape(n_frames, frame)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))

    eps = 1e-10
    noise = float(np.percentile(rms, 10))
    speech = float(np.percentile(rms, 90))
    snr_db = 20.0 * math.log10((speech + eps) / (noise + eps))

    clip_ratio = float((np.abs(data) >= 0.999).mean())

    # A frame counts as silent if it sits close to the noise floor.
    silence_ratio = float((rms <= max(noise * 2.0, 1e-4)).mean())

    return TakeScores(
        duration_ms=duration_ms,
        snr_db=round(snr_db, 2),
        clip_ratio=round(clip_ratio, 6),
        silence_ratio=round(silence_ratio, 4),
        sample_rate=sr,
    )


def probe_duration_ms(path: str) -> Optional[int]:
    """Duration of any audio file in milliseconds, or None if it can't be read.

    score_take() parses WAV headers directly, so it cannot measure the mp3 we
    normally ship — which is why narration duration_ms was silently NULL for every
    mp3 output, and with it the RTF figure in the logs. ffprobe reads container
    metadata for every format Extended can emit, and ffmpeg is already a hard
    dependency of enrollment preprocessing, so this adds nothing to install.

    Duration is reporting only: never fail a finished generation because we could
    not measure it.
    """
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return int(round(float(out.stdout.strip()) * 1000))
    except Exception as exc:
        print(f"[adapter] could not probe duration of {path}: {exc}", flush=True)
        return None


def judge_take(scores: TakeScores) -> Optional[str]:
    """Return a specific rejection reason, or None if the take is acceptable.

    Each failure gets a distinct, user-actionable message — "rejected" with no
    reason is useless to someone trying to fix their recording setup.
    """
    if scores.clip_ratio > MAX_CLIP_RATIO:
        return (
            f"Recording is clipping ({scores.clip_ratio * 100:.2f}% of samples at "
            "full scale). Lower your input gain and record again."
        )
    if scores.snr_db < MIN_SNR_DB:
        return (
            f"Too much background noise (estimated {scores.snr_db:.1f} dB signal-to-noise, "
            f"need {MIN_SNR_DB:.0f} dB). Record somewhere quieter or closer to the mic."
        )
    if scores.duration_ms < MIN_DURATION_MS:
        return (
            f"Take is too short ({scores.duration_ms / 1000:.1f}s, need at least "
            f"{MIN_DURATION_MS / 1000:.0f}s). Read the whole passage straight through."
        )
    if scores.duration_ms > MAX_DURATION_MS:
        return (
            f"Take is too long ({scores.duration_ms / 1000:.1f}s, maximum "
            f"{MAX_DURATION_MS / 1000:.0f}s). One passage is enough."
        )
    if scores.silence_ratio > MAX_SILENCE_RATIO:
        return (
            f"Take is mostly silence ({scores.silence_ratio * 100:.0f}%). Check that the "
            "microphone was actually capturing, and avoid long pauses."
        )
    return None


def preprocess_enrollment(in_path: str, out_path: str, *, target_sr: int = 24_000) -> TakeScores:
    """Normalize an enrollment take and return its scores.

    Loudness normalization goes through ffmpeg `loudnorm`, which applies a real
    true-peak limiter. pyloudnorm is NOT used: it applies loudness gain but has
    no true-peak limiting, so a -1 dBTP ceiling is unachievable with it.

    Denoising is skipped on already-clean audio, because over-denoising strips
    the timbre the speaker embedding depends on.
    """
    pre = score_take(in_path)

    tmp = out_path + ".norm.wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", in_path,
            "-af", "loudnorm=I=-18:TP=-1:LRA=11",
            "-ar", str(target_sr), "-ac", "1", "-c:a", "pcm_s16le",
            tmp,
        ],
        check=True,
        capture_output=True,
    )

    if pre.snr_db < DENOISE_SNR_THRESHOLD:
        try:
            Chatter._apply_pyrnnoise_in_place(tmp)
        except Exception as exc:  # denoise is best-effort, never fatal
            print(f"[adapter] denoise skipped: {exc}")

    os.replace(tmp, out_path)
    return score_take(out_path)
