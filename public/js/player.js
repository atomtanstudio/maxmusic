/**
 * MaxMusic — the persistent player bar.
 *
 * Owns `#player-root` (`.playerbar`) and `public/css/player.css`. Mounted once by
 * the shell and never unmounted, so it outlives every screen. One `<audio>`
 * element, one queue, one waveform.
 *
 * ---------------------------------------------------------------------------
 * IMPERATIVE API — the object the shell stores as `ctx.player`
 * ---------------------------------------------------------------------------
 * Every method is safe to call at any time; a call that cannot be honoured
 * returns `false`/`null` rather than throwing.
 *
 *   player.load(input, opts?)      Load a track. Does not play unless asked.
 *                                  `input` may be:
 *                                    • a url string                 '/tracks/ab.flac'
 *                                    • a backend Track              {id, filename, url, size}
 *                                    • a GenerationResult           {ok, track, extra_info}
 *                                    • a bus payload                {track, title, cover, meta, queue}
 *                                  `opts = { play?: boolean, queue?: Track[] }`
 *                                  → the normalised track, or null.
 *   player.play()                  Resume/start. Returns a Promise<boolean>.
 *   player.pause()                 Pause. Returns boolean.
 *   player.toggle()                Play ⇄ pause.
 *   player.next() / player.prev()  Move through the queue. `prev()` restarts the
 *                                  current track when past 3s, like every player.
 *   player.seek(seconds)           Absolute seek in seconds.
 *   player.seekFraction(0..1)      Absolute seek as a fraction of duration.
 *   player.setVolume(0..1)         Also un-mutes. Persisted in ctx.storage.
 *   player.toggleMute(force?)      Mute/unmute.
 *   player.queue(tracks, opts?)    Append (or `{replace:true}`) and optionally
 *                                  `{play:true}`. Returns the new queue length.
 *   player.clearQueue()            Drops everything except the loaded track.
 *   player.getQueue()              Copy of the queue.
 *   player.getState()              {playing, loading, track, time, duration,
 *                                   volume, muted, repeat, index, queueLength, job}
 *   player.job(info)               Show the live "generating" strip. See below.
 *   player.destroy()               Tear everything down (the shell never calls it).
 *
 * ---------------------------------------------------------------------------
 * IN-PROGRESS GENERATION
 * ---------------------------------------------------------------------------
 * A screen that starts a generation can put the player into its live state:
 *
 *   const job = ctx.player.job({
 *     id: 'gen-1',                   // optional
 *     title: 'Neon Harbour',         // what is being made
 *     status: 'queued',              // free text, shown verbatim
 *     canStop: true,                 // false → the Stop button is hidden
 *     onStop: () => controller.abort(),
 *   });
 *   job.update({ status: 'rendering · take 1 of 2' });
 *   job.done(result, meta, { play: true });   // or job.fail(err) / job.end()
 *
 * The same thing works over the bus for screens that would rather not hold a
 * handle (payload `{id, state:'queued'|'running'|'done'|'error', title, status,
 * track, meta, canStop, play}`):
 *
 *   ctx.bus.emit('player:job', { id, state: 'running', status: 'rendering' });
 *   ctx.bus.on('player:job:stop', ({ id }) => controller.abort());
 *
 * ---------------------------------------------------------------------------
 * BUS EVENTS (in addition to the table in docs/CONTRACT.md §3)
 * ---------------------------------------------------------------------------
 *   listens  player:play      {track, title?, cover?, meta?, queue?}  → load + play
 *   listens  player:pause     —                                       → pause
 *   listens  player:enqueue   {track|tracks, play?, replace?}         → queue
 *   listens  player:job       see above
 *   listens  track:new        {track, meta}  → appended to the queue; loaded
 *                             (paused) when the player is idle, so a finished
 *                             generation is always one click from playing.
 *   emits    player:state     {playing, track, time, duration}
 *   emits    player:job:stop  {id}   the user pressed Stop on the live strip
 *
 * ---------------------------------------------------------------------------
 * WAVEFORM
 * ---------------------------------------------------------------------------
 * Real peaks only. The file is fetched once, decoded with WebAudio and reduced
 * to `BUCKETS` min/max buckets; the played portion is filled with the brand
 * gradient. If the browser cannot decode the file the bar says so in words and
 * click-to-seek keeps working off the media element's own duration — it never
 * draws a fake shape.
 *
 * Everything here is same-origin and offline-safe: no fonts, no CDNs, no
 * external requests of any kind.
 */

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const BUCKETS = 1400;          // peak resolution, independent of pixel width
const BAR_PITCH = 3;           // css px per waveform bar
const BAR_WIDTH = 2;
const PEAK_CACHE_MAX = 16;
const MAX_ANALYSE_BYTES = 240 * 1024 * 1024;
const SEEK_STEP = 5;           // seconds, arrow keys
const STATE_TICK_MS = 250;     // player:state emission while playing
const REPEAT_MODES = ['off', 'all', 'one'];

/** url → Float32Array(BUCKETS) of normalised peaks. */
const peakCache = new Map();

let audioCtx = null;
function getAudioContext() {
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try { audioCtx = new Ctor(); } catch { audioCtx = null; }
  return audioCtx;
}

/* ========================================================================== *
 * Small helpers
 * ========================================================================== */

/** @param {number} s @returns {string} `m:ss`, or `h:mm:ss` past an hour. */
function formatTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Human reason for a MediaError. The element gives us a code, not words. */
function mediaErrorText(el) {
  const err = el?.error;
  if (!err) return 'The browser stopped playback without saying why.';
  switch (err.code) {
    case 1: return 'Playback was aborted.';
    case 2: return 'The track could not be fetched — the connection dropped.';
    case 3: return 'The audio is corrupt or truncated and could not be decoded.';
    case 4: return 'The file could not be loaded — it is missing, or in a format this browser cannot play.';
    default: return err.message || `Media error ${err.code}.`;
  }
}

/**
 * Normalise anything a screen might hand us into one shape.
 * @returns {?{id:string,url:string,title:string,filename:string,cover:string,
 *             format:string,size:number,duration:?number,seed:?number,
 *             instrumental:boolean,meta:Object}}
 */
function normalizeTrack(input) {
  if (!input) return null;
  if (typeof input === 'string') return normalizeTrack({ url: input });

  // {track, meta, title, cover, queue} | GenerationResult | Track
  const raw = input.track && typeof input.track === 'object' ? input.track : input;
  const meta = {
    ...(input.meta && typeof input.meta === 'object' ? input.meta : {}),
    ...(input.extra_info ? { extra_info: input.extra_info } : {}),
    ...(raw.extra_info ? { extra_info: raw.extra_info } : {}),
  };

  const url = typeof raw.url === 'string' ? raw.url : (typeof raw.src === 'string' ? raw.src : '');
  if (!url) return null;

  const filename = String(raw.filename || url.split('/').pop() || '');
  const format = String(
    meta.format || raw.format || (filename.includes('.') ? filename.split('.').pop() : '')
  ).toLowerCase();

  const durationRaw = meta.duration ?? meta.extra_info?.music_duration ?? raw.duration ?? null;
  const duration = Number.isFinite(Number(durationRaw)) ? Number(durationRaw) : null;

  return {
    id: String(raw.id || meta.id || url),
    url,
    title: String(input.title || meta.title || '').trim(),
    filename,
    cover: String(input.cover || meta.cover || meta.coverUrl || ''),
    format,
    size: Number(raw.size) || 0,
    duration,
    seed: Number.isFinite(Number(meta.seed)) ? Number(meta.seed) : null,
    instrumental: Boolean(meta.isInstrumental ?? meta.is_instrumental),
    meta,
  };
}

/** Title we are willing to show. Hash filenames are never a title. */
function displayTitle(track) {
  if (!track) return '';
  if (track.title) return track.title;
  const stem = track.filename.replace(/\.[a-z0-9]+$/i, '');
  return /^[0-9a-f]{8,}$/i.test(stem) ? 'Untitled take' : (stem || 'Untitled take');
}

/** The little facts line under the title. */
function subtitleParts(track) {
  if (!track) return [];
  const out = [];
  if (track.format) out.push(track.format.toUpperCase());
  const rate = Number(track.meta?.extra_info?.music_sample_rate || track.meta?.sample_rate);
  if (Number.isFinite(rate) && rate > 0) out.push(`${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)} kHz`);
  if (track.instrumental) out.push('Instrumental');
  if (Number.isFinite(track.seed) && track.seed !== null) out.push(`seed ${track.seed}`);
  if (track.size) out.push(`${(track.size / 1048576).toFixed(1)} MB`);
  if (!out.length && track.filename) out.push(track.filename);
  return out.slice(0, 4);
}

/* ========================================================================== *
 * Mount
 * ========================================================================== */

/**
 * @param {HTMLElement} root  `#player-root`, the persistent bar.
 * @param {*} ctx             Shell context (see docs/CONTRACT.md §2).
 * @returns {Object} the controller stored as `ctx.player`.
 */
export function mount(root, ctx) {
  const { bus, api, storage, iconMarkup } = ctx;

  /* ---------------------------------------------------------------- DOM -- */

  root.classList.add('player');
  root.dataset.player = 'empty';

  root.insertAdjacentHTML('beforeend', `
    <div class="player__job" id="player-job" hidden>
      <span class="player__job-dot" aria-hidden="true"></span>
      <span class="player__job-label">
        <strong class="player__job-title">Generating</strong>
        <span class="player__job-status"></span>
      </span>
      <span class="player__job-track" aria-hidden="true"><i></i></span>
      <span class="player__job-elapsed mono">0:00</span>
      <button class="player__job-stop btn btn--sm btn--outline" type="button">
        ${iconMarkup('close')}<span>Stop</span>
      </button>
    </div>

    <div class="player__main">
      <div class="player__now">
        <div class="player__art" id="player-art">
          <img class="player__art-img" id="player-art-img" alt="" hidden>
          <svg class="player__art-icon" aria-hidden="true"><use href="#i-wave"/></svg>
          <span class="player__eq" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="player__meta">
          <p class="player__title truncate" id="player-title">Nothing playing</p>
          <p class="player__sub truncate" id="player-sub">Generate a track — it lands here automatically.</p>
        </div>
      </div>

      <div class="player__transport">
        <button class="player__btn" id="player-prev" type="button" aria-label="Previous track">
          ${iconMarkup('prev')}
        </button>
        <button class="player__play" id="player-play" type="button" aria-label="Play" aria-keyshortcuts="Space">
          <svg class="icon player__play-icon" aria-hidden="true"><use href="#i-play" id="player-play-use"/></svg>
        </button>
        <button class="player__btn" id="player-next" type="button" aria-label="Next track">
          ${iconMarkup('next')}
        </button>
        <button class="player__btn player__btn--sm" id="player-repeat" type="button"
                aria-label="Repeat" aria-pressed="false">
          ${iconMarkup('repeat')}
          <span class="player__repeat-one" aria-hidden="true">1</span>
        </button>
      </div>

      <div class="player__scrub">
        <span class="player__time mono" id="player-time">0:00</span>
        <div class="player__wave" id="player-wave" data-wave="idle"
             role="slider" tabindex="0" aria-label="Seek"
             aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="Nothing loaded">
          <canvas class="player__canvas" id="player-canvas"></canvas>
          <span class="player__wave-note" id="player-wave-note"></span>
          <span class="player__wave-cursor" id="player-wave-cursor" hidden></span>
          <span class="player__wave-bubble mono" id="player-wave-bubble" hidden>0:00</span>
        </div>
        <span class="player__time player__time--total mono" id="player-total">0:00</span>
      </div>

      <div class="player__side">
        <div class="player__volume">
          <button class="player__btn player__btn--sm" id="player-mute" type="button" aria-label="Mute">
            ${iconMarkup('volume')}
          </button>
          <input class="range player__vol" id="player-vol" type="range"
                 min="0" max="1" step="0.01" value="1" aria-label="Volume">
        </div>
        <a class="player__btn player__download" id="player-download" download
           aria-disabled="true" tabindex="-1" title="Nothing loaded" aria-label="Download track">
          ${iconMarkup('download')}
        </a>
      </div>
    </div>
  `);

  const el = {
    job: root.querySelector('#player-job'),
    jobTitle: root.querySelector('.player__job-title'),
    jobStatus: root.querySelector('.player__job-status'),
    jobElapsed: root.querySelector('.player__job-elapsed'),
    jobStop: root.querySelector('.player__job-stop'),
    art: root.querySelector('#player-art'),
    artImg: root.querySelector('#player-art-img'),
    title: root.querySelector('#player-title'),
    sub: root.querySelector('#player-sub'),
    prev: root.querySelector('#player-prev'),
    play: root.querySelector('#player-play'),
    playUse: root.querySelector('#player-play-use'),
    next: root.querySelector('#player-next'),
    repeat: root.querySelector('#player-repeat'),
    time: root.querySelector('#player-time'),
    total: root.querySelector('#player-total'),
    wave: root.querySelector('#player-wave'),
    canvas: root.querySelector('#player-canvas'),
    waveNote: root.querySelector('#player-wave-note'),
    waveCursor: root.querySelector('#player-wave-cursor'),
    waveBubble: root.querySelector('#player-wave-bubble'),
    mute: root.querySelector('#player-mute'),
    vol: root.querySelector('#player-vol'),
    download: root.querySelector('#player-download'),
  };

  // Colour probe: resolves tokens (including color-mix) to something canvas takes.
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
  root.append(probe);
  const colorCache = new Map();
  function cssColor(expr, fallback = '#ffffff') {
    if (colorCache.has(expr)) return colorCache.get(expr);
    probe.style.color = '';
    probe.style.color = expr;
    const value = getComputedStyle(probe).color || fallback;
    colorCache.set(expr, value);
    return value;
  }

  /* --------------------------------------------------------------- state -- */

  const audio = new Audio();
  audio.preload = 'metadata';

  const state = {
    /** @type {?ReturnType<typeof normalizeTrack>} */
    track: null,
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    scrubbing: false,
    duration: 0,
    time: 0,
    repeat: REPEAT_MODES.includes(storage.get('player.repeat', 'off')) ? storage.get('player.repeat', 'off') : 'off',
    volume: clamp(Number(storage.get('player.volume', 0.85)) || 0, 0, 1),
    muted: Boolean(storage.get('player.muted', false)),
    error: '',
    /** @type {?{id:string,title:string,status:string,canStop:boolean,onStop:?Function,startedAt:number}} */
    job: null,
  };

  /** @type {?Float32Array} */
  let peaks = null;
  let waveNote = '';
  let analyseToken = 0;
  let analyseAbort = null;

  /* ------------------------------------------------------------ waveform -- */

  const cv = el.canvas;
  const cvx = cv.getContext('2d');
  /** Pre-rendered full-width layers: idle (unplayed) and brand (played). */
  const layers = { idle: document.createElement('canvas'), brand: document.createElement('canvas'), w: 0, h: 0 };
  let rafId = 0;

  function waveGeometry() {
    const w = Math.max(1, Math.round(el.wave.clientWidth));
    const h = Math.max(1, Math.round(el.wave.clientHeight));
    return { w, h, dpr: Math.min(window.devicePixelRatio || 1, 2) };
  }

  /** Reduce BUCKETS peaks to one value per drawn bar. */
  function barValues(count) {
    const out = new Float32Array(count);
    if (!peaks || !peaks.length) return out;
    const per = peaks.length / count;
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * per);
      const end = Math.max(start + 1, Math.floor((i + 1) * per));
      let max = 0;
      for (let j = start; j < end && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j];
      out[i] = max;
    }
    return out;
  }

  function paintLayer(canvas, fill, values, w, h, dpr) {
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = fill;
    const mid = h / 2;
    const cap = mid - 1;
    const minH = 1.5;
    for (let i = 0; i < values.length; i++) {
      const x = i * BAR_PITCH;
      const v = peaks ? Math.pow(values[i], 0.78) : 0.1;
      const half = Math.max(minH, v * cap);
      const y = mid - half;
      const hh = half * 2;
      if (c.roundRect) {
        c.beginPath();
        c.roundRect(x, y, BAR_WIDTH, hh, BAR_WIDTH / 2);
        c.fill();
      } else {
        c.fillRect(x, y, BAR_WIDTH, hh);
      }
    }
  }

  function buildLayers() {
    const { w, h, dpr } = waveGeometry();
    layers.w = w; layers.h = h;
    const count = Math.max(1, Math.floor(w / BAR_PITCH));
    const values = barValues(count);

    const idleFill = cssColor('var(--wave-idle)', 'rgba(255,255,255,.2)');
    paintLayer(layers.idle, idleFill, values, w, h, dpr);

    // The brand ramp spans the whole width, so progress reveals cyan → amber.
    const tmp = layers.brand.getContext('2d');
    layers.brand.width = Math.max(1, Math.round(w * dpr));
    layers.brand.height = Math.max(1, Math.round(h * dpr));
    tmp.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = tmp.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, cssColor('var(--brand-cyan)'));
    g.addColorStop(0.2, cssColor('var(--brand-blue)'));
    g.addColorStop(0.4, cssColor('var(--brand-violet)'));
    g.addColorStop(0.6, cssColor('var(--brand-magenta)'));
    g.addColorStop(0.8, cssColor('var(--brand-red)'));
    g.addColorStop(1, cssColor('var(--brand-amber)'));
    paintLayer(layers.brand, g, values, w, h, dpr);

    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    cvx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawWave() {
    const w = layers.w, h = layers.h;
    if (!w || !h) return;
    cvx.clearRect(0, 0, w, h);
    cvx.drawImage(layers.idle, 0, 0, w, h);

    const frac = state.duration > 0 ? clamp(state.time / state.duration, 0, 1) : 0;
    const x = frac * w;
    if (x > 0.5) {
      cvx.save();
      cvx.beginPath();
      cvx.rect(0, 0, x, h);
      cvx.clip();
      cvx.drawImage(layers.brand, 0, 0, w, h);
      cvx.restore();

      // playhead
      cvx.save();
      cvx.globalAlpha = 0.9;
      cvx.fillStyle = cssColor('var(--text-hi)');
      cvx.fillRect(Math.min(w - 1.5, x - 0.75), 1, 1.5, h - 2);
      cvx.restore();
    }
  }

  function refreshWave() {
    buildLayers();
    drawWave();
  }

  function setWaveState(name, note = '') {
    waveNote = note;
    el.wave.dataset.wave = name;
    el.waveNote.textContent = note;
    el.waveNote.hidden = !note;
  }

  /** Fetch → decode → peaks. Real audio only; never invents a shape. */
  async function analyse(track) {
    const token = ++analyseToken;
    analyseAbort?.abort();
    peaks = null;

    if (!track) { setWaveState('idle'); refreshWave(); return; }

    const cached = peakCache.get(track.url);
    if (cached) {
      peaks = cached;
      setWaveState('ready');
      refreshWave();
      return;
    }

    setWaveState('pending', 'reading audio…');
    refreshWave();

    const AC = getAudioContext();
    if (!AC) {
      setWaveState('unavailable', 'waveform unavailable — this browser has no WebAudio');
      refreshWave();
      return;
    }

    const ctrl = new AbortController();
    analyseAbort = ctrl;
    try {
      const res = await fetch(track.url, { signal: ctrl.signal, cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      const length = Number(res.headers.get('content-length')) || 0;
      if (length > MAX_ANALYSE_BYTES) {
        throw new Error(`file is ${(length / 1048576).toFixed(0)} MB — too large to analyse`);
      }
      const bytes = await res.arrayBuffer();
      if (token !== analyseToken) return;

      const buffer = await AC.decodeAudioData(bytes);
      if (token !== analyseToken) return;

      peaks = computePeaks(buffer);
      peakCache.set(track.url, peaks);
      if (peakCache.size > PEAK_CACHE_MAX) peakCache.delete(peakCache.keys().next().value);

      // The decoded buffer is authoritative about length.
      if (Number.isFinite(buffer.duration) && buffer.duration > 0) {
        state.duration = buffer.duration;
        el.total.textContent = formatTime(buffer.duration);
        el.wave.setAttribute('aria-valuemax', String(Math.round(buffer.duration)));
      }
      setWaveState('ready');
      refreshWave();
    } catch (err) {
      if (err?.name === 'AbortError' || token !== analyseToken) return;
      const why = err?.message || String(err);
      setWaveState('unavailable', `waveform unavailable — ${why}`);
      refreshWave();
    } finally {
      if (analyseAbort === ctrl) analyseAbort = null;
    }
  }

  /** @param {AudioBuffer} buffer @returns {Float32Array} normalised 0..1 peaks. */
  function computePeaks(buffer) {
    const channels = Math.min(buffer.numberOfChannels, 2);
    const length = buffer.length;
    const out = new Float32Array(BUCKETS);
    const per = length / BUCKETS;
    const data = [];
    for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

    let peak = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(length, Math.max(start + 1, Math.floor((b + 1) * per)));
      // Sub-sample very long buckets; the shape is identical and it stays fast.
      const step = Math.max(1, Math.floor((end - start) / 900));
      let max = 0;
      for (let c = 0; c < channels; c++) {
        const chan = data[c];
        for (let i = start; i < end; i += step) {
          const v = chan[i] < 0 ? -chan[i] : chan[i];
          if (v > max) max = v;
        }
      }
      out[b] = max;
      if (max > peak) peak = max;
    }
    if (peak > 0) for (let b = 0; b < BUCKETS; b++) out[b] /= peak;
    return out;
  }

  /* ------------------------------------------------------------- painting -- */

  function paintTransport() {
    const has = Boolean(state.track);
    const many = state.queue.length > 1;

    el.play.disabled = !has;
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el.play.title = has
      ? (state.playing ? 'Pause (Space)' : 'Play (Space)')
      : 'Nothing loaded';
    el.playUse.setAttribute('href', state.playing ? '#i-pause' : '#i-play');

    el.prev.disabled = !has;
    el.prev.title = has
      ? (many ? 'Previous track' : 'Restart track')
      : 'Nothing loaded';

    const canNext = many && (state.repeat === 'all' || state.index < state.queue.length - 1);
    el.next.disabled = !canNext;
    el.next.title = canNext
      ? 'Next track'
      : (state.queue.length > 1 ? 'End of the queue' : 'Only one track in the queue');

    el.repeat.disabled = !has;
    el.repeat.dataset.mode = state.repeat;
    el.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    el.repeat.title = has
      ? { off: 'Repeat off', all: 'Repeat queue', one: 'Repeat this track' }[state.repeat]
      : 'Nothing loaded';

    root.dataset.playing = String(state.playing);
  }

  function paintTrack() {
    const t = state.track;
    root.dataset.player = state.error ? 'error' : (t ? 'loaded' : 'empty');
    el.wave.setAttribute('aria-disabled', String(!t));

    if (!t) {
      el.title.textContent = 'Nothing playing';
      el.sub.textContent = 'Generate a track — it lands here automatically.';
      el.sub.classList.remove('is-error');
      el.artImg.hidden = true;
      el.artImg.removeAttribute('src');
      el.download.setAttribute('aria-disabled', 'true');
      el.download.setAttribute('tabindex', '-1');
      el.download.removeAttribute('href');
      el.download.title = 'Nothing loaded';
      el.total.textContent = '0:00';
      el.time.textContent = '0:00';
      el.wave.setAttribute('aria-valuetext', 'Nothing loaded');
      el.wave.setAttribute('aria-valuemax', '0');
      paintTransport();
      return;
    }

    el.title.textContent = displayTitle(t);
    el.title.title = displayTitle(t);
    if (state.error) {
      el.sub.textContent = state.error;
      el.sub.title = `${state.error}\n${t.url}`;
      el.sub.classList.add('is-error');
    } else {
      const parts = subtitleParts(t);
      el.sub.textContent = state.loading ? 'Loading…' : parts.join('  ·  ');
      el.sub.title = t.filename;
      el.sub.classList.remove('is-error');
    }

    if (t.cover) {
      // Library hands us an inline SVG data URI for tracks with no real art.
      el.artImg.src = /^(data:|blob:)/i.test(t.cover) ? t.cover : api.mediaUrl(t.cover);
      el.artImg.hidden = false;
    } else {
      el.artImg.hidden = true;
      el.artImg.removeAttribute('src');
    }

    el.download.href = api.mediaUrl(t.url);
    el.download.setAttribute('download', t.filename || 'track');
    el.download.removeAttribute('aria-disabled');
    el.download.setAttribute('tabindex', '0');
    el.download.title = `Download ${t.filename || 'track'}`;

    paintTransport();
  }

  function paintTime() {
    el.time.textContent = formatTime(state.time);
    el.total.textContent = formatTime(state.duration);
    el.wave.setAttribute('aria-valuenow', String(Math.round(state.time)));
    el.wave.setAttribute('aria-valuemax', String(Math.round(state.duration)));
    el.wave.setAttribute(
      'aria-valuetext',
      state.duration ? `${formatTime(state.time)} of ${formatTime(state.duration)}` : 'Nothing loaded',
    );
  }

  function paintVolume() {
    // While muted the slider reads 0; state.volume is remembered for unmute.
    const v = state.muted ? 0 : state.volume;
    el.vol.value = String(v);
    el.vol.style.setProperty('--range-pos', String(v));
    el.mute.querySelector('use').setAttribute('href', state.muted || state.volume === 0 ? '#i-mute' : '#i-volume');
    el.mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
    el.mute.title = state.muted ? 'Unmute' : `Mute (${Math.round(state.volume * 100)}%)`;
    el.mute.setAttribute('aria-pressed', String(state.muted));
  }

  /* ---------------------------------------------------------- state feed -- */

  let lastEmit = 0;
  function emitState(force = false) {
    const now = performance.now();
    if (!force && now - lastEmit < STATE_TICK_MS) return;
    lastEmit = now;
    bus.emit('player:state', {
      playing: state.playing,
      track: state.track ? { ...state.track } : null,
      time: state.time,
      duration: state.duration,
    });
  }

  function tick() {
    rafId = 0;
    if (!state.scrubbing) state.time = audio.currentTime || 0;
    paintTime();
    drawWave();
    emitState();
    if (state.playing) rafId = requestAnimationFrame(tick);
  }

  function startTicking() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------- loading -- */

  function applyMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      const t = state.track;
      navigator.mediaSession.metadata = t && window.MediaMetadata
        ? new window.MediaMetadata({
          title: displayTitle(t),
          // The song's own credit. It used to say "MaxMusic" on every track,
          // which put the tool's name where the artist's belongs.
          artist: String(t.artist || '').trim(),
          album: t.instrumental ? 'Instrumental' : 'MiniMax Music 3',
        })
        : null;
      navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    } catch { /* media session is a nicety */ }
  }

  /**
   * @param {*} input
   * @param {{play?: boolean, queue?: Array}} [opts]
   */
  function load(input, opts = {}) {
    const track = normalizeTrack(input);
    if (!track) return null;

    const explicit = Array.isArray(opts.queue) ? opts.queue
      : (Array.isArray(input?.queue) ? input.queue : null);
    if (explicit) {
      const list = explicit.map(normalizeTrack).filter(Boolean);
      if (list.length) {
        state.queue = list;
        if (!list.some((t) => t.url === track.url)) state.queue.unshift(track);
      }
    }
    if (!state.queue.length) state.queue = [track];

    const at = state.queue.findIndex((t) => t.url === track.url);
    if (at >= 0) { state.queue[at] = track; state.index = at; }
    else { state.queue.push(track); state.index = state.queue.length - 1; }

    state.track = track;
    state.error = '';
    state.loading = true;
    state.time = 0;
    state.duration = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0;

    audio.loop = state.repeat === 'one';
    audio.src = api.mediaUrl(track.url);
    audio.load();

    // A hover readout from the previous track would now be lying.
    el.waveCursor.hidden = true;
    el.waveBubble.hidden = true;

    paintTrack();
    paintTime();
    analyse(track);
    applyMediaSession();
    emitState(true);

    if (opts.play) play();
    return track;
  }

  function play() {
    if (!state.track) return Promise.resolve(false);
    const p = audio.play();
    if (!p || typeof p.then !== 'function') return Promise.resolve(true);
    return p.then(() => true).catch((err) => {
      if (err?.name === 'NotAllowedError') {
        ctx.toast('The browser blocked playback until you interact with the page. Press play again.', {
          kind: 'warn', title: 'Autoplay blocked',
        });
      } else {
        ctx.toast(err?.message || String(err), { kind: 'error', title: 'Cannot play' });
      }
      return false;
    });
  }

  function pause() {
    if (!state.track) return false;
    audio.pause();
    return true;
  }

  function toggle() {
    if (!state.track) return false;
    return state.playing ? pause() : play();
  }

  function goTo(index, { play: shouldPlay = true } = {}) {
    if (!state.queue.length) return false;
    const next = state.queue[index];
    if (!next) return false;
    state.index = index;
    const wasPlaying = state.playing || shouldPlay;
    load(next, { play: wasPlaying });
    return true;
  }

  function next({ auto = false } = {}) {
    if (state.queue.length < 2) {
      if (auto) { audio.pause(); seek(0); }
      return false;
    }
    const last = state.index >= state.queue.length - 1;
    if (last && state.repeat !== 'all') {
      if (auto) { audio.pause(); seek(0); }
      return false;
    }
    return goTo(last ? 0 : state.index + 1, { play: auto || state.playing });
  }

  function prev() {
    if (!state.track) return false;
    if (state.time > 3 || state.queue.length < 2) { seek(0); return true; }
    const first = state.index <= 0;
    return goTo(first ? state.queue.length - 1 : state.index - 1, { play: state.playing });
  }

  function seek(seconds) {
    if (!state.track) return false;
    const max = state.duration || audio.duration || 0;
    const to = clamp(Number(seconds) || 0, 0, max > 0 ? max : 0);
    state.time = to;
    try { audio.currentTime = to; } catch { /* not seekable yet */ }
    paintTime();
    drawWave();
    emitState(true);
    return true;
  }

  const seekFraction = (f) => seek(clamp(Number(f) || 0, 0, 1) * (state.duration || 0));

  function setVolume(v) {
    state.volume = clamp(Number(v) || 0, 0, 1);
    if (state.volume > 0) state.muted = false;
    audio.volume = state.volume;
    audio.muted = state.muted;
    storage.set('player.volume', state.volume);
    storage.set('player.muted', state.muted);
    paintVolume();
    return state.volume;
  }

  function toggleMute(force) {
    state.muted = typeof force === 'boolean' ? force : !state.muted;
    audio.muted = state.muted;
    storage.set('player.muted', state.muted);
    paintVolume();
    return state.muted;
  }

  function cycleRepeat() {
    const at = REPEAT_MODES.indexOf(state.repeat);
    state.repeat = REPEAT_MODES[(at + 1) % REPEAT_MODES.length];
    audio.loop = state.repeat === 'one';
    storage.set('player.repeat', state.repeat);
    paintTransport();
    return state.repeat;
  }

  /**
   * @param {*} tracks  one track or an array of them
   * @param {{replace?: boolean, play?: boolean}} [opts]
   */
  function enqueue(tracks, opts = {}) {
    const list = (Array.isArray(tracks) ? tracks : [tracks]).map(normalizeTrack).filter(Boolean);
    if (!list.length) return state.queue.length;

    if (opts.replace) { state.queue = list; state.index = -1; }
    else {
      for (const t of list) {
        const at = state.queue.findIndex((q) => q.url === t.url);
        if (at >= 0) state.queue[at] = t;
        else state.queue.push(t);
      }
    }
    if (!state.track || opts.play) {
      const target = opts.replace ? state.queue[0] : list[0];
      load(target, { play: Boolean(opts.play) });
    } else {
      // The queue always contains whatever is playing, so `index` stays real.
      let at = state.queue.findIndex((q) => q.url === state.track.url);
      if (at < 0) { state.queue.unshift(state.track); at = 0; }
      state.index = at;
      paintTransport();
    }
    return state.queue.length;
  }

  function clearQueue() {
    state.queue = state.track ? [state.track] : [];
    state.index = state.track ? 0 : -1;
    paintTransport();
    return state.queue.length;
  }

  /* ------------------------------------------------------ generating job -- */

  let jobTimer = 0;

  function paintJob() {
    const j = state.job;
    el.job.hidden = !j;
    root.dataset.job = j ? 'live' : '';
    if (!j) {
      clearInterval(jobTimer);
      jobTimer = 0;
      refreshWave();
      return;
    }
    el.jobTitle.textContent = j.title || 'Generating';
    el.jobStatus.textContent = j.status || '';
    el.jobStop.hidden = !j.canStop;
    el.jobElapsed.textContent = formatTime((Date.now() - j.startedAt) / 1000);
    if (!jobTimer) {
      jobTimer = setInterval(() => {
        if (!state.job) return;
        el.jobElapsed.textContent = formatTime((Date.now() - state.job.startedAt) / 1000);
      }, 1000);
    }
    // The bar grew a strip; the waveform box changed height.
    requestAnimationFrame(refreshWave);
  }

  function endJob() {
    state.job = null;
    paintJob();
  }

  /**
   * @param {{id?:string,title?:string,status?:string,canStop?:boolean,onStop?:Function}} info
   */
  function startJob(info = {}) {
    state.job = {
      id: String(info.id || `job-${Date.now()}`),
      title: String(info.title || 'Generating'),
      status: String(info.status || ''),
      canStop: info.canStop !== false,
      onStop: typeof info.onStop === 'function' ? info.onStop : null,
      startedAt: Number(info.startedAt) || Date.now(),
    };
    paintJob();

    const id = state.job.id;
    const guard = (fn) => (...args) => (state.job?.id === id ? fn(...args) : undefined);

    return {
      id,
      update: guard((patch = {}) => {
        Object.assign(state.job, {
          title: patch.title ?? state.job.title,
          status: patch.status ?? state.job.status,
          canStop: patch.canStop ?? state.job.canStop,
        });
        paintJob();
      }),
      done: guard((track, meta, opts = {}) => {
        endJob();
        if (track) return load({ track, meta }, { play: Boolean(opts.play) });
        return null;
      }),
      fail: guard((err) => {
        endJob();
        if (err) ctx.toast(api.errorText(err), { kind: 'error', title: 'Generation failed' });
      }),
      end: guard(endJob),
    };
  }

  el.jobStop.addEventListener('click', () => {
    const j = state.job;
    if (!j) return;
    el.jobStop.disabled = true;
    el.jobStop.querySelector('span').textContent = 'Stopping…';
    try { j.onStop?.(); } catch (err) { console.error('[player] job onStop failed', err); }
    bus.emit('player:job:stop', { id: j.id });
    // The owner decides when the job actually ends; if nobody is listening the
    // strip would hang, so give the request a visible deadline.
    setTimeout(() => {
      el.jobStop.disabled = false;
      el.jobStop.querySelector('span').textContent = 'Stop';
      if (state.job?.id === j.id) {
        state.job.status = 'stop requested — waiting for the generator';
        paintJob();
      }
    }, 4000);
  });

  /* -------------------------------------------------------- audio events -- */

  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) state.duration = audio.duration;
    state.loading = false;
    paintTrack();
    paintTime();
    drawWave();
  });
  audio.addEventListener('durationchange', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      state.duration = audio.duration;
      paintTime();
    }
  });
  audio.addEventListener('canplay', () => { state.loading = false; paintTrack(); });
  audio.addEventListener('waiting', () => { state.loading = true; root.dataset.buffering = 'true'; });
  audio.addEventListener('playing', () => { root.dataset.buffering = 'false'; });
  audio.addEventListener('play', () => {
    state.playing = true;
    state.error = '';
    paintTransport();
    applyMediaSession();
    startTicking();
    emitState(true);
  });
  audio.addEventListener('pause', () => {
    state.playing = false;
    paintTransport();
    applyMediaSession();
    emitState(true);
    drawWave();
  });
  audio.addEventListener('timeupdate', () => {
    if (state.scrubbing) return;
    state.time = audio.currentTime || 0;
    paintTime();
    drawWave();
  });
  audio.addEventListener('ended', () => {
    state.playing = false;
    if (state.repeat === 'one') return; // audio.loop handles it
    if (!next({ auto: true })) {
      state.time = state.duration;
      paintTime();
      paintTransport();
      drawWave();
      emitState(true);
    }
  });
  audio.addEventListener('error', () => {
    state.loading = false;
    state.playing = false;
    state.error = `Playback failed — ${mediaErrorText(audio)}`;
    paintTrack();
    // analyse() may already have a more specific reason (an HTTP status); keep it.
    if (el.wave.dataset.wave !== 'unavailable') {
      setWaveState('unavailable', 'no waveform — the file could not be read');
      refreshWave();
    }
    ctx.toast(`${state.error}\n${state.track?.url || ''}`, { kind: 'error', title: 'Player' });
    emitState(true);
  });

  /* ------------------------------------------------------- input wiring -- */

  el.play.addEventListener('click', () => toggle());
  el.prev.addEventListener('click', () => prev());
  el.next.addEventListener('click', () => next());
  el.repeat.addEventListener('click', () => cycleRepeat());
  el.mute.addEventListener('click', () => toggleMute());
  el.vol.addEventListener('input', () => setVolume(el.vol.value));
  el.download.addEventListener('click', (e) => {
    if (el.download.getAttribute('aria-disabled') === 'true') e.preventDefault();
  });

  // --- seek / scrub --------------------------------------------------------
  const fractionAt = (clientX) => {
    const rect = el.wave.getBoundingClientRect();
    return rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
  };

  let scrubRaf = 0;
  function scrubTo(clientX) {
    const f = fractionAt(clientX);
    state.time = f * (state.duration || 0);
    paintTime();
    if (!scrubRaf) {
      scrubRaf = requestAnimationFrame(() => { scrubRaf = 0; drawWave(); });
    }
  }

  el.wave.addEventListener('pointerdown', (e) => {
    if (!state.track || !state.duration) return;
    e.preventDefault();
    state.scrubbing = true;
    el.wave.setPointerCapture(e.pointerId);
    el.wave.dataset.scrubbing = 'true';
    scrubTo(e.clientX);
  });
  el.wave.addEventListener('pointermove', (e) => {
    if (state.duration > 0) {
      const f = fractionAt(e.clientX);
      el.waveCursor.hidden = false;
      el.waveCursor.style.left = `${f * 100}%`;
      el.waveBubble.hidden = false;
      el.waveBubble.textContent = formatTime(f * state.duration);
      el.waveBubble.style.left = `${f * 100}%`;
    }
    if (state.scrubbing) scrubTo(e.clientX);
  });
  el.wave.addEventListener('pointerleave', () => {
    el.waveCursor.hidden = true;
    el.waveBubble.hidden = true;
  });
  const endScrub = (e) => {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    delete el.wave.dataset.scrubbing;
    try { el.wave.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    seek(fractionAt(e.clientX) * (state.duration || 0));
  };
  el.wave.addEventListener('pointerup', endScrub);
  el.wave.addEventListener('pointercancel', endScrub);

  el.wave.addEventListener('keydown', (e) => {
    if (!state.track || !state.duration) return;
    const map = {
      ArrowLeft: () => seek(state.time - SEEK_STEP),
      ArrowRight: () => seek(state.time + SEEK_STEP),
      ArrowDown: () => seek(state.time - SEEK_STEP),
      ArrowUp: () => seek(state.time + SEEK_STEP),
      PageDown: () => seek(state.time - SEEK_STEP * 3),
      PageUp: () => seek(state.time + SEEK_STEP * 3),
      Home: () => seek(0),
      End: () => seek(state.duration),
      ' ': () => toggle(),
    };
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  });

  // --- global space bar ----------------------------------------------------
  function onKeydown(e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement
      && (t.isContentEditable || t.closest('input, textarea, select, button, a, [role="slider"], [tabindex]'))) return;
    if (!state.track) return;
    e.preventDefault();
    toggle();
  }
  window.addEventListener('keydown', onKeydown);

  // --- resize --------------------------------------------------------------
  const ro = new ResizeObserver(() => refreshWave());
  ro.observe(el.wave);

  /* ---------------------------------------------------------- bus wiring -- */

  bus.on('player:play', (payload) => { load(payload, { play: true }); });
  bus.on('player:pause', () => pause());
  bus.on('player:enqueue', (payload = {}) => {
    enqueue(Array.isArray(payload.tracks) ? payload.tracks : payload, {
      replace: Boolean(payload.replace),
      play: Boolean(payload.play),
    });
  });
  bus.on('track:new', (payload) => {
    const track = normalizeTrack(payload);
    if (!track) return;
    enqueue(track); // loads it only when the player is idle
  });
  bus.on('player:job', (payload = {}) => {
    const stateName = payload.state || (payload.done ? 'done' : 'running');
    if (stateName === 'done') {
      endJob();
      if (payload.track) load(payload, { play: Boolean(payload.play) });
      return;
    }
    if (stateName === 'error') {
      endJob();
      if (payload.error) ctx.toast(api.errorText(payload.error), { kind: 'error', title: 'Generation failed' });
      return;
    }
    if (stateName === 'cancelled' || stateName === 'end') { endJob(); return; }
    if (state.job && (!payload.id || payload.id === state.job.id)) {
      state.job.title = payload.title ?? state.job.title;
      state.job.status = payload.status ?? state.job.status;
      if (payload.canStop !== undefined) state.job.canStop = Boolean(payload.canStop);
      paintJob();
    } else {
      startJob(payload);
    }
  });

  /* ------------------------------------------------------- media session -- */

  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => play(),
      pause: () => pause(),
      previoustrack: () => prev(),
      nexttrack: () => next(),
      seekbackward: () => seek(state.time - SEEK_STEP * 2),
      seekforward: () => seek(state.time + SEEK_STEP * 2),
      seekto: (d) => { if (d?.seekTime != null) seek(d.seekTime); },
    };
    for (const [name, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* unsupported action */ }
    }
  }

  /* --------------------------------------------------------------- boot -- */

  audio.volume = state.volume;
  audio.muted = state.muted;
  audio.loop = state.repeat === 'one';
  paintVolume();
  paintTrack();
  paintTime();
  setWaveState('idle');
  refreshWave();
  emitState(true);

  /* ---------------------------------------------------------- controller -- */

  const controller = {
    load,
    play,
    pause,
    toggle,
    next: () => next(),
    prev,
    seek,
    seekFraction,
    setVolume,
    toggleMute,
    setRepeat: (mode) => {
      if (!REPEAT_MODES.includes(mode)) return state.repeat;
      state.repeat = mode;
      audio.loop = mode === 'one';
      storage.set('player.repeat', mode);
      paintTransport();
      return state.repeat;
    },
    queue: enqueue,
    clearQueue,
    getQueue: () => state.queue.map((t) => ({ ...t })),
    job: startJob,
    getState: () => ({
      playing: state.playing,
      loading: state.loading,
      track: state.track ? { ...state.track } : null,
      time: state.time,
      duration: state.duration,
      volume: state.volume,
      muted: state.muted,
      repeat: state.repeat,
      index: state.index,
      queueLength: state.queue.length,
      job: state.job ? { id: state.job.id, title: state.job.title, status: state.job.status } : null,
      waveform: el.wave.dataset.wave,
      waveformNote: waveNote,
    }),
    destroy() {
      cancelAnimationFrame(rafId);
      clearInterval(jobTimer);
      analyseAbort?.abort();
      ro.disconnect();
      window.removeEventListener('keydown', onKeydown);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      root.replaceChildren();
      root.classList.remove('player');
    },
  };

  return controller;
}

export default mount;
