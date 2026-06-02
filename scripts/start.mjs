/**
 * Start maxmusic unless it is already listening on PORT.
 * Exits 0 when an instance is already healthy (avoids EADDRINUSE on repeat runs).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function portOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function healthOk() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve(res.statusCode === 200 && body.includes('api.minimax.io'));
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const busy = await portOpen();
if (busy) {
  if (await healthOk()) {
    console.log(`\n  maxmusic already running → http://localhost:${PORT}\n`);
    process.exit(0);
  }
  console.error(`\n  Port ${PORT} is in use by another process. Run:\n    npm run stop\n  or:\n    PORT=${PORT + 1} npm start\n`);
  process.exit(1);
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});