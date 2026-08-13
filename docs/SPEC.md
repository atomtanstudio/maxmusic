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

Suno is the bar for **visual and interaction quality only** — layout density, typography,
spacing, control affordances, motion, the persistent player, empty/loading states.

Suno is **NOT** a feature checklist. Do not copy Suno features MiniMax Music 3 cannot do
(personas, stems, remix/extend, covers-of-artists, credits). Features come only from §3.

---

## 2. Brand

- Logo: `public/logo.png` (1190×1322, transparent-dark PNG). Use the PNG. Do not trace it
  to SVG — that flattens the gradient.
- Palette: neon on near-black, running **cyan → blue → violet → magenta → red → amber**.
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
(reachable), model `minimax_music3_high` (FP32 + BF16), `lyrics: local-codex-cli`,
`coverArt: "disabled"`, `hasServerKey: false`.

`coverArt: disabled` means the Covers screen must degrade honestly — show the real reason
from `/api/health` and a clear path to enable it. Do not fake a result and do not hide the
feature.

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
