/**
 * MaxMusic — hash router.
 *
 * No dependencies. Owns one outlet element and the mount/unmount lifecycle of
 * screen modules. Screens are loaded lazily and cached; a module is imported at
 * most once per session.
 *
 * Hash shape:  #/library?track=ab12&tab=songs
 *              ^route     ^query -> route.query
 *
 * @module router
 */

/**
 * @typedef {Object} RouteDef
 * @property {string} name                        Route id, also the nav `data-route`.
 * @property {string} path                        Leading-slash path, e.g. `/create`.
 * @property {() => Promise<*>} load              Dynamic import of the screen module.
 *
 * @typedef {Object} Route
 * @property {string} name
 * @property {string} path
 * @property {Record<string,string>} query        Parsed search params.
 * @property {string} href                        Full hash, e.g. `#/library?track=1`.
 */

/**
 * @param {Object} cfg
 * @param {HTMLElement} cfg.outlet                        Element screens are mounted into.
 * @param {RouteDef[]} cfg.routes
 * @param {string} [cfg.fallback]                         Route name for unknown hashes.
 * @param {(route: Route) => *} cfg.createContext         Builds the `ctx` handed to mount().
 * @param {(module: *, route: Route) => (void|Promise<void>)} [cfg.onBeforeMount]
 * @param {(route: Route, module: *) => void} [cfg.onRouteChange]
 * @param {(err: *, route: Route) => void} [cfg.onError]
 */
export function createRouter(cfg) {
  const {
    outlet,
    routes,
    fallback = routes[0]?.name,
    createContext,
    onBeforeMount,
    onRouteChange,
    onError,
  } = cfg;

  const byName = new Map(routes.map((r) => [r.name, r]));
  const byPath = new Map(routes.map((r) => [r.path, r]));
  /** @type {Map<string, *>} */
  const moduleCache = new Map();

  /** @type {?Route} */
  let current = null;
  /** @type {?(() => void)} */
  let teardown = null;
  let token = 0;
  let started = false;

  /* ---------------------------------------------------------------- parse */

  function parse(hash) {
    let raw = String(hash || '').replace(/^#/, '').trim();
    if (!raw || raw === '/') raw = routeToPath(fallback);
    if (!raw.startsWith('/')) raw = `/${raw}`;

    const [pathPart, queryPart = ''] = raw.split('?');
    const path = pathPart.replace(/\/+$/, '') || '/';
    const def = byPath.get(path) || byName.get(fallback);
    const query = Object.fromEntries(new URLSearchParams(queryPart));

    return {
      name: def?.name ?? fallback,
      path: def?.path ?? path,
      query,
      href: `#${def?.path ?? path}${queryPart ? `?${queryPart}` : ''}`,
      matched: Boolean(byPath.get(path)),
    };
  }

  function routeToPath(name) {
    return byName.get(name)?.path || '/';
  }

  /* --------------------------------------------------------------- render */

  /**
   * An honest failure, in customer language, with the real reason kept as
   * secondary detail rather than as the headline. This is an error state, so
   * technical text is allowed here — it never appears in a working frame.
   */
  function renderLoadError(err, route) {
    const message = err?.message || String(err);
    outlet.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML = `
      <span class="empty__icon">
        <svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>
      </span>
      <h2 class="empty__title">This page didn’t load</h2>
      <p class="empty__text">Something went wrong opening ${route.name}. Try again — if it keeps happening, reload MaxMusic.</p>
      <p class="empty__text"><code class="code" data-reason></code></p>
      <button class="btn btn--sm" type="button" data-retry>
        <svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg>Try again
      </button>`;
    wrap.querySelector('[data-reason]').textContent = message;
    wrap.querySelector('[data-retry]').addEventListener('click', () => reload());
    outlet.append(wrap);
  }

  async function unmountCurrent() {
    if (teardown) {
      try { teardown(); } catch (err) { console.error('[router] teardown failed', err); }
    }
    teardown = null;
    outlet.replaceChildren();
    outlet.scrollTop = 0;
  }

  async function mount(route) {
    const mine = ++token;
    const def = byName.get(route.name);
    if (!def) return;

    await unmountCurrent();
    current = route;

    let mod = moduleCache.get(def.name);
    if (!mod) {
      try {
        mod = await def.load();
        moduleCache.set(def.name, mod);
      } catch (err) {
        if (mine !== token) return;
        console.error(`[router] could not import screen "${def.name}"`, err);
        onError?.(err, route);
        renderLoadError(err, route);
        onRouteChange?.(route, null);
        return;
      }
    }
    if (mine !== token) return;

    try {
      await onBeforeMount?.(mod, route);
      if (mine !== token) return;

      const ctx = createContext(route);
      const result = await mod.mount?.(outlet, ctx);
      if (mine !== token) {
        // The user navigated away while this screen was mounting — undo it.
        if (typeof result === 'function') result();
        else mod.unmount?.();
        return;
      }
      teardown = typeof result === 'function'
        ? result
        : (typeof mod.unmount === 'function' ? () => mod.unmount() : null);
      onRouteChange?.(route, mod);
    } catch (err) {
      if (mine !== token) return;
      console.error(`[router] screen "${def.name}" threw during mount`, err);
      onError?.(err, route);
      renderLoadError(err, route);
      onRouteChange?.(route, mod);
    }
  }

  /* ------------------------------------------------------------- handlers */

  function onHashChange() {
    const next = parse(location.hash);
    if (!next.matched) {
      // Unknown hash — rewrite to the fallback rather than rendering nothing.
      location.replace(`#${routeToPath(fallback)}`);
      return;
    }
    if (current && current.href === next.href) return;
    mount(next);
  }

  /* ---------------------------------------------------------------- api   */

  /** Begin routing. Normalises an empty/unknown hash first. */
  function start() {
    if (started) return;
    started = true;
    window.addEventListener('hashchange', onHashChange);
    const first = parse(location.hash);
    if (`#${location.hash.replace(/^#/, '')}` !== first.href) {
      history.replaceState(null, '', first.href);
    }
    mount(first);
  }

  /** Stop listening and unmount whatever is on screen. */
  function stop() {
    if (!started) return;
    started = false;
    window.removeEventListener('hashchange', onHashChange);
    token++;
    unmountCurrent();
    current = null;
  }

  /**
   * Go to a route.
   * @param {string} to  `create`, `/create`, `#/create` or `/library?track=1`.
   * @param {{replace?: boolean, query?: Record<string,string|number>}} [opts]
   */
  function navigate(to, opts = {}) {
    let target = String(to).replace(/^#/, '');
    if (!target.startsWith('/')) target = routeToPath(target) || `/${target}`;
    if (opts.query && Object.keys(opts.query).length) {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(opts.query).map(([k, v]) => [k, String(v)])),
      ).toString();
      target += (target.includes('?') ? '&' : '?') + qs;
    }
    const href = `#${target}`;
    if (location.hash === href) return;
    if (opts.replace) {
      history.replaceState(null, '', href);
      onHashChange();
    } else {
      location.hash = href;
    }
  }

  /** Re-run mount for the current route (drops the module cache entry). */
  function reload() {
    if (!current) return;
    moduleCache.delete(current.name);
    mount(parse(location.hash));
  }

  /** @returns {?Route} */
  function currentRoute() {
    return current;
  }

  return { start, stop, navigate, reload, current: currentRoute, parse, routes };
}
