#!/usr/bin/env node
/**
 * The director's ears: measures what kind of song this is.
 *
 * Reads the analysis and timing JSONs and reduces them to a one-screen
 * profile — tempo, punch, brightness, vocal density, structure — plus a
 * suggested motion value for the engine's dial. The taste calls (world,
 * faces, palette, devices) belong to whoever reads this profile: today a
 * human or Claude authoring the lyric sheet's `style` block, in the app an
 * LLM behind the OAuth broker doing the same job per song.
 *
 *   node render/direct.mjs render/data/<song>-analysis.json [render/data/<song>-timing.json]
 *
 * @module render/direct
 */

import fs from 'node:fs/promises';

const [analysisFile, timingFile] = process.argv.slice(2);
if (!analysisFile) {
  console.error('usage: node render/direct.mjs <analysis.json> [timing.json]');
  process.exit(1);
}

const A = JSON.parse(await fs.readFile(analysisFile, 'utf8'));
const T = timingFile ? JSON.parse(await fs.readFile(timingFile, 'utf8')) : null;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * p)];
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

const S = A.series;
const profile = {
  duration: A.duration,
  bpm: A.bpm,
  onsetsPerSecond: Number((A.onsets.length / A.duration).toFixed(2)),
  energy: {
    mean: Number(mean(S.rms).toFixed(3)),
    p90: Number(pct(S.rms, 0.9).toFixed(3)),
    dynamicRange: Number((pct(S.rms, 0.9) - pct(S.rms, 0.1)).toFixed(3)),
  },
  bassPresence: Number(mean(S.bass).toFixed(3)),
  brightness: Number((mean(S.high) / Math.max(0.001, mean(S.bass))).toFixed(2)),
};

if (T) {
  const sung = T.lines.reduce((a, l) => a + (l.t1 - l.t0), 0);
  const words = T.lines.reduce((a, l) => a + l.words.length, 0);
  let gap = 0;
  let cursor = 0;
  for (const l of T.lines) {
    gap = Math.max(gap, l.t0 - cursor);
    cursor = Math.max(cursor, l.t1);
  }
  gap = Math.max(gap, A.duration - cursor);
  profile.vocals = {
    wordsPerSungSecond: Number((words / Math.max(1, sung)).toFixed(2)),
    sungFraction: Number((sung / A.duration).toFixed(2)),
    longestInstrumentalGap: Number(gap.toFixed(1)),
  };
}

/* The dial suggestion blends tempo with how hard the record actually hits —
   BPM alone calls a pounding half-time track mellow. */
const tempoTerm = Math.max(0, Math.min(1, (A.bpm - 60) / 90));
const punchTerm = Math.max(0, Math.min(1, (profile.onsetsPerSecond - 1.5) / 4.5));
const loudTerm = Math.max(0, Math.min(1, profile.energy.p90));
profile.suggestedMotion = Number(Math.max(0.15, Math.min(1,
  0.45 * tempoTerm + 0.35 * punchTerm + 0.2 * loudTerm,
)).toFixed(2));

const reads = [];
reads.push(profile.bpm < 85 ? 'slow tempo' : profile.bpm < 115 ? 'mid tempo' : 'fast tempo');
reads.push(profile.onsetsPerSecond > 4.5 ? 'dense/percussive' : profile.onsetsPerSecond > 3 ? 'moderately punchy' : 'sparse/soft attack');
reads.push(profile.brightness > 1.15 ? 'bright/airy top end' : profile.brightness > 0.75 ? 'balanced spectrum' : 'dark/bass-led');
if (profile.vocals) {
  reads.push(profile.vocals.sungFraction > 0.8 ? 'wall-to-wall vocals'
    : profile.vocals.longestInstrumentalGap > 10 ? 'long instrumental stretches' : 'vocal-led with breaks');
}
profile.readsAs = reads.join(', ');

console.log(JSON.stringify(profile, null, 2));
