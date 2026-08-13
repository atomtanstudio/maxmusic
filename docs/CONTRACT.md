# MaxMusic — shell contract

Everything a screen builder needs. `docs/SPEC.md` says *what* to build; this file says
*how to plug it in*. If something you need is not here, ask the shell lane — do not edit
`public/index.html`, `public/css/tokens.css`, `public/css/shell.css`, `public/js/app.js`,
`public/js/router.js` or `public/js/api.js`.

Run: `node server.js` → <http://localhost:3020>. `/api`, `/tracks`, `/covers`, `/uploads`
are proxied to the backend on 3010. No build step, no frameworks, no CDN. Everything must
work offline, so never reference an external host — no fonts, no scripts, no images.

---

## 1. Screen module interface

One file per screen, an ES module at `public/js/screens/<name>.js`.

```js
export const meta = {
  title: 'Create',                    // topbar h1 + document.title
  subtitle: 'One idea in, one song out', // optional line beside the title
  css: '/css/screens/create.css',     // optional; defaults to /css/screens/<route>.css
};

/**
 * @param {HTMLElement} root  Empty container. Append to it; do not replace it.
 * @param {Ctx} ctx           See §2.
 * @returns {void | (() => void) | Promise<void | (() => void)>}
 *          Return a function to be used as the teardown.
 */
export async function mount(root, ctx) { /* … */ }

/** Optional. Used only when mount() did not return a teardown function. */
export function unmount() { /* … */ }
```

Lifecycle guarantees from the router:

- `root` is emptied and its scroll reset before every `mount`.
- `meta.css` is loaded and applied **before** `mount` runs.
- The topbar title/subtitle and the nav highlight are set before `mount` runs.
- `ctx.headerSlot` is emptied before every `mount`.
- Subscriptions made through `ctx.bus.on` / `ctx.onHealth` are released for you on unmount.
  Anything else you attach (timers, `window` listeners, `AbortController`s, `<audio>`
  elements) is yours to clean up in the teardown.
- If `mount` throws or the module fails to import, the router renders an honest error
  panel with the real message and a Retry button. Do not swallow errors to avoid it.
- A module is imported once per session and cached. `ctx.reload()` drops the cache entry
  and remounts.

`root` lives inside `#screen`, which is the scroll container
(`height: 100% − topbar − player; overflow-y: auto`). For a full-height two-column screen,
make your own wrapper `height: 100%; overflow: hidden` and scroll the columns internally.

### Routes

| Route | Hash | Module | CSS |
|---|---|---|---|
| create | `#/create` | `screens/create.js` | `css/screens/create.css` |
| studio | `#/studio` | `screens/studio.js` | `css/screens/studio.css` |
| library | `#/library` | `screens/library.js` | `css/screens/library.css` |
| lyrics | `#/lyrics` | `screens/lyrics.js` | `css/screens/lyrics.css` |
| covers | `#/covers` | `screens/covers.js` | `css/screens/covers.css` |
| settings | `#/settings` | `screens/settings.js` | `css/screens/settings.css` |

Query strings are supported and parsed for you: `#/library?track=ab12` →
`ctx.route.query.track === 'ab12'`. Unknown hashes are rewritten to `#/create`.

---

## 2. `ctx` — everything a screen is given

| Member | Type | Notes |
|---|---|---|
| `ctx.api` | module | The whole of `api.js` (§5). The only way to talk to the backend. |
| `ctx.route` | `{name, path, query, href}` | The route being mounted. |
| `ctx.navigate(to, opts?)` | fn | `'library'`, `'/library'`, `'#/library'`. `opts = {replace?, query?}`. |
| `ctx.reload()` | fn | Re-import and remount the current screen. |
| `ctx.bus` | `{on, once, off, emit}` | §3. `on`/`once` auto-unsubscribe on unmount. |
| `ctx.health` | `Health \| null` | Latest `/api/health` snapshot; `null` before the first check. |
| `ctx.onHealth(fn)` | fn → unsubscribe | Fires immediately if a snapshot exists, then on every change. |
| `ctx.refreshHealth()` | `() => Promise<Health>` | Force a re-check (de-duplicated). |
| `ctx.player` | controller \| `null` | The player lane's controller, or `null` if not loaded. |
| `ctx.playerUnavailableReason` | string | Non-empty only when `ctx.player` is `null`. |
| `ctx.toast(msg, opts?)` | fn → dismiss | `opts = {kind:'info'\|'success'\|'warn'\|'error', title, timeout, action:{label,onClick}}`. Text is rendered verbatim; newlines preserved. |
| `ctx.setTitle(title, sub?)` | fn | Change the topbar title after mount (e.g. when a project loads). |
| `ctx.headerSlot` | `HTMLElement` | `#topbar-actions`. Append screen-level actions here; emptied on unmount. |
| `ctx.registerCss(href)` | `Promise<boolean>` | Load an extra stylesheet once (§4). |
| `ctx.storage` | `{get,set,remove}` | JSON localStorage under the `maxmusic:` prefix. |
| `ctx.icon(name, cls?)` | `SVGSVGElement` | Sprite icon as a DOM node. |
| `ctx.iconMarkup(name, cls?)` | string | Same icon as a markup string for template literals. |

`window.MaxMusic` exists for console debugging only. Never import `app.js` and never
reach for `window.MaxMusic` in shipped screen code — use `ctx`.

---

## 3. Bus events — the cross-lane contract

Emit and listen with `ctx.bus`. Payloads are plain objects.

| Event | Emitted by | Payload | Meaning |
|---|---|---|---|
| `track:new` | create, studio, covers | `{ track, meta }` | A generation finished. `track` is the backend `{id, filename, url, size}`. `meta` carries whatever the screen knows: `{title, prompt, lyrics, duration, seed, format, isInstrumental, extra_info, createdAt}`. |
| `library:changed` | library | `{ count }` | Library contents changed. The shell paints the count badge in the nav rail. |
| `player:play` | any screen | `{ track, title?, cover?, meta?, queue? }` | Request playback. **If no player is loaded the shell toasts an honest "player unavailable" message** — you do not have to check first. |
| `player:state` | player | `{ playing, track, time, duration }` | Playback state changed. |
| `player:ready` | shell | controller | The player module finished mounting. |
| `health` | shell | `Health` | New `/api/health` snapshot. Prefer `ctx.onHealth`. |

Adding an event is fine; document it here in the same table when you do.

### Player handshake (player lane)

`public/js/player.js` must export `mount(root, ctx)` (or a default function with the same
shape) where `root` is `#player-root`, the persistent bar the shell already renders. Return
a controller object; the shell stores it as `ctx.player` and emits `player:ready`. Until
that file exists, the bar shows an honest "Player unavailable" line. Optional CSS at
`public/css/player.css` is auto-loaded.

---

## 4. Registering CSS

The shell loads `meta.css` (default `/css/screens/<route>.css`) before mounting, once per
session. For anything extra:

```js
await ctx.registerCss('/css/screens/create-advanced.css'); // resolves true when applied
```

The file is probed first, so a stylesheet that does not exist yet degrades to a console
warning instead of a MIME error (the dev server answers unknown paths with `index.html`).

Rules for screen CSS:

- Scope every rule under a root class you own, e.g. `.screen-create …`. Two lanes must
  never be able to collide.
- Never restyle `.rail`, `.topbar`, `.playerbar`, `.toast` or `.status`.
- Never redefine a token in `:root`. Set a local custom property on your own root class if
  you need a variant: `.screen-create { --card-pad: var(--space-7); }`.
- Use the primitives in §6 before writing new component CSS.

---

## 5. `api.js`

Import from `ctx.api`. Every call is same-origin and relative.

**Errors.** `ApiError` carries the backend's own words: `.message` (verbatim),
`.details`, `.fullMessage` (message + details), `.status`, `.code`, `.traceId`,
`.endpoint`, `.body`. `ValidationError` carries `.issues` (string array) and is thrown
before any network call. `api.errorText(err)` turns anything into one line fit for a toast.
Show these strings — never replace them with "Something went wrong".

**Functions**

| Call | Returns |
|---|---|
| `api.health({signal, timeoutMs})` | `Promise<Health>` — never rejects; an unreachable backend is a valid answer. |
| `api.validateGeneration(input)` | `{valid, errors[], warnings[], payload}` — pure, no network. Use it to disable the submit button honestly and to show clamp warnings. |
| `api.generate(input, {signal})` | `Promise<GenerationResult>` — `POST /api/generate`. No client timeout; local runs take minutes. |
| `api.generateDual(input, {signal})` | `Promise<{ok, takes:{A,B}, errors?}>` — `POST /api/generate-dual`. |
| `api.generateStream(input, {onEvent, signal})` | `Promise<GenerationResult>` — SSE. `onEvent` sees `{status:'queued'}`, `{partial:true,…}`, `{done:true,…}`, `{error}`. |
| `api.lyrics({mode, prompt, lyrics, title}, {signal})` | `Promise<{ok, song_title, style_tags, lyrics, provider, model}>`. |
| `api.coverArt({prompt, title, mode, musicPrompt, aspect_ratio, n}, {signal})` | `Promise<{ok, cover:{id,filename,url,size,prompt}, alternatives?}>`. |
| `api.cover({file, ...fields}, {signal})` | multipart `POST /api/cover`. 501 in local-comfy mode — show the reason. |
| `api.coverPreprocess({file, audio_url}, {signal})` | multipart `POST /api/cover-preprocess`. 501 in local-comfy mode. |
| `api.upload(file, {signal, onProgress})` | `Promise<{ok, filename, size, mimetype, url}>`; `onProgress(fraction)` is real. |
| `api.mediaUrl(pathOrTrack)` | Same-origin URL for `<audio src>` / `<img src>`. |
| `api.request(path, {method, body, signal, timeoutMs})` | Escape hatch for an endpoint not wrapped above. |

**Constants** — `api.LIMITS` (`PROMPT_MAX` 2000, `LYRICS_MAX` 3500, `DURATION_MIN` 0.04,
`DURATION_MAX` 360, `DURATION_DEFAULT` 120, `SEED_MIN`, `SEED_MAX`, `SAMPLE_RATE_DEFAULT`,
`BITRATE_DEFAULT`), `api.FORMATS`, `api.BITRATES`, `api.SAMPLE_RATES`, `api.SECTION_TAGS`
(the only nine tags), `api.ASPECT_RATIOS`, `api.LYRICS_MODES`.

**`Health` snapshot** — `{ raw, status: 'online'|'degraded'|'offline', message, ok, backend,
comfyUrl, comfyReachable, comfyError, musicModels, modelKeys, lyricsProvider, lyricsEnabled,
coverArtProvider, coverArtEnabled, hasServerKey, error, checkedAt }`. `lyricsEnabled` and
`coverArtEnabled` are derived from the provider strings — use them to degrade honestly.

**Generation input** (SPEC §3a — nothing else is client-controllable):
`prompt`, `lyrics`, `is_instrumental`, `duration`, `seed`, `tiled_decode`, `more_variation`,
`model`, `audio_setting: {format, bitrate, sample_rate}`.
**Never** ship a control for guidance/cfg, flow-matching steps, or auto-lyrics
(`lyrics_optimizer`). They are server env only and the last one throws.

---

## 6. Shared primitives (`shell.css`)

Use these. They are the reason six independently built screens will look like one product.

**Buttons** `.btn` · modifiers `.btn--primary` (the brand gradient — one per view, for the
real action) `.btn--ghost` `.btn--outline` `.btn--danger` `.btn--sm` `.btn--lg`
`.btn--block` `.btn--icon` · state `.is-active` · `:disabled` is styled, so use the real
attribute. Also `.iconbtn` for a bare 32px icon button.

**Selection** `.chip` (+ `.chip--mono`, `.is-active` / `aria-pressed="true"`),
`.segment` > `.segment__item.is-active` for Simple/Advanced-style tab groups.

**Forms** `.field` (label + control + hint column), `.label` (+ `.label__hint` for a
right-aligned counter), `.input`, `.textarea` (+ `.textarea--mono`), `.select`, `.hint`
(+ `.hint--error`, `.hint--warn`), `.switch` > `input` + `.switch__track` + `.switch__label`,
`.range` (set `--range-fill: <pct>%` on the element to colour the filled portion).
`aria-invalid="true"` turns a field red.

**Containers** `.panel` > `.panel__head` (`.panel__title`) + `.panel__body`; `.card`
(+ `.card--hover`); `.divider`.

**Status** `.badge` (+ `--ok --warn --danger --info --brand`), `.notice` >
`.notice__icon` + `.notice__title` (+ `--warn --error --info`), `code.code` for inline code.

**States** `.empty` > `.empty__icon` + `.empty__title` + `.empty__text`; `.spinner`
(put it on an `.icon` using `#i-spinner`); `.skeleton`; `.brandline` (animated gradient
hairline — use it on a panel that is generating).

**Layout** `.page` (+ `.page--narrow`, `.page--flush`, `.page__lead`), `.stack`, `.row`
(+ `.row--wrap`, `.row--end`), `.spacer`, `.truncate`, `.mono`, `.gradient-text`
(one number or one word — never a paragraph), `.visually-hidden`, `.brandmark` (see §8).

---

## 7. Icons

Sprite lives in `index.html`. Use `ctx.icon('play')` or
`ctx.iconMarkup('play')`, or write it directly:

```html
<svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>
```

Available ids (drop the `i-` prefix when calling `ctx.icon`):

`i-create` `i-studio` `i-library` `i-lyrics` `i-covers` `i-settings`
`i-play` `i-pause` `i-prev` `i-next` `i-shuffle` `i-repeat` `i-volume` `i-mute`
`i-search` `i-plus` `i-close` `i-check` `i-chevron-down` `i-chevron-right` `i-chevron-left`
`i-download` `i-copy` `i-trash` `i-heart` `i-more` `i-refresh` `i-wand` `i-alert` `i-info`
`i-dice` `i-clock` `i-wave` `i-mic` `i-external` `i-lock` `i-panel` `i-menu` `i-spinner`

All are 24×24 and inherit `currentColor`. `.icon` sizes them to 18px; override `width`/
`height` on your own class when you need another size. If you need an icon that is not
here, ask the shell lane to add it — do not inline a one-off SVG with a different stroke
weight, and do not link an external icon font.

---

## 8. Design tokens (`tokens.css`)

`tokens.css` is the single source of truth for colour. Every value below is a CSS custom
property on `:root`. Use them; do not hard-code hex values, and do not redefine them.

### Brand — palette sampled from `public/logo.png`

```
--brand-cyan      #0bf3fd      --brand-cyan-deep      #06a8c4
--brand-blue      #1b7bf7      --brand-blue-deep      #1355ae
--brand-violet    #7b22e6      --brand-violet-deep    #56179f
--brand-magenta   #e927d9      --brand-magenta-deep   #a11a97
--brand-red       #f32f55      --brand-red-deep       #ab1f3b
--brand-amber     #fbbf3f      --brand-amber-deep     #b0842b
```

Single-hue accent for focus rings, links, carets, selection — a gradient there is noise:
`--accent` `--accent-hover` `--accent-press` `--accent-soft` `--accent-softer`

Gradients: `--gradient-brand` (90°, all six stops) `--gradient-brand-135`
`--gradient-brand-vertical` `--gradient-brand-conic` `--gradient-brand-wash` (low alpha)
`--gradient-brand-cool` (cyan→violet→magenta, primary actions)
`--gradient-brand-warm` (magenta→red→amber). Glows: `--brand-glow` `--brand-glow-strong`.

**The gradient is the brand's one loud gesture.** Mark, primary action, active/generating
state, waveform. Everything else stays near-black and restrained. Do not rainbow the UI.

### Surfaces (near-black ramp, faint blue cast)

`--surface-0` `#06070b` app ground · `--surface-1` `#0b0d13` rail & player ·
`--surface-2` `#10131a` cards & panels · `--surface-3` `#161a23` raised/popover ·
`--surface-4` `#1e232e` hover/menu · `--surface-inset` `#08090e` wells & text areas ·
`--surface-hover` `--surface-active` `--surface-selected` `--surface-scrim` `--surface-glass`

### Text

`--text-hi` headings/values · `--text` body · `--text-mid` secondary/labels ·
`--text-lo` meta/helper · `--text-faint` placeholder/disabled ·
`--text-inverse` (on a brand fill) · `--text-link`

### Borders and focus

`--border-faint` `--border` `--border-strong` `--border-brand` `--focus-ring` `--focus-ring-tight`

### Status

`--ok` `--ok-bg` `--warn` `--warn-bg` `--danger` `--danger-bg` `--info` `--info-bg`
`--busy` `--busy-bg`

### Radii

`--r-xs` 4 · `--r-sm` 6 · `--r-md` 10 · `--r-lg` 14 · `--r-xl` 20 · `--r-2xl` 28 ·
`--r-pill` · `--r-circle`

### Space

`--space-1` 2 · `--space-2` 4 · `--space-3` 6 · `--space-4` 8 · `--space-5` 12 ·
`--space-6` 16 · `--space-7` 20 · `--space-8` 24 · `--space-9` 32 · `--space-10` 40 ·
`--space-11` 48 · `--space-12` 64

### Type

Families `--font-sans` (system stack) `--font-mono` `--font-display`. There are no
webfonts and none may be added.
Sizes `--fs-3xs` 10 · `--fs-2xs` 11 · `--fs-xs` 12 · `--fs-sm` 13 · `--fs-md` 14 ·
`--fs-lg` 16 · `--fs-xl` 20 · `--fs-2xl` 26 · `--fs-3xl` 34 · `--fs-4xl` 44
Line heights `--lh-tight` `--lh-snug` `--lh-normal` `--lh-loose`
Weights `--fw-regular` `--fw-medium` `--fw-semibold` `--fw-bold`
Tracking `--tracking-tight` `--tracking-normal` `--tracking-wide` `--tracking-caps`

### Shadows

`--shadow-1` `--shadow-2` `--shadow-3` `--shadow-4` `--shadow-inset`
`--shadow-glow-cyan` `--shadow-glow-magenta`

### Motion

Durations `--dur-instant` 80ms · `--dur-fast` 130ms · `--dur-base` 200ms ·
`--dur-slow` 320ms · `--dur-slower` 520ms (all collapse to 1ms under
`prefers-reduced-motion`, so animate with tokens and reduced motion is handled).
Easings `--ease-out` `--ease-in-out` `--ease-spring` `--ease-emphasized`.
Shorthands `--t-fast` `--t-base` `--t-slow` — e.g. `transition: opacity var(--t-base);`

### Layout and controls

`--rail-w` 244 · `--rail-w-narrow` 72 · `--topbar-h` 54 · `--player-h` 84 ·
`--content-max` 1400 · `--gutter` · `--gutter-tight` ·
`--control-h-sm` 28 · `--control-h` 34 · `--control-h-lg` 42 ·
`--field-bg` `--field-border` `--field-radius`

### Z-index

`--z-base` 0 · `--z-sticky` 20 · `--z-rail` 40 · `--z-player` 50 · `--z-overlay` 70 ·
`--z-modal` 80 · `--z-toast` 90

### Logo geometry

`--mark-ratio` `--mark-img-w` `--mark-img-x` `--mark-img-y` drive `.brandmark`, which
crops the neon wave out of `logo.png`. To use the mark anywhere:

```html
<span class="brandmark" style="--mark-size: 96px"><img src="/logo.png" alt=""></span>
```

---

## 9. House rules for every lane

1. **Every control is wired to something real, or visibly disabled with the reason.**
   No placeholder sliders, no buttons that log to console. If a capability is off
   (`coverArtEnabled === false`, `lyricsEnabled === false`, `ctx.player === null`), say so
   in the UI with the backend's own words and point at the fix.
2. **Only the features in SPEC §3.** Guidance/cfg, flow-matching steps and auto-lyrics are
   not client-controllable — a control for them is a defect.
3. **Backend messages are shown verbatim.** `api.errorText(err)` or `err.fullMessage`.
4. **Offline-safe.** No CDN, no external fonts, no remote images. Everything relative.
5. **Vanilla ES modules + CSS.** No frameworks, no bundler, no transpiling.
6. **Vocal generation needs lyrics** and the backend will not write them: `POST /api/lyrics`
   then `POST /api/generate`. One button, two calls, and show the lyrics it wrote.
7. Screenshot **http://localhost:3020**. Port 3010 is the old app and is not evidence.
