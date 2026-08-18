#!/usr/bin/env python3
"""Extract the vocal stem with MaxMusic's existing Demucs-web ONNX model.

This is a test/validation helper, not part of music generation. Its tensor
layout, padding, STFT normalization, and overlap-add mirror the JavaScript
implementation already installed with the Legion ACE-Step UI.
"""

from __future__ import annotations

import argparse
import os
import math
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch


SAMPLE_RATE = 44_100
FFT_SIZE = 4_096
HOP_SIZE = 1_024
TRAINING_SAMPLES = 343_980
MODEL_SPEC_BINS = 2_048
MODEL_SPEC_FRAMES = 336
SEGMENT_OVERLAP = 0.25
VOCALS_INDEX = 3


def reflect_pad(signal: np.ndarray, left: int, right: int) -> np.ndarray:
    return np.pad(signal, (left, right), mode="reflect")


def model_inputs(left: np.ndarray, right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    padded_left = np.zeros(TRAINING_SAMPLES, dtype=np.float32)
    padded_right = np.zeros(TRAINING_SAMPLES, dtype=np.float32)
    length = min(TRAINING_SAMPLES, left.size)
    padded_left[:length] = left[:length]
    padded_right[:length] = right[:length]

    frames = math.ceil(TRAINING_SAMPLES / HOP_SIZE)
    side_pad = (HOP_SIZE // 2) * 3
    right_pad = side_pad + frames * HOP_SIZE - TRAINING_SAMPLES
    center_pad = FFT_SIZE // 2
    window = torch.hann_window(FFT_SIZE, periodic=True)

    channels = []
    for signal in (padded_left, padded_right):
        prepared = reflect_pad(signal, side_pad, right_pad)
        prepared = reflect_pad(prepared, center_pad, center_pad)
        spectrum = torch.stft(
            torch.from_numpy(prepared),
            n_fft=FFT_SIZE,
            hop_length=HOP_SIZE,
            window=window,
            center=False,
            normalized=True,
            return_complex=True,
        )
        spectrum = spectrum[:MODEL_SPEC_BINS, 2 : 2 + MODEL_SPEC_FRAMES]
        channels.extend((spectrum.real.numpy(), spectrum.imag.numpy()))

    waveform = np.stack((padded_left, padded_right), axis=0)[None, ...]
    spectrogram = np.stack(channels, axis=0)[None, ...].astype(np.float32, copy=False)
    return waveform.astype(np.float32, copy=False), spectrogram


def inverse_spectrum(real: np.ndarray, imag: np.ndarray) -> np.ndarray:
    padded_frames = MODEL_SPEC_FRAMES + 4
    padded_bins = MODEL_SPEC_BINS + 1
    spectrum = np.zeros((padded_bins, padded_frames), dtype=np.complex64)
    spectrum[:MODEL_SPEC_BINS, 2 : 2 + MODEL_SPEC_FRAMES] = real + 1j * imag

    length = (padded_frames - 1) * HOP_SIZE + FFT_SIZE
    output = np.zeros(length, dtype=np.float32)
    weight = np.zeros(length, dtype=np.float32)
    window = np.hanning(FFT_SIZE + 1)[:-1].astype(np.float32)
    window_sq = window * window
    scale = math.sqrt(FFT_SIZE)
    for frame in range(padded_frames):
        start = frame * HOP_SIZE
        samples = np.fft.irfft(spectrum[:, frame], n=FFT_SIZE).astype(np.float32) * scale
        output[start : start + FFT_SIZE] += samples * window
        weight[start : start + FFT_SIZE] += window_sq
    np.divide(output, weight, out=output, where=weight > 1e-8)

    offset = FFT_SIZE // 2 + (HOP_SIZE // 2) * 3
    return output[offset : offset + TRAINING_SAMPLES].copy()


def separate_vocals(session: ort.InferenceSession, audio: np.ndarray) -> np.ndarray:
    total = audio.shape[1]
    stride = int(TRAINING_SAMPLES * (1 - SEGMENT_OVERLAP))
    vocals = np.zeros((2, total), dtype=np.float32)
    weights = np.zeros(total, dtype=np.float32)
    starts = list(range(0, total, stride))

    for number, start in enumerate(starts, 1):
        end = min(start + TRAINING_SAMPLES, total)
        segment_length = end - start
        left = np.zeros(TRAINING_SAMPLES, dtype=np.float32)
        right = np.zeros(TRAINING_SAMPLES, dtype=np.float32)
        left[:segment_length] = audio[0, start:end]
        right[:segment_length] = audio[1, start:end]
        waveform, spectrogram = model_inputs(left, right)
        frequency, time_domain = session.run(None, {"input": waveform, "x": spectrogram})

        vocal_time = time_domain[0, VOCALS_INDEX]
        vocal_frequency = frequency[0, VOCALS_INDEX]
        vocal_left = vocal_time[0] + inverse_spectrum(vocal_frequency[0], vocal_frequency[1])
        vocal_right = vocal_time[1] + inverse_spectrum(vocal_frequency[2], vocal_frequency[3])

        positions = np.arange(segment_length, dtype=np.float32)
        fade_in = np.minimum(positions / (stride * 0.5), 1.0)
        fade_out = np.minimum((segment_length - positions) / (stride * 0.5), 1.0)
        window = np.minimum(fade_in, fade_out)
        vocals[0, start:end] += vocal_left[:segment_length] * window
        vocals[1, start:end] += vocal_right[:segment_length] * window
        weights[start:end] += window
        print(f"segment {number}/{len(starts)}", flush=True)

    valid = weights > 0
    vocals[:, valid] /= weights[valid]
    return vocals


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract a vocal stem with Demucs-web ONNX")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--model",
        type=Path,
        # No default worth guessing: point this at wherever the ONNX weights
        # live on your machine, or set MAXMUSIC_DEMUCS_MODEL once.
        default=Path(os.environ.get("MAXMUSIC_DEMUCS_MODEL", "htdemucs_embedded.onnx")),
    )
    args = parser.parse_args()

    samples, rate = sf.read(args.input, dtype="float32", always_2d=True)
    audio = samples.T
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    elif audio.shape[0] > 2:
        audio = audio[:2]
    if rate != SAMPLE_RATE:
        source = torch.from_numpy(audio)
        audio = torch.nn.functional.interpolate(
            source[None, ...],
            size=round(audio.shape[1] * SAMPLE_RATE / rate),
            mode="linear",
            align_corners=False,
        )[0].numpy()

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    vocals = separate_vocals(session, audio.astype(np.float32, copy=False))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, vocals.T, SAMPLE_RATE, subtype="PCM_16")
    print(args.output, flush=True)


if __name__ == "__main__":
    main()
