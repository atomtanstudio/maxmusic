#!/usr/bin/env node
/**
 * Scans each screen for visible occurrences of the product name and reports
 * where they sit. Anything below the blind crop line has to be neutralised
 * before a pairing goes to a judge, or the test is not blind.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://localhost:3020';
const PORT = 9361;
const CROP_TOP = 56;
const SCREENS = ['create', 'studio', 'library', 'lyrics', 'art'];
const BROWSER = '/Applications/ego lite.app/Contents/MacOS/ego lite';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-'));
const proc = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-gpu-compositing',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--remote-allow-origins=*', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1728,959', 'about:blank',
], { stdio: 'ignore' });

for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
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
      setTimeout(() => { if (pending.delete(i)) rej(new Error(`${method} timed out`)); }, 20000);
    }),
    close: () => ws.close(),
  };
}

const SCAN = `(() => {
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/MaxMusic/i.test(n.nodeValue || '')) continue;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    hits.push({
      text: n.nodeValue.trim().slice(0, 70),
      top: Math.round(r.top), left: Math.round(r.left),
      sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').filter(Boolean).join('.') : ''),
    });
  }
  // Also catch it in attributes that paint: alt, title, aria-label, placeholder.
  for (const el of document.querySelectorAll('[alt],[title],[aria-label],[placeholder]')) {
    for (const a of ['alt','title','aria-label','placeholder']) {
      const v = el.getAttribute(a);
      if (v && /MaxMusic/i.test(v)) {
        const r = el.getBoundingClientRect();
        hits.push({ text: '@' + a + '="' + v.slice(0,50) + '"', top: Math.round(r.top), left: Math.round(r.left),
          sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').filter(Boolean).join('.') : '') });
      }
    }
  }
  return JSON.stringify(hits);
})()`;

for (const screen of SCREENS) {
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${APP}/#/${screen}`)}`, { method: 'PUT' })).json();
  const c = client(tab.webSocketDebuggerUrl);
  await c.ready;
  await sleep(3500);
  const { result } = await c.send('Runtime.evaluate', { expression: SCAN, returnByValue: true });
  const hits = JSON.parse(result.value || '[]');
  const below = hits.filter((h) => h.top >= CROP_TOP);
  console.log(`\n${screen}  (${hits.length} total, ${below.length} survive the ${CROP_TOP}px crop)`);
  for (const h of hits) {
    console.log(`  ${h.top >= CROP_TOP ? 'VISIBLE ' : 'cropped '} y=${String(h.top).padStart(4)} x=${String(h.left).padStart(4)}  ${h.sel}`);
    console.log(`             "${h.text}"`);
  }
  c.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => {});
}

proc.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true });
console.log('');
