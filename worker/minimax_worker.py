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
import io
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL_ID = os.environ.get("MAXMUSIC_MODEL", "MiniMaxAI/MiniMax-Music3")
TRACKS_DIR = Path(os.environ.get("MAXMUSIC_TRACKS", Path(__file__).resolve().parent.parent / "render" / "out" / "tracks"))
# The model's own ceiling: 9000 frames at 25 frames a second.
MAX_SECONDS = 360.0
MIN_SECONDS = 5.0

# ---------------------------------------------------------------------------
# The model, loaded once and kept
# ---------------------------------------------------------------------------


class Studio:
    """Owns the pipeline. Loading costs minutes, so it happens once."""

    def __init__(self) -> None:
        self.pipe = None
        self.sampling_rate = 44100
        self.device = "cuda"
        self.offloaded = False
        self.loading = False
        self.error: str | None = None
        self._lock = threading.Lock()
        # One song at a time. The GPU cannot do two anyway, and queuing here
        # gives a clear answer instead of an out-of-memory crash.
        self.busy = threading.Lock()

    def status(self) -> dict:
        free_gb = None
        try:
            import torch

            if torch.cuda.is_available():
                free, _total = torch.cuda.mem_get_info()
                free_gb = round(free / 1024**3, 1)
        except Exception:  # noqa: BLE001 — status must never raise
            pass
        return {
            "ok": self.error is None,
            "model": MODEL_ID,
            "loaded": self.pipe is not None,
            "loading": self.loading,
            "device": self.device,
            "offloaded": self.offloaded,
            "vramFreeGb": free_gb,
            "error": self.error,
        }

    def load(self) -> None:
        """Bring the pipeline up, offloading only when the card needs it."""
        with self._lock:
            if self.pipe is not None:
                return
            self.loading = True
            self.error = None
            try:
                import torch
                from diffusers import ComponentsManager, ModularPipeline

                if not torch.cuda.is_available():
                    raise RuntimeError(
                        "MiniMax Music 3 needs an NVIDIA GPU — torch reports no CUDA device."
                    )

                free, _total = torch.cuda.mem_get_info()
                free_gb = free / 1024**3
                # ~23GB in bfloat16 with everything resident. Below that, hand
                # the components to the offloader rather than failing at the
                # first generation with an out-of-memory error.
                roomy = free_gb >= 26.0

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
            except Exception as err:  # noqa: BLE001 — reported, not raised, so /health can explain
                self.error = f"{type(err).__name__}: {err}"
                self.pipe = None
                raise
            finally:
                self.loading = False

    def generate(self, *, prompt: str, lyrics: str, duration: float, seed: int | None) -> dict:
        """Make one song and write it to disk. Returns what the app needs."""
        import numpy as np
        import soundfile as sf
        import torch

        if self.pipe is None:
            self.load()

        generator = None
        if seed is not None:
            generator = torch.Generator("cuda").manual_seed(int(seed) & 0x7FFFFFFF)

        started = time.time()
        audio = self.pipe(
            prompt=prompt,
            lyrics=lyrics,
            audio_duration=float(duration),
            generator=generator,
            output="audios",
        )[0]

        # (channels, samples) → soundfile wants (samples, channels)
        data = np.asarray(audio)
        if data.ndim == 1:
            data = data[None, :]
        wave = data.T

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
            },
            "askedSeconds": float(duration),
            "renderSeconds": round(time.time() - started, 1),
        }


STUDIO = Studio()

# ---------------------------------------------------------------------------
# Lyrics hygiene
#
# The checkpoint's input contract is strict in one specific way: a structure
# tag owns its line, and anything sharing a line with a leading tag is thrown
# away by the model. A sheet written as "[verse] Sun came up…" therefore loses
# the words silently, which is impossible to diagnose from the audio. Fix it
# here rather than trusting every caller to know.
# ---------------------------------------------------------------------------

TAG_LINE = re.compile(r"^\s*(\[[^\]]+\])[ \t]*(\S.*)$")


def tidy_lyrics(text: str) -> str:
    out: list[str] = []
    for raw in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        match = TAG_LINE.match(raw)
        if match:
            out.append(match.group(1).lower())
            out.append(match.group(2).strip())
        else:
            out.append(raw.rstrip())
    return "\n".join(out).strip()


def clamp_duration(value) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = 120.0
    return max(MIN_SECONDS, min(MAX_SECONDS, seconds))


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
        lyrics = "" if instrumental else tidy_lyrics(body.get("lyrics") or "")
        duration = clamp_duration(body.get("duration"))
        seed = body.get("seed")
        seed = None if seed in ("", None) else int(seed)

        if not prompt and not lyrics:
            raise HTTPException(400, "Describe the song, or give it some words to sing.")

        if not STUDIO.busy.acquire(blocking=False):
            raise HTTPException(409, "This studio is already making a song. One at a time.")
        try:
            return JSONResponse(
                STUDIO.generate(prompt=prompt, lyrics=lyrics, duration=duration, seed=seed)
            )
        except Exception as err:  # noqa: BLE001 — the app shows this to a person
            raise HTTPException(500, f"{type(err).__name__}: {err}") from err
        finally:
            STUDIO.busy.release()

    @app.get("/tracks/{name}")
    def track(name: str):
        # Nothing but a plain file name — never a path.
        if "/" in name or "\\" in name or name.startswith("."):
            raise HTTPException(400, "bad name")
        path = TRACKS_DIR / name
        if not path.is_file():
            raise HTTPException(404, "no such track")
        return FileResponse(path, media_type="audio/flac", filename=name)

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
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info()
            print(f"gpu               {name} · {free / 1024**3:.1f} GB free of {total / 1024**3:.1f} GB")
            if total / 1024**3 < 8:
                print("                  ! under 8 GB — this model will not fit, even offloaded")
                ok = False
        else:
            print("gpu               none visible to torch — MiniMax Music 3 needs CUDA")
            ok = False
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
        print("loaded.", flush=True)

    uvicorn.run(build_app(), host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
