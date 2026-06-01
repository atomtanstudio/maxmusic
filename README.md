# maxmusic

Open-source AI music studio using the [MiniMax Music API](https://platform.minimax.io/docs/api-reference/music-generation). Create songs, covers, lyrics, dual A/B takes, cover art, and lyric videos — from your browser via a small Node proxy.

## Free vs paid models

In **Advanced → Model**, choose:

- **`music-2.6-free`** — no API charge while MiniMax offers the free tier (good for trying the app).
- **`music-2.6`** — paid generation when you want higher limits or paid-only features.

You still need a MiniMax API key for both; “free” refers to **usage billing on their side**, not “no key required.”

## Security & API keys

**No API key is included in this repo.** Never commit `sk-…` keys, `.env`, or generated tracks.

| Where | What happens |
|--------|----------------|
| **Settings (browser)** | Key saved in `localStorage` on your device only, sent as `X-Api-Key` to your server |
| **Server env** | Optional `MINIMAX_API_KEY` for solo/local use — set in Render/Fly **secrets**, not in git |
| **GitHub** | Hosts source only; CI runs `npm run security:check` to block accidental key commits |

See [SECURITY.md](SECURITY.md) for deployment guidance. On a **public** host, omit `MINIMAX_API_KEY` on the server so each user supplies their own key in Settings.

```bash
npm run security:check   # run before every push
```

## Quick start (local)

```bash
git clone https://github.com/atomtanstudio/maxmusic.git
cd maxmusic
npm install
cp .env.example .env   # optional — edit locally, never commit .env
npm start
```

Open http://localhost:3001 → **Settings** → paste your [MiniMax API key](https://platform.minimax.io/).

If port 3001 is busy: `npm run stop` then `npm start`.

## Features

- **Create** — vocal / instrumental, auto-lyrics, magic-wand style tags, dual A/B output
- **Covers** — restyle reference audio
- **Lyrics** — write or edit, send to Create
- **Library** — list/tile view, play, download, lyric video export
- **Cover art** — generated in parallel with tracks (optional)

## Why Node (not GitHub Pages alone)?

The app proxies MiniMax and stores uploads under `/uploads/` and generated audio under `/tracks/`. **GitHub Pages cannot run that API.** Use Render (recommended), Fly, Railway, a VPS, or local `npm start`.

## Deploy from GitHub (Render)

1. Push this repo to GitHub (see below).
2. [Render](https://render.com) → **New** → **Blueprint** → connect the repo (`render.yaml` is included).
3. When prompted, set **`MINIMAX_API_KEY`** in Render’s **Environment** (Secret) — **not** in the repository.
4. After deploy, open your Render URL and add your key in **Settings** if you skipped the server env var.

Optional env vars:

| Variable | Purpose |
|----------|---------|
| `MINIMAX_API_KEY` | Server-wide key (private/solo deploys only) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins in production |
| `NODE_ENV` | Set to `production` on hosts (Render sets this) |
| `PORT` | Set by the platform (default `3001` locally) |

### Docker

```bash
docker build -t maxmusic .
docker run -p 3001:3001 -e MINIMAX_API_KEY=your-key-here maxmusic
```

Pass the key with `-e` or a secrets file — never bake it into the image.

## Push to your GitHub repo

```bash
cd maxmusic
git remote add origin https://github.com/atomtanstudio/maxmusic.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username. Render (or another host) can then deploy from `main`.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on push/PR:

- `npm ci`
- `npm run security:check`
- Smoke test: start server, hit `/api/health` and `/`

## API routes (proxy)

| Path | Purpose |
|------|---------|
| `POST /api/generate` | Text-to-music |
| `POST /api/generate-dual` | Two parallel generations |
| `POST /api/cover` | Multipart cover |
| `POST /api/cover-preprocess` | Cover lyrics preprocess |
| `POST /api/lyrics` | Lyrics generation |
| `POST /api/cover-art` | Album art |
| `GET /api/health` | Health check |

## License

MIT