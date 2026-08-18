#!/usr/bin/env node
/**
 * Renders the stage to an MP4.
 *
 * Drives a local Chromium over the DevTools protocol — the same approach as
 * capture.mjs, no dependencies — seeking the stage one frame at a time and
 * piping screenshots straight into ffmpeg, which muxes the song in. The
 * stage is a pure function of frame number, so the output is reproducible
 * and an excerpt render is just a different frame range.
 *
 *   node render/render.mjs --song osmw --audio shots/showcase/open-source-must-win-v2.flac \
 *        --out render/out/osmw.mp4 [--from 20] [--to 40] [--fps 30] [--quality 18]
 *
 * Stills mode — PNG per timestamp instead of a video, for eyeballing and
 * for the gauntlet's contact sheets. --audio is not needed:
 *
 *   node render/render.mjs --song osmw --stills "1,6,13.5,25" --outdir render/out/stills
 *
 * @module render/render
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseEncoder, supportedEncoders } from './fast-render.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_RENDER_DATA = path.join(REPO, 'render', 'data');
const RENDER_DATA = path.resolve(
  process.env.MAXMUSIC_RENDER_DATA
    || (process.env.MAXMUSIC_DATA
      ? path.join(process.env.MAXMUSIC_DATA, 'render-data')
      : DEFAULT_RENDER_DATA),
);

function pathExecutables(names) {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
}

const macBrowsers = [
  '/Applications/ego lite.app/Contents/MacOS/ego lite',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const windowsRoots = [
  process.env.PROGRAMFILES,
  process.env['PROGRAMFILES(X86)'],
  process.env.LOCALAPPDATA,
].filter(Boolean);
const windowsBrowsers = windowsRoots.flatMap((root) => [
  path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(root, 'Chromium', 'Application', 'chrome.exe'),
  path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
]);

const linuxBrowsers = [
  '/opt/brave.com/brave/brave',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/brave-browser',
];

function configuredBrowsers() {
  const value = String(process.env.MAXMUSIC_BROWSER || '').trim();
  if (!value) return [];
  if (path.isAbsolute(value)) return [value];
  if (value.includes('/') || value.includes('\\')) return [path.resolve(REPO, value)];
  return pathExecutables([value]);
}

const BROWSERS = [...new Set([
  ...configuredBrowsers(),
  ...(process.platform === 'darwin' ? macBrowsers : []),
  ...(process.platform === 'win32' ? windowsBrowsers : []),
  ...(process.platform === 'linux' ? linuxBrowsers : []),
  ...pathExecutables(process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe', 'brave.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']),
])];

/* ------------------------------------------------------------------- args */

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const SONG = args.song || 'osmw';
const AUDIO = args.audio;
const OUT = args.out || `render/out/${SONG}.mp4`;
const FROM = Number(args.from || 0);
const TO = args.to !== undefined ? Number(args.to) : null;
const CRF = String(args.quality || 18);
const FFMPEG = process.env.MAXMUSIC_FFMPEG || 'ffmpeg';

/**
 * `--quality` is a constant-quality target, given to x264 as a CRF and to a
 * hardware encoder as a CQ. Those scales are NOT the same number: measured on
 * one 4-minute film, `-cq 18` on NVENC produced 12.6 Mbps and 367 MB where
 * `-crf 18` on x264 produced 6.2 Mbps and 182 MB. So a hardware encoder is
 * only used here when it is asked for by name — see `kineticEncoder()`.
 */
function kineticEncoder(encoderList) {
  const requested = String(process.env.MAXMUSIC_VIDEO_ENCODER || '').trim();
  if (!requested || requested === 'auto') return 'libx264';
  return chooseEncoder(encoderList, requested);
}

function kineticEncoderArgs(encoder, quality) {
  if (encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0'];
  }
  if (encoder === 'h264_videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(1, Math.min(100, 100 - Number(quality) * 3)))];
  }
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality)];
}
const CDP_PORT = Number(args.port || 9377);
const STILLS = args.stills ? args.stills.split(',').map(Number) : null;
const OUTDIR = args.outdir || 'render/out/stills';

if (!STILLS && (!AUDIO || !fs.existsSync(path.resolve(REPO, AUDIO)))) {
  console.error('Pass --audio <file> (the track to mux in), or --stills "t1,t2,…".');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- static server (repo) -- */

const MIME = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css',
  '.flac': 'audio/flac', '.svg': 'image/svg+xml',
};

function serveRepo() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const relative = path.normalize(url.pathname).replace(/^([/\\])+/, '');
      const dataPrefix = path.join('render', 'data') + path.sep;
      const file = relative.startsWith(dataPrefix)
        ? path.resolve(RENDER_DATA, relative.slice(dataPrefix.length))
        : path.resolve(REPO, relative);
      const root = relative.startsWith(dataPrefix) ? RENDER_DATA : REPO;
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------------------------------------------------------------- browser */

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
        setTimeout(() => {
          if (pending.delete(mid)) reject(new Error(`${method} timed out`));
        }, 30000);
      });
    },
    close() { try { ws.close(); } catch { /* gone */ } },
  };
}

async function launch(browser) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-render-'));
  const browserArgs = [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-allow-origins=*',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1920,1080',
    'about:blank',
  ];
  const proc = spawn(browser, browserArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError = '';
  let stopped = false;
  proc.stderr.on('data', (data) => {
    launchError += String(data);
    if (launchError.length > 6000) launchError = launchError.slice(-6000);
  });
  proc.once('close', () => { stopped = true; });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { proc, profile };
    } catch { /* not yet */ }
    if (stopped) break;
  }
  if (!stopped) proc.kill('SIGKILL');
  const fatal = launchError
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /(?:FATAL|ERROR):/.test(line));
  throw new Error(fatal || 'browser never opened its devtools port');
}

/* ------------------------------------------------------------------ main -- */

const srv = await serveRepo();
const origin = `http://127.0.0.1:${srv.address().port}`;

const browserBin = BROWSERS.find((b) => fs.existsSync(b));
if (!browserBin) {
  console.error(
    'No Chromium-based browser found. Install Chrome, Chromium, Edge, Brave, or Ego Lite, '
    + 'or set MAXMUSIC_BROWSER to its executable.',
  );
  process.exit(1);
}

fs.mkdirSync(path.resolve(REPO, path.dirname(OUT)), { recursive: true });

const { proc, profile } = await launch(browserBin);
let c;
let ff;
try {
  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  c = cdp(tab.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: `${origin}/render/stage.html?song=${SONG}` });

  let meta = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const { result } = await c.send('Runtime.evaluate', {
      expression: 'window.__ready ? JSON.stringify(window.__meta) : ""',
      returnByValue: true,
    });
    if (result.value) { meta = JSON.parse(result.value); break; }
  }
  if (!meta) throw new Error('stage never became ready — check the browser console');

  if (STILLS) {
    const dir = path.resolve(REPO, OUTDIR);
    fs.mkdirSync(dir, { recursive: true });
    for (const ts of STILLS) {
      const f = Math.round(ts * meta.fps);
      await c.send('Runtime.evaluate', { expression: `window.__seek(${f})`, returnByValue: true });
      const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(dir, `t${String(ts).replace('.', '_')}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  ${path.relative(REPO, file)}`);
    }
  } else {
    const fps = meta.fps;
    const f0 = Math.max(0, Math.floor(FROM * fps));
    const f1 = TO === null ? meta.frames : Math.min(meta.frames, Math.ceil(TO * fps));
    const total = f1 - f0;
    console.log(`stage ready · ${meta.w}x${meta.h} @ ${fps}fps · frames ${f0}–${f1} (${total})`);

    const audioPath = path.resolve(REPO, AUDIO);
    const outPath = path.resolve(REPO, OUT);
    // x264 looked like the bottleneck here — it was the busiest process during
    // a render — but it was never on the critical path. Frames are captured and
    // encoded in a pipeline, so the total is whichever is slower, and the
    // browser is. Swapping in NVENC on the same song and machine changed 483s
    // into 491s: nothing, plus a file twice the size. So this stays on x264
    // unless somebody names another encoder, and then it is their choice.
    const encoder = kineticEncoder(await supportedEncoders(FFMPEG));
    // Same shape the fast renderer prints, so the studio's job log reports
    // which hardware made the film whichever renderer made it.
    console.log(`renderer kinetic-browser · encoder ${encoder}`);
    const ffArgs = [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      '-ss', (f0 / fps).toFixed(3), '-i', audioPath,
      '-map', '0:v', '-map', '1:a',
      ...kineticEncoderArgs(encoder, CRF),
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-t', (total / fps).toFixed(3),
      outPath,
    ];
    ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', (d) => { ffErr += d; if (ffErr.length > 8000) ffErr = ffErr.slice(-8000); });
    const ffDone = new Promise((resolve, reject) => {
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(ffErr.split('\n').slice(-6).join(' ')))));
      ff.on('error', reject);
    });

    const started = Date.now();
    for (let f = f0; f < f1; f++) {
      await c.send('Runtime.evaluate', { expression: `window.__seek(${f})`, returnByValue: true });
      const { data } = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
      const buf = Buffer.from(data, 'base64');
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      const done = f - f0 + 1;
      if (done % 90 === 0 || done === total) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = Math.round((total - done) / rate);
        process.stdout.write(`\r  frame ${done}/${total} · ${rate.toFixed(1)} fps · eta ${eta}s   `);
      }
    }
    ff.stdin.end();
    await ffDone;
    const kb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`\n  ✓ ${OUT} · ${kb} KB · ${(total / fps).toFixed(1)}s`);
  }
} finally {
  if (c) c.close();
  proc.kill('SIGKILL');
  srv.close();
  await sleep(400);
  fs.rmSync(profile, { recursive: true, force: true });
}
