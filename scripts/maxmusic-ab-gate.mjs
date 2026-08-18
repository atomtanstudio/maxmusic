#!/usr/bin/env node
/**
 * Replay one accepted direct-Comfy fixture through the live MaxMusic API.
 *
 * This intentionally sends the accepted caption, lyrics, seed, and requested
 * duration unchanged. Any transformation after that point belongs to the
 * MaxMusic HTTP/backend/worker pipeline and is part of the A/B comparison.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boundaryAnalysis,
  makeTail,
  mediaDuration,
  toleranceFor,
  transcribe,
} from './comfy-duration-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const value = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true');
    out[rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return out;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function fetchText(url, options = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs || 60 * 60 * 1000;
  const payload = options.body == null ? null : String(options.body);
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        resolve({
          response: {
            ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
            status: Number(response.statusCode) || 0,
          },
          text,
          body,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sourceReport) throw new Error('--source-report is required.');
  const target = Number(args.target);
  if (!(target > 0)) throw new Error('--target must be a positive number of seconds.');

  const maxmusic = String(args.maxmusic || 'http://127.0.0.1:3024').replace(/\/+$/, '');
  const whisper = args.whisper ? String(args.whisper).replace(/\/+$/, '') : null;
  if (!whisper) throw new Error('--whisper is required for the lyric-ending comparison.');

  const sourcePath = path.resolve(args.sourceReport);
  const sourceReport = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  const sourceDirection = String(args.sourceDirection || '').toLowerCase();
  if (sourceDirection && !['ascending', 'descending'].includes(sourceDirection)) {
    throw new Error('--source-direction must be ascending or descending.');
  }
  const source = sourceReport.results?.find((result) => (
    Number(result.target) === target
    && result.accepted !== false
    && (!sourceDirection || result.direction === sourceDirection)
  ));
  if (!source) {
    throw new Error(
      `No accepted ${sourceDirection ? `${sourceDirection} ` : ''}${target}s fixture exists in ${sourcePath}.`,
    );
  }

  const runId = String(args.runId || `maxmusic-ab-${target}s-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const artifactDir = path.resolve(args.output || path.join(ROOT, 'test-artifacts', 'maxmusic-ab-gate', runId));
  await fs.mkdir(artifactDir, { recursive: true });

  const request = {
    prompt: String(source.caption),
    lyrics: String(source.lyrics),
    duration: target,
    seed: Number(source.seed),
    is_instrumental: false,
    title: `A/B ending gate ${Math.floor(target / 60)}:${String(target % 60).padStart(2, '0')}`,
    idea: 'Direct ComfyUI versus MaxMusic ending-pipeline acceptance fixture',
    audio_setting: { format: 'flac' },
  };

  const health = await fetchText(`${maxmusic}/api/health`, { timeoutMs: 15_000 });
  if (!health.response.ok || health.body?.ok !== true) {
    throw new Error(`MaxMusic health check failed: HTTP ${health.response.status} ${health.text.slice(0, 500)}`);
  }
  const workerHealth = health.body?.worker || {};
  const pipelineParityPass = workerHealth.runtime === 'comfy'
    && workerHealth.comfyRuntimePlanParity === true
    && workerHealth.semanticPreflight === true
    && workerHealth.comfySeedDerivation === true
    && workerHealth.naturalEndToken === true
    && workerHealth.terminalOutroGuard === true
    && workerHealth.acousticEndingGuard === true
    && workerHealth.lyricCompletionGuard === true
    && workerHealth.lyricVerifier?.fullTrackCoverage === true
    && workerHealth.minimumDurationControl === false
    && /^music3-comfy-soft-duration-v\d+$/.test(String(workerHealth.pipelineVersion || ''));
  if (!pipelineParityPass) {
    throw new Error(
      `The live worker does not expose the certified natural-ending pipeline: ${JSON.stringify(workerHealth)}`,
    );
  }

  process.stdout.write(
    `Replaying accepted ${target}s Comfy fixture through ${maxmusic}\n`
    + `seed ${request.seed} · caption ${request.prompt.length} chars · lyrics ${request.lyrics.length} chars\n`,
  );
  const startedAt = Date.now();
  const generated = await fetchText(`${maxmusic}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!generated.response.ok || !generated.body?.track?.url) {
    throw new Error(
      `MaxMusic generation failed: HTTP ${generated.response.status} `
      + `${generated.body?.error || generated.text.slice(0, 1000)}`,
    );
  }

  const trackUrl = new URL(generated.body.track.url, `${maxmusic}/`);
  const trackResponse = await fetch(trackUrl, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!trackResponse.ok) throw new Error(`Could not download MaxMusic track: HTTP ${trackResponse.status}`);
  const audioPath = path.join(artifactDir, `maxmusic-${target}s-seed-${request.seed}.flac`);
  const tailPath = path.join(artifactDir, `maxmusic-${target}s-seed-${request.seed}-tail.mp3`);
  await fs.writeFile(audioPath, Buffer.from(await trackResponse.arrayBuffer()));

  const duration = await mediaDuration(audioPath);
  const boundary = await boundaryAnalysis(audioPath);
  await makeTail(audioPath, tailPath);
  const transcript = await transcribe(whisper, audioPath, duration, request.lyrics);
  const tolerance = toleranceFor(target);
  const ceiling = Number(
    generated.body.generationCeiling
    || generated.body.extra_info?.generation_ceiling_seconds
    || 0,
  );
  const endReason = String(
    generated.body.durationEndReason
    || generated.body.extra_info?.duration_end_reason
    || '',
  );
  const ceilingMargin = ceiling > 0 ? Math.round((ceiling - duration) * 1000) / 1000 : null;
  const durationError = Math.round((duration - target) * 1000) / 1000;
  const durationPass = Math.abs(durationError) <= tolerance;
  // Frame distance is not an ending signal. The AR model emitted an explicit
  // EOS whenever `endReason` is `eos`, even if that token landed in the final
  // few frames. The independent lyric and waveform guards decide whether the
  // decoded result is actually complete and safe.
  const ceilingPass = endReason === 'eos';
  const planCandidates = Array.isArray(generated.body.planCandidates) ? generated.body.planCandidates : [];
  const acceptedPlans = planCandidates.filter((candidate) => candidate?.accepted === true);
  const acceptedPlan = acceptedPlans[0] || null;
  const selectedSeed = Number(generated.body.generationSeed ?? generated.body.extra_info?.generation_seed);
  const plannedSeconds = Number(
    generated.body.plannedSeconds ?? generated.body.extra_info?.planned_duration_seconds,
  );
  const semanticPlanPass = acceptedPlans.length === 1
    && acceptedPlan?.endReason === 'eos'
    && Number(acceptedPlan?.seed) === selectedSeed
    && Number.isFinite(plannedSeconds)
    && Number(acceptedPlan?.maxFrames) > Number(acceptedPlan?.frames)
    && String(acceptedPlan?.samplingSeed || '').length > 0;
  const workerEndingGuard = generated.body.endingGuard || null;
  const workerLyricCompletion = generated.body.lyricCompletion || null;
  const workerLyricPass = generated.body.lyricCompletionGuard === true
    && generated.body.lyricCompletionPass === true
    && ['pass', 'not-applicable'].includes(String(workerLyricCompletion?.verdict || ''));
  const workerEndingPass = generated.body.terminalOutroGuard === true
    && generated.body.acousticEndingPass === true
    && workerEndingGuard?.after?.signalVerdict === 'pass'
    && workerLyricPass;
  const endingPass = pipelineParityPass
    && semanticPlanPass
    && workerEndingPass
    && ceilingPass
    && boundary.signalVerdict === 'pass'
    && transcript.verdict === 'pass';

  const report = {
    runId,
    createdAt: new Date().toISOString(),
    source: {
      report: sourcePath,
      runId: sourceReport.runId,
      direction: source.direction || sourceDirection || null,
      target: source.target,
      seed: source.seed,
      duration: source.duration,
      durationEndReason: 'natural encoder plan',
      ceilingMargin: source.ceilingMargin,
      boundary: source.boundary,
      transcript: source.transcript,
    },
    inputIdentity: {
      target,
      seed: request.seed,
      captionCharacters: request.prompt.length,
      lyricCharacters: request.lyrics.length,
      captionSha256: digest(request.prompt),
      lyricsSha256: digest(request.lyrics),
    },
    request,
    livePipeline: {
      backend: health.body?.backend || null,
      worker: workerHealth,
      pipelineParityPass,
    },
    maxmusic: {
      url: maxmusic,
      response: generated.body,
      audioFile: path.basename(audioPath),
      tailFile: path.basename(tailPath),
      duration: Math.round(duration * 1000) / 1000,
      durationError,
      durationTolerance: tolerance,
      durationPass,
      generationCeiling: ceiling || null,
      ceilingMargin,
      durationEndReason: endReason || null,
      ceilingPass,
      semanticPlanPass,
      workerEndingGuard,
      workerLyricCompletion,
      workerLyricPass,
      workerEndingPass,
      acceptedPlan,
      planCandidates,
      boundary,
      transcript,
      endingPass,
      elapsedSeconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
    },
    comparison: {
      durationDeltaSeconds: Math.round((duration - Number(source.duration)) * 1000) / 1000,
      sourceEndingPass: source.boundary?.signalVerdict === 'pass' && source.transcript?.verdict === 'pass',
      maxmusicEndingPass: endingPass,
      verdict: endingPass ? 'pass' : 'pipeline-divergence',
    },
  };
  const reportPath = path.join(artifactDir, 'report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    `MaxMusic delivered ${duration.toFixed(3)}s (${durationError >= 0 ? '+' : ''}${durationError.toFixed(3)}s) · `
    + `end ${endReason || 'unknown'} · margin ${ceilingMargin ?? 'unknown'}s · `
    + `lyrics ${transcript.orderedLyricCoverage.ratio} · terminal ${transcript.terminalComplete ? 'pass' : 'fail'} · `
    + `boundary ${boundary.signalVerdict}\nReport: ${reportPath}\n`,
  );
  if (!endingPass) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`\nMaxMusic A/B gate failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
