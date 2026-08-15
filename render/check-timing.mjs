#!/usr/bin/env node
/**
 * Timing validator: does the sheet's timing agree with what the record
 * actually sings?
 *
 * For every timed line it measures two things against the ASR segments —
 * which are the ground truth for WHEN vocals exist, whatever the words:
 *
 *   coverage   how much of the line's span overlaps ANY sung segment.
 *              A line timed into silence shows up here as ~0 — that is a
 *              fabricated timing, the "words pop up before the song gets
 *              there" bug.
 *   agreement  best text similarity between the line and the segments it
 *              overlaps. A line sitting on the WRONG vocal shows up here —
 *              the "highlights run on the wrong words" bug.
 *
 *   node render/check-timing.mjs <timing.json> <segments.json>
 *
 * Exits 0 when clean, 1 when any line fails, printing per-line verdicts.
 *
 * @module render/check-timing
 */

import fs from 'node:fs/promises';

const [timingFile, segFile] = process.argv.slice(2);
if (!timingFile || !segFile) {
  console.error('usage: node render/check-timing.mjs <timing.json> <segments.json>');
  process.exit(1);
}

const T = JSON.parse(await fs.readFile(timingFile, 'utf8'));
const segPass = JSON.parse(await fs.readFile(segFile, 'utf8'));

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

const segs = segPass.transcription
  .filter((s) => !/^\s*[\(\[].*[\)\]]\s*$/.test(String(s.text || '').trim()))
  .map((s) => ({
    text: norm(String(s.text || '').replace(/♪/g, '')),
    t0: s.offsets.from / 1000,
    t1: s.offsets.to / 1000,
  }))
  .filter((s) => s.text);

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

let bad = 0;
const rows = [];
for (const line of T.lines || []) {
  const span = Math.max(0.001, line.t1 - line.t0);
  let covered = 0;
  let agree = 0;
  const n = norm(line.text);
  for (const s of segs) {
    const o = Math.max(0, Math.min(line.t1, s.t1) - Math.max(line.t0, s.t0));
    if (o <= 0) continue;
    covered += o;
    // A line that is PART of a longer heard segment is right, not wrong —
    // containment counts as full agreement.
    const contained = n.length >= 6 && s.text.includes(n);
    agree = Math.max(agree, contained ? 1 : sim(n, s.text));
  }
  const coverage = Math.min(1, covered / span);
  const verdict = coverage < 0.35 ? 'SILENT' : agree < 0.34 ? 'WRONG-WORDS' : 'ok';
  if (verdict !== 'ok') bad++;
  rows.push({ line, coverage, agree, verdict });
}

for (const r of rows) {
  const flag = r.verdict === 'ok' ? '  ' : '!!';
  console.log(`${flag} ${r.line.t0.toFixed(1).padStart(6)}–${r.line.t1.toFixed(1).padEnd(6)} cov ${(r.coverage * 100).toFixed(0).padStart(3)}% agree ${(r.agree * 100).toFixed(0).padStart(3)}% ${r.verdict.padEnd(11)} ${r.line.text.slice(0, 56)}`);
}
const total = rows.length;
console.log(`\n${total - bad}/${total} lines verified · ${bad} failing`);
process.exit(bad ? 1 : 0);
