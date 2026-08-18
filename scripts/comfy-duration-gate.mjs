#!/usr/bin/env node
/**
 * Direct MiniMax Music 3 acceptance runner for ComfyUI.
 *
 * This deliberately bypasses MaxMusic's browser and HTTP backend. It submits
 * the native ComfyUI graph, wires the encoder's planned `seconds` output to the
 * latent canvas, downloads the untouched result, and records evidence about
 * its duration and final waveform. A signal check is not allowed to declare a
 * musical ending complete: every result remains pending until its final lyric
 * and phrase are reviewed from the saved tail clip/transcript.
 *
 * Examples:
 *   node scripts/comfy-duration-gate.mjs --sequence pilot
 *   node scripts/comfy-duration-gate.mjs --sequence ascending
 *   node scripts/comfy-duration-gate.mjs --sequence ascending --start-target 120
 *   node scripts/comfy-duration-gate.mjs --sequence descending
 *   node scripts/comfy-duration-gate.mjs --sequence full
 *   node scripts/comfy-duration-gate.mjs --sequence full --run-id overnight-v1 --resume true
 *   node scripts/comfy-duration-gate.mjs --target 270 --plan-only true
 *   node scripts/comfy-duration-gate.mjs --target 120 --seed 1864633347
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_COMFY = 'http://127.0.0.1:8189';
const TARGETS = Object.freeze([30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);
const TERMINAL_LYRIC = 'At last, the silver river carries us safely home.';

const PROFILE = Object.freeze({
  diffusionModel: 'minimax_music3/minimax_music3_dit_fp16.safetensors',
  textEncoder: 'minimax_music3/minimax_music3_text_encoder_pruned_int8_convrot.safetensors',
  vae: 'minimax_music3/minimax_music3_dav.safetensors',
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const next = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[rawKey.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase())] = next;
  }
  return out;
}

function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function countWords(text) {
  return String(text)
    .split('\n')
    .filter((line) => !/^\s*\[[^\]]+\]\s*$/.test(line))
    .join(' ')
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

const INTRO = {
  tag: 'intro',
  lines: [
    'Night opens softly over the city.',
    'One clear pulse wakes under the rain.',
  ],
};

const OUTRO = {
  tag: 'outro',
  lines: [
    'Now every restless light grows quiet.',
    'The final chord settles into dawn.',
    TERMINAL_LYRIC,
  ],
};

const SHORT_VERSE = {
  tag: 'verse',
  lines: [
    'We follow one light through the rain.',
    'Each step turns the dark into morning.',
  ],
};

const BODY = Object.freeze([
  {
    tag: 'verse',
    lines: [
      'Streetlights are drifting across the wet glass.',
      'Our shadows move slowly but never look back.',
      'A signal keeps shining beyond every door.',
      'We carry the rhythm and ask nothing more.',
    ],
  },
  {
    tag: 'pre-chorus',
    lines: [
      'Hold to the spark when the skyline turns blue.',
      'Every long mile is leading us through.',
      'Breathe with the drums as the old echoes fall.',
    ],
  },
  {
    tag: 'chorus',
    lines: [
      'Carry us home on the silver river.',
      'Lift every voice till the cold stars shimmer.',
      'We were divided, now we move as one.',
      'Carry us home to the rise of the sun.',
    ],
  },
  {
    tag: 'verse',
    lines: [
      'Windows glow gold where the sleeping trains turn.',
      'Names we once whispered are lessons we learned.',
      'The wind takes the worry we carried for years.',
      'A warm steady harmony answers our fears.',
    ],
  },
  {
    tag: 'pre-chorus',
    lines: [
      'Step through the silence and open your hands.',
      'Trust where the rising melody lands.',
      'Nothing is ending before it is done.',
    ],
  },
  {
    tag: 'chorus',
    lines: [
      'Carry us home on the silver river.',
      'Lift every voice till the cold stars shimmer.',
      'We were divided, now we move as one.',
      'Carry us home to the rise of the sun.',
    ],
  },
  { tag: 'instrumental', lines: [] },
  {
    tag: 'verse',
    lines: [
      'Morning is waiting beyond the last station.',
      'Basslines are building a new constellation.',
      'Every bright measure releases the past.',
      'We know this fragile momentum can last.',
    ],
  },
  {
    tag: 'bridge',
    lines: [
      'If the road bends, let the harmony guide us.',
      'If the night calls, keep the fire beside us.',
      'Leave every unfinished promise behind.',
      'Answer the dawn with an unguarded mind.',
    ],
  },
  {
    tag: 'chorus',
    lines: [
      'Carry us home on the silver river.',
      'Lift every voice till the cold stars shimmer.',
      'We were divided, now we move as one.',
      'Carry us home to the rise of the sun.',
    ],
  },
  { tag: 'instrumental', lines: [] },
  {
    tag: 'verse',
    lines: [
      'Clouds separate over the roofs of the town.',
      'Old walls of thunder are quietly coming down.',
      'The tune keeps evolving, alive in each turn.',
      'Softly the horizon begins now to burn.',
    ],
  },
  {
    tag: 'bridge',
    lines: [
      'Lower the drums and let one piano answer.',
      'Open the space for the final expansion.',
      'Gather the voices, then let them release.',
      'Resolve every phrase into luminous peace.',
    ],
  },
  {
    tag: 'chorus',
    lines: [
      'Carry us home on the silver river.',
      'Lift every voice till the cold stars shimmer.',
      'We crossed the distance, now we move as one.',
      'Carry us home to the rise of the sun.',
    ],
  },
]);

const EXPANSION_LINES = Object.freeze([
  'No broken road can hold us here.',
  'A patient melody carries the night.',
  'New colors gather beyond every window.',
  'The rhythm keeps opening room for tomorrow.',
  'We turn one more corner together.',
  'A distant piano replies to the rain.',
  'The bass moves gently under our footsteps.',
  'Each passing measure releases another shadow.',
  'Warm voices arrive as the skyline brightens.',
  'We let the old silence fall behind us.',
  'One final ascent brings the horizon closer.',
  'The drums grow wider without losing their pulse.',
  'Every harmony now points toward morning.',
  'We keep moving until the clouds divide.',
  'The last dark station fades in the distance.',
  'A brighter chord waits beyond the bridge.',
  'Our breathing settles into the turning groove.',
  'The open road answers in steady time.',
  'Nothing remains unfinished in the rising light.',
  'We gather every promise into one clear song.',
]);

function renderSections(sections) {
  return sections
    .map(({ tag, lines }) => [`[${tag}]`, ...lines].join('\n'))
    .join('\n\n');
}

function parseSections(lyrics) {
  const sections = [];
  let current = null;
  for (const raw of String(lyrics).replace(/\r\n?/g, '\n').split('\n')) {
    const match = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      current = { tag: match[1].trim().toLowerCase(), lines: [] };
      sections.push(current);
    } else if (current && raw.trim()) {
      current.lines.push(raw.trim());
    }
  }
  return sections;
}

function adjustLyrics(lyrics, direction) {
  const sections = parseSections(lyrics);
  const outroIndex = sections.findIndex((section) => section.tag === 'outro');
  if (outroIndex < 0) throw new Error('The controlled test lyric lost its [outro].');

  if (direction === 'longer') {
    const existing = new Set(sections.flatMap((section) => section.lines).map((line) => line.toLowerCase()));
    const line = EXPANSION_LINES.find((candidate) => !existing.has(candidate.toLowerCase()));
    if (!line) return lyrics;

    let destination = -1;
    for (let i = outroIndex - 1; i >= 0; i -= 1) {
      if (sections[i].tag === 'verse' && sections[i].lines.length < 4) {
        destination = i;
        break;
      }
    }
    if (destination >= 0) sections[destination].lines.push(line);
    else sections.splice(outroIndex, 0, { tag: 'verse', lines: [line] });
    return renderSections(sections);
  }

  for (let i = outroIndex - 1; i >= 0; i -= 1) {
    if (sections[i].tag === 'instrumental' || sections[i].tag === 'chorus') continue;
    if (sections[i].lines.length > 1) {
      sections[i].lines.pop();
      return renderSections(sections);
    }
  }
  return lyrics;
}

function adjustLyricsBy(lyrics, direction, steps) {
  let revised = lyrics;
  for (let step = 0; step < steps; step += 1) {
    const next = adjustLyrics(revised, direction);
    if (next === revised) break;
    revised = next;
  }
  return revised;
}

function lyricsFor(target) {
  if (target === 30) return renderSections([SHORT_VERSE, {
    tag: 'outro',
    lines: ['The final chord settles into dawn.', TERMINAL_LYRIC],
  }]);

  // Longer songs need a correspondingly complete lyric/section arc. The old
  // 1.18 density left 4:00 requests with roughly 294 words and repeated
  // deterministic plans around 3:15; that was a test-fixture defect, not a
  // duration-control failure. Cross into the long-form density at 3:30.
  const desiredWords = Math.round(target * (target >= 210 ? 1.45 : 1.18));
  const selected = [INTRO];
  for (const section of BODY) {
    if (countWords(renderSections([...selected, OUTRO])) >= desiredWords) break;
    selected.push(section);
  }
  selected.push(OUTRO);
  let lyrics = renderSections(selected);
  while (countWords(lyrics) < desiredWords) {
    const expanded = adjustLyrics(lyrics, 'longer');
    if (expanded === lyrics) break;
    lyrics = expanded;
  }
  return lyrics;
}

const SECTION_DIRECTIONS = Object.freeze({
  intro: 'Sparse pad and piano; minimal drums; clear vocal entrance.',
  verse: 'Forward vocal; restrained drums; one new texture and stronger bass.',
  'pre-chorus': 'Widen pad and drums; withhold the full payoff.',
  chorus: 'Full hook, firm drums, broad synths, bass, and light harmony.',
  'post-chorus': 'Answer the hook melodically; retain pulse for transition.',
  instrumental: 'Develop the motif through changing harmony and texture; never loop.',
  solo: 'Expressive lead line, then return to vocal focus.',
  bridge: 'Thin drums, shift harmony, rebuild toward the final peak.',
  outro: 'Sing every line once, reduce density, and resolve.',
});

function arrangementTimeline(target, lyrics) {
  const sections = parseSections(lyrics);
  const tailSeconds = Math.max(2, Math.min(8, Math.round(target * 0.025)));
  const contentSeconds = Math.max(sections.length, target - tailSeconds);
  const weights = sections.map((section) => {
    const words = countWords(renderSections([section]));
    if (section.tag === 'instrumental' || section.tag === 'solo') return Math.max(18, target * 0.06);
    if (section.tag === 'intro') return Math.max(8, words * 0.8);
    if (section.tag === 'outro') return Math.max(12, words * 1.15);
    return Math.max(10, words);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const occurrences = new Map();
  let cursor = 0;
  const lines = sections.map((section, index) => {
    const occurrence = (occurrences.get(section.tag) || 0) + 1;
    occurrences.set(section.tag, occurrence);
    const start = cursor;
    const end = index === sections.length - 1
      ? contentSeconds
      : Math.min(contentSeconds, cursor + (contentSeconds * weights[index]) / totalWeight);
    cursor = end;
    const label = section.tag.replace(/(^|-)\w/g, (match) => match.toUpperCase().replace('-', '-'));
    const repeated = sections.filter((candidate) => candidate.tag === section.tag).length > 1;
    const description = SECTION_DIRECTIONS[section.tag]
      || 'Develop this tagged section coherently and make its transition clearly audible.';
    return `${label}${repeated ? ` ${occurrence}` : ''} (${clock(start)}–${clock(end)}): ${description}`;
  });
  lines.push(
    `Final decay (${clock(contentSeconds)}–${clock(target)}): no new lyric; resolve and fade fully without a hard edit.`,
  );
  return lines.join('\n');
}

function captionFor(target, lyrics) {
  const tags = [...lyrics.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  return [
    '### Global Metadata',
    `Basic Attributes: Luminous cinematic electronic pop and synth-pop at 100–108 BPM, shaped as a complete approximately ${clock(target)} song rather than an excerpt. Warm analog synths, live-feeling electronic drums, electric bass, and selective piano.`,
    'Emotional Progression: Move from nocturnal restraint through broader choruses and a contrasting bridge to a late peak, then calm sunrise resolution.',
    'Production: Keep the lead and motif intelligible in a wide, stable image. Sustain runtime through real harmonic, rhythmic, and density changes—not loops, copied endings, or silence.',
    '',
    '### Vocal Details',
    'One clear English lead with natural diction: intimate verses, lifting pre-choruses, stronger intelligible choruses, and light harmony only at peaks.',
    'Sing all supplied lyrics in order and honor every tag. Never skip sections, start the outro early, replace later text with a hook, or stop inside a word or line. Follow the final lyric with musical resolution.',
    '',
    '### Arrangement',
    `Follow this complete order: ${tags.join(' -> ')}. The spans form one continuous plan; the final boundary is a target, never an edit point. Maintain motif identity while changing drums, bass, voicing, countermelody, and width.`,
    arrangementTimeline(target, lyrics),
    'Completion: Reserve time for every section, peak in the final third, perform the complete outro afterward, and emit end-of-song only after audible resolution and decay. Never force continuation or truncate at the boundary.',
  ].join('\n');
}

function headroomFor(target) {
  return Math.max(8, Math.min(20, Math.round(target * 0.08)));
}

function toleranceFor(target) {
  const floor = target <= 30 ? 8 : 15;
  return Math.max(floor, Math.min(30, target * 0.1));
}

function makeWorkflow({ caption, lyrics, target, ceiling, seed, prefix }) {
  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: PROFILE.diffusionModel, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: PROFILE.textEncoder, type: 'minimax' },
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: PROFILE.vae },
    },
    '4': {
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: {
        clip: ['2', 0],
        caption,
        lyrics,
        seed,
        max_duration: ceiling,
        cfg_scale: 1.7,
        top_k: 50,
      },
    },
    '5': {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['4', 0] },
    },
    '6': {
      class_type: 'EmptyMiniMaxMusic3LatentAudio',
      inputs: { seconds: ['4', 1], batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed,
        steps: 30,
        cfg: 1.7,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    '8': {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['7', 0], vae: ['3', 0] },
    },
    '9': {
      class_type: 'SaveAudioAdvanced',
      inputs: { audio: ['8', 0], filename_prefix: prefix, format: 'flac' },
    },
  };
}

function makePlanWorkflow({ caption, lyrics, ceiling, seed }) {
  return {
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: PROFILE.textEncoder, type: 'minimax' },
    },
    '4': {
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: {
        clip: ['2', 0],
        caption,
        lyrics,
        seed,
        max_duration: ceiling,
        cfg_scale: 1.7,
        top_k: 50,
      },
    },
    '10': {
      class_type: 'PreviewAny',
      inputs: { source: ['4', 1] },
    },
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error(`${response.status} ${data?.error || text.slice(0, 800)}`);
  return data;
}

async function waitForResult(comfy, promptId) {
  const started = Date.now();
  let announced = 0;
  while (Date.now() - started < 45 * 60 * 1000) {
    const history = await fetchJson(`${comfy}/history/${encodeURIComponent(promptId)}`);
    const entry = history?.[promptId];
    if (entry?.status?.status_str === 'error') {
      const detail = JSON.stringify(entry.status?.messages || []).slice(0, 2000);
      throw new Error(`ComfyUI execution failed: ${detail}`);
    }
    if (entry?.status?.completed || entry?.status?.status_str === 'success') {
      for (const output of Object.values(entry.outputs || {})) {
        if (Array.isArray(output?.audio) && output.audio[0]) return { entry, audio: output.audio[0] };
      }
      throw new Error('ComfyUI completed without an audio output.');
    }
    const elapsed = Math.floor((Date.now() - started) / 1000);
    if (elapsed >= announced + 30) {
      announced = elapsed;
      process.stdout.write(`  still rendering (${clock(elapsed)} elapsed)\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('ComfyUI render exceeded the 45-minute test timeout.');
}

async function waitForPlan(comfy, promptId) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    const history = await fetchJson(`${comfy}/history/${encodeURIComponent(promptId)}`);
    const entry = history?.[promptId];
    if (entry?.status?.status_str === 'error') {
      throw new Error(`ComfyUI planning failed: ${JSON.stringify(entry.status?.messages || []).slice(0, 2000)}`);
    }
    if (entry?.status?.completed || entry?.status?.status_str === 'success') {
      const planned = Number(entry.outputs?.['10']?.text?.[0]);
      if (!(planned > 0)) throw new Error(`ComfyUI planner did not expose seconds: ${JSON.stringify(entry.outputs)}`);
      return { entry, seconds: planned };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('ComfyUI encoder planning exceeded the 10-minute test timeout.');
}

async function planSong(comfy, { target, ceiling, seed, initialLyrics }) {
  let lyrics = initialLyrics;
  const attempts = [];
  const seenLyrics = new Set();
  const tolerance = toleranceFor(target);
  for (let attempt = 1; attempt <= 16; attempt += 1) {
    if (seenLyrics.has(lyrics)) break;
    seenLyrics.add(lyrics);
    const caption = captionFor(target, lyrics);
    const workflow = makePlanWorkflow({ caption, lyrics, ceiling, seed });
    const submittedAt = Date.now();
    const queued = await fetchJson(`${comfy}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
      timeoutMs: 60_000,
    });
    if (!queued?.prompt_id) throw new Error(`ComfyUI did not return a planning prompt_id: ${JSON.stringify(queued)}`);
    const result = await waitForPlan(comfy, queued.prompt_id);
    const durationError = Math.round((result.seconds - target) * 1000) / 1000;
    const ceilingMargin = Math.round((ceiling - result.seconds) * 1000) / 1000;
    const pass = Math.abs(durationError) <= tolerance && ceilingMargin > 0.75;
    attempts.push({
      attempt,
      promptId: queued.prompt_id,
      lyricWords: countWords(lyrics),
      plannedSeconds: result.seconds,
      durationError,
      ceilingMargin,
      pass,
      elapsedSeconds: Math.round((Date.now() - submittedAt) / 100) / 10,
    });
    process.stdout.write(
      `  plan ${attempt}: ${countWords(lyrics)} words -> ${result.seconds.toFixed(2)}s `
      + `(${durationError >= 0 ? '+' : ''}${durationError.toFixed(2)}s)${pass ? ' PASS' : ''}\n`,
    );
    if (pass) return { pass: true, lyrics, caption, plannedSeconds: result.seconds, attempts };

    const direction = result.seconds < target - tolerance ? 'longer' : 'shorter';
    // Correct a large miss proportionally. One seven-word line per 45-second
    // miss burned many near-identical language-model passes without adding a
    // meaningful song section. Five lines make one actual verse-sized change.
    const revisionSteps = Math.max(1, Math.min(6, Math.ceil(Math.abs(durationError) / 10)));
    const revised = adjustLyricsBy(lyrics, direction, revisionSteps);
    if (revised === lyrics) break;
    lyrics = revised;
  }
  const last = attempts[attempts.length - 1];
  return {
    pass: false,
    lyrics,
    caption: captionFor(target, lyrics),
    plannedSeconds: last?.plannedSeconds || null,
    attempts,
  };
}

async function downloadAudio(comfy, output, destination) {
  const url = new URL('/view', `${comfy}/`);
  url.searchParams.set('filename', output.filename);
  url.searchParams.set('subfolder', output.subfolder || '');
  url.searchParams.set('type', output.type || 'output');
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!response.ok) throw new Error(`Could not download ComfyUI output: HTTP ${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function run(command, args, { capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    const stdout = [];
    const stderr = [];
    if (capture) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout));
      reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1200)}`));
    });
  });
}

async function mediaDuration(filename) {
  const out = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filename,
  ]);
  return Number(out.toString('utf8').trim());
}

function db(value) {
  return Math.round(20 * Math.log10(Math.max(1e-12, value)) * 10) / 10;
}

function rms(samples, start, end) {
  const lo = Math.max(0, Math.min(samples.length, Math.floor(start)));
  const hi = Math.max(lo + 1, Math.min(samples.length, Math.floor(end)));
  let sum = 0;
  let peak = 0;
  for (let i = lo; i < hi; i += 1) {
    const value = samples[i];
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  return { rms: Math.sqrt(sum / (hi - lo)), peak };
}

async function boundaryAnalysis(filename) {
  const pcm = await run('ffmpeg', [
    '-v', 'error', '-i', filename, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
  ]);
  const values = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const rate = 16000;
  const end = values.length;
  const windows = {};
  for (const seconds of [0.1, 0.25, 0.5, 1, 2, 5]) {
    const stat = rms(values, end - seconds * rate, end);
    windows[String(seconds)] = { rmsDbfs: db(stat.rms), peakDbfs: db(stat.peak) };
  }
  const previous = rms(values, end - 5 * rate, end - rate);
  const finalQuarter = windows['0.25'];
  const decayDb = Math.round((finalQuarter.rmsDbfs - db(previous.rms)) * 10) / 10;
  const finalSampleDbfs = db(Math.abs(values[end - 1] || 0));
  const lowAtBoundary = finalQuarter.rmsDbfs <= -38 && finalQuarter.peakDbfs <= -24;
  const clearDecay = decayDb <= -12 && finalQuarter.peakDbfs <= -18;
  return {
    sampleRate: rate,
    windows,
    priorFourSecondsRmsDbfs: db(previous.rms),
    finalQuarterDecayDb: decayDb,
    finalSampleDbfs,
    signalVerdict: lowAtBoundary || clearDecay ? 'pass' : 'manual-review',
    signalReason: lowAtBoundary
      ? 'final quarter-second is quiet'
      : clearDecay
        ? 'final quarter-second has a clear decay from the preceding phrase'
        : 'substantial audio remains at the file boundary',
  };
}

async function makeTail(filename, destination) {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-sseof', '-20', '-i', filename,
    '-vn', '-codec:a', 'libmp3lame', '-b:a', '160k', destination,
  ], { capture: true });
}

function normalWords(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function orderedWordCoverage(expected, heard) {
  if (!expected.length) return { matchedWords: 0, expectedWords: 0, heardWords: heard.length, ratio: 1 };
  let previous = new Uint16Array(heard.length + 1);
  for (const expectedWord of expected) {
    const current = new Uint16Array(heard.length + 1);
    for (let index = 1; index <= heard.length; index += 1) {
      current[index] = expectedWord === heard[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous = current;
  }
  const matchedWords = previous[heard.length];
  return {
    matchedWords,
    expectedWords: expected.length,
    heardWords: heard.length,
    ratio: Math.round((matchedWords / expected.length) * 1000) / 1000,
  };
}

function lastContiguousSequence(haystack, needle) {
  if (!needle.length || haystack.length < needle.length) return -1;
  for (let start = haystack.length - needle.length; start >= 0; start -= 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return start;
  }
  return -1;
}

async function requestWhisper(whisper, filename) {
  const form = new FormData();
  const bytes = await fs.readFile(filename);
  form.append('file', new Blob([bytes], { type: 'audio/flac' }), path.basename(filename));
  form.append('response_format', 'verbose_json');
  form.append('language', 'en');
  form.append('temperature', '0.0');
  const response = await fetch(`${String(whisper).replace(/\/+$/, '')}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok || !data) throw new Error(`Whisper transcription failed: HTTP ${response.status} ${text.slice(0, 800)}`);
  return data;
}

async function transcribeInChunks(whisper, filename, duration) {
  // whisper.cpp can classify a whole long song from its instrumental opening
  // and return only [MUSIC], even when later 90-second slices contain clear,
  // accurately recognized vocals. Keep every request inside the window proven
  // by the worker's independent tail verifier, then merge absolute timestamps.
  const chunkSeconds = 90;
  if (duration <= chunkSeconds) {
    const data = await requestWhisper(whisper, filename);
    return {
      data,
      chunks: [{ start: 0, duration, purpose: 'coverage-and-terminal', text: String(data.text || '').trim() }],
    };
  }

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maxmusic-whisper-'));
  const chunks = [];
  const responses = [];
  try {
    for (let start = 0, index = 0; start < duration; start += chunkSeconds, index += 1) {
      const length = Math.min(chunkSeconds, duration - start);
      const chunkPath = path.join(temporary, `chunk-${String(index).padStart(2, '0')}.flac`);
      await run('ffmpeg', [
        '-y', '-v', 'error', '-ss', String(start), '-i', filename,
        '-t', String(length), '-vn', '-codec:a', 'flac', chunkPath,
      ]);
      const response = await requestWhisper(whisper, chunkPath);
      const chunkText = String(response.text || '').trim();
      chunks.push({
        start: Math.round(start * 1000) / 1000,
        duration: Math.round(length * 1000) / 1000,
        purpose: 'coverage',
        text: chunkText,
      });
      responses.push({ start, response });
    }

    // A fixed boundary can split the final sung word: e.g. a 193-second song
    // whose terminal line reaches 180 seconds leaves a context-free 13-second
    // final chunk. Add one tail-aligned window so the complete ending is always
    // presented to Whisper in context. Duplicate overlap is harmless to the
    // ordered-coverage LCS, which can skip repeated words.
    const tailStart = Math.max(0, duration - chunkSeconds);
    const lastStart = Number(chunks.at(-1)?.start || 0);
    if (duration > chunkSeconds && Math.abs(lastStart - tailStart) > 0.001) {
      const chunkPath = path.join(temporary, 'chunk-terminal-tail.flac');
      await run('ffmpeg', [
        '-y', '-v', 'error', '-ss', String(tailStart), '-i', filename,
        '-t', String(chunkSeconds), '-vn', '-codec:a', 'flac', chunkPath,
      ]);
      const response = await requestWhisper(whisper, chunkPath);
      const chunkText = String(response.text || '').trim();
      chunks.push({
        start: Math.round(tailStart * 1000) / 1000,
        duration: Math.round(Math.min(chunkSeconds, duration) * 1000) / 1000,
        purpose: 'terminal-tail',
        text: chunkText,
      });
      responses.push({ start: tailStart, response });
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }

  const segments = responses.flatMap(({ start, response }) => (
    Array.isArray(response.segments) ? response.segments : []
  ).map((segment) => ({
    ...segment,
    start: Number.isFinite(Number(segment.start)) ? Number(segment.start) + start : segment.start,
    end: Number.isFinite(Number(segment.end)) ? Number(segment.end) + start : segment.end,
    words: Array.isArray(segment.words) ? segment.words.map((word) => ({
      ...word,
      start: Number.isFinite(Number(word.start)) ? Number(word.start) + start : word.start,
      end: Number.isFinite(Number(word.end)) ? Number(word.end) + start : word.end,
    })) : segment.words,
  })));
  const first = responses[0]?.response || {};
  return {
    data: {
      ...first,
      duration,
      text: chunks.map((chunk) => chunk.text).filter(Boolean).join('\n'),
      segments,
    },
    chunks,
  };
}

async function transcribe(whisper, filename, duration, lyrics) {
  const { data, chunks } = await transcribeInChunks(whisper, filename, duration);

  const transcriptText = String(data.text || '').trim();
  const recognizedText = transcriptText.replace(/\[[^\]]+\]/g, ' ');
  const expected = normalWords(TERMINAL_LYRIC);
  const heard = normalWords(recognizedText);
  const expectedSong = normalWords(String(lyrics).replace(/^\s*\[[^\]]+\]\s*$/gm, ''));
  const coverage = orderedWordCoverage(expectedSong, heard);
  const startsAt = heard.findIndex((_word, index) => expected.every((word, offset) => heard[index + offset] === word));
  const exactTerminalLyric = startsAt >= 0;
  const terminalWindow = heard.slice(-Math.max(20, expected.length * 2));
  const terminalCoverage = orderedWordCoverage(expected, terminalWindow);
  const terminalTail = expected.slice(-5);
  const heardTail = heard.slice(-terminalTail.length);
  const exactTerminalTail = terminalTail.length === heardTail.length
    && terminalTail.every((word, index) => heardTail[index] === word);
  const terminalComplete = exactTerminalLyric
    || (terminalCoverage.matchedWords >= expected.length - 1 && exactTerminalTail);
  const words = (data.segments || []).flatMap((segment) => Array.isArray(segment.words) ? segment.words : []);
  const timedWords = words.flatMap((word) => {
    if (/^\s*\[[^\]]+\]\s*$/.test(String(word?.word || ''))) return [];
    return normalWords(word?.word).map((normalized) => ({ ...word, normalized }));
  });
  const timedTailStart = lastContiguousSequence(timedWords.map((word) => word.normalized), terminalTail);
  const terminalFinalWord = timedTailStart >= 0
    ? timedWords[timedTailStart + terminalTail.length - 1]
    : null;
  const finalWord = terminalFinalWord || timedWords[timedWords.length - 1] || null;
  const finalWordEnd = Number(finalWord?.end);
  const tailAfterFinalWord = Number.isFinite(finalWordEnd)
    ? Math.round((duration - finalWordEnd) * 1000) / 1000
    : null;
  const averageWordProbability = timedWords.length
    ? Math.round((timedWords.reduce((sum, word) => sum + (Number(word.probability) || 0), 0) / timedWords.length) * 1000) / 1000
    : null;

  return {
    text: transcriptText,
    exactTerminalLyric,
    exactTerminalTail,
    terminalCoverage,
    terminalComplete,
    finalWord: String(finalWord?.word || '').trim() || null,
    finalWordEnd: Number.isFinite(finalWordEnd) ? finalWordEnd : null,
    tailAfterFinalWord,
    averageWordProbability,
    orderedLyricCoverage: coverage,
    verificationChunks: chunks,
    // Whisper word timestamps can extend into a word's reverb/decay and are
    // not precise enough to demand an arbitrary 200 ms of post-word silence.
    // A complete terminal lyric plus non-negative timing proves the word was
    // not clipped; `boundaryAnalysis` independently requires a quiet or
    // clearly decaying waveform at EOF and remains the acoustic hard-cut gate.
    verdict: terminalComplete
      && tailAfterFinalWord !== null
      && tailAfterFinalWord >= 0
      && coverage.ratio >= 0.7
      ? 'pass'
      : 'fail',
  };
}

function sequenceFrom(args) {
  if (args.target) {
    const target = Number(args.target);
    if (!TARGETS.includes(target)) throw new Error('--target must be 30, 60, ..., or 300.');
    return [{ target, direction: String(args.direction || 'pilot') }];
  }
  const sequence = String(args.sequence || 'pilot').toLowerCase();
  let items;
  if (sequence === 'pilot') items = [{ target: 30, direction: 'pilot' }];
  else if (sequence === 'ascending') items = TARGETS.map((target) => ({ target, direction: 'ascending' }));
  else if (sequence === 'descending') items = [...TARGETS].reverse().map((target) => ({ target, direction: 'descending' }));
  else if (sequence === 'full') items = [
    ...TARGETS.map((target) => ({ target, direction: 'ascending' })),
    ...[...TARGETS].reverse().map((target) => ({ target, direction: 'descending' })),
  ];
  else throw new Error('--sequence must be pilot, ascending, descending, or full.');

  if (args.startTarget === undefined) return items;
  const startTarget = Number(args.startTarget);
  if (!TARGETS.includes(startTarget)) throw new Error('--start-target must be 30, 60, ..., or 300.');
  if (!['ascending', 'descending'].includes(sequence)) {
    throw new Error('--start-target can only be used with --sequence ascending or descending.');
  }
  return items.filter(({ target }) => sequence === 'ascending' ? target >= startTarget : target <= startTarget);
}

function seedFor({ target, direction }, override) {
  if (override !== undefined) {
    const seed = Number(override);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('--seed must be a non-negative integer.');
    return seed;
  }
  const base = direction === 'descending' ? 920_000 : direction === 'ascending' ? 910_000 : 900_000;
  return base + target;
}

function seedForAttempt(baseSeed, attempt) {
  const seed = baseSeed + (attempt - 1) * 1_000_000;
  if (!Number.isSafeInteger(seed)) throw new Error('Alternate render seed exceeded JavaScript safe integer range.');
  return seed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const comfy = String(args.comfy || DEFAULT_COMFY).replace(/\/+$/, '');
  const whisper = args.whisper ? String(args.whisper).replace(/\/+$/, '') : null;
  const continueAfterFailure = /^(1|true|yes)$/i.test(String(args.continue || 'false'));
  const planOnly = /^(1|true|yes)$/i.test(String(args.planOnly || 'false'));
  const resume = /^(1|true|yes)$/i.test(String(args.resume || 'false'));
  const maxRenderAttempts = Number(args.maxRenderAttempts || 3);
  if (!Number.isInteger(maxRenderAttempts) || maxRenderAttempts < 1 || maxRenderAttempts > 10) {
    throw new Error('--max-render-attempts must be an integer from 1 through 10.');
  }
  const items = sequenceFrom(args);
  if (args.seed !== undefined && items.length !== 1) throw new Error('--seed can only be used with --target.');

  const runId = String(args.runId || new Date().toISOString().replace(/[:.]/g, '-'));
  const artifactDir = path.resolve(args.output || path.join(ROOT, 'test-artifacts', 'comfy-duration-gate', runId));
  await fs.mkdir(artifactDir, { recursive: true });

  const objectInfo = await fetchJson(`${comfy}/object_info/MiniMaxMusic3TextEncode`);
  if (!objectInfo?.MiniMaxMusic3TextEncode) throw new Error('The target ComfyUI does not expose MiniMaxMusic3TextEncode.');

  const freshReport = {
    runId,
    startedAt: new Date().toISOString(),
    comfy,
    whisper,
    workflow: 'direct ComfyUI; encoder seconds wired to latent canvas',
    planOnly,
    maxRenderAttempts,
    terminalLyric: TERMINAL_LYRIC,
    acceptance: {
      duration: 'soft ballpark target: 8 seconds at 0:30, otherwise max(15 seconds, 10%) of target, capped at 30 seconds',
      ceiling: 'must end at least 0.75 seconds before the generation ceiling',
      waveform: 'the boundary must already be quiet or show a clear decay; clicks, sustained boundary audio, and manual-review are not passes',
      structure: 'Whisper must hear at least 70% of supplied lyric words in order; the terminal lyric may have at most one ASR mismatch but its final five words must be exact and finish before the file boundary',
    },
    attempts: [],
    results: [],
    failedItems: [],
  };
  const reportPath = path.join(artifactDir, 'report.json');
  let report = freshReport;
  if (resume) {
    try {
      const saved = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      if (saved.runId !== runId || saved.comfy !== comfy || Boolean(saved.planOnly) !== planOnly) {
        throw new Error('The saved report belongs to a different run, Comfy endpoint, or mode.');
      }
      report = {
        ...freshReport,
        ...saved,
        maxRenderAttempts,
        attempts: Array.isArray(saved.attempts) ? saved.attempts : [],
        results: Array.isArray(saved.results) ? saved.results : [],
        failedItems: Array.isArray(saved.failedItems) ? saved.failedItems : [],
        resumedAt: new Date().toISOString(),
      };
      delete report.finishedAt;
      delete report.stoppedAfterFailure;
      process.stdout.write(`Resuming ${report.results.length}/${items.length} accepted sequence items from ${reportPath}\n`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const baseSeed = seedFor(item, args.seed);
    const target = item.target;
    const ceiling = args.ceiling !== undefined
      ? Number(args.ceiling)
      : Math.min(360, target + headroomFor(target));
    if (!(ceiling >= target && ceiling <= 360)) throw new Error('--ceiling must be between target and 360 seconds.');

    const savedResult = report.results.find((result) => (
      result.index === index + 1
      && result.direction === item.direction
      && Number(result.target) === target
      && result.accepted === true
    ));
    if (savedResult) {
      process.stdout.write(
        `\n[${index + 1}/${items.length}] ${item.direction} ${clock(target)} · `
        + `reusing accepted seed ${savedResult.seed} (${Number(savedResult.duration).toFixed(3)}s)\n`,
      );
      continue;
    }
    report.failedItems = report.failedItems.filter((failure) => !(
      failure.index === index + 1
      && failure.direction === item.direction
      && Number(failure.target) === target
    ));

    let accepted = null;
    for (let renderAttempt = 1; renderAttempt <= maxRenderAttempts; renderAttempt += 1) {
      const seed = seedForAttempt(baseSeed, renderAttempt);
      const label = `${item.direction}-${String(target).padStart(3, '0')}s-attempt-${renderAttempt}-seed-${seed}`;
      const prefix = `audio/maxmusic-duration-gate/${runId}/${label}`;

      process.stdout.write(
        `\n[${index + 1}/${items.length}] ${item.direction} ${clock(target)} · `
        + `attempt ${renderAttempt}/${maxRenderAttempts} · ceiling ${clock(ceiling)} · seed ${seed}\n`,
      );
      const plan = await planSong(comfy, {
        target,
        ceiling,
        seed,
        initialLyrics: lyricsFor(target),
      });
      if (!plan.pass) {
        const failedPlan = {
          index: index + 1,
          renderAttempt,
          direction: item.direction,
          target,
          ceiling,
          seed,
          plannerAttempts: plan.attempts,
          plannedDuration: plan.plannedSeconds,
          caption: plan.caption,
          lyrics: plan.lyrics,
          lyricWords: countWords(plan.lyrics),
          transcriptVerdict: 'not-rendered',
          musicalEndingVerdict: 'fail',
          mechanicalVerdict: 'planning-failed',
          accepted: false,
        };
        report.attempts.push(failedPlan);
        report.updatedAt = new Date().toISOString();
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write('  rejected: no coherent lyric revision produced an in-tolerance natural plan\n');
        continue;
      }

      const { lyrics, caption } = plan;
      if (planOnly) {
        const plannedResult = {
          index: index + 1,
          renderAttempt,
          direction: item.direction,
          target,
          ceiling,
          seed,
          plannerAttempts: plan.attempts,
          plannedDuration: plan.plannedSeconds,
          caption,
          captionWords: countWords(caption),
          lyrics,
          lyricWords: countWords(lyrics),
          transcriptVerdict: 'not-rendered',
          musicalEndingVerdict: 'not-rendered',
          mechanicalVerdict: 'planning-pass',
          accepted: true,
        };
        report.attempts.push(plannedResult);
        report.results.push(plannedResult);
        accepted = plannedResult;
        report.updatedAt = new Date().toISOString();
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(
          `  planning-only pass: ${plan.plannedSeconds.toFixed(2)}s with `
          + `${plannedResult.lyricWords} lyric words and ${plannedResult.captionWords} caption words\n`,
        );
        break;
      }
      const workflow = makeWorkflow({ caption, lyrics, target, ceiling, seed, prefix });
      const submittedAt = Date.now();
      const queued = await fetchJson(`${comfy}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
        timeoutMs: 60_000,
      });
      if (!queued?.prompt_id) throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(queued)}`);

      const completed = await waitForResult(comfy, queued.prompt_id);
      const extension = path.extname(completed.audio.filename) || '.flac';
      const audioPath = path.join(artifactDir, `${label}${extension}`);
      const tailPath = path.join(artifactDir, `${label}-tail.mp3`);
      await downloadAudio(comfy, completed.audio, audioPath);
      const duration = await mediaDuration(audioPath);
      const boundary = await boundaryAnalysis(audioPath);
      await makeTail(audioPath, tailPath);
      const transcript = whisper ? await transcribe(whisper, audioPath, duration, lyrics) : null;

      const tolerance = toleranceFor(target);
      const ceilingMargin = Math.round((ceiling - duration) * 1000) / 1000;
      const durationError = Math.round((duration - target) * 1000) / 1000;
      const result = {
        index: index + 1,
        renderAttempt,
        direction: item.direction,
        target,
        ceiling,
        seed,
        promptId: queued.prompt_id,
        plannerAttempts: plan.attempts,
        plannedDuration: plan.plannedSeconds,
        caption,
        lyrics,
        lyricWords: countWords(lyrics),
        remoteOutput: completed.audio,
        audioFile: path.basename(audioPath),
        tailFile: path.basename(tailPath),
        duration: Math.round(duration * 1000) / 1000,
        durationError,
        durationTolerance: tolerance,
        durationPass: Math.abs(durationError) <= tolerance,
        planMatchPass: Math.abs(duration - plan.plannedSeconds) <= 0.1,
        ceilingMargin,
        ceilingPass: ceilingMargin > 0.75,
        boundary,
        transcript,
        transcriptVerdict: transcript?.verdict || 'pending',
        musicalEndingVerdict: 'pending',
        elapsedSeconds: Math.round((Date.now() - submittedAt) / 100) / 10,
      };
      const objectivePass = result.durationPass
        && result.planMatchPass
        && result.ceilingPass
        && boundary.signalVerdict === 'pass'
        && transcript?.verdict === 'pass';
      result.musicalEndingVerdict = objectivePass ? 'pass' : transcript ? 'fail' : 'pending';
      result.mechanicalVerdict = objectivePass ? 'pass' : 'fail-or-manual-review';
      result.accepted = objectivePass;
      report.attempts.push(result);
      report.updatedAt = new Date().toISOString();
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      process.stdout.write(
        `  delivered ${duration.toFixed(3)}s (${durationError >= 0 ? '+' : ''}${durationError.toFixed(3)}s) · `
        + `ceiling margin ${ceilingMargin.toFixed(3)}s · signal ${boundary.signalVerdict} · `
        + `lyrics ${transcript?.orderedLyricCoverage?.ratio ?? 'pending'} · terminal ${transcript?.terminalComplete ? 'pass' : 'fail'}\n`,
      );
      process.stdout.write(`  saved ${audioPath}\n  tail  ${tailPath}\n`);
      if (objectivePass) {
        accepted = result;
        report.results.push(result);
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        break;
      }
      process.stdout.write('  rejected: objective ending gate failed; preserving artifacts and trying an alternate seed\n');
    }

    if (!accepted) {
      const failedItem = {
        index: index + 1,
        direction: item.direction,
        target,
        attempts: maxRenderAttempts,
      };
      report.failedItems.push(failedItem);
      report.stoppedAfterFailure = failedItem;
      report.updatedAt = new Date().toISOString();
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`  sequence item failed after ${maxRenderAttempts} alternate-seed attempts\n`);
      if (!continueAfterFailure) break;
    }
  }

  report.summary = {
    requestedItems: items.length,
    acceptedItems: report.results.length,
    rejectedAttempts: report.attempts.filter((attempt) => !attempt.accepted).length,
    planningPass: planOnly && report.results.length === items.length && report.failedItems.length === 0,
    sequencePass: !planOnly && report.results.length === items.length && report.failedItems.length === 0,
  };
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nReport: ${reportPath}\n`);
  process.stdout.write(planOnly
    ? 'Planning-only output is diagnostic and does not count as a musical-ending pass.\n'
    : whisper
    ? 'Results pass only when duration, ceiling margin, waveform decay, and the complete terminal lyric all pass.\n'
    : 'No result is a final pass until transcript and musical-ending verdicts are recorded. Re-run with --whisper URL.\n');
}

export {
  TERMINAL_LYRIC,
  boundaryAnalysis,
  makeTail,
  mediaDuration,
  normalWords,
  toleranceFor,
  transcribe,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nComfy duration gate failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
