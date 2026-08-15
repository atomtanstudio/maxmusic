#!/usr/bin/env node
/**
 * Audio analysis for the lyric-video renderer.
 *
 * Decodes a track with ffmpeg and measures the things the stage animates
 * from: a beat grid, an onset envelope, and per-video-frame band energy.
 * Everything downstream is a deterministic function of this file's output,
 * so a render is reproducible from the JSON alone.
 *
 *   node render/analyze.mjs <audio-file> <out.json>
 *
 * No dependencies. The FFT is a plain radix-2; two minutes of mono 44.1k
 * audio is ~10k windows, well under a second of work.
 *
 * @module render/analyze
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const SR = 44100;
const WIN = 2048;
const HOP = 512;
const VIDEO_FPS = 30;

/* ------------------------------------------------------------------ decode */

/** Decode any audio file to mono float32 PCM via ffmpeg. */
function decode(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-v', 'error', '-i', file,
      '-ac', '1', '-ar', String(SR),
      '-f', 'f32le', '-',
    ], { shell: false });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) { reject(new Error(err.trim() || `ffmpeg exited ${code}`)); return; }
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/* --------------------------------------------------------------------- fft */

/** In-place radix-2 FFT over interleaved re/im arrays. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/* ---------------------------------------------------------------- measure */

const hann = new Float32Array(WIN);
for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));

const hzToBin = (hz) => Math.max(0, Math.min(WIN / 2 - 1, Math.round((hz * WIN) / SR)));

/**
 * One pass over the signal: per-hop band energies and spectral flux.
 * Bands are perceptual jobs, not octaves: bass moves the frame, mids carry
 * the voice, highs read as air.
 */
function measure(pcm) {
  const hops = Math.max(1, Math.floor((pcm.length - WIN) / HOP) + 1);
  const bands = {
    bass: [hzToBin(20), hzToBin(150)],
    mid: [hzToBin(150), hzToBin(2000)],
    high: [hzToBin(2000), hzToBin(8000)],
  };
  const out = {
    rms: new Float32Array(hops),
    bass: new Float32Array(hops),
    mid: new Float32Array(hops),
    high: new Float32Array(hops),
    flux: new Float32Array(hops),
  };
  const re = new Float32Array(WIN);
  const im = new Float32Array(WIN);
  let prevMag = new Float32Array(WIN / 2);
  const mag = new Float32Array(WIN / 2);

  for (let h = 0; h < hops; h++) {
    const off = h * HOP;
    let sq = 0;
    for (let i = 0; i < WIN; i++) {
      const s = pcm[off + i] || 0;
      sq += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    out.rms[h] = Math.sqrt(sq / WIN);
    fft(re, im);
    let flux = 0;
    for (let b = 0; b < WIN / 2; b++) {
      mag[b] = Math.hypot(re[b], im[b]);
      const d = mag[b] - prevMag[b];
      if (d > 0) flux += d;
    }
    out.flux[h] = flux;
    for (const [name, [b0, b1]] of Object.entries(bands)) {
      let e = 0;
      for (let b = b0; b < b1; b++) e += mag[b] * mag[b];
      out[name][h] = Math.sqrt(e / Math.max(1, b1 - b0));
    }
    [prevMag, prevMag[0]] = [mag.slice(), prevMag[0]];
  }
  return out;
}

/* ------------------------------------------------------- onsets and beats */

/** Peak-pick the flux envelope against a local adaptive threshold. */
function pickOnsets(flux) {
  const hopT = HOP / SR;
  const w = Math.round(0.35 / hopT);
  const onsets = [];
  for (let i = 2; i < flux.length - 2; i++) {
    if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - w); j < Math.min(flux.length, i + w); j++) { sum += flux[j]; n++; }
    const mean = sum / Math.max(1, n);
    if (flux[i] > mean * 1.5 && (onsets.length === 0 || i * hopT - onsets[onsets.length - 1] > 0.05)) {
      onsets.push(i * hopT);
    }
  }
  return onsets;
}

/**
 * Tempo from the autocorrelation of the flux envelope, then a beat grid
 * phase-fit against it. EDM holds a grid; this does not try to track drift.
 */
function beatGrid(flux, duration) {
  const hopT = HOP / SR;
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  const dev = flux.map((v) => Math.max(0, v - mean));

  let best = { bpm: 120, score: -1 };
  for (let bpm = 70; bpm <= 180; bpm += 0.25) {
    const lag = Math.round(60 / bpm / hopT);
    if (lag < 4 || lag >= dev.length / 2) continue;
    let s = 0;
    for (let i = 0; i + lag < dev.length; i++) s += dev[i] * dev[i + lag];
    // Mild preference for the 110–140 dance band when harmonics tie.
    const w = bpm >= 100 && bpm <= 150 ? 1.06 : 1;
    if (s * w > best.score) best = { bpm, score: s * w };
  }

  const period = 60 / best.bpm;
  let bestPhase = 0;
  let bestSum = -1;
  const steps = 64;
  for (let k = 0; k < steps; k++) {
    const phase = (k / steps) * period;
    let sum = 0;
    for (let t = phase; t < duration; t += period) {
      const i = Math.round(t / hopT);
      if (i < dev.length) sum += dev[i];
    }
    if (sum > bestSum) { bestSum = sum; bestPhase = phase; }
  }

  const beats = [];
  for (let t = bestPhase; t < duration; t += period) beats.push(Number(t.toFixed(4)));
  return { bpm: Number(best.bpm.toFixed(2)), beats };
}

/**
 * Downbeats: of the four possible alignments of a 4/4 bar on the grid, the
 * one with the most bass landing on the one.
 */
function downbeats(beats, bassAt) {
  let bestK = 0;
  let bestSum = -1;
  for (let k = 0; k < 4; k++) {
    let sum = 0;
    for (let i = k; i < beats.length; i += 4) sum += bassAt(beats[i]);
    if (sum > bestSum) { bestSum = sum; bestK = k; }
  }
  return beats.filter((_, i) => (i - bestK) % 4 === 0 && i >= bestK);
}

/* ------------------------------------------------------------------- main */

const [audioFile, outFile] = process.argv.slice(2);
if (!audioFile || !outFile) {
  console.error('usage: node render/analyze.mjs <audio> <out.json>');
  process.exit(1);
}

const pcm = await decode(audioFile);
const duration = pcm.length / SR;
const m = measure(pcm);
const hopT = HOP / SR;

const onsets = pickOnsets(m.flux);
const { bpm, beats } = beatGrid(m.flux, duration);
const bassAt = (t) => m.bass[Math.min(m.bass.length - 1, Math.round(t / hopT))] || 0;
const downs = downbeats(beats, bassAt);

/* Resample band energies to video frames, normalised 0..1 against a high
   percentile so one spike does not flatten the whole song. */
const frames = Math.ceil(duration * VIDEO_FPS);
const norm = (arr) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.98)] || 1;
  return (v) => Math.max(0, Math.min(1, v / ref));
};
const series = {};
for (const name of ['rms', 'bass', 'mid', 'high', 'flux']) {
  const n = norm(m[name]);
  const out = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const i = Math.min(m[name].length - 1, Math.round((f / VIDEO_FPS) / hopT));
    out[f] = Number(n(m[name][i]).toFixed(4));
  }
  series[name] = out;
}

await fs.writeFile(outFile, JSON.stringify({
  source: audioFile,
  duration: Number(duration.toFixed(3)),
  fps: VIDEO_FPS,
  bpm,
  beats,
  downbeats: downs,
  onsets: onsets.map((t) => Number(t.toFixed(4))),
  series,
}));

console.log(`${audioFile}`);
console.log(`  ${duration.toFixed(1)}s · ${bpm} BPM · ${beats.length} beats · ${downs.length} downbeats · ${onsets.length} onsets`);
console.log(`  → ${outFile}`);
