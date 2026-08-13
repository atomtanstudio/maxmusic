/**
 * MaxMusic — application shell.
 *
 * Owns the frame (rail, topbar, screen outlet, player slot), the router, the
 * live backend-status indicator, toasts, the cross-screen event bus and the
 * context object every screen receives.
 *
 * Screens never import this file. They receive everything through `ctx`.
 * See docs/CONTRACT.md.
 *
 * @module app
 */

import * as api from './api.js';
import { createRouter } from './router.js';

/* ========================================================================== *
 * Elements
 * ========================================================================== */

const el = {
  app: document.getElementById('app'),
  rail: document.getElementById('rail'),
  railToggle: document.getElementById('rail-toggle'),
  railScrim: document.getElementById('rail-scrim'),
  navOpen: document.getElementById('nav-open'),
  navItems: Array.from(document.querySelectorAll('.navitem[data-route]')),
  libraryCount: document.getElementById('nav-library-count'),
  status: document.getElementById('status-pill'),
  statusLabel: document.getElementById('status-label'),
  statusDetail: document.getElementById('status-detail'),
  topbarTitle: document.getElementById('topbar-title'),
  topbarSub: document.getElementById('topbar-sub'),
  topbarActions: document.getElementById('topbar-actions'),
  screen: document.getElementById('screen'),
  playerRoot: document.getElementById('player-root'),
  playerFallback: document.getElementById('player-fallback'),
  playerFallbackText: document.getElementById('player-fallback-text'),
  toasts: document.getElementById('toasts'),
};

/* ========================================================================== *
 * Event bus
 * ========================================================================== */

/** @type {Map<string, Set<Function>>} */
const channels = new Map();

export const bus = {
  /**
   * @param {string} event
   * @param {(payload: *) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(event, fn) {
    if (!channels.has(event)) channels.set(event, new Set());
    channels.get(event).add(fn);
    return () => bus.off(event, fn);
  },
  off(event, fn) { channels.get(event)?.delete(fn); },
  once(event, fn) {
    const off = bus.on(event, (payload) => { off(); fn(payload); });
    return off;
  },
  emit(event, payload) {
    const set = channels.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error(`[bus] "${event}" listener failed`, err); }
    }
  },
};

/* ========================================================================== *
 * Small utilities handed to screens
 * ========================================================================== */

const STORE_PREFIX = 'maxmusic:';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(STORE_PREFIX + key); } catch { /* private mode */ }
  },
};

/**
 * Build an `<svg><use/></svg>` for a sprite symbol in index.html.
 * @param {string} name  Sprite id without the `i-` prefix, e.g. `play`.
 * @param {string} [className]
 * @returns {SVGSVGElement}
 */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * Same icon, as a markup string for template literals.
 * @param {string} name
 * @param {string} [className]
 * @returns {string}
 */
export function iconMarkup(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/* ========================================================================== *
 * Screen CSS registry
 * ========================================================================== */

/** @type {Map<string, Promise<boolean>>} */
const cssLoads = new Map();

/**
 * Add a stylesheet once. The file is probed first so that a screen whose CSS
 * has not been written yet degrades silently instead of logging a MIME error
 * (the dev server answers unknown paths with index.html).
 *
 * @param {string} href
 * @returns {Promise<boolean>} true when the sheet is applied.
 */
export function registerCss(href) {
  if (!href) return Promise.resolve(false);
  if (cssLoads.has(href)) return cssLoads.get(href);

  const job = (async () => {
    let ok = false;
    try {
      // GET rather than HEAD: the dev server streams a body for HEAD too, which
      // Chrome logs as a failed request. A second small local GET is cheaper noise.
      const res = await fetch(href, { cache: 'no-store' });
      ok = res.ok && (res.headers.get('content-type') || '').includes('css');
    } catch { ok = false; }

    if (!ok) {
      console.warn(`[shell] stylesheet not available: ${href}`);
      cssLoads.delete(href); // allow a retry once the owning lane writes it
      return false;
    }
    await new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.screenCss = href;
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      document.head.append(link);
    });
    return true;
  })();

  cssLoads.set(href, job);
  return job;
}

/* ========================================================================== *
 * Toasts
 * ========================================================================== */

const TOAST_ICON = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };

/**
 * @param {string} message               Shown verbatim; newlines preserved.
 * @param {{kind?: 'info'|'success'|'warn'|'error', title?: string,
 *          timeout?: number, action?: {label: string, onClick: () => void}}} [opts]
 * @returns {() => void} dismiss
 */
export function toast(message, opts = {}) {
  const { kind = 'info', title = '', timeout = kind === 'error' ? 9000 : 5000, action } = opts;

  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.innerHTML = `
    <span class="toast__icon">${iconMarkup(TOAST_ICON[kind] || 'info')}</span>
    <div class="toast__body">
      ${title ? '<p class="toast__title"></p>' : ''}
      <p class="toast__msg"></p>
    </div>
    <button class="toast__close" type="button" aria-label="Dismiss">${iconMarkup('close')}</button>`;

  if (title) node.querySelector('.toast__title').textContent = title;
  node.querySelector('.toast__msg').textContent = String(message);

  let timer = null;
  const dismiss = () => {
    if (!node.isConnected) return;
    clearTimeout(timer);
    node.setAttribute('data-leaving', '');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  node.querySelector('.toast__close').addEventListener('click', dismiss);

  if (action?.label) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--sm';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.style.marginTop = 'var(--space-4)';
    btn.addEventListener('click', () => { action.onClick?.(); dismiss(); });
    node.querySelector('.toast__body').append(btn);
  }

  el.toasts.append(node);
  if (timeout > 0) timer = setTimeout(dismiss, timeout);
  return dismiss;
}

/* ========================================================================== *
 * Backend health
 * ========================================================================== */

const HEALTH_INTERVAL = 30_000;

const state = {
  /** @type {?import('./api.js').Health} */
  health: null,
  /** @type {?Object} */
  player: null,
  playerReason: '',
};

let healthTimer = null;
let healthInFlight = null;

function paintStatus(snapshot) {
  const s = el.status;
  if (!s) return;

  if (!snapshot) {
    s.dataset.state = 'checking';
    el.statusLabel.textContent = 'Checking backend…';
    el.statusDetail.textContent = 'contacting /api/health';
    s.removeAttribute('title');
    return;
  }

  s.dataset.state = snapshot.status;

  if (snapshot.status === 'online') {
    el.statusLabel.textContent = 'Backend online';
    const host = snapshot.comfyUrl ? snapshot.comfyUrl.replace(/^https?:\/\//, '') : snapshot.backend;
    el.statusDetail.textContent = host;
    s.title = [
      `backend: ${snapshot.backend}`,
      snapshot.comfyUrl ? `comfy: ${snapshot.comfyUrl}` : null,
      snapshot.modelKeys.length ? `models: ${snapshot.modelKeys.join(', ')}` : null,
      `lyrics: ${snapshot.lyricsProvider}`,
      `cover art: ${snapshot.coverArtProvider}`,
    ].filter(Boolean).join('\n');
  } else if (snapshot.status === 'degraded') {
    el.statusLabel.textContent = 'Generator not ready';
    el.statusDetail.textContent = snapshot.comfyError || snapshot.message;
    s.title = snapshot.message;
  } else {
    el.statusLabel.textContent = 'Backend offline';
    el.statusDetail.textContent = snapshot.message;
    s.title = snapshot.message;
  }
}

/**
 * Re-check `/api/health`, repaint the rail indicator and notify subscribers.
 * @returns {Promise<import('./api.js').Health>}
 */
export function refreshHealth() {
  if (healthInFlight) return healthInFlight;
  if (!state.health) paintStatus(null);

  healthInFlight = api.health()
    .then((snapshot) => {
      const previous = state.health;
      state.health = snapshot;
      paintStatus(snapshot);
      bus.emit('health', snapshot);

      if (previous && previous.status !== snapshot.status && snapshot.status !== 'online') {
        toast(snapshot.message, {
          kind: snapshot.status === 'offline' ? 'error' : 'warn',
          title: snapshot.status === 'offline' ? 'Backend offline' : 'Generator not ready',
        });
      }
      return snapshot;
    })
    .finally(() => { healthInFlight = null; });

  return healthInFlight;
}

function startHealthPolling() {
  refreshHealth();
  healthTimer = setInterval(refreshHealth, HEALTH_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.health || Date.now() - state.health.checkedAt > 15_000) refreshHealth();
  });
  window.addEventListener('online', () => refreshHealth());
}

/**
 * Subscribe to health snapshots. Fires immediately when one already exists.
 * @param {(h: import('./api.js').Health) => void} fn
 * @returns {() => void} unsubscribe
 */
function onHealth(fn) {
  const off = bus.on('health', fn);
  if (state.health) { try { fn(state.health); } catch (err) { console.error(err); } }
  return off;
}

/* ========================================================================== *
 * Chrome: nav rail, topbar
 * ========================================================================== */

function setActiveNav(name) {
  for (const item of el.navItems) {
    const active = item.dataset.route === name;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

/**
 * @param {string} title
 * @param {string} [sub]
 */
function setTitle(title, sub = '') {
  const text = String(title || 'MaxMusic');
  el.topbarTitle.textContent = text;
  document.title = text === 'MaxMusic' ? 'MaxMusic' : `${text} · MaxMusic`;
  el.topbarSub.textContent = sub || '';
  el.topbarSub.hidden = !sub;
}

function setRailCollapsed(collapsed) {
  el.app.dataset.rail = collapsed ? 'collapsed' : 'expanded';
  storage.set('rail.collapsed', collapsed);
  el.railToggle?.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
  el.railToggle?.setAttribute('title', collapsed ? 'Expand navigation' : 'Collapse navigation');
  // Labels are hidden when collapsed — keep the names reachable on hover.
  for (const item of el.navItems) {
    if (collapsed) item.title = item.querySelector('.navitem__label')?.textContent?.trim() || '';
    else item.removeAttribute('title');
  }
}

function setDrawer(open) {
  el.app.dataset.nav = open ? 'open' : 'closed';
  el.railScrim.hidden = !open;
}

function wireChrome() {
  setRailCollapsed(Boolean(storage.get('rail.collapsed', false)));
  setDrawer(false);

  el.railToggle?.addEventListener('click', () => {
    setRailCollapsed(el.app.dataset.rail !== 'collapsed');
  });
  el.navOpen?.addEventListener('click', () => setDrawer(el.app.dataset.nav !== 'open'));
  el.railScrim?.addEventListener('click', () => setDrawer(false));
  el.rail?.addEventListener('click', (e) => {
    if (e.target.closest('.navitem, .brand')) setDrawer(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.app.dataset.nav === 'open') setDrawer(false);
  });

  el.status?.addEventListener('click', () => { refreshHealth(); });

  bus.on('library:changed', (payload) => {
    const count = Number(payload?.count);
    if (!Number.isFinite(count) || count <= 0) {
      el.libraryCount.hidden = true;
      el.libraryCount.textContent = '';
    } else {
      el.libraryCount.hidden = false;
      el.libraryCount.textContent = count > 999 ? '999+' : String(count);
    }
  });
}

/* ========================================================================== *
 * Player module bootstrap (owned by the player lane)
 * ========================================================================== */

async function bootPlayer(context) {
  const url = '/js/player.js';
  let available = false;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    available = res.ok && (res.headers.get('content-type') || '').includes('javascript');
  } catch { available = false; }

  if (!available) {
    state.playerReason = 'public/js/player.js has not been built yet.';
    el.playerFallbackText.textContent = `Player unavailable — ${state.playerReason}`;
    el.playerRoot.dataset.state = 'unavailable';
    return;
  }

  await registerCss('/css/player.css');

  try {
    const mod = await import(url);
    const controller = await (mod.mount ?? mod.default)?.(el.playerRoot, context);
    state.player = controller || {};
    el.playerFallback?.remove();
    el.playerRoot.dataset.state = 'ready';
    bus.emit('player:ready', state.player);
  } catch (err) {
    console.error('[shell] player module failed to start', err);
    state.playerReason = err?.message || String(err);
    el.playerFallbackText.textContent = `Player failed to start — ${state.playerReason}`;
    el.playerRoot.dataset.state = 'error';
  }
}

/* ========================================================================== *
 * Screen context
 * ========================================================================== */

/** @type {Array<() => void>} */
let screenCleanups = [];

/**
 * @param {*} route
 * @param {{scoped?: boolean}} [opts]  scoped:false for long-lived consumers such as the
 *                                     player, whose subscriptions must outlive a screen.
 */
function buildContext(route, opts = {}) {
  const scoped = opts.scoped !== false;
  // Subscriptions a screen makes through ctx are released for it on unmount.
  const track = scoped ? (off) => { screenCleanups.push(off); return off; } : (off) => off;

  return {
    api,
    bus: {
      on: (event, fn) => track(bus.on(event, fn)),
      once: (event, fn) => track(bus.once(event, fn)),
      off: bus.off,
      emit: bus.emit,
    },
    route,
    navigate: (to, opts) => router.navigate(to, opts),
    reload: () => router.reload(),

    get health() { return state.health; },
    onHealth: (fn) => track(onHealth(fn)),
    refreshHealth,

    get player() { return state.player; },
    get playerUnavailableReason() { return state.player ? '' : state.playerReason; },

    toast,
    setTitle,
    headerSlot: el.topbarActions,
    registerCss,
    storage,
    icon,
    iconMarkup,
  };
}

/* ========================================================================== *
 * Router wiring
 * ========================================================================== */

const ROUTES = [
  { name: 'create',   path: '/create',   load: () => import('./screens/create.js') },
  { name: 'studio',   path: '/studio',   load: () => import('./screens/studio.js') },
  { name: 'library',  path: '/library',  load: () => import('./screens/library.js') },
  { name: 'lyrics',   path: '/lyrics',   load: () => import('./screens/lyrics.js') },
  { name: 'covers',   path: '/covers',   load: () => import('./screens/covers.js') },
  { name: 'settings', path: '/settings', load: () => import('./screens/settings.js') },
];

const FALLBACK_TITLES = {
  create: 'Create', studio: 'Studio', library: 'Library',
  lyrics: 'Lyrics', covers: 'Covers', settings: 'Settings',
};

const router = createRouter({
  outlet: el.screen,
  routes: ROUTES,
  fallback: 'create',
  createContext: buildContext,

  async onBeforeMount(mod, route) {
    // Release the previous screen's ctx subscriptions and reset shared chrome.
    for (const off of screenCleanups) { try { off(); } catch { /* noop */ } }
    screenCleanups = [];
    el.topbarActions.replaceChildren();

    setActiveNav(route.name);
    setTitle(mod?.meta?.title || FALLBACK_TITLES[route.name] || 'MaxMusic', mod?.meta?.subtitle || '');

    const href = mod?.meta?.css ?? `/css/screens/${route.name}.css`;
    if (href) await registerCss(href);
  },

  onRouteChange(route) {
    setActiveNav(route.name);
  },

  onError(err) {
    if (err?.name === 'AbortError') return;
    toast(api.errorText(err), { kind: 'error', title: 'Screen error' });
  },
});

/* ========================================================================== *
 * Boot
 * ========================================================================== */

function wireGlobalErrors() {
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    if (err?.name === 'AbortError') return;
    console.error('[shell] unhandled rejection', err);
    toast(api.errorText(err), { kind: 'error', title: 'Something failed' });
  });
}

function wirePlayerFallbackRequests() {
  // A screen can always ask for playback. If the player lane has not shipped
  // yet, say so rather than dropping the request on the floor.
  bus.on('player:play', () => {
    if (state.player) return;
    toast(
      state.playerReason
        ? `Player unavailable — ${state.playerReason}`
        : 'Player unavailable.',
      { kind: 'warn', title: 'Cannot play' },
    );
  });
}

function boot() {
  document.documentElement.dataset.shell = 'ready';

  wireChrome();
  wireGlobalErrors();
  wirePlayerFallbackRequests();
  startHealthPolling();

  router.start();
  bootPlayer(buildContext(
    router.current() || { name: 'shell', path: '/', query: {}, href: '#/' },
    { scoped: false },
  ));

  // Debug handle. Not an API — screens use ctx.
  window.MaxMusic = {
    api, bus, router, toast, storage, registerCss, refreshHealth, icon, iconMarkup,
    get health() { return state.health; },
    get player() { return state.player; },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
