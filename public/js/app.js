/**
 * MaxMusic — application shell.
 *
 * Owns the frame (rail, topbar, screen outlet, player slot), the router, the
 * workspace anchor, toasts, overflow menus, the sticky-footer guarantee, the
 * cross-screen event bus and the context object every screen receives.
 *
 * Connection state is deliberately NOT part of the resting UI. It surfaces as
 * a transient toast when the connection actually changes, and as detail on the
 * Settings screen. The machine does not get published to the customer.
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
  workspaceBtn: document.getElementById('workspace-btn'),
  workspaceAvatar: document.getElementById('workspace-avatar'),
  workspaceName: document.getElementById('workspace-name'),
  workspaceMeta: document.getElementById('workspace-meta'),
  workspaceRename: document.getElementById('workspace-rename'),
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
 * Severity is stated as a LABELLED CHIP inside the toast. It used to be a 2px
 * coloured bar down the left edge — one of the two banned patterns (SPEC §9b).
 * Only the two kinds that report a real problem get a chip; success and info
 * are carried by the glyph and the words.
 */
const TOAST_SEVERITY = { warn: 'Warning', error: 'Error' };

/** Live toasts that were given a `key`, so a repeat replaces rather than stacks. */
const keyedToasts = new Map();

/**
 * @param {string} message               Shown verbatim; newlines preserved.
 * @param {{kind?: 'info'|'success'|'warn'|'error', title?: string, timeout?: number,
 *          key?: string,
 *          action?: {label: string, onClick: () => void},
 *          actions?: Array<{label: string, onClick: () => void}>}} [opts]
 * @returns {() => void} dismiss
 */
export function toast(message, opts = {}) {
  const { kind = 'info', title = '', timeout = kind === 'error' ? 9000 : 5000, key } = opts;
  const actions = [opts.action, ...(opts.actions || [])].filter((a) => a && a.label);

  // One live toast per key — a flapping connection must not build a wall.
  if (key && keyedToasts.has(key)) keyedToasts.get(key)();

  const severity = TOAST_SEVERITY[kind] || '';

  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.innerHTML = `
    <span class="toast__icon">${iconMarkup(TOAST_ICON[kind] || 'info')}</span>
    <div class="toast__body">
      ${title || severity ? `<div class="toast__head">
        ${title ? '<p class="toast__title"></p>' : ''}
        ${severity ? `<span class="sev sev--${kind}"></span>` : ''}
      </div>` : ''}
      <p class="toast__msg"></p>
    </div>
    <button class="toast__close" type="button" aria-label="Dismiss">${iconMarkup('close')}</button>`;

  if (title) node.querySelector('.toast__title').textContent = title;
  if (severity) node.querySelector('.sev').textContent = severity;
  node.querySelector('.toast__msg').textContent = String(message);

  let timer = null;
  const dismiss = () => {
    if (key && keyedToasts.get(key) === dismiss) keyedToasts.delete(key);
    if (!node.isConnected) return;
    clearTimeout(timer);
    node.setAttribute('data-leaving', '');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  node.querySelector('.toast__close').addEventListener('click', dismiss);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'toast__actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn btn--sm';
      btn.type = 'button';
      btn.textContent = a.label;
      btn.addEventListener('click', () => { a.onClick?.(); dismiss(); });
      row.append(btn);
    }
    node.querySelector('.toast__body').append(row);
  }

  el.toasts.append(node);
  if (key) keyedToasts.set(key, dismiss);
  if (timeout > 0) timer = setTimeout(dismiss, timeout);
  return dismiss;
}

/* ========================================================================== *
 * Connection state
 *
 * There is no connection card, chip or dot in the resting UI. A working app is
 * silent about its wiring; a broken one says so once, in the customer's words,
 * and gets out of the way. Diagnostics — provider names, hosts, model keys —
 * live on the Settings screen, which reads them from `ctx.health`.
 * ========================================================================== */

const HEALTH_INTERVAL = 30_000;
const CONNECTION_TOAST = 'shell:connection';

const state = {
  /** @type {?import('./api.js').Health} */
  health: null,
  /** @type {?import('./api.js').OpenAIAuth} */
  auth: null,
  /** @type {?Object} */
  player: null,
  playerReason: '',
};

let healthTimer = null;
let healthInFlight = null;
let authInFlight = null;
/** Status the customer was last told about, so we speak only on a real change. */
let announcedStatus = null;

const CONNECTION_COPY = {
  offline: {
    kind: 'error',
    title: 'Not connected',
    message: 'MaxMusic can’t reach your studio right now. Nothing has been lost — this will clear as soon as it answers.',
  },
  degraded: {
    kind: 'warn',
    title: 'Not ready to render',
    message: 'Your studio answered but isn’t ready to render yet. New tracks will fail until it finishes starting up.',
  },
};

function announceConnection(snapshot) {
  const status = snapshot.status;
  if (status === announcedStatus) return;

  // Coming back is worth one quiet line, but only for someone who saw it break.
  if (status === 'online') {
    if (announcedStatus && announcedStatus !== 'online') {
      toast('Your studio is back. You can keep rendering.', {
        kind: 'success', title: 'Reconnected', key: CONNECTION_TOAST, timeout: 4000,
      });
    }
    announcedStatus = status;
    return;
  }

  const copy = CONNECTION_COPY[status] || CONNECTION_COPY.offline;
  toast(copy.message, {
    kind: copy.kind,
    title: copy.title,
    key: CONNECTION_TOAST,
    timeout: 12_000,
    actions: [
      { label: 'Try again', onClick: () => refreshHealth() },
      { label: 'Details', onClick: () => router.navigate('settings') },
    ],
  });
  announcedStatus = status;
}

/**
 * Re-check `/api/health` and notify subscribers.
 * @returns {Promise<import('./api.js').Health>}
 */
export function refreshHealth() {
  if (healthInFlight) return healthInFlight;

  healthInFlight = api.health()
    .then((snapshot) => {
      state.health = snapshot;
      bus.emit('health', snapshot);
      announceConnection(snapshot);
      return snapshot;
    })
    .finally(() => { healthInFlight = null; });

  return healthInFlight;
}

/**
 * Re-read the OpenAI account state and notify subscribers.
 *
 * Kept separate from health on purpose: `/api/health` describes how the backend
 * routes lyrics and cover art, this describes whether the account behind them is
 * signed in, and neither answers the other's question.
 *
 * @returns {Promise<import('./api.js').OpenAIAuth>}
 */
export function refreshAuth() {
  if (authInFlight) return authInFlight;

  authInFlight = api.openaiStatus()
    .then((snapshot) => {
      state.auth = snapshot;
      bus.emit('auth', snapshot);
      return snapshot;
    })
    .finally(() => { authInFlight = null; });

  return authInFlight;
}

/**
 * Subscribe to account snapshots. Fires immediately when one already exists.
 * @param {(a: import('./api.js').OpenAIAuth) => void} fn
 * @returns {() => void} unsubscribe
 */
function onAuth(fn) {
  const off = bus.on('auth', fn);
  if (state.auth) { try { fn(state.auth); } catch (err) { console.error(err); } }
  return off;
}

function startHealthPolling() {
  refreshHealth();
  refreshAuth();
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
 * Overflow menus — the shared primitive for secondary and destructive actions
 *
 * Every screen gets the same menu: same geometry, same keyboard behaviour, and
 * one destructive treatment that only exists in here. Delete never sits inline
 * next to Play again.
 *
 * The list is positioned in viewport coordinates and mounted on <body> while
 * open, so a scrolling row, an `overflow: hidden` panel or a backdrop-filtered
 * footer cannot clip it.
 * ========================================================================== */

/** @type {?{close: () => void}} */
let liveMenu = null;

/**
 * @typedef {Object} MenuItem
 * @property {string}   [label]
 * @property {string}   [icon]        Sprite name, e.g. `trash`.
 * @property {string}   [note]        Right-aligned secondary text (a shortcut, a count).
 * @property {boolean}  [danger]      Destructive. This is the ONLY destructive treatment.
 * @property {boolean}  [disabled]
 * @property {string}   [href]        Renders an anchor instead of a button.
 * @property {() => void} [onSelect]
 * @property {boolean}  [separator]   A rule. No other keys needed.
 * @property {boolean}  [heading]     A small caps section label; use with `label`.
 */

/**
 * Wire an existing element as a menu trigger.
 *
 * @param {HTMLElement} trigger
 * @param {{items: MenuItem[] | (() => MenuItem[]), align?: 'start'|'end', label?: string}} config
 * @returns {{open: () => void, close: () => void, toggle: () => void, destroy: () => void}}
 */
export function attachMenu(trigger, config = {}) {
  const list = document.createElement('div');
  list.className = 'menu__list';
  list.setAttribute('role', 'menu');
  list.hidden = true;

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  if (config.label && !trigger.getAttribute('aria-label')) trigger.setAttribute('aria-label', config.label);

  const resolveItems = () => {
    const raw = typeof config.items === 'function' ? config.items() : config.items;
    return Array.isArray(raw) ? raw.filter(Boolean) : [];
  };

  function build() {
    list.replaceChildren();
    for (const item of resolveItems()) {
      if (item.separator) {
        const hr = document.createElement('hr');
        hr.className = 'menu__sep';
        list.append(hr);
        continue;
      }
      if (item.heading) {
        const h = document.createElement('p');
        h.className = 'menu__label';
        h.textContent = item.label || '';
        list.append(h);
        continue;
      }
      const node = document.createElement(item.href ? 'a' : 'button');
      node.className = `menu__item${item.danger ? ' menu__item--danger' : ''}`;
      node.setAttribute('role', 'menuitem');
      if (item.href) node.href = item.href;
      else node.type = 'button';
      if (item.disabled) {
        node.disabled = true;
        node.setAttribute('aria-disabled', 'true');
      }
      if (item.icon) node.append(icon(item.icon));
      const label = document.createElement('span');
      label.textContent = item.label || '';
      node.append(label);
      if (item.note) {
        const note = document.createElement('span');
        note.className = 'menu__item__note';
        note.textContent = item.note;
        node.append(note);
      }
      node.addEventListener('click', () => {
        if (item.disabled) return;
        close();
        // After close(), so an item that moves focus (rename, a field) wins.
        Promise.resolve().then(() => { try { item.onSelect?.(); } catch (err) { console.error(err); } });
      });
      list.append(node);
    }
  }

  function place() {
    const r = trigger.getBoundingClientRect();
    const gap = 6;
    const edge = 8;
    const w = list.offsetWidth;
    const h = list.offsetHeight;

    let left = config.align === 'start' ? r.left : r.right - w;
    left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - w - edge));

    let top = r.bottom + gap;
    if (top + h > window.innerHeight - edge) {
      const above = r.top - gap - h;
      top = above >= edge ? above : Math.max(edge, window.innerHeight - h - edge);
    }
    list.style.left = `${Math.round(left)}px`;
    list.style.top = `${Math.round(top)}px`;
  }

  function onDocPointer(e) {
    if (list.contains(e.target) || trigger.contains(e.target)) return;
    close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const focusable = Array.from(list.querySelectorAll('.menu__item:not([disabled])'));
    if (!focusable.length) return;
    const at = focusable.indexOf(document.activeElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % focusable.length;
    else if (e.key === 'ArrowUp') next = at < 0 ? focusable.length - 1 : (at - 1 + focusable.length) % focusable.length;
    else if (e.key === 'End') next = focusable.length - 1;
    focusable[next].focus();
  }

  // A menu opened inside a scrolling list must not be killed by the scroll that
  // brought its trigger into view. Ignore scroll for a beat, then behave.
  let openedAt = 0;
  const onScroll = () => { if (Date.now() - openedAt > 220) close(); };

  function open() {
    if (!list.hidden) return;
    liveMenu?.close();
    build();
    if (!list.childElementCount) return;
    document.body.append(list);
    list.style.visibility = 'hidden';
    list.hidden = false;
    place();
    list.style.visibility = '';
    trigger.setAttribute('aria-expanded', 'true');
    liveMenu = { close };
    openedAt = Date.now();

    // Deferred so the click that opened the menu does not immediately close it.
    setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);
    list.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    list.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (liveMenu?.close === close) liveMenu = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    list.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  const toggle = () => (list.hidden ? open() : close());
  const onTriggerClick = (e) => { e.preventDefault(); toggle(); };
  const onTriggerKey = (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    open();
    list.querySelector('.menu__item:not([disabled])')?.focus();
  };

  trigger.addEventListener('click', onTriggerClick);
  trigger.addEventListener('keydown', onTriggerKey);

  return {
    open,
    close,
    toggle,
    destroy() {
      close();
      trigger.removeEventListener('click', onTriggerClick);
      trigger.removeEventListener('keydown', onTriggerKey);
    },
  };
}

/**
 * Build a ready-made `…` overflow menu: a compliant 34px chip plus its list.
 *
 * @param {{items: MenuItem[] | (() => MenuItem[]), align?: 'start'|'end',
 *          label?: string, icon?: string, className?: string}} config
 * @returns {HTMLElement} The `.menu` wrapper. Its controller is on `.menuController`.
 */
export function menu(config = {}) {
  const wrap = document.createElement('div');
  wrap.className = `menu${config.className ? ` ${config.className}` : ''}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'actionchip menu__trigger';
  trigger.setAttribute('aria-label', config.label || 'More actions');
  trigger.append(icon(config.icon || 'more'));

  wrap.append(trigger);
  wrap.menuController = attachMenu(trigger, config);
  return wrap;
}

/* ========================================================================== *
 * Sticky-footer guarantee (.dock)
 *
 * Round 1 sliced cards and primary buttons in half under overlaid action bars.
 * A `.dock` whose footer is a flex sibling cannot overlap at all; a
 * `.dock--overlay` gets its scroller padded by the footer's measured height,
 * kept live by a ResizeObserver. Screens do not have to remember to call this
 * — the shell scans every mount and watches the outlet for new ones.
 * ========================================================================== */

const dockSeen = new WeakSet();
let dockResize = null;

function measureDock(foot) {
  const dock = foot.closest('.dock');
  if (!dock) return;
  dock.style.setProperty('--dock-foot-h', `${Math.ceil(foot.getBoundingClientRect().height)}px`);
}

/**
 * Start maintaining `--dock-foot-h` for every `.dock` inside `root`.
 * Idempotent — calling it again is free.
 *
 * @param {HTMLElement|Document} [root]
 * @returns {number} how many docks are being maintained after this call
 */
export function registerDock(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  if (!dockResize && typeof ResizeObserver !== 'undefined') {
    dockResize = new ResizeObserver((entries) => { for (const e of entries) measureDock(e.target); });
  }
  const docks = [];
  if (root.matches?.('.dock')) docks.push(root);
  docks.push(...root.querySelectorAll('.dock'));

  for (const dock of docks) {
    const foot = dock.querySelector(':scope > .dock__foot');
    if (!foot) continue;
    measureDock(foot);
    if (dockSeen.has(foot)) continue;
    dockSeen.add(foot);
    dockResize?.observe(foot);
  }
  return docks.length;
}

let dockScanQueued = false;
function queueDockScan() {
  if (dockScanQueued) return;
  dockScanQueued = true;
  requestAnimationFrame(() => { dockScanQueued = false; registerDock(el.screen); });
}

/* ========================================================================== *
 * Accent discipline — a lint, so the restrained path stays the easy one
 * ========================================================================== */

function lintAccents() {
  const loud = document.querySelectorAll(
    '.btn--primary:not([hidden]):not(:disabled):not([aria-disabled="true"])',
  );
  if (loud.length > 1) {
    console.warn(
      `[shell] accent discipline: ${loud.length} .btn--primary are visible at once. ` +
      'The solid accent is one primary action per view. ' +
      'Use .btn--strong for a second emphatic action.',
    );
  }
}

/* ========================================================================== *
 * Chrome: nav rail, topbar, workspace anchor
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

/* ------------------------------------------------------ workspace anchor -- */
/* The bottom of the rail is the frame's most valuable slot. It carries who you
   are and the one action this product exists for — never a status readout.

   Round 2 put a derived song count on the second line and it contradicted
   itself inside one session: "Local workspace" on Create, "No songs yet" on
   Library, because the count only arrives when the Library screen reports it
   and every other screen fell back to different copy. An anchor that changes
   its mind is worse than one that says less.

   So the second line is now a single fact that is true on every screen, in
   every state, before anything has loaded: your songs stay on this machine.
   It is also the commercial anchor §7a asked for. The song count keeps exactly
   one home — the Library nav counter — which is where a count belongs. */

const WORKSPACE_FALLBACK = 'My Studio';
/** One line, one meaning, true everywhere. Not derived, so it cannot disagree. */
const WORKSPACE_META = 'Private to this computer';

/** @type {?number} null until the library reports; never guessed. Nav badge only. */
let songCount = null;

function workspaceName() {
  const stored = String(storage.get('workspace.name', '') || '').trim();
  return stored || WORKSPACE_FALLBACK;
}

function paintWorkspace() {
  const name = workspaceName();
  el.workspaceName.textContent = name;
  el.workspaceAvatar.textContent = name.slice(0, 1);
  el.workspaceMeta.textContent = WORKSPACE_META;
  el.workspaceBtn.title = `${name} — ${WORKSPACE_META}`;
}

function beginRename() {
  if (el.app.dataset.rail === 'collapsed') setRailCollapsed(false);
  const input = el.workspaceRename;
  input.value = workspaceName();
  input.hidden = false;
  el.workspaceBtn.style.visibility = 'hidden';
  input.focus();
  input.select();
}

function endRename(commit) {
  const input = el.workspaceRename;
  if (input.hidden) return;
  if (commit) storage.set('workspace.name', input.value.trim().slice(0, 28));
  input.hidden = true;
  el.workspaceBtn.style.visibility = '';
  paintWorkspace();
  if (commit) el.workspaceBtn.focus({ preventScroll: true });
}

function wireWorkspace() {
  paintWorkspace();

  attachMenu(el.workspaceBtn, {
    align: 'start',
    items: () => [
      { label: workspaceName(), heading: true },
      { label: 'Rename workspace', icon: 'pencil', onSelect: beginRename },
      { label: 'Settings', icon: 'settings', onSelect: () => router.navigate('settings') },
    ],
  });

  el.workspaceRename.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
  });
  el.workspaceRename.addEventListener('blur', () => endRename(true));
}

function wireChrome() {
  setRailCollapsed(Boolean(storage.get('rail.collapsed', false)));
  setDrawer(false);
  wireWorkspace();

  el.railToggle?.addEventListener('click', () => {
    setRailCollapsed(el.app.dataset.rail !== 'collapsed');
  });
  el.navOpen?.addEventListener('click', () => setDrawer(el.app.dataset.nav !== 'open'));
  el.railScrim?.addEventListener('click', () => setDrawer(false));
  el.rail?.addEventListener('click', (e) => {
    if (e.target.closest('.navitem, .brand, .railfoot__cta')) setDrawer(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.app.dataset.nav === 'open') setDrawer(false);
  });

  // The song count has one home: the Library nav counter. It deliberately does
  // not also appear under the workspace name — see the anchor note above.
  bus.on('library:changed', (payload) => {
    const count = Number(payload?.count);
    songCount = Number.isFinite(count) && count >= 0 ? count : null;

    if (!songCount) {
      el.libraryCount.hidden = true;
      el.libraryCount.textContent = '';
    } else {
      el.libraryCount.hidden = false;
      el.libraryCount.textContent = songCount > 999 ? '999+' : String(songCount);
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

  // The resting bar never names a file, a module or a stack trace. The real
  // reason stays on ctx.playerUnavailableReason and in the console.
  if (!available) {
    state.playerReason = 'The player did not load in this session.';
    el.playerFallbackText.textContent = 'Playback is unavailable — reload the page to try again.';
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
    el.playerFallbackText.textContent = 'Playback is unavailable — reload the page to try again.';
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

    /* The authority on whether the OpenAI account is signed in. Screens gate
       lyrics and artwork on `ctx.auth.ready`, never on health.lyricsEnabled or
       health.coverArtEnabled — those report configured routing, and signing in
       is not expected to change them. */
    get auth() { return state.auth; },
    onAuth: (fn) => track(onAuth(fn)),
    refreshAuth,

    get player() { return state.player; },
    get playerUnavailableReason() { return state.player ? '' : state.playerReason; },

    toast,
    setTitle,
    headerSlot: el.topbarActions,
    registerCss,
    storage,
    icon,
    iconMarkup,

    // Shared primitives — see docs/CONTRACT.md §6.
    menu,
    attachMenu: (trigger, config) => {
      const controller = attachMenu(trigger, config);
      track(() => controller.destroy());
      return controller;
    },
    registerDock,
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
  { name: 'art',      path: '/art',      load: () => import('./screens/art.js') },
  { name: 'settings', path: '/settings', load: () => import('./screens/settings.js') },
];

const FALLBACK_TITLES = {
  create: 'Create', studio: 'Studio', library: 'Library',
  lyrics: 'Lyrics', art: 'Art', settings: 'Settings',
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
    liveMenu?.close();
    el.topbarActions.replaceChildren();

    setActiveNav(route.name);
    setTitle(mod?.meta?.title || FALLBACK_TITLES[route.name] || 'MaxMusic', mod?.meta?.subtitle || '');

    const href = mod?.meta?.css ?? `/css/screens/${route.name}.css`;
    if (href) await registerCss(href);
  },

  onRouteChange(route) {
    setActiveNav(route.name);
    // Sticky footers are measured and accents counted once the screen settles.
    requestAnimationFrame(() => {
      registerDock(el.screen);
      lintAccents();
    });
  },

  onError(err) {
    if (err?.name === 'AbortError') return;
    toast(api.errorText(err), { kind: 'error', title: 'This page didn’t load' });
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
  // yet, say so rather than dropping the request on the floor — but say it in
  // the customer's language, not the module loader's.
  bus.on('player:play', () => {
    if (state.player) return;
    toast('Reload the page and try again.', { kind: 'warn', title: 'Playback is unavailable' });
  });
}

function boot() {
  document.documentElement.dataset.shell = 'ready';

  wireChrome();
  wireGlobalErrors();
  wirePlayerFallbackRequests();
  startHealthPolling();

  // Any sticky footer a screen renders, now or later, gets its scroll padding.
  new MutationObserver(queueDockScan).observe(el.screen, { childList: true, subtree: true });

  router.start();
  bootPlayer(buildContext(
    router.current() || { name: 'shell', path: '/', query: {}, href: '#/' },
    { scoped: false },
  ));

  // Debug handle. Not an API — screens use ctx.
  window.MaxMusic = {
    api, bus, router, toast, storage, registerCss, refreshHealth, refreshAuth, icon, iconMarkup,
    menu, attachMenu, registerDock,
    get health() { return state.health; },
    get auth() { return state.auth; },
    get player() { return state.player; },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
