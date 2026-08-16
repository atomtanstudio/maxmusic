# MaxMusic's model worker — MiniMax Music 3 through diffusers.
#
# Why a container: the host needs an NVIDIA driver and nothing else. No system
# Python to match, no venv, no CUDA toolkit, no hand-placed model files. The
# weights arrive from Hugging Face into a mounted cache on first run, so the
# image stays small and no licensed weights are ever baked into it.
FROM nvidia/cuda:12.8.1-base-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    TOKENIZERS_PARALLELISM=false

# git is here because diffusers is pinned to a commit until the MiniMax Music 3
# pipeline lands in a release; pip needs it to fetch that.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv libsndfile1 curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 marks its Python as externally managed; this image IS the
# environment, so installing into it is the point.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# torch first and on its own, from the CUDA 12.8 index — Blackwell (RTX 50
# series) needs cu128 or newer, and letting it resolve from PyPI lands a build
# that cannot see the card.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu128

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY minimax_worker.py /app/minimax_worker.py
WORKDIR /app

EXPOSE 3011
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3011/health >/dev/null || exit 1

CMD ["python3", "minimax_worker.py", "--host", "0.0.0.0", "--port", "3011"]
