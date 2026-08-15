#!/usr/bin/env node
/**
 * The standing director: builds a lyric sheet for a song nobody has
 * hand-directed.
 *
 * It is rules, not taste — it reads the profile the way the README's
 * director brief says to, picks a world deterministically per song so two
 * songs never ship identical packs by accident, sets the motion dial from
 * the measurements, and grants NO devices: a device fires only where a
 * lyric earns it, and earning is a judgement this script refuses to fake.
 * When the broker's LLM arrives it replaces this file, not the engine.
 *
 *   node render/auto-direct.mjs --mode scroll|film --analysis a.json \
 *        --segments seg.json --out sheet.json [--lyrics text.txt]
 *        [--title T] [--artist A] [--cover /covers/x.png] [--seed anything]
 *
 * @module render/auto-direct
 */

import fs from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const A = JSON.parse(await fs.readFile(args.analysis, 'utf8'));
const segPass = args.segments
  ? JSON.parse(await fs.readFile(args.segments, 'utf8'))
  : { transcription: [] };
const authored = args.lyrics ? await fs.readFile(args.lyrics, 'utf8') : null;

/* ------------------------------------------------------------------ lines */

/** Stanzas of lines: from the authored text when there is one (blank lines
    are stanza breaks, [tags] are a writing aid), else from the ASR segments
    (a gap of 2s starts a new stanza). */
function stanzasFrom() {
  if (authored && authored.trim()) {
    const out = [[]];
    for (const raw of authored.split('\n')) {
      const line = raw.trim();
      if (!line || /^\[[^\]]*\]$/.test(line)) {
        if (out[out.length - 1].length) out.push([]);
        continue;
      }
      out[out.length - 1].push(line);
    }
    return out.filter((s) => s.length);
  }
  const segs = segPass.transcription
    .map((s) => ({
      text: s.text.replace(/♪/g, '').trim(),
      t0: s.offsets.from / 1000,
      t1: s.offsets.to / 1000,
    }))
    .filter((s) => s.text && !/^\(.*\)$/.test(s.text));
  const out = [[]];
  let lastEnd = null;
  for (const s of segs) {
    if (lastEnd !== null && s.t0 - lastEnd > 2) out.push([]);
    out[out.length - 1].push(s.text);
    lastEnd = s.t1;
  }
  return out.filter((s) => s.length);
}

const stanzas = args.mode === 'visualizer' ? [] : stanzasFrom();
if (!stanzas.length && args.mode !== 'visualizer') {
  console.error('No lyrics to direct — nothing sung and nothing authored.');
  process.exit(1);
}

/* --------------------------------------------------------------- sections */

const normText = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const counts = new Map();
for (const st of stanzas) {
  const key = normText(st.join(' '));
  counts.set(key, (counts.get(key) || 0) + 1);
}

const sections = [];
stanzas.forEach((st, i) => {
  const repeated = (counts.get(normText(st.join(' '))) || 0) >= 2;
  sections.push({
    id: `${repeated ? 'chorus' : 'verse'}-${i + 1}`,
    kind: args.mode === 'film' && repeated ? 'chorus' : 'verse',
    lines: st.map((text) => ({ text })),
  });
});

/* ------------------------------------------------------------------ style */

const tempoTerm = Math.max(0, Math.min(1, (A.bpm - 60) / 90));
const punch = Math.max(0, Math.min(1, (A.onsets.length / A.duration - 1.5) / 4.5));
const motion = Number(Math.max(0.2, Math.min(0.9, 0.45 * tempoTerm + 0.35 * punch + 0.2)).toFixed(2));

/** Deterministic world per song: the same song always gets the same film,
    two different songs usually do not. */
const seed = String(args.seed || args.title || 'song');
let h = 0;
for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;

/**
 * Read what the song is about, when it is obvious. Keyword families are
 * scored against the full text (title + authored or heard lyrics); a world
 * needs a clear lead to be chosen on subject, otherwise tempo and the hash
 * decide. Nothing here is clever — it is a librarian, not a poet.
 */
const fullText = [
  args.title || '',
  authored || '',
  ...segPass.transcription.map((s) => s.text || ''),
].join(' ').toLowerCase();

const FAMILIES = {
  horizon: ['road', 'drive', 'driving', 'highway', 'car', 'wheel', 'mile', 'dawn', 'sunrise', 'engine', 'motorway', 'lane', 'ride', 'street'],
  downpour: ['rain', 'storm', 'thunder', 'water', 'river', 'ocean', 'tears', 'cry', 'drown', 'flood', 'sea', 'wave'],
  sanctum: ['candle', 'flame', 'prayer', 'ghost', 'grave', 'soul', 'silence', 'shadow', 'bone', 'stone', 'hymn', 'sleep', 'death'],
  // 'night' and 'light' appear in every second lyric ever written — they
  // identify nothing and are deliberately absent.
  venue: ['dance', 'club', 'floor', 'neon', 'city', 'party', 'bass', 'signal', 'static', 'wire', 'radio'],
};
const scores = {};
for (const [world, words] of Object.entries(FAMILIES)) {
  scores[world] = words.reduce((a, w) => a + (fullText.match(new RegExp(`\\b${w}`, 'g')) || []).length, 0);
}
const ranked = Object.entries(scores).sort((x, y) => y[1] - x[1]);
const subjectWorld = ranked[0][1] >= 3 && ranked[0][1] >= ranked[1][1] * 1.5 ? ranked[0][0] : null;

const WORLDS = [
  { world: 'venue' },
  {
    world: 'horizon',
    crack: false,
    display: 'Futura',
    text: '"Avenir Next"',
    textStyle: 'italic ',
    ink: '#FFF6EC',
    dim: '#9A8F9E',
    titleAccent: '#FFB347',
    verseAccents: ['#5FD3F0', '#8F7BF0', '#F06AAE', '#FFB347'],
    chorusAccents: ['#FF6FA8'],
  },
  {
    world: 'sanctum',
    crack: false,
    chorusInvert: false,
    display: 'Didot',
    displayWeight: 700,
    text: 'Baskerville',
    textWeightNormal: 400,
    textWeightEmph: 700,
    ink: '#EAE6DA',
    dim: '#77715F',
    titleAccent: '#D9A85C',
    verseAccents: ['#C9CFDA', '#AEB8CC', '#D9A85C', '#BFC6D4'],
    chorusAccents: ['#D3D9E4'],
    textCenterY: 0.42,
    plateMaxH: 0.5,
  },
];

/* Palette rotations per world, chosen by hash — two songs in the same
   world still do not twin. */
const ACCENT_SETS = {
  venue: [
    { verseAccents: ['#00C0E0', '#7060F0', '#B040F0', '#E0A040'], chorusAccents: ['#00C0E0', '#B040F0'] },
    { verseAccents: ['#B040F0', '#F04060', '#E0A040', '#00C0E0'], chorusAccents: ['#F04060'] },
    { verseAccents: ['#0090F0', '#00C0E0', '#7060F0', '#B040F0'], chorusAccents: ['#0090F0'] },
  ],
  horizon: [
    { verseAccents: ['#5FD3F0', '#8F7BF0', '#F06AAE', '#FFB347'], chorusAccents: ['#FF6FA8'] },
    { verseAccents: ['#FFB347', '#F06AAE', '#8F7BF0', '#5FD3F0'], chorusAccents: ['#FFB347'] },
  ],
  sanctum: [
    { verseAccents: ['#C9CFDA', '#AEB8CC', '#D9A85C', '#BFC6D4'], chorusAccents: ['#D3D9E4'] },
    { verseAccents: ['#D9A85C', '#C9CFDA', '#AEB8CC', '#D9A85C'], chorusAccents: ['#E4C79A'] },
  ],
  downpour: [
    { verseAccents: ['#9FC3E8', '#7FA8D8', '#C9CFDA', '#5FD3F0'], chorusAccents: ['#BFD8F2'] },
    { verseAccents: ['#5FD3F0', '#9FC3E8', '#8F7BF0', '#C9CFDA'], chorusAccents: ['#8FD0E8'] },
  ],
};

const DOWNPOUR = {
  world: 'downpour',
  crack: false,
  chorusInvert: false,
  display: '"Avenir Next"',
  displayWeight: 700,
  text: '"Avenir Next"',
  textWeightNormal: 500,
  textWeightEmph: 700,
  ink: '#E8EEF6',
  dim: '#6E7A8C',
  titleAccent: '#9FC3E8',
};

let style;
if (args.mode === 'visualizer') {
  // A different instrument per song: form, palette and turn all from the
  // hash; the motion dial still follows the record.
  const forms = ['ring', 'bars', 'waves'];
  const pal = [
    { verseAccents: ['#00C0E0', '#7060F0', '#B040F0', '#F04060', '#E0A040'], titleAccent: '#00C0E0' },
    { verseAccents: ['#B040F0', '#F04060', '#E0A040', '#00C0E0'], titleAccent: '#B040F0' },
    { verseAccents: ['#5FD3F0', '#8F7BF0', '#F06AAE', '#FFB347'], titleAccent: '#FFB347' },
  ][(h >>> 2) % 3];
  style = {
    world: 'visualizer',
    visForm: forms[h % forms.length],
    visSpin: (h >>> 5) % 2 ? -1 : 1,
    motion,
    tail: 3,
    ...pal,
  };
} else if (args.mode === 'scroll') {
  style = { world: 'scroll', motion: Math.min(0.5, motion), tail: 4 };
} else {
  // Subject first, when the song makes it obvious. Otherwise a slow dark
  // song leans sanctum and the hash rotates the rest of the catalogue.
  const byName = { venue: WORLDS[0], horizon: WORLDS[1], sanctum: WORLDS[2], downpour: DOWNPOUR };
  let base;
  if (subjectWorld) base = byName[subjectWorld];
  else if (A.bpm < 78) base = byName.sanctum;
  else base = [byName.venue, byName.horizon, byName.downpour][h % 3];
  const accents = ACCENT_SETS[base.world];
  style = { ...base, ...accents[(h >>> 3) % accents.length], motion, tail: 3 };
}

/* ----------------------------------------------------------------- output */

const sheet = {
  title: String(args.title || 'Untitled').slice(0, 120),
  artist: String(args.artist || 'MaxMusic').slice(0, 80),
  footer: 'github.com/atomtanstudio/maxmusic',
  note: `Directed automatically (${args.mode}) — profile bpm ${A.bpm}, motion ${style.motion}, world ${style.world}. Hand-author a sheet to overrule.`,
  ...(args.cover ? { cover: args.cover } : {}),
  style,
  sections,
  // A visualizer needs no aligner pass: this sheet doubles as its timing.
  ...(args.mode === 'visualizer' ? { lines: [] } : {}),
};

await fs.writeFile(args.out, JSON.stringify(sheet, null, 1));
console.log(`${sections.length} sections · world ${style.world} · motion ${style.motion} → ${args.out}`);
