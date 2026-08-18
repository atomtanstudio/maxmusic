# MaxMusic

MaxMusic is a local-first front end for MiniMax Music 3. It keeps generated songs in a durable SQLite library and stores the audio beside the project, while leaving the model runtime as a replaceable HTTP worker.

**[Full installation guide →](docs/INSTALL.md)** — both model routes
(diffusers or your existing ComfyUI), what to install, and how to check that
the GPU is really being used.

## Quick start without Docker

Requirements:

- Node 22.13+ (Node 24+ recommended)
- Python 3.10+
- ffmpeg built with libass, for video and export features (the standard Homebrew, Debian/Ubuntu, and gyan.dev "full" builds all include it; a build without it cannot draw lyrics or title cards, and the renderer says so before starting)
- a Chromium-family browser (Chrome, Chromium, Edge, Brave, or Ego Lite) for video rendering
- hardware supported by the installed PyTorch build for local generation

From the project directory:

```sh
cp .env.example .env
node scripts/setup-native.mjs
node scripts/start-native.mjs
```

Open <http://localhost:3020>. The first worker start downloads the model weights into `data/huggingface`; plan on roughly 30 GB of free disk space for the current cache, virtual environment, and Whisper model. Generated audio goes into `data/tracks`, finished videos into `data/videos`, and the library is `data/maxmusic.sqlite`. These runtime files are ignored by Git. The renderer prefers Ego Lite on macOS and discovers Chrome/Chromium/Edge/Brave from common Windows, macOS, and Linux locations or from `PATH`.

Lyric-video timing reuses the private environment's bundled `faster-whisper`; there is no separate Whisper installation. Custom or legacy launches may set `MAXMUSIC_VIDEO_PYTHON` to another environment containing `faster-whisper`, or retain an existing `whisper-cli` through `MAXMUSIC_WHISPER_CLI`.

The worker keeps Music 3 resident for ten idle minutes so a recovery or a two-take request does not reload the model between songs. Set `MAXMUSIC_IDLE_RELEASE_SECONDS` to another value (`0` means keep it resident), or send `POST /release` to the worker when another GPU workload needs the memory immediately. A release request is refused while a song is actively rendering.

MiniMax Music 3 natively treats duration as a maximum frame budget, not an exact stopping time. MaxMusic uses the selected length as creative guidance in the structured caption and gives the semantic planner the model's full completion window, so the length control can never become a guillotine. It never hard-trims a song to the slider value.

The selected length still has to mean something. Semantic planning stops before the expensive denoise and decode passes, so the worker runs up to four of those cheap plans on deterministic alternate seeds and synthesizes only the one that both ended on its own and landed within a quarter of the requested length — never less than fifteen seconds of slack, so short songs are not held to an impossible standard. The first plan inside that band wins immediately, which is the common case and costs nothing extra. When no plan lands inside it, the closest complete composition is published and the app says plainly what was asked for and what arrived; nothing is trimmed, padded, or silently re-rendered. A ceiling-bound plan is never synthesized or published.

An end token alone does not prove that the decoded waveform reached a quiet boundary. The bundled worker makes `[outro]` the final section, inspects the actual final audio, and publishes only a waveform that already decays safely or has received a gentle adaptive fade with no generated samples removed. Vocal takes also receive a local CPU Whisper transcript, but that evidence is advisory: sung diction and effects can turn words such as “chord” into “core,” so ASR can never discard a semantically and acoustically complete song. This verifier does not write lyrics or replace the configured OpenAI OAuth features. The API reports the semantic plan, lyric-completion evidence, and acoustic-ending result for auditing. This integration relies on the Diffusers commit pinned in `worker/requirements.txt` and fails clearly during model load if that sampler contract changes.

No Docker installation is required for this path. The existing files under `worker/` still contain the container route for operators who prefer it.

## Hardware reality

The UI, SQLite library, and remote-worker mode are designed to run on Windows, macOS, and Linux. CUDA is the intended primary path. This checkout has also passed a short real-generation smoke test on Apple MPS using float32; MPS and CPU remain experimental and may be slow or fail on a particular machine. The native launcher requests `MAXMUSIC_DEVICE=auto`, but that does not remove the model's hardware and memory requirements. MPS float16 is not the default because it produced silent output in testing.

If the model machine is separate, leave the UI on one computer and point it at the worker:

```sh
WORKER_URL=http://worker-host:3011 MAXMUSIC_START_WORKER=0 node scripts/start-native.mjs
```

On PowerShell, set the same variables with `$env:WORKER_URL = "http://worker-host:3011"` and `$env:MAXMUSIC_START_WORKER = "0"` before running the command.

Note what that split does and does not move. `WORKER_URL` relocates music generation only. Song analysis, Whisper lyric timing, alignment, and the FFmpeg render for both lyric videos and visualizers all run inside the app's own process, on the machine that runs `scripts/start-native.mjs`. To put the whole pipeline on one GPU machine, run the app there with `HOST=0.0.0.0` and open `http://<that-machine>:3020` from any browser on the network — nothing needs to be installed on the computer you are sitting at. `HOST=0.0.0.0` publishes the app to every device on the network, so use it only on a network you trust.

## Optional services

**Lyric videos and visualizers use no online service.** They are made from your
song file with FFmpeg and a local Whisper model. Music generation needs no
account either. The optional parts are writing lyrics for you and making cover
art, and there are three ways to have them:

1. **An OpenAI account already on this computer.** `OPENAI_API_KEY` in the
   environment, or an API key stored by the Codex CLI, is picked up with no
   configuration. It is read on the server, never reaches the browser, and
   never appears in logs or diagnostics. A ChatGPT sign-in is recognised but
   deliberately not used — that token is issued to the Codex app, not to
   MaxMusic — and Settings says so rather than leaving you guessing.
2. **Any OpenAI-compatible endpoint.** Ollama, LM Studio, llama.cpp, vLLM, or a
   hosted provider, through `LYRICS_URL` / `LYRICS_MODEL` / `LYRICS_KEY`. Ollama
   needs no account and no key.
3. **A server-side OpenAI account backend**, set with `OPENAI_BACKEND_URL`.
   MaxMusic relays account status, sign-in, lyrics and cover-art requests to it
   and the browser never sees a token. This is the OAuth path; it exists for
   people who already run such a service and most installs will never need it.
   When set, it takes precedence over the above.

You can also write or paste lyrics in Studio and skip all of it. The native
launcher loads `.env.local` and `.env`; see [.env.example](.env.example) for
every supported setting.

The model weights are downloaded by Hugging Face at runtime and are not included in this repository. Before publishing a release, review the source model and dependency licenses separately from the application license.

## Existing compatibility path

The original `node server.js` and `start.sh` behavior remains available. If `WORKER_URL` and `MAXMUSIC_DB` are not set, the app continues to use the existing backend proxy and browser-local library exactly as before. The native path is deliberately additive.
