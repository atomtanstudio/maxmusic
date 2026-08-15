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

const RENDER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(RENDER_DIR);
const JOBS_DIR = path.join(RENDER_DIR, 'out', 'jobs');
const DATA_DIR = path.join(RENDER_DIR, 'data');
const MODEL = path.join(RENDER_DIR, 'models', 'ggml-small.en.bin');
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin';

const JOB_TTL_MS = 60 * 60 * 1000;
const TITLE_MAX = 160;
const LYRICS_MAX = 20000;

/** @type {Map<string, object>} */
const jobs = new Map();
const queue = [];
let running = false;
let nextCdpPort = 9401;

/* -------------------------------------------------------------- utilities */

const safeName = (s) => String(s || 'song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'song';

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

/** Fetch a backend media file to disk. */
function fetchToFile(backend, urlPath, dest) {
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
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `${path.basename(bin)} exited ${signal || code}`));
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
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `${path.basename(bin)} exited ${signal || code}`));
    });
  });
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

/* ------------------------------------------------------------- the worker */

function publicJob(job) {
  const body = {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: Number((job.progress || 0).toFixed(3)),
    statusUrl: `/studio/video/${job.id}`,
  };
  if (job.status === 'completed') {
    body.downloadUrl = `/studio/video/${job.id}/file`;
    body.filename = job.filename;
  }
  if (job.error) body.error = job.error;
  return body;
}

async function work(job, backend) {
  const d = job.dir;
  const flac = path.join(d, 'song.flac');
  const wav = path.join(d, 'song16k.wav');
  const sheet = path.join(d, 'sheet.json');
  const lyricsTxt = path.join(d, 'lyrics.txt');
  const dataAnalysis = path.join(DATA_DIR, `job-${job.id}-analysis.json`);
  const dataTiming = path.join(DATA_DIR, `job-${job.id}-timing.json`);

  job.status = 'working';
  job.step = 'Fetching the song';
  job.progress = 0.02;
  await fetchToFile(backend, job.trackUrl, flac);

  await ensureModel(job);

  job.step = 'Reading the song';
  job.progress = 0.12;
  await runCancellable(job, process.execPath, [path.join(RENDER_DIR, 'analyze.mjs'), flac, dataAnalysis]);

  job.step = 'Listening for the words';
  job.progress = 0.18;
  await runCancellable(job, 'ffmpeg', ['-v', 'error', '-y', '-i', flac, '-ar', '16000', '-ac', '1', wav]);
  await runCancellable(job, 'whisper-cli', ['-m', MODEL, '-f', wav, '-oj', '-of', path.join(d, 'seg'), '-np']);
  job.progress = 0.3;
  await runCancellable(job, 'whisper-cli', ['-m', MODEL, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', path.join(d, 'words'), '-np']);

  job.step = 'Directing';
  job.progress = 0.42;
  if (job.lyrics) await fsp.writeFile(lyricsTxt, job.lyrics);
  const directArgs = [
    path.join(RENDER_DIR, 'auto-direct.mjs'),
    '--mode', job.mode,
    '--analysis', dataAnalysis,
    '--segments', path.join(d, 'seg.json'),
    '--out', sheet,
    '--title', job.title,
    '--artist', job.artist,
    '--seed', path.basename(job.trackUrl),
  ];
  if (job.lyrics) directArgs.push('--lyrics', lyricsTxt);
  if (job.cover) directArgs.push('--cover', job.cover);
  await runCancellable(job, process.execPath, directArgs);

  job.step = 'Timing the lyrics';
  await runCancellable(job, process.execPath, [
    path.join(RENDER_DIR, 'align.mjs'), sheet, path.join(d, 'seg.json'), path.join(d, 'words.json'), dataTiming,
    '--drop-unanchored',
  ]);

  job.step = 'Rendering';
  job.progress = 0.45;
  const port = nextCdpPort++;
  await runCancellable(job, process.execPath, [
    path.join(RENDER_DIR, 'render.mjs'),
    '--song', `job-${job.id}`,
    '--audio', flac,
    '--out', path.relative(REPO, job.outFile),
    '--port', String(port),
  ], {
    onStdout: (s) => {
      const m = s.match(/frame (\d+)\/(\d+)/);
      if (m) job.progress = 0.45 + 0.54 * (Number(m[1]) / Number(m[2]));
    },
  });

  const stat = await fsp.stat(job.outFile);
  if (!stat.size) throw new Error('The render finished but produced no file.');
  job.progress = 1;
  job.status = 'completed';
  job.step = 'Done';
  job.finishedAt = Date.now();
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
      const ff = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '320k', 'pipe:1'], { shell: false });
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
      const mode = body?.mode === 'film' ? 'film' : body?.mode === 'scroll' ? 'scroll' : null;
      if (!trackUrl || !mode) { json(res, 400, { error: 'A song and a video kind are required.' }); return; }
      const id = crypto.randomUUID();
      const dir = path.join(JOBS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const title = String(body?.title || 'Untitled').slice(0, TITLE_MAX).trim() || 'Untitled';
      const job = {
        id,
        mode,
        status: 'queued',
        step: 'Waiting for a free slot',
        progress: 0,
        error: null,
        trackUrl,
        cover: mediaPath(body?.cover, 'covers'),
        title,
        artist: String(body?.artist || 'MaxMusic').slice(0, 80).trim() || 'MaxMusic',
        lyrics: String(body?.lyrics || '').slice(0, LYRICS_MAX),
        dir,
        outFile: path.join(dir, 'video.mp4'),
        filename: `${safeName(title)}-${mode === 'film' ? 'lyric-film' : 'lyric-scroll'}.mp4`,
        proc: null,
        createdAt: Date.now(),
        finishedAt: null,
      };
      jobs.set(id, job);
      queue.push(id);
      pump(backend);
      json(res, 202, publicJob(job));
    }).catch(() => json(res, 400, { error: 'That request could not be read.' }));
    return true;
  }

  const jobMatch = pathname.match(/^\/studio\/video\/([0-9a-f-]{36})(\/file)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) { json(res, 404, { error: 'That render is not here any more.' }); return true; }

    if (!jobMatch[2] && req.method === 'GET') { json(res, 200, publicJob(job)); return true; }

    if (jobMatch[2] && req.method === 'GET') {
      if (job.status !== 'completed') { json(res, 409, { error: 'That render is not finished.' }); return true; }
      const stat = fs.statSync(job.outFile);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': stat.size,
        'content-disposition': `attachment; filename="${job.filename}"`,
      });
      fs.createReadStream(job.outFile).pipe(res);
      return true;
    }

    if (!jobMatch[2] && req.method === 'DELETE') {
      if (job.status === 'queued' || job.status === 'working') {
        job.status = 'cancelled';
        job.error = null;
        job.finishedAt = Date.now();
        if (job.proc) { try { job.proc.kill('SIGKILL'); } catch { /* gone */ } }
      }
      json(res, 200, { ok: true });
      return true;
    }
  }

  json(res, 404, { error: 'Nothing lives at that path.' });
  return true;
}
