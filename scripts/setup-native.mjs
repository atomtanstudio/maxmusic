#!/usr/bin/env node

/**
 * Prepare the dependency environment for the no-Docker distribution.
 *
 * The script intentionally uses only Node's standard library and direct child
 * processes. There is no npm installer to bootstrap and no shell syntax that
 * behaves differently between Windows, macOS, and Linux.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipTorch = args.has('--skip-torch');
const venv = path.resolve(process.env.MAXMUSIC_VENV || path.join(ROOT, '.maxmusic-venv'));
const data = path.resolve(process.env.MAXMUSIC_DATA || path.join(ROOT, 'data'));

function fail(message) {
  console.error(`\n[native setup] ${message}`);
  process.exit(1);
}

function run(command, commandArgs, label) {
  console.log(`[native setup] ${label}`);
  console.log(`               ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return true;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error || result.status !== 0) {
    fail(`${label} failed${result.error ? `: ${result.error.message}` : '.'}`);
  }
  return true;
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return result.status === 0 ? `${result.stdout || ''}\n${result.stderr || ''}` : '';
}

function versionOf(text) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function atLeast(version, major, minor) {
  return version && (version[0] > major || (version[0] === major && version[1] >= minor));
}

function findPython() {
  const configured = process.env.MAXMUSIC_PYTHON;
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

  for (const candidate of candidates) {
    const output = capture(candidate.command, [...candidate.args, '--version']);
    const version = versionOf(output);
    if (atLeast(version, 3, 10)) return candidate;
    if (version) console.warn(`[native setup] ignoring ${candidate.command}: Python ${version.join('.')} is older than 3.10.`);
  }
  return null;
}

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return Boolean(capture(probe, [command]));
}

function browserExists() {
  if (process.env.MAXMUSIC_BROWSER && fs.existsSync(path.resolve(process.env.MAXMUSIC_BROWSER))) return true;
  if (process.platform === 'darwin') {
    return [
      '/Applications/ego lite.app/Contents/MacOS/ego lite',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ].some((candidate) => fs.existsSync(candidate));
  }
  if (process.platform === 'linux' && [
    '/opt/brave.com/brave/brave',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ].some((candidate) => fs.existsSync(candidate))) return true;
  const commands = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'brave.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  return commands.some(commandExists);
}

const nodeVersion = versionOf(process.version);
const sqliteSupported = nodeVersion && (
  nodeVersion[0] >= 24
  || (nodeVersion[0] === 23 && nodeVersion[1] >= 4)
  || (nodeVersion[0] === 22 && nodeVersion[1] >= 13)
);
if (!sqliteSupported) {
  fail('The native package needs Node 22.13+ (Node 24+ is recommended) for built-in SQLite.');
}

const python = findPython();
if (!python) fail('Python 3.10+ was not found. Set MAXMUSIC_PYTHON to its executable and run this again.');
if (!commandExists('ffmpeg')) {
  console.warn('[native setup] ffmpeg was not found. Music generation can still prepare, but video/export features need ffmpeg.');
}
if (!browserExists()) {
  console.warn('[native setup] No Chromium-family browser was found. Songs still work, but videos need Chrome, Chromium, Edge, Brave, or Ego Lite. You can also set MAXMUSIC_BROWSER to an executable.');
}

const pythonExe = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
const pipExe = process.platform === 'win32' ? path.join(venv, 'Scripts', 'pip.exe') : path.join(venv, 'bin', 'pip');

console.log(`[native setup] project: ${ROOT}`);
console.log(`[native setup] Python:  ${python.command} ${python.args.join(' ')}`);
console.log(`[native setup] venv:    ${venv}`);
console.log(`[native setup] data:    ${data}`);

if (!fs.existsSync(pythonExe)) run(python.command, [...python.args, '-m', 'venv', venv], 'creating the private Python environment');

if (!skipTorch) {
  const torchIndex = process.env.MAXMUSIC_TORCH_INDEX_URL
    || (process.platform === 'darwin' ? '' : 'https://download.pytorch.org/whl/cu128');
  const torchArgs = ['install', 'torch'];
  if (torchIndex) torchArgs.push('--index-url', torchIndex);
  run(pipExe, torchArgs, torchIndex
    ? `installing PyTorch from ${torchIndex}`
    : 'installing PyTorch from PyPI');
} else {
  console.log('[native setup] skipping PyTorch (--skip-torch was supplied).');
}

run(pipExe, ['install', '-r', path.join(ROOT, 'worker', 'requirements.txt')], 'installing the MiniMax worker requirements');

// Lyric timing runs on CTranslate2, which loads cuBLAS and cuDNN at run time
// rather than declaring them. Without these an NVIDIA machine reports a device,
// picks the GPU, and then fails partway through a video with
// `libcublas.so.12 is not found` — or, once that is handled, quietly does the
// slowest step of every lyric video on the CPU. Only fetch them where there is
// a card to use them.
if (process.platform !== 'darwin' && commandExists('nvidia-smi')) {
  // Not through run(): a machine without these still works, just slowly, and
  // that is not a reason to abandon the whole installation.
  console.log('[native setup] installing the CUDA runtime for GPU lyric timing');
  const cuda = dryRun ? { status: 0 } : spawnSync(
    pipExe,
    ['install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'],
    { cwd: ROOT, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' }, stdio: 'inherit' },
  );
  if (cuda.error || cuda.status !== 0) {
    console.warn('[native setup] Could not install the CUDA runtime libraries.');
    console.warn('[native setup] Lyric timing will use the CPU, which is several times slower.');
  }
}

if (!dryRun) {
  fs.mkdirSync(path.join(data, 'tracks'), { recursive: true });
  fs.mkdirSync(path.join(data, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(data, 'video-jobs'), { recursive: true });
  fs.mkdirSync(path.join(data, 'models'), { recursive: true });
  fs.mkdirSync(path.join(data, 'huggingface'), { recursive: true });
}

console.log('\n[native setup] ready. Start MaxMusic with:');
console.log('               node scripts/start-native.mjs');
console.log('\n[native setup] The first worker start downloads the model weights. They stay in the data directory and are not copied into Git.');
