#!/usr/bin/env node
/**
 * Sequential MaxMusic release gate.
 *
 * Replays the independently accepted ComfyUI fixtures through MaxMusic in the
 * exact order required for release: 0:30 -> 5:00, then 5:00 -> 0:30. Each
 * child run saves untouched audio, a tail clip, waveform evidence, Whisper
 * lyric coverage, and its own A/B report. This runner writes a cumulative
 * report after every song so an interruption can resume without losing proof.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASCENDING = Object.freeze([30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);
const DESCENDING = Object.freeze([...ASCENDING].reverse());

const ASCENDING_SOURCES = Object.freeze({
  30: 'comfy-ascending-v2-20260816/report.json',
  60: 'comfy-ascending-v2-20260816/report.json',
  90: 'comfy-090-accepted-20260816/report.json',
  120: 'comfy-120-retry1-20260816/report.json',
  150: 'comfy-150-accepted-20260816/report.json',
  180: 'comfy-ascending-180-to-300-v4-20260816/report.json',
  210: 'comfy-ascending-180-to-300-v4-20260816/report.json',
  240: 'comfy-ascending-180-to-300-v4-20260816/report.json',
  270: 'comfy-270-accepted-v1-20260816/report.json',
  300: 'comfy-300-accepted-v1-20260816/report.json',
});
const DESCENDING_SOURCE = 'comfy-descending-official-v1-20260816/report.json';

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

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function exists(filename) {
  try { await fs.access(filename); return true; } catch { return false; }
}

function reportAccepted(report) {
  return report?.comparison?.verdict === 'pass'
    && report?.livePipeline?.pipelineParityPass === true
    && report?.maxmusic?.semanticPlanPass === true
    && report?.maxmusic?.workerEndingPass === true
    && report?.maxmusic?.endingPass === true;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`child verifier stopped by ${signal}`));
      else resolve(Number(code || 0));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const maxmusic = String(args.maxmusic || 'http://127.0.0.1:3024').replace(/\/+$/, '');
  const whisper = String(args.whisper || '').replace(/\/+$/, '');
  if (!whisper) throw new Error('--whisper is required.');

  const phase = String(args.phase || 'full').toLowerCase();
  if (!['ascending', 'descending', 'full'].includes(phase)) {
    throw new Error('--phase must be ascending, descending, or full.');
  }
  const resume = truthy(args.resume ?? 'true');
  const runId = String(args.runId || `maxmusic-release-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const output = path.resolve(args.output || path.join(ROOT, 'test-artifacts', 'maxmusic-release-gate', runId));
  const sourceReportOverride = args.sourceReport ? path.resolve(args.sourceReport) : null;
  const cumulativePath = path.join(output, 'report.json');
  await fs.mkdir(output, { recursive: true });

  const jobs = [];
  if (phase !== 'descending') {
    for (const target of ASCENDING) {
      jobs.push({ direction: 'ascending', target, source: ASCENDING_SOURCES[target] });
    }
  }
  if (phase !== 'ascending') {
    for (const target of DESCENDING) {
      jobs.push({ direction: 'descending', target, source: DESCENDING_SOURCE });
    }
  }

  const cumulative = {
    runId,
    createdAt: new Date().toISOString(),
    maxmusic,
    requiredOrder: jobs.map(({ direction, target }) => ({ direction, target })),
    results: [],
    completed: 0,
    required: jobs.length,
    sequencePass: false,
  };

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const label = `${job.direction}-${String(job.target).padStart(3, '0')}`;
    const artifactDir = path.join(output, label);
    const childReportPath = path.join(artifactDir, 'report.json');
    const sourceReport = sourceReportOverride
      || path.join(ROOT, 'test-artifacts', 'comfy-duration-gate', job.source);

    process.stdout.write(
      `\n[release gate ${index + 1}/${jobs.length}] ${job.direction} ${clock(job.target)}\n`,
    );

    let child = null;
    if (resume && await exists(childReportPath)) {
      child = JSON.parse(await fs.readFile(childReportPath, 'utf8'));
      if (reportAccepted(child)) {
        process.stdout.write(`  reusing certified saved report ${childReportPath}\n`);
      } else {
        process.stdout.write(`  saved report predates or fails the current parity gate; rerendering\n`);
        child = null;
      }
    }

    if (!child) {
      await fs.mkdir(artifactDir, { recursive: true });
      const code = await run(process.execPath, [
        path.join(ROOT, 'scripts', 'maxmusic-ab-gate.mjs'),
        '--source-report', sourceReport,
        '--source-direction', job.direction,
        '--target', String(job.target),
        '--maxmusic', maxmusic,
        '--whisper', whisper,
        '--run-id', `${runId}-${label}`,
        '--output', artifactDir,
      ]);
      if (code !== 0) {
        cumulative.failedAt = { index: index + 1, ...job, exitCode: code };
        cumulative.updatedAt = new Date().toISOString();
        await fs.writeFile(cumulativePath, `${JSON.stringify(cumulative, null, 2)}\n`);
        throw new Error(`${label} failed with exit code ${code}; sequence stopped for diagnosis.`);
      }
      child = JSON.parse(await fs.readFile(childReportPath, 'utf8'));
    }

    const accepted = reportAccepted(child);
    const result = {
      index: index + 1,
      direction: job.direction,
      target: job.target,
      sourceReport,
      report: childReportPath,
      sourceSeed: child.source?.seed,
      sourceDuration: child.source?.duration,
      duration: child.maxmusic?.duration,
      durationError: child.maxmusic?.durationError,
      durationTolerance: child.maxmusic?.durationTolerance,
      endReason: child.maxmusic?.durationEndReason,
      pipelineVersion: child.livePipeline?.worker?.pipelineVersion,
      pipelineParityPass: child.livePipeline?.pipelineParityPass,
      semanticPlanPass: child.maxmusic?.semanticPlanPass,
      workerLyricPass: child.maxmusic?.workerLyricPass,
      workerLyricVerdict: child.maxmusic?.workerLyricCompletion?.verdict,
      workerEndingPass: child.maxmusic?.workerEndingPass,
      endingAction: child.maxmusic?.workerEndingGuard?.action,
      planAttempts: child.maxmusic?.response?.generationAttempts,
      ceilingMargin: child.maxmusic?.ceilingMargin,
      boundary: child.maxmusic?.boundary?.signalVerdict,
      lyricCoverage: child.maxmusic?.transcript?.orderedLyricCoverage?.ratio,
      terminalComplete: child.maxmusic?.transcript?.terminalComplete,
      endingPass: child.maxmusic?.endingPass,
      accepted,
    };
    cumulative.results.push(result);
    cumulative.completed = cumulative.results.length;
    cumulative.updatedAt = new Date().toISOString();
    cumulative.sequencePass = cumulative.completed === jobs.length
      && cumulative.results.every((entry) => entry.accepted);
    await fs.writeFile(cumulativePath, `${JSON.stringify(cumulative, null, 2)}\n`);

    if (!accepted) {
      cumulative.failedAt = { index: index + 1, ...job, reason: 'saved report did not satisfy every gate' };
      await fs.writeFile(cumulativePath, `${JSON.stringify(cumulative, null, 2)}\n`);
      throw new Error(`${label} did not satisfy complete-ending acceptance.`);
    }
  }

  process.stdout.write(
    `\nRelease gate passed ${cumulative.completed}/${cumulative.required} sequential renders.\n`
    + `Report: ${cumulativePath}\n`,
  );
}

main().catch((error) => {
  console.error(`\nMaxMusic release gate failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
