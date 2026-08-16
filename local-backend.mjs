/**
 * The app, standing on its own.
 *
 * MaxMusic began as a front end for a separate studio service, which in turn
 * drove ComfyUI. That is a lot of moving parts to ask somebody to assemble
 * before they can hear a song. This module lets the app answer its own API
 * against two things instead: the model worker (`worker/`) for the music, and
 * any OpenAI-compatible chat endpoint for the words.
 *
 * It is opt-in. Set `WORKER_URL` and these routes take over; leave it unset
 * and everything is proxied to a studio backend exactly as before, so an
 * existing ComfyUI setup keeps working untouched.
 *
 * What it deliberately does NOT do: pretend to have things it has not got.
 * Cover art with no image endpoint configured answers plainly that it is not
 * set up, rather than failing somewhere deeper where the message would be
 * about JSON instead of about artwork.
 *
 * @module local-backend
 */

import http from 'node:http';
import https from 'node:https';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');

/* The words. Anything speaking the OpenAI chat API will do: Ollama (the
   default, since it needs no key and no account), LM Studio, llama.cpp's
   server, or api.openai.com with a key. */
const LLM_URL = (process.env.LYRICS_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LYRICS_MODEL || 'qwen3:14b';
const LLM_KEY = process.env.LYRICS_KEY || '';

/** Artwork is optional; the lyric video and the visualizer never needed it. */
const IMAGE_URL = (process.env.COVER_URL || '').replace(/\/+$/, '');
const IMAGE_MODEL = process.env.COVER_MODEL || 'gpt-image-1';
const IMAGE_KEY = process.env.COVER_KEY || '';

export const standalone = Boolean(WORKER_URL);

/* -------------------------------------------------------------------------- *
 * Small HTTP helpers — no dependencies, same as the rest of this project
 * -------------------------------------------------------------------------- */

function fetchJson(url, { method = 'GET', body = null, headers = {}, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* left null on purpose */ }
          resolve({ status: res.statusCode || 0, body: parsed, text });
        });
      },
    );
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* -------------------------------------------------------------------------- *
 * Lyrics
 * -------------------------------------------------------------------------- */

/**
 * The brief the writer works to.
 *
 * The pacing rules are not decoration: a sheet longer than the running time
 * can sing gets cut off mid-phrase, and the structure tags have to sit on
 * their own lines or the model silently drops whatever shares a line with
 * them. Both were learned from songs that came out wrong.
 */
function lyricBrief({ prompt, duration, mode, lyrics, title }) {
  const seconds = Number(duration) > 0 ? Math.round(Number(duration)) : 120;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const words = Math.round(seconds * 1.6);

  const rules = [
    `Write a song that runs about ${clock}. Aim for roughly ${words} sung words — a little under is better than over, because a sheet that outruns the take is cut off mid-line.`,
    'Use structure tags in square brackets — [intro], [verse], [pre-chorus], [chorus], [bridge], [instrumental], [outro] — and put every tag ALONE on its own line, with the words on the lines beneath it. Text sharing a line with a tag is thrown away.',
    'Pace the song to LAND. Give it an ending: close on an [outro] or a final chorus that resolves. Never pad by repeating a hook to fill time.',
    'No commentary, no explanation, no markdown fences. Reply with JSON only.',
  ];

  const shape = mode === 'edit'
    ? `Rewrite these lyrics, keeping their meaning and improving the craft:\n\n${lyrics}`
    : `Write the song from this idea:\n\n${prompt}`;

  return [
    'You write lyrics for a musician using an AI music model.',
    shape,
    title ? `The song is called "${title}".` : '',
    ...rules,
    'Reply with exactly this JSON shape and nothing else:',
    '{"song_title": "…", "style_tags": "genre, tempo in bpm, key, mood, instrumentation, vocal description", "lyrics": "[intro]\\n…"}',
  ].filter(Boolean).join('\n\n');
}

/** Pull the JSON object out of a reply that may have wandered around it. */
function readModelJson(text) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

async function writeLyrics(req, res) {
  const body = await readBody(req);
  const brief = lyricBrief({
    prompt: String(body.prompt || ''),
    duration: body.duration,
    mode: body.mode === 'edit' ? 'edit' : 'write_full_song',
    lyrics: String(body.lyrics || ''),
    title: String(body.title || ''),
  });

  let reply;
  try {
    reply = await fetchJson(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {},
      body: {
        model: LLM_MODEL,
        messages: [{ role: 'user', content: brief }],
        temperature: 0.9,
        stream: false,
      },
      timeoutMs: 10 * 60 * 1000,
    });
  } catch (err) {
    return send(res, 502, {
      error: `The lyric writer at ${LLM_URL} did not answer (${err.message}). `
        + 'Start it, or point LYRICS_URL somewhere else — anything speaking the OpenAI chat API will do.',
    });
  }

  if (reply.status !== 200) {
    return send(res, 502, {
      error: `The lyric writer answered ${reply.status}. ${String(reply.text || '').slice(0, 300)}`,
    });
  }

  const content = reply.body?.choices?.[0]?.message?.content ?? '';
  const parsed = readModelJson(content);
  if (!parsed?.lyrics) {
    return send(res, 502, {
      error: 'The lyric writer replied with something that was not a song. Try again, or use a stronger model.',
      detail: String(content).slice(0, 400) || null,
    });
  }

  send(res, 200, {
    ok: true,
    song_title: String(parsed.song_title || '').trim(),
    style_tags: String(parsed.style_tags || '').trim(),
    lyrics: String(parsed.lyrics || '').trim(),
    provider: 'openai-compatible',
    model: LLM_MODEL,
  });
}

/* -------------------------------------------------------------------------- *
 * Music
 * -------------------------------------------------------------------------- */

async function makeSong(body) {
  const reply = await fetchJson(`${WORKER_URL}/generate`, {
    method: 'POST',
    body: {
      prompt: String(body.prompt || ''),
      lyrics: String(body.lyrics || ''),
      is_instrumental: Boolean(body.is_instrumental),
      duration: Number(body.duration) || 120,
      seed: body.seed ?? null,
    },
    timeoutMs: 60 * 60 * 1000,
  });
  if (reply.status !== 200) {
    const detail = reply.body?.detail || reply.text || '';
    throw new Error(String(detail).slice(0, 400) || `the worker answered ${reply.status}`);
  }
  return reply.body;
}

async function generate(req, res) {
  const body = await readBody(req);
  try {
    send(res, 200, await makeSong(body));
  } catch (err) {
    send(res, 502, { error: `The studio could not make that song. ${err.message}` });
  }
}

async function generateDual(req, res) {
  const body = await readBody(req);
  const takes = { A: null, B: null };
  const errors = [];
  // Sequential on purpose: one GPU, one song at a time.
  for (const slot of ['A', 'B']) {
    try {
      takes[slot] = await makeSong({
        ...body,
        seed: body.seed ?? null,
        // The second take explores a different arrangement of the same brief.
        ...(slot === 'B' ? { seed: null } : {}),
      });
    } catch (err) {
      errors.push({ slot, error: err.message });
    }
  }
  send(res, 200, { ok: Boolean(takes.A || takes.B), takes, errors });
}

/** The same song, delivered as the event stream the Studio screen listens to. */
async function generateStream(req, res) {
  const body = await readBody(req);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const event = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  event({ status: 'queued', backend: 'diffusers-worker' });
  const beat = setInterval(() => event({ status: 'working' }), 15_000);
  try {
    const result = await makeSong(body);
    event({ done: true, ...result });
  } catch (err) {
    event({ error: `The studio could not make that song. ${err.message}` });
  } finally {
    clearInterval(beat);
    res.end();
  }
}

/* -------------------------------------------------------------------------- *
 * Health
 * -------------------------------------------------------------------------- */

async function health(req, res) {
  let worker = null;
  let reachable = false;
  try {
    const reply = await fetchJson(`${WORKER_URL}/health`, { timeoutMs: 5000 });
    worker = reply.body;
    reachable = reply.status === 200 && worker?.ok !== false;
  } catch { /* reported below in the customer's language */ }

  let lyricsProvider = 'disabled';
  try {
    const models = await fetchJson(`${LLM_URL}/models`, {
      headers: LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {},
      timeoutMs: 2500,
    });
    if (models.status === 200) lyricsProvider = 'openai-compatible';
  } catch { /* stays disabled */ }

  send(res, 200, {
    ok: reachable,
    backend: 'diffusers-worker',
    // The app calls the model runtime "comfy" throughout for historical
    // reasons; these fields are that slot, whoever is filling it.
    comfyUrl: WORKER_URL,
    comfyReachable: reachable,
    comfyError: reachable ? null : `No answer from the model worker at ${WORKER_URL}. Start it with ./start.sh, or set WORKER_URL.`,
    musicModels: { 'minimax-music-3': worker?.model || 'MiniMax Music 3' },
    lyrics: lyricsProvider,
    coverArt: IMAGE_URL ? 'openai-compatible' : 'disabled',
    hasServerKey: Boolean(LLM_KEY || IMAGE_KEY),
    worker,
  });
}

/* -------------------------------------------------------------------------- *
 * Cover art — optional, and honest when it is missing
 * -------------------------------------------------------------------------- */

async function coverArt(req, res) {
  const body = await readBody(req);
  if (!IMAGE_URL) {
    return send(res, 501, {
      error: 'No artwork service is set up. Songs, lyric videos and visualizers all work without one — '
        + 'set COVER_URL to anything speaking the OpenAI images API if you want covers too.',
    });
  }
  try {
    const reply = await fetchJson(`${IMAGE_URL}/images/generations`, {
      method: 'POST',
      headers: IMAGE_KEY ? { authorization: `Bearer ${IMAGE_KEY}` } : {},
      body: { model: IMAGE_MODEL, prompt: String(body.prompt || ''), n: 1, size: '1024x1024' },
      timeoutMs: 10 * 60 * 1000,
    });
    const first = reply.body?.data?.[0];
    const url = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
    if (reply.status !== 200 || !url) {
      throw new Error(String(reply.body?.error?.message || reply.text || reply.status).slice(0, 300));
    }
    send(res, 200, { ok: true, cover: { url } });
  } catch (err) {
    send(res, 502, { error: `The artwork service did not deliver. ${err.message}` });
  }
}

/* -------------------------------------------------------------------------- *
 * The finished audio
 * -------------------------------------------------------------------------- */

function streamTrack(req, res) {
  const target = new URL(WORKER_URL + req.url);
  const mod = target.protocol === 'https:' ? https : http;
  const upstream = mod.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      // Range matters: the player seeks.
      headers: { ...(req.headers.range ? { range: req.headers.range } : {}) },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) send(res, 502, { error: 'The model worker is not answering for that file.' });
    else res.destroy();
  });
  req.pipe(upstream);
}

/* -------------------------------------------------------------------------- *
 * The router
 * -------------------------------------------------------------------------- */

/**
 * Answer a request locally, or say no so the caller can proxy it onward.
 * @returns {boolean} true when this module has taken the request.
 */
export function handleLocal(req, res) {
  if (!standalone) return false;
  const path = String(req.url || '').split('?')[0];
  const post = req.method === 'POST';

  if (path === '/api/health') { health(req, res); return true; }
  if (path === '/api/generate' && post) { generate(req, res); return true; }
  if (path === '/api/generate-dual' && post) { generateDual(req, res); return true; }
  if (path === '/api/generate-stream' && post) { generateStream(req, res); return true; }
  if (path === '/api/lyrics' && post) { writeLyrics(req, res); return true; }
  if (path === '/api/cover-art' && post) { coverArt(req, res); return true; }
  if (path.startsWith('/tracks/')) { streamTrack(req, res); return true; }

  // There is no hosted account in this shape of the app, and the screens read
  // this to decide what to offer. Answering plainly is what keeps them honest.
  if (path === '/api/openai/status') {
    send(res, 200, {
      brokerConfigured: false, authenticated: false, codexAvailable: false,
      imageGeneration: Boolean(IMAGE_URL), provider: 'local', planType: null,
    });
    return true;
  }
  if (path.startsWith('/api/openai/')) {
    send(res, 501, { error: 'This copy of MaxMusic has no hosted account to sign in to. Everything runs on your machine.' });
    return true;
  }
  if (path === '/api/cover' || path === '/api/cover-preprocess' || path === '/api/upload') {
    send(res, 501, { error: 'Uploads are not part of this local setup yet.' });
    return true;
  }
  if (path.startsWith('/api/')) {
    send(res, 404, { error: `No such endpoint in the local studio: ${path}` });
    return true;
  }
  return false;
}
