/**
 * MaxMusic — API client.
 *
 * Every call in SPEC §4 lives here. Nothing else in the app may call `fetch`
 * against `/api/*`. Backend error messages are user-facing and useful, so they
 * are surfaced verbatim on `ApiError.message` — never replaced with a generic
 * string, never swallowed.
 *
 * All URLs are same-origin and relative. Nothing here touches an external host.
 *
 * @module api
 */

/* ========================================================================== *
 * Errors
 * ========================================================================== */

/**
 * Thrown when the backend responds with a non-2xx status, or when the request
 * never reached it.
 *
 * @property {number}  status    HTTP status. 0 when the request never landed.
 * @property {string}  message   The backend's own message, verbatim.
 * @property {?string} details   Secondary text the backend supplied (`details` /
 *                               `detail` / `status_msg`), verbatim.
 * @property {?number|string} code  Upstream error code, when present.
 * @property {?string} traceId   Upstream trace id, when present.
 * @property {string}  endpoint  Path that failed, e.g. `/api/generate`.
 * @property {*}       body      Parsed response body (or raw text).
 */
export class ApiError extends Error {
  constructor(message, { status = 0, details = null, code = null, traceId = null, endpoint = '', body = null } = {}) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
    this.traceId = traceId;
    this.endpoint = endpoint;
    this.body = body;
  }

  /** Everything the backend told us, on one or two lines. */
  get fullMessage() {
    return this.details && this.details !== this.message
      ? `${this.message}\n${this.details}`
      : this.message;
  }
}

/** Thrown before any network call when the request payload breaks SPEC §3a. */
export class ValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [String(issues)];
    super(list.join(' '));
    this.name = 'ValidationError';
    this.issues = list;
  }
}

/* ========================================================================== *
 * Limits and enumerations — SPEC §3a / §3d
 * ========================================================================== */

/** @type {Readonly<Record<string, number>>} */
export const LIMITS = Object.freeze({
  PROMPT_MAX: 2000,
  LYRICS_MAX: 3500,
  DURATION_MIN: 0.04,
  DURATION_MAX: 360,
  DURATION_DEFAULT: 120,
  SEED_MIN: 0,
  SEED_MAX: 2 ** 31 - 1,
  SAMPLE_RATE_DEFAULT: 44100,
  BITRATE_DEFAULT: 256000,
});

/** Audio container formats the backend accepts. */
export const FORMATS = Object.freeze(['flac', 'mp3', 'wav']);

/** Bitrates that mean anything (mp3 only). */
export const BITRATES = Object.freeze([32000, 64000, 128000, 256000]);

/** Sample rates the backend accepts. Model is natively 32 kHz. */
export const SAMPLE_RATES = Object.freeze([16000, 24000, 32000, 44100]);

/** The only nine section tags MiniMax Music 3 understands — SPEC §3d. */
export const SECTION_TAGS = Object.freeze([
  '[intro]', '[verse]', '[pre-chorus]', '[chorus]', '[post-chorus]',
  '[bridge]', '[instrumental]', '[solo]', '[outro]',
]);

/** Aspect ratios accepted by `/api/cover-art`. */
export const ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '2:3', '3:2']);

/** Modes accepted by `/api/lyrics`. */
export const LYRICS_MODES = Object.freeze(['write_full_song', 'edit']);

/* ========================================================================== *
 * Transport
 * ========================================================================== */

const JSON_HEADERS = { 'content-type': 'application/json' };

function pickMessage(body, res, endpoint) {
  if (body && typeof body === 'object') {
    // { error: "…" }  |  { error: { message } }  |  { message: "…" }
    const e = body.error ?? body.message;
    if (typeof e === 'string' && e.trim()) return e.trim();
    if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  }
  if (typeof body === 'string' && body.trim() && !body.trim().startsWith('<')) {
    return body.trim().slice(0, 600);
  }
  // No endpoint path in the sentence a customer reads. The path stays on
  // ApiError.endpoint for the console and the Settings screen.
  void endpoint;
  return `That request didn’t complete (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}).`;
}

function pickDetails(body) {
  if (!body || typeof body !== 'object') return null;
  const d = body.details ?? body.detail ?? body.status_msg ?? body.raw;
  if (typeof d === 'string' && d.trim()) return d.trim();
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors
      .map((e) => (typeof e === 'string' ? e : [e.slot, e.error, e.details].filter(Boolean).join(': ')))
      .join('\n');
  }
  return null;
}

async function readBody(res) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { return await res.json(); } catch { return null; }
  }
  try { return await res.text(); } catch { return null; }
}

/**
 * Low-level JSON request. Exported so a screen can reach an endpoint this
 * module has not wrapped yet — prefer the named helpers below.
 *
 * @param {string} endpoint  Path beginning with `/api`.
 * @param {{ method?: string, body?: *, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string,string> }} [opts]
 * @returns {Promise<*>} Parsed JSON body.
 * @throws {ApiError}
 */
export async function request(endpoint, opts = {}) {
  const { method = 'GET', body, signal, timeoutMs = 0, headers = {} } = opts;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method,
      headers: body === undefined ? headers : { ...JSON_HEADERS, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
    throw new ApiError(
      'Could not reach MaxMusic. Check that your studio is running, then try again.',
      { status: 0, details: err?.message ? String(err.message) : null, endpoint, body: null },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const parsed = await readBody(res);
  if (!res.ok) {
    throw new ApiError(pickMessage(parsed, res, endpoint), {
      status: res.status,
      details: pickDetails(parsed),
      code: parsed?.code ?? null,
      traceId: parsed?.trace_id ?? null,
      endpoint,
      body: parsed,
    });
  }
  return parsed;
}

/* ========================================================================== *
 * GET /api/health
 * ========================================================================== */

/**
 * @typedef {Object} Health
 * @property {*}        raw               Untouched response body.
 * @property {'online'|'degraded'|'offline'} status
 * @property {string}   message           Customer copy. Safe to render anywhere.
 * @property {?string}  detail            Verbatim technical reason. Settings only —
 *                                        never in resting product chrome (SPEC §7a).
 * @property {boolean}  ok
 * @property {string}   backend           e.g. `local-comfy` | `remote-minimax`.
 * @property {?string}  comfyUrl
 * @property {boolean}  comfyReachable
 * @property {?string}  comfyError        Verbatim reason ComfyUI is unreachable.
 * @property {Record<string,string>} musicModels  key -> human label.
 * @property {string[]} modelKeys
 * @property {string}   lyricsProvider    e.g. `local-codex-cli` | `disabled`.
 * @property {boolean}  lyricsEnabled
 * @property {string}   coverArtProvider  e.g. `local-media-broker` | `disabled`.
 * @property {boolean}  coverArtEnabled
 * @property {boolean}  hasServerKey
 * @property {?ApiError} error            Set when `status === 'offline'`.
 * @property {number}   checkedAt         Date.now() of this snapshot.
 */

/**
 * Ask the backend how it is doing. Never throws — an unreachable backend is a
 * legitimate answer and the shell renders it.
 *
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<Health>}
 */
export async function health(opts = {}) {
  const { signal, timeoutMs = 8000 } = opts;
  try {
    const raw = await request('/api/health', { signal, timeoutMs });
    const models = raw?.musicModels && typeof raw.musicModels === 'object' ? raw.musicModels : {};
    const comfyReachable = raw?.comfyReachable !== false;
    const lyricsProvider = raw?.lyrics || 'disabled';
    const coverArtProvider = raw?.coverArt || 'disabled';
    const degraded = raw?.ok === false || !comfyReachable;

    return {
      raw,
      status: degraded ? 'degraded' : 'online',
      // `message` is customer copy and is safe to render anywhere.
      // `detail` is the verbatim technical line and belongs in Settings only.
      message: degraded
        ? 'Your studio answered but isn’t ready to render yet.'
        : 'Connected',
      detail: degraded ? (raw?.comfyError || null) : null,
      ok: Boolean(raw?.ok),
      backend: raw?.backend || 'unknown',
      comfyUrl: raw?.comfyUrl || null,
      comfyReachable,
      comfyError: raw?.comfyError || null,
      musicModels: models,
      modelKeys: Object.keys(models),
      lyricsProvider,
      lyricsEnabled: lyricsProvider !== 'disabled',
      coverArtProvider,
      coverArtEnabled: coverArtProvider !== 'disabled',
      hasServerKey: Boolean(raw?.hasServerKey),
      error: null,
      checkedAt: Date.now(),
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const apiErr = err instanceof ApiError ? err : new ApiError(err?.message || String(err), { endpoint: '/api/health' });
    return {
      raw: apiErr.body,
      status: 'offline',
      message: 'MaxMusic can’t reach your studio right now.',
      detail: apiErr.fullMessage,
      ok: false,
      backend: 'unreachable',
      comfyUrl: null,
      comfyReachable: false,
      comfyError: null,
      musicModels: {},
      modelKeys: [],
      lyricsProvider: 'unknown',
      lyricsEnabled: false,
      coverArtProvider: 'unknown',
      coverArtEnabled: false,
      hasServerKey: false,
      error: apiErr,
      checkedAt: Date.now(),
    };
  }
}

/* ========================================================================== *
 * OpenAI account — GET /api/openai/status, POST /api/openai/auth/start,
 *                  GET /api/openai/auth/poll/:id
 *
 * The browser never speaks to the broker itself and never handles a broker
 * token: the backend holds the credential and these three routes are the whole
 * surface. Nothing here may be logged or rendered beyond what these responses
 * carry, and none of it is a secret.
 *
 * This — not `/api/health` — is the authority on whether the account is signed
 * in. `/api/health` reports how the backend is *configured to route* lyrics and
 * cover art; it does not know whether the account is authenticated, and signing
 * in is not expected to change its `lyrics` / `coverArt` fields.
 * ========================================================================== */

/**
 * @typedef {Object} OpenAIAuth
 * @property {*}       raw               Untouched response body.
 * @property {boolean} brokerConfigured  The backend has a broker to talk to.
 * @property {boolean} authenticated     An OpenAI account is signed in.
 * @property {boolean} codexAvailable    Lyrics can be written.
 * @property {boolean} imageGeneration   Album art can be rendered.
 * @property {?string} provider          e.g. `codex-chatgpt`.
 * @property {?string} planType          e.g. `pro`.
 * @property {boolean} ready             brokerConfigured && authenticated && codexAvailable.
 * @property {boolean} reachable         False when the status route itself failed.
 * @property {?ApiError} error
 * @property {number}  checkedAt
 */

/** @param {*} raw @returns {OpenAIAuth} */
function readAuth(raw) {
  const brokerConfigured = Boolean(raw?.brokerConfigured);
  const authenticated = Boolean(raw?.authenticated);
  const codexAvailable = Boolean(raw?.codexAvailable);
  return {
    raw,
    brokerConfigured,
    authenticated,
    codexAvailable,
    imageGeneration: Boolean(raw?.imageGeneration),
    provider: raw?.provider || null,
    planType: raw?.planType || null,
    ready: brokerConfigured && authenticated && codexAvailable,
    reachable: true,
    error: null,
    checkedAt: Date.now(),
  };
}

/**
 * Read account state. Never throws — an unreachable backend is a legitimate
 * answer, the same contract `health()` keeps.
 *
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<OpenAIAuth>}
 */
export async function openaiStatus(opts = {}) {
  const { signal, timeoutMs = 8000 } = opts;
  try {
    return readAuth(await request('/api/openai/status', { signal, timeoutMs }));
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const apiErr = err instanceof ApiError
      ? err
      : new ApiError(err?.message || String(err), { endpoint: '/api/openai/status' });
    return {
      raw: apiErr.body,
      brokerConfigured: false,
      authenticated: false,
      codexAvailable: false,
      imageGeneration: false,
      provider: null,
      planType: null,
      ready: false,
      reachable: false,
      error: apiErr,
      checkedAt: Date.now(),
    };
  }
}

/**
 * Begin sign-in. Resolves either `{ status: 'already_authenticated', auth }` or
 * `{ status: 'pending', id, url, verificationCode, expiresAt }`.
 *
 * Throws on a failed request, because a click that goes nowhere is a real
 * failure the customer is waiting on — unlike a background status poll.
 *
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function openaiAuthStart(opts = {}) {
  const raw = await request('/api/openai/auth/start', {
    method: 'POST',
    signal: opts.signal,
    timeoutMs: 20000,
  });
  if (raw?.status === 'already_authenticated') {
    return { status: 'already_authenticated', auth: readAuth(raw.auth || raw) };
  }
  return {
    status: 'pending',
    id: raw?.id ? String(raw.id) : '',
    url: raw?.url ? String(raw.url) : '',
    // Optional manual fallback. Shown to the customer; it is not a secret, and
    // it is the ONLY code this app ever displays.
    verificationCode: raw?.verification_code ? String(raw.verification_code) : '',
    // Seconds since epoch in the contract; normalised to ms here.
    expiresAt: Number(raw?.expires_at) > 0 ? Number(raw.expires_at) * 1000 : 0,
  };
}

/**
 * Poll one sign-in attempt. Resolves `{ status: 'pending'|'completed'|'failed' }`
 * with `auth` on completion and `message` on failure.
 *
 * @param {string} attemptId
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function openaiAuthPoll(attemptId, opts = {}) {
  const raw = await request(`/api/openai/auth/poll/${encodeURIComponent(attemptId)}`, {
    signal: opts.signal,
    timeoutMs: 15000,
  });
  if (raw?.status === 'completed') {
    return { status: 'completed', auth: readAuth(raw.auth || {}) };
  }
  if (raw?.status === 'failed') {
    return { status: 'failed', message: raw?.error || 'The sign-in didn’t finish.' };
  }
  return {
    status: 'pending',
    expiresAt: Number(raw?.expires_at) > 0 ? Number(raw.expires_at) * 1000 : 0,
  };
}

/**
 * Sign the account out.
 *
 * Not part of the original broker handoff, which documents only status, start
 * and poll. The route is expected at the obvious place beside the other two.
 * `supported: false` comes back when the backend does not offer it yet, so the
 * UI can say so plainly instead of showing a raw 404.
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok: boolean, supported: boolean, message?: string}>}
 */
export async function openaiAuthLogout(opts = {}) {
  try {
    await request('/api/openai/auth/logout', {
      method: 'POST',
      signal: opts.signal,
      timeoutMs: 15000,
    });
    return { ok: true, supported: true };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 404 || status === 405 || status === 501) {
      return {
        ok: false,
        supported: false,
        message: 'Your studio has no sign-out route yet, so the account stays connected.',
      };
    }
    throw err;
  }
}

/* ========================================================================== *
 * Video jobs — POST /api/video-jobs, then poll, then fetch the file
 *
 * A render outlives a request, so this is asynchronous by design: the POST
 * answers 202 with somewhere to watch, and the file is collected afterwards.
 * The browser sends only names the backend already knows — a `/tracks/…` and a
 * `/covers/…` path it served itself — never a filesystem path or an argument.
 * ========================================================================== */

/**
 * @typedef {Object} VideoJob
 * @property {string} id
 * @property {'queued'|'working'|'completed'|'failed'|'cancelled'} status
 * @property {string} [step]   What the studio is doing right now, in words.
 * @property {number} progress 0..1
 * @property {string} statusUrl
 * @property {string} [downloadUrl]
 * @property {string} [filename]
 * @property {string} [error]
 */

/**
 * Queue a video render in the studio — this app's own server, which has the
 * renderer, ffmpeg and the transcriber on hand.
 *
 * @param {{trackUrl: string, mode: 'scroll'|'film', title?: string,
 *          artist?: string, lyrics?: string, cover?: ?string}} input
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<VideoJob>}
 */
export function videoJobCreate(input, opts = {}) {
  return request('/studio/video', {
    method: 'POST',
    body: {
      trackUrl: input.trackUrl,
      mode: input.mode,
      title: input.title || 'Untitled',
      artist: input.artist || '',
      lyrics: input.lyrics || '',
      cover: input.cover || null,
    },
    signal: opts.signal,
    timeoutMs: 20000,
  });
}

/**
 * @param {string} id
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<VideoJob>}
 */
export function videoJobStatus(id, opts = {}) {
  return request(`/studio/video/${encodeURIComponent(id)}`, {
    signal: opts.signal,
    timeoutMs: 15000,
  });
}

/** Stop a render and let the server drop its files. */
export async function videoJobCancel(id) {
  try {
    await request(`/studio/video/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10000 });
    return true;
  } catch {
    // A render that has already gone is the outcome we wanted anyway.
    return false;
  }
}

/**
 * The download link for a song's audio, as the original FLAC or a 320k MP3
 * transcoded on the way out. A plain link — the browser downloads, the
 * server streams.
 */
export function audioDownloadUrl(trackUrl, format, title) {
  const q = new URLSearchParams({ track: trackUrl, format, name: title || 'song' });
  return `/studio/audio?${q}`;
}

/* ========================================================================== *
 * Generation payload — SPEC §3a
 * ========================================================================== */

/**
 * @typedef {Object} GenerationInput
 * @property {string}  [prompt]           Structured caption, ≤2000 chars.
 * @property {string}  [lyrics]           Required unless `is_instrumental`, ≤3500.
 * @property {boolean} [is_instrumental]
 * @property {number}  [duration]         0.04–360 s. Default 120.
 * @property {number}  [seed]             0–2^31-1. Random when omitted.
 * @property {boolean} [tiled_decode]
 * @property {boolean} [more_variation]   `/api/generate-dual` only.
 * @property {string}  [model]            One of `health().modelKeys`.
 * @property {{format?: 'flac'|'mp3'|'wav', bitrate?: number, sample_rate?: number}} [audio_setting]
 */

/**
 * @typedef {Object} Validation
 * @property {boolean}  valid
 * @property {string[]} errors    Blocking. Disable the submit button and show these.
 * @property {string[]} warnings  Non-blocking. Values that were clamped/ignored.
 * @property {Object}   payload   Normalised body, ready to POST.
 */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Normalise and check a generation request without sending it. Use this to
 * drive an honestly-disabled Create button.
 *
 * @param {GenerationInput} input
 * @returns {Validation}
 */
export function validateGeneration(input = {}) {
  const errors = [];
  const warnings = [];

  const instrumental = Boolean(input.is_instrumental);
  const prompt = String(input.prompt ?? '').trim();
  const lyrics = String(input.lyrics ?? '');

  if (prompt.length > LIMITS.PROMPT_MAX) {
    warnings.push(`Your description is ${prompt.length} characters; only the first ${LIMITS.PROMPT_MAX} are used.`);
  }
  if (instrumental) {
    if (!prompt) errors.push('Instrumental tracks still need a style description.');
    if (lyrics.trim()) warnings.push('Lyrics are ignored while Instrumental is on.');
  } else if (!lyrics.trim()) {
    errors.push('A vocal track needs lyrics. Write them on the Lyrics page, or switch to Instrumental.');
  } else if (lyrics.length > LIMITS.LYRICS_MAX) {
    warnings.push(`Your lyrics are ${lyrics.length} characters; only the first ${LIMITS.LYRICS_MAX} are used.`);
  }

  /** @type {Record<string, *>} */
  const payload = { is_instrumental: instrumental };
  if (prompt) payload.prompt = prompt.slice(0, LIMITS.PROMPT_MAX);
  if (!instrumental && lyrics.trim()) payload.lyrics = lyrics.slice(0, LIMITS.LYRICS_MAX);

  if (input.duration !== undefined && input.duration !== null && input.duration !== '') {
    const d = Number(input.duration);
    if (!Number.isFinite(d)) {
      errors.push('Duration must be a number of seconds.');
    } else {
      const c = clamp(d, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
      if (c !== d) warnings.push(`Duration clamped to ${c}s (allowed ${LIMITS.DURATION_MIN}–${LIMITS.DURATION_MAX}s).`);
      payload.duration = c;
    }
  }

  if (input.seed !== undefined && input.seed !== null && input.seed !== '') {
    const s = Number(input.seed);
    if (!Number.isFinite(s) || !Number.isInteger(s)) {
      errors.push('Seed must be a whole number.');
    } else {
      const c = clamp(s, LIMITS.SEED_MIN, LIMITS.SEED_MAX);
      if (c !== s) warnings.push(`Seed clamped to ${c}.`);
      payload.seed = c;
    }
  }

  if (input.tiled_decode) payload.tiled_decode = true;
  if (input.more_variation) payload.more_variation = true;
  if (input.model) payload.model = String(input.model);

  const audio = input.audio_setting || {};
  /** @type {Record<string, *>} */
  const setting = {};
  if (audio.format) {
    if (!FORMATS.includes(audio.format)) errors.push(`Unknown audio format "${audio.format}". Use ${FORMATS.join(', ')}.`);
    else setting.format = audio.format;
  }
  if (audio.sample_rate) setting.sample_rate = Number(audio.sample_rate) || LIMITS.SAMPLE_RATE_DEFAULT;
  if (audio.bitrate) {
    if (setting.format && setting.format !== 'mp3') warnings.push('Bitrate applies to MP3 only.');
    else setting.bitrate = Number(audio.bitrate) || LIMITS.BITRATE_DEFAULT;
  }
  if (Object.keys(setting).length) payload.audio_setting = setting;

  return { valid: errors.length === 0, errors, warnings, payload };
}

/**
 * @typedef {Object} Track
 * @property {string} id
 * @property {string} filename
 * @property {string} url   Same-origin path, e.g. `/tracks/ab12.flac`.
 * @property {number} size  Bytes.
 */

/**
 * @typedef {Object} GenerationResult
 * @property {boolean} ok
 * @property {Track}   track
 * @property {{music_duration?: number, music_sample_rate?: number, music_channel?: number,
 *            bitrate?: number, backend?: string, comfy_prompt_id?: string}} extra_info
 * @property {?string} status
 * @property {?string} trace_id
 */

function prepare(input) {
  const { valid, errors, payload } = validateGeneration(input);
  if (!valid) throw new ValidationError(errors);
  return payload;
}

/**
 * `POST /api/generate` — one take. No client timeout: local ComfyUI runs can
 * take minutes. Pass a signal to let the user cancel.
 *
 * @param {GenerationInput} input
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<GenerationResult>}
 */
export function generate(input, opts = {}) {
  return request('/api/generate', { method: 'POST', body: prepare(input), signal: opts.signal });
}

/**
 * `POST /api/generate-dual` — two takes at once. `more_variation: true` nudges
 * take B onto an alternate arrangement.
 *
 * @param {GenerationInput} input
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok: boolean, takes: {A: ?GenerationResult, B: ?GenerationResult},
 *                    errors?: Array<{slot: string, error: string}>}>}
 */
export function generateDual(input, opts = {}) {
  return request('/api/generate-dual', { method: 'POST', body: prepare(input), signal: opts.signal });
}

/**
 * `POST /api/generate-stream` — same payload, delivered as SSE.
 *
 * Events seen in local-comfy mode:
 *   `{ status: 'queued', backend }` … then `{ done: true, ...GenerationResult }`
 *   or `{ error }`.
 * Remote mode can also emit `{ partial: true, audio, status }`.
 *
 * @param {GenerationInput} input
 * @param {{ onEvent?: (e: *) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<GenerationResult>} Resolves with the terminal `done` event.
 * @throws {ApiError} Carrying the backend's message when the stream reports one.
 */
export async function generateStream(input, opts = {}) {
  const { onEvent, signal } = opts;
  const payload = prepare(input);
  const endpoint = '/api/generate-stream';

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Could not reach MaxMusic. Check that your studio is running, then try again.',
      { status: 0, details: err?.message ? String(err.message) : null, endpoint });
  }

  if (!res.ok) {
    const parsed = await readBody(res);
    throw new ApiError(pickMessage(parsed, res, endpoint), {
      status: res.status, details: pickDetails(parsed), endpoint, body: parsed,
    });
  }
  if (!res.body) throw new ApiError('The server returned no stream body.', { status: res.status, endpoint });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;
  let failure = null;

  const handle = (json) => {
    if (onEvent) { try { onEvent(json); } catch { /* a listener must not kill the stream */ } }
    if (json?.error && !failure) {
      failure = new ApiError(
        typeof json.error === 'string' ? json.error : (json.error.message || 'Generation failed'),
        { status: 500, details: pickDetails(json), endpoint, body: json },
      );
    }
    if (json?.done) final = json;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const text = line.slice(5).trim();
        if (!text) continue;
        try { handle(JSON.parse(text)); } catch { /* partial frame */ }
      }
    }
  }
  if (buffer.startsWith('data:')) {
    try { handle(JSON.parse(buffer.slice(5).trim())); } catch { /* ignore tail */ }
  }

  if (failure) throw failure;
  if (!final) throw new ApiError('The stream ended without returning a track.', { status: 500, endpoint });
  return final;
}

/* ========================================================================== *
 * POST /api/lyrics — SPEC §3e
 * ========================================================================== */

/**
 * Ask the local Codex CLI to write or edit lyrics. This is step one of the
 * two-step "idea → song" flow: the music backend will not write lyrics itself.
 *
 * @param {{ mode?: 'write_full_song'|'edit', prompt?: string, lyrics?: string, title?: string,
 *           duration?: number }} input  `duration` is the song length in seconds the
 *           lyrics must pace to — the writer budgets its words from it.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok: boolean, song_title: string, style_tags: string, lyrics: string,
 *                    provider?: string, model?: string}>}
 */
export function lyrics(input = {}, opts = {}) {
  const body = {
    mode: LYRICS_MODES.includes(input.mode) ? input.mode : 'write_full_song',
    prompt: String(input.prompt ?? ''),
    lyrics: String(input.lyrics ?? ''),
    title: String(input.title ?? ''),
    ...(Number.isFinite(Number(input.duration)) ? { duration: Number(input.duration) } : {}),
  };
  return request('/api/lyrics', { method: 'POST', body, signal: opts.signal });
}

/* ========================================================================== *
 * POST /api/cover-art
 * ========================================================================== */

/**
 * Generate album art. Returns HTTP 501 with a verbatim reason when the health
 * snapshot reports `coverArt: "disabled"` — surface that reason, do not hide
 * the feature and do not fake a result.
 *
 * @param {{ prompt?: string, title?: string, mode?: 'vocal'|'instrumental'|'cover',
 *           musicPrompt?: string, aspect_ratio?: string, n?: number }} input
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok: boolean, cover: {id: string, filename: string, url: string,
 *                    size: number, prompt: string}, alternatives?: string[]}>}
 */
export function coverArt(input = {}, opts = {}) {
  const ratio = input.aspect_ratio || '1:1';
  if (!ASPECT_RATIOS.includes(ratio)) {
    throw new ValidationError([`Unsupported aspect ratio "${ratio}". Use ${ASPECT_RATIOS.join(', ')}.`]);
  }
  const body = {
    prompt: String(input.prompt ?? ''),
    title: String(input.title ?? ''),
    mode: input.mode || 'vocal',
    musicPrompt: String(input.musicPrompt ?? ''),
    aspect_ratio: ratio,
    n: Number(input.n) || 1,
  };
  return request('/api/cover-art', { method: 'POST', body, signal: opts.signal });
}

/* ========================================================================== *
 * Multipart endpoints
 * ========================================================================== */

function toFormData(fields = {}, file = null, fileField = 'audio') {
  const fd = new FormData();
  if (file) fd.append(fileField, file, file.name || 'audio');
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return fd;
}

async function postForm(endpoint, formData, signal) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', body: formData, signal, cache: 'no-store' });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Could not reach MaxMusic. Check that your studio is running, then try again.',
      { status: 0, details: err?.message ? String(err.message) : null, endpoint });
  }
  const parsed = await readBody(res);
  if (!res.ok) {
    throw new ApiError(pickMessage(parsed, res, endpoint), {
      status: res.status, details: pickDetails(parsed), code: parsed?.code ?? null,
      traceId: parsed?.trace_id ?? null, endpoint, body: parsed,
    });
  }
  return parsed;
}

/**
 * `POST /api/upload` — stash an audio file on the backend and get a URL back.
 * Uses XHR so upload progress is real.
 *
 * @param {File|Blob} file
 * @param {{ signal?: AbortSignal, onProgress?: (fraction: number) => void }} [opts]
 * @returns {Promise<{ok: boolean, filename: string, size: number, mimetype: string, url: string}>}
 */
export function upload(file, opts = {}) {
  const endpoint = '/api/upload';
  return new Promise((resolve, reject) => {
    if (!file) return reject(new ValidationError(['Choose an audio file first.']));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.responseType = 'text';

    if (opts.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) opts.onProgress(e.loaded / e.total);
      });
    }
    const abort = () => xhr.abort();
    if (opts.signal) {
      if (opts.signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      opts.signal.addEventListener('abort', abort, { once: true });
    }
    const cleanup = () => opts.signal?.removeEventListener('abort', abort);

    xhr.addEventListener('load', () => {
      cleanup();
      let parsed = null;
      try { parsed = JSON.parse(xhr.responseText); } catch { parsed = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(parsed);
      reject(new ApiError(
        pickMessage(parsed, { status: xhr.status, statusText: xhr.statusText }, endpoint),
        { status: xhr.status, details: pickDetails(parsed), endpoint, body: parsed },
      ));
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new ApiError('That upload didn’t go through. Check that your studio is running, then try again.', { status: 0, endpoint }));
    });
    xhr.addEventListener('abort', () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); });

    xhr.send(toFormData({}, file));
  });
}

/**
 * `POST /api/cover` — cover / reference-audio generation.
 * In `local-comfy` mode the backend answers 501 with the reason; surface it.
 *
 * @param {{ file?: File|Blob } & Record<string, *>} input  Non-file keys go in the form body.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<GenerationResult>}
 */
export function cover(input = {}, opts = {}) {
  const { file, ...fields } = input;
  return postForm('/api/cover', toFormData(fields, file), opts.signal);
}

/**
 * `POST /api/cover-preprocess` — analyse reference audio before a cover.
 * Also 501 in `local-comfy` mode.
 *
 * @param {{ file?: File|Blob, audio_url?: string }} input
 * @param {{ signal?: AbortSignal }} [opts]
 */
export function coverPreprocess(input = {}, opts = {}) {
  const { file, ...fields } = input;
  return postForm('/api/cover-preprocess', toFormData(fields, file), opts.signal);
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

/**
 * Resolve a backend media path (`/tracks/…`, `/covers/…`, `/uploads/…`) to
 * something an `<audio>` or `<img>` can use. Everything stays same-origin: the
 * dev server proxies those prefixes.
 *
 * @param {string|{url?: string}} pathOrObject
 * @returns {string}
 */
export function mediaUrl(pathOrObject) {
  const raw = typeof pathOrObject === 'string' ? pathOrObject : pathOrObject?.url;
  if (!raw) return '';
  if (/^(https?:)?\/\//i.test(raw)) return raw;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Turn anything thrown by this module into one line fit for a toast.
 * @param {*} err
 * @returns {string}
 */
export function errorText(err) {
  if (!err) return 'Unknown error.';
  if (err instanceof ApiError) return err.fullMessage;
  if (err instanceof ValidationError) return err.issues.join('\n');
  if (err?.name === 'AbortError') return 'Cancelled.';
  return err.message || String(err);
}

/** Named default export for `import api from './api.js'`. */
const api = {
  ApiError, ValidationError,
  LIMITS, FORMATS, BITRATES, SAMPLE_RATES, SECTION_TAGS, ASPECT_RATIOS, LYRICS_MODES,
  request, health, validateGeneration, generate, generateDual, generateStream,
  lyrics, coverArt, upload, cover, coverPreprocess, mediaUrl, errorText,
  openaiStatus, openaiAuthStart, openaiAuthPoll, openaiAuthLogout,
  videoJobCreate, videoJobStatus, videoJobCancel, audioDownloadUrl,
};
export default api;
