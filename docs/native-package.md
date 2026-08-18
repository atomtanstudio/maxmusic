# Native package design

The public distribution is deliberately a thin, reversible layer around the current app:

1. `scripts/setup-native.mjs` creates a private Python virtual environment and installs PyTorch plus the worker requirements.
2. `scripts/start-native.mjs` starts the worker and the existing Node server without a shell-specific command line.
3. `library-db.mjs` stores the browser ledger as JSON payloads in one SQLite file.
4. `public/js/library-sync.js` migrates an existing browser library into SQLite and mirrors later changes without changing the screen modules' synchronous storage contract.

Native media lives beside that database: generated audio is in `data/tracks/`, finished videos are in `data/videos/`, and temporary/resumable video-job metadata is in the SQLite `video_jobs` table with working files under `data/video-jobs/`. The media bytes are deliberately files, not database BLOBs.

## Song-ending safety

Music 3's `audio_duration` input is a maximum frame budget, not a command to cut at an exact timestamp. The native worker runs a semantic plan with the full five-minute completion window. The selected length remains a soft instruction in the structured caption; the first plan that emits the model's own end token is rendered once and accepted at its natural duration. MaxMusic does not roll alternate seeds merely to chase the slider value. It permits one planning-only alternate if the first plan reaches the ceiling without EOS, and it never synthesizes or publishes a ceiling-bound plan.

The application normalizes every vocal and instrumental arrangement so `[outro]` is the terminal section; an `[instrumental]` play-out belongs before it. After decoding, the worker separately inspects the real waveform boundary. A naturally quiet or clearly decaying ending is preserved unchanged. If substantial signal is still present, the worker applies a slow-then-late adaptive fade and adds 250 ms of silence; it removes no generated samples.

Vocal output is also checked with the bundled `faster-whisper` dependency on CPU, so Music 3 retains the GPU. The track is transcribed in 90-second windows and the final written lyric is compared near the audible end. This check is diagnostic rather than a publication gate: sung diction, reverb, and near-homophones make ASR too fallible to throw away an otherwise complete song. Instrumentals skip the lexical check. Semantic EOS and the acoustic boundary remain mandatory. Response fields `planCandidates`, `lyricCompletion`, `lyricCompletionPolicy`, `endingGuard`, `lyricCompletionPass`, and `acousticEndingPass` make the evidence auditable. The verifier model downloads into `HF_HOME` on the first vocal generation and is controlled by `MAXMUSIC_WHISPER_MODEL`, `MAXMUSIC_WHISPER_THREADS`, and `MAXMUSIC_WHISPER_TAIL_SECONDS`.

The current MiniMax Music 3 download is large: this verified install uses about 27 GB under `data/huggingface`, plus the Python environment and the roughly 465 MB Whisper model. Users should have about 30 GB free before the first start.

Video rendering needs `ffmpeg`. Lyric film/scroll timing reuses the private environment's bundled `faster-whisper`, so the no-Docker package has no separate Whisper CLI prerequisite. Speech recognition supplies timing evidence only: the aligner verifies that every authored lyric line and word reaches the timing sheet, and estimates timing for any phrase ASR could not name instead of silently deleting it.

The default renderer uses one FFmpeg graph for the cover, waveform, complete-line karaoke, audio, and MP4 output. It selects NVIDIA NVENC when available, VideoToolbox on macOS, and portable `libx264` otherwise. `MAXMUSIC_VIDEO_ENCODER` can name a specific encoder; `MAXMUSIC_FFMPEG` and `MAXMUSIC_FFPROBE` can point to custom binaries. This path does not need a browser.

The original frame-by-frame kinetic renderer is retained for hand-directed videos behind `MAXMUSIC_VIDEO_RENDERER=kinetic`. That optional mode needs a Chromium-family browser. On macOS it prefers Ego Lite when installed, then falls back to Chrome/Chromium/Edge/Brave. On Windows and Linux it checks common installation paths and `PATH`; `MAXMUSIC_BROWSER` supports a custom executable. The kinetic mode is visually richer but substantially slower because it captures a browser frame for every video frame.

The server only opens SQLite when `MAXMUSIC_DB` is set. The legacy proxy path and the current `start.sh` launcher therefore do not acquire a new database dependency.

## OpenAI account routing

`OPENAI_BACKEND_URL` is an optional server-side relay for the OAuth-aware
OpenAI account backend set with `OPENAI_BACKEND_URL`. It is intentionally a
URL for the MaxMusic backend, not the broker's private URL or a token-bearing
setting. With it enabled, the native server routes `/api/openai/*`,
`/api/lyrics`, `/api/cover-art`, and relative `/covers/...` media through that
backend. Music generation and the SQLite library remain local.

If it is absent, the native server keeps the local Ollama/OpenAI-compatible
lyric path and optional image endpoint. This precedence is explicit so a
machine cannot silently use a weaker local model when its operator selected an
authenticated account backend.

## Why SQLite

The library is one user's local collection, not a multi-user service. SQLite gives that collection transactions, a single backup file, and no database daemon. Node's built-in SQLite support avoids native npm modules that would need separate Windows, macOS, and Linux build chains.

## Backup and restore

Stop MaxMusic before copying `data/maxmusic.sqlite` and its `data/tracks/` directory. The database contains library metadata; the audio files are separate by design. A future release should add an explicit export/import command and a consistency check for missing track files.

## Current boundary

The native package makes the application and persistence portable. It does not prove that MiniMax Music 3 inference is fast or fully supported on every device family. CUDA is the intended primary path; this checkout has passed a short real-generation smoke test on Apple MPS using float32, while MPS and CPU remain experimental. MPS float16 is deliberately not the default because it produced silent output in testing. That distinction is kept visible in the setup output and README instead of being hidden behind a generic “ready” message.
