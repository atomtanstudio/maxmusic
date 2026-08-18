#!/usr/bin/env python3
"""Create the timing JSON used by MaxMusic lyric videos.

The native package already installs faster-whisper for song-ending checks.
Using it here keeps lyric films cross-platform without asking people to install
a second Whisper executable. The output intentionally matches the small subset
of whisper.cpp JSON consumed by render/align.mjs.

Listening for the words is the slowest step in a lyric video, and on a machine
with a supported NVIDIA card it is the difference between seconds and minutes.
So the GPU is asked first and the CPU is kept as a working fallback rather than
as a failed render.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import site
import sys
from pathlib import Path


def milliseconds(value: float | None) -> int:
    return max(0, int(round(float(value or 0) * 1000)))


def timed(text: str, start: float | None, end: float | None) -> dict:
    return {
        "text": text,
        "offsets": {"from": milliseconds(start), "to": milliseconds(end)},
    }


def nvidia_library_dirs() -> list[str]:
    """Where pip puts the CUDA runtime, which is not where the loader looks.

    `nvidia-cublas-cu12`, `nvidia-cudnn-cu12` and the PyTorch wheels all install
    their shared libraries under `site-packages/nvidia/*/lib`. Nothing adds that
    to the loader path, so CTranslate2 cannot find them on its own.
    """
    dirs: list[str] = []
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        root = Path(base) / "nvidia"
        if not root.is_dir():
            continue
        for lib in sorted(root.glob("*/lib")):
            if lib.is_dir():
                dirs.append(str(lib))
    return dirs


def warm_cuda_libraries() -> None:
    """Pull the CUDA runtime into this process before CTranslate2 asks for it.

    Loading each library with RTLD_GLOBAL satisfies the dependencies the next
    one declares, which is why the order matters and why plain names are tried
    last: a system-wide install needs no help.
    """
    names = ("libcublasLt.so.12", "libcublas.so.12", "libcudnn.so.9", "libcudnn.so.8")
    for directory in nvidia_library_dirs():
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


def cuda_devices() -> int:
    """Count CUDA devices the way faster-whisper's runtime sees them."""
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001 — any failure means "assume no GPU"
        return 0


def cuda_runtime_ready() -> bool:
    """Whether the GPU can actually be used, not merely whether one exists.

    `get_cuda_device_count()` answers "is there a card", which is a different
    question. A machine can report a device through the driver and still have
    no cuBLAS to compute with — and because CTranslate2 loads those libraries
    lazily, believing the device count means the failure arrives in the middle
    of somebody's song instead of at startup. That is exactly what happened:
    lyric videos died on `libcublas.so.12 is not found` after the model had
    already been built without complaint.
    """
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


def device_order() -> list[tuple[str, str]]:
    """Devices to try, best first, each with the precision that suits it."""
    want = os.environ.get("MAXMUSIC_VIDEO_WHISPER_DEVICE", "auto").strip().lower() or "auto"
    override = os.environ.get("MAXMUSIC_VIDEO_WHISPER_COMPUTE_TYPE", "").strip()
    order: list[tuple[str, str]] = []
    if want in {"auto", "cuda"} and (want == "cuda" or cuda_runtime_ready()):
        order.append(("cuda", override or "float16"))
    if want not in {"auto", "cuda", "cpu"}:
        order.append((want, override or "int8"))
    if not any(device == "cpu" for device, _ in order):
        order.append(("cpu", override or "int8"))
    return order


def prove_model_runs(model) -> None:
    """Force the lazy libraries to load now, on a second of silence.

    Constructing a CUDA model proves nothing: CTranslate2 defers loading cuBLAS
    until the first encoder pass. Running one here moves that failure to a
    place where it can still be answered with the CPU.
    """
    import numpy as np

    silence = np.zeros(16000, dtype=np.float32)
    segments, _ = model.transcribe(silence, beam_size=1, without_timestamps=True)
    for _ in segments:
        break


def load_model(model_name: str, threads: int, cache: str | None):
    from faster_whisper import WhisperModel

    last = None
    for device, compute_type in device_order():
        if device == "cuda":
            warm_cuda_libraries()
        try:
            model = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
                cpu_threads=threads,
                download_root=cache,
            )
            prove_model_runs(model)
            return model, device, compute_type
        except Exception as err:  # noqa: BLE001 — a slow render beats no render
            last = err
            print(
                f"[transcribe] {device} ({compute_type}) cannot run lyric timing here, "
                f"falling back: {type(err).__name__}: {err}",
                file=sys.stderr,
                flush=True,
            )
    raise RuntimeError(f"No Whisper backend could start for lyric timing. Last error: {last}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio")
    parser.add_argument("--segments")
    parser.add_argument("--words")
    parser.add_argument(
        "--probe",
        action="store_true",
        help="report the hardware lyric timing would use, then exit",
    )
    args = parser.parse_args()

    if args.probe:
        device, compute_type = device_order()[0]
        try:
            import faster_whisper  # noqa: F401

            installed = True
        except ImportError:
            installed = False
        print(json.dumps({
            "installed": installed,
            "model": os.environ.get("MAXMUSIC_WHISPER_MODEL", "small"),
            "device": device,
            "computeType": compute_type,
            "cudaDevices": cuda_devices(),
            "cudaRuntimeReady": cuda_runtime_ready(),
            "request": os.environ.get("MAXMUSIC_VIDEO_WHISPER_DEVICE", "auto"),
        }))
        return

    for name in ("audio", "segments", "words"):
        if not getattr(args, name):
            parser.error(f"--{name} is required unless --probe is given")

    try:
        import faster_whisper  # noqa: F401
    except ImportError as error:
        raise RuntimeError(
            "faster-whisper is missing from the configured MaxMusic Python environment; "
            "run node scripts/setup-native.mjs"
        ) from error

    model_name = os.environ.get("MAXMUSIC_WHISPER_MODEL", "small")
    cache = os.environ.get("MAXMUSIC_WHISPER_CACHE")
    if not cache and os.environ.get("HF_HOME"):
        cache = str(Path(os.environ["HF_HOME"]) / "faster-whisper")
    threads = max(1, int(os.environ.get("MAXMUSIC_WHISPER_THREADS", str(min(16, os.cpu_count() or 4)))))

    model, device, compute_type = load_model(model_name, threads, cache)
    # The renderer reads this line to tell the customer, and the log, which
    # hardware actually did the work.
    print(f"transcriber {model_name} on {device} ({compute_type})", flush=True)

    transcript, _ = model.transcribe(
        args.audio,
        beam_size=5,
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=False,
    )

    segments: list[dict] = []
    words: list[dict] = []
    for segment in transcript:
        text = str(segment.text or "").strip()
        if text:
            segments.append(timed(text, segment.start, segment.end))
        for word in segment.words or []:
            token = str(word.word or "").strip()
            if token:
                words.append(timed(token, word.start, word.end))

    Path(args.segments).write_text(
        json.dumps({"transcription": segments}, ensure_ascii=False),
        encoding="utf-8",
    )
    Path(args.words).write_text(
        json.dumps({"transcription": words}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"timed {len(segments)} segments and {len(words)} words", flush=True)


if __name__ == "__main__":
    main()
