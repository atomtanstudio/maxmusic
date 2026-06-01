const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORAGE = {
  tracks: 'maxmusic.tracks',
  apiKey: 'maxmusic.apiKey',
  autoCoverArt: 'maxmusic.autoCoverArt',
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
  dualTakes: null,
  isGenerating: false,
  library: [],
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

function titleFromPrompt(prompt, mode) {
  if (!prompt) return mode === 'instrumental' ? 'Untitled instrumental' : 'Untitled';
  const first = prompt.split(/[,.!?\n]/)[0].trim();
  return (first.length >= 4 ? first : prompt).slice(0, 50);
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
function loadLibrary() {
  try { state.library = JSON.parse(localStorage.getItem(STORAGE.tracks) || '[]'); }
  catch { state.library = []; }
  $('#libraryCount').textContent = state.library.length;
}

function saveLibrary() {
  localStorage.setItem(STORAGE.tracks, JSON.stringify(state.library));
  $('#libraryCount').textContent = state.library.length;
}

function addToLibrary(track) {
  state.library.unshift(track);
  if (state.library.length > 200) state.library = state.library.slice(0, 200);
  saveLibrary();
}

function removeFromLibrary(id) {
  state.library = state.library.filter((t) => t.id !== id);
  saveLibrary();
  renderLibrary();
}

// --- Navigation ---
const PAGE_META = {
  create: ['Create', 'Original songs — prompt, lyrics, dual takes, streaming'],
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

// --- Preview / player ---
function setPreviewLoading(on, msg = 'Generating…') {
  $('#previewEmpty').hidden = on || state.currentTrack || state.dualTakes;
  $('#previewLoading').hidden = !on;
  $('#previewSingle').hidden = on || !state.currentTrack || state.dualTakes;
  $('#previewDual').hidden = on || !state.dualTakes;
  if (on) $('#loadingMsg').textContent = msg;
}

function playTrack(track) {
  state.currentTrack = track;
  state.dualTakes = null;
  const a = $('#audioEl');
  a.src = track.url;
  $('#previewEmpty').hidden = true;
  $('#previewDual').hidden = true;
  $('#previewSingle').hidden = false;

  $('#playerTitle').textContent = track.title;
  $('#playerSub').textContent = `${track.mode} · ${(track.prompt || '').slice(0, 60)}`;

  const cover = $('#playerCover');
  const img = $('#playerCoverImg');
  const icon = $('#playerCoverIcon');
  if (track.coverArtUrl) {
    img.src = track.coverArtUrl;
    img.hidden = false;
    icon.hidden = true;
    cover.style.background = '#000';
  } else {
    img.hidden = true;
    icon.hidden = false;
    cover.style.background = track.gradient;
  }

  $('#downloadBtn').href = track.url;
  $('#downloadBtn').download = `${track.title.replace(/[^\w.-]+/g, '-')}.${track.filename?.split('.').pop() || 'mp3'}`;

  const stats = [
    track.durationMs ? formatTime(track.durationMs / 1000) : null,
    track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : null,
    track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null,
  ].filter(Boolean).join(' · ');
  $('#playerStats').textContent = stats;

  loadWaveform(track.url);
  a.play().catch(() => {});
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
  return {
    model: $('#model').value,
    prompt: $('#prompt').value.trim(),
    lyrics: $('#lyrics').value,
    is_instrumental: state.mode === 'instrumental',
    lyrics_optimizer: state.mode === 'vocal' && $('#lyricsOptimizer').checked,
    output_format: $('#streamMode').checked ? 'hex' : $('#outputFormat').value,
    stream: $('#streamMode').checked,
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

  const payload = readCreatePayload();
  state.isGenerating = true;
  $('#createBtn').disabled = true;
  setPreviewLoading(true);

  try {
    if (payload.stream) {
      await handleStreamGenerate(payload);
    } else if ($('#dualMode').checked) {
      const result = await api('/api/generate-dual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      renderDualTakesFixed(result.takes, {
        prompt: payload.prompt,
        lyrics: payload.lyrics,
        mode: state.mode,
        model: payload.model,
      });
      toast('Dual generation complete', 'success');
    } else {
      const result = await api('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const track = trackFromResult(result, {
        title: titleFromPrompt(payload.prompt, state.mode),
        prompt: payload.prompt,
        lyrics: payload.lyrics,
        mode: state.mode,
        model: payload.model,
      });
      addToLibrary(track);
      playTrack(track);
      if ($('#autoCoverArt').checked) generateCoverArt(track);
      toast('Track ready', 'success');
    }
  } catch (e) {
    showAlert('#alertCreate', e.message);
    toast(e.message, 'error');
  } finally {
    state.isGenerating = false;
    $('#createBtn').disabled = false;
    setPreviewLoading(false);
  }
}

function renderDualTakesFixed(takes, meta) {
  state.dualTakes = takes;
  state.currentTrack = null;
  $('#previewEmpty').hidden = true;
  $('#previewSingle').hidden = true;
  $('#previewDual').hidden = false;
  const el = $('#previewDual');
  el.innerHTML = '';

  for (const slot of ['A', 'B']) {
    const data = takes[slot];
    const card = document.createElement('div');
    card.className = 'take-card';
    if (!data?.track) {
      card.innerHTML = `<div class="take-label">TAKE ${slot}</div><p class="field-hint">Failed</p>`;
      el.appendChild(card);
      continue;
    }
    const tr = trackFromResult(data, {
      ...meta,
      title: `${titleFromPrompt(meta.prompt, meta.mode)} (${slot})`,
    });
    card.innerHTML = `
      <div class="take-label">TAKE ${slot}</div>
      <div class="player-cover" style="background:${tr.gradient};margin-bottom:8px"></div>
      <div style="font-size:13px;font-weight:600">${tr.title}</div>
      <audio controls src="${tr.url}" style="width:100%;margin-top:8px"></audio>
      <button class="secondary-btn" style="margin-top:8px;width:100%">Keep take ${slot}</button>
    `;
    card.querySelector('button').addEventListener('click', () => {
      addToLibrary(tr);
      playTrack(tr);
      if ($('#autoCoverArt').checked) generateCoverArt(tr);
    });
    el.appendChild(card);
  }
}

async function handleStreamGenerate(payload) {
  setPreviewLoading(true, 'Streaming audio…');
  const res = await fetch('/api/generate-stream', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Stream failed ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.done && evt.track) {
          const track = trackFromResult(
            { track: evt.track, extra_info: evt.extra_info, trace_id: evt.trace_id },
            {
              title: titleFromPrompt(payload.prompt, state.mode),
              prompt: payload.prompt,
              lyrics: payload.lyrics,
              mode: state.mode,
              model: payload.model,
            },
          );
          addToLibrary(track);
          playTrack(track);
          if ($('#autoCoverArt').checked) generateCoverArt(track);
          toast('Stream complete', 'success');
        }
        if (evt.error) throw new Error(typeof evt.error === 'string' ? evt.error : evt.error.error);
      } catch (e) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }
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
  const prompt = $('#coverPrompt').value.trim();
  if (prompt.length < 10) {
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
    let result;
    if (state.coverFeatureId) {
      result = await api('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const fd = new FormData();
      fd.append('audio', state.referenceFile);
      for (const [k, v] of Object.entries(payload)) {
        if (v != null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      result = await api('/api/cover', { method: 'POST', body: fd });
    }
    const track = trackFromResult(result, {
      title: titleFromPrompt(prompt, 'cover'),
      prompt,
      lyrics: payload.lyrics,
      mode: 'cover',
      model: payload.model,
    });
    addToLibrary(track);
    playTrack(track);
    setView('create');
    if ($('#autoCoverArt').checked) generateCoverArt(track);
    toast('Cover ready', 'success');
  } catch (e) {
    showAlert('#alertCovers', e.message);
  } finally {
    state.isGenerating = false;
    $('#coverGenerateBtn').disabled = false;
    setPreviewLoading(false);
  }
}

// --- Lyrics page ---
async function handleLyricsGenerate() {
  showAlert('#alertLyrics', null);
  try {
    const result = await api('/api/lyrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: state.lyricsMode,
        prompt: $('#lyricsPrompt').value.trim(),
        lyrics: $('#lyricsExisting').value,
        title: $('#lyricsTitle').value.trim(),
      }),
    });
    $('#lyricsResult').hidden = false;
    $('#lyricsOutput').value = result.lyrics || '';
    $('#lyricsStyleTags').textContent = [result.song_title, result.style_tags].filter(Boolean).join(' · ');
    if (result.song_title) $('#lyricsTitle').value = result.song_title;
    toast('Lyrics ready', 'success');
  } catch (e) {
    showAlert('#alertLyrics', e.message);
  }
}

// --- Cover art ---
async function generateCoverArt(track) {
  try {
    const result = await api('/api/cover-art', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: track.title,
        musicPrompt: track.prompt,
        mode: track.mode,
        lyrics: track.lyrics,
      }),
    });
    track.coverArtUrl = result.cover.url;
    const lib = state.library.find((t) => t.id === track.id);
    if (lib) lib.coverArtUrl = track.coverArtUrl;
    saveLibrary();
    if (state.currentTrack?.id === track.id) playTrack(track);
    renderLibrary();
    toast('Cover art ready', 'success');
  } catch (e) {
    toast(e.message || 'Cover art failed', 'error');
  }
}

// --- Library UI ---
function renderLibrary() {
  loadLibrary();
  const q = $('#librarySearch').value.toLowerCase();
  const items = state.library.filter((t) =>
    !q || t.title.toLowerCase().includes(q) || (t.prompt || '').toLowerCase().includes(q),
  );
  $('#libraryEmpty').hidden = items.length > 0;
  $('#libraryGrid').innerHTML = items.map((t) => `
    <div class="library-card" data-id="${t.id}">
      <div class="card-cover" style="background:${t.coverArtUrl ? `url('${t.coverArtUrl}') center/cover` : t.gradient}"></div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(t.title)}</div>
        <div class="card-sub">${t.mode} · ${escapeHtml((t.prompt || '').slice(0, 36))}</div>
      </div>
    </div>
  `).join('');

  $$('.library-card').forEach((card) => {
    const t = state.library.find((x) => x.id === card.dataset.id);
    card.addEventListener('click', () => playTrack(t));
  });
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

// --- Player events ---
function attachPlayer() {
  const a = $('#audioEl');
  $('#playerPlay').addEventListener('click', () => (a.paused ? a.play() : a.pause()));
  $('#waveformWrap').addEventListener('click', seekFromWaveformEvent);
  window.addEventListener('resize', () => {
    if (waveform.peaks && a.duration) drawWaveform(a.currentTime / a.duration);
  });
  a.addEventListener('timeupdate', () => {
    if (!a.duration) return;
    const pct = a.currentTime / a.duration;
    drawWaveform(pct);
    $('#currentTime').textContent = formatTime(a.currentTime);
  });
  a.addEventListener('loadedmetadata', () => {
    $('#duration').textContent = formatTime(a.duration);
  });
  $('#coverArtBtn').addEventListener('click', () => state.currentTrack && generateCoverArt(state.currentTrack));
  $('#useAsRefBtn').addEventListener('click', async () => {
    if (!state.currentTrack) return;
    const res = await fetch(state.currentTrack.url);
    const blob = await res.blob();
    const file = new File([blob], `ref-${state.currentTrack.id}.mp3`, { type: blob.type });
    setCoverRef(file);
    setView('covers');
    $('#coverPrompt').value = state.currentTrack.prompt || '';
    toast('Loaded as cover reference', 'success');
  });
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

  attachPlayer();
  refreshApiStatus();
  setView('create');
}

boot();