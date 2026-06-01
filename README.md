# maxmusic

Personal/open-source AI music studio built on the [MiniMax Music API](https://platform.minimax.io/docs/api-reference/music-generation). Evolved from an earlier prototype in `music-studio` (Mavis workspace).

## Features

- **Create** — vocal songs, instrumentals, auto-lyrics, dual A/B output, optional streaming
- **Covers** — quick one-step or advanced preprocess → edit lyrics → generate
- **Lyrics** — write full song or edit/continue, send to Create
- **Library** — local history, search, export/import JSON
- **Cover art** — MiniMax `image-01` via `/api/cover-art`
- **Settings** — API key in browser + optional server `MINIMAX_API_KEY`

## Quick start

```bash
cd maxmusic
npm install

# Optional server-wide key
export MINIMAX_API_KEY=sk-your-key

npm start
```

If you see “port already in use”, the app may already be running, or run `npm run stop` then `npm start` again.

Open http://localhost:3000 — paste your key under **Settings** if you did not set the env var.

## Why a Node server?

Cover mode needs a **public URL** for reference audio. This app proxies MiniMax and hosts uploads under `/uploads/`. GitHub Pages alone cannot run that proxy; deploy to any Node host (Fly, Railway, VPS) or run locally.

## API routes

| Path | Purpose |
|------|---------|
| `POST /api/generate` | Text-to-music |
| `POST /api/generate-dual` | Two parallel generations |
| `POST /api/generate-stream` | SSE stream proxy |
| `POST /api/cover` | Multipart cover |
| `POST /api/cover-preprocess` | Two-step cover lyrics |
| `POST /api/lyrics` | Lyrics generation |
| `POST /api/cover-art` | Album art (`image-01`) |

## Deploy from GitHub

### CI

Every push/PR runs [.github/workflows/ci.yml](.github/workflows/ci.yml) — `npm ci`, starts the server, hits `/api/health`.

### Render (recommended)

1. Push this repo to GitHub.
2. [Render](https://render.com) → **New Blueprint** → connect the repo (`render.yaml` is included).
3. Set `MINIMAX_API_KEY` in the dashboard.

### Docker

```bash
docker build -t maxmusic .
docker run -p 3000:3000 -e MINIMAX_API_KEY=sk-… maxmusic
```

### Local only

```bash
npm start
```

GitHub Pages cannot host the API proxy; use Render, Fly, Railway, or run locally.

## License

MIT