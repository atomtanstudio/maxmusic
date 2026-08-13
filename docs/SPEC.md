# MaxMusic — build contract

Authoritative for every builder and critic. Verified against the live backend and the
official MiniMax Music 3 docs on 2026-08-13. Do not add anything not listed here.

---

## 1. The goal and the bar

Rebuild the MaxMusic front end until it reads as a shipped commercial product.

**The bar** is `refs/` — real screenshots captured from the live products:

| File | What it is |
|---|---|
| `refs/suno-create-advanced.png` | Suno's real logged-in Advanced create screen |
| `refs/suno-create.png` | Suno's Simple create screen |
| `refs/suno-library.png` | Suno's library |
| `refs/suno-explore.png` | Suno's explore feed |
| `refs/mm3-simple.png` | MiniMax Music 3 Studio, Simple mode |
| `refs/mm3-studio.png` | MiniMax Music 3 Studio, Studio mode |

Suno is a **floor to beat, not a template to copy.** It is one reference among several
(Udio and Treblo were also cited); it is in `refs/` because it was the one that could be
captured logged-in and at full fidelity.

What to take from it: the *quality level* only — layout density, typographic rhythm,
spacing discipline, control affordances, motion, the persistent player, and how seriously
it treats empty and loading states.

What NOT to take: its visual identity. A screen that reads as a Suno reskin has failed
even if it is well made. MaxMusic has its own brand (§2) and should look like its own
product — a distinct, opinionated interface that a designer would defend on its own terms.
The goal is to **win** the blind comparison, not to tie it.

Suno is also **NOT** a feature checklist. Do not copy Suno features MiniMax Music 3 cannot
do (personas, stems, remix/extend, covers-of-artists, credits). Features come only from §3.

---

## 2. Brand

- Logo: `public/logo.png` (1190×1322, transparent-dark PNG). Use the PNG. Do not trace it
  to SVG — that flattens the gradient.
- Palette: neon on near-black, running **cyan → blue → violet → magenta → red → amber**.
- These stops are **sampled from the actual logo pixels**, left to right. Use them verbatim:

  | Stop | Hex |
  |---|---|
  | cyan | `#00C0E0` |
  | blue | `#0090F0` |
  | indigo | `#2090F0` |
  | violet | `#7060F0` |
  | magenta | `#B040F0` |
  | red | `#F04060` |
  | amber | `#E0A040` |

  Canonical ramp:
  `linear-gradient(90deg,#00C0E0,#0090F0,#7060F0,#B040F0,#F04060,#E0A040)`
- The gradient is the brand's one loud gesture. Use it on the mark, on primary actions,
  on active/generating states, on the waveform. Everything else stays near-black,
  restrained, and high-contrast. Do not rainbow the whole interface.
- Dark theme is the product. A light theme is not required.

---

## 3. Feature surface — the ONLY features that exist

### 3a. Per-request generation params (client CAN control)

| Param | Range / values | Notes |
|---|---|---|
| `prompt` | string ≤2000 chars | The structured caption (§3c) |
| `lyrics` | string ≤3500 chars | **Required** unless `is_instrumental` |
| `is_instrumental` | bool | When true, `lyrics` is ignored |
| `duration` | 0.04–360 s, default 120 | MM3 supports up to 5 min |
| `seed` | int 0–2^31 | Random when omitted |
| `audio_setting.format` | `flac` \| `mp3` \| `wav` | Backend default `flac` |
| `audio_setting.bitrate` | e.g. 256000 | mp3 only |
| `audio_setting.sample_rate` | default 44100 | model native 32 kHz |
| `tiled_decode` | bool | memory-saving decode |
| `more_variation` | bool | `/api/generate-dual` — two takes at once |

### 3b. NOT client-controllable — must NOT appear as a control

- **Guidance / cfg** — server env `COMFY_MUSIC_CFG` only.
- **Flow-matching steps** — server env `COMFY_MUSIC_STEPS` only.
- **`lyrics_optimizer` / auto-lyrics** — *throws* in local-comfy mode.

Shipping a slider for any of these is a dead control and fails review. If the UI wants to
show them, show them read-only as "server setting" in Settings, sourced from `/api/health`.

### 3c. The structured caption — what `prompt` should contain

MM3 is trained on a three-part labeled caption. Studio mode edits these as three fields
and joins them into `prompt`. Total roughly 250–400 words.

1. **Global metadata** — one paragraph, in this order:
   `Basic Attributes: bpm is <n>. key is <letter>, and scale is <major|minor>. <Genre / Subgenre>.`
   then `Global Emotional Progression: …` then `Application Scenarios & Imagery: …`
   then `Sonics & Production Profile: …`
2. **Vocal details** — `Vocal Gender & Timbre: Singer A (<Male|Female>), <timbre/register>.`
   then `Vocal Style: …` then `Harmony/Backing Vocals: …` then `Vocal FX: …`
   For instrumentals write `Instrumental, no vocals.` and name the lead melodic voice.
3. **Arrangement** — `Instrument Lifecycle Description (Primary/Secondary Layering): Primary: …
   Secondary: …` then `Groove & Foundation Progression: …` then
   `Embellishments, Textures & Spatial FX: …`. State what enters/exits/intensifies per section.

Rules: be concrete and musical; describe an energy arc and instrument lifecycles, not a
static gear list. Never contradict a user constraint. Never quote lyric lines in the caption.

### 3d. Lyrics rules

- Section tags, each **alone on its own line**. Words on a tag line are dropped.
  Only these nine: `[intro] [verse] [pre-chorus] [chorus] [post-chorus] [bridge]
  [instrumental] [solo] [outro]`
- Roughly **12–16 sung words per 10 seconds**.
- Structure by duration: ≤30 s → one verse + one chorus; ~60 s → verse/pre-chorus/chorus/
  verse/chorus; ≥120 s → full structure with bridge and outro.
- Musical direction (tempo, instruments, dynamics) belongs in Arrangement, never in lyrics.
- Instrumental → `[instrumental]` sections with no words.

### 3e. Hard flow consequence

Vocal generation **requires** lyrics and the backend will **not** write them. So
"one-line idea → song" must be a two-step flow in the client:
`POST /api/lyrics` (local Codex) → put the result in the lyrics field → `POST /api/generate`.
Surface that as one button, but implement it as two calls, and show the lyrics it wrote
before or while generating.

---

## 4. Backend API

The backend lives in another repo and is **read-only**. This app proxies to it.

| Endpoint | Body / notes |
|---|---|
| `GET /api/health` | `{ok, backend, comfyUrl, comfyReachable, musicModels, lyrics, coverArt, hasServerKey}` |
| `POST /api/generate` | payload from §3a |
| `POST /api/generate-dual` | same + `more_variation` — returns two takes |
| `POST /api/generate-stream` | same, streamed |
| `POST /api/lyrics` | `{mode, prompt, lyrics, title}` → local Codex CLI |
| `POST /api/cover-art` | `{prompt, title, mode, musicPrompt, aspect_ratio, n}` |
| `POST /api/cover` | multipart audio — cover/reference-audio mode |
| `POST /api/cover-preprocess` | multipart audio |
| `POST /api/upload` | multipart audio |
| `/uploads/*`, `/covers/*` | static assets from the backend |

**Live environment right now:** `backend: local-comfy`, ComfyUI at `192.168.1.100:8190`
(reachable), models `minimax_music3_high` + `minimax_music3_max_precision`,
`lyrics: local-codex-cli`, **`coverArt: local-media-broker` (ENABLED)**, `hasServerKey: false`.

Cover art is now live. The Covers screen must actually generate. Read
`ctx.health.coverArtEnabled` — never hardcode either state.

---

## 5. Running it

```
node server.js          # http://localhost:3020, proxies /api → 127.0.0.1:3010
```

- The **old** front end stays running on **3010** and is never modified. It is also the
  backend this app proxies to, so leave it alone.
- Always screenshot **http://localhost:3020**. A screenshot of 3010 is the old app and is
  void as evidence.

---

## 6. File ownership — do not edit outside your lane

| Owner | Files |
|---|---|
| shell | `public/index.html`, `public/css/tokens.css`, `public/css/shell.css`, `public/js/app.js`, `public/js/router.js`, `public/js/api.js` |
| create | `public/js/screens/create.js`, `public/css/screens/create.css` |
| studio | `public/js/screens/studio.js`, `public/css/screens/studio.css` |
| player | `public/js/player.js`, `public/css/player.css` |
| library | `public/js/screens/library.js`, `public/css/screens/library.css` |
| lyrics | `public/js/screens/lyrics.js`, `public/css/screens/lyrics.css` |
| covers | `public/js/screens/covers.js`, `public/css/screens/covers.css` |
| settings | `public/js/screens/settings.js`, `public/css/screens/settings.css` |

Shared design tokens live in `tokens.css` and are owned by shell. If you need a new token,
use an existing one or a local value — do not edit `tokens.css`.

No build step. No frameworks. No CDN links — the app must run offline. ES modules only.

---

## 7. Round 1 verdicts — the corrections that override everything above

Five blind judges compared our screens against the real product. **We lost all five**, four
of them "obvious". The judges never saw the code. Their reasons converged hard, so these
corrections are not suggestions — they are the round 2 pass/fail criteria.

### 7a. THE BIG ONE — no engineering internals in product chrome

Every single judge identified our build by its plumbing. This was the loudest tell in all
five frames. Banned from any resting-state UI:

- LAN addresses or ports: `192.168.1.100:8190`, `localhost:3020`
- Endpoint paths: `POST /api/lyrics`, `POST /api/generate-stream`
- Backend/build identifiers: `local-comfy`, `local-codex-cli`, `local-media-broker`
- Model internals: `FP16 + INT8 ConvRot encoder`, `FP32 + BF16`, `2 available`
- Spec references: `§3d rule`, `Lyrics match every §3d rule`
- Implementation notes as labels: `saves VRAM on long renders`, `ignored for flac`,
  `Streams /api/generate-stream so status arrives while ComfyUI works`
- Raw byte sizes and internal counters: `30.4 MB`, `71.4 MB`

Rewrite every one in customer language. `Progress updates live while your track renders`.
`Connected`. `Lyrics fit the 2:00 target`.

**Where diagnostics DO belong:** the Settings screen, and transient error states that only
appear when something is actually wrong. Connection state is a toast when the backend
drops — not a permanent sidebar card. "Honest" means never faking success; it does not mean
publishing the machine to the user.

The sidebar's bottom anchor slot must hold an identity/commercial anchor, not a status chip.

### 7b. Every screen needs a floor

Judges measured 45–57% of our viewport as untreated void, and lists that simply stop
mid-page "read as a failed render rather than a designed sparse state". Every screen fills
its frame: the large panel on Create becomes the track-history list; sparse lists end in a
terminal card on the same row rhythm; no region is left as flat dark nothing.

### 7c. One value, one control

Duration currently renders three ways at once (slider + numeric + five preset chips) so
"the user cannot tell which is authoritative". Collapse to a chip row plus one editable
field. Audit every control for the same fault.

### 7d. Contrast and hit targets are failing measurably

The library's regenerate icon measured **1.1:1** against its row — effectively invisible.
Bare glyphs with no container, mixed fills and strokes in one strip, and a destructive
delete sitting inline at identical weight to play.

Rule: interactive icons get a container with a visible rest state, one icon style and
stroke weight throughout, ≥3:1 glyph-on-chip contrast, ≥34px hit targets, ≥12px gaps.
Destructive actions go in an overflow menu, never inline with primary ones.

### 7e. Sticky footers must not bisect content

Both Covers and Lyrics had cards and primary buttons sliced in half by overlaid action
bars. Any scroll container under a sticky footer gets bottom padding equal to the full
footer height. A half-erased label reads as a clipping bug, and it was called "the single
loudest unfinished-build signal in the frame".

### 7f. One accent, not four

We shipped cyan, magenta, green and violet simultaneously; the reference holds
near-monochrome with a single accent. The brand gradient is for **one** primary action per
view, plus the waveform. Status greens and info blues are not additional accents — express
state through form (weight, container, position) before reaching for hue.

### 7g. Alignment rhythm

Rows must share one left rail and one fixed pitch. Ours broke its own rail (title at x=415,
icons at x=425) and varied row heights. Pick the rhythm, then hold it everywhere.

---

## 8. "Covers" resolved — it meant cover SONGS, and they are impossible here

Verified three ways on 2026-08-13:

1. **`server.js`** — in `local-comfy` mode both audio endpoints hard-fail:
   `POST /api/cover` → `501 "Audio cover restyling is not provided by the local Music 3
   Comfy workflow."` and `POST /api/cover-preprocess` → `501` likewise.
2. **`local-providers.js:55`** — the health field is album art, not song covers:
   `coverArt: comfyCoverWorkflow ? 'local-comfy-workflow' : broker.configured ? 'local-media-broker' : 'disabled'`
3. **Official diffusers pipeline doc for MiniMax Music 3** — the pipeline takes `prompt`,
   `lyrics`, `audio_duration`, `generator`, `output`. **No argument accepts audio.** It is
   purely text-to-audio: no reference audio, no melody conditioning, no continuation.

So the two things were always separate features that share a word:

| Old name | What it actually is | Status here |
|---|---|---|
| `/api/cover`, `/api/cover-preprocess` | **Cover songs** — upload a reference track, restyle it | **Impossible.** Legacy MiniMax `music-2.6` API feature. MM3 cannot accept audio at all. |
| `/api/cover-art` | **Album art** — image generation for a track | **Works.** Via the local media broker (gpt-image-2 on the signed-in OpenAI account), or a ComfyUI image workflow. |

### Decisions

- **Cut cover songs entirely.** Not a disabled screen, not a "coming soon" — the model cannot
  do it, so it does not exist in this product. Remove any upload-reference-audio affordance.
- **Rename the screen `Art`.** Route `#/art`, files `public/js/screens/art.js` and
  `public/css/screens/art.css`. Nav label "Art". Never use the bare word "Covers" as a
  destination — it is the ambiguity that caused this.
- Within Art, "cover" may appear only as a noun for the image on a track ("cover art",
  "album art"), never as a verb or a section name.

---

## 9. Two banned patterns — they read as AI-generated

Both called out directly. Neither is a matter of taste; both are house style now.

### 9a. Gradient restraint

The brand gradient is currently doing too much work and it makes the product look generated.
The logo is deliberately polychrome; the interface must not be.

- The gradient appears on **the logo mark, and the waveform's played portion. That is all.**
- Primary buttons are **solid**. Pick ONE stop from the ramp as the product's accent —
  cyan `#00C0E0` is the recommendation — and use a flat fill of it. A solid, confident accent
  reads as designed; a gradient fill on a button reads as generated.
- No gradient text. No gradient borders. No gradient card backgrounds. No gradient rules or
  dividers. No glow/bloom behind buttons.
- Hover and active states shift lightness or elevation, not hue.

### 9b. No coloured accent bar on the left edge of cards

The 2–4px coloured stripe down the left side of an information card, notice, or callout is
one of the most recognisable AI-generated design tells. It is banned outright.

Distinguish cards by the things real design systems use: background elevation, border weight,
internal spacing, type weight and size, an icon set in the content, or a small chip. If a card
must signal severity, put the signal **inside** the card as a labelled chip — not as a
decorative edge.

This applies to every surface in the product, including any documentation or status page.
