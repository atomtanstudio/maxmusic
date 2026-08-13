# MaxMusic — resume here

Paused 13 Aug 2026, mid round 3. Everything below is verified, not remembered.

---

## Start back up

```bash
cd /Users/richgates/Documents/claude/maxmusic && ./start.sh
```

That starts the app on **:3020** and the live gauntlet monitor on **:3021**, and tells you
whether your backend on :3010 is up.

Then open:

- **http://localhost:3020** — the new front end
- **http://localhost:3021** — live build monitor (reads run journals + git + source on every
  request, refreshes every 3s, no manual updates)

### The one thing you must start yourself

The app proxies `/api` to **your existing maxmusic backend on :3010**, which lives in the other
repo and is yours to manage. If :3010 is down, start it however you normally do. For reference,
this is the environment it was last observed running with:

```bash
cd /Users/richgates/Documents/coding/legion/maxmusic && PORT=3010 MUSIC_BACKEND=local-comfy COMFY_URL=http://192.168.1.100:8190 LOCAL_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex LOCAL_CODEX_HOME="/Users/richgates/Library/Application Support/Codex" node server.js
```

Add the `LOCAL_MEDIA_BROKER_*` vars back to that line to re-enable cover art (see below).
Plain `node server.js` serves **3000**, not 3010 — the `PORT` is required.

> **Careful with `pkill -f "node server.js"`.** Both this app and the backend run under that
> exact command line, so it kills both. Target the port instead:
> `kill $(lsof -nP -iTCP:3020 -sTCP:LISTEN -t)`

At pause, ComfyUI at `192.168.1.100:8190` was **not reachable** (`comfyReachable: false`) — that
host was likely off. Generation will fail until it is back; the UI reports this honestly.

---

## What this is

A complete front-end redesign for MaxMusic, built fresh in `~/Documents/claude/maxmusic`.
It is a standalone zero-dependency app: `server.js` serves `public/` and proxies `/api`,
`/uploads`, `/covers`, `/tracks` to :3010. Vanilla ES modules and CSS, no build step, no
frameworks, no external network requests.

`~/Documents/coding/legion/maxmusic` is **read-only reference** and has never been modified.

Work is driven by a "gauntlet loop": build a screen, screenshot the real thing, and put it
blind side-by-side against a real shipped product for a fresh judge that has never seen the
code. Losers come back with one named gap.

---

## Where we got to

| Round | Result |
|---|---|
| 1 | **Lost 0 / 5**, four "obvious". Every judge identified the build the same way: we published engineering internals as product UI. |
| 2 | Rebuilt all five screens against their named gaps. Build committed (`9d75dbf`). Its scoring pass was killed — a capture agent drifted into generating content instead of screenshotting. **Never scored.** |
| 3 | Design pass landed (solid accent, stripe removal, Covers → Art rename). Lanes partially done. **Stopped here.** |

Round 1's full verdicts with the named gaps are in `shots/round1-verdicts.json`.

### Live counters (what "done" looks like)

The monitor's *Outstanding review items* panel greps the source on every refresh. At pause:

| Item | At pause | Target |
|---|---|---|
| gradient stylesheets | 1 | 0 |
| left-edge accent stripes | 1 | 0 |
| modules with plumbing strings | 3 | 0 |

Round 1 started at 4 / 2 / 3.

---

## Pick up here — in priority order

### 1. `#/art` is broken (blocker, ~10 min)

Navigating to `#/art` silently redirects to `#/create`.

- `ROUTES` in `public/js/app.js:901` **does** include `{ name: 'art', path: '/art', … }`
- `public/js/screens/art.js` imports cleanly and `public/css/screens/art.css` exists
- The nav item and label are correct

So `parse()` in `public/js/router.js` is returning `matched: false` for `/art`, and
`onHashChange` (line ~176) rewrites to the fallback. **Check how the route list is passed into
the router** — it is probably reading a stale list rather than `ROUTES`. Every other route
works, so this is specific to the newly added one.

### 2. Finish the two banned patterns

Product-owner call, non-negotiable, written up in `docs/SPEC.md` §9:

- **No gradients** anywhere except the logo mark and the played portion of the waveform.
  Primary buttons are a **solid** cyan `#00C0E0`. No gradient text, borders, card backgrounds,
  rules or glows. Hover shifts lightness, never hue.
- **No coloured left-edge stripe** on cards or notices. Distinguish by elevation, border,
  spacing, type weight, or a labelled chip inside the card.

One stylesheet and one stripe remain. `grep -rl linear-gradient public/css/screens/` and
`grep -rnE "border-left:\s*[234]px" public/css/` find them.

### 3. Purge the last plumbing strings

Three modules still carry engineering internals in resting UI. This lost us round 1 outright.
`grep -rlE "192\.168\.1\.100|POST /api|ConvRot" public/js/`

### 4. Then run round 3's scoring pass

Nothing has been blind-judged since round 1. See "Resuming the loop" below.

---

## Cover art is off, and it is not our bug

`/api/health` reports `coverArt: "disabled"`, and the Art screen correctly says so. Three
things are true:

1. Your backend was restarted at 15:25 **without** its `LOCAL_MEDIA_BROKER_*` environment
   variables, so it no longer knows about the broker.
2. The broker itself is **not running** — nothing is listening on :8788.
3. Even once both are back, generation fails with:
   ```
   install_openai_codex_image_collector.<locals>.collect_with_retries()
   got an unexpected keyword argument 'input_images'
   ```
   in `openclaw-media-broker/scripts/hermes-media-runner.py`. That file monkey-patches the
   Hermes plugin with a collector defined at line 356 as
   `collect_with_retries(token, *, prompt, size, quality)`. Upstream Hermes now calls it with an
   extra `input_images=` keyword. Fix: accept `input_images=None` on `collect_with_retries`
   (and `collect_once`) and forward or ignore it.

Your ChatGPT account is fine — `auth_mode: chatgpt`, `plan_type: pro`, image generation on. A
direct account-backed gpt-image-2 render succeeded; it is `public/demo/obsidian-temple.png`.
The provider is already OpenAI gpt-image-2 by default; no provider change is needed.

`public/demo/` also holds nine genre cover images generated during round 2, usable as seed
content.

---

## Files worth knowing

| Path | What |
|---|---|
| `docs/SPEC.md` | **The contract.** Feature surface, brand, round 1 verdicts, banned patterns, the Art screen spec. Every agent reads this first. |
| `docs/CONTRACT.md` | Module interface and design tokens for screen builders. |
| `docs/progress.html` | Narrative board (static; the live one is :3021). |
| `refs/` | The bar — six real screenshots, incl. Suno's logged-in Advanced create screen. |
| `shots/round1-verdicts.json` | Round 1 verdicts and named gaps. |
| `shots/now/` | Screenshots of the current build. |
| `gauntlet-status.mjs` | The live monitor. |

Key facts already established in `docs/SPEC.md`, so you do not have to rediscover them:
guidance/cfg and flow-matching steps are **env-only** and must never be sliders; auto-lyrics
throws in ComfyUI mode, so Simple mode is two calls; MiniMax Music 3 accepts **no audio input**,
so cover *songs* are impossible and were cut; the brand ramp is sampled from the logo's pixels.

---

## Resuming the loop

Tell Claude Code:

> Read RESUME.md and docs/SPEC.md, then continue the gauntlet. Fix the `#/art` route first,
> finish the gradient and edge-stripe purge, clear the remaining plumbing strings, then run a
> capture and blind judging pass for all five screens and report the verdicts.

Keep the capture step **tightly scoped** — screenshot and pair only, no content generation, no
seeding, no editing app files. An unbounded capture agent is what derailed round 2.

---

## Do not

- Modify anything in `~/Documents/coding/legion/maxmusic`.
- Stop, restart or reconfigure the backend on :3010 — its environment is yours.
- Edit the broker repo as part of this build; it is a separate concern.
