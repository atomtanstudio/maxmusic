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

Open http://localhost:3000 → **Settings** → paste your [MiniMax API key](https://platform.minimax.io/).

If port 3000 is busy: `npm run stop` then `npm start`.

## Features

- **Create** — vocal / instrumental, auto-lyrics, magic-wand style tags, dual A/B output
- **Covers** — restyle reference audio
- **Lyrics** — write or edit, send to Create
- **Library** — list/tile view, play, download, lyric video export
- **Cover art** — generated in parallel with tracks (optional)

## On GitHub (this repo)

**Source:** https://github.com/atomtanstudio/maxmusic

The project already lives on GitHub. That is the right place for the code, issues, and CI. Pushing updates:

```bash
git add -A && git commit -m "your message" && git push origin main
```

## Can I use GitHub Pages (`*.github.io`)?

**Not for the full app.** GitHub Pages only hosts static files (HTML/CSS/JS). maxmusic needs **`server.js`** to:

- Proxy MiniMax (API keys stay off the client bundle)
- Save generated audio and cover art
- Accept reference uploads for **Covers**

So a `github.io` URL by itself **cannot** run Generate / Covers / Lyrics API calls. There is no Render requirement — but you do need *some* way to run Node, or users run it locally / in Codespaces.

## Let people try it from GitHub (no Render)

### Option A — **GitHub Codespaces** (browser, on GitHub’s cloud)

Good for demos: visitors get a temporary VM tied to your repo.

1. Open https://github.com/atomtanstudio/maxmusic
2. **Code** → **Codespaces** → **Create codespace on main**
3. Wait for setup (`npm ci` runs automatically)
4. In the terminal: `npm start`
5. When port **3000** is forwarded, open it in the browser (Codespaces usually prompts you)
6. **Settings** → paste a [MiniMax API key](https://platform.minimax.io/) → **Save**
7. Use **music-2.6-free** in Advanced if you want the free model tier

Each person uses **their own** Codespace minutes (GitHub free tier has limits). Keys stay in that Codespace’s browser storage, not in your repo.

### Option B — **Clone and run locally** (what most open-source apps do)

Share the repo link and the Quick start steps above. Each user runs `npm start` on their machine — nothing to deploy.

## Production (atomtan.studio / Hetzner)

**Live URL (when deployed):** https://maxmusic.atomtan.studio

Push to `main` triggers [.github/workflows/deploy-hetzner.yml](.github/workflows/deploy-hetzner.yml) — same pattern as PromptSilo: rsync to `/srv/maxmusic`, `npm ci`, restart `maxmusic` systemd unit, Caddy reverse-proxy on port **3002**.

One-time server setup: [ops/README.md](ops/README.md). Reuse GitHub secrets `ATOMTANSTUDIO_HOST`, `ATOMTANSTUDIO_USER`, `ATOMTANSTUDIO_DEPLOY_SSH_KEY`.

## Optional: other hosts (Render, Fly, Docker)

| Variable | Purpose |
|----------|---------|
| `MINIMAX_API_KEY` | Optional server key (omit on public sites; use Settings per user) |
| `ALLOWED_ORIGINS` | CORS allowlist in production |
| `PORT` | Set by the host (default `3000` locally) |

Optional Render blueprint: [`render.yaml`](render.yaml).

### Docker (self-host)

```bash
docker build -t maxmusic .
docker run -p 3000:3000 -e MINIMAX_API_KEY=your-key-here maxmusic
```

Never put the key in the image or in git.

## CI & deploy

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on push/PR:

- `npm ci`
- `npm run security:check`
- Smoke test: start server, hit `/api/health` and `/`

[.github/workflows/deploy-hetzner.yml](.github/workflows/deploy-hetzner.yml) deploys to Hetzner on push to `main`.

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
