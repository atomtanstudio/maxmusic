/**
 * The studio: the app server's side of audio export and video rendering.
 *
 * Everything runs on this machine — the same ffmpeg, whisper-cpp and
 * Chromium the render pipeline already uses — so nothing here depends on
 * the Legion patch that never went live. The browser talks to three
 * things:
 *
 *   GET  /studio/audio?track=/tracks/x.flac&format=mp3&name=Title
 *        streams the song as a download, transcoding when asked
 *   POST /studio/video   { trackUrl, mode: 'scroll'|'film', title, artist,
 *                          lyrics, cover }
 *   GET  /studio/video/<id>          status
 *   GET  /studio/video/<id>/file     the finished MP4
 *   DELETE /studio/video/<id>        cancel
 *
 * Nothing the browser sends becomes an argument: trackUrl and cover are
 * reduced to basenames under their fixed prefixes, every spawn uses a
 * fixed argv with shell:false, and job ids are our own UUIDs.
 *
 * @module render/jobs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assFilterMissing, chooseEncoder } from './fast-render.mjs';

const RENDER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(RENDER_DIR);
const NATIVE_DATA_DIR = process.env.MAXMUSIC_DATA ? path.resolve(process.env.MAXMUSIC_DATA) : null;
const JOBS_DIR = NATIVE_DATA_DIR
  ? path.join(NATIVE_DATA_DIR, 'video-jobs')
  : path.join(RENDER_DIR, 'out', 'jobs');
// Native packages keep temporary timing/analysis beside the SQLite library,
// not inside the source tree (which may be read-only after installation).
// render.mjs maps the stage's `/render/data/...` requests to this same path.
const DATA_DIR = process.env.MAXMUSIC_RENDER_DATA
  ? path.resolve(process.env.MAXMUSIC_RENDER_DATA)
  : NATIVE_DATA_DIR
    ? path.join(NATIVE_DATA_DIR, 'render-data')
    : path.join(RENDER_DIR, 'data');
const MODEL = NATIVE_DATA_DIR
  ? path.join(NATIVE_DATA_DIR, 'models', 'ggml-small.en.bin')
  : path.join(RENDER_DIR, 'models', 'ggml-small.en.bin');
const VIDEO_DIR = NATIVE_DATA_DIR
  ? path.join(NATIVE_DATA_DIR, 'videos')
  : path.join(RENDER_DIR, 'out', 'videos');
const LEGACY_VIDEO_DIR = path.join(RENDER_DIR, 'out', 'videos');
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin';
const VIDEO_TRANSCRIBER = path.join(REPO, 'scripts', 'video-transcribe.py');
const FAST_RENDERER = path.join(RENDER_DIR, 'fast-render.mjs');

const JOB_TTL_MS = 60 * 60 * 1000;
const TITLE_MAX = 160;
const LYRICS_MAX = 20000;

// Native packages keep writable runtime data outside the source tree. Create
// every renderer-owned directory here as well as in the launcher: server.js
// can be started directly, and a missing analysis directory must never turn a
// perfectly readable song into a failed video job.
for (const dir of [JOBS_DIR, DATA_DIR, VIDEO_DIR, path.dirname(MODEL)]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** @type {Map<string, object>} */
const jobs = new Map();
const queue = [];
let running = false;
let nextCdpPort = 9401;
let libraryDbStore = null;

function durableJob(job) {
  return {
    id: job.id,
    trackId: job.trackId || null,
    requestedMode: job.requestedMode || job.mode,
    mode: job.mode,
    visualizerConfirmed: Boolean(job.visualizerConfirmed),
    status: job.status,
    step: job.step,
    progress: job.progress,
    error: job.error,
    trackUrl: job.trackUrl,
    cover: job.cover,
    title: job.title,
    artist: job.artist,
    lyrics: job.lyrics,
    dir: job.dir,
    outFile: job.outFile,
    filename: job.filename,
    publicUrl: job.publicUrl || null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    proc: null,
  };
}

function persistJob(job) {
  if (!libraryDbStore?.saveVideoJob) return;
  try {
    libraryDbStore.saveVideoJob(durableJob(job));
  } catch (error) {
    console.error('[studio] could not persist video job:', error.message);
  }
}

/**
 * Attach the native SQLite store after server.js opens it. Jobs that were
 * active during a previous process are marked interrupted rather than being
 * presented as if they could resume after their child processes disappeared.
 */
export function configureStudio({ libraryDb = null } = {}) {
  libraryDbStore = libraryDb;
  if (!libraryDbStore?.listVideoJobs) return;
  for (const saved of libraryDbStore.listVideoJobs()) {
    if (!saved?.id || jobs.has(saved.id)) continue;
    const job = { timings: {}, hardware: {}, ...saved, proc: null };
    if (job.status === 'queued' || job.status === 'working') {
      job.status = 'failed';
      job.step = 'Stopped after the app restarted';
      job.error = 'The app restarted before this video finished. Start it again to make a new render.';
      job.finishedAt = Date.now();
      persistJob(job);
    }
    jobs.set(job.id, job);
    if (job.status === 'completed' && job.trackId && job.publicUrl && job.filename && libraryDbStore.recordVideo) {
      try {
        libraryDbStore.recordVideo({
          trackId: job.trackId,
          mode: job.mode,
          url: job.publicUrl,
          filename: job.filename,
          at: job.finishedAt || job.createdAt,
        });
      } catch (error) {
        console.error('[studio] could not reconcile finished video:', error.message);
      }
    }
  }
}

/* -------------------------------------------------------------- utilities */

const safeName = (s) => String(s || 'song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'song';

/** Section tags alone are structure, not lyric text. */
export function hasAuthoredLyrics(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[[^\]]+\]\s*$/.test(line))
    .join(' ')
    .trim().length > 0;
}

/**
 * Recover the durable lyric sheet when a stale browser sends an empty copy.
 * The database is authoritative for an already-saved song.
 */
export function resolveJobLyrics(supplied, trackId, store = libraryDbStore) {
  const incoming = String(supplied || '').slice(0, LYRICS_MAX);
  if (hasAuthoredLyrics(incoming) || !trackId || !store?.list) return incoming;
  try {
    const record = store.list().find((item) => String(item?.id) === String(trackId));
    if (!record || record.isInstrumental) return incoming;
    const durable = String(record.lyrics || '').slice(0, LYRICS_MAX);
    return hasAuthoredLyrics(durable) ? durable : incoming;
  } catch {
    return incoming;
  }
}

/**
 * Old/stale clients did not distinguish an intentional no-lyrics visualizer
 * from a mistaken adjacent-menu click. For a vocal song, unconfirmed
 * `visualizer` therefore fails safe to the lyric video. Updated clients send
 * an explicit confirmation only after explaining that lyric text is omitted.
 */
export function resolveVideoMode(requestedMode, lyrics, visualizerConfirmed = false) {
  if (requestedMode === 'visualizer' && hasAuthoredLyrics(lyrics) && visualizerConfirmed !== true) {
    return 'film';
  }
  return requestedMode;
}

/** Resolve an executable without invoking a shell. */
export function findExecutable(command) {
  const value = String(command || '').trim();
  if (!value) return null;
  const hasPath = path.isAbsolute(value) || value.includes('/') || value.includes('\\');
  const roots = hasPath ? [''] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')]
    : [''];
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = hasPath ? `${value}${extension}` : path.join(root, `${value}${extension}`);
      try {
        fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function nativePython() {
  const venv = process.env.MAXMUSIC_VENV
    ? path.resolve(process.env.MAXMUSIC_VENV)
    : path.join(REPO, '.maxmusic-venv');
  const privatePython = process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
  const candidates = [
    process.env.MAXMUSIC_VIDEO_PYTHON,
    process.env.MAXMUSIC_PYTHON,
    privatePython,
  ];
  for (const candidate of candidates) {
    const executable = findExecutable(candidate);
    if (executable) return executable;
  }
  return null;
}

function whisperCli() {
  return findExecutable(process.env.MAXMUSIC_WHISPER_CLI || 'whisper-cli');
}

/** One answer for where FFmpeg is, so `MAXMUSIC_FFMPEG` means it everywhere. */
export function ffmpegBin() {
  return findExecutable(process.env.MAXMUSIC_FFMPEG || 'ffmpeg') || 'ffmpeg';
}

export function ffprobeBin() {
  if (process.env.MAXMUSIC_FFPROBE) return findExecutable(process.env.MAXMUSIC_FFPROBE) || process.env.MAXMUSIC_FFPROBE;
  const ffmpeg = process.env.MAXMUSIC_FFMPEG && findExecutable(process.env.MAXMUSIC_FFMPEG);
  if (ffmpeg) {
    const beside = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (findExecutable(beside)) return beside;
  }
  return findExecutable('ffprobe') || 'ffprobe';
}

function findVideoFile(name) {
  const filename = path.basename(decodeURIComponent(String(name || '')));
  if (!filename || filename === '.' || filename === '..') return null;
  const roots = [...new Set([VIDEO_DIR, LEGACY_VIDEO_DIR])];
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const file = path.resolve(root, filename);
    if (!file.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(file)) continue;
    return file;
  }
  return null;
}

/** `/tracks/<basename>` or `/covers/<basename>` only — anything else is refused. */
function mediaPath(url, prefix) {
  if (typeof url !== 'string' || !url.startsWith(`/${prefix}/`)) return null;
  const name = path.basename(url.slice(prefix.length + 2));
  if (!name || name === '.' || name === '..') return null;
  return `/${prefix}/${name}`;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Where a media URL might already be on this machine.
 *
 * Two cases: the sleeves shipped in `public/samples`, which are not on the
 * worker at all, and a tracks directory this app shares with the worker. A
 * copy beats a round trip, and it is the only thing that works when the worker
 * is on another machine and the file is a local one.
 */
function localMedia(urlPath) {
  const url = String(urlPath || '');
  const candidates = [];
  if (url.startsWith('/samples/')) {
    candidates.push(path.join(REPO, 'public', 'samples', path.basename(url)));
  }
  if (url.startsWith('/tracks/')) {
    const tracks = process.env.MAXMUSIC_TRACKS
      || (NATIVE_DATA_DIR ? path.join(NATIVE_DATA_DIR, 'tracks') : null);
    if (tracks) candidates.push(path.join(tracks, path.basename(url)));
  }
  return candidates.find((file) => fs.existsSync(file)) || null;
}

/** Fetch a backend media file to disk, or copy it if it is already here. */
function fetchToFile(backend, urlPath, dest) {
  const here = localMedia(urlPath);
  if (here) return fsp.copyFile(here, dest);
  return fetchOverHttp(backend, urlPath, dest);
}

function fetchOverHttp(backend, urlPath, dest) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: backend.host, port: backend.port, path: urlPath }, (up) => {
      if (up.statusCode !== 200) {
        up.resume();
        reject(new Error(`The song file could not be fetched (HTTP ${up.statusCode}). Is the backend running?`));
        return;
      }
      const out = fs.createWriteStream(dest);
      up.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', () => reject(new Error('The backend is not answering, so the song file could not be fetched.')));
  });
}

/** Pull the useful exception out of a Node/ffmpeg stderr tail. */
export function childFailureMessage(stderr, fallback) {
  const lines = String(stderr || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const exception = lines.find((line) => /^(?:Error|[A-Za-z]+Error):\s+/.test(line));
  if (exception) return exception.replace(/^(?:Error|[A-Za-z]+Error):\s+/, '').slice(0, 500);

  const useful = lines.filter((line) => (
    !/^Node\.js v\d/i.test(line)
    && !/^at\s/.test(line)
    && !/^[{}]$/.test(line)
    && !/^\^+$/.test(line)
    && !/^(?:errno|code|syscall|path):/.test(line)
    && !/^node:internal\//.test(line)
  ));
  return useful.slice(-3).join(' ').slice(0, 500) || fallback;
}

/** Last complete frame counter from a renderer stdout chunk. */
/**
 * Read the hardware a stage announced, so a slow video can be explained
 * instead of guessed at. The transcriber prints its device and the renderer
 * prints its encoder; both are the difference between seconds and minutes on
 * a machine with a supported NVIDIA card.
 */
export function stageHardware(output) {
  const text = String(output || '');
  const transcriber = text.match(/transcriber\s+(\S+)\s+on\s+(\S+)\s+\(([^)]+)\)/);
  if (transcriber) {
    return { stage: 'transcribe', device: transcriber[2], detail: `${transcriber[1]} ${transcriber[3]}` };
  }
  const renderer = text.match(/renderer\s+(\S+)\s+·\s+encoder\s+(\S+)/);
  if (renderer) return { stage: 'render', device: renderer[2], detail: renderer[1] };
  return null;
}

export function rendererFrameProgress(output) {
  const matches = [...String(output || '').matchAll(/frame (\d+)\/(\d+)/g)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const complete = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(complete) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, complete / total));
}

/** Run a short child process and collect its stdout. */
function capture(bin, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { shell: false, cwd: REPO });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${path.basename(bin)} exited ${code}`));
    });
  });
}

/** Run a child process, resolving on exit 0. */
function run(bin, argv, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { shell: false, cwd: REPO });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 6000) err = err.slice(-6000); });
    p.stdout.on('data', (d) => { if (onStdout) onStdout(String(d)); });
    p.on('error', (e) => reject(new Error(`${path.basename(bin)} could not start: ${e.message}`)));
    p.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(childFailureMessage(err, `${path.basename(bin)} exited ${signal || code}`)));
    });
    if (onStdout) p.job_proc = p;
    return p;
  });
}

/** Same as run(), but the job can cancel it. */
function runCancellable(job, bin, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { shell: false, cwd: REPO });
    job.proc = p;
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 6000) err = err.slice(-6000); });
    p.stdout.on('data', (d) => { if (opts.onStdout) opts.onStdout(String(d)); });
    p.on('error', (e) => { job.proc = null; reject(new Error(`${path.basename(bin)} could not start: ${e.message}`)); });
    p.on('close', (code, signal) => {
      job.proc = null;
      if (job.status === 'cancelled') { reject(new Error('cancelled')); return; }
      if (code === 0) resolve();
      else reject(new Error(childFailureMessage(err, `${path.basename(bin)} exited ${signal || code}`)));
    });
  });
}

/**
 * What this machine will actually use to make a video, asked once and cached.
 *
 * "The video got slower" is nearly always one stage that quietly fell back to
 * the CPU, and nobody should have to render a whole song to find that out.
 */
let capabilityCache = null;
export function videoCapabilities({ refresh = false } = {}) {
  if (capabilityCache && !refresh) return capabilityCache;
  capabilityCache = (async () => {
    const ffmpeg = ffmpegBin();
    const [encoders, filters, words] = await Promise.all([
      capture(ffmpeg, ['-hide_banner', '-encoders']).catch(() => ''),
      capture(ffmpeg, ['-hide_banner', '-filters']).catch(() => ''),
      (async () => {
        const python = nativePython();
        if (!python || !fs.existsSync(VIDEO_TRANSCRIBER)) {
          return whisperCli() ? { installed: true, device: 'cpu', model: 'whisper-cli' } : { installed: false };
        }
        try {
          return JSON.parse(await capture(python, [VIDEO_TRANSCRIBER, '--probe']));
        } catch {
          return { installed: false };
        }
      })(),
    ]);
    const kinetic = String(process.env.MAXMUSIC_VIDEO_RENDERER || '').toLowerCase() === 'kinetic';
    const requested = process.env.MAXMUSIC_VIDEO_ENCODER || 'auto';
    return {
      renderer: kinetic ? 'kinetic-browser' : 'fast-ffmpeg',
      ffmpeg,
      encoder: chooseEncoder(encoders, requested),
      encoderRequest: requested,
      subtitles: !assFilterMissing(filters),
      words,
    };
  })();
  return capabilityCache;
}

/** The transcription model, fetched once and kept. */
async function ensureModel(job) {
  if (fs.existsSync(MODEL)) return;
  job.step = 'Fetching the transcription model — one time, about 460 MB';
  await fsp.mkdir(path.dirname(MODEL), { recursive: true });
  const tmp = `${MODEL}.part`;
  await new Promise((resolve, reject) => {
    const get = (url, redirects = 0) => {
      if (redirects > 5) { reject(new Error('The model download kept redirecting.')); return; }
      https.get(url, (up) => {
        if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
          up.resume();
          get(up.headers.location, redirects + 1);
          return;
        }
        if (up.statusCode !== 200) { up.resume(); reject(new Error(`Model download failed (HTTP ${up.statusCode}).`)); return; }
        const total = Number(up.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(tmp);
        up.on('data', (d) => {
          got += d.length;
          if (total) job.progress = (got / total) * 0.1; // first tenth of the bar
        });
        up.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    };
    get(MODEL_URL);
  });
  await fsp.rename(tmp, MODEL);
}

/**
 * Produce the segment and word JSON consumed by align.mjs. Native installs
 * already carry faster-whisper for song verification, so reuse that private
 * environment and keep whisper-cli only as a compatibility fallback for older
 * direct launches.
 */
async function transcribeForVideo(job, wav, dir) {
  const python = nativePython();
  if (python && fs.existsSync(VIDEO_TRANSCRIBER)) {
    job.step = 'Listening for the words';
    job.progress = 0.18;
    await runCancellable(job, python, [
      VIDEO_TRANSCRIBER,
      '--audio', wav,
      '--segments', path.join(dir, 'seg.json'),
      '--words', path.join(dir, 'words.json'),
    ], {
      onStdout: (chunk) => {
        const found = stageHardware(chunk);
        if (found?.stage === 'transcribe') job.hardware.transcribe = `${found.device} · ${found.detail}`;
      },
    });
    job.progress = 0.3;
    return;
  }

  const cli = whisperCli();
  if (cli) {
    await ensureModel(job);
    job.step = 'Listening for the words';
    job.hardware.transcribe = 'whisper-cli · cpu';
    job.progress = 0.18;
    await runCancellable(job, cli, ['-m', MODEL, '-f', wav, '-oj', '-of', path.join(dir, 'seg'), '-np']);
    job.progress = 0.3;
    await runCancellable(job, cli, ['-m', MODEL, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', path.join(dir, 'words'), '-np']);
    return;
  }

  throw new Error(
    'Lyric timing is not installed. Run node scripts/setup-native.mjs, '
    + 'or set MAXMUSIC_VIDEO_PYTHON to a Python environment containing faster-whisper.',
  );
}

/* ------------------------------------------------------------- the worker */

function publicJob(job) {
  const body = {
    id: job.id,
    mode: job.mode,
    status: job.status,
    step: job.step,
    progress: Number((job.progress || 0).toFixed(3)),
    statusUrl: `/studio/video/${job.id}`,
  };
  if (job.status === 'completed') {
    body.downloadUrl = job.publicUrl || `/studio/video/${job.id}/file`;
    body.filename = job.filename;
  }
  if (job.error) body.error = job.error;
  return body;
}

/** Stage timings, so "the video got slower" is a measurement, not a feeling. */
function stopwatch(job) {
  return async (name, run) => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      job.timings[name] = Math.round((Date.now() - started) / 100) / 10;
    }
  };
}

async function work(job, backend) {
  const d = job.dir;
  const flac = path.join(d, 'song.flac');
  const wav = path.join(d, 'song16k.wav');
  const sheet = path.join(d, 'sheet.json');
  const lyricsTxt = path.join(d, 'lyrics.txt');
  const dataAnalysis = path.join(DATA_DIR, `job-${job.id}-analysis.json`);
  const dataTiming = path.join(DATA_DIR, `job-${job.id}-timing.json`);
  let coverFile = null;

  const time = stopwatch(job);
  const jobStarted = Date.now();

  job.status = 'working';
  job.step = 'Fetching the song';
  job.progress = 0.02;
  await time('fetch', () => fetchToFile(backend, job.trackUrl, flac));

  // Artwork is optional. Keep a private local copy for FFmpeg so rendering
  // never depends on a browser being able to reach another service.
  if (job.cover) {
    const extension = path.extname(job.cover).toLowerCase();
    coverFile = path.join(d, `cover${/^\.(?:png|jpe?g|webp)$/.test(extension) ? extension : '.png'}`);
    try {
      await fetchToFile(backend, job.cover, coverFile);
    } catch (error) {
      coverFile = null;
      console.warn(`[studio] cover unavailable for ${job.id}: ${error.message}`);
    }
  }

  // A lyric request is never silently downgraded to a no-text visualizer.
  // Request validation normally catches this before the job is queued.
  if (job.mode !== 'visualizer' && !hasAuthoredLyrics(job.lyrics)) {
    throw new Error('This song has no written lyrics to put in a lyric video.');
  }

  job.step = 'Reading the song';
  job.progress = 0.12;
  await time('analyse', () => runCancellable(
    job, process.execPath, [path.join(RENDER_DIR, 'analyze.mjs'), flac, dataAnalysis],
  ));

  const direct = async () => {
    const directArgs = [
      path.join(RENDER_DIR, 'auto-direct.mjs'),
      '--mode', job.mode,
      '--analysis', dataAnalysis,
      '--out', sheet,
      '--title', job.title,
      '--artist', job.artist,
      '--seed', path.basename(job.trackUrl),
    ];
    if (job.mode !== 'visualizer') directArgs.push('--segments', path.join(d, 'seg.json'));
    if (job.lyrics && job.mode !== 'visualizer') directArgs.push('--lyrics', lyricsTxt);
    if (job.cover) directArgs.push('--cover', job.cover);
    await runCancellable(job, process.execPath, directArgs);
  };

  if (job.mode === 'visualizer') {
    job.step = 'Directing';
    job.progress = 0.4;
    await time('direct', () => direct());
    await fsp.copyFile(sheet, dataTiming); // a visualizer sheet IS its timing
  } else {
    job.step = 'Listening for the words';
    job.progress = 0.18;
    await time('transcribe', async () => {
      await runCancellable(job, ffmpegBin(), ['-v', 'error', '-y', '-i', flac, '-ar', '16000', '-ac', '1', wav]);
      await transcribeForVideo(job, wav, d);
    });

    job.step = 'Directing';
    job.progress = 0.42;
    if (job.lyrics) await fsp.writeFile(lyricsTxt, job.lyrics);
    await time('direct', () => direct());

    job.step = 'Timing the lyrics';
    try {
      await time('align', () => runCancellable(job, process.execPath, [
        path.join(RENDER_DIR, 'align.mjs'), sheet, path.join(d, 'seg.json'), path.join(d, 'words.json'), dataTiming,
        '--keep-all', '--analysis', dataAnalysis,
      ]));
    } catch (err) {
      throw new Error(`The complete lyric sheet could not be timed: ${err.message}`);
    }
  }

  job.step = 'Rendering';
  job.progress = 0.45;
  const kinetic = String(process.env.MAXMUSIC_VIDEO_RENDERER || '').toLowerCase() === 'kinetic';
  const renderArgs = kinetic
    ? [
        path.join(RENDER_DIR, 'render.mjs'),
        '--song', `job-${job.id}`,
        '--audio', flac,
        '--out', path.relative(REPO, job.outFile),
        '--port', String(nextCdpPort++),
      ]
    : [
        FAST_RENDERER,
        '--audio', flac,
        '--timing', dataTiming,
        '--mode', job.mode,
        '--out', job.outFile,
        '--ffmpeg', ffmpegBin(),
        '--ffprobe', ffprobeBin(),
        ...(coverFile ? ['--cover', coverFile] : []),
      ];
  await time('render', () => runCancellable(job, process.execPath, renderArgs, {
    onStdout: (s) => {
      const frameProgress = rendererFrameProgress(s);
      if (frameProgress !== null) job.progress = 0.45 + 0.54 * frameProgress;
      const found = stageHardware(s);
      if (found?.stage === 'render') job.hardware.render = `${found.device} · ${found.detail}`;
    },
  }));

  const stat = await fsp.stat(job.outFile);
  if (!stat.size) throw new Error('The render finished but produced no file.');

  // The finished video moves to the keep — the job directory is swept in an
  // hour, but the video belongs to the song now, downloadable whenever.
  const store = VIDEO_DIR;
  await fsp.mkdir(store, { recursive: true });
  const publicName = `${safeName(job.title)}-${{ film: 'lyric-video', scroll: 'lyric-scroll', visualizer: 'visualizer' }[job.mode]}-${job.id.slice(0, 8)}.mp4`;
  await fsp.copyFile(job.outFile, path.join(store, publicName));
  job.publicUrl = `/studio/videos/${encodeURIComponent(publicName)}`;
  job.filename = publicName;

  job.progress = 1;
  job.status = 'completed';
  job.step = 'Done';
  job.finishedAt = Date.now();
  console.log(
    `[studio] ${job.mode} ${job.id.slice(0, 8)} finished in `
    + `${Math.round((Date.now() - jobStarted) / 1000)}s · `
    + Object.entries(job.timings).map(([name, seconds]) => `${name} ${seconds}s`).join(' · ')
    + (job.hardware.transcribe ? ` · words on ${job.hardware.transcribe}` : '')
    + (job.hardware.render ? ` · video on ${job.hardware.render}` : ''),
  );
  persistJob(job);
  if (libraryDbStore?.recordVideo && job.trackId) {
    try {
      libraryDbStore.recordVideo({
        trackId: job.trackId,
        mode: job.mode,
        url: job.publicUrl,
        filename: job.filename,
        at: job.finishedAt,
      });
    } catch (error) {
      console.error('[studio] could not persist finished video:', error.message);
    }
  }
}

function pump(backend) {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') { pump(backend); return; }
  running = true;
  work(job, backend)
    .catch((err) => {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.error = err.message === 'cancelled'
          ? 'Cancelled.'
          : `${job.step || 'The render'} stopped: ${err.message}`;
        job.finishedAt = Date.now();
        persistJob(job);
      }
    })
    .finally(() => {
      running = false;
      // The per-song data files are only needed during the render.
      for (const f of [path.join(DATA_DIR, `job-${job.id}-analysis.json`), path.join(DATA_DIR, `job-${job.id}-timing.json`)]) {
        fsp.rm(f, { force: true }).catch(() => {});
      }
      pump(backend);
    });
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.finishedAt || now - job.finishedAt < JOB_TTL_MS) continue;
    fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();

/* ----------------------------------------------------------- HTTP surface */

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('Body too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * Handle a /studio request. Returns true when the request was handled.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{host: string, port: number}} backend
 */
export function handleStudio(req, res, backend) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (!pathname.startsWith('/studio/')) return false;

  // ---- audio download, streaming, optional transcode ----
  if (pathname === '/studio/audio' && req.method === 'GET') {
    const track = mediaPath(url.searchParams.get('track'), 'tracks');
    const format = url.searchParams.get('format') === 'mp3' ? 'mp3' : 'flac';
    const name = safeName(url.searchParams.get('name'));
    if (!track) { json(res, 400, { error: 'That is not a song on this server.' }); return true; }

    const up = http.get({ host: backend.host, port: backend.port, path: track }, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        json(res, 502, { error: 'The song file could not be fetched. Is the backend running?' });
        return;
      }
      if (format === 'flac') {
        res.writeHead(200, {
          'content-type': 'audio/flac',
          'content-disposition': `attachment; filename="${name}.flac"`,
          ...(upstream.headers['content-length'] ? { 'content-length': upstream.headers['content-length'] } : {}),
        });
        upstream.pipe(res);
        return;
      }
      const ff = spawn(ffmpegBin(), ['-v', 'error', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '320k', 'pipe:1'], { shell: false });
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-disposition': `attachment; filename="${name}.mp3"`,
      });
      upstream.pipe(ff.stdin);
      ff.stdout.pipe(res);
      ff.on('error', () => res.destroy());
      res.on('close', () => { try { ff.kill('SIGKILL'); } catch { /* gone */ } });
    });
    up.on('error', () => json(res, 502, { error: 'The backend is not answering.' }));
    return true;
  }

  // ---- video jobs ----
  if (pathname === '/studio/video' && req.method === 'POST') {
    readBody(req).then((body) => {
      const trackUrl = mediaPath(body?.trackUrl, 'tracks');
      const requestedMode = ['film', 'scroll', 'visualizer'].includes(body?.mode) ? body.mode : null;
      if (!trackUrl || !requestedMode) { json(res, 400, { error: 'A song and a video kind are required.' }); return; }
      const trackId = String(body?.trackId || '').trim() || null;
      const lyrics = resolveJobLyrics(body?.lyrics, trackId);
      const visualizerConfirmed = body?.visualizerConfirmed === true;
      const mode = resolveVideoMode(requestedMode, lyrics, visualizerConfirmed);
      if (mode !== 'visualizer' && !hasAuthoredLyrics(lyrics)) {
        json(res, 400, { error: 'This song has no written lyrics. Choose the audio visualizer instead.' });
        return;
      }
      const id = crypto.randomUUID();
      const dir = path.join(JOBS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const title = String(body?.title || 'Untitled').slice(0, TITLE_MAX).trim() || 'Untitled';
      const job = {
        id,
        trackId,
        requestedMode,
        mode,
        visualizerConfirmed,
        status: 'queued',
        step: 'Waiting for a free slot',
        progress: 0,
        error: null,
        trackUrl,
        // A shipped sample's sleeve lives in `public/samples`, not in the covers
      // store, and it should still be able to back its own lyric video.
      cover: mediaPath(body?.cover, 'covers') || mediaPath(body?.cover, 'samples'),
        title,
        artist: String(body?.artist || 'MaxMusic').slice(0, 80).trim() || 'MaxMusic',
        lyrics,
        dir,
        outFile: path.join(dir, 'video.mp4'),
        filename: `${safeName(title)}-${{ film: 'lyric-video', scroll: 'lyric-scroll', visualizer: 'visualizer' }[mode]}.mp4`,
        proc: null,
        // Where the time went and which hardware spent it. A lyric video that
        // suddenly takes minutes is nearly always one stage that fell back to
        // the CPU, and that should be readable rather than deducible.
        timings: {},
        hardware: {},
        createdAt: Date.now(),
        finishedAt: null,
      };
      jobs.set(id, job);
      persistJob(job);
      queue.push(id);
      pump(backend);
      json(res, 202, publicJob(job));
    }).catch(() => json(res, 400, { error: 'That request could not be read.' }));
    return true;
  }

  // ---- the keep: finished videos, downloadable any time ----
  const keepMatch = pathname.match(/^\/studio\/videos\/([^/]+)$/);
  if (keepMatch && req.method === 'GET') {
    const name = path.basename(decodeURIComponent(keepMatch[1]));
    const file = findVideoFile(name);
    if (!file) {
      json(res, 404, { error: 'That video is not here.' });
      return true;
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${name}"`,
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const jobMatch = pathname.match(/^\/studio\/video\/([0-9a-f-]{36})(\/file)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) { json(res, 404, { error: 'That render is not here any more.' }); return true; }

    if (!jobMatch[2] && req.method === 'GET') { json(res, 200, publicJob(job)); return true; }

    if (jobMatch[2] && req.method === 'GET') {
      if (job.status !== 'completed') { json(res, 409, { error: 'That render is not finished.' }); return true; }
      const publicName = job.publicUrl
        ? path.basename(decodeURIComponent(new URL(job.publicUrl, 'http://localhost').pathname))
        : null;
      const keptFile = publicName ? findVideoFile(publicName) : null;
      const file = keptFile && fs.existsSync(keptFile) ? keptFile : job.outFile;
      if (!file || !fs.existsSync(file)) {
        json(res, 404, { error: 'That finished video is no longer on disk.' });
        return true;
      }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': stat.size,
        'content-disposition': `attachment; filename="${job.filename}"`,
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }

    if (!jobMatch[2] && req.method === 'DELETE') {
      if (job.status === 'queued' || job.status === 'working') {
        job.status = 'cancelled';
        job.error = null;
        job.finishedAt = Date.now();
        if (job.proc) { try { job.proc.kill('SIGKILL'); } catch { /* gone */ } }
        persistJob(job);
      }
      json(res, 200, { ok: true });
      return true;
    }
  }

  json(res, 404, { error: 'Nothing lives at that path.' });
  return true;
}
