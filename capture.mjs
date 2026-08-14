#!/usr/bin/env node
/**
 * MaxMusic — gauntlet capture.
 *
 * Screenshots the five product screens off the running app on :3020 and writes
 * them to `shots/now/`. That is the whole job. It does not generate content,
 * seed a library, or touch app source — round 2's scoring pass was lost to a
 * capture agent that wandered into doing all three, so this step is a script
 * with no judgement in it rather than an agent with initiative.
 *
 * Drives a Chromium already on the machine over the DevTools protocol, so
 * there is no browser download and no new dependency.
 *
 * It deliberately does NOT use `--virtual-time-budget`: the app keeps a health
 * poll running, so virtual time never drains and the browser hangs until it is
 * killed. Instead it navigates, then waits for the screen outlet to actually
 * hold content before it shoots.
 *
 *   node capture.mjs                  # all five screens
 *   node capture.mjs create library   # just those
 *
 * @module capture
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(REPO, 'shots/now');
const APP = process.env.APP_URL || 'http://localhost:3020';
const W = Number(process.env.SHOT_W || 1440);
const H = Number(process.env.SHOT_H || 900);
const SCALE = Number(process.env.SHOT_SCALE || 2);
const PORT = Number(process.env.CDP_PORT || 9333);

/** The five screens the gauntlet scores, in nav order. */
const SCREENS = ['create', 'studio', 'library', 'lyrics', 'art'];

/** `ego lite` is the browser to use here. Others are fallbacks. */
const BROWSERS = [
  '/Applications/ego lite.app/Contents/MacOS/ego lite',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- preflight -- */

/** Fail loudly and early rather than capturing five pictures of a 502. */
async function preflight() {
  let res;
  try {
    res = await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.error(`\n  The app on ${APP} is not answering (${err.message}).`);
    console.error('  Start it with ./start.sh before capturing.\n');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`\n  ${APP}/api/health returned HTTP ${res.status}.`);
    console.error('  The backend is unreachable through the proxy — captures would show error');
    console.error('  states rather than the product. Fix that first:\n');
    console.error('    BACKEND_HOST=<host> ./start.sh\n');
    process.exit(1);
  }
  const h = await res.json().catch(() => ({}));
  console.log(`\n  backend    ${h.backend || '?'}`);
  console.log(`  comfy      ${h.comfyReachable ? 'reachable' : 'NOT reachable'}`);
  console.log(`  lyrics     ${h.lyrics || '?'}`);
  console.log(`  cover art  ${h.coverArt || '?'}`);
  if (h.lyrics === 'disabled' || h.coverArt === 'disabled') {
    console.log('\n  Note: a disabled capability renders as an honest "unavailable" state.');
    console.log('  Real product behaviour, but judges will see it — worth knowing before');
    console.log('  you read the verdicts.');
  }
  console.log('');
}

/* ------------------------------------------------------------------ cdp --- */

/** Minimal DevTools-protocol client over one page's WebSocket. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
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
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

async function launch(browser) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-shot-'));
  const proc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--disable-gpu-compositing',
    // Without this the browser dies on WebGL init — it falls back to software
    // WebGL, which is deprecated, and takes the whole process down with it.
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    // Without this the socket opens but every command is silently dropped,
    // because Node's WebSocket sends an Origin header that devtools rejects.
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${W},${H}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { proc, profile };
    } catch { /* not listening yet */ }
  }
  proc.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
  throw new Error(`${path.basename(browser)} never opened a devtools port on ${PORT}`);
}

/* -------------------------------------------------------------- capture --- */

/**
 * Wait until the router has mounted something into the outlet and the screen
 * has stopped changing size — that is the honest "it has rendered" signal,
 * rather than a fixed sleep that is either wasteful or too short.
 */
const SETTLED = `(() => {
  const outlet = document.querySelector('#screen') || document.querySelector('.screen');
  if (!outlet || outlet.children.length === 0) return 'empty';
  if (document.querySelector('[data-loading], .skeleton')) return 'loading';
  if (document.fonts && document.fonts.status !== 'loaded') return 'fonts';
  return 'ok:' + outlet.scrollHeight;
})()`;

async function capture(screen) {
  const out = path.join(OUT, `${screen}.png`);
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = cdp(tab.webSocketDebuggerUrl);
  await c.ready;
  try {
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: SCALE, mobile: false,
    });
    await c.send('Page.enable');
    await c.send('Page.navigate', { url: `${APP}/#/${screen}` });

    let last = '';
    let stable = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const { result } = await c.send('Runtime.evaluate', { expression: SETTLED, returnByValue: true });
      const v = String(result.value ?? '');
      if (v.startsWith('ok:')) {
        stable = v === last ? stable + 1 : 0;
        last = v;
        if (stable >= 3) break;      // same height three polls running
      } else {
        stable = 0; last = v;
      }
    }
    if (!last.startsWith('ok:')) {
      console.log(`  ${screen.padEnd(9)} FAILED — never settled (last state: ${last || 'none'})`);
      return false;
    }
    await sleep(600);                // let one animation frame's transitions land

    const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
  } catch (err) {
    console.log(`  ${screen.padEnd(9)} FAILED — ${err.message}`);
    return false;
  } finally {
    c.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => {});
  }
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`  ${screen.padEnd(9)} ${String(kb).padStart(5)} KB  shots/now/${screen}.png`);
  return true;
}

/* ----------------------------------------------------------------- main --- */

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const screens = want.length ? want : SCREENS;
const unknown = screens.filter((s) => !SCREENS.includes(s));
if (unknown.length) {
  console.error(`Unknown screen(s): ${unknown.join(', ')}`);
  console.error(`Known: ${SCREENS.join(', ')}`);
  process.exit(1);
}

await preflight();
fs.mkdirSync(OUT, { recursive: true });

const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) {
  console.error('No Chromium-based browser found. Looked in:');
  for (const b of BROWSERS) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`  ${path.basename(browser)} · ${W}x${H} @${SCALE}x\n`);

const { proc, profile } = await launch(browser);
let ok = 0;
try {
  for (const s of screens) if (await capture(s)) ok++;
} finally {
  // The browser's helper processes keep writing into the profile for a moment
  // after the kill, so a single rm races them and throws ENOTEMPTY. Wait for
  // the exit, then retry briefly. A leftover temp dir is not worth failing on.
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGKILL');
  await Promise.race([exited, sleep(3000)]);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break; }
    catch { await sleep(400); }
  }
}
console.log(`\n  ${ok}/${screens.length} captured into shots/now/\n`);
process.exit(ok === screens.length ? 0 : 1);
