# Installing MaxMusic

MaxMusic makes songs on your own computer. Nothing is uploaded, there is no
account to create, and the only parts that talk to the internet are the ones
you deliberately turn on.

There are two ways to run the model that makes the music. Pick one:

- **[Diffusers](#route-a--diffusers-recommended)** — one setup command, weights
  download themselves. Start here.
- **[ComfyUI](#route-b--comfyui)** — use the ComfyUI you already have, with the
  MiniMax Music 3 files placed in its model folders.

Everything else in this guide — video, lyrics, artwork — is the same either
way.

---

## What you need

| | |
|---|---|
| **Node** | 22.13 or newer (24+ recommended) |
| **Python** | 3.10 or newer |
| **FFmpeg** | built with **libass**, for video and export |
| **GPU** | NVIDIA with CUDA is the intended path. Apple MPS and CPU run, but are experimental and slow |
| **Disk** | about 30 GB for the model cache, the Python environment, and the lyric-timing model |
| **RAM/VRAM** | MiniMax Music 3 is roughly 23 GB of weights. 24 GB of VRAM or more is comfortable; less will offload to system RAM and run slower |

FFmpeg must have libass or MaxMusic cannot draw lyrics or title cards. The
standard builds all include it:

```bash
brew install ffmpeg
```

```bash
sudo apt install ffmpeg
```

On Windows, use the gyan.dev **full** build. If you install it somewhere
unusual, point `MAXMUSIC_FFMPEG` at it. MaxMusic checks for libass before it
starts a render and tells you outright if it is missing, rather than failing
several hundred lines into an FFmpeg graph.

---

## Route A — Diffusers (recommended)

This route installs its own private Python environment and downloads the model
weights on first use. You do not need ComfyUI.

```bash
git clone https://github.com/atomtanstudio/maxmusic
cd maxmusic
cp .env.example .env
node scripts/setup-native.mjs
node scripts/start-native.mjs
```

Open <http://localhost:3020>.

The first song takes a while: the weights are downloading. They land in
`data/huggingface` and stay there. After that the worker keeps the model
resident for ten idle minutes, so a second take does not reload 23 GB.

`setup-native.mjs` installs the CUDA 12.8 PyTorch wheel on Windows and Linux.
For a CPU-only, ROCm, or older-CUDA machine, set the matching index first:

```bash
MAXMUSIC_TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu node scripts/setup-native.mjs
```

---

## Route B — ComfyUI

Use this if you already run ComfyUI and would rather keep one copy of the
weights. MaxMusic drives it over ComfyUI's own HTTP API and does not install
anything into it.

**1. ComfyUI needs MiniMax Music 3 support.** These node types are built into
recent ComfyUI — no custom nodes are required:

`MiniMaxMusic3TextEncode`, `EmptyMiniMaxMusic3LatentAudio`, `CLIPLoader` with
the `minimax` type, `UNETLoader`, `VAELoader`, `VAEDecodeAudio`,
`SaveAudioAdvanced`.

If your ComfyUI does not have them, update it. MaxMusic checks for
`MiniMaxMusic3TextEncode` at startup and reports exactly that if it is absent.

**2. Put the three model files in ComfyUI's model folders.** These are the
repackaged MiniMax Music 3 files ComfyUI's own Music 3 template uses. The
default paths MaxMusic asks for are:

| File | Goes in |
|---|---|
| `minimax_music3_dit_fp16.safetensors` | `ComfyUI/models/diffusion_models/minimax_music3/` |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | `ComfyUI/models/text_encoders/minimax_music3/` |
| `minimax_music3_dav.safetensors` | `ComfyUI/models/vae/minimax_music3/` |

If your files are named differently or live elsewhere under those folders,
override the names instead of renaming files:

```bash
MAXMUSIC_COMFY_DIFFUSION_MODEL=minimax_music3/your_dit.safetensors
MAXMUSIC_COMFY_TEXT_ENCODER=minimax_music3/your_text_encoder.safetensors
MAXMUSIC_COMFY_VAE=minimax_music3/your_dav.safetensors
```

**3. Point the worker at ComfyUI** in `.env`:

```bash
MAXMUSIC_RUNTIME=comfy
MAXMUSIC_COMFY_URL=http://127.0.0.1:8189
```

**4. Start ComfyUI, then MaxMusic:**

```bash
node scripts/setup-native.mjs
node scripts/start-native.mjs
```

The setup step is still needed on this route: MaxMusic's own Python
environment provides lyric timing for videos and the lyric-completion check
for songs. Pass `--skip-torch` if you would rather not install a second copy of
PyTorch, though CUDA lyric timing benefits from having it.

---

## Which machine does what

Music generation follows `WORKER_URL`. **Everything else runs inside the app's
own process** — song analysis, lyric timing, alignment, and the FFmpeg render
for both lyric videos and visualizers.

So pointing `WORKER_URL` at a GPU box moves the music there and leaves the
video work where the app is running. To put the whole pipeline on one GPU
machine, run the app on that machine:

```bash
HOST=0.0.0.0 node scripts/start-native.mjs
```

and open `http://<that-machine>:3020` from any browser on your network.
Nothing needs to be installed on the computer you are sitting at.
`HOST=0.0.0.0` publishes the app to every device on the network, so use it only
on a network you trust.

### Is it actually using the GPU?

Two stages decide whether a lyric video takes seconds or minutes, and both
accept a slower answer rather than failing. **Settings → Diagnostics** reports
what each one chose:

```text
video encoder ... h264_nvenc
video words ..... small on cuda (float16)
video subtitles . available
```

`libx264` or `on cpu` there means a fallback happened. Every finished video
also logs where its time went:

```text
[studio] film 4f1c2a90 finished in 41s · fetch 0.3s · analyse 1.1s ·
transcribe 6.2s · direct 0.2s · align 0.4s · render 32.8s ·
words on cuda · small float16 · video on h264_nvenc · fast-ffmpeg
```

Lyric timing on a CPU is the usual culprit; on a CUDA machine it is several
times quicker (measured on a 5090: 3.0s versus 16.8s for a four-minute song).

MaxMusic asks for the GPU first, but a driver is not enough. CTranslate2, which
runs Whisper, loads **cuBLAS and cuDNN at run time** — a machine can report a
CUDA device through the driver and have neither installed. `setup-native.mjs`
installs them wherever `nvidia-smi` is present. If lyric timing says `on cpu`
on a machine with an NVIDIA card, that is what is missing:

```bash
.maxmusic-venv/bin/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

MaxMusic checks the libraries actually load, and runs a second of silence
through the model before trusting the GPU, so a machine without them renders
slowly rather than failing partway through a video. To pin it either way:

```bash
MAXMUSIC_VIDEO_WHISPER_DEVICE=cuda   # or cpu
MAXMUSIC_WHISPER_DEVICE=cuda         # the song's lyric-completion check
```

---

## Optional: lyrics

**A song with vocals needs words, but MaxMusic does not need to write them.**
You can type or paste your own lyrics in Studio and never set any of this up.

If you want lyrics written for you, MaxMusic uses the first of these it finds:

**1. An OpenAI account already on this computer.** If you have signed in with
the Codex CLI and it holds an API key, or `OPENAI_API_KEY` is set in your
environment, MaxMusic uses it with no configuration at all. The credential is
read on the server, is never sent to the browser, and never appears in logs or
diagnostics.

A ChatGPT sign-in is *not* the same thing: that token is issued to the Codex
app, not to MaxMusic. Settings says so plainly when it finds one, so you are
not left wondering why an account you know you have is not being used.

**2. Any OpenAI-compatible endpoint.** Ollama, LM Studio, llama.cpp's server,
vLLM, or a hosted provider:

```bash
# a local model, no account and no key
LYRICS_URL=http://127.0.0.1:11434/v1
LYRICS_MODEL=qwen3:14b
LYRICS_API=ollama
```

```bash
# OpenAI directly
LYRICS_URL=https://api.openai.com/v1
LYRICS_MODEL=gpt-4o-mini
LYRICS_KEY=sk-...
```

**3. A server-side OpenAI account backend.** If you run one implementing
[BROKER.md](BROKER.md), set `OPENAI_BACKEND_URL` and it takes over the lyrics,
artwork, and sign-in routes. This is the OAuth path, and it exists for people
who already operate that service; it is not required and most installs will
never use it.

---

## Optional: cover art

Same credential rules. With an OpenAI key available, artwork is offered
automatically. Otherwise point `COVER_URL` at anything speaking the OpenAI
images API:

```bash
COVER_URL=https://api.openai.com/v1
COVER_MODEL=gpt-image-1
COVER_KEY=sk-...
```

Covers are only ever generated when you ask for one.

---

## What needs nothing at all

**Lyric videos and visualizers use no online service.** They are made from your
song file with FFmpeg and a local Whisper model. No OpenAI account, no key, no
internet. If a song has cover art, the video uses it as a background; if it
does not, the video draws an animated gradient instead.

Music generation is the same: the model runs on your hardware and needs no
account.

---

## Troubleshooting

**"This FFmpeg was built without libass"** — your FFmpeg cannot draw text.
Install one that can, or set `MAXMUSIC_FFMPEG` to it. See
[What you need](#what-you-need).

**"ComfyUI does not expose MiniMaxMusic3TextEncode"** — ComfyUI is running but
does not have MiniMax Music 3 support. Update it.

**"No answer from the model worker"** — the Python worker is not running.
Check the console the launcher is printing to. On the ComfyUI route, check
ComfyUI is up at `MAXMUSIC_COMFY_URL`.

**Songs come back much shorter than asked for** — this is the model deciding a
composition has resolved, and MaxMusic will not pad or trim a song to a number.
It plans several complete arrangements and renders the one nearest your
requested length; when none of them lands in the right range it says so on the
finished song. A longer lyric sheet is the most reliable way to get a longer
song.

**Videos got slower** — check Settings → Diagnostics for a CPU fallback. See
[Is it actually using the GPU?](#is-it-actually-using-the-gpu)

**Nothing changed after an update** — the app notices when the files underneath
an open tab have changed and offers to reload. If in doubt, reload the page.

---

Every setting mentioned here is listed with its default in
[.env.example](../.env.example).
