#!/usr/bin/env node
/**
 * Word-level lyric timing: canonical sheet × two whisper passes.
 *
 * Whisper hears the record; the canonical sheet says what is actually sung.
 * Alignment is two-stage, because the two passes fail differently: the
 * segment pass reliably catches every sung PHRASE but times it loosely, and
 * the word pass (-ml 1) times words tightly but drops whole phrases. So
 * lines are first anchored to segments, then words are timed inside each
 * anchored window from the word pass, and anything still missing is
 * interpolated inside its window — never across the whole song.
 *
 *   node render/align.mjs <lyrics.json> <segments.json> <words.json> <out.json>
 *
 * @module render/align
 */

import fs from 'node:fs/promises';

const [lyricsFile, segFile, wordFile, outFile] = process.argv.slice(2);
if (!lyricsFile || !segFile || !wordFile || !outFile) {
  console.error('usage: node render/align.mjs <lyrics.json> <segments.json> <words.json> <out.json>');
  process.exit(1);
}

const sheet = JSON.parse(await fs.readFile(lyricsFile, 'utf8'));
const segPass = JSON.parse(await fs.readFile(segFile, 'utf8'));
const wordPass = JSON.parse(await fs.readFile(wordFile, 'utf8'));

const MIN_WORD_S = 0.12;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

/* ----------------------------------------------------------- whisper data */

/** Sung segments: text plus window, music/noise annotations dropped. */
let segments = segPass.transcription
  .map((s) => ({
    text: norm(s.text.replace(/♪/g, '')),
    t0: s.offsets.from / 1000,
    t1: s.offsets.to / 1000,
  }))
  .filter((s) => s.text && !/^\(.*\)$/.test(s.text) && !/^upbeat music$/.test(s.text));

/**
 * A chanted phrase comes back as ONE segment holding several repeats
 * ("open it up open it up …"), while the sheet keeps one line per repeat.
 * Any segment that is exactly k concatenations of a canonical line is split
 * into k even sub-segments so the line alignment stays one-to-one.
 */
function splitRepeats(canonicalTexts) {
  const out = [];
  for (const seg of segments) {
    const flat = seg.text.replace(/ /g, '');
    let split = null;
    for (const phrase of canonicalTexts) {
      const p = phrase.replace(/ /g, '');
      if (!p || flat.length <= p.length || flat.length % p.length !== 0) continue;
      const k = flat.length / p.length;
      if (flat === p.repeat(k)) { split = { phrase, k }; break; }
    }
    if (!split) { out.push(seg); continue; }
    const dt = (seg.t1 - seg.t0) / split.k;
    for (let i = 0; i < split.k; i++) {
      out.push({ text: split.phrase, t0: seg.t0 + i * dt, t1: seg.t0 + (i + 1) * dt });
    }
  }
  return out;
}

/** Timed words from the -ml 1 pass. */
const heardWords = wordPass.transcription
  .map((s) => ({
    w: norm(s.text.replace(/♪/g, '')).replace(/ /g, ''),
    t0: s.offsets.from / 1000,
    t1: s.offsets.to / 1000,
  }))
  .filter((s) => s.w);

/* ------------------------------------------------- canonical line sequence */

const lines = [];
for (const section of sheet.sections) {
  if (!section.lines) continue;
  for (const line of section.lines) {
    for (let r = 0; r < (line.repeat || 1); r++) {
      lines.push({
        section: section.id,
        kind: section.kind,
        text: line.text,
        device: line.device,
        repeatIndex: r,
        norm: norm(line.text),
        words: line.text.split(/\s+/).map((word) => ({ word, n: norm(word).replace(/ /g, '') })),
      });
    }
  }
}

segments = splitRepeats([...new Set(lines.map((l) => l.norm))]);

/* ------------------------------------------------------- string similarity */

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

/* -------------------------------------- stage 1: lines ↔ segments (global) */

function alignLines() {
  const m = lines.length;
  const n = segments.length;
  const GAP = -0.45;
  const H = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  for (let i = 1; i <= m; i++) H[i][0] = H[i - 1][0] + GAP;
  for (let j = 1; j <= n; j++) H[0][j] = H[0][j - 1] + GAP;
  const match = (i, j) => {
    const s = sim(lines[i - 1].norm, segments[j - 1].text);
    return s > 0.45 ? s : -1;
  };
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      H[i][j] = Math.max(H[i - 1][j - 1] + match(i, j), H[i - 1][j] + GAP, H[i][j - 1] + GAP);
    }
  }
  let i = m;
  let j = n;
  const out = new Array(m).fill(null);
  while (i > 0 && j > 0) {
    if (Math.abs(H[i][j] - (H[i - 1][j - 1] + match(i, j))) < 1e-9) {
      if (match(i, j) > 0) out[i - 1] = j - 1;
      i--; j--;
    } else if (Math.abs(H[i][j] - (H[i - 1][j] + GAP)) < 1e-9) {
      i--;
    } else {
      j--;
    }
  }
  return out;
}

const lineSeg = alignLines();

/* ------------------------- stage 2: words within each line's time window -- */

/**
 * A line's window: its matched segment, stretched to the next line's segment
 * start so a segment whose tail was padded with silence does not clip words.
 */
function windowFor(idx) {
  const seg = lineSeg[idx] !== null ? segments[lineSeg[idx]] : null;
  if (!seg) return null;
  let t1 = seg.t1;
  for (let k = idx + 1; k < lines.length; k++) {
    if (lineSeg[k] !== null) { t1 = Math.min(t1, segments[lineSeg[k]].t0); break; }
  }
  return { t0: seg.t0, t1: Math.max(t1, seg.t0 + 0.4) };
}

for (let idx = 0; idx < lines.length; idx++) {
  const line = lines[idx];
  const win = windowFor(idx);
  if (!win) continue;
  line.t0 = win.t0;
  line.t1 = win.t1;

  const pool = heardWords.filter((w) => w.t0 >= win.t0 - 0.35 && w.t1 <= win.t1 + 0.35);
  // Greedy in-order match of the line's words against the pool.
  let cursor = 0;
  for (const cw of line.words) {
    for (let p = cursor; p < pool.length; p++) {
      if (sim(cw.n, pool[p].w) >= 0.6) {
        cw.t0 = pool[p].t0;
        cw.t1 = Math.max(pool[p].t1, pool[p].t0 + MIN_WORD_S);
        cursor = p + 1;
        break;
      }
    }
  }
  // Interpolate the rest inside the window, between neighbouring matches.
  for (let w = 0; w < line.words.length; w++) {
    if (line.words[w].t0 !== undefined) continue;
    let lo = w - 1;
    while (lo >= 0 && line.words[lo].t0 === undefined) lo--;
    let hi = w + 1;
    while (hi < line.words.length && line.words[hi].t0 === undefined) hi++;
    const t0 = lo >= 0 ? line.words[lo].t1 : win.t0;
    const t1 = hi < line.words.length ? line.words[hi].t0 : win.t1;
    const span = [];
    for (let k = lo + 1; k < hi; k++) span.push(line.words[k]);
    const total = span.reduce((a, x) => a + x.n.length, 0) || 1;
    let cur = Math.min(t0, t1);
    for (const x of span) {
      const dur = Math.max(MIN_WORD_S, ((t1 - t0) * x.n.length) / total);
      x.t0 = cur;
      x.t1 = cur + dur;
      x.guessed = true;
      cur += dur;
    }
  }
  // The window may carry leading silence from a padded ASR segment; the
  // line begins when its first word does.
  line.t0 = Math.min(...line.words.map((w) => w.t0));
  line.t1 = Math.max(line.t1, ...line.words.map((w) => w.t1));
}

const unanchored = lines.filter((l) => l.t0 === undefined);
if (unanchored.length) {
  console.error('UNANCHORED LINES — fix the sheet or the ASR before rendering:');
  for (const l of unanchored) console.error(`  [${l.section}] ${l.text}`);
  process.exit(1);
}

/* ----------------------------------------------------------------- output */

const outLines = lines.map((line) => ({
  section: line.section,
  kind: line.kind,
  text: line.text,
  ...(line.device ? { device: line.device } : {}),
  repeatIndex: line.repeatIndex,
  t0: Number(line.t0.toFixed(3)),
  t1: Number(line.t1.toFixed(3)),
  words: line.words.map((w) => ({
    word: w.word,
    t0: Number(w.t0.toFixed(3)),
    t1: Number(w.t1.toFixed(3)),
    ...(w.guessed ? { guessed: true } : {}),
  })),
}));

await fs.writeFile(outFile, JSON.stringify({
  title: sheet.title,
  artist: sheet.artist,
  footer: sheet.footer,
  ...(sheet.style ? { style: sheet.style } : {}),
  lines: outLines,
}, null, 1));

const nWords = outLines.reduce((a, l) => a + l.words.length, 0);
const guessed = outLines.reduce((a, l) => a + l.words.filter((w) => w.guessed).length, 0);
console.log(`${outLines.length} lines · ${nWords} words · ${guessed} interpolated`);
for (const l of outLines) {
  const flag = l.words.some((w) => w.guessed) ? ' *' : '';
  console.log(`  ${l.t0.toFixed(2).padStart(7)}–${l.t1.toFixed(2).padEnd(7)} [${l.kind}] ${l.text}${flag}`);
}
console.log(`→ ${outFile}`);
