import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

let worker;
let account;
let app;
let appUrl;
let replies = [];
let generationCalls = [];
let accountStatus = 200;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function render(seconds, id, {
  seed = 1,
  ceiling = Math.ceil(seconds + 8),
  attempts = 1,
  plannedSeconds = seconds,
  endReason = 'eos',
} = {}) {
  return {
    track: { id, filename: `${id}.flac`, url: `/tracks/${id}.flac` },
    extra_info: {
      music_duration: Math.round(seconds * 1000),
      music_sample_rate: 44100,
      music_channel: 2,
      generation_ceiling_seconds: ceiling,
      generation_seed: seed,
      planning_attempts: attempts,
      planned_duration_seconds: plannedSeconds,
      duration_end_reason: endReason,
    },
    generationCeiling: ceiling,
    generationSeed: seed,
    generationAttempts: attempts,
    plannedSeconds,
    durationEndReason: endReason,
    planningSeconds: 0.1,
    synthesisSeconds: 0.1,
    renderSeconds: 0.1,
    terminalOutroGuard: true,
    acousticEndingPass: true,
    endingGuard: {
      action: 'natural-decay',
      after: { signalVerdict: 'pass' },
    },
    lyricCompletionGuard: true,
    lyricCompletionPass: true,
    lyricCompletion: {
      verdict: 'pass',
      reason: 'full-lyrics-and-terminal-heard',
      fullTrackCoveragePass: true,
    },
  };
}

function failure(status, detail) {
  return { __workerStatus: status, detail };
}

async function generate(path, body) {
  const response = await fetch(`${appUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function post(path, body) {
  const response = await fetch(`${appUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  worker = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/generate') {
      generationCalls.push(await readJson(req));
      const next = replies.shift();
      if (!next) return json(res, 500, { detail: 'test worker ran out of replies' });
      if (next.__workerStatus) return json(res, next.__workerStatus, { detail: next.detail });
      return json(res, 200, next);
    }
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    return json(res, 404, { error: 'not found' });
  });
  const workerAddress = await listen(worker);
  process.env.WORKER_URL = `http://127.0.0.1:${workerAddress.port}`;

  account = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/openai/status') {
      return json(res, accountStatus, accountStatus === 200
        ? { brokerConfigured: true, authenticated: true }
        : { error: 'account relay unavailable' });
    }
    return json(res, 404, { error: 'not found' });
  });
  const accountAddress = await listen(account);
  process.env.OPENAI_BACKEND_URL = `http://127.0.0.1:${accountAddress.port}`;

  const { handleLocal } = await import(`../local-backend.mjs?duration-test=${Date.now()}`);
  app = http.createServer((req, res) => {
    if (!handleLocal(req, res)) json(res, 404, { error: 'not handled' });
  });
  const appAddress = await listen(app);
  appUrl = `http://127.0.0.1:${appAddress.port}`;
});

after(async () => {
  await Promise.all([close(app), close(worker), close(account)]);
});

beforeEach(() => {
  replies = [];
  generationCalls = [];
  accountStatus = 200;
});

test('health never advertises OAuth features while the configured relay is unavailable', async () => {
  accountStatus = 503;
  const unavailable = await fetch(`${appUrl}/api/health`).then((response) => response.json());
  assert.equal(unavailable.openaiConfigured, true);
  assert.equal(unavailable.openaiBroker, 'unreachable');
  assert.equal(unavailable.lyrics, 'disabled');
  assert.equal(unavailable.coverArt, 'disabled');

  accountStatus = 200;
  const restored = await fetch(`${appUrl}/api/health`).then((response) => response.json());
  assert.equal(restored.openaiBroker, 'authenticated');
  assert.equal(restored.lyrics, 'openai-oauth');
  assert.equal(restored.coverArt, 'openai-oauth');
});

test('the backend makes one request and keeps the worker-selected natural plan', async () => {
  replies.push(render(218, 'finished', {
    seed: 42,
    ceiling: 360,
    attempts: 1,
    plannedSeconds: 217.24,
  }));
  const result = await generate('/api/generate', {
    prompt: 'cinematic synth rock',
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 210,
    seed: 42,
  });

  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].duration, 360);
  assert.equal(generationCalls[0].target_duration, 210);
  assert.equal(generationCalls[0].max_plan_attempts, 4);
  assert.equal(generationCalls[0].minimum_duration, 0);
  assert.equal(generationCalls[0].seed, 42);
  assert.equal(result.track.id, 'finished');
  assert.equal(result.generationSeed, 42);
  assert.equal(result.generationAttempts, 1);
  assert.equal(result.durationEndReason, 'eos');
  assert.equal(result.extra_info.duration_recovery, null);
  assert.equal(result.extra_info.planned_duration_seconds, 217.24);
});

test('a complete take outside the ballpark is published, and said so', async () => {
  // Never trimmed and never re-rendered behind the customer's back: the worker
  // plans several complete compositions and publishes the closest. What
  // changes when none of them answers the request is that the length control
  // stops pretending it described the result.
  replies.push(render(117.08, 'natural-117', {
    seed: 1270483973,
    ceiling: 360,
    attempts: 3,
    plannedSeconds: 117.08,
  }));
  const result = await generate('/api/generate', {
    prompt: 'ambient neoclassical darkwave with operatic vocals',
    lyrics: '[verse]\nA complete lyric\n\n[outro]\nI remain',
    duration: 90,
    seed: 1270483973,
  });

  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].duration, 360);
  assert.equal(generationCalls[0].target_duration, 90);
  assert.equal(generationCalls[0].max_plan_attempts, 4);
  assert.equal(result.track.id, 'natural-117');
  assert.equal(result.durationEndReason, 'eos');
  assert.deepEqual(result.extra_info.duration_ballpark_seconds, [67.5, 112.5]);
  assert.equal(result.extra_info.duration_in_ballpark, false);
  assert.match(result.durationWarning, /1:30/);
  assert.match(result.durationWarning, /1:57/);
  assert.match(result.durationWarning, /longer/);
});

test('a take inside the ballpark is not something to warn anybody about', async () => {
  replies.push(render(101, 'natural-101', {
    seed: 5150,
    ceiling: 360,
    attempts: 1,
    plannedSeconds: 101,
  }));
  const result = await generate('/api/generate', {
    prompt: 'ambient neoclassical darkwave with operatic vocals',
    lyrics: '[verse]\nA complete lyric\n\n[outro]\nI remain',
    duration: 90,
    seed: 5150,
  });

  assert.equal(result.durationWarning, null);
  assert.equal(result.extra_info.duration_in_ballpark, true);
});

test('an official structured caption reaches the worker byte-for-byte', async () => {
  const prompt = [
    '### Global Metadata',
    'Basic Attributes: luminous electronic pop.',
    '### Vocal Details',
    'Sing every supplied line.',
    '### Arrangement',
    'Resolve after the outro.',
  ].join('\n');
  replies.push(render(61, 'structured', { seed: 9, ceiling: 75 }));
  await generate('/api/generate', {
    prompt,
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 60,
    seed: 9,
  });
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].prompt, prompt);
});

test('an explicit instrumental brief with tag-only lyrics is canonicalized before the worker', async () => {
  const contradictory = [
    '### Global Metadata',
    'Basic Attributes: instrumental, dark ambient thall, no lyrics.',
    '### Vocal Details',
    'A clear lead vocal delivers the written lyrics.',
    '### Arrangement',
    'Shape one complete song around 4:00 with a resolved outro.',
    'Complete section order: intro -> instrumental -> solo -> instrumental -> outro.',
  ].join('\n');
  replies.push(render(238, 'canonical-instrumental', { seed: 77, ceiling: 360 }));
  await generate('/api/generate', {
    idea: 'Instrumental, dark ambient thall, no lyrics.',
    prompt: contradictory,
    lyrics: '[intro]\n\n[instrumental]\n\n[solo]\n\n[instrumental]\n\n[outro]',
    is_instrumental: false,
    duration: 240,
    seed: 77,
  });

  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].is_instrumental, true);
  assert.doesNotMatch(generationCalls[0].prompt, /clear lead vocal/i);
  assert.match(generationCalls[0].prompt, /Instrumental, no vocals\./);
  assert.ok((generationCalls[0].lyrics.match(/^\[[^\]]+\]$/gm) || []).length >= 8);
});

test('a selected instrumental remains explicit at the current worker boundary', async () => {
  replies.push(render(205, 'selected-instrumental', { seed: 78, ceiling: 360 }));
  await generate('/api/generate', {
    prompt: 'A fully instrumental electronic piece.',
    is_instrumental: true,
    duration: 210,
    seed: 78,
  });
  assert.equal(generationCalls[0].is_instrumental, true);
  assert.match(generationCalls[0].lyrics, /^\[intro\]/);
});

test('a trailing instrumental is moved before the outro on the real API path', async () => {
  replies.push(render(61, 'reordered', { seed: 9, ceiling: 75 }));
  await generate('/api/generate', {
    prompt: 'luminous electronic pop',
    lyrics: '[verse]\nA line\n\n[outro]\nThe ending\n\n[instrumental]',
    duration: 60,
    seed: 9,
  });
  assert.equal(
    generationCalls[0].lyrics,
    '[verse]\nA line\n\n[instrumental]\n\n[outro]\nThe ending',
  );
  assert.match(generationCalls[0].prompt, /Complete section order: verse -> instrumental -> outro\./);
});

test('the semantic EOS report remains authoritative near a waveform ceiling', async () => {
  replies.push(render(226.8, 'complete', {
    seed: 7,
    ceiling: 231,
    plannedSeconds: 225.96,
    endReason: 'eos',
  }));
  const result = await generate('/api/generate', {
    prompt: 'slow orchestral ballad',
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 210,
    seed: 7,
  });
  assert.equal(generationCalls.length, 1);
  assert.equal(result.track.id, 'complete');
  assert.equal(result.durationEndReason, 'eos');
});

test('a semantic-plan failure returns without starting a second backend render', async () => {
  replies.push(failure(500, 'RuntimeError: Music 3 could not plan a naturally ending song. No audio was rendered.'));
  const result = await post('/api/generate', {
    prompt: 'cinematic synth rock',
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 210,
    seed: 42,
  });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /did not finish cleanly/i);
  assert.doesNotMatch(result.body.error, /RuntimeError|seed|plan/i);
  assert.equal(generationCalls.length, 1);
});

test('an uncertified waveform boundary is never published', async () => {
  const unsafe = render(60, 'unsafe', { seed: 42, ceiling: 75 });
  unsafe.acousticEndingPass = false;
  unsafe.endingGuard = {
    action: 'none',
    after: { signalVerdict: 'fail' },
  };
  replies.push(unsafe);
  const result = await post('/api/generate', {
    prompt: 'cinematic synth rock',
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 60,
    seed: 42,
  });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /did not finish cleanly/i);
  assert.equal(generationCalls.length, 1);
});

test('uncertain lyric transcription never discards a naturally ended take', async () => {
  const incomplete = render(60, 'missing-outro', { seed: 42, ceiling: 75 });
  incomplete.lyricCompletionPass = false;
  incomplete.lyricCompletion = {
    verdict: 'fail',
    reason: 'terminal-lyric-missing',
  };
  replies.push(incomplete);
  const result = await post('/api/generate', {
    prompt: 'cinematic synth rock',
    lyrics: '[verse]\nA line\n\n[outro]\nThe ending must be heard',
    duration: 60,
    seed: 42,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.track.id, 'missing-outro');
  assert.equal(result.body.lyricCompletionPass, false);
  assert.equal(generationCalls.length, 1);
});

test('low ASR body coverage remains advisory when EOS and the acoustic ending pass', async () => {
  const incomplete = render(60, 'missing-body', { seed: 42, ceiling: 75 });
  incomplete.lyricCompletionPass = false;
  incomplete.lyricCompletion.fullTrackCoveragePass = false;
  incomplete.lyricCompletion.reason = 'incomplete-lyric-coverage';
  replies.push(incomplete);
  const result = await post('/api/generate', {
    prompt: 'cinematic synth rock',
    lyrics: '[verse]\nA line\n\n[outro]\nThe ending must be heard',
    duration: 60,
    seed: 42,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.track.id, 'missing-body');
  assert.equal(result.body.lyricCompletionPass, false);
  assert.equal(result.body.lyricCompletion.fullTrackCoveragePass, false);
  assert.equal(generationCalls.length, 1);
});

test('a naturally short take is accepted without a warning or blind retry', async () => {
  replies.push(render(160, 'complete-short', {
    seed: 7,
    ceiling: 360,
    plannedSeconds: 159.2,
  }));
  const result = await generate('/api/generate', {
    prompt: 'slow orchestral ballad',
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 210,
    seed: 7,
  });

  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].duration, 360);
  assert.equal(generationCalls[0].seed, 7);
  assert.equal(result.track.id, 'complete-short');
  // 2:40 for a 3:30 request: shorter than asked, still recognisably the song
  // that was ordered, and nothing was cut to get there.
  assert.equal(result.extra_info.duration_in_ballpark, true);
  assert.equal(result.durationWarning, null);
});

test('a five-minute request answered with fifty seconds is not passed off as fine', async () => {
  replies.push(render(50, 'far-too-short', {
    seed: 11,
    ceiling: 360,
    attempts: 4,
    plannedSeconds: 50,
  }));
  const result = await generate('/api/generate', {
    prompt: 'slow orchestral ballad',
    lyrics: '[verse]\nA line\n\n[outro]\nThe end',
    duration: 300,
    seed: 11,
  });

  assert.equal(result.track.id, 'far-too-short');
  assert.equal(result.extra_info.duration_in_ballpark, false);
  assert.match(result.durationWarning, /5:00/);
  assert.match(result.durationWarning, /0:50/);
  assert.match(result.durationWarning, /shorter/);
});

test('dual generation uses two explicit distinct seeds and no hidden retries for good takes', async () => {
  replies.push(
    render(200, 'take-a', { seed: 100, ceiling: 231 }),
    render(201, 'take-b', { seed: 104829, ceiling: 231 }),
  );
  const result = await generate('/api/generate-dual', {
    prompt: 'driving electronic instrumental',
    duration: 210,
    is_instrumental: true,
  });

  assert.equal(generationCalls.length, 2);
  assert.equal(Number.isInteger(generationCalls[0].seed), true);
  assert.equal(Number.isInteger(generationCalls[1].seed), true);
  assert.notEqual(generationCalls[0].seed, generationCalls[1].seed);
  assert.equal(result.takes.A.track.id, 'take-a');
  assert.equal(result.takes.B.track.id, 'take-b');
  assert.equal(result.takes.A.generationAttempts, 1);
  assert.equal(result.takes.B.generationAttempts, 1);
});
