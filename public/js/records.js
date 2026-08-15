/**
 * The library ledger — every record the product keeps about a song, and
 * nothing about how any screen paints it.
 *
 * This lives outside the screens because the moment a song finishes is not
 * a moment any particular screen is guaranteed to be mounted. The shell
 * wires `track:new` to `storeTrack` at boot, so a song created anywhere
 * lands in the library even if the Library screen has never been opened.
 *
 * @module records
 */

const STORE_KEY = 'library.tracks';

export function titleFromPrompt(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const m = text.match(/([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,3})/);
  const words = (m ? m[1] : text).split(' ').slice(0, 4).join(' ');
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

/** Duration in seconds. `extra_info.music_duration` is milliseconds. */
export function durationOf(meta, extra) {
  const ms = Number(extra?.music_duration);
  if (Number.isFinite(ms) && ms > 0) return ms > 400 ? ms / 1000 : ms;
  const d = Number(meta?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * Turn anything a producing lane emits on `track:new` into a stored record.
 * Tolerant on purpose: `{track, meta}`, a bare GenerationResult, or a record.
 */
export function toRecord(payload) {
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
    title: String(m.title || '').trim() || titleFromPrompt(prompt) || 'Untitled song',
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
    videos: Array.isArray(m.videos) ? m.videos.filter((v) => v && v.url && v.mode) : [],
    createdAt: Number(m.createdAt) || Date.now(),
    source: String(m.source || '') || null,
    parentId: String(m.parentId || '') || null,
  };
}

export function coerce(raw) {
  const r = toRecord(raw);
  // A stored record already has the right shape; keep its own createdAt.
  r.createdAt = Number(raw?.createdAt) || r.createdAt;
  return r;
}

export function loadRecords(storage) {
  const raw = storage.get(STORE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => r && typeof r === 'object' && (r.url || r.id)).map(coerce);
}

export function saveRecords(storage, list) {
  return storage.set(STORE_KEY, list);
}

/**
 * Store one finished track. Dedupes by id (a re-emit updates in place) and
 * keeps newest first. Returns the stored record and the ledger size, which
 * the shell's nav counter wants.
 */
export function storeTrack(storage, payload) {
  const record = toRecord(payload);
  if (!record.url && !record.id) return null;
  const list = loadRecords(storage);
  const existing = list.findIndex((r) => r.id === record.id);
  if (existing >= 0) list.splice(existing, 1);
  list.unshift(record);
  saveRecords(storage, list);
  return { record, count: list.length };
}

/**
 * Patch one stored record — the shell uses this to attach freshly made
 * cover art to its song. Returns the updated record, or null.
 */
export function updateRecord(storage, id, patch) {
  const list = loadRecords(storage);
  const i = list.findIndex((r) => r.id === String(id));
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  saveRecords(storage, list);
  return list[i];
}
