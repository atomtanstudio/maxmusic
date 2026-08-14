/**
 * Video jobs — renders a song into an MP4 with FFmpeg.
 *
 * The browser sends a track, a cover and some text. It never sends a path, a
 * URL or an FFmpeg argument: `trackUrl` is resolved inside `public/tracks` and
 * `coverArtUrl` inside the covers directory, both by basename only, and
 * anything that escapes those directories is refused. FFmpeg is launched with
 * `spawn(..., { shell: false })` and a fixed argument list, so nothing the
 * customer types can become part of a command.
 *
 * The frame: the cover art fills it and is taken well down in brightness so
 * the words stay readable over it, the title and artist sit at the top, the
 * lyrics scroll up the middle, and along the bottom — where a scrubber would be
 * — the brand ramp is seen through the audio spectrum, over a progress line.
 *
 * @module video-jobs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const FFMPEG = '/usr/bin/ffmpeg';
const FFPROBE = '/usr/bin/ffprobe';

const FONT_DIR = `${os.homedir()}/.local/share/fonts/maxmusic`;
const FONT_TITLE = `${FONT_DIR}/InterDisplay-Black.ttf`;
const FONT_BODY = `${FONT_DIR}/Inter-Medium.ttf`;
const FONT_META = `${FONT_DIR}/Inter-Regular.ttf`;
const FONT_FALLBACK = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/** Renders in flight at once. The GPU and CPU are shared with ComfyUI. */
const MAX_CONCURRENT = 2;
/** Refuse anything longer than this — a runaway render is a stuck machine. */
const MAX_DURATION_S = 15 * 60;
/** A job's files are removed this long after it finishes, collected or not. */
const JOB_TTL_MS = 60 * 60 * 1000;
/** Longest a single render may run before it is killed. */
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;

const TITLE_MAX = 200;
const ARTIST_MAX = 120;
const LYRICS_MAX = 20000;

/**
 * Output shapes. Only these are accepted; `preset` is never interpolated into
 * an argument, it only selects one of these objects.
 */
const PRESETS = {
  'square-1080': { w: 1080, h: 1080, margin: 88, titleY: 636, bandY: 210, vizH: 150 },
  'portrait-1080': { w: 1080, h: 1920, margin: 96, titleY: 1310, bandY: 420, vizH: 170 },
  'landscape-1080': { w: 1920, h: 1080, margin: 110, titleY: 640, bandY: 190, vizH: 140 },
};

const BAR_H = 3;

/** @type {Map<string, Job>} */
const jobs = new Map();
let running = 0;
/** @type {string[]} */
const queue = [];

const pickFont = (preferred) => (fsSync.existsSync(preferred) ? preferred : FONT_FALLBACK);

/* ---------------------------------------------------------------- inputs -- */

/**
 * Resolve a browser-supplied media URL to a real file, or throw.
 *
 * Only `/<expectedPrefix>/<basename>` is accepted. The basename is stripped of
 * any directory part before it is joined, and the result must still sit inside
 * `dir` — so `../`, an absolute path, or a URL on another host cannot escape.
 */
async function resolveMedia(url, expectedPrefix, dir, { optional = false } = {}) {
  if (url === null || url === undefined || url === '') {
    if (optional) return null;
    throw new HttpError(400, `${expectedPrefix} is required.`);
  }
  if (typeof url !== 'string') throw new HttpError(400, `${expectedPrefix} must be a string.`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    throw new HttpError(400, 'Only files already on this server can be used.');
  }
  const prefix = `/${expectedPrefix}/`;
  if (!url.startsWith(prefix)) {
    throw new HttpError(400, `Expected a ${prefix}… path.`);
  }
  const name = path.basename(url.slice(prefix.length));
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'That file name is not usable.');

  const full = path.resolve(dir, name);
  const root = path.resolve(dir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(400, 'That file is outside the media directory.');
  }
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new HttpError(404, 'That file is not on this server.');
  }
  return full;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Read a track's duration, so progress is a real fraction and limits can bite. */
function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ], { shell: false });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const seconds = Number(String(out).trim());
      if (code !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
        reject(new Error(err.trim() || 'Could not read the track length.'));
        return;
      }
      resolve(seconds);
    });
  });
}

/**
 * Lyrics scroll as one block. Blank lines and section tags are dropped: a tag
 * like [chorus] is a writing aid, not something to put on screen.
 */
function lyricLines(lyrics) {
  const out = [];
  for (const raw of String(lyrics || '').split('\n')) {
    const line = raw.trim();
    // A section tag becomes the break it implies, rather than vanishing and
    // leaving two stanzas welded together.
    if (!line || /^\[[^\]]*\]$/.test(line)) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/* ------------------------------------------------------------ filtergraph -- */

/**
 * Everything that does not move is painted ONCE, by ImageMagick, into a single
 * frame; everything that does move is a finished image ffmpeg slides around.
 *
 * That split is the whole performance story. `drawtext` with a moving `y`
 * re-shapes every glyph on every frame, and `-loop 1` on a still re-runs its
 * blur and crop thirty times a second — either one turns a twelve second render
 * into minutes. Composited first, the same render takes under two seconds.
 */
function imagemagickStage(spec, files) {
  const { preset: P, title, artist, footer, coverFile } = spec;
  const M = P.margin;
  const urlY = P.vizH + 34;

  const args = ['-size', `${P.w}x${P.h}`, 'xc:#07070B'];

  if (coverFile) {
    // The art carries the frame but must never win it: knocked well down, a
    // touch of blur so texture does not fight the type, and a vignette that
    // pulls the eye to the centre and darkens the corners where text sits.
    args.push(
      '(', coverFile,
      '-resize', `${P.w}x${P.h}^`,
      '-gravity', 'center', '-extent', `${P.w}x${P.h}`,
      '-blur', '0x3', '-modulate', '38,108',
      ')', '-composite',
      '(', '-size', `${P.w}x${P.h}`, 'radial-gradient:none-black',
      '-alpha', 'set', '-channel', 'A', '-evaluate', 'multiply', '0.62', '+channel',
      ')', '-composite',
    );
  }

  // Eyebrow: the artist, letterspaced by hand. Small caps set wide against a
  // heavy title is the oldest trick in record-sleeve typography and it still
  // reads as considered rather than default.
  if (artist) {
    args.push(
      '-font', pickFont(FONT_BODY), '-pointsize', String(Math.round(P.w * 0.0195)),
      '-fill', '#7C879B', '-gravity', 'northwest',
      '-annotate', `+${M + 3}+${P.titleY - Math.round(P.w * 0.035)}`,
      artist.toUpperCase().split('').join(' '),
    );
  }

  // The title wraps, so a long one drops to a second line instead of running
  // off the frame. caption: measures and breaks; annotate would not.
  args.push(
    '(', '-size', `${P.w - 2 * M}x`, '-background', 'none', '-fill', 'white',
    '-font', pickFont(FONT_TITLE), '-pointsize', String(Math.round(P.w * 0.072)),
    '-interline-spacing', String(Math.round(P.w * 0.004)),
    '-gravity', 'northwest', `caption:${title.toUpperCase()}`,
    ')', '-geometry', `+${M}+${P.titleY}`, '-composite',
  );

  if (footer) {
    args.push(
      '-font', pickFont(FONT_META), '-pointsize', String(Math.round(P.w * 0.0176)),
      '-fill', '#6E7889', '-gravity', 'southwest',
      '-annotate', `+${M}+${urlY}`, footer,
    );
  }

  args.push(files.stage);
  return args;
}

/** The lyric block, rasterised once. Left-set with generous leading. */
function imagemagickLyrics(spec, files) {
  const { preset: P, lyricsText } = spec;
  return [
    '-size', `${P.w - 2 * P.margin}x`,
    '-background', 'none',
    '-fill', '#F2F5FA',
    '-font', pickFont(FONT_BODY),
    '-pointsize', String(Math.round(P.w * 0.0315)),
    '-interline-spacing', String(Math.round(P.w * 0.024)),
    '-gravity', 'west',
    `caption:${lyricsText}`,
    files.lyrics,
  ];
}

/**
 * The brand ramp as a five-stop strip, interpolated smoothly.
 *
 * Built here rather than by FFmpeg's `gradients` source, which weights its
 * stops unevenly — the first attempt read as almost entirely gold — and which
 * slowly rotates the ramp unless its speed is pinned.
 */
function imagemagickRamp(P, file) {
  return [
    'xc:#00C0E0', 'xc:#4A7BF0', 'xc:#9B5AF0', 'xc:#E0508A', 'xc:#E8A040', '+append',
    '-filter', 'Cubic', '-resize', `${P.w}x${P.vizH}!`,
    file,
  ];
}

const vizHeightFor = (P) => P.vizH;
/** The lyric window: the space above the credits, below the top of the frame. */
const bandHeightFor = (P) => P.titleY - P.bandY - Math.round(P.w * 0.069);

/**
 * @param {{preset: object, duration: number, hasLyrics: boolean,
 *          lyricsHeight: number}} spec
 */
function buildFilter(spec) {
  const { preset: P, duration, hasLyrics, lyricsHeight } = spec;
  const VIZ_H = vizHeightFor(P);
  const bandH = bandHeightFor(P);
  const d = duration.toFixed(3);

  const parts = ['[1:v]format=rgba[stage]'];
  let last = 'stage';

  if (hasLyrics) {
    const speed = (lyricsHeight + bandH) / Math.max(duration, 1);
    parts.push(`color=c=0x000000@0:s=${P.w}x${bandH}:r=30:d=${d},format=rgba[band]`);
    parts.push('[2:v]format=rgba[lp]');
    parts.push(`[band][lp]overlay=x=${P.margin}:y=H-t*${speed.toFixed(3)}[lraw]`);
    parts.push('[3:v]format=gray[fade]');
    // A label may be consumed once, so the window is split before one copy is
    // reduced to its alpha and multiplied by the edge ramp.
    parts.push('[lraw]split[lk][lm]');
    parts.push('[lm]alphaextract[la]');
    parts.push('[la][fade]blend=all_mode=multiply[la2]');
    parts.push('[lk][la2]alphamerge[lband]');
    parts.push(`[${last}][lband]overlay=0:${P.bandY}[v1]`);
    last = 'v1';
  }

  /* A waveform envelope, not a spectrum. showfreqs saturated into a solid white
     block with almost no dynamic range, and showcqt put nearly everything into
     one bass spike. `cline` gives the dense symmetric shape people already know
     from a player, and the ramp supplies its colour through the wave's alpha. */
  const rampIdx = hasLyrics ? 4 : 2;
  parts.push(`[${rampIdx}:v]format=rgba[ramp]`);
  parts.push(`[0:a]showwaves=s=${P.w}x${VIZ_H}:mode=cline:rate=30:colors=white:scale=sqrt,format=gray[wmask]`);
  parts.push('[ramp][wmask]alphamerge,format=rgba,colorchannelmixer=aa=0.95[viz]');
  parts.push(`[${last}][viz]overlay=0:${P.h - VIZ_H - BAR_H}[v2]`);

  parts.push(`[v2]drawbox=x=0:y=${P.h - BAR_H}:w=iw*t/${d}:h=${BAR_H}`
    + ':color=white@0.5:t=fill[vout]');

  return parts.join(';');
}

/**
 * The lyric window's edge mask: black at the very top and bottom, white
 * through the middle, so text arriving and leaving fades rather than being cut.
 */
function imagemagickFade(bandH, width, file) {
  const ramp = Math.max(24, Math.round(bandH * 0.26));
  return [
    '-size', `${width}x${bandH}`, 'xc:black',
    '(', '-size', `${width}x${ramp}`, 'gradient:black-white', ')', '-geometry', '+0+0', '-composite',
    '(', '-size', `${width}x${bandH - 2 * ramp}`, 'xc:white', ')', '-geometry', `+0+${ramp}`, '-composite',
    '(', '-size', `${width}x${ramp}`, 'gradient:white-black', ')', '-geometry', `+0+${bandH - ramp}`, '-composite',
    '-colorspace', 'Gray',
    file,
  ];
}

/** Run one ImageMagick command, resolving when it succeeds. */
function magick(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/convert', args, { shell: false });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(err.trim().slice(0, 300) || `convert exited ${code}`))));
  });
}

/** Height of a rendered PNG, so the scroll speed can be exact. */
function pngHeight(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/identify', ['-format', '%h', file], { shell: false });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => {
      const h = Number(String(out).trim());
      resolve(Number.isFinite(h) && h > 0 ? h : 0);
    });
  });
}

/* ------------------------------------------------------------------ jobs -- */

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {'queued'|'rendering'|'completed'|'failed'|'cancelled'} status
 * @property {number} progress 0..1
 * @property {?string} error
 * @property {string} dir
 * @property {string} outFile
 * @property {?import('node:child_process').ChildProcess} proc
 * @property {number} createdAt
 * @property {?number} finishedAt
 */

function publicJob(job) {
  const body = {
    id: job.id,
    status: job.status,
    progress: Number(job.progress.toFixed(4)),
    statusUrl: `/api/video-jobs/${job.id}`,
    createdAt: job.createdAt,
  };
  if (job.status === 'completed') {
    body.downloadUrl = `/api/video-jobs/${job.id}/file`;
    body.filename = job.filename;
  }
  if (job.error) body.error = job.error;
  return body;
}

async function cleanup(job) {
  try { await fs.rm(job.dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

function finish(job, status, error = null) {
  if (['completed', 'failed', 'cancelled'].includes(job.status)) return;
  job.status = status;
  job.error = error;
  job.finishedAt = Date.now();
  job.proc = null;
  if (status !== 'completed') cleanup(job);
  running = Math.max(0, running - 1);
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    running++;
    render(job).catch((err) => finish(job, 'failed', err?.message || String(err)));
  }
}

async function render(job) {
  job.status = 'rendering';

  const args = ['-hide_banner', '-nostdin', '-y'];
  args.push('-i', job.trackFile);
  // Index order is load-bearing: the graph refers to these by number.
  //   0 audio · 1 stage · [2 lyrics · 3 fade] · ramp last
  args.push('-loop', '1', '-i', job.stageFile);
  if (job.lyricsFile) {
    args.push('-loop', '1', '-i', job.lyricsPng);
    args.push('-loop', '1', '-i', job.fadeFile);
  }
  args.push('-loop', '1', '-i', job.rampFile);
  args.push(
    '-filter_complex', job.filter,
    '-map', '[vout]',
    '-map', '0:a',
    '-c:v', job.encoder,
  );
  if (job.encoder === 'libx264') {
    args.push('-preset', 'medium', '-crf', '20');
  } else {
    args.push('-preset', 'p5', '-cq', '23');
  }
  args.push(
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    '-t', String(job.duration.toFixed(3)),
    '-progress', 'pipe:1', '-nostats',
    job.outFile,
  );

  const proc = spawn(FFMPEG, args, { shell: false });
  job.proc = proc;

  const killTimer = setTimeout(() => {
    if (job.proc) { try { job.proc.kill('SIGKILL'); } catch { /* gone */ } }
    finish(job, 'failed', 'The render ran too long and was stopped.');
  }, RENDER_TIMEOUT_MS);

  let stdout = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    stdout = lines.pop() || '';
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'out_time_ms') {
        const seconds = Number(value) / 1e6;
        if (Number.isFinite(seconds)) {
          job.progress = Math.max(0, Math.min(0.999, seconds / job.duration));
        }
      }
    }
  });

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  await new Promise((resolve) => {
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      finish(job, 'failed', `FFmpeg could not start: ${err.message}`);
      resolve();
    });
    proc.on('close', async (code, signal) => {
      clearTimeout(killTimer);
      if (job.status === 'cancelled') { resolve(); return; }
      if (signal || code !== 0) {
        const tail = stderr.trim().split('\n').slice(-4).join(' ').slice(0, 400);
        finish(job, 'failed', tail || `FFmpeg exited with code ${code}.`);
        resolve();
        return;
      }
      try {
        const stat = await fs.stat(job.outFile);
        if (!stat.size) throw new Error('empty file');
      } catch {
        finish(job, 'failed', 'The render finished but produced no file.');
        resolve();
        return;
      }
      job.progress = 1;
      finish(job, 'completed');
      resolve();
    });
  });
}

/* -------------------------------------------------------------- the API --- */

/**
 * @param {object} body                     Parsed request body.
 * @param {{tracksDir: string, coversDir: string}} dirs
 */
export async function createVideoJob(body, dirs) {
  const preset = PRESETS[body?.preset] ? body.preset : 'square-1080';

  const trackFile = await resolveMedia(body?.trackUrl, 'tracks', dirs.tracksDir);
  const coverFile = await resolveMedia(body?.coverArtUrl, 'covers', dirs.coversDir, { optional: true });

  const duration = await probeDuration(trackFile);
  if (duration > MAX_DURATION_S) {
    throw new HttpError(413, `That track is longer than the ${Math.round(MAX_DURATION_S / 60)} minute limit.`);
  }

  const title = String(body?.title || 'Untitled').slice(0, TITLE_MAX).trim() || 'Untitled';
  const artist = String(body?.artist || '').slice(0, ARTIST_MAX).trim();
  const lines = lyricLines(String(body?.lyrics || '').slice(0, LYRICS_MAX));

  const id = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), `mm-video-${id}`);
  await fs.mkdir(dir, { recursive: true });

  const files = {
    stage: path.join(dir, 'stage.png'),
    lyrics: path.join(dir, 'lyrics.png'),
    ramp: path.join(dir, 'ramp.png'),
  };
  const P = PRESETS[preset];
  // A short line under the credits — a handle or a project URL. Plain text only.
  const footer = String(body?.footer || '').slice(0, 120).replace(/[\r\n]+/g, ' ').trim();

  // Painted before the job is queued, so a bad font or an unreadable cover
  // fails here with a real message rather than inside FFmpeg.
  await magick(imagemagickStage({ preset: P, title, artist, footer, coverFile }, files));
  await magick(imagemagickRamp(P, files.ramp));

  let lyricsPng = null;
  let lyricsHeight = 0;
  let fadeFile = null;
  if (lines.length) {
    await magick(imagemagickLyrics({ preset: P, lyricsText: lines.join('\n') }, files));
    lyricsHeight = await pngHeight(files.lyrics);
    if (lyricsHeight > 0) {
      lyricsPng = files.lyrics;
      fadeFile = path.join(dir, 'fade.png');
      await magick(imagemagickFade(bandHeightFor(P), P.w, fadeFile));
    }
  }

  const safeTitle = title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'song';
  const job = {
    id,
    status: 'queued',
    progress: 0,
    error: null,
    dir,
    outFile: path.join(dir, 'video.mp4'),
    filename: `${safeTitle}.mp4`,
    trackFile,
    coverFile,
    stageFile: files.stage,
    lyricsFile: lyricsPng,
    lyricsPng,
    fadeFile,
    rampFile: files.ramp,
    duration,
    encoder: body?.encoder === 'h264_nvenc' ? 'h264_nvenc' : 'libx264',
    proc: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  job.filter = buildFilter({
    preset: P,
    duration,
    hasLyrics: Boolean(lyricsPng),
    lyricsHeight,
  });

  jobs.set(id, job);
  queue.push(id);
  pump();
  return publicJob(job);
}

export function getVideoJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

/** @returns {?{file: string, filename: string}} */
export function getVideoJobFile(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'completed') return null;
  return { file: job.outFile, filename: job.filename };
}

export function cancelVideoJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued' || job.status === 'rendering') {
    const wasRendering = job.status === 'rendering';
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    if (job.proc) { try { job.proc.kill('SIGKILL'); } catch { /* gone */ } }
    job.proc = null;
    cleanup(job);
    if (wasRendering) { running = Math.max(0, running - 1); pump(); }
  } else {
    cleanup(job);
  }
  jobs.delete(id);
  return true;
}

/** Drop finished jobs and their files once nobody is coming back for them. */
export function sweepVideoJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (!job.finishedAt) continue;
    if (now - job.finishedAt < JOB_TTL_MS) continue;
    cleanup(job);
    jobs.delete(id);
  }
}

export const VIDEO_PRESETS = Object.keys(PRESETS);
