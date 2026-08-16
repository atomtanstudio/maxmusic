// MaxMusic — redesigned front end.
// Serves public/ and proxies the API to the existing maxmusic backend, which owns
// the ComfyUI (MiniMax Music 3) and local OpenAI wiring. Nothing here talks to
// ComfyUI directly, so the backend repo stays untouched.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleStudio } from './render/jobs.mjs';
import { enforceLength, clock } from './public/js/pacing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3020);
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 3010);

const PROXY_PREFIXES = ['/api', '/uploads', '/covers', '/tracks'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Pipe a request straight through to the backend, preserving streaming.
 *
 * @param {?string} body   a replacement request body, or null to stream the
 *                         original through untouched.
 * @param {?(payload: *) => void} onJson  called with the parsed response when
 *                         it is JSON. The customer's copy is never delayed for
 *                         this: the response is piped as it arrives and only a
 *                         copy is kept, so a watcher cannot slow a render down
 *                         or break a stream by existing.
 */
function proxy(req, res, body = null, onJson = null) {
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
  if (body !== null) {
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(body);
  }

  const upstream = http.request(
    {
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      if (!onJson || !/json/i.test(up.headers['content-type'] || '')) {
        up.pipe(res);
        return;
      }
      const seen = [];
      let kept = 0;
      up.on('data', (c) => { if (kept < MAX_BODY) { seen.push(c); kept += c.length; } });
      up.on('end', () => {
        try { onJson(JSON.parse(Buffer.concat(seen).toString('utf8'))); }
        catch { /* not the shape we were watching for */ }
      });
      up.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'Backend unreachable',
        detail: `${err.code || err.message} — expected the maxmusic backend on ${BACKEND_HOST}:${BACKEND_PORT}`,
      })
    );
  });

  if (body !== null) {
    upstream.end(body);
    return;
  }
  req.pipe(upstream);
}

/* -------------------------------------------------------------------------- *
 * The length floor
 *
 * A lyric sheet longer than the running time can sing does not get sung fast —
 * it gets cut off in the middle of a line, which is the single worst thing this
 * app can hand somebody. The screens already fit the words to the take before
 * asking for a song, but a screen can be bypassed: a tab left open on
 * yesterday's JavaScript, the Studio screen, a script posting to the API. One
 * song was truncated for exactly that reason after the screen-side fix shipped.
 *
 * So every generation is checked here on the way past, where nothing can miss
 * it. This only ever removes surplus sections; it never changes the length that
 * was asked for, and a request that already fits is forwarded untouched.
 * -------------------------------------------------------------------------- */

const PACED_ROUTE = /^\/api\/generate(-dual|-stream)?(\?|$)/;
const MAX_BODY = 2 * 1024 * 1024;

/* Whether the studio lets the model choose its own length.
 *
 * MiniMax reads the lyrics, plans an arrangement and reports how long that
 * arrangement is; the workflow can either use that answer or overrule it with
 * the length that was requested. While it overrules it, a sheet that outruns
 * the canvas is cut off mid-phrase and this floor is what prevents that. Once
 * the model is allowed to answer, the floor would be cutting verses the model
 * had every intention of singing.
 *
 * Nothing needs configuring either way: a song that comes back SHORTER than it
 * was asked for can only mean the model set the length, so that is the signal.
 * See docs/backend-let-the-model-set-the-length.md.
 */
const PACING_FLAG = path.join(__dirname, 'render', 'data', 'model-sets-length.json');
let modelSetsLength = false;
try {
  modelSetsLength = JSON.parse(fs.readFileSync(PACING_FLAG, 'utf8')).modelSetsLength === true;
} catch { /* first run */ }

function noteDeliveredLength(asked, delivered) {
  if (modelSetsLength || !(asked > 0) || !(delivered > 0)) return;
  if (delivered > asked - 2) return;
  modelSetsLength = true;
  console.log(
    `[length] asked for ${clock(asked)} and got ${clock(delivered)} — the model is choosing its own `
    + 'length now, so the app will stop trimming lyric sheets.',
  );
  try {
    fs.mkdirSync(path.dirname(PACING_FLAG), { recursive: true });
    fs.writeFileSync(PACING_FLAG, JSON.stringify({ modelSetsLength: true, noticedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error('[length] could not remember that —', err.message);
  }
}

/**
 * How long the song that came back actually is.
 *
 * Measured off the audio, not read from the reply: the backend fills in
 * `music_duration` from the length that was REQUESTED, so it says 3:00 for a
 * 2:52 song and would hide the very thing this is watching for.
 */
function deliveredSeconds(payload) {
  const track = [payload, payload?.takes?.A, payload?.takes?.B]
    .map((t) => t?.track?.url || t?.url)
    .find((u) => typeof u === 'string' && u.startsWith('/'));
  if (!track) return Promise.resolve(0);

  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      `http://${BACKEND_HOST}:${BACKEND_PORT}${track}`,
    ]);
    let out = '';
    probe.stdout.on('data', (c) => { out += c; });
    probe.on('error', () => resolve(0));
    probe.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

/**
 * One buffered round trip to the backend. Used where the reply has to be READ
 * before it can be answered with — piping is right for everything else.
 *
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
function askBackend(req, bodyText) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(bodyText);
    const up = http.request(
      { host: BACKEND_HOST, port: BACKEND_PORT, method: req.method, path: req.url, headers },
      (r) => {
        const parts = [];
        r.on('data', (c) => parts.push(c));
        r.on('end', () => resolve({ status: r.statusCode || 502, headers: r.headers, body: Buffer.concat(parts).toString('utf8') }));
      },
    );
    up.on('error', reject);
    up.end(bodyText);
  });
}

/* -------------------------------------------------------------------------- *
 * The ceiling guard
 *
 * `max_duration` is a ceiling and the model ends the song earlier when the song
 * is over — but when its arrangement needs MORE than the ceiling, it does not
 * get to say so. It plans right up to the limit and the recording stops
 * mid-line. That is what a cut-off song is, every time: the plan came back
 * equal to the ceiling.
 *
 * Which makes it detectable without asking anything in advance. A song that
 * fits ends somewhere short of its ceiling — 2:25, 2:52, 2:56 of a 3:00 — and
 * a song that was squeezed lands on it to the centisecond. When that happens
 * the song is made once more with room to finish. Measured on the song that
 * prompted this: a 3:00 ceiling had it planning 180.0s exactly, and the same
 * words under a 4:05 ceiling planned 3:13 and ended properly.
 *
 * Asking the model up front instead would cost a minute on EVERY song, for a
 * question that is only interesting occasionally, and its answer changes with
 * the ceiling anyway.
 * -------------------------------------------------------------------------- */

const CEILING_HEADROOM = 1.35;
const HIT_THE_CEILING = 0.6;

/* What the model can actually sing in a second once it is allowed to set its
   own length — measured, not guessed: 399 words in 172s is 2.32. Sheets are
   left alone below this. It is not a pacing target like the old one, which
   existed to protect a fixed canvas; it is the point past which no amount of
   extra room will help, so words have to come out instead. */
const BEYOND_SINGING = 2.4;

async function guardCeiling(req, res, body, raw, hasWords) {
  const asked = Number(body.duration);

  // A sheet nobody could sing in the time available, at any ceiling.
  if (hasWords) try {
    const ceilingRoom = Math.min(360, Math.round(asked * CEILING_HEADROOM));
    const fitted = enforceLength({ lyrics: String(body.lyrics), duration: ceilingRoom, density: BEYOND_SINGING });
    if (fitted.trimmed.length) {
      console.log(
        `[length] even with ${clock(ceilingRoom)} to sing in, ${fitted.raw} words is past what a voice gets `
        + `through. Dropped ${fitted.trimmed.join(', ')}.`,
      );
      body = { ...body, lyrics: fitted.lyrics };
      raw = JSON.stringify(body);
    }
  } catch (err) {
    console.error('[length] could not weigh this sheet —', err.message);
  }

  // Whether anyone is still waiting for this. NOT `req.destroyed`, which is
  // true the moment the request body has been read — a stream auto-destroys
  // when it ends, so reading that as "they left" made this give up every time.
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) clientGone = true; });

  let reply;
  try {
    reply = await askBackend(req, raw);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'Backend unreachable',
      detail: `${err.code || err.message} — expected the maxmusic backend on ${BACKEND_HOST}:${BACKEND_PORT}`,
    }));
    return;
  }

  const send = (r) => {
    const headers = { ...r.headers };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(r.body);
    res.writeHead(r.status, headers);
    res.end(r.body);
  };

  let payload = null;
  try { payload = JSON.parse(reply.body); } catch { /* not ours to reason about */ }
  if (reply.status !== 200 || !payload) return send(reply);

  const delivered = await deliveredSeconds(payload).catch(() => 0);
  noteDeliveredLength(asked, delivered);

  const squeezed = delivered > 0 && asked > 0 && delivered >= asked - HIT_THE_CEILING;
  // Nobody is waiting for this any more, so there is nothing to rescue.
  if (!squeezed || clientGone || res.writableEnded) return send(reply);

  const roomier = Math.min(360, Math.round(asked * CEILING_HEADROOM));
  if (roomier <= asked) return send(reply);

  console.log(
    `[length] this song used every second of ${clock(asked)}, which is what being cut off looks like. `
    + `Making it again, with up to ${clock(roomier)} to finish in.`,
  );

  let second;
  try {
    second = await askBackend(req, JSON.stringify({ ...body, duration: roomier }));
  } catch (err) {
    console.error('[length] the second attempt did not come back —', err.message, '· keeping the first.');
    return send(reply);
  }

  let secondPayload = null;
  try { secondPayload = JSON.parse(second.body); } catch { /* keep the first */ }
  if (second.status !== 200 || !secondPayload) return send(reply);

  const secondLength = await deliveredSeconds(secondPayload).catch(() => 0);
  if (secondLength > 0 && secondLength < roomier - HIT_THE_CEILING) {
    console.log(`[length] it came out ${clock(secondLength)} and ended on its own.`);
  } else {
    console.log(`[length] it wanted the whole ${clock(roomier)} as well — sending it, but this song wants to be longer than the studio will go.`);
  }
  send(second);
}

function paceRequest(req, res) {
  const chunks = [];
  let size = 0;
  let tooBig = false;

  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { tooBig = true; return; }
    chunks.push(c);
  });

  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    // Anything unexpected — oversized, not JSON, no words to weigh — is not
    // this function's business. Forward it exactly as it arrived.
    if (tooBig) return proxy(req, res, raw);

    let body;
    try { body = JSON.parse(raw); } catch { return proxy(req, res, raw); }
    if (!body || typeof body !== 'object' || !body.duration) return proxy(req, res, raw);

    // An instrumental has no words to weigh, but it is a song with an
    // arrangement and it gets squeezed against the ceiling exactly like any
    // other — a 0:30 instrumental came back 29.99s long, which is a cut-off.
    // Only the lyric side of this is about lyrics.
    const hasWords = !body.is_instrumental && Boolean(body.lyrics);

    // Watch what comes back, whether or not anything is trimmed on the way out.
    // This runs after the customer already has their response, so measuring the
    // audio cannot hold a render up.
    const watch = (payload) => {
      Promise.resolve(deliveredSeconds(payload))
        .then((seconds) => noteDeliveredLength(Number(body.duration), seconds))
        .catch(() => {});
    };

    // A stream cannot be read and reconsidered, so it keeps the simple path.
    if (modelSetsLength && !/-stream/.test(req.url)) return guardCeiling(req, res, body, raw, hasWords);
    if (modelSetsLength || !hasWords) return proxy(req, res, raw, watch);

    let fitted;
    try {
      fitted = enforceLength({
        lyrics: String(body.lyrics),
        duration: Number(body.duration),
        voice: String(body.prompt || ''),
      });
    } catch (err) {
      console.error('[length] could not weigh this sheet, sending it as it came —', err.message);
      return proxy(req, res, raw);
    }

    if (!fitted.trimmed.length) return proxy(req, res, raw, watch);

    console.log(
      `[length] ${clock(body.duration)} can sing about ${fitted.limit} words; this sheet had `
      + `${fitted.raw}. Dropped ${fitted.trimmed.join(', ')} so the song can reach its ending.`,
    );
    proxy(req, res, JSON.stringify({ ...body, lyrics: fitted.lyrics }), watch);
  });

  req.on('error', () => { if (!res.headersSent) res.writeHead(400).end('Bad request'); });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const root = path.join(__dirname, 'public');
  const filePath = path.normalize(path.join(root, pathname));

  // Never serve outside public/
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-style fallback so client routes deep-link cleanly.
      const fallback = path.join(root, 'index.html');
      return fs.readFile(fallback, (e, buf) => {
        if (e) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(buf);
      });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // `no-cache` still lets a browser hold the file and revalidate; a fix that
    // has shipped should never be one stale copy away from not existing. Code
    // and markup are never stored, media still is.
    const code = /\.(html|js|mjs|css|json|map)$/i.test(filePath);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': code ? 'no-store, must-revalidate' : 'no-cache',
      'content-length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* -------------------------------------------------------------------------- *
 * Build stamp
 *
 * A tab left open keeps running the JavaScript it loaded, however many times
 * the files underneath it change — no cache header reaches code that is already
 * in memory. That cost a real afternoon: a fix shipped, the open tab carried on
 * without it, and the song failed exactly as before. So the app can ask what it
 * is running against and say when it has gone stale.
 * -------------------------------------------------------------------------- */

let stampCache = { at: 0, value: '' };

function buildStamp() {
  if (Date.now() - stampCache.at < 5000) return stampCache.value;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|js|mjs|css)$/i.test(entry.name)) continue;
      const m = fs.statSync(full).mtimeMs;
      if (m > newest) newest = m;
    }
  };
  try { walk(path.join(__dirname, 'public')); } catch { /* keep the old stamp */ }
  stampCache = { at: Date.now(), value: String(Math.round(newest)) };
  return stampCache.value;
}

const server = http.createServer((req, res) => {
  if (req.url === '/app-version') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ stamp: buildStamp() }));
    return;
  }

  // The studio — audio export and video rendering — lives on this machine,
  // not on the backend, because this machine has ffmpeg, whisper and the
  // renderer.
  if (req.url.startsWith('/studio/')) {
    if (handleStudio(req, res, { host: BACKEND_HOST, port: BACKEND_PORT })) return;
  }
  const isProxied = PROXY_PREFIXES.some(
    (p) => req.url === p || req.url.startsWith(p + '/') || req.url.startsWith(p + '?')
  );
  if (isProxied) {
    if (req.method === 'POST' && PACED_ROUTE.test(req.url)) return paceRequest(req, res);
    return proxy(req, res);
  }
  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is in use. Try: PORT=${PORT + 1} node server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  MaxMusic → http://localhost:${PORT}`);
  console.log(`  API proxied to ${BACKEND_HOST}:${BACKEND_PORT}\n`);
});
