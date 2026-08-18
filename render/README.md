# The MaxMusic lyric-video renderers

MaxMusic has a fast production renderer and an optional kinetic renderer. The
default production path keeps every authored lyric line visible, highlights
words on their sung timestamps, and uses the machine's native video encoder.
The kinetic path builds a continuous live-graphics world for hand-directed
films, but takes longer because it captures one browser frame at a time.

There are no renderer npm dependencies. The default path only shells out to
`ffmpeg`/`ffprobe`; the optional kinetic path also needs local Chromium.

## The pipeline

```
audio.flac ──▶ analyze.mjs ──▶ data/<song>-analysis.json   (bass/mid/high per frame, onsets, beats)
lyrics.json ─▶ align.mjs ───▶ data/<song>-timing.json     (every authored line + word timing)
                 ▲  faster-whisper (timing evidence)
fast-render.mjs ──▶ ffmpeg (cover + waveform + ASS karaoke) ──▶ MP4

Optional kinetic path:
stage.html + engine.mjs ◀── analysis + timing, deterministic paint(frame)
render.mjs ──▶ headless Chromium ──▶ ffmpeg ──▶ MP4
```

1. **`analyze.mjs`** — decodes the track with ffmpeg and measures it: RMS,
   per-band energy (bass drives the beam and the pumps, highs drive sparkle),
   spectral-flux onsets, and a best-effort beat grid. AI-generated songs do
   not always hold a grid, so the stage leans on the envelopes — which are
   sample-accurate by construction — and treats beats as decoration.

2. **`align.mjs`** — marries the canonical lyric sheet to ASR timing evidence.
   Lines anchor to phrases, words time inside their line's window, and merged
   phrases are split back into their authored lines. ASR is never treated as
   the source of lyric content: a final coverage invariant requires every
   authored line and word to be present, estimating uncertain timing instead
   of deleting text.

3. **`engine.mjs` + `stage.html`** — the stage. A pure function of frame
   number: seeded PRNG, no wall-clock, no Math.random, so a render is
   reproducible bit-for-bit. Scenes are templates keyed by section kind —
   chant slams, verse lockups (emphasis earned by how long a word is sung),
   the anthem plate that inverts on later choruses, a monospace verse for
   the source-reading lines, audio-reactive drops, the constellation outro
   where every sung line hangs in space, and a quiet endcard. Per-line
   `device` hints in the lyric sheet opt into bespoke treatments (the
   redaction bars, the crack).

4. **`fast-render.mjs`** — builds the background, waveform, full-line ASS
   karaoke, audio, and output in one FFmpeg graph. It prefers NVENC on NVIDIA,
   VideoToolbox on macOS, and `libx264` elsewhere. This is the Studio default.

5. **`render.mjs`** — the optional kinetic renderer. It drives Chromium over
   the DevTools protocol, seeks the stage one frame at a time, and pipes
   screenshots into ffmpeg. Enable it with `MAXMUSIC_VIDEO_RENDERER=kinetic`.

## Rendering a song

```bash
# one-off setup per song
node render/analyze.mjs shots/showcase/open-source-must-win-v2.flac render/data/osmw-analysis.json
whisper-cli -m <model> -f <16k-mono.wav> -oj -of seg
whisper-cli -m <model> -f <16k-mono.wav> -ml 1 -sow -oj -of words
node render/align.mjs render/lyrics-osmw.json seg.json words.json render/data/osmw-timing.json

# the default fast video
node render/fast-render.mjs --audio shots/showcase/open-source-must-win-v2.flac \
     --timing render/data/osmw-timing.json --mode film --cover cover.png \
     --out render/out/osmw.mp4

# optional hand-directed kinetic video
node render/render.mjs --song osmw --audio shots/showcase/open-source-must-win-v2.flac \
     --out render/out/osmw-kinetic.mp4

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

### When a gap becomes a scene

Silence between two sung sections only earns its own scene — its own world,
a cut away and a cut back — when it is long enough to be an event in the
song. The thresholds live in `engine.mjs` where sections are stitched:

| gap | threshold | what happens |
|---|---|---|
| before the first line | 1.5s | title card |
| between sections | **5s** | drop / instrumental scene |
| after the last line | 2.5s | end card |

A mid-song gap under five seconds is a breath, not a break: the scene
already playing simply holds the frame through it. This was a real defect
— a song with 2.1–2.7s gaps between verses cut to the drop wall and back
three times, each for about two seconds, which reads as a fault in the
film rather than a choice. Raising only the mid-song number left every
genuine break (6.5s, 12s, 25s in the reference cut) exactly as it was.

## The studio (in-app)

The app server mounts `/studio` — audio export and video jobs, all on this
machine. The Library's per-song menu drives it:

- **Download FLAC / Download MP3** — `GET /studio/audio?track=…&format=…`,
  streamed; MP3 is transcoded on the way out at 320k.
- **Make a lyric video** — every authored line remains on screen while its
  sung words highlight. Songs without cover art use an animated color field
  instead of a blank background.
- **Make an audio visualizer** — a large, bright waveform over the cover or
  animated color field. Vocal songs require an explicit confirmation because
  this deliverable intentionally contains no lyric text.

The native default is `fast-render.mjs`, a single FFmpeg graph that uses NVENC
on supported NVIDIA machines, VideoToolbox on supported Macs, and `libx264`
elsewhere. Set `MAXMUSIC_VIDEO_RENDERER=kinetic` only for the slower browser-
captured directed engine.

Jobs run one at a time (`POST /studio/video`, poll `GET /studio/video/:id`,
fetch `…/:id/file`). Native installs reuse the private environment's
`faster-whisper` model. Finished videos live beside the SQLite library under
`data/videos/`; working files stay under `data/video-jobs/`.
