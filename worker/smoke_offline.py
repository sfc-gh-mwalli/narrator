"""
Offline smoke test for the Narrator worker image.

Run this INSIDE the container with networking disabled:

    docker run --rm --network none narrator-worker:dev python smoke_offline.py

It exercises both job shapes end to end. The point is not audio quality — it is
to prove that nothing in the dependency tree reaches the network at first use.
That failure mode is invisible during a build (which has network) and only
surfaces inside SPCS, which has none. Three separate lazy fetches were found
this way already: nltk punkt_tab, the Chatterbox weights, and faster-whisper.

Exits non-zero on any failure.
"""
import os
import subprocess
import sys
import wave
import math
import struct

WORK = "/tmp/smoke"
os.makedirs(WORK, exist_ok=True)

failures: list[str] = []


def step(name: str):
    print(f"\n=== {name} ===", flush=True)


def make_reference_wav(path: str, seconds: float = 16.0, sr: int = 24_000) -> None:
    """Synthesize a crude voiced-ish signal so we need no recorded asset.

    A few harmonics with an amplitude envelope and brief gaps. Not speech, but
    structured enough to pass basic scoring and exercise the code paths.
    """
    n = int(seconds * sr)
    frames = bytearray()
    for i in range(n):
        t = i / sr
        # amplitude envelope with short pauses, so silence_ratio is non-trivial
        env = 0.0 if (t % 4.0) > 3.4 else 0.45 * (0.7 + 0.3 * math.sin(2 * math.pi * 0.7 * t))
        f0 = 120.0 + 12.0 * math.sin(2 * math.pi * 0.3 * t)
        s = (
            0.60 * math.sin(2 * math.pi * f0 * t)
            + 0.25 * math.sin(2 * math.pi * 2 * f0 * t)
            + 0.12 * math.sin(2 * math.pi * 3 * f0 * t)
        )
        v = max(-1.0, min(1.0, env * s))
        frames += struct.pack("<h", int(v * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))


# ---------------------------------------------------------------------------
step("environment")
print(f"python  = {sys.version.split()[0]}")
print(f"cwd     = {os.getcwd()}")
for var in ("TRANSFORMERS_OFFLINE", "HF_HUB_OFFLINE", "HF_DATASETS_OFFLINE",
            "HF_HOME", "TORCH_HOME", "NLTK_DATA"):
    print(f"{var:22s}= {os.environ.get(var, '<unset>')}")

try:
    out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=True)
    print("ffmpeg  =", out.stdout.splitlines()[0])
except Exception as exc:
    failures.append(f"ffmpeg unavailable: {exc}")

# ---------------------------------------------------------------------------
step("import adapter (loads TTS model — must not hit the network)")
try:
    import adapter
    print("device =", adapter.device())
    adapter.ensure_model()
    print("model loaded and verified")
except Exception as exc:
    failures.append(f"adapter import / model load failed: {exc}")
    print(f"FATAL: {exc}")
    # Nothing below can work without a model.
    print("\n=== RESULT ===")
    for f in failures:
        print(f"FAIL: {f}")
    sys.exit(1)

# ---------------------------------------------------------------------------
step("ENROLL job shape: score + normalize a take")
ref_raw = os.path.join(WORK, "ref_raw.wav")
ref_norm = os.path.join(WORK, "ref_norm.wav")
try:
    make_reference_wav(ref_raw)
    pre = adapter.score_take(ref_raw)
    print("pre-normalization scores :", pre.as_dict())

    post = adapter.preprocess_enrollment(ref_raw, ref_norm)
    print("post-normalization scores:", post.as_dict())

    verdict = adapter.judge_take(post)
    print("judgement:", verdict or "ACCEPTED")

    if not os.path.exists(ref_norm) or os.path.getsize(ref_norm) == 0:
        failures.append("normalized enrollment audio missing or empty")
except Exception as exc:
    failures.append(f"ENROLL path failed: {exc}")
    print(f"ERROR: {exc}")

# ---------------------------------------------------------------------------
step("rejection messages are distinct and specific")
try:
    from adapter import TakeScores, judge_take
    cases = {
        "clipping":  TakeScores(20_000, 30.0, 0.02, 0.10, 24_000),
        "noisy":     TakeScores(20_000, 8.0, 0.0, 0.10, 24_000),
        "too short": TakeScores(3_000, 30.0, 0.0, 0.10, 24_000),
        "too long":  TakeScores(90_000, 30.0, 0.0, 0.10, 24_000),
        "silent":    TakeScores(20_000, 30.0, 0.0, 0.90, 24_000),
        "good":      TakeScores(20_000, 30.0, 0.0, 0.10, 24_000),
    }
    reasons = {}
    for label, s in cases.items():
        r = judge_take(s)
        reasons[label] = r
        print(f"  {label:10s} -> {r or 'ACCEPTED'}")
    if reasons["good"] is not None:
        failures.append("a clean take was rejected")
    bad = [k for k, v in reasons.items() if k != "good" and v is None]
    if bad:
        failures.append(f"these bad takes were accepted: {bad}")
    distinct = {v for k, v in reasons.items() if v}
    if len(distinct) != 5:
        failures.append("rejection reasons are not all distinct")
except Exception as exc:
    failures.append(f"judgement checks failed: {exc}")

# ---------------------------------------------------------------------------
step("GENERATE job shape: short script, whisper validation ON")
try:
    paths = adapter.generate_narration(
        script_text="This is an offline smoke test of the narration worker.",
        ref_wav_path=ref_norm if os.path.exists(ref_norm) else ref_raw,
        base_seed=12345,
        output_basename="smoke",
        export_format="wav",
        num_candidates=1,      # keep it quick; the point is reachability
        max_attempts=1,
        validate_with_whisper=True,   # exercises faster-whisper offline
        parallel_workers=1,
    )
    print("returned:", paths)
    if not paths:
        failures.append("generation returned no paths")
    for p in paths:
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            failures.append(f"generated file missing or empty: {p}")
        else:
            print(f"  {p}  ({os.path.getsize(p)} bytes)")
except Exception as exc:
    failures.append(f"GENERATE path failed: {exc}")
    print(f"ERROR: {exc}")

# ---------------------------------------------------------------------------
print("\n=== RESULT ===")
if failures:
    for f in failures:
        print(f"FAIL: {f}")
    sys.exit(1)
print("PASS: both job shapes ran offline; no dependency required the network")
