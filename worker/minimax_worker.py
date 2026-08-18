"""
MaxMusic's model worker — MiniMax Music 3, through diffusers.

Why this exists
---------------
The app has always talked to whatever makes the audio over HTTP, which meant
the thing making the audio could be a ComfyUI install driven by a workflow
graph. That works, and it stays supported, but it is a lot to ask of somebody
who just wants to make a song: install a second application, find three model
files, put each in the right folder, keep the graph and the node names in step.

This is the other way in. `pip install`, and the weights arrive from Hugging
Face on first run. No graph, no file placement, no second GUI.

The contract
------------
Deliberately the same shape the app already speaks, so nothing upstream has to
know which runtime answered:

    GET  /health    → readiness, device, and whether the weights are resident
    POST /generate  → { prompt, lyrics, duration, seed, instrumental }
                      → { track: {url, filename}, extra_info: {...} }
    POST /release   → safely unload the resident model when no song is running
    GET  /tracks/…  → the finished audio

One deliberate difference from the ComfyUI path: `music_duration` here is
MEASURED from the audio that came out, never copied from the length that was
asked for. The two are not the same number — `audio_duration` is an upper
bound and the language model stops when the song is over — and reporting the
request as though it were the result is how a 2:25 song ends up labelled 3:00.

Running it
----------
    python worker/minimax_worker.py --check          # verify the environment
    python worker/minimax_worker.py --port 3011      # serve

@module worker/minimax_worker
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from difflib import SequenceMatcher
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL_ID = os.environ.get("MAXMUSIC_MODEL", "MiniMaxAI/MiniMax-Music3")
RUNTIME = os.environ.get("MAXMUSIC_RUNTIME", "diffusers").strip().lower()
if RUNTIME not in {"diffusers", "comfy"}:
    raise RuntimeError("MAXMUSIC_RUNTIME must be 'diffusers' or 'comfy'.")
COMFY_URL = os.environ.get("MAXMUSIC_COMFY_URL", "http://127.0.0.1:8189").strip().rstrip("/")
COMFY_DIFFUSION_MODEL = os.environ.get(
    "MAXMUSIC_COMFY_DIFFUSION_MODEL",
    "minimax_music3/minimax_music3_dit_fp16.safetensors",
).strip()
COMFY_TEXT_ENCODER = os.environ.get(
    "MAXMUSIC_COMFY_TEXT_ENCODER",
    "minimax_music3/minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
).strip()
COMFY_VAE = os.environ.get(
    "MAXMUSIC_COMFY_VAE",
    "minimax_music3/minimax_music3_dav.safetensors",
).strip()
PIPELINE_VERSION = "music3-comfy-soft-duration-v12" if RUNTIME == "comfy" else "music3-soft-duration-v12"
TRACKS_DIR = Path(os.environ.get("MAXMUSIC_TRACKS", Path(__file__).resolve().parent.parent / "render" / "out" / "tracks"))
DEVICE_REQUEST = os.environ.get("MAXMUSIC_DEVICE", "cuda").strip().lower()
# MPS float16 can report a successful pipeline call while producing an all-zero
# waveform on this model. Float32 costs more memory but is the safer native
# default; the setting remains explicit for experimentation.
MPS_DTYPE_REQUEST = os.environ.get("MAXMUSIC_MPS_DTYPE", "float32").strip().lower()
# Releasing after every song makes a two-take request reload roughly 23 GB of
# weights between takes. Keep the model warm for one editing session instead,
# then return its VRAM automatically. Zero keeps it resident until /release.
# The older boolean remains a compatibility switch for existing deployments.
_LEGACY_AUTO_RELEASE = os.environ.get("MAXMUSIC_AUTO_RELEASE_VRAM", "true").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
try:
    IDLE_RELEASE_SECONDS = max(
        0.0,
        float(os.environ.get("MAXMUSIC_IDLE_RELEASE_SECONDS", "600" if _LEGACY_AUTO_RELEASE else "0")),
    )
except ValueError:
    IDLE_RELEASE_SECONDS = 600.0 if _LEGACY_AUTO_RELEASE else 0.0
# The model's own ceiling: 9000 frames at 25 frames a second.
MAX_SECONDS = 360.0
MIN_SECONDS = 5.0
MAX_AUDIO_FRAMES = 9000
SEED_MODULUS = 2147483647
SEED_STEP = 104729
COMFY_SEED_STEP = 1_000_000
# Semantic planning is the cheap half of a render: it runs the language model
# stages and stops before denoising and decoding. Spending a few of those to
# find a plan that answers the requested length costs a fraction of one wrong
# song, and only the winning plan is ever synthesised.
MAX_PLAN_ATTEMPTS = 4
try:
    DEFAULT_PLAN_ATTEMPTS = max(1, min(MAX_PLAN_ATTEMPTS, int(os.environ.get("MAXMUSIC_PLAN_ATTEMPTS", "4"))))
except ValueError:
    DEFAULT_PLAN_ATTEMPTS = MAX_PLAN_ATTEMPTS

VERIFY_LYRICS = os.environ.get("MAXMUSIC_VERIFY_LYRICS", "true").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
WHISPER_MODEL = os.environ.get("MAXMUSIC_WHISPER_MODEL", "small").strip() or "small"
try:
    WHISPER_THREADS = max(1, min(32, int(os.environ.get("MAXMUSIC_WHISPER_THREADS", str(min(16, os.cpu_count() or 4))))))
except ValueError:
    WHISPER_THREADS = min(16, os.cpu_count() or 4)
try:
    WHISPER_TAIL_SECONDS = max(30.0, min(180.0, float(os.environ.get("MAXMUSIC_WHISPER_TAIL_SECONDS", "90"))))
except ValueError:
    WHISPER_TAIL_SECONDS = 90.0
WHISPER_DEVICE_REQUEST = os.environ.get("MAXMUSIC_WHISPER_DEVICE", "auto").strip().lower() or "auto"
WHISPER_COMPUTE_REQUEST = os.environ.get("MAXMUSIC_WHISPER_COMPUTE_TYPE", "").strip()


def cuda_devices() -> int:
    """Count CUDA devices the way faster-whisper's runtime sees them."""
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001 — any failure means "assume no GPU"
        pass
    try:
        import torch

        return int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
    except Exception:  # noqa: BLE001
        return 0


def warm_cuda_libraries() -> None:
    """Pull the CUDA runtime into this process before CTranslate2 asks for it.

    `nvidia-cublas-cu12`, `nvidia-cudnn-cu12` and the PyTorch wheels install
    their shared libraries under `site-packages/nvidia/*/lib`, which nothing
    adds to the loader path. Loading them with RTLD_GLOBAL satisfies the
    dependencies each one declares.
    """
    import ctypes
    import site

    names = ("libcublasLt.so.12", "libcublas.so.12", "libcudnn.so.9", "libcudnn.so.8")
    roots = []
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        root = Path(base) / "nvidia"
        if root.is_dir():
            roots.extend(str(p) for p in sorted(root.glob("*/lib")) if p.is_dir())
    for directory in roots:
        for name in names:
            candidate = Path(directory) / name
            if candidate.exists():
                try:
                    ctypes.CDLL(str(candidate), mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
    for name in names:
        try:
            ctypes.CDLL(name, mode=ctypes.RTLD_GLOBAL)
        except OSError:
            pass


def cuda_runtime_ready() -> bool:
    """Whether the GPU can actually be used, not merely whether one exists.

    A device count answers "is there a card", which is a different question: a
    machine can report one through the driver and have no cuBLAS to compute
    with. CTranslate2 loads those libraries lazily, so believing the device
    count means the failure lands in the middle of a song rather than at
    startup — which is exactly how lyric videos broke with
    `libcublas.so.12 is not found` after the model had built without complaint.
    """
    import ctypes

    if cuda_devices() <= 0:
        return False
    warm_cuda_libraries()
    for name in ("libcublas.so.12", "cublas64_12.dll"):
        try:
            ctypes.CDLL(name)
            return True
        except OSError:
            continue
    return False


def whisper_device_order() -> list[tuple[str, str]]:
    """Devices to try for lyric verification, best first, with matching precision.

    `small` in float16 is a few hundred megabytes beside a resident Music 3, so
    the GPU that just made the song can usually check it too — an order of
    magnitude faster than the CPU. Where it cannot, the CPU is still there, so
    a tight card costs time rather than the check itself. Pin
    ``MAXMUSIC_WHISPER_DEVICE=cpu`` to keep every byte of VRAM for the model.
    """
    want = WHISPER_DEVICE_REQUEST
    override = WHISPER_COMPUTE_REQUEST
    order: list[tuple[str, str]] = []
    if want in {"auto", "cuda"} and (want == "cuda" or cuda_runtime_ready()):
        order.append(("cuda", override or "float16"))
    if want not in {"auto", "cuda", "cpu"}:
        order.append((want, override or "int8"))
    if not any(device == "cpu" for device, _ in order):
        order.append(("cpu", override or "int8"))
    return order


def duration_ballpark(seconds: float) -> tuple[float, float]:
    """The public duration promise: the same ballpark, never an exact stop.

    Music 3 decides for itself when a composition has resolved, so the
    selected length can only ever be creative guidance. It still has to mean
    something: asking for five minutes and being handed fifty seconds is not a
    song that ran a little short, it is a different request. A quarter of the
    target either way — never less than fifteen seconds, which is what keeps
    the shortest songs from being held to an impossible standard — is wide
    enough for the model to end where it wants and narrow enough that the
    slider still describes what arrives.
    """
    target = max(0.0, float(seconds))
    slack = max(15.0, target * 0.25)
    return max(MIN_SECONDS, target - slack), min(MAX_SECONDS, target + slack)


def plan_is_in_ballpark(planned_seconds: float, target_seconds: float) -> bool:
    """True when a complete plan also answers the length that was asked for."""
    low, high = duration_ballpark(target_seconds)
    return low <= float(planned_seconds) <= high


def plan_beats(candidate: dict, incumbent: dict | None) -> bool:
    """Whether a fresh plan answers the request better than the best so far.

    Only a plan that ended on its own can win: a composition that ran into the
    frame ceiling is not a song, however close to the requested length it got.
    Among complete plans the one nearest the ballpark wins, and ties go to the
    incumbent so the earliest good plan is the one that is synthesised.
    """
    if not candidate.get("semanticAccepted"):
        return False
    if incumbent is None:
        return True
    return float(candidate["ballparkMiss"]) < float(incumbent["ballparkMiss"])


def ballpark_miss(planned_seconds: float, target_seconds: float) -> float:
    """How far outside the ballpark a plan sits, in seconds. Zero when inside.

    Used to rank plans, so the closest complete composition is the one that
    gets synthesised when no candidate lands inside the band.
    """
    low, high = duration_ballpark(target_seconds)
    planned = float(planned_seconds)
    if planned < low:
        return low - planned
    if planned > high:
        return planned - high
    return 0.0


def candidate_seed(seed: int, attempt_index: int) -> int:
    """Deterministically explore another composition without hidden randomness."""
    return (int(seed) + (SEED_STEP * int(attempt_index))) % SEED_MODULUS


def comfy_candidate_seed(seed: int, attempt_index: int) -> int:
    """Use the alternate-seed spacing proven by the direct ComfyUI gate."""
    return (int(seed) + (COMFY_SEED_STEP * int(attempt_index))) % SEED_MODULUS


def comfy_generation_ceiling(target: float, supplied_ceiling: float) -> float:
    """Return a hard safety ceiling, never a requested-song-length cutoff.

    ``MiniMaxMusic3TextEncode.max_duration`` is explicitly a maximum: the
    model emits its own end-of-song token earlier when the composition has
    resolved. Clamping that maximum close to the requested length turned the
    length control into a guillotine. Keep ``target`` in the signature for API
    compatibility, but let the structured caption carry that soft target and
    give the semantic planner all of the completion room the caller supplied.
    """
    del target
    return min(float(supplied_ceiling), MAX_SECONDS)


def semantic_plan_is_natural(planned_seconds: float, ceiling: float) -> bool:
    """True only when Music 3 emitted EOS before its hard safety ceiling."""
    return (float(ceiling) - float(planned_seconds)) > 0.75


def derive_sampling_seed(seed: int, *parts: str) -> int:
    """Match ComfyUI's MiniMax Music 3 random stream for a displayed seed."""
    digest = hashlib.blake2b(digest_size=8, person=b"minimax-ttm")
    digest.update(int(seed).to_bytes(8, "little", signed=False))
    for part in parts:
        value = str(part).encode("utf-8")
        digest.update(len(value).to_bytes(4, "little"))
        digest.update(value)
    return int.from_bytes(digest.digest(), "little") & ((1 << 63) - 1)


def clamp_plan_attempts(value) -> int:
    try:
        attempts = int(value)
    except (TypeError, ValueError):
        attempts = DEFAULT_PLAN_ATTEMPTS
    # A few alternate semantic preflights recover an unlucky plan without
    # turning a button click into seed roulette. Only the chosen plan is
    # synthesized, so the alternates never render or publish a cutoff.
    return max(1, min(MAX_PLAN_ATTEMPTS, attempts))


def _comfy_request(path: str, *, payload: dict | None = None, timeout: float = 30.0) -> bytes:
    """Call the local ComfyUI API without adding another Python dependency."""
    url = f"{COMFY_URL}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST" if payload is not None else "GET",
        headers={"Content-Type": "application/json"} if payload is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"ComfyUI HTTP {err.code} for {path}: {detail}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise RuntimeError(f"ComfyUI is unreachable at {COMFY_URL}: {err}") from err


def _comfy_json(path: str, *, payload: dict | None = None, timeout: float = 30.0) -> dict:
    raw = _comfy_request(path, payload=payload, timeout=timeout)
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise RuntimeError(f"ComfyUI returned invalid JSON for {path}.") from err
    if not isinstance(decoded, dict):
        raise RuntimeError(f"ComfyUI returned an unexpected response for {path}.")
    return decoded


def _comfy_available() -> tuple[bool, str | None]:
    try:
        info = _comfy_json("/object_info/MiniMaxMusic3TextEncode", timeout=5.0)
        if "MiniMaxMusic3TextEncode" not in info:
            return False, "ComfyUI does not expose MiniMaxMusic3TextEncode."
        return True, None
    except Exception as err:  # noqa: BLE001 - health reports the dependency failure
        return False, str(err)


def _comfy_plan_workflow(*, prompt: str, lyrics: str, ceiling: float, seed: int) -> dict:
    return {
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": COMFY_TEXT_ENCODER, "type": "minimax"},
        },
        "4": {
            "class_type": "MiniMaxMusic3TextEncode",
            "inputs": {
                "clip": ["2", 0],
                "caption": prompt,
                "lyrics": lyrics,
                "seed": int(seed),
                "max_duration": float(ceiling),
                "cfg_scale": 1.7,
                "top_k": 50,
            },
        },
        "10": {"class_type": "PreviewAny", "inputs": {"source": ["4", 1]}},
    }


def _comfy_render_workflow(
    *, prompt: str, lyrics: str, ceiling: float, seed: int, prefix: str
) -> dict:
    workflow = _comfy_plan_workflow(prompt=prompt, lyrics=lyrics, ceiling=ceiling, seed=seed)
    workflow.update(
        {
            "1": {
                "class_type": "UNETLoader",
                "inputs": {"unet_name": COMFY_DIFFUSION_MODEL, "weight_dtype": "default"},
            },
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": COMFY_VAE}},
            "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
            "6": {
                "class_type": "EmptyMiniMaxMusic3LatentAudio",
                "inputs": {"seconds": ["4", 1], "batch_size": 1},
            },
            "7": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["1", 0],
                    "positive": ["4", 0],
                    "negative": ["5", 0],
                    "latent_image": ["6", 0],
                    "seed": int(seed),
                    "steps": 30,
                    "cfg": 1.7,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1,
                },
            },
            "8": {
                "class_type": "VAEDecodeAudio",
                "inputs": {"samples": ["7", 0], "vae": ["3", 0]},
            },
            "9": {
                "class_type": "SaveAudioAdvanced",
                "inputs": {
                    "audio": ["8", 0],
                    "filename_prefix": prefix,
                    "format": "flac",
                },
            },
        }
    )
    return workflow


def _comfy_submit(workflow: dict) -> str:
    reply = _comfy_json(
        "/prompt",
        payload={"prompt": workflow, "client_id": str(uuid.uuid4())},
        timeout=30.0,
    )
    prompt_id = str(reply.get("prompt_id") or "")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI did not accept the Music 3 workflow: {str(reply)[:1000]}")
    return prompt_id


def _comfy_execution_error(entry: dict) -> str | None:
    for message in entry.get("status", {}).get("messages", []):
        if not isinstance(message, list) or len(message) < 2 or not isinstance(message[1], dict):
            continue
        payload = message[1]
        if payload.get("exception_message"):
            return str(payload["exception_message"])
    return None


def _wait_for_comfy(prompt_id: str, *, output: str, timeout: float) -> tuple[dict, object]:
    deadline = time.time() + timeout
    encoded = urllib.parse.quote(prompt_id, safe="")
    while time.time() < deadline:
        history = _comfy_json(f"/history/{encoded}", timeout=30.0)
        entry = history.get(prompt_id)
        if isinstance(entry, dict):
            error = _comfy_execution_error(entry)
            status = entry.get("status", {})
            if error or status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI Music 3 execution failed: {error or 'unknown execution error'}")
            if status.get("completed") or status.get("status_str") == "success":
                outputs = entry.get("outputs", {})
                if output == "plan":
                    values = outputs.get("10", {}).get("text", [])
                    seconds = float(values[0]) if values else 0.0
                    if seconds <= 0:
                        raise RuntimeError("ComfyUI Music 3 planner returned no duration.")
                    return entry, seconds
                for node in outputs.values():
                    audio = node.get("audio") if isinstance(node, dict) else None
                    if isinstance(audio, list) and audio:
                        return entry, audio[0]
                raise RuntimeError("ComfyUI Music 3 completed without an audio output.")
        time.sleep(0.5)
    raise RuntimeError(f"ComfyUI Music 3 {output} timed out after {timeout / 60.0:g} minutes.")


def _download_comfy_audio(output: dict) -> bytes:
    query = urllib.parse.urlencode(
        {
            "filename": str(output.get("filename") or ""),
            "subfolder": str(output.get("subfolder") or ""),
            "type": str(output.get("type") or "output"),
        }
    )
    return _comfy_request(f"/view?{query}", timeout=300.0)


def resolve_device(torch) -> str:
    """Resolve the requested device without changing the legacy CUDA default."""
    requested = DEVICE_REQUEST
    if requested == "auto":
        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(getattr(torch, "backends", None), "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
        return "cpu"

    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError(
                "MiniMax Music 3 was asked to use CUDA, but torch reports no CUDA device. "
                "Set MAXMUSIC_DEVICE=auto to try Apple MPS or CPU."
            )
        return "cuda"

    if requested == "mps":
        mps = getattr(getattr(torch, "backends", None), "mps", None)
        if mps is None or not mps.is_available():
            raise RuntimeError("MAXMUSIC_DEVICE=mps was requested, but torch reports no usable Apple MPS device.")
        return "mps"

    if requested == "cpu":
        return "cpu"

    raise RuntimeError(f"Unknown MAXMUSIC_DEVICE={requested!r}; use auto, cuda, mps, or cpu.")

# ---------------------------------------------------------------------------
# The model, kept warm across one editing session
# ---------------------------------------------------------------------------


class Studio:
    """Own the pipeline, keeping it warm until a safe idle boundary."""

    def __init__(self) -> None:
        self.pipe = None
        self.sampling_rate = 44100
        self.device = DEVICE_REQUEST
        self.offloaded = False
        self.note = None
        self.loading = False
        self.error: str | None = None
        self._lock = threading.Lock()
        self._timer_lock = threading.Lock()
        self._idle_timer: threading.Timer | None = None
        self.idle_release_at: float | None = None
        # One song at a time. The GPU cannot do two anyway, and queuing here
        # gives a clear answer instead of an out-of-memory crash.
        self.busy = threading.Lock()

    def status(self) -> dict:
        free_gb = None
        comfy_ok = None
        comfy_error = None
        if RUNTIME == "comfy":
            comfy_ok, comfy_error = _comfy_available()
        try:
            import torch

            if torch.cuda.is_available():
                free, _total = torch.cuda.mem_get_info()
                free_gb = round(free / 1024**3, 1)
        except Exception:  # noqa: BLE001 — status must never raise
            pass
        return {
            "ok": self.error is None and (RUNTIME != "comfy" or comfy_ok is True),
            "model": MODEL_ID if RUNTIME == "diffusers" else "MiniMax Music 3 via ComfyUI",
            "pipelineVersion": PIPELINE_VERSION,
            "runtime": RUNTIME,
            "loaded": self.pipe is not None if RUNTIME == "diffusers" else comfy_ok,
            "loading": self.loading,
            "busy": self.busy.locked(),
            "device": self.device if RUNTIME == "diffusers" else "cuda",
            "mpsDtype": MPS_DTYPE_REQUEST if self.device == "mps" else None,
            "offloaded": self.offloaded,
            "note": self.note,
            "comfyUrl": COMFY_URL if RUNTIME == "comfy" else None,
            "comfyReachable": comfy_ok,
            "comfyError": comfy_error,
            "vramFreeGb": free_gb,
            "idleReleaseSeconds": IDLE_RELEASE_SECONDS,
            "idleReleaseAt": self.idle_release_at,
            "minimumDurationControl": False,
            "naturalEndToken": True,
            "semanticPreflight": True,
            "comfySeedDerivation": True,
            "comfyRuntimePlanParity": RUNTIME == "comfy",
            "comfyRuntimePlanParityReason": None if RUNTIME == "comfy" else (
                "ComfyUI uses a pruned INT8 text encoder while this worker uses the official "
                "Diffusers checkpoint; RNG derivation matches, sampled plans can differ."
            ),
            "terminalOutroGuard": True,
            "acousticEndingGuard": True,
            "lyricCompletionGuard": VERIFY_LYRICS,
            "comfySeedStep": COMFY_SEED_STEP if RUNTIME == "comfy" else None,
            "comfyHeadroomPolicy": "full completion window; requested duration is a soft target" if RUNTIME == "comfy" else None,
            "lyricVerifier": LYRICS_VERIFIER.status(),
            "defaultPlanAttempts": DEFAULT_PLAN_ATTEMPTS,
            "error": self.error,
        }

    def cancel_idle_release(self) -> None:
        """Cancel a pending idle unload before the next render begins."""
        with self._timer_lock:
            timer = self._idle_timer
            self._idle_timer = None
            self.idle_release_at = None
        if timer is not None:
            timer.cancel()

    def schedule_idle_release(self) -> None:
        """Release VRAM later, never between back-to-back takes."""
        self.cancel_idle_release()
        if IDLE_RELEASE_SECONDS <= 0 or (RUNTIME == "diffusers" and self.pipe is None):
            return
        timer = threading.Timer(IDLE_RELEASE_SECONDS, self._release_if_idle)
        timer.daemon = True
        with self._timer_lock:
            self._idle_timer = timer
            self.idle_release_at = time.time() + IDLE_RELEASE_SECONDS
        timer.start()

    def _release_if_idle(self) -> None:
        # The same single-flight lock used by /generate closes the race where a
        # timer fires at the exact moment a new request arrives.
        if not self.busy.acquire(blocking=False):
            self.schedule_idle_release()
            return
        try:
            with self._timer_lock:
                self._idle_timer = None
                self.idle_release_at = None
            self.unload(reason=f"{IDLE_RELEASE_SECONDS:g}s idle")
        finally:
            self.busy.release()

    def unload(self, reason: str = "manual request") -> bool:
        """Drop pipeline references and return cached accelerator memory."""
        self.cancel_idle_release()
        if RUNTIME == "comfy":
            # ComfyUI's /free endpoint intentionally returns an empty 200
            # response. Treating every successful Comfy call as JSON made the
            # model unload correctly but then surfaced a false HTTP 500 to the
            # caller. This endpoint needs only the transport/status check.
            _comfy_request(
                "/free",
                payload={"unload_models": True, "free_memory": True},
                timeout=30.0,
            )
            self.note = f"ComfyUI models unloaded after {reason}; accelerator memory released."
            print(f"[worker] {self.note}", flush=True)
            return True
        with self._lock:
            pipe = self.pipe
            if pipe is None:
                return False
            self.pipe = None
            self.offloaded = False
            try:
                # Moving first helps ModularPipeline release component tensors
                # held behind manager hooks instead of only clearing the cache.
                pipe.to("cpu")
            except Exception as err:  # noqa: BLE001 — cleanup continues safely
                print(f"[worker] pipeline CPU move during unload: {type(err).__name__}: {err}", flush=True)
            del pipe
            gc.collect()

            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    ipc_collect = getattr(torch.cuda, "ipc_collect", None)
                    if callable(ipc_collect):
                        ipc_collect()
                mps = getattr(torch, "mps", None)
                if self.device == "mps" and mps is not None:
                    empty_cache = getattr(mps, "empty_cache", None)
                    if callable(empty_cache):
                        empty_cache()
            except Exception as err:  # noqa: BLE001 — never lose finished audio to cleanup
                print(f"[worker] accelerator cache cleanup: {type(err).__name__}: {err}", flush=True)
            self.note = f"Model unloaded after {reason}; accelerator memory released."
            print(f"[worker] {self.note}", flush=True)
            return True

    def load(self) -> None:
        """Bring the pipeline up, offloading only when the card needs it."""
        self.cancel_idle_release()
        if RUNTIME == "comfy":
            available, error = _comfy_available()
            if not available:
                raise RuntimeError(error or f"ComfyUI is unavailable at {COMFY_URL}.")
            self.note = f"Using the certified ComfyUI Music 3 runtime at {COMFY_URL}."
            return
        with self._lock:
            if self.pipe is not None:
                return
            self.loading = True
            self.error = None
            try:
                import torch
                from diffusers import ComponentsManager, ModularPipeline

                self.device = resolve_device(torch)

                # The CUDA path below is the established path used by the
                # existing local deployment. Native packaging opts into this
                # branch with MAXMUSIC_DEVICE=auto. MPS/CPU support depends on
                # the pinned diffusers pipeline and is intentionally reported
                # as experimental until it has been exercised with the model.
                if self.device != "cuda":
                    dtype = torch.float32
                    if self.device == "mps" and MPS_DTYPE_REQUEST in {"float16", "fp16", "half"}:
                        dtype = torch.float16
                    self.pipe = ModularPipeline.from_pretrained(MODEL_ID)
                    self.pipe.load_components(dtype=dtype)
                    self.pipe.to(self.device)
                    self.offloaded = False
                    self.sampling_rate = int(getattr(self.pipe, "sampling_rate", 44100))
                    self.note = (
                        f"{self.device} inference is experimental for MiniMax Music 3 and may be very slow."
                    )
                    print(f"[worker] ready · experimental {self.device} mode", flush=True)
                    return

                free, total = torch.cuda.mem_get_info()
                free_gb = free / 1024**3
                total_gb = total / 1024**3
                # ~23GB in bfloat16 with everything resident. Below that the
                # components go to the offloader rather than failing at the
                # first generation with an out-of-memory error.
                #
                # This asks what is FREE, and it is worth knowing why that is
                # a trap: whatever else is on the card at this instant decides
                # how the model runs for the life of the process. A neighbour
                # holding 4 GB while this loaded once put a 32 GB card on the
                # offload path, and a 90-second song took 23 minutes instead
                # of 90 seconds. The number cannot be ignored — loading full
                # into a card that is genuinely occupied just fails later —
                # but it CAN be said out loud, so the cause is never a mystery.
                needed_gb = 24.0
                roomy = free_gb >= needed_gb

                if not roomy and total_gb >= needed_gb:
                    print(
                        f"[worker] this card has {total_gb:.0f} GB but only {free_gb:.1f} GB is free, so the "
                        f"model is loading in offload mode, which is MUCH slower (minutes per minute of audio, "
                        f"not seconds). Free the card and restart the worker to run at full speed.",
                        flush=True,
                    )

                if roomy:
                    self.pipe = ModularPipeline.from_pretrained(MODEL_ID)
                    self.pipe.load_components(dtype=torch.bfloat16)
                    self.pipe.to("cuda")
                    self.offloaded = False
                else:
                    manager = ComponentsManager()
                    manager.enable_auto_cpu_offload(device="cuda")
                    self.pipe = ModularPipeline.from_pretrained(MODEL_ID, components_manager=manager)
                    self.pipe.load_components(dtype=torch.bfloat16)
                    self.offloaded = True
                    # Under ~22GB the language model has to stream layer by
                    # layer. Slower, but it runs on an 8GB card.
                    if free_gb < 22.0:
                        from diffusers.hooks.group_offloading import apply_group_offloading

                        apply_group_offloading(
                            self.pipe.language_model,
                            onload_device=torch.device("cuda"),
                            offload_type="leaf_level",
                            use_stream=True,
                        )

                self.sampling_rate = int(getattr(self.pipe, "sampling_rate", 44100))
                self.note = None if roomy else (
                    f"Loaded in offload mode: only {free_gb:.1f} GB of {total_gb:.0f} GB was free. "
                    "Songs will take minutes rather than seconds. Free the card and restart for full speed."
                )
                print(
                    f"[worker] ready · {'full speed' if roomy else 'offload mode'} · "
                    f"{free_gb:.1f} GB free of {total_gb:.0f} GB",
                    flush=True,
                )
            except Exception as err:  # noqa: BLE001 — reported, not raised, so /health can explain
                self.error = f"{type(err).__name__}: {err}"
                self.pipe = None
                raise
            finally:
                self.loading = False

    def _music_blocks(self):
        """Return the pinned Music 3 stages or fail loudly after an API change."""
        root = getattr(self.pipe, "_blocks", None)
        blocks = getattr(root, "sub_blocks", None)
        required = ("text_encoder", "semantic_generator", "prepare_chunks", "denoise", "decode")
        missing = [name for name in required if blocks is None or name not in blocks]
        if missing:
            raise RuntimeError(
                "The pinned Diffusers Music 3 block layout changed; semantic preflight cannot run "
                f"(missing: {', '.join(missing)}). Reinstall worker/requirements.txt before generating."
            )
        return root, blocks

    def _new_generator(self, torch, seed: int):
        # MPS does not expose the same generator surface as CUDA. A CPU
        # generator is accepted by the pipeline for the experimental native
        # path; CUDA retains the established generator behavior.
        generator_device = "cuda" if self.device == "cuda" else "cpu"
        return torch.Generator(generator_device).manual_seed(derive_sampling_seed(seed, "ar"))

    def _new_pipeline_state(self, *, prompt: str, lyrics: str, duration: float, generator):
        """Build the same defaulted state ModularPipeline.__call__ would build."""
        from diffusers.modular_pipelines.modular_pipeline import PipelineState

        root, _blocks = self._music_blocks()
        state = PipelineState()
        for expected in root.inputs:
            name = getattr(expected, "name", None)
            if name is None:
                continue
            state.set(
                name,
                getattr(expected, "default", None),
                getattr(expected, "kwargs_type", None),
            )
        state.set("prompt", prompt)
        state.set("lyrics", lyrics)
        state.set("audio_duration", float(duration))
        state.set("generator", generator)
        return state

    def _semantic_plan(
        self,
        *,
        prompt: str,
        lyrics: str,
        target_duration: float,
        ceiling: float,
        seed: int,
        attempt: int,
        torch,
    ):
        """Generate only the inexpensive semantic timeline and classify its end."""
        _root, blocks = self._music_blocks()
        generator = self._new_generator(torch, seed)
        state = self._new_pipeline_state(
            prompt=prompt,
            lyrics=lyrics,
            duration=ceiling,
            generator=generator,
        )
        started = time.time()
        try:
            for name in ("text_encoder", "semantic_generator"):
                _components, state = blocks[name](self.pipe, state)
        except ValueError as err:
            # Immediate EOS is a valid sampled composition decision, but it is
            # not a usable song. Let another deterministic seed have a turn.
            if "generated zero audio frames" not in str(err):
                raise
            summary = {
                "attempt": attempt,
                "seed": seed,
                "samplingSeed": str(derive_sampling_seed(seed, "ar")),
                "plannedSeconds": 0.0,
                "endReason": "empty",
                "semanticAccepted": False,
                "accepted": False,
                "elapsedSeconds": round(time.time() - started, 1),
            }
            return None, summary

        frame_hiddens = state.get("frame_hiddens")
        if frame_hiddens is None or getattr(frame_hiddens, "ndim", 0) < 2:
            raise RuntimeError("Music 3 semantic planning returned no frame timeline.")
        frame_rate = float(getattr(self.pipe, "frame_rate", 25.0))
        frame_count = int(frame_hiddens.shape[1])
        max_frames = min(int(float(ceiling) * frame_rate), MAX_AUDIO_FRAMES)
        planned_seconds = frame_count / frame_rate
        natural = semantic_plan_is_natural(planned_seconds, ceiling)
        accepted = natural
        summary = {
            "attempt": attempt,
            "seed": seed,
            "samplingSeed": str(derive_sampling_seed(seed, "ar")),
            "frames": frame_count,
            "maxFrames": max_frames,
            "plannedSeconds": round(planned_seconds, 3),
            "endReason": "eos" if natural else "ceiling",
            "semanticAccepted": accepted,
            "accepted": accepted,
            "elapsedSeconds": round(time.time() - started, 1),
        }
        return state, summary

    def _generate_comfy(
        self,
        *,
        prompt: str,
        lyrics: str,
        duration: float,
        target_duration: float,
        max_plan_attempts: int,
        minimum_duration: float,
        verify_lyrics: bool,
        seed: int | None,
    ) -> dict:
        """Run the exact ComfyUI graph that passed the independent 20-song gate."""
        import numpy as np
        import soundfile as sf

        self.cancel_idle_release()
        available, error = _comfy_available()
        if not available:
            raise RuntimeError(error or f"ComfyUI is unavailable at {COMFY_URL}.")

        started = time.time()
        ceiling = comfy_generation_ceiling(target_duration, duration)
        base_seed = (
            int(seed) % SEED_MODULUS
            if seed is not None
            else int.from_bytes(os.urandom(4), "big") % SEED_MODULUS
        )
        summaries: list[dict] = []
        chosen = None
        chosen_data = None
        ending_guard = None
        lyric_completion = None
        planning_seconds = 0.0
        synthesis_seconds = 0.0
        sample_rate = 44100

        # Plan first, every time, and only then render the plan that both ended
        # on its own and answered the length that was asked for. The planner is
        # a fraction of a render here too, and it is submitted to the same
        # ComfyUI graph with the same seed the render will use.
        best_summary = None
        for attempt_index in range(max_plan_attempts):
            plan_seed = comfy_candidate_seed(base_seed, attempt_index)
            plan_started = time.time()
            plan_prompt_id = _comfy_submit(
                _comfy_plan_workflow(
                    prompt=prompt,
                    lyrics=lyrics,
                    ceiling=ceiling,
                    seed=plan_seed,
                )
            )
            _entry, planned_seconds = _wait_for_comfy(
                plan_prompt_id,
                output="plan",
                timeout=10 * 60.0,
            )
            natural = semantic_plan_is_natural(planned_seconds, ceiling)
            semantic_accepted = natural
            miss = ballpark_miss(planned_seconds, target_duration)
            summary = {
                "attempt": attempt_index + 1,
                "seed": plan_seed,
                "samplingSeed": str(plan_seed),
                "frames": int(round(float(planned_seconds) * 25.0)),
                "maxFrames": int(round(float(ceiling) * 25.0)),
                "plannedSeconds": round(float(planned_seconds), 3),
                "endReason": "eos" if natural else "ceiling",
                "semanticAccepted": semantic_accepted,
                "ballparkMiss": round(miss, 3),
                "inBallpark": bool(semantic_accepted) and miss <= 0.0,
                "accepted": semantic_accepted,
                "elapsedSeconds": round(time.time() - plan_started, 1),
                "comfyPlanPromptId": plan_prompt_id,
            }
            planning_seconds += time.time() - plan_started
            summaries.append(summary)
            print(
                f"[comfy-plan] attempt={summary['attempt']}/{max_plan_attempts} seed={plan_seed} "
                f"target={target_duration:g}s ceiling={ceiling:g}s "
                f"planned={summary['plannedSeconds']:g}s end={summary['endReason']} "
                f"semanticAccepted={summary['semanticAccepted']} "
                f"inBallpark={summary['inBallpark']} miss={summary['ballparkMiss']:g}s "
                f"elapsed={summary['elapsedSeconds']:g}s",
                flush=True,
            )
            if not semantic_accepted:
                continue
            if plan_beats(summary, best_summary):
                best_summary = summary
            if summary["inBallpark"]:
                break

        if best_summary is not None:
            summary = best_summary
            plan_seed = summary["seed"]
            if not summary["inBallpark"]:
                low, high = duration_ballpark(target_duration)
                print(
                    f"[comfy-plan] no plan landed in the {low:g}-{high:g}s ballpark for a "
                    f"{target_duration:g}s request. Rendering the closest complete "
                    f"composition at {summary['plannedSeconds']:g}s.",
                    flush=True,
                )

            synthesis_started = time.time()
            render_prompt_id = _comfy_submit(
                _comfy_render_workflow(
                    prompt=prompt,
                    lyrics=lyrics,
                    ceiling=ceiling,
                    seed=plan_seed,
                    prefix=f"audio/maxmusic-native/{uuid.uuid4().hex[:16]}",
                )
            )
            _entry, remote_output = _wait_for_comfy(
                render_prompt_id,
                output="audio",
                timeout=45 * 60.0,
            )
            if not isinstance(remote_output, dict):
                raise RuntimeError("ComfyUI returned malformed Music 3 audio metadata.")
            audio_bytes = _download_comfy_audio(remote_output)
            wave, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
            data = np.asarray(wave, dtype=np.float32).T
            if not data.size or not np.isfinite(data).all():
                raise RuntimeError("ComfyUI Music 3 returned invalid audio.")
            peak = float(np.max(np.abs(data)))
            rms = float(np.sqrt(np.mean(np.square(data, dtype=np.float64))))
            if peak < 1e-4 or rms < 1e-5:
                raise RuntimeError("ComfyUI Music 3 returned silent audio.")

            data, candidate_ending = finish_waveform(data, int(sample_rate), np)
            candidate_synthesis_seconds = time.time() - synthesis_started
            synthesis_seconds += candidate_synthesis_seconds
            summary.update(
                {
                    "synthesisSeconds": round(candidate_synthesis_seconds, 1),
                    "acousticEnding": candidate_ending,
                    "comfyRenderPromptId": render_prompt_id,
                    "comfyOutput": remote_output,
                }
            )

            if verify_lyrics:
                try:
                    completion = LYRICS_VERIFIER.verify(data, int(sample_rate), lyrics, np)
                except Exception as err:  # noqa: BLE001 — ASR is evidence, not song validity
                    completion = lyric_verifier_unavailable(err)
                summary["lyricCompletion"] = completion
                print(
                    f"[lyrics] attempt={summary['attempt']}/{max_plan_attempts} seed={summary['seed']} "
                    f"verdict={completion['verdict']} "
                    f"coverage={completion.get('orderedLyricCoverage', {}).get('ratio', 0):.3f} "
                    f"terminal={completion.get('terminalCoverage', {}).get('ratio', 0):.3f} "
                    f"elapsed={completion.get('elapsedSeconds', 0):g}s",
                    flush=True,
                )
                # Whisper is deliberately advisory. Sung diction, effects and
                # near-homophones routinely change one or two ASR tokens. EOS
                # plus the acoustic boundary are the actual cutoff safeguards;
                # a fallible transcript must never discard a finished song.
                summary["lyricVerificationAdvisory"] = completion["verdict"] != "pass"
            else:
                completion = {
                    "verdict": "not-applicable",
                    "reason": "instrumental",
                    "expectedTerminalWords": [],
                    "orderedLyricCoverage": {
                        "matchedWords": 0,
                        "expectedWords": 0,
                        "heardWords": 0,
                        "ratio": 1.0,
                    },
                }
                summary["lyricCompletion"] = completion

            summary["accepted"] = True
            chosen = summary
            chosen_data = np.asarray(data, dtype=np.float32).copy()
            ending_guard = candidate_ending
            lyric_completion = completion

        if chosen_data is None or chosen is None or ending_guard is None or lyric_completion is None:
            outcomes = "; ".join(
                f"seed {item['seed']}: {item.get('rejectionReason') or item['endReason']} "
                f"at {item['plannedSeconds']:g}s"
                for item in summaries
            )
            print(f"[comfy-plan] no natural EOS before hard ceiling. Plans: {outcomes}", flush=True)
            raise RuntimeError(
                "MiniMax Music 3 reached its five-minute hard limit before the song ended naturally. "
                "No incomplete track was saved."
            )

        acoustic_ending_pass = ending_guard["after"]["signalVerdict"] == "pass"
        lyric_completion_pass = lyric_completion["verdict"] in {"pass", "not-applicable"}
        output_wave = chosen_data.T
        TRACKS_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex[:20]}.flac"
        sf.write(TRACKS_DIR / name, output_wave, int(sample_rate), format="FLAC")
        seconds = output_wave.shape[0] / float(sample_rate)
        self.sampling_rate = int(sample_rate)
        self.note = f"Using the certified ComfyUI Music 3 runtime at {COMFY_URL}."

        return {
            "track": {"url": f"/tracks/{name}", "filename": name, "id": name.rsplit(".", 1)[0]},
            "extra_info": {
                "music_duration": round(seconds * 1000),
                "music_sample_rate": int(sample_rate),
                "music_channel": int(output_wave.shape[1]),
                "requested_duration_seconds": float(target_duration),
                "generation_ceiling_seconds": float(ceiling),
                "planned_duration_seconds": chosen["plannedSeconds"],
                "duration_ballpark_seconds": list(duration_ballpark(target_duration)),
                "duration_in_ballpark": bool(chosen.get("inBallpark")),
                "duration_end_reason": "eos",
                "generation_seed": chosen["seed"],
                "planning_attempts": chosen["attempt"],
                "pipeline_version": PIPELINE_VERSION,
                "runtime": RUNTIME,
                "terminal_outro_guard": True,
                "acoustic_ending_guard": ending_guard["action"],
                "acoustic_ending_pass": acoustic_ending_pass,
                "lyric_completion_guard": lyric_completion["verdict"],
                "lyric_completion_policy": "advisory",
                "lyric_completion_pass": lyric_completion_pass,
                "ending_fade_seconds": ending_guard["fadeSeconds"],
                "comfy_prompt_id": chosen.get("comfyRenderPromptId"),
            },
            "askedSeconds": float(target_duration),
            "requestedSeconds": float(target_duration),
            "generationCeiling": float(ceiling),
            "generationSeed": chosen["seed"],
            "generationAttempts": chosen["attempt"],
            "durationEndReason": "eos",
            "plannedSeconds": chosen["plannedSeconds"],
            "plannedInBallpark": bool(chosen.get("inBallpark")),
            "durationBallpark": list(duration_ballpark(target_duration)),
            "planCandidates": summaries,
            "pipelineVersion": PIPELINE_VERSION,
            "runtime": RUNTIME,
            "comfyRuntimePlanParity": True,
            "terminalOutroGuard": True,
            "endingGuard": ending_guard,
            "acousticEndingPass": acoustic_ending_pass,
            "lyricCompletionGuard": True,
            "lyricCompletionPolicy": "advisory",
            "lyricCompletion": lyric_completion,
            "lyricCompletionPass": lyric_completion_pass,
            "minimumSeconds": 0.0,
            "ignoredMinimumSeconds": float(minimum_duration),
            "planningSeconds": round(planning_seconds, 1),
            "synthesisSeconds": round(synthesis_seconds, 1),
            "renderSeconds": round(time.time() - started, 1),
        }

    def generate(
        self,
        *,
        prompt: str,
        lyrics: str,
        duration: float,
        target_duration: float,
        max_plan_attempts: int,
        minimum_duration: float,
        verify_lyrics: bool,
        seed: int | None,
    ) -> dict:
        """Publish only a natural plan with a certified acoustic boundary.

        CPU ASR remains attached as useful lyric-completion evidence, but it is
        not authoritative enough to veto a semantically and acoustically
        complete song.
        """
        if RUNTIME == "comfy":
            return self._generate_comfy(
                prompt=prompt,
                lyrics=lyrics,
                duration=duration,
                target_duration=target_duration,
                max_plan_attempts=max_plan_attempts,
                minimum_duration=minimum_duration,
                verify_lyrics=verify_lyrics,
                seed=seed,
            )

        import numpy as np
        import soundfile as sf
        import torch

        self.cancel_idle_release()
        if self.pipe is None:
            self.load()

        started = time.time()
        planning_started = time.time()
        base_seed = int(seed) % SEED_MODULUS if seed is not None else int.from_bytes(os.urandom(4), "big") % SEED_MODULUS
        summaries: list[dict] = []
        chosen = None
        chosen_data = None
        ending_guard = None
        lyric_completion = None
        synthesis_seconds = 0.0

        # `audio_duration` is only a frame ceiling. We first run the language
        # model stages used by the official ComfyUI workflow and inspect whether
        # the sampled composition emitted its own audio-end token, and whether
        # it did so anywhere near the length that was asked for. Planning is the
        # cheap half of a render, so an unlucky seed is answered by planning
        # again rather than by publishing a fifty-second answer to a five-minute
        # request. Only the winning plan is ever synthesised.
        best_state = None
        best_summary = None
        for attempt_index in range(max_plan_attempts):
            plan_seed = candidate_seed(base_seed, attempt_index)
            state, summary = self._semantic_plan(
                prompt=prompt,
                lyrics=lyrics,
                target_duration=target_duration,
                ceiling=duration,
                seed=plan_seed,
                attempt=attempt_index + 1,
                torch=torch,
            )
            miss = ballpark_miss(summary["plannedSeconds"], target_duration)
            summary["ballparkMiss"] = round(miss, 3)
            summary["inBallpark"] = bool(summary["semanticAccepted"]) and miss <= 0.0
            summaries.append(summary)
            print(
                f"[plan] attempt={summary['attempt']}/{max_plan_attempts} seed={plan_seed} "
                f"target={target_duration:g}s ceiling={duration:g}s "
                f"planned={summary['plannedSeconds']:g}s end={summary['endReason']} "
                f"semanticAccepted={summary['semanticAccepted']} "
                f"inBallpark={summary['inBallpark']} miss={summary['ballparkMiss']:g}s "
                f"elapsed={summary['elapsedSeconds']:g}s",
                flush=True,
            )
            if not summary["semanticAccepted"]:
                del state
                gc.collect()
                continue

            if plan_beats(summary, best_summary):
                if best_state is not None:
                    del best_state
                    gc.collect()
                best_state, best_summary = state, summary
            else:
                del state
                gc.collect()
            if summary["inBallpark"]:
                break

        if best_state is not None and best_summary is not None:
            state = best_state
            summary = best_summary
            if not summary["inBallpark"]:
                print(
                    f"[plan] no plan landed in the {duration_ballpark(target_duration)[0]:g}"
                    f"-{duration_ballpark(target_duration)[1]:g}s ballpark for a "
                    f"{target_duration:g}s request. Synthesising the closest complete "
                    f"composition at {summary['plannedSeconds']:g}s.",
                    flush=True,
                )

            synthesis_started = time.time()
            _root, blocks = self._music_blocks()
            for name in ("prepare_chunks", "denoise", "decode"):
                _components, state = blocks[name](self.pipe, state)
            audios = state.get("audios")
            if audios is None or len(audios) == 0:
                raise RuntimeError("Music 3 synthesis completed without returning audio.")
            audio = audios[0]

            # (channels, samples) -> soundfile wants (samples, channels)
            data = np.asarray(audio)
            if data.ndim == 1:
                data = data[None, :]
            if not data.size or not np.isfinite(data).all():
                raise RuntimeError(f"MiniMax Music 3 returned invalid audio on {self.device}.")
            peak = float(np.max(np.abs(data)))
            rms = float(np.sqrt(np.mean(np.square(data, dtype=np.float64))))
            if peak < 1e-4 or rms < 1e-5:
                raise RuntimeError(
                    f"MiniMax Music 3 returned silent audio on {self.device}. "
                    "Try MAXMUSIC_DEVICE=cuda, or MAXMUSIC_DEVICE=cpu if this machine has no supported GPU."
                )
            data, candidate_ending = finish_waveform(data, self.sampling_rate, np)
            candidate_synthesis_seconds = time.time() - synthesis_started
            synthesis_seconds += candidate_synthesis_seconds
            summary["synthesisSeconds"] = round(candidate_synthesis_seconds, 1)
            summary["acousticEnding"] = candidate_ending

            if verify_lyrics:
                try:
                    completion = LYRICS_VERIFIER.verify(data, self.sampling_rate, lyrics, np)
                except Exception as err:  # noqa: BLE001 — ASR is evidence, not song validity
                    completion = lyric_verifier_unavailable(err)
                summary["lyricCompletion"] = completion
                print(
                    f"[lyrics] attempt={summary['attempt']}/{max_plan_attempts} seed={summary['seed']} "
                    f"verdict={completion['verdict']} "
                    f"coverage={completion.get('orderedLyricCoverage', {}).get('ratio', 0):.3f} "
                    f"terminal={completion.get('terminalCoverage', {}).get('ratio', 0):.3f} "
                    f"elapsed={completion.get('elapsedSeconds', 0):g}s",
                    flush=True,
                )
                summary["lyricVerificationAdvisory"] = completion["verdict"] != "pass"
            else:
                completion = {
                    "verdict": "not-applicable",
                    "reason": "instrumental",
                    "expectedTerminalWords": [],
                }
                summary["lyricCompletion"] = completion

            summary["accepted"] = True
            chosen = summary
            chosen_data = np.asarray(data, dtype=np.float32).copy()
            ending_guard = candidate_ending
            lyric_completion = completion
            del state, best_state, audios, audio, data
            best_state = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        if chosen_data is None or chosen is None or ending_guard is None or lyric_completion is None:
            outcomes = "; ".join(
                f"seed {item['seed']}: {item.get('rejectionReason') or item['endReason']} "
                f"at {item['plannedSeconds']:g}s"
                for item in summaries
            )
            print(f"[plan] no natural EOS before hard ceiling. Plans: {outcomes}", flush=True)
            raise RuntimeError(
                "MiniMax Music 3 reached its five-minute hard limit before the song ended naturally. "
                "No incomplete track was saved."
            )

        planning_seconds = time.time() - planning_started
        acoustic_ending_pass = ending_guard["after"]["signalVerdict"] == "pass"
        lyric_completion_pass = lyric_completion["verdict"] in {"pass", "not-applicable"}
        wave = chosen_data.T

        TRACKS_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex[:20]}.flac"
        path = TRACKS_DIR / name
        sf.write(path, wave, self.sampling_rate, format="FLAC")

        seconds = wave.shape[0] / float(self.sampling_rate)
        return {
            "track": {"url": f"/tracks/{name}", "filename": name, "id": name.rsplit(".", 1)[0]},
            "extra_info": {
                # MEASURED, not the number that was asked for. See the note at
                # the top of this file.
                "music_duration": round(seconds * 1000),
                "music_sample_rate": self.sampling_rate,
                "music_channel": int(wave.shape[1]),
                "requested_duration_seconds": float(target_duration),
                "generation_ceiling_seconds": float(duration),
                "planned_duration_seconds": chosen["plannedSeconds"],
                "duration_ballpark_seconds": list(duration_ballpark(target_duration)),
                "duration_in_ballpark": bool(chosen.get("inBallpark")),
                "duration_end_reason": "eos",
                "generation_seed": chosen["seed"],
                "planning_attempts": chosen["attempt"],
                "pipeline_version": PIPELINE_VERSION,
                "terminal_outro_guard": True,
                "acoustic_ending_guard": ending_guard["action"],
                "acoustic_ending_pass": acoustic_ending_pass,
                "lyric_completion_guard": lyric_completion["verdict"],
                "lyric_completion_policy": "advisory",
                "lyric_completion_pass": lyric_completion_pass,
                "ending_fade_seconds": ending_guard["fadeSeconds"],
            },
            "askedSeconds": float(target_duration),
            "requestedSeconds": float(target_duration),
            "generationCeiling": float(duration),
            "generationSeed": chosen["seed"],
            "generationAttempts": chosen["attempt"],
            "durationEndReason": "eos",
            "plannedSeconds": chosen["plannedSeconds"],
            "plannedInBallpark": bool(chosen.get("inBallpark")),
            "durationBallpark": list(duration_ballpark(target_duration)),
            "planCandidates": summaries,
            "pipelineVersion": PIPELINE_VERSION,
            "terminalOutroGuard": True,
            "endingGuard": ending_guard,
            "acousticEndingPass": acoustic_ending_pass,
            "lyricCompletionGuard": True,
            "lyricCompletionPolicy": "advisory",
            "lyricCompletion": lyric_completion,
            "lyricCompletionPass": lyric_completion_pass,
            "minimumSeconds": 0.0,
            "ignoredMinimumSeconds": float(minimum_duration),
            "planningSeconds": round(planning_seconds, 1),
            "synthesisSeconds": round(synthesis_seconds, 1),
            "renderSeconds": round(time.time() - started, 1),
        }


STUDIO = Studio()

# ---------------------------------------------------------------------------
# Lyrics hygiene
#
# The checkpoint's input contract is strict in one specific way: a structure
# tag owns its line. Canonicalize tags here so "[verse] Sun came up…" keeps the
# words and so native Diffusers receives the exact section whitespace used by
# the independently accepted ComfyUI path.
# ---------------------------------------------------------------------------

LYRIC_TAG_SPLIT = re.compile(r"\s*(\[[^\]]+\])\s*")


def tidy_lyrics(text: str) -> str:
    # Match ComfyUI's proven Music 3 prompt path exactly: every structure tag
    # owns a line and surrounding whitespace is removed. Diffusers performs its
    # own final normalization after this, so the assembled prompt now receives
    # the same section boundaries in both runtimes.
    source = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    parts = LYRIC_TAG_SPLIT.split(source)
    return "\n".join(
        part.lower() if part.startswith("[") else part
        for part in parts
        if part
    ).strip()


def normalize_song_ending(text: str) -> str:
    """Make ``[outro]`` the final section without changing lyric words.

    Music 3 treats section tags as arrangement instructions. A sheet ending
    ``[outro] ... [instrumental]`` asks it to resolve and then begin another
    section, which made otherwise complete lyrics land against the frame
    ceiling. Move the last existing outro block to the end, or add a bare
    terminal outro when a direct API caller supplied none.
    """
    source = tidy_lyrics(text)
    if not source:
        return source

    blocks: list[dict] = []
    current = {"tag": "", "lines": []}

    def keep(block: dict) -> bool:
        return bool(block["tag"] or any(str(line).strip() for line in block["lines"]))

    for line in source.split("\n"):
        if re.fullmatch(r"\[[^\]]+\]", line.strip()):
            if keep(current):
                blocks.append(current)
            current = {"tag": line.strip().lower(), "lines": []}
        else:
            current["lines"].append(line)
    if keep(current):
        blocks.append(current)

    outro_index = next(
        (index for index in range(len(blocks) - 1, -1, -1) if blocks[index]["tag"] == "[outro]"),
        -1,
    )
    if outro_index >= 0 and outro_index != len(blocks) - 1:
        blocks.append(blocks.pop(outro_index))
    elif outro_index < 0:
        blocks.append({"tag": "[outro]", "lines": []})

    return "\n".join(
        line
        for block in blocks
        for line in ([block["tag"]] if block["tag"] else []) + block["lines"]
        if line
    ).strip()


WORD_PATTERN = re.compile(r"[^\W_]+(?:['’\-][^\W_]+)*", re.UNICODE)


def normal_words(value: str) -> list[str]:
    """Reduce lyrics and ASR text to comparable Unicode word tokens."""
    return [word.casefold() for word in WORD_PATTERN.findall(str(value or ""))]


def terminal_lyric_words(lyrics: str, *, maximum: int = 12) -> list[str]:
    """Return the final sung line, extending one line back when it is tiny."""
    lines = [
        line.strip()
        for line in normalize_song_ending(lyrics).splitlines()
        if line.strip() and not re.fullmatch(r"\[[^\]]+\]", line.strip())
    ]
    if not lines:
        return []
    words = normal_words(lines[-1])
    index = len(lines) - 2
    while len(words) < 5 and index >= 0:
        words = normal_words(lines[index]) + words
        index -= 1
    return words[-maximum:]


def all_lyric_words(lyrics: str) -> list[str]:
    """Return sung words only; section tags are model instructions, not lyrics."""
    lines = [
        line
        for line in normalize_song_ending(lyrics).splitlines()
        if line.strip() and not re.fullmatch(r"\[[^\]]+\]", line.strip())
    ]
    return normal_words("\n".join(lines))


def ordered_word_coverage(expected: list[str], heard: list[str]) -> dict:
    """Longest ordered overlap, used because singing ASR may miss one word."""
    if not expected:
        return {"matchedWords": 0, "expectedWords": 0, "heardWords": len(heard), "ratio": 1.0}
    previous = [0] * (len(heard) + 1)
    for expected_word in expected:
        current = [0] * (len(heard) + 1)
        for index, heard_word in enumerate(heard, start=1):
            current[index] = (
                previous[index - 1] + 1
                if expected_word == heard_word
                else max(previous[index], current[index - 1])
            )
        previous = current
    matched = previous[-1]
    return {
        "matchedWords": matched,
        "expectedWords": len(expected),
        "heardWords": len(heard),
        "ratio": round(matched / len(expected), 3),
    }


def contiguous_sequence(haystack: list[str], needle: list[str]) -> bool:
    if not needle or len(haystack) < len(needle):
        return False
    return any(
        haystack[start : start + len(needle)] == needle
        for start in range(len(haystack) - len(needle) + 1)
    )


def best_terminal_phrase_match(expected: list[str], heard: list[str]) -> dict:
    """Find a near-verbatim terminal phrase while tolerating ASR spelling.

    Whisper commonly hears sung plurals as singulars and drops a quiet final
    consonant (for example, absences -> absence and chord -> core). Character
    similarity across the whole ordered phrase is much stronger evidence than
    requiring every individual ASR token to be exact. Candidates must still
    finish within the final few transcript words.
    """
    if not expected or not heard:
        return {"similarity": 0.0, "phrase": [], "endGapWords": len(heard)}
    expected_text = " ".join(expected)
    minimum = max(1, len(expected) - 2)
    maximum = min(len(heard), len(expected) + 2)
    best = {"similarity": 0.0, "phrase": [], "endGapWords": len(heard)}
    earliest_end = max(1, len(heard) - 4)
    for end in range(earliest_end, len(heard) + 1):
        for size in range(minimum, maximum + 1):
            start = end - size
            if start < 0:
                continue
            candidate = heard[start:end]
            similarity = SequenceMatcher(
                None,
                expected_text,
                " ".join(candidate),
                autojunk=False,
            ).ratio()
            if similarity > best["similarity"]:
                best = {
                    "similarity": round(similarity, 3),
                    "phrase": candidate,
                    "endGapWords": len(heard) - end,
                }
    return best


def assess_lyric_completion(lyrics: str, transcript: str) -> dict:
    """Require the last written lyric to be audibly present near song end."""
    expected = terminal_lyric_words(lyrics)
    heard = normal_words(transcript)
    terminal_window = heard[-max(36, len(expected) * 4) :]
    coverage = ordered_word_coverage(expected, terminal_window)
    anchor_size = min(4, len(expected))
    anchor = expected[-anchor_size:] if anchor_size else []
    anchor_coverage = ordered_word_coverage(anchor, terminal_window)
    exact_line = contiguous_sequence(terminal_window, expected)
    exact_anchor = contiguous_sequence(terminal_window, anchor)
    final_word_near_end = bool(expected) and expected[-1] in terminal_window[-8:]
    fuzzy_line = best_terminal_phrase_match(expected, terminal_window)
    fuzzy_line_near_end = fuzzy_line["similarity"] >= 0.88 and fuzzy_line["endGapWords"] <= 4
    passed = bool(expected) and (
        exact_line
        or fuzzy_line_near_end
        or (
            coverage["ratio"] >= 0.8
            and anchor_coverage["ratio"] >= 0.75
            and final_word_near_end
        )
    )
    return {
        "verdict": "pass" if passed else "fail",
        "reason": (
            "terminal-lyric-heard"
            if passed
            else ("no-terminal-lyric" if not expected else "terminal-lyric-missing")
        ),
        "expectedTerminalWords": expected,
        "terminalCoverage": coverage,
        "terminalAnchorCoverage": anchor_coverage,
        "exactTerminalLine": exact_line,
        "exactTerminalAnchor": exact_anchor,
        "fuzzyTerminalSimilarity": fuzzy_line["similarity"],
        "fuzzyTerminalPhrase": fuzzy_line["phrase"],
        "fuzzyTerminalEndGapWords": fuzzy_line["endGapWords"],
        "finalWordNearEnd": final_word_near_end,
        "heardTail": terminal_window[-24:],
    }


def lyric_verifier_unavailable(error: Exception) -> dict:
    """Represent an ASR outage without turning it into a render failure."""
    return {
        "verdict": "unavailable",
        "reason": "lyric-verifier-unavailable",
        "expectedTerminalWords": [],
        "terminalCoverage": {
            "matchedWords": 0,
            "expectedWords": 0,
            "heardWords": 0,
            "ratio": 0.0,
        },
        "orderedLyricCoverage": {
            "matchedWords": 0,
            "expectedWords": 0,
            "heardWords": 0,
            "ratio": 0.0,
        },
        "fullTrackCoveragePass": False,
        "elapsedSeconds": 0.0,
        "error": f"{type(error).__name__}: {error}"[:240],
    }


def lyric_verification_windows(total_samples: int, chunk_samples: int) -> list[tuple[int, int, str]]:
    """Cover the full song and always add a context-rich tail-aligned window."""
    total = max(0, int(total_samples))
    size = max(1, int(chunk_samples))
    if total <= 0:
        return []
    windows = [
        (start, min(total, start + size), "coverage")
        for start in range(0, total, size)
    ]
    tail_start = max(0, total - size)
    if windows[-1][0] == tail_start:
        start, end, _purpose = windows[-1]
        windows[-1] = (start, end, "coverage-and-terminal")
    else:
        windows.append((tail_start, total, "terminal-tail"))
    return windows


class LyricsVerifier:
    """Lazy Whisper analyzer for lyric completion.

    It prefers the accelerator that just made the song — `small` in float16 is
    a rounding error beside a resident Music 3, and an order of magnitude
    quicker than the CPU — and drops to the CPU whenever that is not possible,
    so a small card costs time rather than the check.
    """

    def __init__(self) -> None:
        self.model = None
        self.loading = False
        self.device: str | None = None
        self.compute_type: str | None = None
        self.error: str | None = None
        self._lock = threading.Lock()

    def status(self) -> dict:
        planned = whisper_device_order()[0]
        return {
            "enabled": VERIFY_LYRICS,
            "loaded": self.model is not None,
            "loading": self.loading,
            "model": WHISPER_MODEL,
            "device": self.device or planned[0],
            "computeType": self.compute_type or planned[1],
            "deviceRequest": WHISPER_DEVICE_REQUEST,
            "tailSeconds": WHISPER_TAIL_SECONDS,
            "chunkSeconds": WHISPER_TAIL_SECONDS,
            "fullTrackCoverage": True,
            "policy": "advisory",
            "error": self.error,
        }

    def load(self):
        if not VERIFY_LYRICS:
            raise RuntimeError("MAXMUSIC_VERIFY_LYRICS is disabled.")
        with self._lock:
            if self.model is not None:
                return self.model
            self.loading = True
            self.error = None
            try:
                from faster_whisper import WhisperModel

                cache = os.environ.get("MAXMUSIC_WHISPER_CACHE")
                if not cache and os.environ.get("HF_HOME"):
                    cache = str(Path(os.environ["HF_HOME"]) / "faster-whisper")
                last = None
                for device, compute_type in whisper_device_order():
                    try:
                        self.model = WhisperModel(
                            WHISPER_MODEL,
                            device=device,
                            compute_type=compute_type,
                            cpu_threads=WHISPER_THREADS,
                            download_root=cache,
                        )
                    except Exception as err:  # noqa: BLE001 — try the next device
                        last = err
                        print(
                            f"[lyrics] verifier cannot use {device} ({compute_type}): "
                            f"{type(err).__name__}: {err}",
                            flush=True,
                        )
                        continue
                    try:
                        # Constructing proves nothing: CTranslate2 defers its
                        # CUDA libraries to the first encoder pass. Run one on a
                        # second of silence so a failure can still be answered
                        # with the CPU instead of with a half-checked song.
                        import numpy as _np

                        probe, _ = self.model.transcribe(
                            _np.zeros(16000, dtype=_np.float32),
                            beam_size=1,
                            without_timestamps=True,
                        )
                        for _ in probe:
                            break
                    except Exception as err:  # noqa: BLE001 — try the next device
                        last = err
                        self.model = None
                        print(
                            f"[lyrics] verifier cannot run on {device}: "
                            f"{type(err).__name__}: {err}",
                            flush=True,
                        )
                        continue
                    self.device = device
                    self.compute_type = compute_type
                    detail = f"{WHISPER_THREADS} threads" if device == "cpu" else compute_type
                    print(
                        f"[lyrics] verifier ready · {WHISPER_MODEL} · {device} · {detail}",
                        flush=True,
                    )
                    return self.model
                raise RuntimeError(f"no Whisper backend would start. Last error: {last}")
            except Exception as err:  # noqa: BLE001 — generation must fail closed
                self.error = f"{type(err).__name__}: {err}"
                self.model = None
                self.device = None
                self.compute_type = None
                raise RuntimeError(
                    "The local lyric-completion verifier could not start. "
                    f"{self.error}"
                ) from err
            finally:
                self.loading = False

    def verify(self, data, sample_rate: int, lyrics: str, np) -> dict:
        terminal_expected = terminal_lyric_words(lyrics)
        expected_song = all_lyric_words(lyrics)
        if not terminal_expected or not expected_song:
            raise RuntimeError(
                "A vocal song needs a final lyric line so MaxMusic can prove that its ending is complete."
            )
        model = self.load()
        wave = np.asarray(data, dtype=np.float32)
        if wave.ndim == 2:
            mono = np.mean(wave, axis=0, dtype=np.float32)
        elif wave.ndim == 1:
            mono = wave
        else:
            raise RuntimeError("The lyric verifier received malformed audio.")

        if sample_rate != 16000:
            output_samples = max(1, int(round(mono.shape[0] * 16000.0 / float(sample_rate))))
            source_positions = np.arange(mono.shape[0], dtype=np.float64)
            target_positions = np.linspace(0, max(0, mono.shape[0] - 1), output_samples, dtype=np.float64)
            mono = np.interp(target_positions, source_positions, mono).astype(np.float32)

        started = time.time()
        chunk_samples = max(1, int(round(WHISPER_TAIL_SECONDS * 16000.0)))
        coverage_texts: list[str] = []
        terminal_text = ""
        chunks: list[dict] = []
        last_info = None
        for start, end, purpose in lyric_verification_windows(mono.shape[0], chunk_samples):
            segments, info = model.transcribe(
                mono[start:end],
                beam_size=5,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            text = " ".join(str(segment.text or "").strip() for segment in segments).strip()
            if purpose in {"coverage", "coverage-and-terminal"}:
                coverage_texts.append(text)
            if purpose in {"terminal-tail", "coverage-and-terminal"}:
                terminal_text = text
            chunks.append(
                {
                    "startSeconds": round(start / 16000.0, 3),
                    "durationSeconds": round((end - start) / 16000.0, 3),
                    "purpose": purpose,
                    "transcriptCharacters": len(text),
                    "transcriptTail": text[-160:],
                }
            )
            last_info = info

        transcript = " ".join(text for text in coverage_texts if text).strip()
        result = assess_lyric_completion(lyrics, terminal_text or transcript)
        terminal_pass = result["verdict"] == "pass"
        song_coverage = ordered_word_coverage(expected_song, normal_words(transcript))
        coverage_pass = song_coverage["ratio"] >= 0.7
        result["terminalVerdict"] = result["verdict"]
        result["orderedLyricCoverage"] = song_coverage
        result["fullTrackCoveragePass"] = coverage_pass
        result["verdict"] = "pass" if terminal_pass and coverage_pass else "fail"
        if not terminal_pass:
            result["reason"] = "terminal-lyric-missing"
        elif not coverage_pass:
            result["reason"] = "incomplete-lyric-coverage"
        else:
            result["reason"] = "full-lyrics-and-terminal-heard"
        result.update(
            {
                "model": WHISPER_MODEL,
                "device": "cpu",
                "language": str(getattr(last_info, "language", "") or "") or None,
                "languageProbability": round(
                    float(getattr(last_info, "language_probability", 0.0) or 0.0),
                    3,
                ),
                "verificationChunks": chunks,
                "transcriptTail": (terminal_text or transcript)[-600:],
                "elapsedSeconds": round(time.time() - started, 1),
            }
        )
        return result


LYRICS_VERIFIER = LyricsVerifier()


def _dbfs(value: float) -> float:
    """Convert a linear amplitude to a finite dBFS value for JSON reports."""
    import math

    return 20.0 * math.log10(max(float(value), 1e-12))


def analyze_waveform_ending(data, sample_rate: int, np) -> dict:
    """Classify whether a channel-first waveform reaches a safe boundary.

    Semantic EOS is necessary but not sufficient: the official decoder can
    return a loud final sample. A boundary passes when its last quarter-second is
    genuinely quiet, or when it has fallen at least 12 dB from the preceding
    two seconds and its remaining peak is already low.
    """
    wave = np.asarray(data, dtype=np.float32)
    if wave.ndim == 1:
        wave = wave[None, :]
    if wave.ndim != 2 or wave.shape[-1] == 0:
        raise RuntimeError("Cannot inspect an empty or malformed waveform ending.")

    samples = int(wave.shape[-1])
    final_samples = max(1, min(samples, int(float(sample_rate) * 0.25)))
    prior_end = max(0, samples - int(float(sample_rate) * 1.0))
    prior_start = max(0, samples - int(float(sample_rate) * 5.0))
    final = wave[:, samples - final_samples :]
    prior = wave[:, prior_start:prior_end]
    if prior.size == 0:
        prior = wave[:, : max(1, samples - final_samples)]
    if prior.size == 0:
        prior = final

    final_rms = float(np.sqrt(np.mean(np.square(final, dtype=np.float64))))
    final_peak = float(np.max(np.abs(final)))
    prior_rms = float(np.sqrt(np.mean(np.square(prior, dtype=np.float64))))
    final_rms_db = _dbfs(final_rms)
    final_peak_db = _dbfs(final_peak)
    prior_rms_db = _dbfs(prior_rms)
    decay_db = final_rms_db - prior_rms_db
    quiet = final_rms_db <= -38.0 and final_peak_db <= -24.0
    decayed = decay_db <= -12.0 and final_peak_db <= -18.0

    return {
        "signalVerdict": "pass" if quiet or decayed else "fail",
        "reason": "quiet-boundary" if quiet else ("clear-decay" if decayed else "live-signal-at-boundary"),
        "finalWindowSeconds": round(final_samples / float(sample_rate), 3),
        "finalRmsDbfs": round(final_rms_db, 2),
        "finalPeakDbfs": round(final_peak_db, 2),
        "priorRmsDbfs": round(prior_rms_db, 2),
        "decayDb": round(decay_db, 2),
    }


def finish_waveform(data, sample_rate: int, np):
    """Guarantee a non-abrupt file boundary while preserving almost all audio.

    Natural decays are returned byte-for-byte. If decoded audio is still live
    at EOF, an adaptive slow-then-late fade is applied and 250 ms of digital
    silence is appended. This is intentionally a delivery safeguard, not a
    duration trim; no generated samples or lyric words are removed.
    """
    wave = np.asarray(data, dtype=np.float32)
    if wave.ndim == 1:
        wave = wave[None, :]
    before = analyze_waveform_ending(wave, sample_rate, np)
    if before["signalVerdict"] == "pass":
        return wave, {
            "action": "natural-decay",
            "fadeSeconds": 0.0,
            "silenceSeconds": 0.0,
            "before": before,
            "after": before,
        }

    duration = wave.shape[-1] / float(sample_rate)
    fade_seconds = max(1.0, min(8.0, duration * 0.04))
    fade_samples = max(1, min(wave.shape[-1], int(round(fade_seconds * sample_rate))))
    # A cubic phase leaves the early part of the final phrase almost untouched,
    # then completes a smooth equal-power landing near the actual file edge.
    progress = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
    curve = np.cos((np.pi / 2.0) * np.power(progress, 3)).astype(np.float32)
    finished = wave.copy()
    finished[:, -fade_samples:] *= curve[None, :]
    finished[:, -1] = 0.0

    silence_seconds = 0.25
    silence_samples = max(1, int(round(silence_seconds * sample_rate)))
    finished = np.concatenate(
        [finished, np.zeros((finished.shape[0], silence_samples), dtype=finished.dtype)],
        axis=-1,
    )
    after = analyze_waveform_ending(finished, sample_rate, np)
    if after["signalVerdict"] != "pass":
        raise RuntimeError(
            "The acoustic ending guard could not produce a safe waveform boundary; no track was published."
        )
    return finished, {
        "action": "adaptive-fade",
        "fadeSeconds": round(fade_samples / float(sample_rate), 3),
        "silenceSeconds": round(silence_samples / float(sample_rate), 3),
        "before": before,
        "after": after,
    }


def clamp_duration(value) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = 120.0
    return max(MIN_SECONDS, min(MAX_SECONDS, seconds))


def clamp_target_duration(value, ceiling: float) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = float(ceiling)
    return max(MIN_SECONDS, min(float(ceiling), seconds))


def clamp_minimum_duration(value, ceiling: float) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = 0.0
    return max(0.0, min(float(ceiling), seconds))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def build_app():
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import FileResponse, JSONResponse

    app = FastAPI(title="MaxMusic worker", docs_url=None, redoc_url=None)

    @app.get("/health")
    def health():
        return JSONResponse(STUDIO.status())

    @app.post("/generate")
    def generate(body: dict):
        prompt = str(body.get("prompt") or "").strip()
        instrumental = bool(body.get("is_instrumental") or body.get("instrumental"))
        # Music3 still validates that `lyrics` is a non-empty string even
        # when the request is instrumental. The tag is the model's native
        # way to represent an instrumental section; the UI/API flag remains
        # useful for routing and metadata.
        supplied_lyrics = normalize_song_ending(body.get("lyrics") or "")
        # Keep structured instrumental sections when the caller supplies them.
        # The standalone app uses these tags to give Music 3 an arrangement arc;
        # a bare fallback still keeps direct API callers compatible.
        lyrics = supplied_lyrics if instrumental and supplied_lyrics else (
            "[instrumental]\n[outro]" if instrumental else supplied_lyrics
        )
        duration = clamp_duration(body.get("duration"))
        minimum_duration = clamp_minimum_duration(
            body.get("minimum_duration", body.get("min_duration")),
            duration,
        )
        target_duration = clamp_target_duration(
            body.get("target_duration", body.get("requested_duration", body.get("duration"))),
            duration,
        )
        max_plan_attempts = clamp_plan_attempts(body.get("max_plan_attempts"))
        seed = body.get("seed")
        seed = None if seed in ("", None) else int(seed)

        if not prompt and not lyrics:
            raise HTTPException(400, "Describe the song, or give it some words to sing.")

        if not STUDIO.busy.acquire(blocking=False):
            raise HTTPException(409, "This studio is already making a song. One at a time.")
        try:
            return JSONResponse(
                STUDIO.generate(
                    prompt=prompt,
                    lyrics=lyrics,
                    duration=duration,
                    target_duration=target_duration,
                    max_plan_attempts=max_plan_attempts,
                    minimum_duration=minimum_duration,
                    verify_lyrics=not instrumental,
                    seed=seed,
                )
            )
        except Exception as err:  # noqa: BLE001 — the app shows this to a person
            raise HTTPException(500, f"{type(err).__name__}: {err}") from err
        finally:
            STUDIO.busy.release()
            STUDIO.schedule_idle_release()

    @app.post("/release")
    def release():
        """Release model VRAM explicitly without interrupting a render."""
        if not STUDIO.busy.acquire(blocking=False):
            raise HTTPException(409, "A song is rendering; VRAM will not be released mid-song.")
        try:
            unloaded = STUDIO.unload(reason="manual request")
        finally:
            STUDIO.busy.release()
        return JSONResponse({"ok": True, "unloaded": unloaded, **STUDIO.status()})

    @app.get("/tracks/{name}")
    def track(name: str):
        # Nothing but a plain file name — never a path.
        if "/" in name or "\\" in name or name.startswith("."):
            raise HTTPException(400, "bad name")
        path = TRACKS_DIR / name
        if not path.is_file():
            raise HTTPException(404, "no such track")
        return FileResponse(path, media_type="audio/flac", filename=name)

    @app.delete("/tracks/{name}")
    def delete_track(name: str):
        # The app uses this only to remove a superseded first take after its
        # duration guard successfully creates a replacement. Keep the same
        # basename-only boundary as the download route.
        if "/" in name or "\\" in name or name.startswith("."):
            raise HTTPException(400, "bad name")
        path = TRACKS_DIR / name
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return JSONResponse({"ok": True})

    return app


# ---------------------------------------------------------------------------
# Environment check — the friendly half of "it does not work"
# ---------------------------------------------------------------------------


def check() -> int:
    ok = True

    print(f"python            {sys.version.split()[0]}")

    try:
        import torch

        print(f"torch             {torch.__version__}")
        try:
            selected = resolve_device(torch)
        except RuntimeError as error:
            print(f"device            unavailable — {error}")
            ok = False
            selected = None

        if selected == "cuda":
            name = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info()
            print(f"gpu               {name} · {free / 1024**3:.1f} GB free of {total / 1024**3:.1f} GB")
            if total / 1024**3 < 8:
                print("                  ! under 8 GB — this model will not fit, even offloaded")
                ok = False
        elif selected == "mps":
            print("device            Apple MPS (experimental)")
        elif selected == "cpu":
            print("device            CPU (experimental and likely very slow)")
        else:
            print(f"device            unavailable for MAXMUSIC_DEVICE={DEVICE_REQUEST!r}")
    except ImportError:
        print("torch             MISSING — pip install -r worker/requirements.txt")
        ok = False

    try:
        import diffusers

        print(f"diffusers         {diffusers.__version__}")
        try:
            from diffusers import MiniMaxMusic3ModularPipeline  # noqa: F401

            print("pipeline          MiniMaxMusic3ModularPipeline found")
        except ImportError:
            print("pipeline          MISSING — this diffusers build has no MiniMax Music 3.")
            print("                  Install the pinned commit in worker/requirements.txt.")
            ok = False
    except ImportError:
        print("diffusers         MISSING — pip install -r worker/requirements.txt")
        ok = False

    for mod in ("transformers", "soundfile", "fastapi", "uvicorn"):
        try:
            __import__(mod)
            print(f"{mod:<18}ok")
        except ImportError:
            print(f"{mod:<18}MISSING — pip install -r worker/requirements.txt")
            ok = False

    print(f"tracks            {TRACKS_DIR}")
    print("\n" + ("ready — start it with: python worker/minimax_worker.py" if ok else "not ready yet, see above"))
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="MaxMusic's MiniMax Music 3 worker")
    parser.add_argument("--check", action="store_true", help="verify the environment and exit")
    parser.add_argument("--preload", action="store_true", help="load the weights at startup")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MAXMUSIC_WORKER_PORT", 3011)))
    args = parser.parse_args()

    if args.check:
        return check()

    import uvicorn

    if args.preload:
        print(f"loading {MODEL_ID} — the first run downloads the weights, which takes a while…", flush=True)
        STUDIO.load()
        STUDIO.schedule_idle_release()
        print("loaded.", flush=True)

    uvicorn.run(build_app(), host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
