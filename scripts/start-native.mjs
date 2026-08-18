#!/usr/bin/env node

/**
 * Start the no-Docker app and, when available, its local model worker.
 *
 * Environment variables are intentionally ordinary strings so this launcher
 * can be called from PowerShell, cmd.exe, bash, zsh, or a desktop shortcut.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Let the copy-and-run package pick up local configuration without asking
// people to translate shell syntax between bash, PowerShell, cmd.exe, and
// desktop shortcuts. Explicit environment variables still win because
// Node's loader does not overwrite values that are already present.
if (typeof process.loadEnvFile === 'function') {
  for (const filename of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path.join(ROOT, filename));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[native] Could not load ${filename}: ${error.message}`);
      }
    }
  }
}

const data = path.resolve(process.env.MAXMUSIC_DATA || path.join(ROOT, 'data'));
const venv = path.resolve(process.env.MAXMUSIC_VENV || path.join(ROOT, '.maxmusic-venv'));
const python = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
const port = String(process.env.PORT || process.env.MAXMUSIC_PORT || '3020');
const workerPort = String(process.env.MAXMUSIC_WORKER_PORT || '3011');
const startWorker = process.env.MAXMUSIC_START_WORKER !== '0';

fs.mkdirSync(path.join(data, 'tracks'), { recursive: true });
fs.mkdirSync(path.join(data, 'videos'), { recursive: true });
fs.mkdirSync(path.join(data, 'video-jobs'), { recursive: true });
fs.mkdirSync(path.join(data, 'models'), { recursive: true });
fs.mkdirSync(path.join(data, 'huggingface'), { recursive: true });

const env = {
  ...process.env,
  PORT: port,
  HOST: process.env.HOST || '127.0.0.1',
  WORKER_URL: process.env.WORKER_URL || `http://127.0.0.1:${workerPort}`,
  MAXMUSIC_DB: process.env.MAXMUSIC_DB || path.join(data, 'maxmusic.sqlite'),
  MAXMUSIC_DATA: data,
  MAXMUSIC_TRACKS: process.env.MAXMUSIC_TRACKS || path.join(data, 'tracks'),
  // The video renderer reuses the same faster-whisper installation instead
  // of requiring a separate whisper-cli package.
  MAXMUSIC_PYTHON: process.env.MAXMUSIC_PYTHON || python,
  HF_HOME: process.env.HF_HOME || path.join(data, 'huggingface'),
  // Existing/legacy launches keep their CUDA default. The native path asks
  // the worker to choose CUDA, Apple MPS, or CPU when the backend supports it.
  MAXMUSIC_DEVICE: process.env.MAXMUSIC_DEVICE || 'auto',
  MAXMUSIC_WORKER_PORT: workerPort,
};

const children = [];
let shuttingDown = false;

function stop(child) {
  if (child && !child.killed) child.kill('SIGTERM');
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stop(child);
  setTimeout(() => process.exit(code), 250);
}

if (startWorker) {
  if (fs.existsSync(python)) {
    const worker = spawn(python, ['worker/minimax_worker.py', '--host', '127.0.0.1', '--port', workerPort], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      windowsHide: false,
    });
    children.push(worker);
    worker.once('exit', (code, signal) => {
      if (!shuttingDown) console.error(`[native] model worker stopped${signal ? ` (${signal})` : ` with code ${code}`}. The UI will remain available.`);
    });
  } else {
    console.error(`[native] Python environment not found at ${python}. Run: node scripts/setup-native.mjs`);
    console.error('[native] Starting the UI anyway; set MAXMUSIC_START_WORKER=0 when using a worker on another machine.');
  }
} else {
  console.log(`[native] local worker disabled; using ${env.WORKER_URL}`);
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
children.push(server);
server.once('exit', (code, signal) => {
  if (shuttingDown) return;
  console.error(`[native] app stopped${signal ? ` (${signal})` : ` with code ${code}`}.`);
  shutdown(typeof code === 'number' ? code : 1);
});

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

console.log(`\n[native] MaxMusic → http://localhost:${port}`);
console.log(`[native] library   → ${env.MAXMUSIC_DB}`);
console.log(`[native] tracks    → ${env.MAXMUSIC_TRACKS}`);
