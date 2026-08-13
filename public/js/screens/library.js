/**
 * MaxMusic — Library.
 *
 * Every take this browser has generated. There is no list endpoint on the
 * backend (see SPEC §4), so the index lives in localStorage under
 * `maxmusic:library.tracks` and the audio itself stays on the backend at
 * `/tracks/…`. The screen is honest about that everywhere it matters.
 *
 * Wired to real things:
 *   bus `track:new`          → a record is stored and `library:changed` is emitted
 *   bus `player:play`        → play / queue (the shell answers when no player exists)
 *   `<a download>`           → the real file the backend rendered
 *   `api.generateStream()`   → re-run a take with its own seed
 *   localStorage             → delete (with undo), import, export, clear
 *
 * Owned by the library lane: this file + public/css/screens/library.css.
 *
 * @module screens/library
 */

export const meta = {
  title: 'Library',
  subtitle: 'Every take this browser has generated',
  css: '/css/screens/library.css',
};

/* ========================================================================== *
 * Storage
 * ========================================================================== */

const STORE_KEY = 'library.tracks';
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

/** Human total for the stats line, e.g. `1 hr 4 min`. */
function fmtTotalTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const mins = Math.round(sec / 60);
  if (mins < 1) return `${Math.round(sec)} sec`;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short relative stamp for a row: `4 min ago`, `Yesterday`, `12 Aug`. */
function fmtWhen(ts) {
  if (!Number.isFinite(ts)) return '—';
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

/* The SPEC §3c section labels. Useful in the full caption, noise in a one-line row. */
const CAPTION_LABELS = /(Basic Attributes|Global Emotional Progression|Application Scenarios & Imagery|Sonics & Production Profile|Vocal Gender & Timbre|Vocal Style|Harmony\/Backing Vocals|Vocal FX|Instrument Lifecycle Description[^:]*|Groove & Foundation Progression|Embellishments, Textures & Spatial FX|Primary|Secondary)\s*:\s*/g;

/** One-line caption excerpt: the caption itself, minus its structural labels. */
function excerpt(record) {
  const text = String(record.prompt || '').replace(CAPTION_LABELS, '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  if (record.isInstrumental) return 'Instrumental take — no caption was recorded.';
  return 'No caption was recorded for this take.';
}

/* ========================================================================== *
 * Deterministic cover art
 *
 * No backend cover is attached to most takes, and inventing a remote image is
 * both a lie and a network request. Instead every take gets a plate drawn from
 * its own seed, using the brand ramp read straight off tokens.css — so the art
 * is reproducible, offline, and never hard-codes a colour.
 * ========================================================================== */

/** @type {?{ramp: string[], base: string}} */
let palette = null;

function readPalette() {
  if (palette) return palette;
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  palette = {
    ramp: [
      pick('--brand-cyan', '#0bf3fd'),
      pick('--brand-blue', '#1b7bf7'),
      pick('--brand-violet', '#7b22e6'),
      pick('--brand-magenta', '#e927d9'),
      pick('--brand-red', '#f32f55'),
      pick('--brand-amber', '#fbbf3f'),
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

let artUid = 0;

/**
 * Build the SVG plate for a record. Deterministic in the record's seed/id.
 * @param {Object} record
 * @param {number} [forceMotif] Only the empty state uses this, to show all three.
 * @returns {string} SVG markup, safe to inject (all values are numbers/hex).
 */
function coverSvg(record, forceMotif) {
  const { ramp, base } = readPalette();
  const key = `${record.seed ?? ''}|${record.id ?? ''}|${record.title ?? ''}`;
  const h = hash32(key);
  const rnd = rngFrom(h);
  const uid = `a${(artUid += 1).toString(36)}${(h % 4096).toString(36)}`;

  /* Three stops two apart on the ramp: always a vivid slice, never muddy. The
     variety between plates comes from the motif and its geometry, not the hue. */
  const i0 = h % 6;
  const c1 = ramp[i0];
  const c2 = ramp[(i0 + 2) % 6];
  const c3 = ramp[(i0 + 4) % 6];
  const plate = mix(base, c2, 0.11);
  const n = (v) => v.toFixed(2);

  const angle = (h >>> 6) % 4;
  const [x1, y1, x2, y2] = [
    ['0', '0', '1', '1'], ['0', '1', '1', '0'], ['0', '0', '1', '0'], ['0', '0', '0', '1'],
  ][angle];

  const defs = [
    `<linearGradient id="${uid}l" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
    + `<stop offset="0" stop-color="${c1}"/><stop offset=".52" stop-color="${c2}"/>`
    + `<stop offset="1" stop-color="${c3}"/></linearGradient>`,
    `<radialGradient id="${uid}v" cx=".5" cy=".42" r=".8">`
    + `<stop offset=".5" stop-color="${base}" stop-opacity="0"/>`
    + `<stop offset="1" stop-color="${base}" stop-opacity=".6"/></radialGradient>`,
  ];

  let body = '';
  const motif = Number.isInteger(forceMotif) ? forceMotif : h % 4;

  if (motif === 0) {
    /* spectrum — a symmetric waveform read across the plate */
    const bars = 19;
    const step = 100 / bars;
    let rects = '';
    for (let i = 0; i < bars; i += 1) {
      const t = (i + 0.5) / bars;
      const envelope = Math.sin(Math.PI * t) ** 0.5;
      const hh = Math.max(6, (18 + 74 * envelope) * (0.5 + 0.5 * rnd()));
      const w = step * 0.52;
      rects += `<rect x="${n(i * step + step * 0.24)}" y="${n((100 - hh) / 2)}"`
        + ` width="${n(w)}" height="${n(hh)}" rx="${n(w / 2)}"/>`;
    }
    defs.push(`<radialGradient id="${uid}g" cx=".5" cy=".5" r=".55">`
      + `<stop offset="0" stop-color="${c2}" stop-opacity=".55"/>`
      + `<stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient>`);
    body = `<rect width="100" height="100" fill="url(#${uid}g)"/>`
      + `<g fill="url(#${uid}l)">${rects}</g>`;
  } else if (motif === 1) {
    /* orbit — a record cut by concentric rings */
    const cx = 24 + rnd() * 52;
    const cy = 24 + rnd() * 52;
    const gap = 5.5 + rnd() * 6;
    const count = 4 + Math.floor(rnd() * 6);
    let rings = '';
    for (let i = 0; i < count; i += 1) {
      const r = 6 + i * gap + rnd() * 3;
      const sw = 0.8 + rnd() * 3.4;
      rings += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"`
        + ` stroke-width="${n(sw)}" opacity="${n(0.45 + 0.5 * rnd())}"/>`;
    }
    defs.push(`<radialGradient id="${uid}d" cx=".5" cy=".5" r=".5">`
      + `<stop offset="0" stop-color="${c1}" stop-opacity=".7"/>`
      + `<stop offset="1" stop-color="${c3}" stop-opacity=".1"/></radialGradient>`);
    const disc = 6 + count * gap;
    const cut = rnd();
    body = `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(disc)}" fill="url(#${uid}d)"/>`
      + `<g fill="none" stroke="url(#${uid}l)">${rings}</g>`
      + `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(2.6 + rnd() * 2.6)}" fill="${c2}"/>`
      + (cut < 0.45
        ? `<rect x="-10" y="${n(58 + rnd() * 26)}" width="120" height="${n(6 + rnd() * 22)}" fill="${plate}" opacity=".88"/>`
        : '');
  } else if (motif === 2) {
    /* horizon — a sun over banded ground */
    const hy = 54 + rnd() * 18;
    const sx = 28 + rnd() * 44;
    const sr = 15 + rnd() * 9;
    defs.push(`<linearGradient id="${uid}s" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${c1}" stop-opacity=".1"/>`
      + `<stop offset="1" stop-color="${c2}" stop-opacity=".55"/></linearGradient>`);
    defs.push(`<linearGradient id="${uid}u" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
    let lines = '';
    for (let i = 0; i < 6; i += 1) {
      const y = hy + 2 + i * i * 1.5 + i * 2;
      if (y > 99) break;
      lines += `<rect x="0" y="${n(y)}" width="100" height="${n(0.7 + i * 0.25)}"`
        + ` fill="${c1}" opacity="${n(0.5 - i * 0.07)}"/>`;
    }
    body = `<rect width="100" height="${n(hy)}" fill="url(#${uid}s)"/>`
      + `<circle cx="${n(sx)}" cy="${n(hy - sr * 0.35)}" r="${n(sr)}" fill="url(#${uid}u)" opacity=".95"/>`
      + `<rect x="0" y="${n(hy)}" width="100" height="${n(100 - hy)}" fill="${plate}"/>`
      + `<rect x="0" y="${n(hy - 0.5)}" width="100" height="1" fill="${c1}" opacity=".75"/>${lines}`;
  } else {
    /* prism — hard bands with a knocked-out disc */
    const rot = (rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 48);
    const cols = [c1, c2, c3, c2, c1, c3, c1];
    const count = 3 + Math.floor(rnd() * 4);
    let bands = '';
    let x = -34;
    for (let i = 0; i < count; i += 1) {
      const w = 6 + rnd() * (i === 0 ? 34 : 24);
      bands += `<rect x="${n(x)}" y="-46" width="${n(w)}" height="192" fill="${cols[i]}"`
        + ` opacity="${n(0.6 + 0.35 * rnd())}"/>`;
      x += w + 2 + rnd() * 16;
    }
    const disc = rnd();
    body = `<g transform="rotate(${n(rot)} 50 50)">${bands}</g>`
      + (disc < 0.72
        ? `<circle cx="${n(22 + rnd() * 56)}" cy="${n(20 + rnd() * 56)}" r="${n(9 + rnd() * 15)}" fill="${plate}" opacity=".92"/>`
        : `<rect x="0" y="${n(62 + rnd() * 20)}" width="100" height="40" fill="${plate}" opacity=".9"/>`);
  }

  return `<svg class="cover__art" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">`
    + `<defs>${defs.join('')}</defs>`
    + `<rect width="100" height="100" fill="${plate}"/>${body}`
    + `<rect width="100" height="100" fill="url(#${uid}v)"/></svg>`;
}

/** The same plate as a data: URI, so the player can show identical art offline. */
function coverDataUri(record) {
  const svg = coverSvg(record).replace(' class="cover__art"', ' xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ========================================================================== *
 * Records
 * ========================================================================== */

function titleFromPrompt(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const m = text.match(/([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,3})/);
  const words = (m ? m[1] : text).split(' ').slice(0, 4).join(' ');
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

/** Duration in seconds. `extra_info.music_duration` is milliseconds. */
function durationOf(meta, extra) {
  const ms = Number(extra?.music_duration);
  if (Number.isFinite(ms) && ms > 0) return ms > 400 ? ms / 1000 : ms;
  const d = Number(meta?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * Turn anything a producing lane emits on `track:new` into a stored record.
 * Tolerant on purpose: `{track, meta}`, a bare GenerationResult, or a record.
 */
function toRecord(payload) {
  const p = payload || {};
  const track = (p.track && typeof p.track === 'object') ? p.track : p;
  const m = (p.meta && typeof p.meta === 'object') ? p.meta : p;
  const extra = m.extra_info || p.extra_info || track.extra_info || {};
  const url = String(track.url || m.url || '');
  const filename = String(track.filename || url.split('/').pop() || '');
  const id = String(track.id || m.id || filename.replace(/\.[^.]+$/, '') || `t${Date.now().toString(36)}`);
  const prompt = String(m.prompt ?? '');
  const audio = m.audio_setting || {};
  const format = String(m.format || audio.format || (filename.split('.').pop() || '')).toLowerCase();

  return {
    id,
    url,
    filename,
    size: Number(track.size ?? m.size) || 0,
    title: String(m.title || '').trim() || titleFromPrompt(prompt) || 'Untitled take',
    prompt,
    lyrics: String(m.lyrics ?? ''),
    isInstrumental: Boolean(m.isInstrumental ?? m.is_instrumental),
    duration: durationOf(m, extra),
    seed: Number.isFinite(Number(m.seed)) && m.seed !== null && m.seed !== '' ? Number(m.seed) : null,
    format: format && format !== 'undefined' ? format : '',
    sampleRate: Number(m.sampleRate ?? m.sample_rate ?? audio.sample_rate ?? extra.music_sample_rate) || null,
    bitrate: Number(m.bitrate ?? audio.bitrate ?? extra.bitrate) || null,
    model: String(m.model || '') || null,
    cover: String(m.cover || m.coverUrl || '') || null,
    createdAt: Number(m.createdAt) || Date.now(),
    source: String(m.source || '') || null,
    parentId: String(m.parentId || '') || null,
    backend: String(extra.backend || '') || null,
  };
}

function coerce(raw) {
  const r = toRecord(raw);
  // A stored record already has the right shape; keep its own createdAt.
  r.createdAt = Number(raw?.createdAt) || r.createdAt;
  return r;
}

function loadRecords(storage) {
  const raw = storage.get(STORE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => r && typeof r === 'object' && (r.url || r.id)).map(coerce);
}

function saveRecords(storage, list) {
  return storage.set(STORE_KEY, list);
}

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
  let health = ctx.health;
  let playing = { id: null, isPlaying: false };
  /** @type {?HTMLElement} */
  let sheetReturnFocus = null;
  let openSheetId = null;

  const cleanups = [];

  /* ------------------------------------------------------------- store -- */

  function persist(next, { silent = false } = {}) {
    records = next;
    const ok = saveRecords(ctx.storage, records);
    if (!ok) {
      ctx.toast('This browser refused to save the library (storage is full or blocked). The list on screen is correct until you reload.', {
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
    ctx.toast(`Removed “${record.title}”. The rendered file itself stays on the backend at ${record.url || 'its original path'}.`, {
      kind: 'info',
      title: 'Removed from library',
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
      record.model, record.format, record.seed === null ? '' : String(record.seed),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
  }

  function compute() {
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
                 placeholder="Search titles, captions, lyrics, seeds…" autocomplete="off"
                 aria-label="Search the library">
          <button class="iconbtn lib__search-clear" type="button" data-role="search-clear"
                  aria-label="Clear search" hidden>${ctx.iconMarkup('close')}</button>
        </div>
        <div class="segment lib__filter" role="tablist" aria-label="Filter by type" data-role="filter">
          ${FILTERS.map((f) => `<button class="segment__item" type="button" role="tab" data-filter="${f.value}">${esc(f.label)}</button>`).join('')}
        </div>
        <label class="lib__sort">
          <span class="visually-hidden">Sort</span>
          <select class="select" data-role="sort">
            ${SORTS.map((s) => `<option value="${s.value}">${esc(s.label)}</option>`).join('')}
          </select>
        </label>
        <div class="lib__menu" data-role="menu">
          <button class="iconbtn" type="button" data-role="menu-toggle" aria-haspopup="menu"
                  aria-expanded="false" aria-label="Library options" title="Library options">
            ${ctx.iconMarkup('more')}
          </button>
          <div class="lib__pop" role="menu" data-role="menu-pop" hidden>
            <button class="lib__pop-item" type="button" role="menuitem" data-action="export">
              ${ctx.iconMarkup('download')}<span>Export library as JSON</span>
            </button>
            <button class="lib__pop-item" type="button" role="menuitem" data-action="import">
              ${ctx.iconMarkup('plus')}<span>Import a library file</span>
            </button>
            <div class="lib__pop-sep" role="separator"></div>
            <button class="lib__pop-item lib__pop-item--danger" type="button" role="menuitem" data-action="clear">
              ${ctx.iconMarkup('trash')}<span>Clear this library</span>
            </button>
          </div>
        </div>
      </div>
      <p class="lib__stats" data-role="stats"></p>
      <div class="lib__body" data-role="body"></div>
    </div>
    <input type="file" accept="application/json,.json" data-role="import-input" hidden>`;

  root.append(page);

  const bar = page.querySelector('[data-role="bar"]');
  const searchInput = page.querySelector('[data-role="search"]');
  const searchClear = page.querySelector('[data-role="search-clear"]');
  const filterGroup = page.querySelector('[data-role="filter"]');
  const sortSelect = page.querySelector('[data-role="sort"]');
  const menuWrap = page.querySelector('[data-role="menu"]');
  const menuToggle = page.querySelector('[data-role="menu-toggle"]');
  const menuPop = page.querySelector('[data-role="menu-pop"]');
  const statsLine = page.querySelector('[data-role="stats"]');
  const body = page.querySelector('[data-role="body"]');
  const importInput = page.querySelector('[data-role="import-input"]');

  sortSelect.value = prefs.sort;

  /* ------------------------------------------------------- header slot -- */

  const headerTools = document.createElement('div');
  headerTools.className = 'lib-headtools';
  headerTools.innerHTML = `
    <div class="segment lib-view" role="group" aria-label="Layout">
      <button class="segment__item" type="button" data-view="list" title="List view">
        ${ctx.iconMarkup('menu')}<span class="lib-view__label">List</span>
      </button>
      <button class="segment__item" type="button" data-view="grid" title="Grid view">
        ${ctx.iconMarkup('covers')}<span class="lib-view__label">Grid</span>
      </button>
    </div>
    <button class="btn" type="button" data-action="new">${ctx.iconMarkup('plus')}New song</button>`;
  ctx.headerSlot.append(headerTools);

  headerTools.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) {
      prefs.view = view.dataset.view;
      ctx.storage.set(PREFS_KEY, prefs);
      render();
      return;
    }
    if (e.target.closest('[data-action="new"]')) ctx.navigate('create');
  });

  /* ============================== rendering ============================= */

  function paintChrome() {
    const empty = records.length === 0;
    headerTools.hidden = empty;
    bar.hidden = empty;
    statsLine.hidden = empty;
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
  }

  function paintStats() {
    if (!records.length) return;
    const totalSec = visible.reduce((n, r) => n + (Number.isFinite(r.duration) ? r.duration : 0), 0);
    const totalBytes = visible.reduce((n, r) => n + (r.size || 0), 0);
    const parts = [`${visible.length} ${visible.length === 1 ? 'take' : 'takes'}`];
    const time = fmtTotalTime(totalSec);
    if (time) parts.push(time);
    if (totalBytes) parts.push(fmtBytes(totalBytes));
    const filtered = visible.length !== records.length;
    statsLine.textContent = filtered
      ? `${parts.join(' · ')} — filtered from ${records.length}`
      : parts.join(' · ');
  }

  /** Cover block shared by both views. */
  function coverMarkup(record, { badge = true } = {}) {
    const art = record.cover
      ? `<img class="cover__img" src="${esc(api.mediaUrl(record.cover))}" alt="" loading="lazy">`
      : coverSvg(record);
    const time = badge && Number.isFinite(record.duration)
      ? `<span class="cover__time mono">${fmtDuration(record.duration)}</span>` : '';
    return `<span class="cover" data-cover>
        ${art}
        <span class="cover__eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span class="cover__play">${ctx.iconMarkup('play')}</span>
        ${time}
      </span>`;
  }

  function badgesMarkup(record) {
    const out = [];
    if (record.isInstrumental) out.push('<span class="badge lib-badge">Instrumental</span>');
    if (record.format) out.push(`<span class="badge lib-badge">${esc(record.format)}</span>`);
    if (record.seed !== null) out.push(`<span class="badge lib-badge lib-badge--seed mono" title="Seed ${record.seed}">seed ${esc(record.seed)}</span>`);
    if (record.parentId) out.push('<span class="badge lib-badge">Re-run</span>');
    return out.join('');
  }

  /* Blocked actions stay clickable and carry `aria-disabled` + the reason: a
     natively disabled button swallows hover, so its tooltip never appears and
     the user is never told why. Clicking one toasts the reason instead. */
  function actionsMarkup(record) {
    const reason = regenerateBlockReason(record);
    const noFile = 'No audio path was recorded for this take, so there is nothing to play or download.';
    const canPlay = Boolean(record.url);
    return `
      <div class="lib-actions">
        <button class="iconbtn lib-act" type="button" data-act="play"
                ${canPlay ? '' : 'aria-disabled="true"'}
                title="${canPlay ? 'Play' : esc(noFile)}" aria-label="Play">${ctx.iconMarkup('play')}</button>
        ${canPlay
          ? `<a class="iconbtn lib-act" data-act="download" href="${esc(api.mediaUrl(record.url))}"
                download="${esc(record.filename || `${record.title}.${record.format || 'audio'}`)}"
                title="Download ${esc(record.filename)}" aria-label="Download">${ctx.iconMarkup('download')}</a>`
          : `<button class="iconbtn lib-act" type="button" data-act="blocked" aria-disabled="true"
                title="${esc(noFile)}" aria-label="Download">${ctx.iconMarkup('download')}</button>`}
        <button class="iconbtn lib-act" type="button" data-act="regenerate" ${reason ? 'aria-disabled="true"' : ''}
                title="${esc(reason || `Run this caption again with seed ${record.seed}`)}"
                aria-label="Re-run with the same seed">${ctx.iconMarkup('refresh')}</button>
        <button class="iconbtn lib-act lib-act--danger" type="button" data-act="delete"
                title="Remove from this browser's library" aria-label="Remove">${ctx.iconMarkup('trash')}</button>
      </div>`;
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
        <p class="lib-row__excerpt">${esc(excerpt(record))}</p>
        ${actionsMarkup(record)}
      </div>
      <div class="lib-row__meta">
        <span class="lib-row__when">${esc(fmtWhen(record.createdAt))}</span>
        <span class="lib-row__size mono">${record.size ? esc(fmtBytes(record.size)) : ''}</span>
      </div>
      ${jobMarkup(record)}
    </li>`;
  }

  function cardMarkup(record) {
    return `<li class="lib-card" data-id="${esc(record.id)}" tabindex="0">
      ${coverMarkup(record)}
      <div class="lib-card__body">
        <p class="lib-card__title truncate">${esc(record.title)}</p>
        <p class="lib-card__meta">
          <span>${esc(fmtWhen(record.createdAt))}</span>
          <span class="lib-card__dot">·</span>
          <span class="mono">${record.seed === null ? 'no seed' : `seed ${esc(record.seed)}`}</span>
        </p>
      </div>
      ${actionsMarkup(record)}
      ${jobMarkup(record)}
    </li>`;
  }

  function emptyLibraryMarkup() {
    const plates = [2, 0, 1]
      .map((motif, i) => `<span class="lib-empty__plate lib-empty__plate--${i + 1}">`
        + `${coverSvg({ id: `maxmusic-plate-${i}`, seed: 11 + i * 37, title: 'MaxMusic' }, motif)}</span>`)
      .join('');
    return `<div class="lib-empty">
      <div class="lib-empty__art" aria-hidden="true">${plates}</div>
      <h2 class="lib-empty__title">Nothing here yet</h2>
      <p class="lib-empty__lead">
        Every take you render lands here — with the caption it was built from, its
        seed, and the original file. Nothing is uploaded anywhere: the list lives in
        this browser and the audio stays on your backend.
      </p>
      <div class="lib-empty__cta">
        <button class="btn btn--primary btn--lg" type="button" data-action="go-create">
          ${ctx.iconMarkup('wand')}Write a song
        </button>
        <button class="btn btn--lg" type="button" data-action="go-studio">
          ${ctx.iconMarkup('studio')}Open Studio
        </button>
      </div>
      <ul class="lib-empty__facts">
        <li><span class="lib-empty__fact-icon">${ctx.iconMarkup('dice')}</span>
          <b>Reproducible</b><span>Each take keeps its seed and caption, so one click runs the exact same song again.</span></li>
        <li><span class="lib-empty__fact-icon">${ctx.iconMarkup('download')}</span>
          <b>Yours to keep</b><span>Download the file the backend rendered — FLAC, WAV or MP3, untouched.</span></li>
        <li><span class="lib-empty__fact-icon">${ctx.iconMarkup('lock')}</span>
          <b>Local index</b><span>The backend has no library endpoint, so MaxMusic remembers your takes in this browser only.</span></li>
      </ul>
      <p class="lib-empty__note">
        Moving machines, or clearing site data? <button class="lib-link" type="button" data-action="import">Import a library file</button>
        you exported earlier — the audio paths stay valid as long as the backend still has the files.
      </p>
    </div>`;
  }

  function emptyResultsMarkup() {
    return `<div class="empty lib-noresults">
      <span class="empty__icon">${ctx.iconMarkup('search')}</span>
      <h2 class="empty__title">No takes match</h2>
      <p class="empty__text">
        Nothing in ${records.length} ${records.length === 1 ? 'take' : 'takes'} matches
        ${query ? `“${esc(query)}”` : 'this filter'}${prefs.filter !== 'all' ? ` in ${prefs.filter} takes` : ''}.
      </p>
      <button class="btn" type="button" data-action="reset-filters">Reset search and filters</button>
    </div>`;
  }

  function render() {
    compute();
    paintChrome();
    paintStats();

    if (!records.length) {
      body.innerHTML = emptyLibraryMarkup();
      return;
    }
    if (!visible.length) {
      body.innerHTML = emptyResultsMarkup();
      return;
    }

    const grid = prefs.view === 'grid';
    body.innerHTML = `<ul class="${grid ? 'lib-grid' : 'lib-list'}" role="list">`
      + visible.map(grid ? cardMarkup : rowMarkup).join('')
      + '</ul>';
    paintPlaying();
    paintJobs();
  }

  /* ------------------------------------------------- live row painting -- */

  function paintPlaying() {
    for (const node of body.querySelectorAll('[data-id]')) {
      const isCurrent = node.dataset.id === playing.id;
      node.classList.toggle('is-current', isCurrent);
      node.classList.toggle('is-playing', isCurrent && playing.isPlaying);
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
        seed: record.seed,
        format: record.format,
        isInstrumental: record.isInstrumental,
        createdAt: record.createdAt,
      },
    };
  }

  function play(record) {
    if (!record?.url) {
      ctx.toast('This entry has no audio path recorded, so there is nothing to play.', { kind: 'warn', title: 'Cannot play' });
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
    if (Number.isFinite(record.duration)) input.duration = record.duration;
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
    if (jobs.has(record.id)) return 'This take is already running.';
    if (record.seed === null) return 'No seed was recorded for this take, so it cannot be reproduced exactly.';
    const check = api.validateGeneration(regenerateInput(record));
    if (!check.valid) return check.errors.join(' ');
    if (health && health.status !== 'online') return health.message;
    return '';
  }

  async function regenerate(record) {
    const reason = regenerateBlockReason(record);
    if (reason) { ctx.toast(reason, { kind: 'warn', title: 'Cannot re-run' }); return; }

    const controller = new AbortController();
    const job = { id: record.id, status: 'Sending to the backend…', startedAt: Date.now(), controller, title: record.title };
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
          if (event?.status === 'queued') bump(`Queued on ${event.backend || 'the generator'}…`);
          else if (event?.partial) bump('Streaming a partial take…');
          else if (event?.done) bump('Writing the file…');
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

      (shell?.toast || ctx.toast)(`“${fresh.title}” finished with seed ${record.seed}.`, {
        kind: 'success',
        title: 'Re-run complete',
        action: { label: 'Play', onClick: () => ctx.bus.emit('player:play', playPayload(fresh)) },
      });
    } catch (err) {
      jobs.delete(record.id);
      hooks.jobs?.();
      if (err?.name === 'AbortError') {
        (shell?.toast || ctx.toast)(`Re-run of “${record.title}” cancelled.`, { kind: 'info', timeout: 3000 });
        return;
      }
      (shell?.toast || ctx.toast)(api.errorText(err), { kind: 'error', title: 'Re-run failed' });
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
    ctx.toast(`Exported ${records.length} ${records.length === 1 ? 'take' : 'takes'}.`, { kind: 'success', timeout: 3000 });
  }

  async function importLibrary(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed?.tracks;
      if (!Array.isArray(list)) throw new Error('That file has no "tracks" array.');
      const incoming = list.filter((r) => r && typeof r === 'object' && (r.url || r.id)).map(coerce);
      if (!incoming.length) throw new Error('That file contained no usable takes.');
      const added = addRecords(incoming);
      const skipped = incoming.length - added;
      ctx.toast(added
        ? `Imported ${added} ${added === 1 ? 'take' : 'takes'}.${skipped ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} already here.` : ''}`
        : `All ${incoming.length} ${incoming.length === 1 ? 'take' : 'takes'} in that file are already in the library.`,
      { kind: added ? 'success' : 'info', title: 'Import' });
    } catch (err) {
      ctx.toast(`Could not read that file: ${err?.message || err}`, { kind: 'error', title: 'Import failed' });
    }
  }

  function clearLibrary() {
    if (!records.length) return;
    const backup = records.slice();
    persist([]);
    closeSheet();
    ctx.toast(`Cleared ${backup.length} ${backup.length === 1 ? 'take' : 'takes'} from this browser. The files stay on the backend.`, {
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
    <aside class="lib-sheet__panel" role="dialog" aria-modal="true" aria-label="Take details" data-role="panel"></aside>`;
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
    const lyrics = record.isInstrumental
      ? 'Instrumental take — MiniMax Music 3 ignores lyrics when the instrumental flag is set.'
      : (record.lyrics || 'No lyrics were recorded with this take.');
    return `
      <header class="lib-sheet__head">
        <span class="lib-sheet__cover">${record.cover
          ? `<img class="cover__img" src="${esc(api.mediaUrl(record.cover))}" alt="">`
          : coverSvg(record)}</span>
        <div class="lib-sheet__id">
          <h2 class="lib-sheet__title">${esc(record.title)}</h2>
          <p class="lib-sheet__badges">${badgesMarkup(record) || '<span class="badge lib-badge">Take</span>'}</p>
          <p class="lib-sheet__when">${esc(fmtStamp(record.createdAt))}${record.backend ? ` · ${esc(record.backend)}` : ''}</p>
        </div>
        <button class="iconbtn lib-sheet__close" type="button" data-act="close" aria-label="Close details">
          ${ctx.iconMarkup('close')}
        </button>
      </header>

      <div class="lib-sheet__actions">
        <button class="btn btn--primary" type="button" data-act="play" ${record.url ? '' : 'disabled'}>
          ${ctx.iconMarkup('play')}Play
        </button>
        ${record.url
          ? `<a class="btn" data-act="download" href="${esc(api.mediaUrl(record.url))}" download="${esc(record.filename)}">
               ${ctx.iconMarkup('download')}Download</a>`
          : `<button class="btn" type="button" disabled title="No file path recorded">${ctx.iconMarkup('download')}Download</button>`}
        <button class="btn" type="button" data-act="regenerate" ${reason ? 'disabled' : ''} title="${esc(reason)}">
          ${ctx.iconMarkup('refresh')}Re-run seed
        </button>
        <button class="btn btn--danger btn--icon" type="button" data-act="delete" aria-label="Remove from library"
                title="Remove from this browser's library">${ctx.iconMarkup('trash')}</button>
      </div>
      ${reason ? `<p class="hint hint--warn lib-sheet__blocked">${ctx.iconMarkup('info')}${esc(reason)}</p>` : ''}
      <div class="lib-sheet__job" data-role="sheet-job"></div>

      <dl class="lib-meta">
        ${metaRow('Duration', fmtDuration(record.duration))}
        ${metaRow('Seed', record.seed === null ? 'not recorded' : String(record.seed), { mono: true })}
        ${metaRow('Format', record.format ? record.format.toUpperCase() : '—')}
        ${metaRow('Sample rate', record.sampleRate ? `${record.sampleRate} Hz` : '—', { mono: true })}
        ${metaRow('Size', fmtBytes(record.size))}
        ${metaRow('Model', record.model || 'backend default')}
      </dl>

      <section class="lib-sheet__block">
        <h3 class="lib-sheet__label">Caption
          <button class="lib-link" type="button" data-act="copy-prompt" ${record.prompt ? '' : 'disabled'}>Copy</button>
        </h3>
        <div class="lib-sheet__text">${esc(record.prompt || 'No caption was recorded for this take.')}</div>
      </section>

      <section class="lib-sheet__block">
        <h3 class="lib-sheet__label">Lyrics
          <button class="lib-link" type="button" data-act="copy-lyrics" ${record.lyrics && !record.isInstrumental ? '' : 'disabled'}>Copy</button>
        </h3>
        <div class="lib-sheet__text lib-sheet__text--mono">${esc(lyrics)}</div>
      </section>

      <footer class="lib-sheet__foot">
        <span class="lib-sheet__path mono truncate" title="${esc(record.url)}">${esc(record.url || 'no path recorded')}</span>
        ${record.url ? `<a class="lib-link" href="${esc(api.mediaUrl(record.url))}" target="_blank" rel="noopener">Open file${ctx.iconMarkup('external')}</a>` : ''}
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

  function setMenu(open) {
    menuPop.hidden = !open;
    menuToggle.setAttribute('aria-expanded', String(open));
    menuWrap.classList.toggle('is-open', open);
  }

  menuToggle.addEventListener('click', () => setMenu(menuPop.hidden));
  menuPop.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    setMenu(false);
    const action = item.dataset.action;
    if (action === 'export') exportLibrary();
    else if (action === 'import') importInput.click();
    else if (action === 'clear') clearLibrary();
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

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'download') return; // the anchor does the work
      if (act.disabled) return;
      e.preventDefault();
      if (act.getAttribute('aria-disabled') === 'true') {
        ctx.toast(act.title, { kind: 'warn', title: 'Not available for this take' });
        return;
      }
      if (act.dataset.act === 'play') play(record);
      else if (act.dataset.act === 'regenerate') regenerate(record);
      else if (act.dataset.act === 'delete') removeRecord(record.id);
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

  function onDocClick(e) {
    if (!menuPop.hidden && !menuWrap.contains(e.target)) setMenu(false);
  }

  function onKeydown(e) {
    onSheetKeydown(e);
    if (e.key === 'Escape') {
      if (!sheet.hidden) { closeSheet(); return; }
      if (!menuPop.hidden) { setMenu(false); return; }
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

  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
  cleanups.push(() => document.removeEventListener('click', onDocClick));
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));

  /* --------------------------------------------------------------- bus -- */

  ctx.bus.on('track:new', (payload) => {
    try {
      const record = toRecord(payload);
      if (!record.url && !record.id) return;
      addRecords(record);
    } catch (err) {
      console.error('[library] could not store a new track', err);
      ctx.toast(`A finished track could not be added to the library: ${err?.message || err}`, {
        kind: 'error', title: 'Library',
      });
    }
  });

  /* Durations we stored are what the take was *asked* for. Once the player has
     decoded the file it knows the real length — take it, once per track. */
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
      ctx.toast(`No take with id ${deepLink} is in this browser's library.`, { kind: 'warn', title: 'Not found' });
    }
  }

  /* ------------------------------------------------------------ unmount -- */

  return () => {
    for (const off of cleanups) { try { off(); } catch { /* noop */ } }
    headerTools.remove();
    sheet.remove();
    // In-flight re-runs are deliberately left running; they finish into storage.
  };
}
