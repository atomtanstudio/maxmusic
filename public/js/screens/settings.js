/**
 * Settings — the backend's own account of itself, plus the defaults this
 * browser starts every request from.
 *
 * Everything on the left of this screen is read from `GET /api/health` and is
 * shown verbatim: backend mode, ComfyUI URL and live reachability, the music
 * model profiles the server reports, the lyrics provider, cover-art
 * availability and whether a server key is present. Nothing here is invented.
 *
 * Guidance (cfg) and flow-matching steps are server env only (SPEC §3b). They
 * are listed READ-ONLY with the variable that owns them and the backend's
 * documented fallback — never as a control, and never as a live value, because
 * `/api/health` does not report one.
 *
 * The only writable settings are client-side defaults, persisted to
 * localStorage under the single key `maxmusic:defaults`:
 *   { duration: number, format: 'flac'|'mp3'|'wav', bitrate: number,
 *     startScreen: 'create'|'studio'|'library'|'lyrics'|'art'|'settings',
 *     artist: string }
 *
 * @module screens/settings
 */

export const meta = {
  title: 'Settings',
  subtitle: 'What the server is actually running',
  css: '/css/screens/settings.css',
};

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const PREF_KEY = 'defaults';

const PREF_FALLBACK = Object.freeze({
  duration: 120,
  format: 'flac',
  bitrate: 256000,
  startScreen: 'create',
  // Whoever is credited on a song. Almost always the same person every time,
  // so it lives here and each song may override it rather than being retyped.
  artist: '',
});

/** Longest artist name we will store. Long enough for a band, short enough to lay out. */
const ARTIST_MAX = 60;

const START_SCREENS = [
  ['create', 'Create'],
  ['studio', 'Studio'],
  ['library', 'Library'],
  ['lyrics', 'Lyrics'],
  ['art', 'Art'],
  ['settings', 'Settings'],
];

const FORMAT_NOTE = {
  flac: 'Lossless, and the backend default. Largest files.',
  mp3: 'Compressed. Bitrate below applies to mp3 only.',
  wav: 'Lossless PCM. Plays anywhere, large files.',
};

/**
 * Server-only settings. `/api/health` does not report their live values, so no
 * value is displayed as if it were live — only the variable that owns them and
 * the fallback the backend uses when the variable is unset.
 */
const SERVER_ONLY = [
  {
    name: 'Guidance (cfg)',
    env: 'COMFY_MUSIC_CFG',
    fallback: '1.7',
    note: 'How closely the model follows your description. Set on the server, between 0 and 100. The server does not report its live value, so it is not shown here.',
  },
  {
    name: 'Flow-matching steps',
    env: 'COMFY_MUSIC_STEPS',
    fallback: '30',
    note: 'How much work goes into each take — more steps, slower and steadier. Set on the server, between 1 and 200.',
  },
  {
    name: 'Server default duration',
    env: 'COMFY_MUSIC_DEFAULT_DURATION',
    fallback: '120 s',
    note: 'Used only when a request omits duration. A request that sends its own duration wins.',
  },
  {
    name: 'Auto-lyrics (lyrics_optimizer)',
    env: '—',
    fallback: 'rejected',
    note: 'Not available in local-comfy mode: the backend throws if a request sets it. Vocal songs need real lyrics — write them on the Lyrics screen first.',
  },
];

/* ========================================================================== *
 * Small helpers
 * ========================================================================== */

const hostOf = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

function clockOf(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function agoText(then) {
  if (!then) return '—';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(then).toLocaleTimeString();
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number} `value` as a finite number, or `fallback`. Guards the
 *   `Number(null) === 0` trap so a missing preference falls back honestly.
 */
function numberOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ========================================================================== *
 * Markup
 * ========================================================================== */

function chainNode(id, name, glyph) {
  const art = glyph === 'brandmark'
    ? '<span class="brandmark set-node__mark"><img src="/logo.png" alt=""></span>'
    : `<svg class="icon set-node__glyph" aria-hidden="true"><use href="#i-${glyph}"/></svg>`;
  return `
    <div class="set-node" role="listitem" data-node="${id}" data-state="checking">
      <span class="set-node__badge">${art}</span>
      <span class="set-node__pip" aria-hidden="true"></span>
      <div class="set-node__text">
        <p class="set-node__name" data-name>${name}</p>
        <p class="set-node__sub mono truncate" data-sub>…</p>
        <p class="set-node__state" data-state-text>checking</p>
      </div>
    </div>`;
}

function capCard(id, glyph, name, link) {
  return `
    <article class="card set-cap" data-cap="${id}" data-state="checking">
      <header class="set-cap__head">
        <span class="set-cap__icon"><svg class="icon" aria-hidden="true"><use href="#i-${glyph}"/></svg></span>
        <h3 class="set-cap__name">${name}</h3>
      </header>
      <div class="set-cap__row">
        <p class="set-cap__value mono" data-value>…</p>
        <span class="badge set-cap__badge" data-badge>Checking</span>
      </div>
      <p class="set-cap__note" data-note></p>
      ${link
        ? `<a class="set-cap__link" href="#/${link}">Open ${link[0].toUpperCase()}${link.slice(1)}
             <svg class="icon" aria-hidden="true"><use href="#i-chevron-right"/></svg></a>`
        : ''}
    </article>`;
}

function envRow(row) {
  return `
    <li class="set-env">
      <div class="set-env__head">
        <span class="set-env__name"></span>
        <code class="code set-env__env"></code>
        <span class="badge set-env__badge">
          <svg class="icon set-env__lock" aria-hidden="true"><use href="#i-lock"/></svg>server setting
        </span>
      </div>
      <p class="set-env__value mono">unset → <b></b></p>
      <p class="set-env__note"></p>
    </li>`;
}

function template(iconMarkup) {
  return `
  <section class="panel set-hero" data-state="checking">
    <div class="set-hero__line" data-line aria-hidden="true"></div>

    <div class="set-hero__top">
      <span class="set-hero__dot" aria-hidden="true"></span>
      <div class="set-hero__head">
        <h2 class="set-hero__title" data-title>Checking backend…</h2>
        <p class="set-hero__msg" data-message>contacting /api/health</p>
      </div>
      <dl class="set-hero__meta">
        <div><dt>Checked</dt><dd data-checked>—</dd></div>
        <div><dt>Round trip</dt><dd data-rtt>—</dd></div>
        <div><dt>Endpoint</dt><dd data-endpoint class="truncate">/api/health</dd></div>
      </dl>
    </div>

    <div class="set-chain" role="list" aria-label="Request path">
      ${chainNode('browser', 'This browser', 'panel')}
      <span class="set-chain__link" data-link="1" aria-hidden="true"></span>
      ${chainNode('app', 'MaxMusic app', 'brandmark')}
      <span class="set-chain__link" data-link="2" aria-hidden="true"></span>
      ${chainNode('api', 'Backend API', 'studio')}
      <span class="set-chain__link" data-link="3" aria-hidden="true"></span>
      ${chainNode('engine', 'ComfyUI', 'wave')}
    </div>

    <div class="notice set-verdict" data-verdict data-state="checking">
      <span class="notice__icon">${iconMarkup('info')}</span>
      <div>
        <p class="notice__title" data-verdict-title>Checking</p>
        <p data-verdict-text>Asking the backend how it is doing.</p>
      </div>
    </div>
  </section>

  <section class="set-sec">
    <header class="set-sec__head">
      <h2 class="set-sec__title">Capabilities</h2>
      <p class="set-sec__note">Every value below comes from <code class="code">/api/health</code>, verbatim.</p>
    </header>
    <div class="set-caps">
      ${capCard('music', 'wave', 'Music generation', 'create')}
      ${capCard('lyrics', 'mic', 'Lyrics', 'lyrics')}
      ${capCard('cover', 'art', 'Cover art', 'art')}
      ${capCard('key', 'lock', 'Server API key', '')}
    </div>
  </section>

  <div class="set-split">
    <div class="set-col">
      <section class="set-sec">
        <header class="set-sec__head">
          <h2 class="set-sec__title">Music models</h2>
          <p class="set-sec__note">Profiles the backend reports.</p>
        </header>
        <div class="panel">
          <ul class="set-models" data-models></ul>
          <p class="hint set-models__foot">
            A request may name one of these keys as <code class="code">model</code>.
            When it does not, the backend picks its own profile.
          </p>
        </div>
      </section>

      <section class="set-sec">
        <header class="set-sec__head">
          <h2 class="set-sec__title">This client</h2>
          <p class="set-sec__note">The half of the path that runs in your browser.</p>
        </header>
        <div class="panel">
          <dl class="set-facts">
            <div class="set-fact">
              <dt>App origin</dt>
              <dd class="mono truncate" data-fact-origin>…</dd>
            </div>
            <div class="set-fact">
              <dt>Proxied to the backend</dt>
              <dd class="mono">/api · /tracks · /covers · /uploads</dd>
            </div>
            <div class="set-fact">
              <dt>Player module</dt>
              <dd class="mono" data-fact-player>…</dd>
            </div>
            <div class="set-fact">
              <dt>Preferences</dt>
              <dd class="mono" data-fact-store>…</dd>
            </div>
          </dl>
        </div>
      </section>

      <details class="set-raw">
        <summary class="set-raw__summary">
          <svg class="icon set-raw__chev" aria-hidden="true"><use href="#i-chevron-right"/></svg>
          Raw <code class="code">/api/health</code> response
          <span class="spacer"></span>
          <span class="set-raw__meta mono" data-raw-meta></span>
        </summary>
        <pre class="set-raw__pre mono" data-raw>…</pre>
      </details>
    </div>

    <section class="set-sec">
      <header class="set-sec__head">
        <h2 class="set-sec__title">Server settings</h2>
        <p class="set-sec__note">Read-only. Not client-controllable.</p>
      </header>
      <div class="panel">
        <ul class="set-envs" data-envs>${SERVER_ONLY.map(envRow).join('')}</ul>
        <p class="hint set-envs__foot">
          These live in the backend's environment, not in this app. MaxMusic ships no
          control for them on purpose — a slider that cannot reach the server is a lie.
        </p>
      </div>
    </section>
  </div>

  <section class="set-sec">
    <header class="set-sec__head">
      <h2 class="set-sec__title">OpenAI account</h2>
      <p class="set-sec__note">Signs in on the server. This browser never holds the credential.</p>
    </header>

    <div class="panel set-account" data-account data-state="checking">
      <div class="set-account__row">
        <span class="set-account__dot" aria-hidden="true"></span>
        <div class="set-account__text">
          <p class="set-account__state" data-account-state>Checking OpenAI…</p>
          <p class="set-account__note" data-account-note></p>
        </div>
        <button class="btn btn--sm set-account__btn" type="button" data-account-btn disabled>
          Sign in with OpenAI
        </button>
      </div>

      <div class="set-account__pending" data-account-pending hidden>
        <p class="set-account__pendtext">
          Finish signing in on the OpenAI tab. This page picks it up on its own.
        </p>
        <p class="set-account__code" data-account-code hidden>
          If the tab didn’t open, go to <b data-account-url></b> and enter
          <code class="code" data-account-verify></code>
        </p>
        <div class="row">
          <button class="btn btn--sm" type="button" data-account-cancel>Stop waiting</button>
          <button class="btn btn--sm btn--ghost" type="button" data-account-reopen>Open the tab again</button>
        </div>
      </div>
    </div>
  </section>

  <section class="set-sec">
    <header class="set-sec__head">
      <h2 class="set-sec__title">Your defaults</h2>
      <p class="set-sec__note">Stored in this browser under <code class="code">maxmusic:defaults</code>.</p>
      <button class="btn btn--sm btn--ghost set-sec__action" type="button" data-reset>
        ${iconMarkup('refresh')}Reset
      </button>
    </header>

    <div class="panel set-prefs">
      <div class="set-pref">
        <div class="field">
          <label class="label" for="set-duration-num">
            Default duration
            <span class="label__hint" data-duration-clock>2:00</span>
          </label>
          <div class="set-pref__control">
            <input class="range set-pref__range" type="range" id="set-duration"
                   min="10" max="360" step="5" aria-label="Default duration in seconds">
            <input class="input set-pref__num mono" type="number" id="set-duration-num"
                   min="0.04" max="360" step="1" inputmode="decimal">
            <span class="set-pref__unit">s</span>
          </div>
          <p class="hint" data-duration-hint>
            MiniMax Music 3 accepts 0.04–360 s. New requests start here.
          </p>
        </div>
      </div>

      <div class="set-pref">
        <div class="field">
          <span class="label" id="set-format-label">Default format</span>
          <div class="segment set-pref__segment" role="group" aria-labelledby="set-format-label" data-format>
            <button class="segment__item" type="button" data-format-value="flac" aria-pressed="false">FLAC</button>
            <button class="segment__item" type="button" data-format-value="mp3" aria-pressed="false">MP3</button>
            <button class="segment__item" type="button" data-format-value="wav" aria-pressed="false">WAV</button>
          </div>
          <p class="hint" data-format-hint></p>
        </div>
        <div class="field set-pref__sub">
          <label class="label" for="set-bitrate">
            mp3 bitrate
            <span class="label__hint" data-bitrate-state></span>
          </label>
          <select class="select" id="set-bitrate" data-bitrate></select>
        </div>
      </div>

      <div class="set-pref">
        <div class="field">
          <label class="label" for="set-artist">Artist name</label>
          <div class="set-pref__control">
            <input class="input set-pref__text" type="text" id="set-artist" data-artist
                   maxlength="${ARTIST_MAX}" autocomplete="off" spellcheck="false"
                   placeholder="Nobody in particular">
          </div>
          <p class="hint">
            Who gets credited on the songs you make. Any song can override it in Studio.
            Leave it empty and songs stay uncredited.
          </p>
        </div>
      </div>

      <div class="set-pref">
        <div class="field">
          <label class="label" for="set-start">Start screen</label>
          <div class="set-pref__control">
            <select class="select" id="set-start" data-start></select>
            <button class="btn btn--sm" type="button" data-open-start>
              ${iconMarkup('external')}Open
            </button>
          </div>
          <p class="hint">
            MaxMusic opens the route in the URL and falls back to
            <code class="code">#/create</code>. This choice is stored for screens that link
            home; <b>Open</b> takes you there now.
          </p>
        </div>
      </div>

      <div class="set-preview">
        <span class="label">What a new request starts from</span>
        <code class="set-preview__code mono" data-preview></code>
        <p class="hint hint--warn set-preview__warn" data-preview-warn hidden></p>
      </div>
    </div>
  </section>`;
}

/* ========================================================================== *
 * Mount
 * ========================================================================== */

/**
 * @param {HTMLElement} root
 * @param {*} ctx
 * @returns {() => void} teardown
 */
export function mount(root, ctx) {
  const { api } = ctx;

  const page = document.createElement('div');
  page.className = 'page screen-settings';
  page.innerHTML = template(ctx.iconMarkup);
  root.append(page);

  const $ = (sel) => page.querySelector(sel);
  const el = {
    hero: $('.set-hero'),
    title: $('[data-title]'),
    message: $('[data-message]'),
    checked: $('[data-checked]'),
    rtt: $('[data-rtt]'),
    endpoint: $('[data-endpoint]'),
    verdict: $('[data-verdict]'),
    verdictTitle: $('[data-verdict-title]'),
    verdictText: $('[data-verdict-text]'),
    models: $('[data-models]'),
    envs: $('[data-envs]'),
    raw: $('[data-raw]'),
    rawMeta: $('[data-raw-meta]'),
    durationRange: $('#set-duration'),
    durationNum: $('#set-duration-num'),
    durationClock: $('[data-duration-clock]'),
    formatGroup: $('[data-format]'),
    formatHint: $('[data-format-hint]'),
    bitrate: $('[data-bitrate]'),
    bitrateState: $('[data-bitrate-state]'),
    start: $('[data-start]'),
    artist: $('[data-artist]'),
    openStart: $('[data-open-start]'),
    account: $('[data-account]'),
    accountState: $('[data-account-state]'),
    accountNote: $('[data-account-note]'),
    accountBtn: $('[data-account-btn]'),
    accountPending: $('[data-account-pending]'),
    accountCode: $('[data-account-code]'),
    accountUrl: $('[data-account-url]'),
    accountVerify: $('[data-account-verify]'),
    accountCancel: $('[data-account-cancel]'),
    accountReopen: $('[data-account-reopen]'),
    preview: $('[data-preview]'),
    previewWarn: $('[data-preview-warn]'),
    reset: $('[data-reset]'),
    factOrigin: $('[data-fact-origin]'),
    factPlayer: $('[data-fact-player]'),
    factStore: $('[data-fact-store]'),
  };
  const node = (id) => page.querySelector(`[data-node="${id}"]`);
  const link = (n) => page.querySelector(`[data-link="${n}"]`);
  const cap = (id) => page.querySelector(`[data-cap="${id}"]`);

  /* ---------------------------------------------------------- server rows */

  Array.from(el.envs.children).forEach((li, i) => {
    const row = SERVER_ONLY[i];
    li.querySelector('.set-env__name').textContent = row.name;
    li.querySelector('.set-env__env').textContent = row.env;
    li.querySelector('.set-env__value b').textContent = row.fallback;
    li.querySelector('.set-env__note').textContent = row.note;
    if (row.env === '—') {
      li.querySelector('.set-env__env').hidden = true;
      li.querySelector('.set-env__value').firstChild.textContent = 'request → ';
    }
  });

  /* --------------------------------------------------------- client facts */

  el.factOrigin.textContent = location.origin;

  /** Client-side half of the diagnosis: player module and preference storage. */
  function paintClient() {
    const loaded = Boolean(ctx.player);
    el.factPlayer.textContent = loaded ? 'loaded' : (ctx.playerUnavailableReason || 'not loaded');
    el.factPlayer.dataset.state = loaded ? 'ok' : 'warn';

    // storage.set returns false when localStorage is unavailable (private mode,
    // blocked cookies). Probe with a throwaway key so nothing is left behind.
    const writable = ctx.storage.set('storage.probe', 1);
    if (writable) ctx.storage.remove('storage.probe');
    el.factStore.textContent = writable
      ? 'localStorage · writable'
      : 'localStorage · blocked, nothing persists';
    el.factStore.dataset.state = writable ? 'ok' : 'warn';
  }

  /* --------------------------------------------------------------- health */

  /** @type {?number} */
  let rttMs = null;
  /** @type {?import('../api.js').Health} */
  let snapshot = null;

  const BADGE = { ok: 'badge--ok', warn: 'badge--warn', fail: 'badge--danger', info: 'badge--info', checking: '' };

  function paintNode(id, state, sub, stateText) {
    const n = node(id);
    if (!n) return;
    n.dataset.state = state;
    n.querySelector('[data-sub]').textContent = sub;
    n.querySelector('[data-state-text]').textContent = stateText;
  }

  function paintLink(n, state) {
    const l = link(n);
    if (l) l.dataset.state = state;
  }

  function paintCap(id, { state, badge, value, note }) {
    const c = cap(id);
    if (!c) return;
    c.dataset.state = state;
    const b = c.querySelector('[data-badge]');
    b.className = `badge set-cap__badge ${BADGE[state] || ''}`.trim();
    b.textContent = badge;
    c.querySelector('[data-value]').textContent = value;
    c.querySelector('[data-note]').textContent = note;
  }

  const VERDICT_ICON = { ok: 'check', warn: 'alert', fail: 'alert', checking: 'info' };

  function paintVerdict(state, title, text) {
    el.verdict.dataset.state = state;
    el.verdict.querySelector('.notice__icon use')
      .setAttribute('href', `#i-${VERDICT_ICON[state] || 'info'}`);
    el.verdictTitle.textContent = title;
    el.verdictText.textContent = text;
  }

  function paintModels(h) {
    el.models.replaceChildren();
    const keys = h ? h.modelKeys : [];
    if (!keys.length) {
      const li = document.createElement('li');
      li.className = 'set-model set-model--empty';
      li.textContent = h && h.status === 'offline'
        ? 'The backend did not answer, so it reported no model profiles.'
        : 'The backend reported no music models.';
      el.models.append(li);
      return;
    }
    for (const key of keys) {
      const li = document.createElement('li');
      li.className = 'set-model';
      const k = document.createElement('span');
      k.className = 'set-model__key mono';
      k.textContent = key;
      const label = document.createElement('span');
      label.className = 'set-model__label';
      label.textContent = h.musicModels[key];
      li.append(k, label);
      el.models.append(li);
    }
  }

  function paintHealth(h) {
    snapshot = h;
    const offline = h.status === 'offline';
    const degraded = h.status === 'degraded';
    // Only claim a remote backend when the health call actually told us so —
    // an offline snapshot reports `backend: 'unreachable'`, which is not an answer.
    const remote = !offline && h.backend !== 'local-comfy';
    /** The API error kind tells us which hop broke: 0 = never reached this app. */
    const errStatus = h.error ? h.error.status : null;
    const proxyDead = offline && errStatus === 0;

    el.hero.dataset.state = h.status;
    el.title.textContent = offline
      ? 'Backend offline'
      : degraded ? 'Generator not ready' : 'Backend online';
    el.message.textContent = h.message;
    el.endpoint.textContent = h.error && h.error.endpoint ? h.error.endpoint : '/api/health';

    /* --- request path ---------------------------------------------------- */
    paintNode('browser', navigator.onLine ? 'ok' : 'warn',
      navigator.onLine ? 'online' : 'offline',
      navigator.onLine ? 'requests start here' : 'this browser reports no network');

    paintNode('app', proxyDead ? 'fail' : 'ok',
      location.host,
      proxyDead ? 'the /api proxy did not answer' : 'serves this page, proxies /api');

    paintNode('api', offline ? (proxyDead ? 'unknown' : 'fail') : 'ok',
      offline ? (h.error && h.error.status ? `HTTP ${h.error.status}` : 'no response') : h.backend,
      offline ? (proxyDead ? 'not reached' : 'refused the request') : 'answering /api/health');

    const engineName = offline ? 'Music engine' : (remote ? 'MiniMax API' : 'ComfyUI');
    node('engine').querySelector('[data-name]').textContent = engineName;
    if (offline) {
      // The backend never answered, so which engine it uses is genuinely unknown.
      paintNode('engine', 'unknown', 'not reported', 'not reached');
    } else if (remote) {
      paintNode('engine', h.ok ? 'ok' : 'fail',
        (h.raw && h.raw.apiBase) ? hostOf(h.raw.apiBase) : 'remote',
        h.ok ? 'reported ready' : 'not ready');
    } else {
      paintNode('engine', h.comfyReachable ? 'ok' : 'fail',
        h.comfyUrl ? hostOf(h.comfyUrl) : 'no COMFY_URL reported',
        h.comfyReachable ? 'reachable' : (h.comfyError || 'unreachable'));
    }

    paintLink(1, proxyDead ? 'fail' : 'ok');
    paintLink(2, proxyDead ? 'unknown' : (offline ? 'fail' : 'ok'));
    paintLink(3, offline ? 'unknown' : (remote ? (h.ok ? 'ok' : 'fail') : (h.comfyReachable ? 'ok' : 'fail')));

    /* --- verdict --------------------------------------------------------- */
    if (offline) {
      paintVerdict('fail', 'Nothing can generate',
        `${h.message}\nThe API did not answer, so every screen that talks to the backend will fail. Check that the MaxMusic backend is running and that this app can proxy to it.`);
    } else if (degraded) {
      paintVerdict('warn', 'Generation will fail until the engine answers',
        remote
          ? h.message
          : `${h.comfyError || h.message}\nMaxMusic reaches the backend, but the backend cannot reach ComfyUI at ${h.comfyUrl || 'the configured COMFY_URL'}. Start ComfyUI on that host, or point COMFY_URL at the right one.`);
    } else {
      paintVerdict('ok', 'Ready to generate',
        `${h.backend} is up and ${remote ? 'the API reports ready' : `ComfyUI answers at ${hostOf(h.comfyUrl) || 'the configured COMFY_URL'}`}. Vocal songs still need lyrics — the backend will not write them, so use Lyrics first.`);
    }

    /* --- capabilities ---------------------------------------------------- */
    paintCap('music', offline
      ? { state: 'fail', badge: 'Offline', value: h.backend, note: 'MaxMusic could not reach your studio.' }
      : degraded
        ? { state: 'warn', badge: 'Not ready', value: h.backend, note: h.comfyError || h.message }
        : {
            state: 'ok',
            badge: 'Ready',
            value: h.backend,
            note: remote
              ? 'Generation runs on the MiniMax API.'
              : `Generation runs on your own ComfyUI at ${h.comfyUrl || 'the configured COMFY_URL'}.`,
          });

    paintCap('lyrics', offline
      ? { state: 'fail', badge: 'Unknown', value: h.lyricsProvider, note: 'The backend did not answer, so its lyrics provider is unknown.' }
      : h.lyricsEnabled
        ? { state: 'ok', badge: 'Available', value: h.lyricsProvider, note: 'Ready to write lyrics. A song with vocals needs words first — start on the Lyrics screen.' }
        : { state: 'warn', badge: 'Off', value: h.lyricsProvider, note: 'No lyrics provider is configured. Set LOCAL_CODEX_BIN and LOCAL_CODEX_HOME in the backend environment, or paste lyrics by hand.' });

    paintCap('cover', offline
      ? { state: 'fail', badge: 'Unknown', value: h.coverArtProvider, note: 'The backend did not answer, so cover art availability is unknown.' }
      : h.coverArtEnabled
        ? { state: 'ok', badge: 'Available', value: h.coverArtProvider, note: 'Ready to make album art for any of your songs. Start on the Art screen.' }
        : { state: 'warn', badge: 'Disabled', value: h.coverArtProvider, note: 'Cover art is off. Set COMFY_COVER_WORKFLOW to a ComfyUI image workflow, or LOCAL_MEDIA_BROKER_URL to a running local broker, in the backend environment.' });

    paintCap('key', offline
      ? { state: 'fail', badge: 'Unknown', value: '—', note: 'The backend did not answer.' }
      : h.hasServerKey
        ? { state: 'ok', badge: 'Present', value: 'server key set', note: 'The server holds its own MiniMax key, so this browser never sends one.' }
        : remote
          ? { state: 'warn', badge: 'Missing', value: 'none', note: 'The remote backend has no MINIMAX_API_KEY. Requests to the MiniMax API will be rejected until one is set on the server.' }
          : { state: 'info', badge: 'Not needed', value: 'none', note: 'local-comfy renders on your own hardware. A MiniMax API key is only used by the remote backend.' });

    /* --- models + raw ---------------------------------------------------- */
    paintModels(h);

    el.raw.textContent = h.raw
      ? JSON.stringify(h.raw, null, 2)
      : (h.error ? h.error.fullMessage : 'no response body');
    el.rawMeta.textContent = h.error
      ? `HTTP ${h.error.status || 'no response'}`
      : `HTTP 200 · ${Object.keys(h.raw || {}).length} fields`;

    paintClock();
  }

  function paintClock() {
    el.checked.textContent = snapshot ? agoText(snapshot.checkedAt) : '—';
    el.rtt.textContent = rttMs === null ? '—' : `${rttMs} ms`;
  }

  let busy = false;
  async function recheck() {
    if (busy) return;
    busy = true;
    el.hero.dataset.busy = 'true';
    recheckBtn.disabled = true;
    const started = performance.now();
    try {
      await ctx.refreshHealth();
      rttMs = Math.round(performance.now() - started);
    } finally {
      busy = false;
      el.hero.removeAttribute('data-busy');
      recheckBtn.disabled = false;
      paintClock();
    }
  }

  /* ------------------------------------------------------------ defaults  */

  const stored = ctx.storage.get(PREF_KEY, null);
  const prefs = {
    duration: numberOr(stored && stored.duration, PREF_FALLBACK.duration),
    format: api.FORMATS.includes(stored && stored.format) ? stored.format : PREF_FALLBACK.format,
    bitrate: numberOr(stored && stored.bitrate, PREF_FALLBACK.bitrate),
    startScreen: START_SCREENS.some(([k]) => k === (stored && stored.startScreen))
      ? stored.startScreen
      : PREF_FALLBACK.startScreen,
    artist: String((stored && stored.artist) || PREF_FALLBACK.artist).slice(0, ARTIST_MAX),
  };

  for (const rate of api.BITRATES) {
    const opt = document.createElement('option');
    opt.value = String(rate);
    opt.textContent = `${rate / 1000} kbps`;
    el.bitrate.append(opt);
  }
  for (const [value, label] of START_SCREENS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    el.start.append(opt);
  }

  function persist() {
    ctx.storage.set(PREF_KEY, { ...prefs });
  }

  /**
   * Runs the real validator so the preview and any clamp warning are honest.
   * While the duration field is being typed into, validate what is in the field
   * — that is how the user finds out their 1000 became 360.
   */
  function paintPreview() {
    const typing = document.activeElement === el.durationNum && el.durationNum.value !== '';
    const check = api.validateGeneration({
      is_instrumental: true,
      prompt: 'preview',
      duration: typing ? el.durationNum.value : prefs.duration,
      audio_setting: {
        format: prefs.format,
        bitrate: prefs.format === 'mp3' ? prefs.bitrate : undefined,
      },
    });
    el.preview.textContent = JSON.stringify({
      duration: Number.isFinite(check.payload.duration) ? check.payload.duration : prefs.duration,
      audio_setting: check.payload.audio_setting,
    });
    const notes = [...check.errors, ...check.warnings];
    el.previewWarn.hidden = notes.length === 0;
    el.previewWarn.textContent = notes.join(' ');
    el.previewWarn.classList.toggle('hint--error', check.errors.length > 0);
    el.previewWarn.classList.toggle('hint--warn', check.errors.length === 0);
  }

  function paintDefaults() {
    const d = prefs.duration;
    el.durationRange.value = String(Math.min(360, Math.max(10, Math.round(d))));
    el.durationRange.style.setProperty('--range-fill', `${((el.durationRange.value - 10) / 350) * 100}%`);
    if (document.activeElement !== el.durationNum) el.durationNum.value = String(d);
    el.durationClock.textContent = clockOf(d);

    for (const btn of el.formatGroup.querySelectorAll('[data-format-value]')) {
      const on = btn.dataset.formatValue === prefs.format;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    el.formatHint.textContent = FORMAT_NOTE[prefs.format];

    const mp3 = prefs.format === 'mp3';
    el.bitrate.disabled = !mp3;
    el.bitrate.value = String(prefs.bitrate);
    el.bitrateState.textContent = mp3 ? '' : `ignored for ${prefs.format}`;

    // Don't fight the caret while it is being typed into.
    if (document.activeElement !== el.artist) el.artist.value = prefs.artist;

    el.start.value = prefs.startScreen;
    const label = (START_SCREENS.find(([k]) => k === prefs.startScreen) || [])[1] || '';
    el.openStart.title = `Go to ${label}`;

    paintPreview();
  }

  function setDuration(raw) {
    const check = api.validateGeneration({
      is_instrumental: true,
      prompt: 'preview',
      duration: raw,
      audio_setting: { format: prefs.format },
    });
    if (Number.isFinite(check.payload.duration)) {
      prefs.duration = check.payload.duration;
      persist();
    }
    paintDefaults();
  }

  /* ---------------------------------------------------------- topbar keys */

  const recheckBtn = document.createElement('button');
  recheckBtn.className = 'btn btn--sm';
  recheckBtn.type = 'button';
  recheckBtn.innerHTML = `${ctx.iconMarkup('refresh', 'icon set-recheck__icon')}Re-check`;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn--sm btn--ghost';
  copyBtn.type = 'button';
  copyBtn.innerHTML = `${ctx.iconMarkup('copy')}Copy report`;

  ctx.headerSlot.append(copyBtn, recheckBtn);

  /** One paste-able block for a bug report — every value straight from health. */
  function report() {
    const h = snapshot;
    const row = (label, value) => `${(label + ' ').padEnd(17, '.')} ${value}`;
    const lines = [
      `MaxMusic diagnostics — ${new Date().toISOString()}`,
      row('app', location.origin),
      row('player module', ctx.player ? 'loaded' : (ctx.playerUnavailableReason || 'not loaded')),
      row('health status', h ? h.status : 'unknown'),
      row('health message', h ? h.message.replace(/\n/g, ' / ') : '—'),
      row('round trip', rttMs === null ? '—' : `${rttMs} ms`),
      row('backend', h ? h.backend : '—'),
      row('comfy url', h && h.comfyUrl ? h.comfyUrl : '—'),
      row('comfy reachable', h ? String(h.comfyReachable) : '—'),
      row('comfy error', h && h.comfyError ? h.comfyError : '—'),
      row('models', h && h.modelKeys.length ? h.modelKeys.join(', ') : '—'),
      row('lyrics', h ? h.lyricsProvider : '—'),
      row('cover art', h ? h.coverArtProvider : '—'),
      row('server key', h ? String(h.hasServerKey) : '—'),
      row('client defaults', JSON.stringify(prefs)),
      '',
      'raw /api/health:',
      h && h.raw ? JSON.stringify(h.raw, null, 2) : (h && h.error ? h.error.fullMessage : 'no response'),
    ];
    return lines.join('\n');
  }

  /** Older/permission-restricted browsers have no async clipboard. */
  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  copyBtn.addEventListener('click', async () => {
    const text = report();
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast('Diagnostics copied to the clipboard.', { kind: 'success' });
    } catch (err) {
      if (legacyCopy(text)) {
        ctx.toast('Diagnostics copied to the clipboard.', { kind: 'success' });
        return;
      }
      ctx.toast(`Could not copy: ${api.errorText(err)}`, { kind: 'warn', title: 'Clipboard blocked' });
    }
  });
  recheckBtn.addEventListener('click', recheck);

  /* --------------------------------------------------------------- events */

  el.durationRange.addEventListener('input', () => setDuration(el.durationRange.value));
  el.durationNum.addEventListener('input', () => setDuration(el.durationNum.value));
  el.durationNum.addEventListener('blur', () => paintDefaults());

  el.formatGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-format-value]');
    if (!btn) return;
    prefs.format = btn.dataset.formatValue;
    persist();
    paintDefaults();
  });

  el.bitrate.addEventListener('change', () => {
    prefs.bitrate = Number(el.bitrate.value) || PREF_FALLBACK.bitrate;
    persist();
    paintDefaults();
  });

  el.start.addEventListener('change', () => {
    prefs.startScreen = el.start.value;
    persist();
    paintDefaults();
  });

  el.artist.addEventListener('input', () => {
    prefs.artist = el.artist.value.slice(0, ARTIST_MAX);
    persist();
  });

  el.openStart.addEventListener('click', () => ctx.navigate(prefs.startScreen));

  el.reset.addEventListener('click', () => {
    Object.assign(prefs, PREF_FALLBACK);
    ctx.storage.remove(PREF_KEY);
    paintDefaults();
    ctx.toast('Defaults reset to 120 s, FLAC, Create.', { kind: 'info' });
  });

  const onNetwork = () => { if (snapshot) paintHealth(snapshot); };
  window.addEventListener('online', onNetwork);
  window.addEventListener('offline', onNetwork);

  /* ----------------------------------------------------------------- boot */

  /* ------------------------------------------------------- OpenAI account  */

  /* One attempt at a time. `pollTimer` is a chain of delayed single requests,
     never a setInterval — an interval can start a second poll while the first
     is still out, which the broker contract rules out explicitly. */
  const attempt = { id: '', url: '', expiresAt: 0 };
  let pollTimer = null;
  let pollAbort = null;
  let starting = false;

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollAbort?.abort(new DOMException('Cancelled', 'AbortError'));
    pollAbort = null;
    attempt.id = '';
    attempt.url = '';
    attempt.expiresAt = 0;
    el.accountPending.hidden = true;
    paintAccount(ctx.auth);
  }

  function paintAccount(auth) {
    const waiting = Boolean(attempt.id);
    el.accountPending.hidden = !waiting;

    if (waiting) {
      el.account.dataset.state = 'pending';
      el.accountState.textContent = 'Finish sign-in in the OpenAI tab…';
      el.accountNote.textContent = 'This page is watching for it.';
      el.accountBtn.hidden = true;
      return;
    }
    el.accountBtn.hidden = false;

    if (!auth) {
      el.account.dataset.state = 'checking';
      el.accountState.textContent = 'Checking OpenAI…';
      el.accountNote.textContent = '';
      el.accountBtn.disabled = true;
      return;
    }
    if (!auth.reachable) {
      el.account.dataset.state = 'fail';
      el.accountState.textContent = 'Can’t check your OpenAI account';
      el.accountNote.textContent = 'Your studio didn’t answer. It has to be running to sign in.';
      el.accountBtn.disabled = true;
      el.accountBtn.textContent = 'Sign in with OpenAI';
      return;
    }
    if (!auth.brokerConfigured) {
      el.account.dataset.state = 'off';
      el.accountState.textContent = 'No OpenAI account is set up';
      el.accountNote.textContent = 'Your studio has no broker to sign in through, so this is set up on the server.';
      el.accountBtn.disabled = true;
      el.accountBtn.textContent = 'Sign in with OpenAI';
      return;
    }
    if (auth.authenticated) {
      el.account.dataset.state = 'ok';
      el.accountState.textContent = 'OpenAI · connected';
      const bits = [];
      if (auth.planType) bits.push(`${auth.planType} plan`);
      bits.push(auth.codexAvailable ? 'lyrics ready' : 'lyrics unavailable');
      bits.push(auth.imageGeneration ? 'album art ready' : 'album art unavailable');
      el.accountNote.textContent = bits.join(' · ');
      el.accountBtn.disabled = false;
      el.accountBtn.textContent = 'Check again';
      return;
    }
    el.account.dataset.state = 'off';
    el.accountState.textContent = 'Not signed in';
    el.accountNote.textContent = 'Signing in lets MaxMusic write lyrics and make album art.';
    el.accountBtn.disabled = false;
    el.accountBtn.textContent = 'Sign in with OpenAI';
  }

  async function pollOnce() {
    if (!attempt.id) return;
    if (attempt.expiresAt && Date.now() > attempt.expiresAt) {
      stopPolling();
      ctx.toast('That sign-in expired before it finished. Try again when you are ready.',
        { kind: 'warn', title: 'Sign-in timed out' });
      return;
    }
    pollAbort = new AbortController();
    try {
      const res = await api.openaiAuthPoll(attempt.id, { signal: pollAbort.signal });
      if (!attempt.id) return;                       // cancelled while in flight
      if (res.status === 'completed') {
        attempt.id = '';
        el.accountPending.hidden = true;
        await ctx.refreshAuth();
        ctx.toast('Lyrics and album art are ready to use.', { kind: 'success', title: 'OpenAI connected' });
        return;
      }
      if (res.status === 'failed') {
        const message = res.message;
        stopPolling();
        ctx.toast(message, { kind: 'error', title: 'Sign-in didn’t finish' });
        return;
      }
      if (res.expiresAt) attempt.expiresAt = res.expiresAt;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const message = api.errorText(err);
      stopPolling();
      ctx.toast(message, { kind: 'error', title: 'Sign-in didn’t finish' });
      return;
    }
    pollTimer = setTimeout(pollOnce, 1500);
  }

  el.accountBtn.addEventListener('click', async () => {
    if (starting) return;                            // duplicate clicks do nothing
    const auth = ctx.auth;
    if (auth?.authenticated) { await ctx.refreshAuth(); return; }

    starting = true;
    el.accountBtn.disabled = true;
    try {
      const started = await api.openaiAuthStart();
      if (started.status === 'already_authenticated') {
        await ctx.refreshAuth();
        return;
      }
      if (!started.id) throw new Error('Your studio didn’t return a sign-in to wait on.');

      attempt.id = started.id;
      attempt.url = started.url;
      attempt.expiresAt = started.expiresAt;
      el.accountUrl.textContent = started.url;
      el.accountVerify.textContent = started.verificationCode;
      el.accountCode.hidden = !started.verificationCode;
      paintAccount(ctx.auth);
      if (started.url) window.open(started.url, '_blank', 'noopener,noreferrer');
      pollTimer = setTimeout(pollOnce, 1200);
    } catch (err) {
      ctx.toast(api.errorText(err), { kind: 'error', title: 'Couldn’t start sign-in' });
    } finally {
      starting = false;
      el.accountBtn.disabled = false;
      paintAccount(ctx.auth);
    }
  });

  el.accountCancel.addEventListener('click', stopPolling);
  el.accountReopen.addEventListener('click', () => {
    if (attempt.url) window.open(attempt.url, '_blank', 'noopener,noreferrer');
  });

  ctx.onHealth(paintHealth);
  ctx.onAuth(paintAccount);
  ctx.bus.on('player:ready', paintClient);
  paintClient();
  paintDefaults();
  paintAccount(ctx.auth);
  ctx.refreshAuth();
  const ticker = setInterval(paintClock, 1000);
  recheck();

  return () => {
    clearInterval(ticker);
    stopPolling();
    window.removeEventListener('online', onNetwork);
    window.removeEventListener('offline', onNetwork);
  };
}
