// maxmusic — MiniMax music studio proxy
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const API_BASE = 'https://api.minimax.io';
const TRACKS_DIR = path.join(__dirname, 'public', 'tracks');
const COVERS_DIR = path.join(__dirname, 'public', 'covers');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_MB = 50;

await fs.mkdir(TRACKS_DIR, { recursive: true });
await fs.mkdir(COVERS_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const id = crypto.randomBytes(8).toString('hex');
      const ext = path.extname(file.originalname) || '.mp3';
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const ERROR_CODES = {
  0: 'Success',
  1002: 'Rate limit triggered — retry in a moment',
  1004: 'Authentication failed — check API key',
  1008: 'Insufficient balance on your account',
  1026: 'Content flagged for sensitive material',
  2013: 'Invalid parameters — check your inputs',
  2049: 'Invalid API key',
};

function getApiKey(req) {
  const header = req.header('x-api-key');
  if (header) return header.trim();
  return process.env.MINIMAX_API_KEY?.trim() || null;
}

function apiError(json, fallbackStatus = 400) {
  const baseResp = json?.base_resp;
  if (baseResp && baseResp.status_code !== 0) {
    const code = baseResp.status_code;
    return {
      status: fallbackStatus,
      body: {
        error: ERROR_CODES[code] || `API error ${code}`,
        code,
        details: baseResp.status_msg,
        trace_id: json.trace_id,
      },
    };
  }
  return null;
}

async function callMusicApi(payload, apiKey) {
  const res = await fetch(`${API_BASE}/v1/music_generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, json, raw: text };
}

async function persistHexAudio(hex, format) {
  const id = crypto.randomBytes(10).toString('hex');
  const ext = format === 'wav' ? 'wav' : format === 'pcm' ? 'pcm' : 'mp3';
  const filename = `${id}.${ext}`;
  const buf = Buffer.from(hex, 'hex');
  await fs.writeFile(path.join(TRACKS_DIR, filename), buf);
  return { id, filename, url: `/tracks/${filename}`, size: buf.length };
}

async function persistRemoteAudio(remoteUrl, format) {
  const r = await fetch(remoteUrl);
  if (!r.ok) throw new Error(`Failed to fetch remote audio: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const id = crypto.randomBytes(10).toString('hex');
  const ext = format === 'wav' ? 'wav' : format === 'pcm' ? 'pcm' : 'mp3';
  const filename = `${id}.${ext}`;
  await fs.writeFile(path.join(TRACKS_DIR, filename), buf);
  return { id, filename, url: `/tracks/${filename}`, size: buf.length };
}

function buildPayload(body, req) {
  const {
    model = 'music-2.6',
    prompt = '',
    lyrics = '',
    is_instrumental = false,
    lyrics_optimizer = false,
    stream = false,
    output_format = 'hex',
    audio_setting = {},
    reference_filename = null,
    cover_feature_id = null,
    variation_suffix = '',
  } = body || {};

  const payload = { model, stream, output_format: stream ? 'hex' : output_format };
  if (audio_setting && Object.keys(audio_setting).length) {
    payload.audio_setting = audio_setting;
  }

  if (model === 'music-cover' || model === 'music-cover-free') {
    if (!prompt || prompt.length < 10) {
      throw new Error('Cover mode requires a target style prompt (10–300 chars).');
    }
    if (cover_feature_id) {
      payload.cover_feature_id = cover_feature_id;
      if (!lyrics || lyrics.length < 10) {
        throw new Error('Cover with edited lyrics requires lyrics (10–1000 chars).');
      }
      payload.lyrics = lyrics.slice(0, 1000);
    } else if (!reference_filename && !body?.audio_url) {
      throw new Error('Cover mode requires reference audio (upload or URL).');
    }
    payload.prompt = (prompt + variation_suffix).slice(0, 300);
  } else if (is_instrumental) {
    if (!prompt || prompt.length < 1) throw new Error('Instrumental mode requires a style prompt.');
    payload.is_instrumental = true;
    payload.prompt = (prompt + variation_suffix).slice(0, 2000);
  } else if (lyrics_optimizer) {
    payload.lyrics_optimizer = true;
    if (prompt) payload.prompt = (prompt + variation_suffix).slice(0, 2000);
  } else {
    if (!lyrics || lyrics.length < 1) {
      throw new Error('Vocal mode requires lyrics (or enable auto-lyrics).');
    }
    payload.lyrics = lyrics.slice(0, 3500);
    if (prompt) payload.prompt = (prompt + variation_suffix).slice(0, 2000);
  }

  if ((model === 'music-cover' || model === 'music-cover-free')
      && !payload.cover_feature_id) {
    if (body?.audio_url) {
      payload.audio_url = body.audio_url;
    } else if (reference_filename) {
      const host = `${req.protocol}://${req.get('host')}`;
      payload.audio_url = `${host}/uploads/${path.basename(reference_filename)}`;
    }
  }

  return payload;
}

async function finalizeMusicResponse(json, req) {
  const err = apiError(json);
  if (err) return { error: err.body, status: err.status };

  const data = json.data || {};
  const extra = json.extra_info || {};
  const format = req.body?.audio_setting?.format || 'mp3';
  let track = null;

  if (data.audio) {
    const isUrl = typeof data.audio === 'string' && /^https?:\/\//i.test(data.audio);
    if (isUrl) {
      track = await persistRemoteAudio(data.audio, format);
    } else {
      track = await persistHexAudio(data.audio, format);
    }
  }

  return {
    ok: true,
    track,
    extra_info: extra,
    trace_id: json.trace_id,
    status: data.status,
  };
}

async function runGeneration(req, res) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: 'No API key. Set MINIMAX_API_KEY or pass X-Api-Key.' });
  }

  let payload;
  try {
    payload = buildPayload(req.body, req);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const { json } = await callMusicApi(payload, apiKey);
    const result = await finalizeMusicResponse(json, req);
    if (result.error) return res.status(result.status).json(result.error);
    res.json(result);
  } catch (err) {
    console.error('[generate]', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
}

async function runDualGeneration(req, res) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: 'No API key. Set MINIMAX_API_KEY or pass X-Api-Key.' });
  }

  const moreVariation = Boolean(req.body?.more_variation);
  const suffixB = moreVariation ? ', alternate arrangement, variation B' : '';

  let payloadA;
  let payloadB;
  try {
    payloadA = buildPayload(req.body, req);
    payloadB = buildPayload({ ...req.body, variation_suffix: suffixB }, req);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const [resA, resB] = await Promise.all([
      callMusicApi(payloadA, apiKey),
      callMusicApi(payloadB, apiKey),
    ]);

    const fakeReq = { body: req.body };
    const outA = await finalizeMusicResponse(resA.json, fakeReq);
    const outB = await finalizeMusicResponse(resB.json, fakeReq);

    const errors = [];
    if (outA.error) errors.push({ slot: 'A', ...outA.error });
    if (outB.error) errors.push({ slot: 'B', ...outB.error });
    if (errors.length === 2) {
      return res.status(400).json({ error: 'Both generations failed', errors });
    }

    res.json({
      ok: true,
      takes: {
        A: outA.error ? null : outA,
        B: outB.error ? null : outB,
      },
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('[generate-dual]', err);
    res.status(500).json({ error: err.message || 'Dual generation failed' });
  }
}

// Stream proxy — forwards upstream body as SSE chunks
app.post('/api/generate-stream', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: 'No API key.' });
  }

  let payload;
  try {
    payload = buildPayload({ ...req.body, stream: true, output_format: 'hex' }, req);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const upstream = await fetch(`${API_BASE}/v1/music_generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      res.write(`data: ${JSON.stringify({ error: text.slice(0, 500) })}\n\n`);
      return res.end();
    }

    const reader = upstream.body?.getReader();
    if (!reader) {
      const text = await upstream.text();
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
      return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      res.write(`data: ${JSON.stringify({ chunk: decoder.decode(value) })}\n\n`);
    }

    // Try to parse final JSON from buffer
    try {
      const json = JSON.parse(buffer);
      const err = apiError(json);
      if (err) {
        res.write(`data: ${JSON.stringify({ error: err.body })}\n\n`);
      } else if (json?.data?.audio) {
        const format = req.body?.audio_setting?.format || 'mp3';
        const track = await persistHexAudio(json.data.audio, format);
        res.write(`data: ${JSON.stringify({ done: true, track, extra_info: json.extra_info, trace_id: json.trace_id })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ done: true, raw: json })}\n\n`);
      }
    } catch {
      res.write(`data: ${JSON.stringify({ done: true, note: 'stream ended' })}\n\n`);
    }
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    apiBase: API_BASE,
    hasServerKey: Boolean(process.env.MINIMAX_API_KEY),
  });
});

app.post('/api/generate', runGeneration);
app.post('/api/generate-dual', runDualGeneration);

app.post('/api/cover', upload.single('audio'), (req, res) => {
  if (req.file) {
    req.body = req.body || {};
    req.body.reference_filename = req.file.filename;
    // Parse JSON fields sent via multipart
    for (const key of ['model', 'prompt', 'lyrics', 'audio_setting', 'output_format', 'is_instrumental', 'lyrics_optimizer', 'cover_feature_id', 'more_variation']) {
      if (typeof req.body[key] === 'string' && (req.body[key].startsWith('{') || req.body[key].startsWith('['))) {
        try { req.body[key] = JSON.parse(req.body[key]); } catch { /* keep string */ }
      }
    }
  }
  return runGeneration(req, res);
});

app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });
  res.json({
    ok: true,
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    url: `/uploads/${req.file.filename}`,
  });
});

app.post('/api/cover-preprocess', upload.single('audio'), async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'No API key.' });

  let audio_url = req.body?.audio_url;
  if (req.file) {
    const host = `${req.protocol}://${req.get('host')}`;
    audio_url = `${host}/uploads/${req.file.filename}`;
  }
  if (!audio_url && !req.body?.audio_base64) {
    return res.status(400).json({ error: 'Provide reference audio (file or URL).' });
  }

  const payload = { model: 'music-cover' };
  if (audio_url) payload.audio_url = audio_url;
  else payload.audio_base64 = req.body.audio_base64;

  try {
    const r = await fetch(`${API_BASE}/v1/music_cover_preprocess`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await r.json();
    const err = apiError(json);
    if (err) return res.status(err.status).json(err.body);
    res.json({ ok: true, ...json });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lyrics', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'No API key.' });

  const { mode = 'write_full_song', prompt = '', lyrics = '', title = '' } = req.body || {};
  try {
    const r = await fetch(`${API_BASE}/v1/lyrics_generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ mode, prompt, lyrics, title }),
    });
    const json = await r.json();
    const err = apiError(json);
    if (err) return res.status(err.status).json(err.body);
    res.json({ ok: true, ...json });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '2:3', '3:2']);

function buildCoverPrompt({ title, musicPrompt, mode }) {
  const mood = (musicPrompt || title || 'atmospheric').slice(0, 400);
  const baseTitle = (title || 'Untitled').slice(0, 80);
  const modeHint = {
    vocal: 'album cover, negative space for typography',
    instrumental: 'cinematic wide composition, instrumental album art',
    cover: 'cover version album art',
  }[mode] || 'album cover';
  return [
    `Album cover art titled "${baseTitle}".`,
    mood,
    `${modeHint}, square 1:1, no text, no logos, vivid palette, streaming-ready.`,
  ].join(' ');
}

app.post('/api/cover-art', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'No API key.' });

  const {
    prompt,
    title,
    mode,
    musicPrompt,
    aspect_ratio = '1:1',
    model = 'image-01',
    n = 1,
    prompt_optimizer = true,
  } = req.body || {};

  if (!ASPECT_RATIOS.has(aspect_ratio)) {
    return res.status(400).json({ error: `Invalid aspect_ratio.` });
  }

  const finalPrompt = (prompt && prompt.trim())
    ? prompt.trim().slice(0, 1500)
    : buildCoverPrompt({ title, musicPrompt, mode });

  try {
    const r = await fetch(`${API_BASE}/v1/image_generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: finalPrompt,
        aspect_ratio,
        response_format: 'url',
        n,
        prompt_optimizer,
      }),
    });
    const json = await r.json();
    const err = apiError(json);
    if (err) return res.status(err.status).json(err.body);

    const remoteUrls = json?.data?.image_urls || [];
    if (!remoteUrls.length) {
      return res.status(500).json({ error: 'Image API returned no URLs' });
    }

    const imgRes = await fetch(remoteUrls[0]);
    if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const id = crypto.randomBytes(10).toString('hex');
    const ct = imgRes.headers.get('content-type') || '';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const filename = `${id}.${ext}`;
    await fs.writeFile(path.join(COVERS_DIR, filename), buf);
    res.json({
      ok: true,
      cover: { id, filename, url: `/covers/${filename}`, size: buf.length, prompt: finalPrompt },
      alternatives: remoteUrls.slice(1),
    });
  } catch (err) {
    console.error('[cover-art]', err);
    res.status(500).json({ error: err.message || 'Cover art failed' });
  }
});

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h' }));
app.use('/covers', express.static(COVERS_DIR, { maxAge: '1d' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const server = http.createServer(app);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Run:\n    npm run stop\n  or:\n    PORT=${Number(PORT) + 1} npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  maxmusic → http://localhost:${PORT}`);
  console.log(`  API: ${API_BASE}`);
  if (process.env.MINIMAX_API_KEY) {
    console.log(`  Server key: loaded`);
  } else {
    console.log(`  Server key: not set — use Settings in the UI`);
  }
});