/**
 * The app, standing on its own.
 *
 * MaxMusic began as a front end for a separate studio service, which in turn
 * drove ComfyUI. That is a lot of moving parts to ask somebody to assemble
 * before they can hear a song. This module lets the app answer its own API
 * against three things instead: the model worker (`worker/`) for the music, an
 * optional server-side OpenAI account backend for words and covers, and an
 * OpenAI-compatible chat endpoint as the local fallback.
 *
 * It is opt-in. Set `WORKER_URL` and these routes take over; leave it unset
 * and everything is proxied to a studio backend exactly as before, so an
 * existing ComfyUI setup keeps working untouched.
 *
 * The account backend is deliberately a narrow relay. The browser never sees
 * its credential and never talks to the broker directly. When it is configured,
 * it owns the lyrics, cover-art and account routes; the local
 * Ollama-compatible writer remains available when it is not.
 *
 * @module local-backend
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';

import {
  enforceLength,
  countSungWords,
  clock,
  durationBallpark,
  inDurationBallpark,
  normalizeSongEnding,
} from './public/js/pacing.js';
import {
  ensureMusic3Caption,
  instrumentalStructureLyrics,
  requestsInstrumental,
} from './public/js/music3-caption.js';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');

/* A server-side backend that already implements the OpenAI account contract in
   the account contract. This is not the broker itself: do not point this at the
   broker's private port and do not put a broker token in the environment. */
const OPENAI_BACKEND_URL = (process.env.OPENAI_BACKEND_URL || '').replace(/\/+$/, '');

/**
 * An OpenAI credential the person at this computer already has.
 *
 * Somebody who has signed in with the Codex CLI, or exported the usual
 * environment variable, has already done the work; asking them to paste the
 * same key into a second file is a chore with no benefit. This reads only
 * files that belong to the person running the app, stays on the server, and
 * never returns the credential itself to the browser.
 *
 * A ChatGPT sign-in is recognised but deliberately not used as if it were an
 * API key: that token is issued for the Codex client, not for this app. It is
 * reported so the UI can say what was found and what it would still need.
 *
 * @returns {{key: string|null, mode: string, source: string|null}}
 */
function localOpenAiAccount() {
  const fromEnv = String(process.env.OPENAI_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, mode: 'api-key', source: 'the OPENAI_API_KEY environment variable' };

  const home = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const key = String(auth?.OPENAI_API_KEY || '').trim();
    if (key) return { key, mode: 'api-key', source: 'the OpenAI sign-in already on this computer' };
    if (auth?.tokens?.access_token) {
      return { key: null, mode: 'chatgpt', source: 'a ChatGPT sign-in already on this computer' };
    }
  } catch { /* no local sign-in, which is perfectly normal */ }
  return { key: null, mode: 'none', source: null };
}

const LOCAL_OPENAI = localOpenAiAccount();
const OPENAI_API = 'https://api.openai.com/v1';

/* The words. Anything speaking the OpenAI chat API will do: Ollama (which
   needs no key and no account), LM Studio, llama.cpp's server, or OpenAI
   itself. Nothing configured and a credential already on the machine means
   OpenAI; nothing configured and no credential means Ollama, which somebody
   can install without an account. Ollama gets its native chat route so
   thinking can be disabled and its context window can stay small enough to
   share memory with Music 3. */
const CONFIGURED_LYRICS_URL = String(process.env.LYRICS_URL || '').trim().replace(/\/+$/, '');
const LYRICS_USE_OPENAI = !CONFIGURED_LYRICS_URL && Boolean(LOCAL_OPENAI.key);
const LLM_URL = CONFIGURED_LYRICS_URL
  || (LYRICS_USE_OPENAI ? OPENAI_API : 'http://127.0.0.1:11434/v1');
const LLM_MODEL = process.env.LYRICS_MODEL || (LYRICS_USE_OPENAI ? 'gpt-4o-mini' : 'qwen3:14b');
const LLM_KEY = process.env.LYRICS_KEY
  || (LLM_URL.startsWith(OPENAI_API) ? LOCAL_OPENAI.key || '' : '');
const LLM_API = String(
  process.env.LYRICS_API || (LLM_URL.includes(':11434') ? 'ollama' : 'openai-compatible'),
).toLowerCase();
const LLM_CONTEXT = Math.max(2048, Number(process.env.LYRICS_CONTEXT || 8192));
const LLM_MAX_TOKENS = Math.max(256, Number(process.env.LYRICS_MAX_TOKENS || 1200));

/* Artwork is optional; the lyric video and the visualizer never needed it. A
   credential already on the machine is enough to offer it, and covers are only
   ever made when somebody asks for one. */
const CONFIGURED_COVER_URL = String(process.env.COVER_URL || '').trim().replace(/\/+$/, '');
const IMAGE_URL = CONFIGURED_COVER_URL || (LOCAL_OPENAI.key ? OPENAI_API : '');
const IMAGE_MODEL = process.env.COVER_MODEL || 'gpt-image-1';
const IMAGE_KEY = process.env.COVER_KEY
  || (IMAGE_URL.startsWith(OPENAI_API) ? LOCAL_OPENAI.key || '' : '');

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
  // A browser refresh can close the response while a GPU render is still
  // finishing. Persistence happens before this function is called; do not
  // turn a normal disconnected client into an unhandled write error.
  if (res.destroyed || res.writableEnded) return;
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

/** The worker is intentionally single-flight. Keep that state distinct from
 * a failed render so the UI can tell a person what actually happened. */
class WorkerBusyError extends Error {
  constructor() {
    super('Another render is already in progress. It will release the studio when it finishes; this song was not started.');
    this.name = 'WorkerBusyError';
    this.code = 'worker_busy';
    this.status = 409;
  }
}

/* -------------------------------------------------------------------------- *
 * OpenAI account backend relay
 * -------------------------------------------------------------------------- */

function accountTarget(requestUrl) {
  return `${OPENAI_BACKEND_URL}${requestUrl}`;
}

function requestHasBody(req) {
  const length = req.headers['content-length'];
  return req.method !== 'GET' && req.method !== 'HEAD'
    && (length === undefined || Number(length) > 0 || Boolean(req.headers['transfer-encoding']));
}

/**
 * Keep account/OAuth credentials on the configured backend. The native app
 * only forwards the documented JSON routes and deliberately drops browser
 * authorization/cookie headers rather than carrying an accidental secret
 * across the boundary.
 */
async function forwardAccountRequest(req, res) {
  let body = null;
  if (requestHasBody(req)) body = await readBody(req);

  const path = String(req.url || '').split('?')[0];
  const timeoutMs = path === '/api/openai/status'
    ? 10_000
    : path.startsWith('/api/lyrics') || path.startsWith('/api/cover-art')
      ? 10 * 60 * 1000
      : 20_000;

  let reply;
  try {
    reply = await fetchJson(accountTarget(req.url), {
      method: req.method,
      body,
      timeoutMs,
    });
  } catch (error) {
    return send(res, 502, {
      error: `The OpenAI account backend did not answer (${error.message}).`,
    });
  }

  if (reply.body !== null) return send(res, reply.status || 502, reply.body);
  return send(res, reply.status || 502, {
    error: String(reply.text || 'The OpenAI account backend returned no JSON response.').slice(0, 400),
  });
}

/** Serve relative `/covers/...` results from the account backend same-origin. */
function streamAccountMedia(req, res) {
  let target;
  try { target = new URL(accountTarget(req.url)); }
  catch { return send(res, 400, { error: 'The cover URL is invalid.' }); }

  const mod = target.protocol === 'https:' ? https : http;
  const headers = {};
  for (const key of ['range', 'if-none-match', 'if-modified-since']) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  const upstream = mod.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (reply) => {
      res.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (!res.headersSent) send(res, 502, { error: `The cover backend did not answer (${error.message}).` });
    else res.destroy();
  });
  req.pipe(upstream);
}

async function accountHealth() {
  if (!OPENAI_BACKEND_URL) return null;
  try {
    const reply = await fetchJson(accountTarget('/api/openai/status'), { timeoutMs: 5000 });
    return reply.status === 200 && reply.body ? reply.body : null;
  } catch { return null; }
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
  const runtime = clock(seconds);
  const words = Math.round(seconds * 1.6);

  const rules = [
    `Write a song that runs about ${runtime}. Aim for roughly ${words} sung words — a little under is better than over, because a sheet that outruns the take is cut off mid-line.`,
    'Use structure tags in square brackets — [intro], [verse], [pre-chorus], [chorus], [bridge], [instrumental], [outro] — and put every tag ALONE on its own line, with the words on the lines beneath it. Text sharing a line with a tag is thrown away.',
    'Pace the song to LAND. End on [outro], and make [outro] the FINAL section tag. If an instrumental play-out is useful, put [instrumental] before that terminal [outro], never after it. Never pad by repeating a hook to fill time.',
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

/** Build a native Ollama URL from either `.../v1` or its host-only form. */
function ollamaUrl(endpoint) {
  const target = new URL(LLM_URL);
  const base = target.pathname.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  target.pathname = `${base}/api/${String(endpoint).replace(/^\/+/, '')}`;
  target.search = '';
  return target.toString();
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

  const messages = [{ role: 'user', content: brief }];
  const request = LLM_API === 'ollama'
    ? {
        url: ollamaUrl('chat'),
        body: {
          model: LLM_MODEL,
          messages,
          stream: false,
          think: false,
          format: 'json',
          options: {
            temperature: 0.9,
            num_ctx: LLM_CONTEXT,
            num_predict: LLM_MAX_TOKENS,
          },
        },
      }
    : {
        url: `${LLM_URL}/chat/completions`,
        body: {
          model: LLM_MODEL,
          messages,
          temperature: 0.9,
          max_tokens: LLM_MAX_TOKENS,
          ...(process.env.LYRICS_REASONING ? { reasoning_effort: process.env.LYRICS_REASONING } : {}),
          stream: false,
        },
      };

  let reply;
  try {
    reply = await fetchJson(request.url, {
      method: 'POST',
      headers: LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {},
      body: request.body,
      timeoutMs: 10 * 60 * 1000,
    });
  } catch (err) {
    return send(res, 502, {
      error: `The lyric writer at ${LLM_URL} did not answer (${err.message}). `
        + 'Start it, or point LYRICS_URL somewhere else — Ollama and OpenAI-compatible chat APIs are supported.',
    });
  }

  if (reply.status !== 200) {
    return send(res, 502, {
      error: `The lyric writer answered ${reply.status}. ${String(reply.text || '').slice(0, 300)}`,
    });
  }

  const content = reply.body?.choices?.[0]?.message?.content
    ?? reply.body?.message?.content
    ?? '';
  const parsed = readModelJson(content);
  if (!parsed?.lyrics) {
    return send(res, 502, {
      error: 'The lyric writer replied with something that was not a song. Try again, or use a stronger model.',
      detail: String(content).slice(0, 400) || null,
    });
  }

  // Writers overshoot. Asked for a 90-second song with a budget of about 144
  // words, a good local model returned 217 — and 217 words cannot be sung in
  // 90 seconds at any tempo, so the take gets cut off mid-line no matter how
  // much room it is given afterwards. Fit the sheet to the take here, where
  // the length is known, rather than leaving it for the ceiling to discover.
  let sheet = String(parsed.lyrics || '').trim();
  const asked = Number(body.duration) > 0 ? Number(body.duration) : 120;
  const fitted = enforceLength({ lyrics: sheet, duration: asked, density: 1.6 });
  if (fitted.trimmed.length) {
    console.log(
      `[lyrics] ${clock(asked)} can sing about ${fitted.limit} words and the writer sent ${fitted.raw}. `
      + `Dropped ${fitted.trimmed.join(', ')}.`,
    );
    sheet = fitted.lyrics;
  }
  sheet = normalizeSongEnding(sheet);

  send(res, 200, {
    ok: true,
    song_title: String(parsed.song_title || '').trim(),
    style_tags: String(parsed.style_tags || '').trim(),
    lyrics: sheet,
    words: countSungWords(sheet),
    provider: LLM_API === 'ollama' ? 'ollama' : 'openai-compatible',
    model: LLM_MODEL,
  });
}

/* -------------------------------------------------------------------------- *
 * Music
 * -------------------------------------------------------------------------- */

/* Music 3 treats `audio_duration` as a maximum frame count and emits its own
   semantic end token when the composition has resolved. The selected length is
   creative guidance in the caption, not a cutoff or an acceptance test.

   The worker preflights a semantic timeline before the expensive synthesis
   pass and permits one planning-only fallback when the first plan never emits
   EOS. A complete composition is rendered once and accepted even when its
   natural duration differs from the requested ballpark. CPU lyric transcription
   is retained as diagnostic evidence, never as a hard publication veto. */
const MODEL_MAX_SECONDS = 360;
const HIT_THE_CEILING = 0.75;
const SEED_MODULUS = 2147483647;
const SEED_STEP = 104729;
/* Semantic planning stops before the expensive denoise and decode passes, so
   a handful of preflights costs a fraction of one wrong song. The worker keeps
   the plan that best answers the requested length and synthesises only that
   one. It clamps this to its own ceiling; the two are deliberately equal. */
const MAX_PLAN_ATTEMPTS = 4;

const deliveredSeconds = (result) => Number(result?.extra_info?.music_duration || 0) / 1000;

function hitGenerationCeiling(got, ceiling) {
  return got > 0 && ceiling > 0 && got >= ceiling - HIT_THE_CEILING;
}

function seedFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0) return null;
  return seed % SEED_MODULUS;
}

function freshSeed() {
  return randomInt(0, SEED_MODULUS);
}

function alternateSeed(seed) {
  return (seed + SEED_STEP) % SEED_MODULUS;
}

function initialGenerationCeiling(asked) {
  // Music 3's own public inference example uses all 9,000 available semantic
  // frames. This is only a maximum: a complete song emits EOS sooner. Giving
  // every request the full window prevents a 1:30 preference from becoming a
  // 1:38 guillotine while leaving the structured caption to steer the length.
  void asked;
  return MODEL_MAX_SECONDS;
}

function durationWarning(asked, got, endReason, attempts) {
  if (!(asked > 0) || !(got > 0)) return '';
  if (endReason === 'ceiling') {
    return `The model used every available second and may end abruptly at ${clock(got)}. `
      + `${attempts > 1 ? 'A recovery did not produce a better complete ending.' : 'No additional headroom was available.'}`;
  }
  // A natural ending inside the ballpark is a finished song, not a warning.
  // Outside it, the length control did not describe what arrived, and saying
  // so is the whole reason the band exists: the worker planned several
  // complete compositions and none of them answered the request, so the
  // closest one was published rather than a truncated take.
  if (!inDurationBallpark(got, asked)) {
    const { low, high } = durationBallpark(asked);
    const direction = got < low ? 'shorter' : 'longer';
    return `You asked for ${clock(asked)} and this take ended naturally at ${clock(got)}, `
      + `${direction} than the ${clock(low)}–${clock(high)} range MaxMusic aims for. `
      + `${attempts > 1 ? `${attempts} complete arrangements were planned and this was the closest.` : 'Nothing was trimmed.'} `
      + 'Rendering again, or changing the lyric length, usually lands closer.';
  }
  // The chosen duration remains in metadata so the Library can display what
  // was actually made.
  return '';
}

/**
 * Music 3 needs a non-empty lyrics field even for an instrumental. A lone
 * `[instrumental]` tag satisfies validation, but it gives the model almost no
 * arrangement to develop, which is why a five-minute request previously came
 * back as a little over two minutes. These are native tags only; they are not
 * shown to the user as lyrics.
 */
function instrumentalLyricsForDuration(seconds) {
  return instrumentalStructureLyrics(seconds);
}

/** One canonical song blueprint is used for prompting, rendering and storage. */
function normalizeGenerationBody(body) {
  const suppliedLyrics = normalizeSongEnding(body?.lyrics);
  const selectedInstrumental = body?.is_instrumental === true || body?.instrumental === true;
  const inferredInstrumental = !selectedInstrumental
    && countSungWords(suppliedLyrics) === 0
    && requestsInstrumental(body?.idea, body?.prompt);
  const instrumental = selectedInstrumental || inferredInstrumental;
  if (inferredInstrumental) {
    console.log('[intent] Reconciled an explicit no-vocal brief with its tag-only lyric sheet.');
  }
  return {
    ...(body || {}),
    is_instrumental: instrumental,
    lyrics: instrumental
      ? instrumentalLyricsForDuration(Number(body?.duration) || 120)
      : normalizeSongEnding(body?.lyrics),
  };
}

function fullLengthPrompt(prompt, asked, lyrics, instrumental) {
  // Studio and the corrected Simple composer already send the model's native
  // three-part caption. `ensureMusic3Caption` preserves those byte-for-byte and
  // upgrades only legacy/plain API descriptions.
  return ensureMusic3Caption({ prompt, duration: asked, lyrics, instrumental });
}

function withDurationMetadata(result, {
  requestedSeconds,
  generationSeed,
  generationCeiling,
  generationMinimum,
  attempts,
  recoveryReason = null,
  adapterStarted,
}) {
  const { _generation: generation = {}, ...publicResult } = result || {};
  const got = deliveredSeconds(result);
  const reportedEndReason = String(
    result?.durationEndReason || result?.extra_info?.duration_end_reason || generation.endReason || '',
  ).toLowerCase();
  const endReason = reportedEndReason || (hitGenerationCeiling(got, generationCeiling) ? 'ceiling' : 'eos');
  const warning = durationWarning(requestedSeconds, got, endReason, attempts);
  const elapsed = Math.round(((Date.now() - adapterStarted) / 1000) * 10) / 10;
  return {
    ...publicResult,
    requestedSeconds,
    generationSeed,
    generationCeiling,
    generationMinimum,
    generationAttempts: attempts,
    durationEndReason: endReason,
    durationWarning: warning || null,
    extra_info: {
      ...(result?.extra_info || {}),
      requested_duration_seconds: requestedSeconds,
      delivered_duration_seconds: Math.round(got * 1000) / 1000,
      duration_ballpark_seconds: [
        durationBallpark(requestedSeconds).low,
        durationBallpark(requestedSeconds).high,
      ],
      duration_in_ballpark: inDurationBallpark(got, requestedSeconds),
      generation_ceiling_seconds: generationCeiling,
      minimum_duration_seconds: generationMinimum,
      generation_seed: generationSeed,
      generation_attempts: attempts,
      duration_end_reason: endReason,
      duration_recovery: recoveryReason,
      adapter_elapsed_seconds: elapsed,
      worker_render_seconds: generation.workerRenderSeconds ?? null,
      worker_round_trip_seconds: generation.roundTripSeconds ?? null,
      worker_planning_seconds: Number(result?.planningSeconds) || null,
      worker_synthesis_seconds: Number(result?.synthesisSeconds) || null,
      planned_duration_seconds: Number(result?.plannedSeconds
        ?? result?.extra_info?.planned_duration_seconds) || null,
      planning_attempts: Number(result?.generationAttempts
        ?? result?.extra_info?.planning_attempts) || attempts,
      duration_warning: warning || null,
    },
  };
}

async function makeSongThatEnds(body, { seed: requestedSeed = null } = {}) {
  body = normalizeGenerationBody(body);
  if (!body.is_instrumental && countSungWords(body.lyrics) === 0) {
    throw new Error('A vocal generation reached the backend without any sung words.');
  }
  const adapterStarted = Date.now();
  const asked = Math.max(5, Math.min(MODEL_MAX_SECONDS, Number(body.duration) || 120));
  const firstSeed = seedFrom(requestedSeed) ?? seedFrom(body.seed) ?? freshSeed();
  const minimum = 0;
  const generationCeiling = initialGenerationCeiling(asked);
  const plannedPrompt = fullLengthPrompt(
    body.prompt,
    asked,
    body.lyrics,
    Boolean(body.is_instrumental),
  );
  const plannedBody = {
    ...body,
    prompt: plannedPrompt,
    duration: generationCeiling,
    target_duration: asked,
    max_plan_attempts: MAX_PLAN_ATTEMPTS,
    minimum_duration: minimum,
    seed: firstSeed,
    lyrics: body.is_instrumental ? instrumentalLyricsForDuration(asked) : body.lyrics,
  };

  const result = await makeSong(plannedBody);
  const selectedSeed = seedFrom(result?.generationSeed ?? result?._generation?.seed) ?? firstSeed;
  const selectedCeiling = Number(result?.generationCeiling
    ?? result?.extra_info?.generation_ceiling_seconds) || generationCeiling;
  const attempts = Math.max(1, Number(result?.generationAttempts
    ?? result?.extra_info?.planning_attempts) || 1);
  const endReason = String(
    result?.durationEndReason || result?.extra_info?.duration_end_reason || result?._generation?.endReason || '',
  ).toLowerCase() || (hitGenerationCeiling(deliveredSeconds(result), selectedCeiling) ? 'ceiling' : 'eos');
  if (endReason !== 'eos') {
    throw new Error(
      `The worker returned a ${endReason || 'non-natural'} semantic ending; MaxMusic will not publish it.`,
    );
  }
  const acousticEndingPass = result?.terminalOutroGuard === true
    && result?.acousticEndingPass === true
    && result?.endingGuard?.after?.signalVerdict === 'pass';
  if (!acousticEndingPass) {
    throw new Error(
      'The worker did not certify a safe acoustic ending; MaxMusic will not publish this track.',
    );
  }
  if (!body.is_instrumental && result?.lyricCompletionPass !== true) {
    const completion = result?.lyricCompletion || {};
    console.warn(
      `[lyrics] advisory only verdict=${completion.verdict || 'unknown'} `
      + `reason=${completion.reason || 'unknown'}; `
      + 'accepting natural EOS with a certified acoustic ending.',
    );
  }

  const recoveryReason = attempts > 1 ? 'semantic-preflight-alternate-seed' : null;
  const final = withDurationMetadata(result, {
    requestedSeconds: asked,
    generationSeed: selectedSeed,
    generationCeiling: selectedCeiling,
    generationMinimum: minimum,
    attempts,
    recoveryReason,
    adapterStarted,
  });
  console.log(
    `[length] complete requested=${asked}s delivered=${deliveredSeconds(final).toFixed(1)}s `
    + `planned=${Number(final.extra_info.planned_duration_seconds || 0).toFixed(1)}s `
    + `end=${final.durationEndReason} planAttempts=${attempts} seed=${selectedSeed} `
    + `elapsed=${final.extra_info.adapter_elapsed_seconds}s.`,
  );
  return final;
}

async function makeSong(body) {
  const instrumental = Boolean(body.is_instrumental);
  const duration = Number(body.duration) || 120;
  const targetDuration = Number(body.target_duration) || duration;
  const generationSeed = seedFrom(body.seed);
  const roundTripStarted = Date.now();
  const reply = await fetchJson(`${WORKER_URL}/generate`, {
    method: 'POST',
    body: {
      prompt: String(body.prompt || ''),
      // Music3 validates that lyrics is non-empty even when the request is
      // instrumental. Its native section tag carries that meaning without
      // turning the public API into a fake lyric-writing requirement.
      lyrics: instrumental
        ? (String(body.lyrics || '').trim() || instrumentalLyricsForDuration(targetDuration))
        : normalizeSongEnding(body.lyrics),
      // The current worker preserves supplied instrumental section tags. Send
      // the mode explicitly so lyric verification and stored metadata cannot
      // silently classify an instrumental as a vocal song.
      is_instrumental: instrumental,
      duration,
      target_duration: targetDuration,
      max_plan_attempts: Math.max(1, Math.min(MAX_PLAN_ATTEMPTS, Number(body.max_plan_attempts) || MAX_PLAN_ATTEMPTS)),
      minimum_duration: Math.max(0, Number(body.minimum_duration) || 0),
      seed: generationSeed,
    },
    timeoutMs: 60 * 60 * 1000,
  });
  if (reply.status !== 200) {
    if (reply.status === 409) throw new WorkerBusyError();
    const detail = reply.body?.detail || reply.text || '';
    throw new Error(String(detail).slice(0, 400) || `the worker answered ${reply.status}`);
  }
  const roundTripSeconds = Math.round(((Date.now() - roundTripStarted) / 1000) * 10) / 10;
  const got = deliveredSeconds(reply.body);
  const selectedSeed = seedFrom(reply.body?.generationSeed
    ?? reply.body?.extra_info?.generation_seed) ?? generationSeed;
  const selectedCeiling = Number(reply.body?.generationCeiling
    ?? reply.body?.extra_info?.generation_ceiling_seconds) || duration;
  const planningAttempts = Math.max(1, Number(reply.body?.generationAttempts
    ?? reply.body?.extra_info?.planning_attempts) || 1);
  const endReason = String(
    reply.body?.durationEndReason || reply.body?.extra_info?.duration_end_reason || '',
  ).toLowerCase() || (hitGenerationCeiling(got, selectedCeiling) ? 'ceiling' : 'eos');
  console.log(
    `[render] seed=${selectedSeed} planAttempts=${planningAttempts} `
    + `target=${targetDuration}s ceiling=${selectedCeiling}s delivered=${got.toFixed(1)}s end=${endReason} `
    + `worker=${Number(reply.body?.renderSeconds || 0).toFixed(1)}s roundTrip=${roundTripSeconds}s.`,
  );
  return {
    ...reply.body,
    _generation: {
      seed: selectedSeed,
      minimum: Math.max(0, Number(body.minimum_duration) || 0),
      ceiling: selectedCeiling,
      attempts: planningAttempts,
      endReason,
      workerRenderSeconds: Number(reply.body?.renderSeconds) || null,
      roundTripSeconds,
    },
  };
}

function titleFromPrompt(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.slice(0, 4).join(' ') || 'Untitled song';
}

function generatedRecord(body, result) {
  const track = result?.track || {};
  const filename = String(track.filename || String(track.url || '').split('/').pop() || '');
  const instrumental = Boolean(body.is_instrumental);
  const requestedDuration = Number(result?.requestedSeconds || body.duration) || 120;
  const actualDuration = deliveredSeconds(result);
  const format = String(body.audio_setting?.format || filename.split('.').pop() || '').toLowerCase();
  return {
    id: String(track.id || filename.replace(/\.[^.]+$/, '')),
    url: String(track.url || ''),
    filename,
    size: Number(track.size) || 0,
    title: String(body.title || '').trim() || titleFromPrompt(body.idea || body.prompt),
    artist: String(body.artist || '').trim(),
    prompt: String(body.prompt || ''),
    idea: String(body.idea || ''),
    lyrics: instrumental ? '' : String(body.lyrics || ''),
    isInstrumental: instrumental,
    duration: actualDuration || requestedDuration,
    requestedDuration,
    durationWarning: result?.durationWarning || null,
    durationEndReason: String(result?.durationEndReason || result?.extra_info?.duration_end_reason || '') || null,
    generationCeiling: Number(result?.generationCeiling || result?.extra_info?.generation_ceiling_seconds) || null,
    generationMinimum: Number(result?.generationMinimum || result?.extra_info?.minimum_duration_seconds) || null,
    generationAttempts: Number(result?.generationAttempts || result?.extra_info?.generation_attempts) || 1,
    format,
    seed: Number.isFinite(Number(result?.generationSeed ?? body.seed))
      && (result?.generationSeed ?? body.seed) !== null
      && (result?.generationSeed ?? body.seed) !== ''
      ? Number(result?.generationSeed ?? body.seed)
      : null,
    sampleRate: Number(result?.extra_info?.music_sample_rate) || null,
    bitrate: Number(body.audio_setting?.bitrate) || null,
    model: 'MiniMaxAI/MiniMax-Music3',
    cover: null,
    videos: [],
    createdAt: Date.now(),
    source: 'native-server',
    parentId: null,
  };
}

function persistGeneratedResult(result, body, db) {
  if (!db || !result?.track?.url) return;
  try {
    db.upsert(generatedRecord(body, result));
  } catch (error) {
    // The audio is still returned; a database problem must not turn a finished
    // GPU render into a lost result. The service log makes the backup issue
    // visible for repair.
    console.error('[library] could not persist the completed generation:', error.message);
  }
}

async function generate(req, res, db) {
  const body = normalizeGenerationBody(await readBody(req));
  try {
    const result = await makeSongThatEnds(body);
    persistGeneratedResult(result, body, db);
    send(res, 200, result);
  } catch (err) {
    if (err?.code === 'worker_busy') {
      send(res, 409, { error: err.message, code: err.code });
      return;
    }
    send(res, 502, { error: publicGenerationError(err) });
  }
}

function publicGenerationError(err) {
  const technical = String(err?.stack || err?.message || err || 'unknown generation failure');
  console.error('[render] generation rejected:', technical);
  if (/five-minute hard limit/i.test(technical)) {
    return 'Music 3 did not reach the end of that composition before its five-minute limit, so MaxMusic did not save an incomplete song.';
  }
  return 'That take did not finish cleanly, so MaxMusic did not save incomplete audio.';
}

async function generateDual(req, res, db) {
  const body = normalizeGenerationBody(await readBody(req));
  const takes = { A: null, B: null };
  const errors = [];
  const firstSeed = seedFrom(body.seed) ?? freshSeed();
  const seeds = { A: firstSeed, B: alternateSeed(firstSeed) };
  // Sequential on purpose: one GPU, one song at a time.
  for (const slot of ['A', 'B']) {
    try {
      // Both are explicit so a model reload cannot reset an implicit random
      // generator and produce byte-identical "different" takes.
      takes[slot] = await makeSongThatEnds(body, { seed: seeds[slot] });
      persistGeneratedResult(takes[slot], body, db);
    } catch (err) {
      errors.push({
        slot,
        error: err?.code === 'worker_busy' ? err.message : publicGenerationError(err),
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  }
  const allBusy = !takes.A && !takes.B && errors.length === 2
    && errors.every((err) => err.code === 'worker_busy');
  send(res, allBusy ? 409 : 200, {
    ok: Boolean(takes.A || takes.B), takes, errors,
    ...(allBusy ? { error: errors[0].error, code: 'worker_busy' } : {}),
  });
}

/** The same song, delivered as the event stream the Studio screen listens to. */
async function generateStream(req, res, db) {
  const body = normalizeGenerationBody(await readBody(req));
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const event = (payload) => {
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  event({ status: 'queued', backend: 'diffusers-worker' });
  const beat = setInterval(() => event({ status: 'working' }), 15_000);
  try {
    const result = await makeSongThatEnds(body);
    persistGeneratedResult(result, body, db);
    event({ done: true, ...result });
  } catch (err) {
    event({
      error: err?.code === 'worker_busy' ? err.message : publicGenerationError(err),
      ...(err?.code ? { code: err.code, status: err.status || 500 } : {}),
    });
  } finally {
    clearInterval(beat);
    if (!res.destroyed && !res.writableEnded) res.end();
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
  let coverArtProvider = 'disabled';
  let openaiBroker = 'disabled';
  const account = await accountHealth();
  if (OPENAI_BACKEND_URL) {
    // Configuration is not availability. Keep signed-out-but-reachable OAuth
    // visible so the UI can offer sign-in, but never advertise lyrics or cover
    // art when the relay itself cannot answer.
    lyricsProvider = account ? 'openai-oauth' : 'disabled';
    coverArtProvider = account ? 'openai-oauth' : 'disabled';
    openaiBroker = account
      ? (account.authenticated ? 'authenticated' : 'configured')
      : 'unreachable';
  } else {
    try {
      const models = await fetchJson(LLM_API === 'ollama' ? ollamaUrl('tags') : `${LLM_URL}/models`, {
        headers: LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {},
        timeoutMs: 2500,
      });
      if (models.status === 200) {
        lyricsProvider = LLM_API === 'ollama'
          ? 'ollama'
          : (LLM_URL.startsWith(OPENAI_API) ? 'openai-key' : 'openai-compatible');
      }
    } catch { /* stays disabled */ }
    coverArtProvider = IMAGE_URL
      ? (IMAGE_URL.startsWith(OPENAI_API) ? 'openai-key' : 'openai-compatible')
      : 'disabled';
  }

  send(res, 200, {
    ok: reachable,
    backend: worker?.runtime === 'comfy' ? 'comfy-worker' : 'diffusers-worker',
    // The app calls the model runtime "comfy" throughout for historical
    // reasons; these fields are that slot, whoever is filling it.
    comfyUrl: WORKER_URL,
    comfyReachable: reachable,
    comfyError: reachable ? null : `No answer from the model worker at ${WORKER_URL}. Start it with ./start.sh, or set WORKER_URL.`,
    musicModels: { 'minimax-music-3': worker?.model || 'MiniMax Music 3' },
    lyrics: lyricsProvider,
    coverArt: coverArtProvider,
    openaiBroker,
    openaiConfigured: Boolean(OPENAI_BACKEND_URL),
    hasServerKey: Boolean(LLM_KEY || IMAGE_KEY),
    // Where the credential came from, never what it is. A ChatGPT sign-in is
    // reported as found-but-unusable rather than quietly ignored, so nobody
    // concludes the app cannot see an account they know they have.
    openaiAccount: {
      mode: LOCAL_OPENAI.mode,
      source: LOCAL_OPENAI.source,
      usable: Boolean(LOCAL_OPENAI.key),
    },
    video: await videoHealth(),
    worker,
  });
}

/**
 * What this machine will use to make a video, before anybody waits for one.
 *
 * The two stages that decide whether a lyric video takes seconds or minutes
 * are listening for the words and encoding the picture, and both silently
 * accept a slower answer when the fast one is unavailable. Report the real
 * choice so a CPU fallback is visible rather than merely felt.
 */
async function videoHealth() {
  try {
    const { videoCapabilities } = await import('./render/jobs.mjs');
    const caps = await videoCapabilities();
    const words = caps.words || {};
    return {
      renderer: caps.renderer,
      encoder: caps.encoder,
      accelerated: caps.encoder !== 'libx264',
      subtitles: caps.subtitles,
      words: words.installed
        ? `${words.model || 'whisper'} on ${words.device}${words.computeType ? ` (${words.computeType})` : ''}`
        : 'not installed',
      wordsAccelerated: words.installed === true && words.device === 'cuda',
    };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 200) };
  }
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
 * Durable library
 * -------------------------------------------------------------------------- */

async function library(req, res, db) {
  if (req.method === 'GET') {
    send(res, 200, { ok: true, records: db.list() });
    return;
  }

  if (req.method !== 'PUT') {
    res.writeHead(405, { allow: 'GET, PUT' });
    res.end();
    return;
  }

  const body = await readBody(req);
  try {
    if (Array.isArray(body.records) && body.records.length === 0 && !body.allowEmpty && db.list().length) {
      send(res, 409, {
        error: 'The empty library snapshot was not applied. Confirm Delete all songs before clearing the database.',
      });
      return;
    }
    const count = db.replace(body.records);
    send(res, 200, { ok: true, count });
  } catch (error) {
    send(res, 400, { error: error.message || 'The library could not be saved.' });
  }
}

/* -------------------------------------------------------------------------- *
 * The router
 * -------------------------------------------------------------------------- */

/**
 * Answer a request locally, or say no so the caller can proxy it onward.
 * @returns {boolean} true when this module has taken the request.
 */
export function handleLocal(req, res, { libraryDb = null } = {}) {
  const path = String(req.url || '').split('?')[0];
  const post = req.method === 'POST';

  // Library persistence is independent of the model worker. Keeping this
  // route available before the standalone check also lets a launcher diagnose
  // or migrate the library while the worker is still downloading its model.
  if (libraryDb && path === '/api/library') { library(req, res, libraryDb); return true; }
  if (!standalone) return false;

  if (path === '/api/health') { health(req, res); return true; }
  if (path === '/api/generate' && post) { generate(req, res, libraryDb); return true; }
  if (path === '/api/generate-dual' && post) { generateDual(req, res, libraryDb); return true; }
  if (path === '/api/generate-stream' && post) { generateStream(req, res, libraryDb); return true; }
  if (OPENAI_BACKEND_URL && (
    path === '/api/openai/status'
    || path.startsWith('/api/openai/')
    || (path === '/api/lyrics' && post)
    || (path === '/api/cover-art' && post)
  )) {
    forwardAccountRequest(req, res);
    return true;
  }
  if (path === '/api/lyrics' && post) { writeLyrics(req, res); return true; }
  if (path === '/api/cover-art' && post) { coverArt(req, res); return true; }
  if (path.startsWith('/tracks/')) { streamTrack(req, res); return true; }
  if (OPENAI_BACKEND_URL && path.startsWith('/covers/')) {
    streamAccountMedia(req, res);
    return true;
  }

  // There is no hosted account in the local-only shape of the app, and the
  // screens read this to decide what to offer. Answer plainly when the account
  // backend was not configured.
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
