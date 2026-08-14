#!/usr/bin/env node
/**
 * MaxMusic — blind pairing.
 *
 * Takes the current captures in `shots/now/` and the real product screenshots
 * in `refs/`, de-identifies both, shuffles them into `a` / `b` slots, and
 * writes `shots/blind-r<round>/<piece>/{a,b}.png` plus a `key.json` recording which
 * slot is ours. The judge sees only the two images; the key stays out of the
 * prompt.
 *
 * De-identification follows round 1 exactly, so verdicts stay comparable:
 *   · both images lose their top 56px, which is where each product's wordmark
 *     sits (ours ends at y=26, the reference's at y~49)
 *   · the reference's sidebar account handle is painted over with a colour
 *     sampled from just outside the patch
 *
 * The compositing runs in a headless browser canvas because the machine has no
 * ImageMagick, and `sips` can neither offset-crop nor fill a rect. Files are
 * served over a short-lived local HTTP server so the canvas is same-origin and
 * never tainted.
 *
 *   node blind.mjs
 *
 * @module blind
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const ROUND = Number(process.env.ROUND || 4);
const OUT = path.join(REPO, `shots/blind-r${ROUND}`);
const PORT = Number(process.env.CDP_PORT || 9372);
const CROP_TOP = 56;
const FILL = { x: 18, y: 376, w: 200, h: 34 };   // reference sidebar account handle
const BROWSER = '/Applications/ego lite.app/Contents/MacOS/ego lite';

/** Pairings are the ones round 1 established — changing them breaks comparability. */
const PIECES = [
  { piece: 'create',  ours: 'shots/now/create.png',  ref: 'refs/suno-create.png' },
  { piece: 'studio',  ours: 'shots/now/studio.png',  ref: 'refs/suno-create-advanced.png' },
  { piece: 'library', ours: 'shots/now/library.png', ref: 'refs/suno-library.png' },
  { piece: 'lyrics',  ours: 'shots/now/lyrics.png',  ref: 'refs/suno-create-advanced.png' },
  { piece: 'art',     ours: 'shots/now/art.png',     ref: 'refs/suno-explore.png' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ file server -- */

const TYPES = { '.png': 'image/png', '.html': 'text/html; charset=utf-8' };
const fileServer = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  // The compositing page must live on this same origin, or the canvas is
  // tainted by the images and toDataURL refuses to export.
  if (rel === '') {
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    res.end('<!doctype html><title>compositor</title>');
    return;
  }
  const abs = path.join(REPO, rel);
  if (!abs.startsWith(REPO) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => fileServer.listen(0, '127.0.0.1', r));
const FILES = `http://127.0.0.1:${fileServer.address().port}`;

/* ------------------------------------------------------------------ cdp --- */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-blind-'));
const proc = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-gpu-compositing',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--remote-allow-origins=*', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* wait */ }
}
if (!up) {
  proc.kill('SIGKILL');
  console.error(`\n  ${path.basename(BROWSER)} never opened a devtools port.\n`);
  process.exit(1);
}

function client(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const s = pending.get(m.id);
    if (s) { pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); }
  });
  return {
    ready,
    send: (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.delete(i)) rej(new Error(`${method} timed out`)); }, 45000);
    }),
    close: () => ws.close(),
  };
}

/**
 * Crop the wordmark strip off, and for the reference also paint out the
 * account handle using a colour sampled from immediately right of the patch,
 * so the fill matches the sidebar rather than guessing at a hex value.
 */
const COMPOSITE = (url, cropTop, fill) => `(async () => {
  const img = new Image();
  img.src = ${JSON.stringify(url)};
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight - ${cropTop};
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.drawImage(img, 0, ${cropTop}, w, h, 0, 0, w, h);
  ${fill ? `
  {
    const y = ${fill.y} - ${cropTop};
    const probe = c.getImageData(${fill.x + fill.w} + 12, y + Math.floor(${fill.h} / 2), 1, 1).data;
    c.fillStyle = 'rgb(' + probe[0] + ',' + probe[1] + ',' + probe[2] + ')';
    c.fillRect(${fill.x}, y, ${fill.w}, ${fill.h});
  }` : ''}
  return cv.toDataURL('image/png');
})()`;

async function render(page, url, cropTop, fill) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression: COMPOSITE(url, cropTop, fill),
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'composite failed');
  return Buffer.from(String(result.value).split(',')[1], 'base64');
}

/* ----------------------------------------------------------------- main --- */

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${FILES}/`)}`, { method: 'PUT' })).json();
const page = client(tab.webSocketDebuggerUrl);
await page.ready;
await sleep(1200);   // let the blank compositing page finish loading

fs.mkdirSync(OUT, { recursive: true });
console.log('');
let done = 0;

for (const { piece, ours, ref } of PIECES) {
  const dir = path.join(OUT, piece);
  for (const f of [ours, ref]) {
    if (!fs.existsSync(path.join(REPO, f))) {
      console.log(`  ${piece.padEnd(8)} SKIPPED — missing ${f}`);
      continue;
    }
  }
  try {
    const oursPng = await render(page, `${FILES}/${ours}`, CROP_TOP, null);
    const refPng = await render(page, `${FILES}/${ref}`, CROP_TOP, FILL);

    // Coin flip per piece, recorded in the key. The judge gets no pattern to learn.
    const oursSlot = Math.random() < 0.5 ? 'a' : 'b';
    const refSlot = oursSlot === 'a' ? 'b' : 'a';

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${oursSlot}.png`), oursPng);
    fs.writeFileSync(path.join(dir, `${refSlot}.png`), refPng);
    fs.writeFileSync(path.join(dir, 'key.json'), `${JSON.stringify({
      piece,
      round: ROUND,
      ours: oursSlot,
      reference: refSlot,
      sources: { [oursSlot]: ours, [refSlot]: ref },
      deidentification: {
        crop_top_px: CROP_TOP,
        note: 'Top strip cropped from both images; it carried each product wordmark (ours ended at y=26, reference at y~49). A DOM scan confirmed no other visible occurrence of our product name survives the crop on any screen.',
        reference_fill_rect: `${FILL.x},${FILL.y},${FILL.w},${FILL.h} (sidebar account handle, filled with a colour sampled 12px to its right)`,
      },
    }, null, 2)}\n`);

    console.log(`  ${piece.padEnd(8)} ours=${oursSlot}  ref=${refSlot}  ${path.basename(ref)}`);
    done++;
  } catch (err) {
    console.log(`  ${piece.padEnd(8)} FAILED — ${err.message}`);
  }
}

page.close();
const exited = new Promise((r) => proc.once('exit', r));
proc.kill('SIGKILL');
await Promise.race([exited, sleep(3000)]);
for (let i = 0; i < 5; i++) {
  try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(400); }
}
fileServer.close();

console.log(`\n  ${done}/${PIECES.length} pairings written to shots/blind-r${ROUND}/\n`);
process.exit(done === PIECES.length ? 0 : 1);
