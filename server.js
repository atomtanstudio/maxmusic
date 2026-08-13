// MaxMusic — redesigned front end.
// Serves public/ and proxies the API to the existing maxmusic backend, which owns
// the ComfyUI (MiniMax Music 3) and local OpenAI wiring. Nothing here talks to
// ComfyUI directly, so the backend repo stays untouched.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3020);
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 3010);

const PROXY_PREFIXES = ['/api', '/uploads', '/covers', '/tracks'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.map': 'application/json; charset=utf-8',
};

/** Pipe a request straight through to the backend, preserving streaming. */
function proxy(req, res) {
  const upstream = http.request(
    {
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'Backend unreachable',
        detail: `${err.code || err.message} — expected the maxmusic backend on ${BACKEND_HOST}:${BACKEND_PORT}`,
      })
    );
  });

  req.pipe(upstream);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const root = path.join(__dirname, 'public');
  const filePath = path.normalize(path.join(root, pathname));

  // Never serve outside public/
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-style fallback so client routes deep-link cleanly.
      const fallback = path.join(root, 'index.html');
      return fs.readFile(fallback, (e, buf) => {
        if (e) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(buf);
      });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'content-length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const isProxied = PROXY_PREFIXES.some(
    (p) => req.url === p || req.url.startsWith(p + '/') || req.url.startsWith(p + '?')
  );
  if (isProxied) return proxy(req, res);
  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is in use. Try: PORT=${PORT + 1} node server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  MaxMusic → http://localhost:${PORT}`);
  console.log(`  API proxied to ${BACKEND_HOST}:${BACKEND_PORT}\n`);
});
