# The MaxMusic lyric-video renderer

Turns a song into a kinetic-typography lyric video: one continuous dark world
— the venue from the cover art, rebuilt as live graphics — where the lyrics
are the scenography. Words land on their sung timestamps; everything else
moves on measured audio, so nothing can drift out of sync.

Zero npm dependencies, same as the app. The only tools it shells out to are
`ffmpeg` (decode, mux, encode) and a local Chromium — the same one
`capture.mjs` already drives.

## The pipeline

```
audio.flac ──▶ analyze.mjs ──▶ data/<song>-analysis.json   (bass/mid/high per frame, onsets, beats)
lyrics.json ─▶ align.mjs ───▶ data/<song>-timing.json     (word-level sung times)
                 ▲  whisper-cli (segments + words passes)
stage.html + engine.mjs ◀── both JSONs, deterministic paint(frame)
render.mjs ──▶ headless Chromium ──▶ ffmpeg ──▶ out/<song>.mp4
```

1. **`analyze.mjs`** — decodes the track with ffmpeg and measures it: RMS,
   per-band energy (bass drives the beam and the pumps, highs drive sparkle),
   spectral-flux onsets, and a best-effort beat grid. AI-generated songs do
   not always hold a grid, so the stage leans on the envelopes — which are
   sample-accurate by construction — and treats beats as decoration.

2. **`align.mjs`** — marries the canonical lyric sheet to two whisper-cpp
   passes (`-m small.en`, segment + `-ml 1 -sow` word). Lines anchor to
   segments, words time inside their line's window, chant repeats split
   merged segments, and anything the ASR missed is interpolated inside its
   window. Refuses to emit a sheet with unanchored lines.

3. **`engine.mjs` + `stage.html`** — the stage. A pure function of frame
   number: seeded PRNG, no wall-clock, no Math.random, so a render is
   reproducible bit-for-bit. Scenes are templates keyed by section kind —
   chant slams, verse lockups (emphasis earned by how long a word is sung),
   the anthem plate that inverts on later choruses, a monospace verse for
   the source-reading lines, audio-reactive drops, the constellation outro
   where every sung line hangs in space, and a quiet endcard. Per-line
   `device` hints in the lyric sheet opt into bespoke treatments (the
   redaction bars, the crack).

4. **`render.mjs`** — drives Chromium over the DevTools protocol, seeks the
   stage one frame at a time, and pipes screenshots straight into ffmpeg,
   which muxes the track. ~35 fps capture on an M-series Mac, so a
   two-minute song renders in about two minutes.

## Rendering a song

```bash
# one-off setup per song
node render/analyze.mjs shots/showcase/open-source-must-win-v2.flac render/data/osmw-analysis.json
whisper-cli -m <model> -f <16k-mono.wav> -oj -of seg
whisper-cli -m <model> -f <16k-mono.wav> -ml 1 -sow -oj -of words
node render/align.mjs render/lyrics-osmw.json seg.json words.json render/data/osmw-timing.json

# the video
node render/render.mjs --song osmw --audio shots/showcase/open-source-must-win-v2.flac \
     --out render/out/osmw.mp4

# fast iteration: excerpts and stills
node render/render.mjs --song osmw --audio <flac> --from 24 --to 40 --out render/out/ex.mp4
node render/render.mjs --song osmw --stills "6,25.2,29,52.5" --outdir render/out/stills
```

Open `render/stage.html?song=osmw&dev` through any static server rooted at
the repo for a scrub bar.

## The gauntlet

The output is scored the same way the app's screens were: blind judges who
have never seen the code, given `judge-pack.sh`'s stills, contact sheet and
consecutive-frame filmstrips, scoring against the bar of official
label-released lyric videos — plus named defects. Losers come back with a
fix list. `shots/` holds the app-era verdicts; the video rounds live with
the session that ran them.

## Adding a song

1. Write `render/lyrics-<song>.json` — sections with `kind`
   (chant/verse/mono/pre/chorus/tag/instrumental), lines, optional `repeat`
   and per-line `device` hints. The engine needs no song-specific code;
   devices are data.
2. Run the pipeline above. The scenes derive from the timing (which
   sections exist, where the drops are, what the outro is).

## The director

Outputs must not all look alike. The aesthetic is data — a `style` block
in the lyric sheet — and something with taste has to write it per song.
Today that is a human or Claude; in the app it is the broker's LLM. The
contract:

**Input** — `direct.mjs`'s profile (tempo, punch, brightness, vocal
density, structure, a suggested motion value) plus the transcript:

```bash
node render/direct.mjs render/data/<song>-analysis.json render/data/<song>-timing.json
```

**Output** — the sheet's `style` block plus section kinds and devices:

- `world` — where the song lives (`venue`, `horizon`, more as they are
  built). A manifesto belongs in a room; a drive belongs under a sky.
- `display` / `text` / `textStyle` — the type voices. An anthem takes a
  condensed heavy; a mellow song can take an italic or a script face.
- `ink`, `dim`, `verseAccents`, `chorusAccents`, `titleAccent` — the
  palette, and its arc across the song if the verses travel.
- `motion` — the dial, 0 calm to 1 punchy. Start from the profile's
  suggestion, then listen: BPM alone calls a pounding half-time track
  mellow. Everything scales with it — word arrival speed, bass pumps,
  onset kicks, flash strength — so a slow jazz song must never pulse.
- devices (`crack: false`, per-line `redact`/`vanish`) — ONLY where the
  lyric earns them. A device firing on an unearned line reads as template.

Rules of thumb: slow + sparse → low motion, soft faces, long fades.
Bright/airy → cooler palette; bass-led → darker, warmer. Wall-to-wall
vocals → the arc must come from treatments (no drops to lean on). Long
instrumental stretches → the world carries them (drops, visualiser
moments). Never reuse the previous song's pack unchanged.

## The studio (in-app)

The app server mounts `/studio` — audio export and video jobs, all on this
machine. The Library's per-song menu drives it:

- **Download FLAC / Download MP3** — `GET /studio/audio?track=…&format=…`,
  streamed; MP3 is transcoded on the way out at 320k.
- **Make a lyric scroll** — the song's cover, softened, with the words
  gliding up on the sung timing and each word lifting to the accent as it
  is sung.
- **Make a lyric film** — the directed kinetic engine; `auto-direct.mjs`
  writes the sheet when no hand-authored one exists.

Jobs run one at a time (`POST /studio/video`, poll `GET /studio/video/:id`,
fetch `…/:id/file`). First video on a fresh machine downloads the
transcription model (~460 MB) into `render/models/` and keeps it.
