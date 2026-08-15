# MaxMusic — shell contract

Everything a screen builder needs. `docs/SPEC.md` says *what* to build; this file says
*how to plug it in*. If something you need is not here, ask the shell lane — do not edit
`public/index.html`, `public/css/tokens.css`, `public/css/shell.css`, `public/js/app.js`,
`public/js/router.js` or `public/js/api.js`.

Run: `node server.js` → <http://localhost:3020>. `/api`, `/tracks`, `/covers`, `/uploads`
are proxied to the backend on 3010. No build step, no frameworks, no CDN. Everything must
work offline, so never reference an external host — no fonts, no scripts, no images.

---

## 0. Round 3 — READ THIS FIRST

Two patterns were named directly by the product owner as the things that make this build
read as AI-generated. They are house style now, not preferences. Both are enforced in
`tokens.css` and `shell.css`; if your screen still shows one, it is your screen's bug.

### 0a. No gradients

The brand ramp survives in **one token with a self-documenting name**:

```
--ramp-logo-waveform-only
```

Legal on exactly two surfaces: **the logo mark** and **the played portion of the
waveform**. Nowhere else. Not buttons, not text, not borders, not card backgrounds, not
rules or dividers, not badges, not hairlines. No glow, halo or bloom behind anything.

Everything emphatic is a **solid fill of one accent — cyan `#00C0E0`**. Hover and active
move **lightness**, never hue.

| Token | Value | Job |
|---|---|---|
| `--accent` | `#00C0E0` | rest. The product's one accent. |
| `--accent-hover` | `#0FDDFF` | hover — the same hue, 9% lighter. |
| `--accent-press` | `#00A6C1` | active/pressed — the same hue, 6% darker. |
| `--accent-disabled` | `#007285` | disabled — the same hue, 18% darker. Plainly inert. |
| `--accent-ink` | `#04161A` | text and glyphs **on** an accent fill (8.5:1). |
| `--accent-soft` / `--accent-softer` | cyan at 14% / 7% | focus halo, quiet fills, track. |

All four states are `hsl(188.6 100% L)` — only `L` moves. Do not invent a fifth state and
do not shift the hue for one.

**Tokens that no longer exist.** They were deleted, not renamed to something you can find.
A `var()` on any of them makes the whole declaration invalid, which is the intended
outcome — the gradient disappears instead of surviving under a new name:

| Deleted | Use instead |
|---|---|
| `--gradient-brand` | `--ramp-logo-waveform-only` **only if** you are painting the played waveform; otherwise `--accent`. |
| `--gradient-brand-cool` / `--gradient-brand-warm` | `--accent` (solid). |
| `--gradient-brand-135` / `-vertical` / `-conic` / `-wash` | nothing. Use a surface step. |
| `--brand-glow` / `--brand-glow-strong` | nothing. Bloom is banned. |
| `--shadow-glow-cyan` / `--shadow-glow-magenta` | `--shadow-2` / `--shadow-3` (elevation). |
| `.gradient-text` | plain `--text-hi`. Gradient text is banned outright. |
| `--dock-fade` | nothing — `.dock__foot--fade` is now elevation (`--shadow-lift`). |
| `--brand-*-deep` (six) | nothing. They were only ever gradient fodder. |

The six ramp stops (`--brand-cyan` … `--brand-amber`) **do** still exist, retuned to the
SPEC §2 values, because the player paints the waveform from them and the library generates
placeholder artwork from them. They are not a palette to decorate chrome with. Reaching for
`--brand-violet` to tint a card is the "four accents at once" bug that lost round 1.

`--busy` / `--busy-bg` were violet; they are now `--accent` / `--accent-soft`.

### 0b. No left-edge accent stripe

The 2–4px coloured bar down the left side of a card, notice, callout, toast or code block
is banned outright, on every surface including docs and status pages.

Distinguish surfaces with the things real design systems use: **elevation**
(`--surface-*`), **border weight** (`--border-*`, on all four sides or none), **spacing**,
**type weight and size**, an **icon in the content** — or a **labelled severity chip inside
the card**:

```html
<div class="notice notice--warn">
  <svg class="icon notice__icon" aria-hidden="true"><use href="#i-alert"/></svg>
  <div class="notice__body">
    <p class="notice__head">
      <span class="notice__title">Not ready to render</span>
      <span class="sev sev--warn">Warning</span>
    </p>
    <p>New tracks will fail until your studio finishes starting up.</p>
  </div>
</div>
```

`.sev` variants: `.sev--warn`, `.sev--error`, `.sev--live` (solid accent), `.sev--ok`
(colourless). The chip carries a **word**, so severity is read, not decoded from an edge.
Shell toasts already render one for `warn` and `error` — that is what replaced the stripe
they used to wear.

Removed with the stripe: the `::before` marker on `.navitem.is-active`. An active nav item
is now a raised container + a hairline + semibold full-contrast text — three form signals,
no bar.

### 0c. "Covers" is now "Art"

Cover **songs** are impossible on MiniMax Music 3 (the pipeline accepts no audio) and were
cut. The screen that remains generates **album art**. Everything renamed:

| Was | Now |
|---|---|
| route `#/covers` | `#/art` |
| `public/js/screens/covers.js` | `public/js/screens/art.js` |
| `public/css/screens/covers.css` | `public/css/screens/art.css` |
| nav label `Covers`, page title `Cover art` | `Art` |
| sprite `#i-covers` | `#i-art` |
| CSS namespace `.screen-covers` / `.cov-*` | `.screen-art` / `.art-*` |
| bus `covers:new` | `art:new` |
| storage `maxmusic:covers.history` / `.draft` | `maxmusic:art.history` / `.draft` |

`#/covers` is not a route any more; the router rewrites unknown hashes to `#/create`.
The word "cover" survives **only as a noun for the image on a track** — "cover art", the
`/api/cover-art` endpoint, the `/covers/*` static mount, `record.cover`. Never as a
destination, a nav label, a section heading or a verb.

---

## 0.1. Round 2 — what changed in the shell, and what it means for you

Round 1 lost all five blind comparisons. Four of the fixes live in this file, and three of
them are primitives you are expected to use rather than reinvent.

| Round 1 defect | Round 2 shell answer | What you must do |
|---|---|---|
| `Backend online / 192.168.1.100:8190` card in the sidebar | Deleted. Connection state is a transient toast; the anchor slot now holds the workspace identity + a `New song` CTA. | Never print a host, a port, an endpoint path, a provider name, a model string or a byte size in resting UI. Read `ctx.health` and speak in customer language. |
| Bare icon glyphs at 1.1:1, mixed fills and strokes, inline delete | `.actionchip` + `.actionbar` + `.menu` (§6a) | Build every icon action out of these. Do not hand-roll a bare `<button><svg>`. |
| Sticky footers slicing cards and buttons in half | `.dock` (§6b), measured for you | Wrap any screen with a pinned action bar in `.dock`. |
| Cyan + magenta + green + violet at once | Tokens retuned; `--ok`/`--info` are now colourless; one accent per view, linted at runtime (round 3 made that accent solid — see §0a) | Reach for `.btn--strong`, a container, or weight before you reach for a hue. |

**Removed** — these no longer exist, do not reference them:
`.status`, `.status__dot`, `.status__label`, `.status__detail`, `.brand__sub`, and the
per-nav-item brand-gradient slice. `.iconbtn` still resolves (it is now an alias of
`.actionchip`) but is deprecated — rename it when you touch a file.

**Added** — `--surface-5`, `--action-size`, `--action-size-lg`, `--action-gap`,
`--icon-stroke`, `.btn--strong`, `.actionbar`, `.actionchip`, `.menu`, `.dock`,
`ctx.menu`, `ctx.attachMenu`, `ctx.registerDock`, `health.detail`,
`i-chevron-up` / `i-share` / `i-pencil` / `i-user`.

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
| settings | `#/settings` | `screens/settings.js` | `css/screens/settings.css` |

Query strings are supported and parsed for you: `#/library?track=ab12` →
`ctx.route.query.track === 'ab12'`. Unknown hashes are rewritten to `#/create`.

Lyrics and Art were routes of their own until Aug 2026. Both were removed
because the work had moved to where the songs are: lyrics are written, shown
and edited on Create and Studio, and artwork is made from a song through the
cover-art dialog in the Library. What survived of Art is `art-brief.js`, the
deterministic song → art-direction reader that dialog composes with.

Non-screen modules screens may import: `records.js` (the song ledger),
`studio-actions.js` (audio and video exports), `cover-redo.js` (the cover-art
dialog), `art-brief.js`, and `pacing.js` (fitting a lyric sheet and a running
time to each other — see the module header for the measured numbers).

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
| `ctx.menu(config)` | `HTMLElement` | A ready-made `…` overflow menu (chip + list). §6a. |
| `ctx.attachMenu(el, config)` | controller | Turn an element you already rendered into a menu trigger. Destroyed for you on unmount. §6a. |
| `ctx.registerDock(root?)` | `number` | Force a sticky-footer measurement. Rarely needed — the shell scans automatically. §6b. |

`window.MaxMusic` exists for console debugging only. Never import `app.js` and never
reach for `window.MaxMusic` in shipped screen code — use `ctx`.

---

## 3. Bus events — the cross-lane contract

Emit and listen with `ctx.bus`. Payloads are plain objects.

| Event | Emitted by | Payload | Meaning |
|---|---|---|---|
| `track:new` | create, studio | `{ track, meta }` | A generation finished. `track` is the backend `{id, filename, url, size}`. `meta` carries whatever the screen knows: `{title, prompt, lyrics, duration, seed, format, isInstrumental, extra_info, createdAt}`. |
| `art:new` | art | `{ cover, meta }` | Album art finished rendering. Was `covers:new`. |
| `library:changed` | library | `{ count }` | Library contents changed. The shell paints the count badge in the nav rail — and **only** there. The workspace anchor deliberately does not mirror it (see §6e). |
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
- Never restyle `.rail`, `.topbar`, `.playerbar`, `.toast`, `.sev`, `.railfoot` or
  `.workspace`.
  The rail's bottom anchor (workspace identity + `New song`) is shell-owned; nothing may
  be added to it, and nothing may report connection state anywhere in the chrome.
- Never restyle `.actionchip`, `.actionbar`, `.menu*` or `.dock*` geometry. Colour and
  size are the contract, not a starting point. Add a class *beside* them if you need a
  hook (`class="actionchip lib-act"`), and only set things they do not own.
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

**`Health` snapshot** — `{ raw, status: 'online'|'degraded'|'offline', message, detail, ok,
backend, comfyUrl, comfyReachable, comfyError, musicModels, modelKeys, lyricsProvider,
lyricsEnabled, coverArtProvider, coverArtEnabled, hasServerKey, error, checkedAt }`.

- `message` is **customer copy** (`Connected`, `MaxMusic can't reach your studio right
  now.`) and is safe to render on any screen.
- `detail` is the **verbatim technical reason** and belongs on Settings only, alongside
  `backend`, `comfyUrl`, `comfyError`, `modelKeys` and the provider strings. Putting any of
  those in a working frame is house rule 0.
- `lyricsEnabled` and `coverArtEnabled` are derived from the provider strings — use them to
  degrade honestly. **Always read the flag, never hardcode either state.** Cover art
  reports as off whenever the operator's image service is not running; that is correct
  behaviour, not a bug. Build the Art screen so it works the moment it returns.
- The shell polls every 30s and raises a **transient toast** on a real change of state
  (and a one-line "Reconnected" when it recovers). Screens do not need to render
  connection state at all — just disable what cannot work and say why.

**Generation input** (SPEC §3a — nothing else is client-controllable):
`prompt`, `lyrics`, `is_instrumental`, `duration`, `seed`, `tiled_decode`, `more_variation`,
`model`, `audio_setting: {format, bitrate, sample_rate}`.
**Never** ship a control for guidance/cfg, flow-matching steps, or auto-lyrics
(`lyrics_optimizer`). They are server env only and the last one throws.

---

## 6. Shared primitives (`shell.css`)

Use these. They are the reason six independently built screens will look like one product.

**Buttons** `.btn` · modifiers `.btn--primary` (a **solid** `--accent` fill — **one per
view**, for the real action; hover/press/disabled are lightness steps of the same cyan and
there is no glow behind it) `.btn--strong` (second-emphasis: a solid high-contrast white
fill, no hue) `.btn--ghost` `.btn--outline` `.btn--danger` `.btn--sm` `.btn--lg`
`.btn--block` `.btn--icon` · state `.is-active` · `:disabled` is styled, so use the real
attribute. Do not restyle `.btn--primary`'s background in a screen sheet — a second fill
is how the "one accent" rule dies.

**Selection** `.chip` (+ `.chip--mono`, `.is-active` / `aria-pressed="true"` — selected is
a solid fill, not a tint), `.segment` > `.segment__item.is-active` for Simple/Advanced-style
tab groups.

### 6a. Icon actions — `.actionbar`, `.actionchip`, `.menu`

The library's regenerate icon measured **1.1:1** against its row in round 1. These
primitives make that impossible. Build every row-level or toolbar-level icon action out of
them; never hand-roll a bare `<button><svg>`.

```html
<div class="actionbar">
  <button class="actionchip" type="button" aria-label="Play">
    <svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>
  </button>
  <button class="actionchip actionchip--count" type="button" aria-label="Plays">
    <svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>
    <span class="actionchip__num">12</span>
  </button>
  <button class="actionchip" type="button" aria-label="Download">…</button>
  <span class="actionbar__sep"></span>
  <!-- the overflow menu goes here; build it with ctx.menu() -->
</div>
```

| Class | What it guarantees |
|---|---|
| `.actionbar` | One flex row at a fixed `--action-gap` (12px). Neighbours cannot crowd. `.actionbar--end` pushes it right; `.actionbar__sep` is the hairline divider. |
| `.actionchip` | A **34px circular container that is visible at rest** (`--surface-4` + a 1px border) with the glyph at `--text-mid` = **5.2:1 on the chip**, rising to `--text-hi` = 10.4:1 on hover. Verified by measurement, not by eye. |
| `.actionchip--lg` | 40px. For a row's primary affordance (play). Same look. |
| `.actionchip--count` | Pill variant that also carries a numeral in `.actionchip__num`. Still 34px tall. |
| `.actionchip--onground` | Use when the chip sits on `--surface-0`/`--surface-1` rather than on a card. |
| `.actionchip.is-active` / `[aria-pressed="true"]` | Inverts to a solid fill. |
| `.menu` | The standard overflow menu (below). |

Three rules the primitives enforce, so do not work around them:

1. **There is no small variant.** `--action-size` is 34px. If a chip does not fit, the row
   is too dense — change the row.
2. **There is no inline destructive chip.** Delete, Clear, Remove and Discard live in a
   `.menu` as `.menu__item--danger`. A *labelled* destructive button (`.btn--danger`) may
   sit in the open; a destructive *icon* may not.
3. **One icon style, one stroke weight.** Every glyph comes from the sprite: 24×24,
   `1.75` stroke, round caps and joins, `currentColor`. The only filled shapes in the whole
   set are dots (`i-more`, `i-dice` pips). Do not inline a one-off SVG and do not add a
   filled icon — ask the shell lane instead.

**Building a menu.** Do not assemble `.menu__list` by hand; the shell owns positioning
(viewport-fixed, mounted on `<body>` while open, flips up near the bottom, so a scrolling
row or a `backdrop-filter` footer cannot clip it), outside-click, Escape, arrow-key
navigation and focus restoration.

```js
const overflow = ctx.menu({
  label: 'More actions',           // aria-label on the trigger chip
  align: 'end',                    // 'end' (default) | 'start'
  items: () => [                   // array, or a function for per-row state
    { label: 'Rename',   icon: 'pencil',   onSelect: () => rename(id) },
    { label: 'Download', icon: 'download', note: 'FLAC', href: url },
    { separator: true },
    { label: 'Delete',   icon: 'trash',    danger: true, onSelect: () => remove(id) },
  ],
});
row.append(overflow);              // the wrapper is a compliant .actionchip trigger
```

`MenuItem` keys: `label`, `icon` (sprite name), `note` (right-aligned secondary text),
`danger`, `disabled`, `href` (renders an anchor), `onSelect`, `separator`, `heading`.
For an element you already rendered — a row's own `…` button, an account row, a
`.btn` with a chevron — use `ctx.attachMenu(el, config)`; it is torn down on unmount.

### 6b. Sticky footers — `.dock`

Round 1 sliced a card header and a primary button in half on two screens. Any scroll
region with a pinned action bar goes in a `.dock`.

```html
<div class="dock">                       <!-- height:100%, flex column -->
  <div class="dock__scroll">…form, list, editor…</div>
  <div class="dock__foot dock__foot--fade">
    <button class="btn btn--primary btn--lg btn--block">Generate</button>
  </div>
</div>
```

- **Default (`.dock`)** — the footer is a flex sibling of the scroller, so overlap is
  *structurally impossible*. Prefer this. `.dock__scroll` already carries 24px of bottom
  breathing room.
- **`.dock--overlay`** — opt in when you want a glass bar floating over the content. The
  shell measures the footer with a `ResizeObserver` and sets `--dock-foot-h` on the
  `.dock`; `.dock__scroll` is padded by `--dock-foot-h + 24px`, live, whatever the footer
  grows into. Measured: an 80px footer produced 104px of scroll padding and 25px of
  clearance below the last card at full scroll.
- `.dock__foot--fade` now lifts the footer with a shadow (`--shadow-lift`) so it reads as
  sitting **above** the content. It used to be a fade-to-surface gradient, which is banned;
  elevation says the same thing. `--dock-fade` is gone — delete any `--dock-fade` you set.

You do not have to call anything: the shell scans on every mount and watches the outlet
for docks added later. `ctx.registerDock(el)` exists for a dock you build inside a shadow
of the outlet or after an unusual async paint.

### 6c. Accent discipline — how the one-accent rule is enforced

We shipped cyan, magenta, green and violet simultaneously. Then we filled every primary
button with a six-stop ramp. Both are gone. The accent is now spent on exactly two things:
**ONE `.btn--primary` per view, and the actively-generating state.** The ramp itself is
spent on **the mark and the played waveform**, and nothing else, ever.

The rule is enforced in five places rather than by good intentions:

1. **The gradient tokens were deleted, not deprecated.** There is one ramp token and its
   name (`--ramp-logo-waveform-only`) states its scope. A stale `var(--gradient-brand-cool)`
   resolves to nothing, so the gradient vanishes rather than surviving quietly. See §0a.
2. **Tokens carry the palette limit.** `--ok` and `--info` resolve to `--text-hi` on a
   raised container — there is no success green and no info blue to reach for. `--warn` is
   the ramp's amber and `--danger` the ramp's red, each with one job. `--busy` is now the
   accent, not violet. `--surface-selected` is a white tint, not a cyan one.
3. **The shared components already obey it.** Active chips, active nav items, checked
   switches, filled sliders and selected states are all solid `--text-hi` fills — form,
   not hue. `.brandline` is a solid accent segment travelling across a quiet track, not a
   scrolling ramp. `.badge--brand` and `.sev--live` are flat `--accent`.
4. **`.btn--strong` exists** so "this is also important" has an obvious answer that is not
   a second accent fill.
5. **The shell lints it.** After every mount it counts visible, enabled `.btn--primary`
   elements and logs `[shell] accent discipline: N .btn--primary are visible at once` when
   `N > 1`. Keep the console clean.

If a screen needs to signal state, spend **weight, a container, elevation, position or
size first**. Reach for hue only when the state is a warning or a destruction — and when
you do, wear it as a full border plus a labelled `.sev` chip, never as an edge.

**Self-check before you hand a screen over.** Both of these must come back empty for your
own files:

```
grep -n "gradient" public/css/screens/<yours>.css
grep -n "border-left" public/css/screens/<yours>.css   # a 1px column divider is fine;
                                                       # anything ≥2px and coloured is not
```

**Forms** `.field` (label + control + hint column), `.label` (+ `.label__hint` for a
right-aligned counter), `.input`, `.textarea` (+ `.textarea--mono`), `.select`, `.hint`
(+ `.hint--error`, `.hint--warn`), `.switch` > `input` + `.switch__track` + `.switch__label`,
`.range` (set `--range-fill: <pct>%` on the element to colour the filled portion).
`aria-invalid="true"` turns a field red.

### 6d. Severity — `.sev`, the chip that replaced the edge stripe

`.sev` is a small uppercase chip carrying a **word**. It goes **inside** the surface, on
the title row — never on its edge. This is the sanctioned way for a card, notice, panel or
toast to say how serious it is.

| Class | Reads as | Colour |
|---|---|---|
| `.sev` | neutral label | `--surface-4` + `--text-mid` |
| `.sev--warn` | `Warning` | `--warn` on `--warn-bg`, full border |
| `.sev--error` | `Error` | `--danger` on `--danger-bg`, full border |
| `.sev--live` | `Working` | solid `--accent` + `--accent-ink` |
| `.sev--ok` | `Ready` | colourless — `--text-hi` on `--surface-5` |

Pair it with `.notice__head` (or `.toast__head`, which the shell fills in for you) so the
title and the chip sit on one baseline. Markup is in §0b.

### 6e. The rest

**Containers** `.panel` > `.panel__head` (`.panel__title`) + `.panel__body`; `.card`
(+ `.card--hover`); `.divider`. Cards are distinguished by **elevation and border weight**
— there is no left-edge variant of any of them and there must never be one.

**Status** `.badge` (+ `--ok --warn --danger --info --brand`; `--ok` and `--info` are
deliberately colourless, `--brand` is now a flat `--accent` fill — see §6c), `.notice` >
`.notice__icon` + `.notice__body` > `.notice__head` (`.notice__title` + `.sev`)
(+ `--warn --error --info`), `code.code` for inline code.

**States** `.empty` > `.empty__icon` + `.empty__title` + `.empty__text`; `.spinner`
(put it on an `.icon` using `#i-spinner`); `.skeleton` (a breathing surface — the sweeping
sheen was a moving gradient and is gone); `.brandline` (indeterminate progress hairline: a
**solid accent** segment travelling across a quiet track, full width, so it is not an edge
stripe. Use it on a panel that is actually generating, not as decoration).

**Layout** `.page` (+ `.page--narrow`, `.page--flush`, `.page__lead`), `.stack`, `.row`
(+ `.row--wrap`, `.row--end`), `.spacer`, `.truncate`, `.mono`, `.visually-hidden`,
`.brandmark` (see §8). `.gradient-text` **no longer exists** — gradient text is banned.

**The rail anchor** — the workspace block at the bottom of the nav is shell-owned and is an
**identity** statement, not a readout. Its second line is the constant
`Private to this computer`: true on every screen, in every state, before anything has
loaded. Round 2 derived a song count there and it contradicted itself inside one session
("Local workspace" on Create, "No songs yet" on Library) because only the Library screen
reports the count. A count has exactly one home — the Library nav badge, fed by
`library:changed`. Do not add a second readout to the anchor and do not restyle it.

**Toasts** `ctx.toast(msg, {kind, title, timeout, key, actions})`. `actions` is an array of
`{label, onClick}` rendered as buttons in the toast body. `key` replaces a live toast with
the same key instead of stacking a second one — use it for anything that can repeat.
`warn` and `error` automatically get a labelled `.sev` chip on the title row; the toast's
2px left edge stripe was removed in round 3.

---

## 7. Icons

Sprite lives in `index.html`. Use `ctx.icon('play')` or
`ctx.iconMarkup('play')`, or write it directly:

```html
<svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>
```

Available ids (drop the `i-` prefix when calling `ctx.icon`):

`i-create` `i-studio` `i-library` `i-lyrics` `i-art` `i-settings`
`i-play` `i-pause` `i-prev` `i-next` `i-shuffle` `i-repeat` `i-volume` `i-mute`
`i-search` `i-plus` `i-close` `i-check` `i-chevron-down` `i-chevron-up`
`i-chevron-right` `i-chevron-left`
`i-download` `i-copy` `i-trash` `i-heart` `i-more` `i-refresh` `i-wand` `i-alert` `i-info`
`i-dice` `i-clock` `i-wave` `i-mic` `i-external` `i-lock` `i-panel` `i-menu` `i-spinner`
`i-share` `i-pencil` `i-user`

**One style, one weight.** Every symbol is 24×24, drawn as a `1.75` stroke in
`currentColor` with round caps and joins. The only filled shapes in the set are dots
(`i-more`, the pips in `i-dice`). `i-play` and `i-pause` are stroked like everything else —
round 1 lost partly on "play is a solid fill, download and trash are ~1.5px strokes",
so a filled play glyph is no longer available anywhere.

`.icon` sizes them to 18px; override `width`/`height` on your own class when you need
another size (colour too — but keep it ≥3:1 against whatever it sits on). If you need an
icon that is not here, ask the shell lane to add it — do not inline a one-off SVG with a
different stroke weight, and do not link an external icon font.

---

## 8. Design tokens (`tokens.css`)

`tokens.css` is the single source of truth for colour. Every value below is a CSS custom
property on `:root`. Use them; do not hard-code hex values, and do not redefine them.

### Brand ramp — SPEC §2 values, verbatim

```
--brand-cyan      #00C0E0        --brand-magenta   #B040F0
--brand-blue      #0090F0        --brand-red       #F04060
--brand-indigo    #2090F0        --brand-amber     #E0A040
--brand-violet    #7060F0
```

These six exist so the **player** can paint the waveform and the **library** can generate
placeholder artwork. They are not a palette for chrome. There are no `-deep` variants any
more.

The only gradient in the product:

```
--ramp-logo-waveform-only
  linear-gradient(90deg, #00C0E0, #0090F0, #7060F0, #B040F0, #F04060, #E0A040)
```

Legal on the **logo mark** and the **played portion of the waveform**. Nowhere else — the
token is named so a code review can see the violation without opening the spec.

### Accent — solid cyan, states by lightness

```
--accent            #00C0E0    rest        --accent-ink        #04161A   text on the fill
--accent-hover      #0FDDFF    hover       --accent-soft       cyan 14%  quiet fill
--accent-press      #00A6C1    pressed     --accent-softer     cyan  7%  focus halo, track
--accent-disabled   #007285    disabled
```

All four states are `hsl(188.6 100% L)`; only `L` moves — 44 / 53 / 38 / 26. **Never shift
hue for a state.** `--accent` is also `--text-link`, `--border-brand` (at 45% alpha),
`--focus-ring`, `::selection` and `--busy`. See §0a for the deleted gradient/glow tokens.

### Surfaces (near-black ramp, faint blue cast)

`--surface-0` `#06070b` app ground · `--surface-1` `#0b0d13` rail & player ·
`--surface-2` `#10131a` cards & panels · `--surface-3` `#161a23` raised ·
`--surface-4` `#1e232e` action-chip rest / menu / tooltip · `--surface-5` `#272d3a` hover
on a chip or menu item · `--surface-inset` `#08090e` wells & text areas ·
`--surface-hover` `--surface-active` `--surface-selected` (a white tint, not a cyan one)
`--surface-scrim` `--surface-glass`

### Text

`--text-hi` headings/values · `--text` body · `--text-mid` secondary/labels ·
`--text-lo` meta/helper · `--text-faint` placeholder/disabled ·
`--text-inverse` (on a white/high-contrast fill; use `--accent-ink` on an accent fill) ·
`--text-link`

### Borders and focus

`--border-faint` `--border` `--border-strong` `--border-brand` (the accent at 45% — for
focus and a live caret, **on all four sides or none**) `--focus-ring` `--focus-ring-tight`

### Status — three colours, each with one job

`--ok` / `--ok-bg` — **colourless on purpose**: full-contrast text on a raised container.
There is no success green. Say "done" with a check glyph, weight and a container.
`--info` / `--info-bg` — same, colourless. There is no info blue.
`--warn` / `--warn-bg` — the ramp's amber. Transient warnings only.
`--danger` / `--danger-bg` — the ramp's red. Destructive intent only.
`--busy` / `--busy-bg` — **the accent** (was violet). The actively-generating state only.

If you find yourself wanting a fifth colour, you want a container instead.

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

`--shadow-1` `--shadow-2` `--shadow-3` `--shadow-4` `--shadow-inset` ·
`--shadow-lift` (upward, for a sticky footer over content).

Elevation is the legal way to say "raised", "hovered" or "above". There are **no coloured
glow tokens** — `--shadow-glow-cyan` and `--shadow-glow-magenta` were deleted, because a
halo behind a button is bloom and bloom is banned.

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

Icon-action floors (§6a) — these are minimums, not suggestions:
`--action-size` 34 · `--action-size-lg` 40 · `--action-gap` 12 · `--icon-stroke` 1.75

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

0. **No engineering internals in resting UI.** This is the rule that lost round 1 — every
   judge named it, in every frame. Banned from anything a customer sees while the app is
   working normally: LAN addresses and ports, endpoint paths, backend/provider/build names
   (`local-comfy`, `local-codex-cli`, `local-media-broker`), model and quantization strings,
   spec section numbers, implementation notes dressed as labels ("saves VRAM on long
   renders", "ignored for flac"), raw byte sizes and internal counters.
   Say `Connected`, not `192.168.1.100:8190`. Say `Progress updates live while your track
   renders`, not `Streams /api/generate-stream`. Say `Lyrics fit the 2:00 target`, not
   `Lyrics match every §3d rule`.
   Diagnostics have exactly two homes: the **Settings** screen, and **transient error
   states** that only appear when something is actually wrong. `health.message` is customer
   copy and is safe anywhere; `health.detail`, `health.comfyUrl`, `health.backend`,
   `health.modelKeys` and `err.endpoint` are Settings-only.

1. **Every control is wired to something real, or visibly disabled with the reason.**
   No placeholder sliders, no buttons that log to console. If a capability is off
   (`coverArtEnabled === false`, `lyricsEnabled === false`, `ctx.player === null`), say so
   in the UI and point at the fix.
2. **Only the features in SPEC §3.** Guidance/cfg, flow-matching steps and auto-lyrics are
   not client-controllable — a control for them is a defect.
3. **Failure messages are shown verbatim, in error states.** `api.errorText(err)` or
   `err.fullMessage` — never replaced with "Something went wrong". Honest means never
   faking success; it does not mean publishing the machine on a working screen (rule 0).
4. **Offline-safe.** No CDN, no external fonts, no remote images. Everything relative.
5. **Vanilla ES modules + CSS.** No frameworks, no bundler, no transpiling.
6. **Vocal generation needs lyrics** and the backend will not write them: `POST /api/lyrics`
   then `POST /api/generate`. One button, two calls, and show the lyrics it wrote.
7. **No gradients** anywhere except the logo mark and the played waveform, which share the
   single `--ramp-logo-waveform-only` token. Primary actions are a solid `--accent`; hover
   and active move lightness, never hue; nothing glows. See §0a.
8. **No left-edge accent stripe** on a card, notice, callout, toast or code block — on any
   surface, including docs and status pages. Distinguish with elevation, border weight,
   spacing, type weight, or a labelled `.sev` chip **inside** the surface. See §0b.
9. **"Covers" is "Art".** Route `#/art`, files `screens/art.*`, nav label `Art`. The word
   "cover" is allowed only as a noun for the image on a track. See §0c.
10. Screenshot **http://localhost:3020**. Port 3010 is the old app and is not evidence.
