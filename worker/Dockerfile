# syntax=docker/dockerfile:1
# ============================================================================
# Narrator — service B (GPU TTS worker) image
# ============================================================================
# MUST be built for linux/amd64: SPCS GPU_NV_S nodes are x86_64. On Apple
# Silicon this means a QEMU cross-build (slow on first run, cached after).
#
# Base is nvidia/cuda 12.8.1 to match torch's cu128 wheels, on Ubuntu 22.04
# whose system Python is 3.10 — the version Chatterbox-TTS-Extended requires.
#
# Everything the runtime needs is baked in. SPCS containers have NO network
# egress, so any dependency that lazily fetches a model at first use will fail
# only in production. Three such fetches are pre-warmed below.
# ============================================================================
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# ffmpeg is a hard requirement of Extended (loudnorm, format conversion) and is
# invoked as a subprocess, not a library. libsndfile1 backs soundfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-venv python3-pip \
        ffmpeg libsndfile1 libgomp1 \
        git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- TLS-intercepting networks (build-time only) ----------------------------
# Some corporate networks terminate and re-sign outbound TLS at a security
# gateway, so a host can present a locally-issued certificate chain rather than
# its real one. Where that happens it is often partial: on the network this was
# developed on, the HuggingFace model downloads were intercepted while PyPI and
# GitHub were not, so only the weight-baking steps below failed, with
# CERTIFICATE_VERIFY_FAILED. Installing the intercepting root as a trusted CA
# fixes it.
#
# This is environment-specific, not inherent to the project — on a build host
# with no such gateway, snowflake-ca.crt can be an empty file. It is gitignored
# because it is specific to your machine and network.
# Only needed at BUILD time; the runtime has no network at all.
COPY snowflake-ca.crt /usr/local/share/ca-certificates/snowflake-ca.crt
RUN update-ca-certificates
# Point Python's TLS at the system store so requests/httpx/huggingface_hub pick
# up the CA above rather than only trusting certifi's bundle.
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN ln -sf /usr/bin/python3.10 /usr/local/bin/python && \
    ln -sf /usr/bin/python3.10 /usr/local/bin/python3

# --- Extended, pinned -------------------------------------------------------
# Pinned to a specific commit for reproducibility. One targeted patch is applied
# at the end of this file (patch_extended.py, take-selection bug); everything
# else is called as-is through process_text_for_tts().
ARG EXTENDED_REPO=https://github.com/petermg/Chatterbox-TTS-Extended.git
ARG EXTENDED_COMMIT=7b43fc08faa42160208a7e3d0c521a453e59125d
WORKDIR /opt
RUN git clone "${EXTENDED_REPO}" extended && \
    cd extended && git checkout "${EXTENDED_COMMIT}" && \
    rm -rf .git

WORKDIR /opt/extended

# --- Python dependencies ----------------------------------------------------
# LAYER SIZING IS LOAD-BEARING. Do not collapse these RUNs back into one.
#
# A Snowflake image-registry session token lasts ~58 minutes (measured twice),
# and the upload path here sustains ~2.4 MB/s. That puts a hard ceiling of about
# 8.3 GB on any SINGLE layer: a blob larger than that can never finish inside one
# token's life, and because a failed blob restarts from zero, retrying is futile
# rather than merely slow. Installing every requirement in one RUN produced an
# 8.26 GB layer — right at that ceiling — which is exactly why the first push
# attempts looped forever without converging.
#
# Layers below are therefore bucketed by measured installed size (from `du -sm`
# on site-packages of a working build), targeting ~1 GB each with torch's own
# wheel the largest at ~2 GB. Smaller layers also mean a partial push banks real
# progress: every completed blob is retained by the registry, so a re-push after
# token expiry resumes instead of starting over.
#
# Sizes are installed (uncompressed) megabytes:
#   cudnn 1055 | cublas 858 | cusparse+cusolver 754 | cufft+nccl+nvrtc 742
#   small nvidia + cusparselt 501 | triton 544 | torch+torchaudio 1971 | rest ~1800
#
# setuptools<81 is REQUIRED: librosa==0.10.0 imports pkg_resources, which
# setuptools 81 removed. Verified by failure — setuptools 84 breaks the import.
RUN python -m pip install --upgrade pip && \
    python -m pip install "setuptools<81" wheel

# Every pip invocation below is constrained by this file so that splitting the
# install cannot change which versions get resolved. See its header for why.
COPY constraints.cu128.txt /tmp/constraints.cu128.txt
ENV PIP_CONSTRAINT=/tmp/constraints.cu128.txt \
    PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128

# CUDA runtime libraries, biggest first. These are torch's dependencies, but
# installing them explicitly up front is what lets them occupy their own layers
# instead of being swept into torch's.
RUN python -m pip install nvidia-cudnn-cu12
RUN python -m pip install nvidia-cublas-cu12
RUN python -m pip install nvidia-cusparse-cu12 nvidia-cusolver-cu12
RUN python -m pip install nvidia-cufft-cu12 nvidia-nccl-cu12 nvidia-cuda-nvrtc-cu12
RUN python -m pip install \
        nvidia-curand-cu12 nvidia-nvjitlink-cu12 nvidia-cuda-cupti-cu12 \
        nvidia-cuda-runtime-cu12 nvidia-cufile-cu12 nvidia-nvtx-cu12 \
        nvidia-cusparselt-cu12
RUN python -m pip install triton

# torch itself. Its CUDA dependencies are already satisfied above, so this layer
# carries only the torch and torchaudio wheels.
RUN python -m pip install torch torchaudio

# Extended's own requirements.txt, with two corrections applied by
# requirements.patched.txt (see that file's header for why). Everything heavy is
# already installed, so this resolves to the remaining pure-Python packages.
COPY requirements.patched.txt /tmp/requirements.patched.txt
RUN python -m pip install -r /tmp/requirements.patched.txt

# What the worker itself needs, beyond Extended. Note there is NO web
# framework: service B exposes no HTTP surface, it polls a table.
RUN python -m pip install snowflake-connector-python soundfile

# Fail the BUILD, not production, if the split above dropped or shifted anything.
# A missing import inside SPCS costs a pool resume and a log dig to discover.
RUN python - <<'PY'
import importlib, sys
mods = [
    "torch", "torchaudio", "transformers", "diffusers", "librosa", "soundfile",
    "faster_whisper", "nltk", "omegaconf", "perth", "conformer", "s3tokenizer",
    "silero_vad", "snowflake.connector", "numpy", "scipy",
]
missing = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as exc:
        missing.append(f"{m}: {type(exc).__name__}: {exc}")
if missing:
    sys.exit("import check FAILED:\n  " + "\n  ".join(missing))
import torch
print(f"import check OK ({len(mods)} modules); torch {torch.__version__}")
PY

# --- Pre-warm everything that would otherwise fetch at runtime --------------
ENV HF_HOME=/opt/models/hf \
    TORCH_HOME=/opt/models/torch \
    NLTK_DATA=/opt/models/nltk

# 1. nltk punkt_tab — fetched on the first sentence split. This one is easy to
#    miss because it only fails once real text is processed.
RUN mkdir -p "${NLTK_DATA}" && \
    python -c "import nltk; nltk.download('punkt_tab', download_dir='${NLTK_DATA}'); nltk.download('punkt', download_dir='${NLTK_DATA}')"

# 2. Chatterbox TTS weights. Downloaded on CPU here purely to populate the
#    cache; the runtime loads them onto the GPU.
RUN python -c "\
import torch; \
from chatterbox.src.chatterbox.tts import ChatterboxTTS; \
m = ChatterboxTTS.from_pretrained('cpu'); \
print('chatterbox weights cached')"

# 3. faster-whisper 'medium' — Extended's default validation backend
#    (use_faster_whisper defaults True, whisper_model defaults to medium).
RUN python -c "\
from faster_whisper import WhisperModel; \
WhisperModel('medium', device='cpu', compute_type='int8'); \
print('faster-whisper medium cached')"

# Now lock the runtime out of the network. Anything not cached above will fail
# loudly here rather than mysteriously inside SPCS.
ENV TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    HF_HUB_OFFLINE=1

# --- Our code ---------------------------------------------------------------
# Extended writes ./temp and ./output relative to CWD and WIPES ./temp on every
# call, so the working directory is fixed and single-worker by construction.
RUN mkdir -p /opt/extended/temp /opt/extended/output

# Fix Extended's take selection, add progress/cancellation hooks, and repair the
# vendored model's generate_batch so takes can be produced in one batched pass.
#
# Selection: Extended scores every candidate with Whisper and then discards the
# scores, selecting the SHORTEST passing clip instead -- which actively prefers
# takes that skipped words. Measured on a real 15-chunk run, 5 of 15 chunks
# shipped a strictly worse take than one they had already generated.
#
# generate_batch: shipped broken (torch.stack where torch.cat was meant), so the
# batched path raised and fell back to sequential, giving no speedup at all.
#
# Applied here, at the very end, rather than next to the clone: these files are
# cheap to iterate on and a change to them must not invalidate the multi-GB
# dependency layers above (the registry session token only lasts ~58 minutes).
# numnorm.py must land BEFORE the patcher runs: patch_extended.py reads it from its
# own directory and injects its source into Chatter.py, so that the number
# canonicaliser ships inside the patched file with no runtime import.
COPY patch_extended.py numnorm.py /opt/extended/
RUN python /opt/extended/patch_extended.py /opt/extended

COPY adapter.py worker.py planning.py smoke_offline.py /opt/extended/

# The service spec overrides this with ["python", "worker.py"]; keeping the
# worker as the default means `docker run` on the image does the useful thing.
CMD ["python", "worker.py"]
