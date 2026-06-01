# Security

## API keys

- **This repository must never contain a MiniMax API key.** No `sk-…` strings in source, commits, or screenshots.
- Keys are accepted only via:
  - **`X-Api-Key` request header** (from the browser Settings field, stored in `localStorage` on that device), or
  - **`MINIMAX_API_KEY` environment variable** on the machine running `server.js` (optional; for solo local or private deploys).
- The server forwards the key to MiniMax as `Authorization: Bearer …` and does not echo it in JSON responses or logs.

## Before you push to GitHub

```bash
npm run security:check
```

Do not commit `.env`, generated audio under `public/tracks/`, cover images under `public/covers/`, or files in `uploads/`.

## Public deployment (Render, Fly, Railway, etc.)

1. Connect the GitHub repo to the host; set **`MINIMAX_API_KEY` only in the host’s secret/env UI**, not in the repo.
2. For a **public** app where strangers might use it: **do not** set `MINIMAX_API_KEY` on the server — require each user to paste their own key in **Settings**.
3. Optionally set `ALLOWED_ORIGINS` to your app URL if you serve the UI from another domain.
4. Use `NODE_ENV=production` so CORS defaults to same-origin unless `ALLOWED_ORIGINS` is set.

## Local development

- Prefer a `.env` file (gitignored) or `export MINIMAX_API_KEY=…` in your shell — not hardcoded in files.
- Clearing the key: **Settings → Clear**, or remove `maxmusic.apiKey` from browser `localStorage`.

## What we mitigate in code

- Redaction of `Bearer` / `sk-` patterns in API error text returned to the client
- No `X-Powered-By`; basic security headers
- Upload MIME/extension checks for reference audio
- Random upload filenames (no user-controlled paths)
- Health endpoint reports only `hasServerKey: true|false`, never the key value

## Reporting issues

Open a private security issue or contact the maintainer if you find a key leak or auth bypass.