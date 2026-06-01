import { buildRichStylePrompt, isGenericSeed, pickWandTheme, prepareMusicPrompt } from './style-suggest.js';
import { dualTrackTitles, titleFromLyrics } from './title-from-lyrics.js';
import { exportLyricVideo } from './lyric-video.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORAGE = {
  tracks: 'maxmusic.tracks',
  apiKey: 'maxmusic.apiKey',
  autoCoverArt: 'maxmusic.autoCoverArt',
  libraryView: 'maxmusic.libraryView',
};

const STYLE_CHIPS = [
  ['Cinematic', 'Cinematic orchestral, 100 BPM, D minor, epic brass, choir'],
  ['Lo-fi', 'Lo-fi hip-hop, mellow, 75 BPM, vinyl crackle, jazzy piano'],
  ['Indie Folk', 'Indie folk, acoustic, 110 BPM, fingerpicked guitar, warm vocal'],
  ['Synthwave', 'Synthwave, retro 80s, 120 BPM, analog synths, driving bass'],
  ['Jazz', 'Jazz, 95 BPM, walking bass, brush drums, saxophone'],
  ['Trap', 'Trap, 140 BPM, dark, heavy 808s, female rap vocal'],
  ['EDM', 'EDM, 128 BPM, big room, festival drop, euphoric lead'],
  ['Ballad', 'Acoustic ballad, 70 BPM, piano, emotional female vocal, strings'],
];

const LYRIC_TAGS = [
  '[Intro]', '[Verse]', '[Pre Chorus]', '[Chorus]', '[Hook]', '[Bridge]',
  '[Interlude]', '[Solo]', '[Inst]', '[Build Up]', '[Break]', '[Outro]',
];

const state = {
  view: 'create',
  mode: 'vocal',
  coverFlow: 'quick',
  lyricsMode: 'write_full_song',
  referenceFile: null,
  coverFeatureId: null,
  currentTrack: null,
  sessionItems: [],
  videoExport: null,
  suggestedSongTitle: '',
  isGenerating: false,
  library: [],
  libraryAudio: null,
  libraryPlayingId: null,
  libraryView: localStorage.getItem(STORAGE.libraryView) || 'list',
};

const waveform = {
  peaks: null,
  bars: 140,
  loading: false,
};

// --- API ---
function authHeaders() {
  const h = {};
  const key = localStorage.getItem(STORAGE.apiKey);
  if (key) h['X-Api-Key'] = key;
  return h;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

// --- Utils ---
function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveTrackTitle({ lyrics = '', prompt = '', mode = 'vocal', apiTitle = '' } = {}) {
  return titleFromLyrics(lyrics, {
    apiTitle: apiTitle || state.suggestedSongTitle || '',
    prompt,
    mode,
  });
}

function resolveDualTrackTitles({ lyrics = '', prompt = '', mode = 'vocal', apiTitle = '' } = {}) {
  return dualTrackTitles(lyrics, {
    apiTitle: apiTitle || state.suggestedSongTitle || '',
    prompt,
    mode,
  });
}

function paletteFor(seed) {
  const sets = [
    ['#3d3530', '#5a4f45'],
    ['#2a3330', '#4a5c55'],
    ['#352e28', '#564a40'],
    ['#2c2a32', '#45435a'],
  ];
  const [a, b] = sets[Math.abs(seed) % sets.length];
  return `linear-gradient(145deg, ${a}, ${b})`;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return Math.abs(h);
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

function showAlert(id, msg) {
  const a = $(id);
  if (!msg) { a.hidden = true; a.textContent = ''; return; }
  a.hidden = false;
  a.textContent = msg;
}

function parseLyricsResponse(result) {
  const data = result?.data && typeof result.data === 'object' ? result.data : result;
  return {
    lyrics: (data.lyrics || result.lyrics || '').trim(),
    song_title: data.song_title || result.song_title || '',
    style_tags: data.style_tags || result.style_tags || '',
  };
}

function applyLyricsToCreateFields({ lyrics, style_tags, song_title }, { updatePrompt = false } = {}) {
  if (lyrics) {
    $('#lyrics').value = lyrics;
    $('#lyrics').disabled = false;
    $('#lyrics').style.opacity = '1';
    $('#lyricsOptimizer').checked = false;
    $('#lyricsCount').textContent = String(lyrics.length);
  }
  if (updatePrompt && style_tags) $('#prompt').value = style_tags;
  state.suggestedSongTitle = song_title
    || titleFromLyrics(lyrics, { prompt: $('#prompt').value, mode: state.mode });
  if (song_title && state.view === 'lyrics') $('#lyricsTitle').value = song_title;
}

async function fetchLyricsFromApi({ mode, prompt, lyrics = '', title = '' }) {
  const result = await api('/api/lyrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, prompt, lyrics, title }),
  });
  return parseLyricsResponse(result);
}

async function ensureLyricsForCreate(prompt) {
  const theme = isGenericSeed(prompt) ? pickWandTheme(prompt) : (prompt?.trim() || pickWandTheme(prompt));
  const parsed = await fetchLyricsFromApi({ mode: 'write_full_song', prompt: theme });
  if (!parsed.lyrics) throw new Error('Lyrics API returned no lyrics — try again or write your own.');
  applyLyricsToCreateFields(parsed, { updatePrompt: false });
  return parsed.lyrics;
}

function hexToAudioBlob(hex, mime = 'audio/mpeg') {
  const clean = hex.replace(/\s/g, '');
  if (!clean || clean.length < 4) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  return new Blob([bytes], { type: mime });
}

function trackFromResult(result, meta) {
  const t = result.track;
  const extra = result.extra_info || {};
  return {
    id: t.id,
    filename: t.filename,
    url: t.url,
    size: t.size,
    title: meta.title,
    prompt: meta.prompt,
    lyrics: meta.lyrics || '',
    mode: meta.mode,
    model: meta.model,
    sampleRate: extra.music_sample_rate,
    bitrate: extra.bitrate,
    durationMs: extra.music_duration,
    channels: extra.music_channel,
    createdAt: Date.now(),
    gradient: paletteFor(hashStr(meta.prompt + meta.mode)),
    trace_id: result.trace_id,
  };
}

// --- Library ---
function updateLibraryCountBadge() {
  const el = $('#libraryCount');
  if (!el) return;
  const n = state.library.length;
  el.textContent = String(n);
  el.hidden = n === 0;
  const label = `${n} saved track${n === 1 ? '' : 's'}`;
  el.setAttribute('aria-label', label);
  el.title = label;
}

function loadLibrary() {
  try { state.library = JSON.parse(localStorage.getItem(STORAGE.tracks) || '[]'); }
  catch { state.library = []; }
  updateLibraryCountBadge();
}

function saveLibrary() {
  localStorage.setItem(STORAGE.tracks, JSON.stringify(state.library));
  updateLibraryCountBadge();
}

function stopLibraryPlayback() {
  $$('.library-audio').forEach((a) => {
    a.pause();
    a.currentTime = 0;
  });
  if (state.libraryAudio) {
    state.libraryAudio.pause();
    state.libraryAudio = null;
  }
  state.libraryPlayingId = null;
  syncLibraryPlayUi(null);
}

function syncLibraryPlayUi(playingId) {
  $$('.library-card').forEach((card) => {
    const playing = !!playingId && card.dataset.id === playingId;
    card.classList.toggle('is-playing', playing);
    const btn = card.querySelector('[data-act="play"]');
    if (!btn) return;
    btn.classList.toggle('is-playing', playing);
    btn.textContent = playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
}

function bindAudioTransport({ audio, playBtn, timeEl, seekEl, onBeforePlay }) {
  if (!audio) return;
  const syncTime = () => {
    if (timeEl) {
      const cur = formatTime(audio.currentTime);
      const dur = audio.duration && Number.isFinite(audio.duration) ? formatTime(audio.duration) : '—';
      timeEl.textContent = `${cur} / ${dur}`;
    }
    if (seekEl && audio.duration && Number.isFinite(audio.duration)) {
      seekEl.value = String((audio.currentTime / audio.duration) * 100);
    }
  };
  playBtn?.addEventListener('click', () => {
    if (audio.paused) {
      onBeforePlay?.();
      audio.play().catch(() => toast('Playback failed', 'error'));
    } else {
      audio.pause();
      if (audio.classList.contains('library-audio')) {
        state.libraryPlayingId = null;
        state.libraryAudio = null;
        syncLibraryPlayUi(null);
      }
    }
  });
  seekEl?.addEventListener('input', () => {
    if (!audio.duration || !Number.isFinite(audio.duration)) return;
    audio.currentTime = (parseFloat(seekEl.value) / 100) * audio.duration;
    syncTime();
  });
  audio.addEventListener('play', () => {
    playBtn?.classList.add('is-playing');
    if (playBtn) playBtn.textContent = '❚❚';
  });
  audio.addEventListener('pause', () => {
    playBtn?.classList.remove('is-playing');
    if (playBtn) playBtn.textContent = '▶';
  });
  audio.addEventListener('timeupdate', syncTime);
  audio.addEventListener('loadedmetadata', syncTime);
  audio.addEventListener('ended', () => {
    playBtn?.classList.remove('is-playing');
    if (playBtn) playBtn.textContent = '▶';
    if (seekEl) seekEl.value = '0';
    if (audio.classList.contains('library-audio')) stopLibraryPlayback();
  });
}

function toggleLibraryTrack(t, card) {
  if (!t?.url) {
    toast('No audio URL for this track', 'error');
    return;
  }
  const audio = card?.querySelector('.library-audio');
  if (state.libraryPlayingId === t.id && audio && !audio.paused) {
    audio.pause();
    stopLibraryPlayback();
    return;
  }
  $$('.take-audio').forEach((a) => a.pause());
  $$('.library-audio').forEach((a) => { if (a !== audio) a.pause(); });
  state.libraryPlayingId = null;
  state.libraryAudio = null;
  if (audio) {
    state.libraryAudio = audio;
    state.libraryPlayingId = t.id;
    audio.play().catch(() => toast('Playback failed', 'error'));
  } else {
    const fallback = new Audio(t.url);
    state.libraryAudio = fallback;
    state.libraryPlayingId = t.id;
    fallback.addEventListener('ended', stopLibraryPlayback);
    fallback.play().catch(() => toast('Playback failed', 'error'));
  }
  syncLibraryPlayUi(t.id);
}

function confirmRemoveLibraryTrack(t) {
  if (!t) return;
  if (!confirm(`Remove “${t.title}” from your library?\n\nThis only removes it from this browser — the audio file on the server is not deleted.`)) {
    return;
  }
  removeFromLibrary(t.id);
  toast('Removed from library', 'success');
}

function addToLibrary(track) {
  if (state.library.some((t) => t.id === track.id)) return false;
  state.library.unshift(track);
  if (state.library.length > 200) state.library = state.library.slice(0, 200);
  saveLibrary();
  renderLibrary();
  return true;
}

function downloadTrack(track) {
  if (!track?.url) {
    toast('No audio to download', 'error');
    return;
  }
  const ext = track.filename?.split('.').pop() || 'mp3';
  const a = document.createElement('a');
  a.href = track.url;
  a.download = `${(track.title || 'track').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-')}.${ext}`;
  a.click();
  toast('Download started', 'success');
}

function saveTrackToLibrary(track, label = 'Track') {
  if (!track) return;
  if (addToLibrary(track)) {
    const item = state.sessionItems.find((i) => i.track?.id === track.id);
    if (item) item.savedToLibrary = true;
    renderSessionList();
    toast(`${label} saved to library`, 'success');
  } else {
    toast(`${label} is already in your library`, '');
  }
}

function isTrackInLibrary(trackId) {
  return state.library.some((t) => t.id === trackId);
}

function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function addSessionItem(item) {
  const entry = {
    id: item.id || newSessionId(),
    status: item.status || 'creating',
    label: item.label || 'Untitled',
    track: item.track || null,
    error: item.error || null,
    gradient: item.gradient || dualGradient(item.label || ''),
    coverArtUrl: item.coverArtUrl || item.track?.coverArtUrl || null,
    promptSnippet: item.promptSnippet || item.track?.prompt || '',
    savedToLibrary: item.track ? isTrackInLibrary(item.track.id) : false,
  };
  state.sessionItems.unshift(entry);
  updatePreviewChrome();
  renderSessionList();
  return entry.id;
}

function updateSessionItem(id, patch) {
  const item = state.sessionItems.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  if (patch.track) {
    item.savedToLibrary = isTrackInLibrary(patch.track.id);
    item.coverArtUrl = patch.track.coverArtUrl || item.coverArtUrl;
    item.gradient = patch.track.gradient || item.gradient;
    item.promptSnippet = patch.track.prompt || item.promptSnippet;
  }
  renderSessionList();
  updatePreviewChrome();
}

function sessionItemsNeedingLibrarySave() {
  return state.sessionItems.filter(
    (i) => i.status === 'ready' && i.track && !isTrackInLibrary(i.track.id),
  );
}

async function clearSession() {
  const unsaved = sessionItemsNeedingLibrarySave();
  if (unsaved.length) {
    const n = unsaved.length;
    const saveFirst = confirm(
      `${n} track${n > 1 ? 's are' : ' is'} not in your library yet.\n\nOK = save them to the library first, then clear.\nCancel = continue without saving.`,
    );
    if (saveFirst) {
      unsaved.forEach((i) => addToLibrary(i.track));
      unsaved.forEach((i) => { i.savedToLibrary = true; });
      renderSessionList();
    }
  }
  if (!state.sessionItems.length) return;
  if (!confirm('Clear all tracks from this session?')) return;
  state.sessionItems = [];
  updatePreviewChrome();
  renderSessionList();
  toast('Session cleared', '');
}

function renderVideoExportPanel() {
  const ve = state.videoExport;
  const panels = [$('#videoExportPanel'), $('#libraryVideoExportPanel')].filter(Boolean);
  const title = ve?.active
    ? 'Generating lyric video…'
    : ve?.error
      ? 'Lyric video failed'
      : 'Lyric video ready';
  const msg = ve?.message || '';
  const pct = ve?.progress != null ? Math.round(ve.progress * 100) : 0;

  for (const panel of panels) {
    if (!ve) {
      panel.hidden = true;
      continue;
    }
    panel.hidden = false;
    panel.classList.toggle('is-done', Boolean(ve.done));
    panel.classList.toggle('is-error', Boolean(ve.error));
    const titleEl = panel.querySelector('.video-export-head strong');
    const msgEl = panel.querySelector('.video-export-msg');
    const fill = panel.querySelector('.video-export-fill');
    const bar = panel.querySelector('.video-export-bar');
    const cancel = panel.querySelector('[id$="VideoExportCancel"]');
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg;
    if (fill) fill.style.width = `${pct}%`;
    if (bar) {
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', `${pct}%`);
    }
    if (cancel) cancel.hidden = !ve.active;
  }
}

async function createLyricVideoForTrack(track, sessionId) {
  if (state.videoExport?.active) {
    toast('Lyric video in progress — see the progress bar above the list', '');
    return;
  }
  const abort = new AbortController();
  state.videoExport = {
    active: true,
    trackId: track.id,
    progress: 0,
    message: 'Starting…',
    abort,
  };
  renderVideoExportPanel();
  renderSessionList();
  renderLibrary();

  try {
    const result = await exportLyricVideo(
      track,
      (update) => {
        if (!state.videoExport?.active) return;
        state.videoExport.progress = update.progress ?? state.videoExport.progress;
        state.videoExport.message = update.message;
        renderVideoExportPanel();
        renderSessionList();
        renderLibrary();
      },
      { signal: abort.signal },
    );
    state.videoExport = {
      active: false,
      done: true,
      trackId: track.id,
      progress: 1,
      message: `Download started (${result.filename})`,
    };
    renderVideoExportPanel();
    toast(`Lyric video saved (${result.label})`, 'success');
  } catch (e) {
    const cancelled = e.message?.includes('cancel');
    state.videoExport = {
      active: false,
      error: e.message,
      trackId: track.id,
      message: cancelled ? 'Cancelled' : e.message,
    };
    renderVideoExportPanel();
    if (!cancelled) toast(e.message || 'Lyric video failed', 'error');
  } finally {
    renderSessionList();
    renderLibrary();
    setTimeout(() => {
      if (!state.videoExport?.active) {
        state.videoExport = null;
        renderVideoExportPanel();
      }
    }, 12000);
  }
}

function removeFromLibrary(id) {
  if (state.libraryPlayingId === id) stopLibraryPlayback();
  state.library = state.library.filter((t) => t.id !== id);
  saveLibrary();
  renderLibrary();
}

// --- Navigation ---
const PAGE_META = {
  create: ['Create', 'New tracks stack in the session panel — save to library when you want to keep them'],
  covers: ['Covers', 'Restyle reference audio — quick or lyrics-first workflow'],
  lyrics: ['Lyrics', 'Write or edit lyrics, then send to Create'],
  library: ['Library', 'Local history — export and import supported'],
  settings: ['Settings', 'API key and defaults'],
};

function setMobileNavOpen(open) {
  $('#sidebar').classList.toggle('open', open);
  const backdrop = $('#sidebarBackdrop');
  backdrop.hidden = !open;
  backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
  $('#menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setView(name) {
  state.view = name;
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  const [title, sub] = PAGE_META[name] || ['', ''];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('#workspace').classList.toggle('single-col', name === 'library' || name === 'settings');
  $('#previewPanel').hidden = name === 'library' || name === 'settings';
  setMobileNavOpen(false);
  if (name === 'library') renderLibrary();
  if (name === 'settings') refreshKeyStatus();
}

// --- Preview / session list ---
function updatePreviewChrome() {
  const hasSession = state.sessionItems.length > 0;
  const creating = state.sessionItems.some((i) => i.status === 'creating');
  $('#previewEmpty').hidden = hasSession || state.isGenerating || !!state.videoExport;
  $('#previewSession').hidden = !hasSession;
  $('#previewLoading').hidden = !state.isGenerating || (hasSession && !creating);
  renderVideoExportPanel();
}

function setPreviewLoading(on, msg = 'Generating…') {
  if (on && msg) $('#loadingMsg').textContent = msg;
  updatePreviewChrome();
}

function dualGradient(seed) {
  return paletteFor(hashStr(String(seed)));
}

function shouldGenerateCoverArt() {
  return $('#autoCoverArt').checked;
}

function applyCoverArtToTrack(track, coverUrl) {
  if (!coverUrl || !track) return;
  track.coverArtUrl = coverUrl;
  const lib = state.library.find((t) => t.id === track.id);
  if (lib) lib.coverArtUrl = coverUrl;
  saveLibrary();
  const item = state.sessionItems.find((i) => i.track?.id === track.id);
  if (item) {
    item.coverArtUrl = coverUrl;
    if (item.track) item.track.coverArtUrl = coverUrl;
  }
  renderSessionList();
  renderLibrary();
}

async function fetchCoverArtParallel(meta) {
  const result = await api('/api/cover-art', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: meta.title,
      musicPrompt: meta.prompt || meta.musicPrompt,
      mode: meta.mode,
      lyrics: meta.lyrics,
    }),
  });
  return result.cover?.url || null;
}

function coverArtPromise(meta) {
  if (!shouldGenerateCoverArt()) return Promise.resolve(null);
  return fetchCoverArtParallel(meta).catch(() => null);
}

// --- Waveform ---
function drawWaveform(progress = 0) {
  const canvas = $('#waveform');
  const wrap = $('#waveformWrap');
  if (!canvas || !waveform.peaks) return;

  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth || 320;
  const h = 56;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const peaks = waveform.peaks;
  const barW = w / peaks.length;
  const mid = h / 2;
  const playedBars = Math.floor(progress * peaks.length);

  for (let i = 0; i < peaks.length; i++) {
    const amp = peaks[i] * (h * 0.42);
    const x = i * barW + barW * 0.15;
    const bw = Math.max(1, barW * 0.7);
    ctx.fillStyle = i < playedBars ? 'rgba(193, 127, 89, 0.95)' : 'rgba(168, 160, 149, 0.35)';
    ctx.fillRect(x, mid - amp, bw, amp * 2);
  }

  $('#waveformPlayhead').style.left = `${progress * 100}%`;
}

async function loadWaveform(url) {
  const wrap = $('#waveformWrap');
  if (!wrap || !url) return;
  wrap.classList.add('is-loading');
  waveform.peaks = null;
  drawWaveform(0);

  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await ctx.decodeAudioData(buf.slice(0));
    const ch = audioBuf.getChannelData(0);
    const bars = waveform.bars;
    const block = Math.max(1, Math.floor(ch.length / bars));
    const peaks = [];
    for (let i = 0; i < bars; i++) {
      let max = 0;
      const start = i * block;
      for (let j = 0; j < block; j++) max = Math.max(max, Math.abs(ch[start + j] || 0));
      peaks.push(max);
    }
    const top = Math.max(...peaks, 0.001);
    waveform.peaks = peaks.map((p) => p / top);
    await ctx.close();
    drawWaveform(0);
  } catch {
    waveform.peaks = Array.from({ length: waveform.bars }, () => 0.15 + Math.random() * 0.2);
    drawWaveform(0);
  } finally {
    wrap.classList.remove('is-loading');
  }
}

function seekFromWaveformEvent(e) {
  const a = $('#audioEl');
  if (!a.duration) return;
  const wrap = $('#waveformWrap');
  const r = wrap.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  a.currentTime = x * a.duration;
  drawWaveform(x);
}

// --- Generation ---
function readCreatePayload() {
  const rawPrompt = $('#prompt').value.trim();
  return {
    model: $('#model').value,
    prompt: prepareMusicPrompt(rawPrompt),
    lyrics: $('#lyrics').value,
    is_instrumental: state.mode === 'instrumental',
    lyrics_optimizer: state.mode === 'vocal' && $('#lyricsOptimizer').checked,
    output_format: $('#outputFormat').value,
    stream: false,
    audio_setting: {
      sample_rate: parseInt($('#sampleRate').value, 10),
      bitrate: parseInt($('#bitrate').value, 10),
      format: $('#audioFormat').value,
    },
    more_variation: $('#moreVariation').checked,
  };
}

function validateCreate() {
  const p = readCreatePayload();
  if (state.mode === 'instrumental' && !p.prompt) return 'Instrumental needs a style prompt.';
  if (state.mode === 'vocal' && !p.lyrics_optimizer && !p.lyrics.trim()) {
    return 'Add lyrics or enable auto-lyrics.';
  }
  return null;
}

async function handleCreate() {
  if (state.isGenerating) return;
  const err = validateCreate();
  showAlert('#alertCreate', err);
  if (err) return;

  let payload = readCreatePayload();
  const useDual = $('#dualMode').checked;
  const needsAutoLyrics = state.mode === 'vocal' && payload.lyrics_optimizer;
  state.isGenerating = true;
  state.suggestedSongTitle = '';
  $('#createBtn').disabled = true;
  showAlert('#alertCreate', null);
  if (!useDual) setPreviewLoading(true, needsAutoLyrics ? 'Writing lyrics…' : 'Generating…');

  try {
    if (needsAutoLyrics) {
      await ensureLyricsForCreate(payload.prompt);
      payload = readCreatePayload();
      payload.lyrics_optimizer = false;
      if (!payload.lyrics.trim()) {
        throw new Error('Lyrics were not applied — try again.');
      }
      if (!useDual) setPreviewLoading(true, 'Generating music…');
    }
    if (useDual) {
      setPreviewLoading(true, 'Generating…');
      await handleDualGenerateProgressive(payload);
    } else {
      const title = resolveTrackTitle({
        lyrics: payload.lyrics,
        prompt: payload.prompt,
        mode: state.mode,
      });
      const sessionId = addSessionItem({
        status: 'creating',
        label: title,
        promptSnippet: payload.prompt,
        gradient: dualGradient(payload.prompt || title),
      });
      const coverMeta = {
        title,
        prompt: payload.prompt,
        mode: state.mode,
        lyrics: payload.lyrics,
      };
      const [result, coverUrl] = await Promise.all([
        api('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        coverArtPromise(coverMeta),
      ]);
      const track = trackFromResult(result, {
        title,
        prompt: payload.prompt,
        lyrics: payload.lyrics,
        mode: state.mode,
        model: payload.model,
      });
      if (coverUrl) applyCoverArtToTrack(track, coverUrl);
      updateSessionItem(sessionId, { status: 'ready', track });
      toast('Track ready', 'success');
    }
  } catch (e) {
    showAlert('#alertCreate', e.message);
    toast(e.message, 'error');
  } finally {
    state.isGenerating = false;
    $('#createBtn').disabled = false;
    setPreviewLoading(false);
    updatePreviewChrome();
  }
}

function renderSessionCardInner(item) {
  const status = item.status || 'creating';
  const statusLabel = status === 'creating' ? 'Creating…'
    : status === 'ready' ? 'Ready'
      : status === 'failed' ? 'Failed' : status;
  const statusClass = status === 'ready' ? 'take-status--ready'
    : status === 'failed' ? 'take-status--failed' : 'take-status--creating';

  const artClass = `take-art${status === 'creating' ? ' is-generating' : ''}`;
  const artStyle = item.coverArtUrl
    ? `background-image:url('${item.coverArtUrl}');background-size:cover;background-position:center`
    : `background:${item.gradient || dualGradient(item.label)}`;

  const promptSnippet = escapeHtml((item.promptSnippet || item.track?.prompt || '').slice(0, 120));
  const title = status === 'ready' && item.track
    ? escapeHtml(item.track.title)
    : escapeHtml(item.label);

  const inLib = item.savedToLibrary || (item.track && isTrackInLibrary(item.track.id));
  const savedBadge = inLib ? '<span class="take-saved-badge">In library</span>' : '';

  const ve = state.videoExport;
  const videoOnCard = item.track && ve && (ve.active || ve.done || ve.error) && ve.trackId === item.track.id;
  let videoBlock = '';
  if (videoOnCard) {
    const pct = ve.progress != null ? Math.round(ve.progress * 100) : 0;
    videoBlock = `
      <div class="take-video-progress">
        <p class="video-export-msg">${escapeHtml(ve.message || '')}</p>
        <div class="video-export-bar"><span class="video-export-fill" style="width:${pct}%"></span></div>
      </div>
    `;
  }

  let mainBody = '';
  if (status === 'creating') {
    mainBody = `<p class="take-sub">Composing — cover art may generate in parallel</p>`;
  } else if (status === 'ready' && item.track) {
    const videoBusy = ve?.active && ve.trackId === item.track.id;
    mainBody = `
      <div class="take-mini-player">
        <button type="button" class="take-mini-play" data-act="play" aria-label="Play">▶</button>
        <div class="take-mini-transport">
          <span class="take-mini-time" data-time>0:00 / —</span>
          <input type="range" class="take-seek" min="0" max="100" value="0" step="0.1" aria-label="Seek through track">
        </div>
      </div>
      <audio class="take-audio" preload="metadata" src="${item.track.url}"></audio>
      ${videoBlock}
      <div class="take-actions">
        <button type="button" class="secondary-btn" data-act="save-lib">Save to library</button>
        <button type="button" class="secondary-btn" data-act="download">Download song</button>
        <button type="button" class="secondary-btn" data-act="lyric-video" ${videoBusy ? 'disabled' : ''}>Generate and download lyric video</button>
      </div>
    `;
  } else if (status === 'failed') {
    mainBody = `<p class="take-error">${escapeHtml(item.error || 'Generation failed')}</p>`;
  }

  return `
    <div class="${artClass}" style="${artStyle}" aria-hidden="true"></div>
    <div class="take-main">
      <div class="take-card-head">
        <p class="take-title">${title}</p>
        <span class="take-status ${statusClass}">${statusLabel}</span>
        ${savedBadge}
      </div>
      ${promptSnippet ? `<p class="take-prompt">${promptSnippet}</p>` : ''}
      ${mainBody}
    </div>
  `;
}

function bindSessionCard(card, item) {
  const audio = card.querySelector('.take-audio');
  const playBtn = card.querySelector('[data-act="play"]');
  const timeEl = card.querySelector('[data-time]');
  const seekEl = card.querySelector('.take-seek');

  if (audio && item.track) {
    bindAudioTransport({
      audio,
      playBtn,
      timeEl,
      seekEl,
      onBeforePlay: () => {
        $$('.take-audio').forEach((a) => { if (a !== audio) a.pause(); });
        stopLibraryPlayback();
      },
    });
  }

  card.querySelector('[data-act="save-lib"]')?.addEventListener('click', () => {
    if (!item.track) return;
    saveTrackToLibrary(item.track, item.track.title);
  });
  card.querySelector('[data-act="download"]')?.addEventListener('click', () => {
    if (!item.track) return;
    downloadTrack(item.track);
  });
  card.querySelector('[data-act="lyric-video"]')?.addEventListener('click', () => {
    if (!item.track) return;
    createLyricVideoForTrack(item.track, item.id);
  });
}

function renderSessionList() {
  const el = $('#sessionList');
  if (!el) return;
  el.innerHTML = '';
  for (const item of state.sessionItems) {
    const card = document.createElement('div');
    card.className = 'take-card suno-row';
    card.dataset.sessionId = item.id;
    if (item.status === 'ready') card.classList.add('is-ready');
    if (item.status === 'failed') card.classList.add('is-failed');
    if (item.savedToLibrary || (item.track && isTrackInLibrary(item.track.id))) {
      card.classList.add('in-library');
    }
    card.innerHTML = renderSessionCardInner(item);
    bindSessionCard(card, item);
    el.appendChild(card);
  }
}

async function handleDualGenerateProgressive(payload) {
  const meta = {
    prompt: payload.prompt,
    lyrics: payload.lyrics,
    mode: state.mode,
    model: payload.model,
  };

  const { titleA, titleB } = resolveDualTrackTitles({
    lyrics: meta.lyrics,
    prompt: meta.prompt,
    mode: meta.mode,
  });
  const idA = addSessionItem({
    status: 'creating',
    label: titleA,
    promptSnippet: meta.prompt,
    gradient: dualGradient(meta.prompt + 'A'),
  });
  const idB = addSessionItem({
    status: 'creating',
    label: titleB,
    promptSnippet: meta.prompt,
    gradient: dualGradient(meta.prompt + 'B'),
  });
  $('#previewLoading').hidden = true;

  const variationB = payload.more_variation ? ', alternate arrangement, variation B' : '';

  const runSlot = async (slot, variationSuffix, sessionId, title) => {
    const body = { ...payload, stream: false, variation_suffix: variationSuffix };
    const coverMeta = { title, prompt: meta.prompt, mode: meta.mode, lyrics: meta.lyrics };

    try {
      const [result, coverUrl] = await Promise.all([
        api('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        coverArtPromise(coverMeta),
      ]);
      const track = trackFromResult(result, {
        ...meta,
        title,
      });
      if (coverUrl) applyCoverArtToTrack(track, coverUrl);
      updateSessionItem(sessionId, { status: 'ready', track });
      toast(`${slot === 'A' ? 'Version A' : 'Version B'} is ready`, 'success');
      return true;
    } catch (e) {
      const msg = e.data?.error || e.data?.details || e.message || 'Failed';
      updateSessionItem(sessionId, { status: 'failed', error: msg });
      return false;
    }
  };

  const results = await Promise.all([
    runSlot('A', '', idA, titleA),
    runSlot('B', variationB, idB, titleB),
  ]);

  const n = results.filter(Boolean).length;
  if (n === 0) throw new Error('Both versions failed — check your prompt or API balance.');
  if (n === 1) toast('One version is ready; the other failed', '');
  else toast('Both versions ready', 'success');
}

// --- Covers ---
function setCoverRef(file) {
  state.referenceFile = file;
  $('#coverDropInner').hidden = true;
  $('#coverDropLoaded').hidden = false;
  $('#coverLoadedName').textContent = file.name;
  $('#coverLoadedMeta').textContent = formatBytes(file.size);
}

function clearCoverRef() {
  state.referenceFile = null;
  state.coverFeatureId = null;
  $('#coverRefAudio').value = '';
  $('#coverDropInner').hidden = false;
  $('#coverDropLoaded').hidden = true;
}

async function handlePreprocess() {
  if (!state.referenceFile) {
    showAlert('#alertCovers', 'Upload reference audio first.');
    return;
  }
  showAlert('#alertCovers', null);
  const fd = new FormData();
  fd.append('audio', state.referenceFile);
  try {
    const result = await api('/api/cover-preprocess', { method: 'POST', body: fd });
    state.coverFeatureId = result.cover_feature_id;
    $('#coverLyrics').value = result.formatted_lyrics || '';
    $('#coverLyricsField').hidden = false;
    toast('Lyrics extracted — edit then generate', 'success');
  } catch (e) {
    showAlert('#alertCovers', e.message);
  }
}

async function handleCoverGenerate() {
  const rawPrompt = $('#coverPrompt').value.trim();
  const prompt = prepareMusicPrompt(rawPrompt).slice(0, 300);
  if (rawPrompt.length < 10) {
    showAlert('#alertCovers', 'Style prompt must be 10–300 characters.');
    return;
  }
  if (!state.referenceFile && !state.coverFeatureId) {
    showAlert('#alertCovers', 'Upload reference audio or preprocess first.');
    return;
  }

  const payload = {
    model: $('#coverModel').value,
    prompt,
    lyrics: $('#coverLyrics').value,
    cover_feature_id: state.coverFeatureId || undefined,
    output_format: 'hex',
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
  };

  state.isGenerating = true;
  $('#coverGenerateBtn').disabled = true;
  setPreviewLoading(true);

  try {
    const title = resolveTrackTitle({ lyrics: payload.lyrics, prompt, mode: 'cover' });
    const sessionId = addSessionItem({
      status: 'creating',
      label: title,
      promptSnippet: prompt,
      gradient: dualGradient(prompt),
    });
    $('#previewLoading').hidden = true;
    setView('create');
    const coverMeta = { title, prompt, mode: 'cover', lyrics: payload.lyrics };
    let result;
    let coverUrl = null;
    if (state.coverFeatureId) {
      [result, coverUrl] = await Promise.all([
        api('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        coverArtPromise(coverMeta),
      ]);
    } else {
      const fd = new FormData();
      fd.append('audio', state.referenceFile);
      for (const [k, v] of Object.entries(payload)) {
        if (v != null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      const coverP = coverArtPromise(coverMeta);
      result = await api('/api/cover', { method: 'POST', body: fd });
      const coverUrl = await coverP;
      const track = trackFromResult(result, {
        title,
        prompt,
        lyrics: payload.lyrics,
        mode: 'cover',
        model: payload.model,
      });
      if (coverUrl) applyCoverArtToTrack(track, coverUrl);
      updateSessionItem(sessionId, { status: 'ready', track });
      toast('Cover ready', 'success');
      return;
    }
    const track = trackFromResult(result, {
      title,
      prompt,
      lyrics: payload.lyrics,
      mode: 'cover',
      model: payload.model,
    });
    if (coverUrl) applyCoverArtToTrack(track, coverUrl);
    updateSessionItem(sessionId, { status: 'ready', track });
    toast('Cover ready', 'success');
  } catch (e) {
    showAlert('#alertCovers', e.message);
  } finally {
    state.isGenerating = false;
    $('#coverGenerateBtn').disabled = false;
    setPreviewLoading(false);
    updatePreviewChrome();
  }
}

// --- Lyrics page ---
async function handleLyricsGenerate() {
  showAlert('#alertLyrics', null);
  const btn = $('#lyricsGenerateBtn');
  btn.disabled = true;
  try {
    const parsed = await fetchLyricsFromApi({
      mode: state.lyricsMode,
      prompt: $('#lyricsPrompt').value.trim(),
      lyrics: $('#lyricsExisting').value,
      title: $('#lyricsTitle').value.trim(),
    });
    $('#lyricsResult').hidden = false;
    $('#lyricsOutput').value = parsed.lyrics;
    $('#lyricsStyleTags').textContent = [parsed.song_title, parsed.style_tags].filter(Boolean).join(' · ');
    const derivedTitle = parsed.song_title
      || titleFromLyrics(parsed.lyrics, { prompt: $('#lyricsPrompt').value.trim() });
    if (derivedTitle) {
      $('#lyricsTitle').value = derivedTitle;
      state.suggestedSongTitle = derivedTitle;
    }
    $('#lyricsOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(parsed.lyrics ? 'Lyrics ready' : 'No lyrics returned', parsed.lyrics ? 'success' : 'error');
  } catch (e) {
    showAlert('#alertLyrics', e.message);
  } finally {
    btn.disabled = false;
  }
}

async function handlePromptWand() {
  const btn = $('#promptWandBtn');
  const seed = $('#prompt').value.trim();
  const usedPlaceholder = isGenericSeed(seed);
  const themeForApi = usedPlaceholder ? pickWandTheme(seed) : seed;
  btn.disabled = true;
  try {
    let apiTags = '';
    try {
      const parsed = await fetchLyricsFromApi({ mode: 'write_full_song', prompt: themeForApi });
      apiTags = parsed.style_tags || '';
    } catch {
      /* local vocabulary still works */
    }
    $('#prompt').value = buildRichStylePrompt(seed, apiTags);
    toast(
      usedPlaceholder
        ? 'Style tags from a sample theme — edit the prompt or add your own vibe first'
        : 'Detailed style tags applied',
      'success',
    );
  } catch (e) {
    toast(e.message || 'Style suggestion failed', 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Cover art ---
async function generateCoverArt(track) {
  try {
    const url = await fetchCoverArtParallel({
      title: track.title,
      prompt: track.prompt,
      mode: track.mode,
      lyrics: track.lyrics,
    });
    if (!url) throw new Error('No cover image returned');
    applyCoverArtToTrack(track, url);
    toast('Cover art ready', 'success');
  } catch (e) {
    toast(e.message || 'Cover art failed', 'error');
  }
}

function libraryCardVideoBlock(trackId) {
  const ve = state.videoExport;
  if (!ve || ve.trackId !== trackId) return '';
  const pct = ve.progress != null ? Math.round(ve.progress * 100) : 0;
  return `
    <div class="library-video-progress">
      <p>${escapeHtml(ve.message || '')}</p>
      <div class="video-export-bar"><span class="video-export-fill" style="width:${pct}%"></span></div>
    </div>
  `;
}

function libraryMiniPlayerHtml(t) {
  const playing = state.libraryPlayingId === t.id;
  return `
    <div class="take-mini-player library-mini-player">
      <button type="button" class="take-mini-play library-play${playing ? ' is-playing' : ''}" data-act="play" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? '❚❚' : '▶'}</button>
      <div class="take-mini-transport">
        <span class="take-mini-time" data-time>0:00 / —</span>
        <input type="range" class="take-seek" min="0" max="100" value="0" step="0.1" aria-label="Seek through track">
      </div>
    </div>
    <audio class="library-audio" preload="metadata" src="${escapeHtml(t.url || '')}"></audio>
  `;
}

function libraryActionsHtml(t, videoBusy) {
  return `
    <div class="library-actions">
      <button type="button" class="secondary-btn" data-act="download">Download song</button>
      <button type="button" class="secondary-btn" data-act="lyric-video" ${videoBusy ? 'disabled' : ''}>Generate and download lyric video</button>
    </div>
  `;
}

function libraryListCardHtml(t, videoBusy) {
  const art = t.coverArtUrl ? `url('${escapeHtml(t.coverArtUrl)}') center/cover` : (t.gradient || 'var(--bg-3)');
  return `
    <div class="library-card library-card--list${state.libraryPlayingId === t.id ? ' is-playing' : ''}" data-id="${t.id}">
      <button type="button" class="library-remove" data-act="remove" aria-label="Remove from library">×</button>
      <div class="library-art" style="background:${art}"></div>
      <div class="library-main">
        <div class="library-head">
          <p class="card-title">${escapeHtml(t.title)}</p>
        </div>
        <p class="card-sub">${escapeHtml(t.mode || 'track')} · ${escapeHtml((t.prompt || '').slice(0, 48))}</p>
        ${libraryMiniPlayerHtml(t)}
        ${libraryCardVideoBlock(t.id)}
        ${libraryActionsHtml(t, videoBusy)}
      </div>
    </div>
  `;
}

function libraryTileCardHtml(t, videoBusy) {
  const art = t.coverArtUrl ? `url('${escapeHtml(t.coverArtUrl)}') center/cover` : (t.gradient || 'var(--bg-3)');
  const playing = state.libraryPlayingId === t.id;
  return `
    <div class="library-card library-card--tile${playing ? ' is-playing' : ''}" data-id="${t.id}">
      <button type="button" class="library-remove" data-act="remove" aria-label="Remove from library">×</button>
      <div class="library-tile-cover" style="background:${art}">
        <button type="button" class="take-mini-play library-play library-play--tile${playing ? ' is-playing' : ''}" data-act="play" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? '❚❚' : '▶'}</button>
      </div>
      <div class="library-tile-body">
        <p class="card-title">${escapeHtml(t.title)}</p>
        <p class="card-sub">${escapeHtml(t.mode || 'track')}</p>
        <div class="take-mini-transport library-tile-seek">
          <span class="take-mini-time" data-time>0:00 / —</span>
          <input type="range" class="take-seek" min="0" max="100" value="0" step="0.1" aria-label="Seek through track">
        </div>
        <audio class="library-audio" preload="metadata" src="${escapeHtml(t.url || '')}"></audio>
        ${libraryCardVideoBlock(t.id)}
        ${libraryActionsHtml(t, videoBusy)}
      </div>
    </div>
  `;
}

function bindLibraryCard(card, t) {
  const audio = card.querySelector('.library-audio');
  const playBtn = card.querySelector('[data-act="play"]');
  const timeEl = card.querySelector('[data-time]');
  const seekEl = card.querySelector('.take-seek');

  if (audio) {
    bindAudioTransport({
      audio,
      playBtn,
      timeEl,
      seekEl,
      onBeforePlay: () => {
        $$('.take-audio').forEach((a) => a.pause());
        $$('.library-audio').forEach((a) => { if (a !== audio) a.pause(); });
        state.libraryAudio = audio;
        state.libraryPlayingId = t.id;
        syncLibraryPlayUi(t.id);
      },
    });
  }

  playBtn?.addEventListener('click', (e) => e.stopPropagation());

  card.querySelector('[data-act="download"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadTrack(t);
  });
  card.querySelector('[data-act="lyric-video"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    createLyricVideoForTrack(t, null);
  });
  card.querySelector('[data-act="remove"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmRemoveLibraryTrack(t);
  });
}

function setLibraryView(mode) {
  state.libraryView = mode === 'tiles' ? 'tiles' : 'list';
  localStorage.setItem(STORAGE.libraryView, state.libraryView);
  const grid = $('#libraryGrid');
  if (grid) {
    grid.classList.toggle('library-grid--list', state.libraryView === 'list');
    grid.classList.toggle('library-grid--tiles', state.libraryView === 'tiles');
  }
  $('#libraryViewList')?.classList.toggle('active', state.libraryView === 'list');
  $('#libraryViewTiles')?.classList.toggle('active', state.libraryView === 'tiles');
  $('#libraryViewList')?.setAttribute('aria-pressed', state.libraryView === 'list' ? 'true' : 'false');
  $('#libraryViewTiles')?.setAttribute('aria-pressed', state.libraryView === 'tiles' ? 'true' : 'false');
  renderLibrary();
}

// --- Library UI ---
function renderLibrary() {
  loadLibrary();
  const q = ($('#librarySearch')?.value || '').toLowerCase();
  const items = state.library.filter((t) =>
    !q || t.title.toLowerCase().includes(q) || (t.prompt || '').toLowerCase().includes(q),
  );
  $('#libraryEmpty').hidden = items.length > 0;
  const ve = state.videoExport;
  const videoBusy = (id) => ve?.active && ve.trackId === id;
  const grid = $('#libraryGrid');
  if (grid) {
    grid.classList.toggle('library-grid--list', state.libraryView === 'list');
    grid.classList.toggle('library-grid--tiles', state.libraryView === 'tiles');
  }

  const html = state.libraryView === 'tiles'
    ? items.map((t) => libraryTileCardHtml(t, videoBusy(t.id))).join('')
    : items.map((t) => libraryListCardHtml(t, videoBusy(t.id))).join('');

  $('#libraryGrid').innerHTML = html;

  $$('.library-card').forEach((card) => {
    const t = state.library.find((x) => x.id === card.dataset.id);
    if (t) bindLibraryCard(card, t);
  });
  renderVideoExportPanel();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Settings ---
async function refreshApiStatus() {
  const pill = $('#apiStatus');
  const text = pill.querySelector('.api-status-text');
  try {
    const h = await api('/api/health');
    const userKey = localStorage.getItem(STORAGE.apiKey);
    if (h.hasServerKey || userKey) {
      pill.className = 'api-pill ready';
      text.textContent = h.hasServerKey ? 'server + ready' : 'key ready';
    } else {
      pill.className = 'api-pill error';
      text.textContent = 'no key';
    }
    $('#serverKeyStatus').textContent = h.hasServerKey
      ? 'MINIMAX_API_KEY is set on the server.'
      : 'No server env key — use Settings below.';
  } catch {
    pill.className = 'api-pill error';
    text.textContent = 'offline';
  }
}

function refreshKeyStatus() {
  const key = localStorage.getItem(STORAGE.apiKey);
  $('#userKeyStatus').textContent = key ? 'Key saved in this browser.' : 'No key saved.';
  if (key) $('#userApiKey').value = key;
}

// --- Session panel controls ---
function attachSessionControls() {
  $('#clearSessionBtn')?.addEventListener('click', clearSession);
  const cancelVideoExport = () => {
    if (state.videoExport?.abort) {
      state.videoExport.abort.abort();
    }
    state.videoExport = {
      active: false,
      error: 'cancelled',
      message: 'Cancelled',
      progress: 0,
    };
    renderVideoExportPanel();
    renderSessionList();
    renderLibrary();
    toast('Lyric video cancelled', '');
  };
  $('#videoExportCancel')?.addEventListener('click', cancelVideoExport);
  $('#libraryVideoExportCancel')?.addEventListener('click', cancelVideoExport);
}

// --- Init UI ---
function initChips() {
  const row = $('#styleChips');
  STYLE_CHIPS.forEach(([label, prompt]) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.addEventListener('click', () => { $('#prompt').value = prompt; });
    row.appendChild(b);
  });

  const toolbar = $('#lyricsToolbar');
  LYRIC_TAGS.forEach((tag) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-btn';
    b.textContent = tag.replace(/[\[\]]/g, '');
    b.addEventListener('click', () => insertTag($('#lyrics'), tag));
    toolbar.appendChild(b);
  });
}

function insertTag(textarea, tag) {
  const start = textarea.selectionStart;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(textarea.selectionEnd);
  const insert = (before.endsWith('\n') || !before ? '' : '\n') + tag + '\n';
  textarea.value = before + insert + after;
  textarea.focus();
  $('#lyricsCount').textContent = textarea.value.length;
}

function boot() {
  loadLibrary();
  initChips();

  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#menuBtn').addEventListener('click', () => {
    setMobileNavOpen(!$('#sidebar').classList.contains('open'));
  });
  $('#sidebarBackdrop').addEventListener('click', () => setMobileNavOpen(false));

  $$('.mode-tab').forEach((t) => t.addEventListener('click', () => {
    $$('.mode-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.mode = t.dataset.mode;
    $('#lyricsField').hidden = state.mode === 'instrumental';
  }));

  $$('[data-cover-flow]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-cover-flow]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.coverFlow = b.dataset.coverFlow;
    $('#coverAdvancedBlock').hidden = state.coverFlow !== 'advanced';
  }));

  $$('[data-lyrics-mode]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-lyrics-mode]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.lyricsMode = b.dataset.lyricsMode;
    $('#lyricsEditField').hidden = state.lyricsMode !== 'edit';
  }));

  $('#lyrics').addEventListener('input', () => {
    $('#lyricsCount').textContent = $('#lyrics').value.length;
  });
  $('#lyricsOptimizer').addEventListener('change', (e) => {
    $('#lyrics').disabled = e.target.checked;
    $('#lyrics').style.opacity = e.target.checked ? '0.45' : '1';
  });

  $('#promptWandBtn').addEventListener('click', handlePromptWand);

  $('#createBtn').addEventListener('click', handleCreate);
  $('#coverGenerateBtn').addEventListener('click', handleCoverGenerate);
  $('#preprocessBtn').addEventListener('click', handlePreprocess);
  $('#lyricsGenerateBtn').addEventListener('click', handleLyricsGenerate);

  $('#sendToCreate').addEventListener('click', () => {
    $('#prompt').value = $('#lyricsStyleTags').textContent || $('#lyricsPrompt').value;
    $('#lyrics').value = $('#lyricsOutput').value;
    setView('create');
  });

  const dz = $('#coverDropzone');
  const input = $('#coverRefAudio');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const f = e.dataTransfer.files?.[0];
    if (f) setCoverRef(f);
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) setCoverRef(f);
  });
  $('#clearCoverRef').addEventListener('click', (e) => { e.stopPropagation(); clearCoverRef(); });

  $('#saveKey').addEventListener('click', () => {
    const v = $('#userApiKey').value.trim();
    if (!v) return toast('Paste a key', 'error');
    localStorage.setItem(STORAGE.apiKey, v);
    refreshKeyStatus();
    refreshApiStatus();
    toast('Key saved', 'success');
  });
  $('#clearKey').addEventListener('click', () => {
    localStorage.removeItem(STORAGE.apiKey);
    refreshKeyStatus();
    refreshApiStatus();
  });

  const auto = localStorage.getItem(STORAGE.autoCoverArt);
  $('#autoCoverArt').checked = auto !== 'false';
  $('#autoCoverArt').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.autoCoverArt, e.target.checked ? 'true' : 'false');
  });

  $('#librarySearch').addEventListener('input', renderLibrary);
  $('#libraryViewList')?.addEventListener('click', () => setLibraryView('list'));
  $('#libraryViewTiles')?.addEventListener('click', () => setLibraryView('tiles'));
  setLibraryView(state.libraryView);
  $('#clearLibrary').addEventListener('click', () => {
    if (!confirm('Clear library metadata? Audio files on server remain.')) return;
    state.library = [];
    saveLibrary();
    renderLibrary();
  });
  $('#exportLibrary').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.library, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `maxmusic-library-${Date.now()}.json`;
    a.click();
  });
  $('#importLibrary').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error('Invalid library file');
      state.library = [...data, ...state.library].slice(0, 200);
      saveLibrary();
      renderLibrary();
      toast('Library imported', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    e.target.value = '';
  });

  attachSessionControls();
  updatePreviewChrome();
  refreshApiStatus();
  setView('create');
}

boot();