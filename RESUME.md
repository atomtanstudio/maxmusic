# MaxMusic — resume here

Updated 14 Aug 2026. Round 3 build work is **done**; the scoring pass is what remains.
Everything below is verified, not remembered.

---

## Start back up

```bash
cd /Users/richgates/Documents/claude/maxmusic && ./start.sh
```

That starts the app on **:3020** and the live gauntlet monitor on **:3021**, and tells you
whether your backend on :3010 is up.

> **Node.** This machine had no `node` at all on 14 Aug — `start.sh` failed both servers with
> `node: command not found`. Installed via `brew install node` (v26.7.0, `/opt/homebrew/bin/node`).
> If it goes missing again, that is the fix.

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
| 3 | Design pass landed (solid accent, stripe removal, Covers → Art rename). Build work **finished 14 Aug**. Still **never blind-judged.** |

Round 1's full verdicts with the named gaps are in `shots/round1-verdicts.json`.

### Live counters (what "done" looks like)

The monitor's *Outstanding review items* panel scans the source on every refresh.

| Item | Round 1 | 13 Aug pause | Now |
|---|---|---|---|
| gradient stylesheets | 4 | 1 | **0** |
| left-edge accent stripes | 2 | 1 | **0** |
| modules with plumbing strings | 3 | 3 | **0** |
| files still named covers | — | 2 | **0** |

The counters now scan **code with comments stripped**, because the old greps counted JSDoc.
`api.js` documenting `POST /api/generate` in a comment block is good documentation, not a
plumbing leak — round 1 was lost on what the customer can see, so that is what is measured.
The stripe check also catches the pseudo-element dodge (an absolutely positioned 2–4px bar
pinned left), which the old `border-left` grep missed — that is how the second stripe hid.

---

## Pick up here

### The only thing left: round 3's scoring pass

Nothing has been blind-judged since round 1. The build is ready for it. See "Resuming the
loop" below, and keep the capture step tightly scoped.

### Closed on 14 Aug — do not redo these

**1. `#/art` was not broken.** The note claiming it silently redirects to `#/create` was
stale. Verified in a real browser on all three paths — direct `#/art`, nav click, and
route-to-route — the hash holds and the screen mounts. `parse()` and `ROUTES` were correct
all along. No change was needed or made.

**2. Six CSS custom properties were used but never defined**, which was the real bug behind
the gradient item. `--gradient-brand`, `--gradient-brand-warm`, `--gradient-brand-wash`,
`--gradient-brand-vertical`, `--shadow-glow-cyan` and `--shadow-glow-magenta` were removed
from `tokens.css` during the earlier purge but left in use at eight sites. They resolved to
empty, so the play-button ring, the job dot, the level meter, the art wash and the settings
hairline were all painting **transparent**. Every site now uses `--accent` or a flat scrim.

Three of those sites animated a gradient's `background-position`, which does nothing once the
fill is solid, so they were reworked to opacity pulses and a travelling solid band. The
`player-shimmer` and `set-flow-v` keyframes became dead and were deleted.

**3. Both remaining stripes are gone** — the `border-left: 2px solid var(--brand-violet)` on
the settings code block, and a 2px `::before` bar on the read-only server rows that the old
grep never saw. Those rows now read as locked through recessed elevation plus their existing
lock badge.

**4. User-visible plumbing is clear.** Five strings were rewritten in customer language.
Every remaining grep hit is a JSDoc comment, which is why the counters were changed to strip
comments before matching.

**Not changed, deliberately:** the Settings screen's `This client` panel and its `/api ·
/tracks · /covers · /uploads` row. SPEC §7a names the Settings screen as exactly where
diagnostics belong. The two surviving `covers` hits are the English word in `art.js`'s
imagery map and the real `/covers` backend route.

### Verified in the browser, not just by grep

Walking every element and both pseudo-elements, **zero gradients paint anywhere** in the
running app. The one sanctioned gradient still exists where it should: the played portion of
the waveform, built in canvas at `public/js/player.js:440` with stops matching the ramp
exactly. That is why `--ramp-logo-waveform-only` has no CSS reference — the waveform is
canvas, not CSS. It is not dead.

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
