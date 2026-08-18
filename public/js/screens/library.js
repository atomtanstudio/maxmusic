/**
 * MaxMusic — Library.
 *
 * Every song made on this machine. There is no list endpoint (SPEC §4), so the
 * index lives in this browser and the audio itself stays in the studio. That
 * fact is explained once, in customer language, in the empty state — it is
 * never printed as chrome on a working frame.
 *
 * Wired to real things:
 *   bus `track:new`          → a record is stored and `library:changed` is emitted
 *   bus `player:play`        → play / queue (the shell answers when no player exists)
 *   `<a download>`           → the real file that was rendered
 *   `api.generateStream()`   → run a song again from its own seed
 *   localStorage             → delete (with undo), import, export, clear
 *
 * Round 2 rebuild, against the named round 1 failures:
 *   - the row action strip is `.actionbar` + `.actionchip` (CONTRACT §6a) —
 *     34px containers visible at rest, one icon style, 12px gaps, and the
 *     destructive action moved into a right-aligned `…` menu at the row edge;
 *   - the strip starts on the same left rail as the title and the caption;
 *   - every row is one fixed pitch;
 *   - seeds, file sizes and provider names are gone from resting UI. The seed
 *     is still a first-class feature — it lives in the row's overflow menu and
 *     in the detail sheet, where reproducibility is actually used;
 *   - the list can no longer stop mid-page: it ends in a terminal card on the
 *     same rail and row height, which absorbs whatever height is left.
 *
 * Owned by the library lane: this file + public/css/screens/library.css.
 *
 * @module screens/library
 */

import { toRecord, coerce, loadRecords, saveRecords } from '../records.js';
import { downloadAudio, makeLyricVideo, downloadVideo, hasDisplayableLyrics } from '../studio-actions.js';
import { redoCoverArt } from '../cover-redo.js';
import { renameSong } from '../rename.js';

export const meta = {
  title: 'Library',
  subtitle: 'Everything you’ve made',
  css: '/css/screens/library.css',
};

/* ========================================================================== *
 * Storage
 * ========================================================================== */

// Records themselves live in records.js — the shell keeps the ledger.
const PREFS_KEY = 'library.prefs';

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'longest', label: 'Longest' },
  { value: 'shortest', label: 'Shortest' },
  { value: 'title', label: 'Title A–Z' },
];

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'vocal', label: 'Vocal' },
  { value: 'instrumental', label: 'Instrumental' },
];

const DEFAULT_PREFS = { view: 'list', sort: 'newest', filter: 'all' };

/**
 * The three sleeves in the empty state are real renders from this product's own
 * art model, shipped with the app. An empty library is the one moment a person
 * has not yet seen what comes out of it, so it shows the actual output rather
 * than an abstraction of it. If a file is ever missing the plate falls back to
 * a drawn one — a broken image is worse than a plainer one.
 */
const EMPTY_PLATES = [
  { src: '/demo/cover-blues.png', motif: 2, seed: 11 },
  { src: '/demo/cover-soul.png', motif: 0, seed: 48 },
  { src: '/demo/cover-synthwave.png', motif: 1, seed: 85 },
];

/* ========================================================================== *
 * Module-scope state that must outlive one mount
 *
 * A re-run takes minutes. Navigating away must not throw it on the floor, so
 * the job registry and the handles it needs (toast/storage/bus) live here.
 * ========================================================================== */

/** @type {Map<string, {id: string, status: string, startedAt: number, controller: AbortController, title: string}>} */
const jobs = new Map();

/** @type {?{toast: Function, storage: Object, emit: Function, api: Object}} */
let shell = null;

/**
 * Repaint hooks installed by the live mount and cleared on unmount, so a job
 * that outlives the screen still lands in storage and repaints if we come back.
 * @type {{jobs: ?Function, reload: ?Function}}
 */
const hooks = { jobs: null, reload: null };

/* ========================================================================== *
 * Formatting
 * ========================================================================== */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** @param {number} sec @returns {string} `m:ss` */
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short relative stamp for a row: `4 min ago`, `Yesterday`, `12 Aug`. */
function fmtWhen(ts) {
  if (!Number.isFinite(ts)) return '';
  const now = Date.now();
  const diff = now - ts;
  if (diff < 45_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `${Math.round(diff / 3_600_000)} hr ago`;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

/** Full stamp for the detail sheet. */
function fmtStamp(ts) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What the file should be called once it lands in someone's Downloads folder.
 * The name the studio wrote it under is a twenty-character hash — correct for a
 * disk, useless to a person, and exactly the kind of plumbing that has no place
 * in front of a customer.
 */
function downloadName(record) {
  const ext = String(record.format || String(record.filename || '').split('.').pop() || 'flac')
    .toLowerCase().replace(/[^a-z0-9]/g, '') || 'flac';
  const title = String(record.title || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${title || 'MaxMusic song'}.${ext}`;
}

function fmtSampleRate(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

/* The structured-caption section labels. Useful in the full caption, noise in
   a one-line row. */
const CAPTION_LABELS = /(Basic Attributes|Global Emotional Progression|Application Scenarios & Imagery|Sonics & Production Profile|Vocal Gender & Timbre|Vocal Style|Harmony\/Backing Vocals|Vocal FX|Instrument Lifecycle Description[^:]*|Groove & Foundation Progression|Embellishments, Textures & Spatial FX|Primary|Secondary)\s*:\s*/g;

/**
 * The caption is written for the model, so its head reads like a form:
 * "bpm is 96. key is D, and scale is minor." Say it the way a musician would.
 */
function humaniseAttributes(text) {
  return text
    .replace(/\bbpm is\s*(\d+(?:\.\d+)?)\s*[.,]?\s*/i, (_, bpm) => `${Math.round(Number(bpm))} BPM · `)
    .replace(/\bkey is\s*([A-G][#b♯♭]?)\s*,?\s*and scale is\s*(major|minor)\s*[.,]?\s*/i,
      (_, key, scale) => `${key} ${scale.toLowerCase()} · `)
    .replace(/\bkey is\s*([A-G][#b♯♭]?)\s*[.,]?\s*/i, (_, key) => `${key} · `)
    .replace(/\s*·\s*·\s*/g, ' · ');
}

/** The caption, label-stripped and turned back into prose. */
function captionText(record) {
  const raw = String(record.prompt || '').replace(CAPTION_LABELS, '').replace(/\s+/g, ' ').trim();
  return humaniseAttributes(raw)
    .replace(/\s+/g, ' ')
    .replace(/^[·\s]+/, '')
    /* Stripping the caption's labels leaves sentences starting lower-case.
       Put the capital back so the row reads as prose, not as a dumped field. */
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, c) => lead + c.toUpperCase())
    .trim();
}

const sentencesOf = (text) => String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

const normSentence = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Captions written by the same flow share whole sentences — "A lead vocal
 * delivers the written lyrics with natural phrasing." was ending every row in
 * the list, which made eight different songs read as eight copies of one
 * template. A sentence that appears in more than one *distinct* caption is not
 * describing this song, so the row drops it.
 *
 * Counted over distinct captions, never over records: a re-run repeats its
 * parent's caption verbatim, and that pair must not delete each other's text.
 *
 * @param {Array<Object>} records
 * @returns {Set<string>} normalised sentences that belong to no single song.
 */
function sharedSentencesOf(records) {
  const captions = new Set(records.map(captionText).filter(Boolean));
  const tally = new Map();
  for (const caption of captions) {
    for (const s of new Set(sentencesOf(caption).map(normSentence))) {
      tally.set(s, (tally.get(s) || 0) + 1);
    }
  }
  const shared = new Set();
  for (const [s, count] of tally) if (count > 1) shared.add(s);
  return shared;
}

/**
 * A simple-mode caption is "<the idea> <the style tags>", and the tag list
 * nearly always opens by restating the idea's genre: "A defiant punk anthem
 * about staying up far too late defiant punk rock, fast tempo, raw vocals…".
 * Find where the tags start — the first word pair that has already been said —
 * and cut from there to the first comma, so the row keeps the idea and the
 * tags and says the genre once.
 *
 * Deliberately timid: it only fires when the repeat sits in the last few words
 * before that comma and well past the middle of the phrase, because a caption
 * that genuinely repeats itself early ("a song about a song") must survive.
 */
const DANGLERS = /^(a|an|the|and|or|of|with|for|in|on|at|to|about|by|from|into|that|this)$/i;

function dropRestatedGenre(text) {
  const stop = text.indexOf(',');
  if (stop < 0) return text;
  const head = text.slice(0, stop).split(' ').filter(Boolean);
  if (head.length < 6) return text;
  const floor = Math.max(2, Math.ceil(head.length * 0.4));
  const seen = new Map();
  for (let i = 0; i + 1 < head.length; i += 1) {
    const pair = normSentence(`${head[i]} ${head[i + 1]}`);
    if (!/^[a-z]+ [a-z]+$/.test(pair)) continue;
    /* Cutting must leave a finished clause. If what remains trails off on
       "…about a" the repeat was part of the sentence, not the start of a list. */
    if (seen.has(pair) && i >= floor && head.length - i <= 6 && !DANGLERS.test(head[i - 1])) {
      return `${head.slice(0, i).join(' ')}${text.slice(stop)}`;
    }
    if (!seen.has(pair)) seen.set(pair, i);
  }
  return text;
}

/**
 * Drop the second run of any phrase of three words or more, keeping the
 * punctuation that hung off its last word.
 */
function dropRepeatedPhrase(text) {
  let words = text.split(' ').filter(Boolean);
  for (let pass = 0; pass < 2; pass += 1) {
    const limit = Math.min(8, Math.floor(words.length / 2));
    let cut = null;
    for (let n = limit; n >= 3 && !cut; n -= 1) {
      const seen = new Set();
      for (let i = 0; i + n <= words.length; i += 1) {
        const phrase = normSentence(words.slice(i, i + n).join(' '));
        if (phrase.split(' ').length < n) continue;
        if (seen.has(phrase)) { cut = { at: i, len: n }; break; }
        seen.add(phrase);
      }
    }
    if (!cut) break;
    const tail = (words[cut.at + cut.len - 1].match(/[,.;:]$/) || [''])[0];
    words.splice(cut.at, cut.len);
    const prev = cut.at - 1;
    if (tail && prev >= 0 && !/[,.;:]$/.test(words[prev])) words[prev] += tail;
    words = words.join(' ').replace(/\s+([,.;:])/g, '$1').split(' ').filter(Boolean);
  }
  return words.join(' ').replace(/[\s,;:]+$/, '').trim();
}

/**
 * One-line caption excerpt in customer language.
 * @param {Object} record
 * @param {Set<string>} [shared] Sentences the whole library has in common.
 */
function excerpt(record, shared) {
  const text = captionText(record);
  if (!text) {
    return record.isInstrumental
      ? 'Instrumental — no caption was saved with this song.'
      : 'No caption was saved with this song.';
  }
  const parts = sentencesOf(text);
  const own = shared ? parts.filter((s) => !shared.has(normSentence(s))) : parts;
  /* A song whose caption is *entirely* shared still gets a line: better a
     familiar sentence than a blank row. */
  return dropRepeatedPhrase(dropRestatedGenre((own.length ? own : parts).join(' '))) || text;
}

/* ========================================================================== *
 * Deterministic cover art
 *
 * Most songs have no rendered cover attached, and inventing a remote image is
 * both a lie and a network request. Instead every song gets a plate drawn from
 * its own seed, using the brand ramp read straight off tokens.css — so the art
 * is reproducible, offline, and never hard-codes a colour. Each plate keeps to
 * one narrow slice of the ramp: album art may be vivid, the interface may not.
 *
 * ROUND 3: these plates are FLAT. There is no `linearGradient`, no
 * `radialGradient` and no `stop` anywhere below. A soft neon mesh was exactly
 * the tell that got gradients banned from the product; hard-edged shapes in
 * two inks on a tinted black read as a pressed sleeve instead of a render.
 * ========================================================================== */

/** @type {?{ramp: string[], base: string}} */
let palette = null;

function readPalette() {
  if (palette) return palette;
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  palette = {
    ramp: [
      pick('--brand-cyan', '#00c0e0'),
      pick('--brand-blue', '#0090f0'),
      pick('--brand-violet', '#7060f0'),
      pick('--brand-magenta', '#b040f0'),
      pick('--brand-red', '#f04060'),
      pick('--brand-amber', '#e0a040'),
    ],
    base: pick('--surface-0', '#06070b'),
  };
  return palette;
}

function parseHex(hex) {
  const s = String(hex).replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
}

/** Blend two token colours so a plate can sit on a tinted near-black. */
function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  return `#${[0, 1, 2].map((i) => Math.round(A[i] * (1 - t) + B[i] * t).toString(16).padStart(2, '0')).join('')}`;
}

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rngFrom(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Build the SVG plate for a record. Deterministic in the record's seed/id, and
 * flat by rule — every shape below is a solid fill or a solid stroke.
 *
 * @param {Object} record
 * @param {number} [forceMotif] Only the empty state uses this, to show a spread.
 * @returns {string} SVG markup, safe to inject (all values are numbers/hex).
 */
function coverSvg(record, forceMotif) {
  const { ramp, base } = readPalette();
  const key = `${record.seed ?? ''}|${record.id ?? ''}|${record.title ?? ''}`;
  const h = hash32(key);
  const rnd = rngFrom(h);

  /* Two inks off one narrow slice of the ramp, on a tinted near-black. Two
     inks is a duotone sleeve; six is a colour-picker demo. */
  const i0 = h % 6;
  const ink = mix(ramp[i0], base, 0.1);
  const ink2 = mix(ramp[(i0 + 2) % 6], base, 0.36);
  const ground = mix(base, ramp[i0], 0.13);
  const n = (v) => v.toFixed(2);

  let body = '';
  const motif = Number.isInteger(forceMotif) ? forceMotif : h % 4;

  if (motif === 0) {
    /* spectrum — a symmetric bar read, each bar one flat fill */
    const bars = 17;
    const step = 100 / bars;
    let rects = '';
    for (let i = 0; i < bars; i += 1) {
      const t = (i + 0.5) / bars;
      const env = Math.sin(Math.PI * t) ** 0.6;
      const hh = Math.max(8, (16 + 70 * env) * (0.58 + 0.42 * rnd()));
      const w = step * 0.5;
      rects += `<rect x="${n(i * step + step * 0.25)}" y="${n((100 - hh) / 2)}"`
        + ` width="${n(w)}" height="${n(hh)}" rx="${n(w / 2)}" fill="${i % 3 === 1 ? ink2 : ink}"/>`;
    }
    body = `<rect x="0" y="49.3" width="100" height="1.4" fill="${ink2}"/>${rects}`;
  } else if (motif === 1) {
    /* orbit — concentric rings cut by one hard band */
    const cx = 30 + rnd() * 40;
    const cy = 30 + rnd() * 40;
    const gap = 6 + rnd() * 5;
    const count = 4 + Math.floor(rnd() * 4);
    let rings = '';
    for (let i = 0; i < count; i += 1) {
      rings += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(7 + i * gap)}" fill="none"`
        + ` stroke="${i % 2 ? ink2 : ink}" stroke-width="${n(1.2 + rnd() * 2.4)}"/>`;
    }
    body = `${rings}<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(4 + rnd() * 4)}" fill="${ink}"/>`
      + `<rect x="0" y="${n(58 + rnd() * 24)}" width="100" height="${n(5 + rnd() * 14)}" fill="${ground}"/>`;
  } else if (motif === 2) {
    /* horizon — a slatted sun over a ruled ground */
    const hy = 52 + rnd() * 16;
    const sx = 26 + rnd() * 48;
    const sr = 16 + rnd() * 8;
    let slats = '';
    for (let i = 0; i < 5; i += 1) {
      slats += `<rect x="0" y="${n(hy - sr * 0.95 + i * sr * 0.4)}" width="100"`
        + ` height="${n(1 + i * 0.7)}" fill="${ground}"/>`;
    }
    let rules = '';
    for (let i = 0; i < 6; i += 1) {
      const y = hy + 2.5 + i * i * 1.4 + i * 2.2;
      if (y > 99) break;
      rules += `<rect x="0" y="${n(y)}" width="100" height="${n(0.8 + i * 0.3)}" fill="${ink2}"/>`;
    }
    body = `<circle cx="${n(sx)}" cy="${n(hy - sr * 0.3)}" r="${n(sr)}" fill="${ink}"/>${slats}`
      + `<rect x="0" y="${n(hy)}" width="100" height="${n(100 - hy)}" fill="${ground}"/>`
      + `<rect x="0" y="${n(hy - 0.7)}" width="100" height="1.4" fill="${ink}"/>${rules}`;
  } else {
    /* prism — hard rotated bands with a knocked-out disc */
    const rot = (rnd() < 0.5 ? -1 : 1) * (6 + rnd() * 40);
    const cols = [ink, ink2, ink, ink2, ink];
    const count = 3 + Math.floor(rnd() * 3);
    let bands = '';
    let x = -30;
    for (let i = 0; i < count; i += 1) {
      const w = 8 + rnd() * 24;
      bands += `<rect x="${n(x)}" y="-50" width="${n(w)}" height="200" fill="${cols[i % cols.length]}"/>`;
      x += w + 4 + rnd() * 14;
    }
    body = `<g transform="rotate(${n(rot)} 50 50)">${bands}</g>`
      + `<circle cx="${n(28 + rnd() * 44)}" cy="${n(26 + rnd() * 44)}" r="${n(11 + rnd() * 12)}" fill="${ground}"/>`;
  }

  return `<svg class="cover__art" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">`
    + `<rect width="100" height="100" fill="${ground}"/>${body}</svg>`;
}

/** The same plate as a data: URI, so the player can show identical art offline. */
function coverDataUri(record) {
  const svg = coverSvg(record).replace(' class="cover__art"', ' xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ========================================================================== *
 * Records
 * ========================================================================== */

/* ========================================================================== *
 * Screen
 * ========================================================================== */

export function mount(root, ctx) {
  const { api } = ctx;

  shell = { toast: ctx.toast, storage: ctx.storage, emit: ctx.bus.emit, api };

  /* ------------------------------------------------------------- state -- */

  const prefs = { ...DEFAULT_PREFS, ...(ctx.storage.get(PREFS_KEY, null) || {}) };
  if (!SORTS.some((s) => s.value === prefs.sort)) prefs.sort = DEFAULT_PREFS.sort;
  if (!FILTERS.some((f) => f.value === prefs.filter)) prefs.filter = DEFAULT_PREFS.filter;
  if (prefs.view !== 'grid' && prefs.view !== 'list') prefs.view = DEFAULT_PREFS.view;

  let records = loadRecords(ctx.storage);
  let query = '';
  let visible = [];
  /** Sentences every caption shares; recomputed whenever the library changes. */
  let shared = sharedSentencesOf(records);
  let health = ctx.health;
  let playing = { id: null, isPlaying: false };
  /** @type {?HTMLElement} */
  let sheetReturnFocus = null;
  let openSheetId = null;

  const cleanups = [];
  /** Row overflow menus built for the current paint; torn down on the next one. */
  let rowMenus = [];

  /* ------------------------------------------------------------- store -- */

  function persist(next, { silent = false, allowEmpty = false } = {}) {
    records = next;
    const ok = saveRecords(ctx.storage, records, { allowEmpty });
    if (!ok) {
      ctx.toast('This browser refused to save your library — its storage is full or blocked. What you see is correct until you reload.', {
        kind: 'error', title: 'Could not save',
      });
    }
    ctx.bus.emit('library:changed', { count: records.length });
    if (!silent) render();
    return ok;
  }

  function addRecords(incoming, { announce = true } = {}) {
    const list = Array.isArray(incoming) ? incoming : [incoming];
    const byId = new Map(records.map((r) => [r.id, r]));
    let added = 0;
    for (const item of list) {
      if (!item || byId.has(item.id)) continue;
      byId.set(item.id, item);
      added += 1;
    }
    if (!added) return 0;
    const next = Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
    persist(next, { silent: !announce });
    return added;
  }

  function removeRecord(id) {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    const index = records.findIndex((r) => r.id === id);
    persist(records.filter((r) => r.id !== id));
    if (openSheetId === id) closeSheet();
    ctx.toast(`Removed “${record.title}” from your library. The audio file itself is untouched.`, {
      kind: 'info',
      title: 'Removed',
      timeout: 8000,
      action: {
        label: 'Undo',
        onClick: () => {
          const next = records.slice();
          next.splice(Math.min(index, next.length), 0, record);
          persist(next);
        },
      },
    });
  }

  /* -------------------------------------------------------- derivations -- */

  function matches(record, q) {
    if (!q) return true;
    const haystack = [
      record.title, record.prompt, record.lyrics, record.filename,
      record.format, record.seed === null ? '' : String(record.seed),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
  }

  function compute() {
    shared = sharedSentencesOf(records);
    const q = query.trim().toLowerCase();
    let list = records.filter((r) => {
      if (prefs.filter === 'vocal' && r.isInstrumental) return false;
      if (prefs.filter === 'instrumental' && !r.isInstrumental) return false;
      return matches(r, q);
    });
    const dur = (r) => (Number.isFinite(r.duration) ? r.duration : -1);
    list = list.slice().sort((a, b) => {
      switch (prefs.sort) {
        case 'oldest': return a.createdAt - b.createdAt;
        case 'longest': return dur(b) - dur(a) || b.createdAt - a.createdAt;
        case 'shortest': return dur(a) - dur(b) || b.createdAt - a.createdAt;
        case 'title': return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        default: return b.createdAt - a.createdAt;
      }
    });
    visible = list;
    return list;
  }

  /* --------------------------------------------------------- structure -- */

  const page = document.createElement('div');
  page.className = 'screen-library';
  page.innerHTML = `
    <div class="lib">
      <div class="lib__bar" data-role="bar">
        <div class="lib__search">
          ${ctx.iconMarkup('search', 'icon lib__search-icon')}
          <input class="input lib__search-input" type="search" data-role="search"
                 placeholder="Search your songs" autocomplete="off"
                 aria-label="Search your songs">
          <button class="lib__search-clear" type="button" data-role="search-clear"
                  aria-label="Clear search" hidden>${ctx.iconMarkup('close')}</button>
        </div>
        <div class="lib__tools">
          <div class="segment lib__filter" role="tablist" aria-label="Filter by type" data-role="filter">
            ${FILTERS.map((f) => `<button class="segment__item" type="button" role="tab" data-filter="${f.value}">${esc(f.label)}</button>`).join('')}
          </div>
          <label class="lib__sort">
            <span class="visually-hidden">Sort</span>
            <select class="select" data-role="sort">
              ${SORTS.map((s) => `<option value="${s.value}">${esc(s.label)}</option>`).join('')}
            </select>
          </label>
          <span class="lib__menuslot" data-role="menuslot"></span>
        </div>
      </div>
      <p class="lib__stats" data-role="stats" hidden></p>
      <div class="lib__body" data-role="body"></div>
    </div>
    <input type="file" accept="application/json,.json" data-role="import-input" hidden>`;

  root.append(page);

  const bar = page.querySelector('[data-role="bar"]');
  const searchInput = page.querySelector('[data-role="search"]');
  const searchClear = page.querySelector('[data-role="search-clear"]');
  const filterGroup = page.querySelector('[data-role="filter"]');
  const sortSelect = page.querySelector('[data-role="sort"]');
  const menuSlot = page.querySelector('[data-role="menuslot"]');
  const statsLine = page.querySelector('[data-role="stats"]');
  const body = page.querySelector('[data-role="body"]');
  const importInput = page.querySelector('[data-role="import-input"]');

  sortSelect.value = prefs.sort;

  /* The library-level overflow. Everything destructive lives in a menu. */
  menuSlot.append(ctx.menu({
    label: 'Library options',
    align: 'end',
    items: () => [
      { label: 'Export library', icon: 'download', disabled: !records.length, onSelect: exportLibrary },
      { label: 'Import library', icon: 'plus', onSelect: () => importInput.click() },
      { separator: true },
      { label: 'Delete all songs', icon: 'trash', danger: true, disabled: !records.length, onSelect: clearLibrary },
    ],
  }));

  /* ------------------------------------------------------- header slot -- */

  const headerTools = document.createElement('div');
  headerTools.className = 'lib-headtools';
  headerTools.innerHTML = `
    <div class="segment lib-view" role="group" aria-label="Layout">
      <button class="segment__item" type="button" data-view="list" title="List view">
        ${ctx.iconMarkup('menu')}<span class="lib-view__label">List</span>
      </button>
      <button class="segment__item" type="button" data-view="grid" title="Grid view">
        ${ctx.iconMarkup('art')}<span class="lib-view__label">Grid</span>
      </button>
    </div>`;
  ctx.headerSlot.append(headerTools);

  headerTools.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (!view) return;
    prefs.view = view.dataset.view;
    ctx.storage.set(PREFS_KEY, prefs);
    render();
  });

  /* ============================== rendering ============================= */

  function paintChrome() {
    const empty = records.length === 0;
    headerTools.hidden = empty;
    bar.hidden = empty;
    for (const btn of filterGroup.querySelectorAll('[data-filter]')) {
      btn.classList.toggle('is-active', btn.dataset.filter === prefs.filter);
      btn.setAttribute('aria-selected', String(btn.dataset.filter === prefs.filter));
    }
    for (const btn of headerTools.querySelectorAll('[data-view]')) {
      const active = btn.dataset.view === prefs.view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    searchClear.hidden = !query;

    /* A count is only worth screen space when it is telling you something you
       did not already know: that a filter is hiding things. */
    const filtered = records.length > 0 && visible.length !== records.length;
    statsLine.hidden = !filtered;
    if (filtered) {
      statsLine.textContent = `${visible.length} of ${records.length} songs`;
    }
  }

  /** Cover block shared by both views. */
  function coverMarkup(record) {
    const art = record.cover
      ? `<img class="cover__img" src="${esc(api.mediaUrl(record.cover))}" alt="" loading="lazy">`
      : coverSvg(record);
    const time = Number.isFinite(record.duration)
      ? `<span class="cover__time">${fmtDuration(record.duration)}</span>` : '';
    return `<span class="cover" data-cover role="button" tabindex="-1" aria-hidden="true">
        ${art}
        <span class="cover__eq"><i></i><i></i><i></i><i></i></span>
        <span class="cover__play">${ctx.iconMarkup('play')}</span>
        ${time}
      </span>`;
  }

  function badgesMarkup(record) {
    const out = [];
    if (record.isInstrumental) out.push('<span class="badge lib-badge">Instrumental</span>');
    if (record.format) out.push(`<span class="badge lib-badge">${esc(record.format.toUpperCase())}</span>`);
    if (record.parentId) out.push('<span class="badge lib-badge">Re-run</span>');
    return out.join('');
  }

  /* Blocked actions stay clickable and carry `aria-disabled` + the reason: a
     natively disabled button swallows hover, so its tooltip never appears and
     the user is never told why. Clicking one toasts the reason instead. */
  function actionsMarkup(record) {
    const reason = regenerateBlockReason(record);
    const noFile = 'No audio was saved for this song, so there is nothing to play or download.';
    const canPlay = Boolean(record.url);
    return `
      <div class="actionbar lib-actions">
        <button class="actionchip actionchip--lg" type="button" data-act="play"
                ${canPlay ? '' : 'aria-disabled="true"'}
                title="${canPlay ? 'Play' : esc(noFile)}" aria-label="Play">${ctx.iconMarkup('play')}</button>
        ${canPlay
          ? `<a class="actionchip" data-act="download" href="${esc(api.mediaUrl(record.url))}"
                download="${esc(downloadName(record))}"
                title="Download" aria-label="Download">${ctx.iconMarkup('download')}</a>`
          : `<button class="actionchip" type="button" data-act="blocked" aria-disabled="true"
                title="${esc(noFile)}" aria-label="Download">${ctx.iconMarkup('download')}</button>`}
        <button class="actionchip" type="button" data-act="regenerate" ${reason ? 'aria-disabled="true"' : ''}
                title="${esc(reason || 'Make this song again')}"
                aria-label="Make this song again">${ctx.iconMarkup('refresh')}</button>
      </div>`;
  }

  /** The `…` trigger. Its items are attached after paint by `wireRowMenus`. */
  function overflowMarkup(record) {
    return `<button class="actionchip lib-more" type="button" data-role="more"
              data-for="${esc(record.id)}" aria-label="More actions for ${esc(record.title)}"
              >${ctx.iconMarkup('more')}</button>`;
  }

  /* The studio actions live in studio-actions.js, shared with Create. */

  function menuItems(record) {
    const hasLyrics = hasDisplayableLyrics(record);
    return [
      { label: 'Song details', icon: 'info', onSelect: () => openSheet(record.id, null) },
      { label: 'Rename song or artist', icon: 'pencil', onSelect: () => renameSong(ctx, record) },
      { separator: true },
      { label: 'Download FLAC', icon: 'wave', disabled: !record.url, onSelect: () => downloadAudio(ctx, record, 'flac') },
      { label: 'Download MP3', icon: 'wave', disabled: !record.url, onSelect: () => downloadAudio(ctx, record, 'mp3') },
      {
        label: 'Make a lyric video',
        icon: 'wave',
        note: hasLyrics ? 'Shows every lyric' : 'No lyrics saved',
        disabled: !record.url || !hasLyrics,
        onSelect: () => makeLyricVideo(ctx, record, 'film'),
      },
      {
        label: 'Make an audio visualizer',
        icon: 'wave',
        note: hasLyrics ? 'No lyric text' : 'Music only',
        disabled: !record.url,
        onSelect: () => makeLyricVideo(ctx, record, 'visualizer'),
      },
      ...(record.videos || []).map((v) => ({
        label: { film: 'Download the lyric video', scroll: 'Download the lyric scroll', visualizer: 'Download the visualizer video' }[v.mode] || 'Download the video',
        icon: 'download',
        onSelect: () => downloadVideo(ctx, record, v.mode),
      })),
      {
        label: 'Redo the cover art',
        icon: 'wand',
        onSelect: () => redoCoverArt(ctx, record),
      },
      { separator: true },
      { label: 'Copy caption', icon: 'copy', disabled: !record.prompt, onSelect: () => copy(record.prompt, 'Caption') },
      { label: 'Copy lyrics', icon: 'copy', disabled: !hasLyrics, onSelect: () => copy(record.lyrics, 'Lyrics') },
      {
        label: 'Copy seed',
        icon: 'dice',
        note: record.seed === null ? '' : String(record.seed),
        disabled: record.seed === null,
        onSelect: () => copy(String(record.seed), 'Seed'),
      },
      { separator: true },
      { label: 'Delete song', icon: 'trash', danger: true, onSelect: () => removeRecord(record.id) },
    ];
  }

  function wireRowMenus() {
    for (const controller of rowMenus) { try { controller.destroy(); } catch { /* noop */ } }
    rowMenus = [];
    for (const trigger of body.querySelectorAll('[data-role="more"]')) {
      const id = trigger.dataset.for;
      rowMenus.push(ctx.attachMenu(trigger, {
        align: 'end',
        items: () => {
          const record = recordById(id);
          return record ? menuItems(record) : [];
        },
      }));
    }
  }

  function jobMarkup(record) {
    const job = jobs.get(record.id);
    if (!job) return '';
    return `<div class="lib-job" data-job="${esc(record.id)}">
        <span class="brandline"></span>
        <span class="lib-job__text">
          ${ctx.iconMarkup('spinner', 'icon spinner')}
          <span data-role="job-status">${esc(job.status)}</span>
          <span class="mono lib-job__clock" data-role="job-clock">0:00</span>
        </span>
        <button class="btn btn--sm" type="button" data-act="cancel-job">Cancel</button>
      </div>`;
  }

  function rowMarkup(record) {
    return `<li class="lib-row" data-id="${esc(record.id)}" tabindex="0">
      ${coverMarkup(record)}
      <div class="lib-row__main">
        <p class="lib-row__title"><span class="lib-row__name truncate">${esc(record.title)}</span>${badgesMarkup(record)}</p>
        <p class="lib-row__excerpt">${esc(excerpt(record, shared))}</p>
        ${actionsMarkup(record)}
      </div>
      <span class="lib-row__when">${esc(fmtWhen(record.createdAt))}</span>
      ${overflowMarkup(record)}
      ${jobMarkup(record)}
    </li>`;
  }

  function cardMarkup(record) {
    const canPlay = Boolean(record.url);
    return `<li class="lib-card" data-id="${esc(record.id)}" tabindex="0">
      <span class="lib-card__art">
        ${coverMarkup(record)}
        <span class="actionbar lib-card__actions">
          <button class="actionchip actionchip--lg" type="button" data-act="play"
                  ${canPlay ? '' : 'aria-disabled="true"'}
                  aria-label="Play" title="Play">${ctx.iconMarkup('play')}</button>
        </span>
      </span>
      <div class="lib-card__body">
        <div class="lib-card__id">
          <p class="lib-card__title truncate">${esc(record.title)}</p>
          <p class="lib-card__meta">
            <span>${esc(fmtWhen(record.createdAt))}</span>
            ${record.isInstrumental ? '<span class="lib-card__dot">·</span><span>Instrumental</span>' : ''}
          </p>
        </div>
        ${overflowMarkup(record)}
      </div>
      ${jobMarkup(record)}
    </li>`;
  }

  /**
   * The floor. Round 1's list simply stopped at 44% of the viewport and left
   * flat nothing under it. This card sits on the same left rail and the same
   * row height as a song, and absorbs whatever height is left over — so three
   * songs read as a designed sparse library, not a half-failed render.
   */
  function tailMarkup() {
    return `<div class="lib-tail" data-role="tail">
      <span class="lib-tail__plate" aria-hidden="true">${ctx.iconMarkup('plus')}</span>
      <div class="lib-tail__main">
        <p class="lib-tail__title">Write another song</p>
        <p class="lib-tail__text">Describe an idea and MaxMusic writes the lyrics for you, or bring
          your own words and shape the arrangement yourself in Studio.</p>
      </div>
      <div class="lib-tail__cta">
        <button class="btn btn--strong" type="button" data-action="go-create">
          ${ctx.iconMarkup('wand')}New song
        </button>
        <button class="btn btn--ghost" type="button" data-action="go-studio">
          ${ctx.iconMarkup('studio')}Open Studio
        </button>
      </div>
    </div>`;
  }

  /**
   * The terminal card always fills the leftover height, so the page has a floor
   * whatever the list length. When that leftover is most of the frame it also
   * recomposes into a centred panel.
   *
   * The decision is taken from the room *below the list* — never from the
   * card's own height, which the card's own layout would then change.
   */
  function fitTail() {
    const tail = body.querySelector('[data-role="tail"]');
    const list = body.querySelector('.lib-list, .lib-grid');
    if (!tail || !list) return;
    const room = root.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
    /* Below this the card is close enough to a row to keep the row layout and
       the left rail; above it, that layout is a thin band floating in a big
       box, so the card recomposes instead. */
    tail.classList.toggle('is-tall', room > 290);
  }

  let fitQueued = false;
  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fitTail(); });
  }

  const roomWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queueFit);
  roomWatch?.observe(root);
  window.addEventListener('resize', queueFit);
  cleanups.push(() => {
    roomWatch?.disconnect();
    window.removeEventListener('resize', queueFit);
  });

  function emptyLibraryMarkup() {
    const plates = EMPTY_PLATES
      .map((plate, i) => `<span class="lib-empty__plate lib-empty__plate--${i + 1}">`
        + `<img class="cover__img" src="${plate.src}" alt="" data-plate="${i}">`
        + `</span>`)
      .join('');
    return `<div class="lib-empty">
      <div class="lib-empty__art" aria-hidden="true">${plates}</div>
      <h2 class="lib-empty__title">Nothing here yet</h2>
      <p class="lib-empty__lead">
        Every song you make lands here — with the caption it was built from, its
        lyrics, its seed and the original audio file, ready to download.
      </p>
      <div class="lib-empty__cta">
        <button class="btn btn--strong btn--lg" type="button" data-action="go-create">
          ${ctx.iconMarkup('wand')}Write a song
        </button>
        <button class="btn btn--lg" type="button" data-action="go-studio">
          ${ctx.iconMarkup('studio')}Open Studio
        </button>
      </div>
      <ul class="lib-empty__facts">
        <li><span class="lib-empty__fact-icon">${ctx.iconMarkup('dice')}</span>
          <b>Reproducible</b><span>Every song keeps its seed and caption, so one click makes the exact same song again.</span></li>
        <li><span class="lib-empty__fact-icon">${ctx.iconMarkup('download')}</span>
          <b>Yours to keep</b><span>Download the file exactly as it was rendered — FLAC, WAV or MP3, untouched.</span></li>
        <li><span class="lib-empty__fact-icon">${ctx.iconMarkup('lock')}</span>
          <b>Stays private</b><span>Your library is kept on this computer. Nothing is published and nothing is uploaded.</span></li>
      </ul>
      <p class="lib-empty__note">
        Moving to another machine? <button class="lib-link" type="button" data-action="import">Import a library file</button>
        you exported earlier and your songs come with you.
      </p>
    </div>`;
  }

  /** A missing sleeve degrades to a drawn plate instead of a broken image. */
  function wireEmptyPlates() {
    for (const img of body.querySelectorAll('[data-plate]')) {
      img.addEventListener('error', () => {
        const i = Number(img.dataset.plate) || 0;
        const plate = EMPTY_PLATES[i] || EMPTY_PLATES[0];
        const holder = img.parentElement;
        if (holder) {
          holder.innerHTML = coverSvg({ id: `maxmusic-plate-${i}`, seed: plate.seed, title: 'MaxMusic' }, plate.motif);
        }
      }, { once: true });
    }
  }

  function emptyResultsMarkup() {
    return `<div class="lib-noresults">
      <span class="lib-noresults__icon">${ctx.iconMarkup('search')}</span>
      <h2 class="lib-noresults__title">No songs match</h2>
      <p class="lib-noresults__text">
        Nothing in your ${records.length} ${records.length === 1 ? 'song' : 'songs'} matches
        ${query ? `“${esc(query)}”` : 'this filter'}${prefs.filter !== 'all' ? ` in ${prefs.filter} songs` : ''}.
      </p>
      <button class="btn" type="button" data-action="reset-filters">Clear search and filters</button>
    </div>`;
  }

  function render() {
    compute();
    paintChrome();

    if (!records.length) {
      body.innerHTML = emptyLibraryMarkup();
      wireEmptyPlates();
      wireRowMenus();
      return;
    }
    if (!visible.length) {
      body.innerHTML = emptyResultsMarkup();
      wireRowMenus();
      return;
    }

    const grid = prefs.view === 'grid';
    body.innerHTML = `<ul class="${grid ? 'lib-grid' : 'lib-list'}" role="list">`
      + visible.map(grid ? cardMarkup : rowMarkup).join('')
      + '</ul>'
      + tailMarkup();
    wireRowMenus();
    fitTail();
    paintPlaying();
    paintJobs();
  }

  /* ------------------------------------------------- live row painting -- */

  function paintPlaying() {
    for (const node of body.querySelectorAll('[data-id]')) {
      const isCurrent = node.dataset.id === playing.id;
      node.classList.toggle('is-current', isCurrent);
      node.classList.toggle('is-playing', isCurrent && playing.isPlaying);
      const play = node.querySelector('[data-act="play"]');
      if (play) {
        const on = isCurrent && playing.isPlaying;
        play.setAttribute('aria-label', on ? 'Pause' : 'Play');
        play.setAttribute('title', on ? 'Pause' : 'Play');
        play.classList.toggle('is-active', on);
      }
    }
  }

  function paintJobs() {
    for (const node of body.querySelectorAll('[data-id]')) {
      const job = jobs.get(node.dataset.id);
      node.classList.toggle('is-working', Boolean(job));
      const holder = node.querySelector('[data-job]');
      if (job && !holder) { node.insertAdjacentHTML('beforeend', jobMarkup({ id: node.dataset.id })); }
      if (!job && holder) holder.remove();
      if (job && holder) {
        const status = holder.querySelector('[data-role="job-status"]');
        if (status) status.textContent = job.status;
      }
    }
    tickClocks();
  }

  function tickClocks() {
    for (const node of body.querySelectorAll('[data-job]')) {
      const job = jobs.get(node.dataset.job);
      if (!job) continue;
      const clock = node.querySelector('[data-role="job-clock"]');
      if (clock) clock.textContent = fmtDuration((Date.now() - job.startedAt) / 1000);
    }
  }

  const clockTimer = setInterval(tickClocks, 1000);
  cleanups.push(() => clearInterval(clockTimer));

  hooks.jobs = () => { paintJobs(); if (openSheetId) paintSheetJob(); };
  hooks.reload = () => { records = loadRecords(ctx.storage); render(); };
  cleanups.push(() => { hooks.jobs = null; hooks.reload = null; });

  /* ================================ actions ============================ */

  function recordById(id) { return records.find((r) => r.id === id) || null; }

  function playPayload(record) {
    return {
      track: { id: record.id, filename: record.filename, url: record.url, size: record.size },
      title: record.title,
      cover: record.cover ? api.mediaUrl(record.cover) : coverDataUri(record),
      meta: {
        prompt: record.prompt,
        lyrics: record.lyrics,
        duration: record.duration,
        requestedDuration: record.requestedDuration,
        durationWarning: record.durationWarning,
        seed: record.seed,
        format: record.format,
        isInstrumental: record.isInstrumental,
        createdAt: record.createdAt,
      },
    };
  }

  function play(record) {
    if (!record?.url) {
      ctx.toast('No audio was saved for this song, so there is nothing to play.', { kind: 'warn', title: 'Cannot play' });
      return;
    }
    const from = visible.findIndex((r) => r.id === record.id);
    const queue = (from >= 0 ? visible.slice(from) : [record]).filter((r) => r.url).map(playPayload);
    ctx.bus.emit('player:play', { ...playPayload(record), queue });
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(`${label} copied.`, { kind: 'success', timeout: 2200 });
    } catch (err) {
      ctx.toast(`Could not copy: ${err?.message || err}`, { kind: 'error' });
    }
  }

  /* ------------------------------------------------- re-run with seed -- */

  function regenerateInput(record) {
    const input = {
      prompt: record.prompt,
      lyrics: record.isInstrumental ? '' : record.lyrics,
      is_instrumental: record.isInstrumental,
      seed: record.seed,
    };
    if (Number.isFinite(record.requestedDuration)) input.duration = record.requestedDuration;
    else if (Number.isFinite(record.duration)) input.duration = record.duration;
    if (record.model) input.model = record.model;
    const audio = {};
    if (record.format) audio.format = record.format;
    if (record.sampleRate) audio.sample_rate = record.sampleRate;
    if (record.bitrate && record.format === 'mp3') audio.bitrate = record.bitrate;
    if (Object.keys(audio).length) input.audio_setting = audio;
    return input;
  }

  /** @returns {string} empty when a re-run is possible, otherwise the honest reason. */
  function regenerateBlockReason(record) {
    if (jobs.has(record.id)) return 'This song is already being made.';
    if (record.seed === null) return 'No seed was saved for this song, so it cannot be made again exactly.';
    const check = api.validateGeneration(regenerateInput(record));
    if (!check.valid) return check.errors.join(' ');
    if (health && health.status !== 'online') return health.message;
    return '';
  }

  async function regenerate(record) {
    const reason = regenerateBlockReason(record);
    if (reason) { ctx.toast(reason, { kind: 'warn', title: 'Cannot make this again' }); return; }

    const controller = new AbortController();
    const job = { id: record.id, status: 'Starting…', startedAt: Date.now(), controller, title: record.title };
    jobs.set(record.id, job);
    hooks.jobs?.();

    const bump = (status) => {
      job.status = status;
      hooks.jobs?.();
    };

    try {
      const result = await api.generateStream(regenerateInput(record), {
        signal: controller.signal,
        onEvent: (event) => {
          if (event?.status === 'queued') bump('Waiting for a free slot…');
          else if (event?.partial) bump('Writing the music…');
          else if (event?.done) bump('Finishing the mix…');
        },
      });

      const fresh = toRecord({
        track: result.track,
        meta: {
          title: `${record.title.replace(/\s+\(re-run(?: \d+)?\)$/i, '')} (re-run)`,
          prompt: record.prompt,
          lyrics: record.lyrics,
          isInstrumental: record.isInstrumental,
          duration: record.duration,
          seed: record.seed,
          format: record.format,
          sample_rate: record.sampleRate,
          bitrate: record.bitrate,
          model: record.model,
          extra_info: result.extra_info,
          createdAt: Date.now(),
          source: 'library:re-run',
          parentId: record.id,
        },
      });

      jobs.delete(record.id);

      const store = shell?.storage || ctx.storage;
      const current = loadRecords(store);
      if (!current.some((r) => r.id === fresh.id)) {
        const next = [fresh, ...current].sort((a, b) => b.createdAt - a.createdAt);
        saveRecords(store, next);
        (shell?.emit || ctx.bus.emit)('library:changed', { count: next.length });
      }
      if (hooks.reload) hooks.reload(); else hooks.jobs?.();

      (shell?.toast || ctx.toast)(`“${fresh.title}” is ready.`, {
        kind: 'success',
        title: 'Done',
        action: { label: 'Play', onClick: () => ctx.bus.emit('player:play', playPayload(fresh)) },
      });
    } catch (err) {
      jobs.delete(record.id);
      hooks.jobs?.();
      if (err?.name === 'AbortError') {
        (shell?.toast || ctx.toast)(`Stopped making “${record.title}”.`, { kind: 'info', timeout: 3000 });
        return;
      }
      (shell?.toast || ctx.toast)(api.errorText(err), { kind: 'error', title: 'Could not make this song' });
    }
  }

  /* ---------------------------------------------------- import/export -- */

  function exportLibrary() {
    if (!records.length) return;
    const blob = new Blob([JSON.stringify({
      app: 'maxmusic', kind: 'library', version: 1, exportedAt: new Date().toISOString(), tracks: records,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maxmusic-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ctx.toast(`Exported ${records.length} ${records.length === 1 ? 'song' : 'songs'}.`, { kind: 'success', timeout: 3000 });
  }

  async function importLibrary(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed?.tracks;
      if (!Array.isArray(list)) throw new Error('That file does not look like a MaxMusic library.');
      const incoming = list.filter((r) => r && typeof r === 'object' && (r.url || r.id)).map(coerce);
      if (!incoming.length) throw new Error('That file contained no songs.');
      const added = addRecords(incoming);
      const skipped = incoming.length - added;
      ctx.toast(added
        ? `Imported ${added} ${added === 1 ? 'song' : 'songs'}.${skipped ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} already here.` : ''}`
        : `All ${incoming.length} ${incoming.length === 1 ? 'song' : 'songs'} in that file are already in your library.`,
      { kind: added ? 'success' : 'info', title: 'Import' });
    } catch (err) {
      ctx.toast(`Could not read that file: ${err?.message || err}`, { kind: 'error', title: 'Import failed' });
    }
  }

  function clearLibrary() {
    if (!records.length) return;
    const backup = records.slice();
    persist([], { allowEmpty: true });
    closeSheet();
    ctx.toast(`Deleted ${backup.length} ${backup.length === 1 ? 'song' : 'songs'} from your library. The audio files themselves are untouched.`, {
      kind: 'warn',
      title: 'Library cleared',
      timeout: 10000,
      action: { label: 'Undo', onClick: () => persist(backup) },
    });
  }

  /* ============================== detail sheet ========================= */

  const sheet = document.createElement('div');
  sheet.className = 'lib-sheet';
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="lib-sheet__scrim" data-role="scrim"></div>
    <aside class="lib-sheet__panel" role="dialog" aria-modal="true" aria-label="Song details" data-role="panel"></aside>`;
  page.append(sheet);

  const sheetPanel = sheet.querySelector('[data-role="panel"]');

  function metaRow(label, value, { mono = false } = {}) {
    return `<div class="lib-meta__item">
      <dt>${esc(label)}</dt>
      <dd class="${mono ? 'mono' : ''}">${esc(value)}</dd>
    </div>`;
  }

  function sheetMarkup(record) {
    const reason = regenerateBlockReason(record);
    const requestedLength = Number(record.requestedDuration);
    const showsRequestedLength = Number.isFinite(requestedLength)
      && Number.isFinite(record.duration)
      && Math.abs(requestedLength - record.duration) >= 1.5;
    const lyrics = record.isInstrumental
      ? 'Instrumental — this song was made without lyrics.'
      : (record.lyrics || 'No lyrics were saved with this song.');
    return `
      <header class="lib-sheet__head">
        <span class="lib-sheet__cover">${record.cover
          ? `<img class="cover__img" src="${esc(api.mediaUrl(record.cover))}" alt="">`
          : coverSvg(record)}</span>
        <div class="lib-sheet__id">
          <h2 class="lib-sheet__title">${esc(record.title)}</h2>
          <p class="lib-sheet__badges">${badgesMarkup(record) || '<span class="badge lib-badge">Song</span>'}</p>
          <p class="lib-sheet__when">${esc(fmtStamp(record.createdAt))}</p>
        </div>
        <button class="actionchip lib-sheet__close" type="button" data-act="close" aria-label="Close details">
          ${ctx.iconMarkup('close')}
        </button>
      </header>

      <div class="lib-sheet__actions">
        <button class="btn btn--strong" type="button" data-act="play" ${record.url ? '' : 'disabled'}>
          ${ctx.iconMarkup('play')}Play
        </button>
        ${record.url
          ? `<a class="btn" data-act="download" href="${esc(api.mediaUrl(record.url))}" download="${esc(downloadName(record))}">
               ${ctx.iconMarkup('download')}Download</a>`
          : `<button class="btn" type="button" disabled title="No audio was saved for this song">${ctx.iconMarkup('download')}Download</button>`}
        <button class="btn" type="button" data-act="regenerate" ${reason ? 'disabled' : ''} title="${esc(reason)}">
          ${ctx.iconMarkup('refresh')}Make it again
        </button>
      </div>
      ${reason ? `<p class="hint hint--warn lib-sheet__blocked">${ctx.iconMarkup('info')}${esc(reason)}</p>` : ''}
      ${record.durationWarning
        ? `<p class="hint hint--warn lib-sheet__blocked">${ctx.iconMarkup('info')}${esc(record.durationWarning)}</p>`
        : ''}
      <div class="lib-sheet__job" data-role="sheet-job"></div>

      <dl class="lib-meta">
        ${metaRow('Length', fmtDuration(record.duration))}
        ${showsRequestedLength ? metaRow('Requested', fmtDuration(requestedLength)) : ''}
        ${metaRow('Format', record.format ? record.format.toUpperCase() : '—')}
        ${metaRow('Quality', fmtSampleRate(record.sampleRate))}
        ${metaRow('Seed', record.seed === null ? 'not saved' : String(record.seed), { mono: true })}
      </dl>

      <section class="lib-sheet__block">
        <h3 class="lib-sheet__label">Caption
          <button class="lib-link" type="button" data-act="copy-prompt" ${record.prompt ? '' : 'disabled'}>Copy</button>
        </h3>
        <div class="lib-sheet__text">${esc(record.prompt || 'No caption was saved with this song.')}</div>
      </section>

      <section class="lib-sheet__block">
        <h3 class="lib-sheet__label">Lyrics
          <button class="lib-link" type="button" data-act="copy-lyrics" ${record.lyrics && !record.isInstrumental ? '' : 'disabled'}>Copy</button>
        </h3>
        <div class="lib-sheet__text lib-sheet__text--mono">${esc(lyrics)}</div>
      </section>

      <footer class="lib-sheet__foot">
        <span class="lib-sheet__file truncate">${record.url
          ? `Saves as <b>${esc(downloadName(record))}</b>`
          : 'No audio file was saved for this song.'}</span>
        <button class="btn btn--sm btn--danger" type="button" data-act="delete">
          ${ctx.iconMarkup('trash')}Delete
        </button>
      </footer>`;
  }

  function paintSheetJob() {
    const holder = sheetPanel.querySelector('[data-role="sheet-job"]');
    if (!holder) return;
    const job = openSheetId ? jobs.get(openSheetId) : null;
    if (!job) { holder.innerHTML = ''; return; }
    holder.innerHTML = `<div class="lib-job lib-job--sheet" data-job="${esc(openSheetId)}">
        <span class="brandline"></span>
        <span class="lib-job__text">${ctx.iconMarkup('spinner', 'icon spinner')}
          <span data-role="job-status">${esc(job.status)}</span>
          <span class="mono lib-job__clock" data-role="job-clock">${fmtDuration((Date.now() - job.startedAt) / 1000)}</span>
        </span>
        <button class="btn btn--sm" type="button" data-act="cancel-job">Cancel</button>
      </div>`;
  }

  function openSheet(id, trigger) {
    const record = recordById(id);
    if (!record) return;
    openSheetId = id;
    sheetReturnFocus = trigger || null;
    sheetPanel.innerHTML = sheetMarkup(record);
    paintSheetJob();
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('is-open'));
    sheetPanel.querySelector('[data-act="close"]')?.focus();
  }

  function closeSheet() {
    if (sheet.hidden) return;
    openSheetId = null;
    sheet.classList.remove('is-open');
    sheet.hidden = true;
    sheetPanel.innerHTML = '';
    if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
    sheetReturnFocus = null;
  }

  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="scrim"]')) { closeSheet(); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const record = recordById(openSheetId);
    const act = btn.dataset.act;
    if (act === 'close') { closeSheet(); return; }
    if (!record) return;
    if (act === 'play') play(record);
    else if (act === 'regenerate') { regenerate(record); paintSheetJob(); }
    else if (act === 'delete') removeRecord(record.id);
    else if (act === 'copy-prompt') copy(record.prompt, 'Caption');
    else if (act === 'copy-lyrics') copy(record.lyrics, 'Lyrics');
    else if (act === 'cancel-job') jobs.get(record.id)?.controller.abort();
  });

  /* Light focus containment: Tab cycles inside the open sheet. */
  function onSheetKeydown(e) {
    if (sheet.hidden || e.key !== 'Tab') return;
    const focusables = sheetPanel.querySelectorAll(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ================================ events ============================= */

  function setQuery(value) {
    query = value;
    render();
  }

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery(searchInput.value), 110);
  });
  cleanups.push(() => clearTimeout(searchTimer));

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    setQuery('');
    searchInput.focus();
  });

  filterGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    prefs.filter = btn.dataset.filter;
    ctx.storage.set(PREFS_KEY, prefs);
    render();
  });

  sortSelect.addEventListener('change', () => {
    prefs.sort = sortSelect.value;
    ctx.storage.set(PREFS_KEY, prefs);
    render();
  });

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file) importLibrary(file);
    importInput.value = '';
  });

  body.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    if (action) {
      const kind = action.dataset.action;
      if (kind === 'go-create') ctx.navigate('create');
      else if (kind === 'go-studio') ctx.navigate('studio');
      else if (kind === 'import') importInput.click();
      else if (kind === 'reset-filters') {
        query = '';
        searchInput.value = '';
        prefs.filter = 'all';
        ctx.storage.set(PREFS_KEY, prefs);
        render();
      }
      return;
    }

    const item = e.target.closest('[data-id]');
    if (!item) return;
    const record = recordById(item.dataset.id);
    if (!record) return;

    if (e.target.closest('[data-role="more"]')) return; // the menu owns its trigger

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'download') return; // the anchor does the work
      if (act.disabled) return;
      e.preventDefault();
      if (act.getAttribute('aria-disabled') === 'true') {
        ctx.toast(act.title, { kind: 'warn', title: 'Not available for this song' });
        return;
      }
      if (act.dataset.act === 'play') play(record);
      else if (act.dataset.act === 'regenerate') regenerate(record);
      else if (act.dataset.act === 'cancel-job') jobs.get(record.id)?.controller.abort();
      return;
    }

    if (e.target.closest('[data-cover]')) { play(record); return; }
    openSheet(record.id, item);
  });

  body.addEventListener('keydown', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item || e.target !== item) return;
    if (e.key === 'Enter') { e.preventDefault(); openSheet(item.dataset.id, item); }
    else if (e.key === ' ') {
      e.preventDefault();
      const record = recordById(item.dataset.id);
      if (record) play(record);
    }
  });

  function onKeydown(e) {
    onSheetKeydown(e);
    if (e.key === 'Escape') {
      if (!sheet.hidden) { closeSheet(); return; }
      if (query) { searchInput.value = ''; setQuery(''); }
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!records.length) return;
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  }

  document.addEventListener('keydown', onKeydown);
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));

  /* --------------------------------------------------------------- bus -- */

  // The shell stores finished tracks the moment they exist (records.js);
  // this screen only re-reads the ledger when told it changed.
  ctx.bus.on('library:changed', (payload) => {
    if (payload?.source && !['shell', 'server'].includes(payload.source)) return;
    records = loadRecords(ctx.storage);
    render();
  });

  /* The worker reports a measured duration and the record separately keeps what
     was requested. Once the player decodes the file it can correct the measured
     value without losing the user's target. */
  const measured = new Set();

  ctx.bus.on('player:state', (payload) => {
    const track = payload?.track;
    const id = track?.id || (track?.url ? String(track.url).split('/').pop().replace(/\.[^.]+$/, '') : null);
    playing = { id: id || null, isPlaying: Boolean(payload?.playing) };
    paintPlaying();

    const real = Number(payload?.duration);
    if (!id || measured.has(id) || !Number.isFinite(real) || real <= 0.5) return;
    const record = recordById(id);
    if (!record) return;
    measured.add(id);
    if (Math.abs((record.duration || 0) - real) < 1.5) return;
    persist(records.map((r) => (r.id === id ? { ...r, duration: Math.round(real * 100) / 100 } : r)));
  });

  ctx.onHealth((snapshot) => {
    const before = health?.status;
    health = snapshot;
    if (before !== snapshot.status && records.length) render();
  });

  /* --------------------------------------------------------- first run -- */

  ctx.bus.emit('library:changed', { count: records.length });
  render();

  const deepLink = ctx.route?.query?.track;
  if (deepLink) {
    const target = recordById(String(deepLink));
    if (target) {
      const node = body.querySelector(`[data-id="${CSS.escape(target.id)}"]`);
      node?.scrollIntoView({ block: 'center' });
      node?.classList.add('is-flagged');
      setTimeout(() => node?.classList.remove('is-flagged'), 2400);
      openSheet(target.id, node);
    } else {
      ctx.toast('That song is not in your library on this computer.', { kind: 'warn', title: 'Not found' });
    }
  }

  /* ------------------------------------------------------------ unmount -- */

  return () => {
    for (const off of cleanups) { try { off(); } catch { /* noop */ } }
    for (const controller of rowMenus) { try { controller.destroy(); } catch { /* noop */ } }
    rowMenus = [];
    headerTools.remove();
    sheet.remove();
    // In-flight re-runs are deliberately left running; they finish into storage.
  };
}
