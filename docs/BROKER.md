# OpenAI account broker — frontend contract

Supplied by the product owner, 14 Aug 2026. This is the contract for the sign-in work that
replaces the currently disabled `lyrics` and `coverArt` capabilities. Nothing here is
implemented yet.

## Architecture

```text
Browser frontend
      |  HTTP /api/* — no OpenAI token
      v
Legion MiniMax backend      http://192.168.1.100:3010
      |  server-side authenticated requests
      v
Unraid OpenAI account broker  http://192.168.1.70:8787
```

**The browser must never call the Unraid broker directly.** No broker token, token file, or
`OPENAI_BROKER_*` secret may appear in frontend code, browser storage, a build-time variable,
a query parameter, a log, or an error message. The credential stays server-side on Legion at
`/srv/ai/secrets/openai-broker-token` and is read only by the MiniMax backend.

If a new OpenAI-backed capability is wanted, a narrow backend route is added first and the
frontend calls that route.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/openai/status` | Account state for rendering the button. Safe for the browser. |
| `POST /api/openai/auth/start` | Begin sign-in. No body. |
| `GET /api/openai/auth/poll/:attemptId` | Poll while the sign-in tab is open. |

`GET /api/openai/status` →

```json
{ "brokerConfigured": true, "authenticated": true, "provider": "codex-chatgpt",
  "planType": "pro", "imageGeneration": true, "codexAvailable": true }
```

`POST /api/openai/auth/start` → either `{ "status": "already_authenticated", "auth": {…} }`
or `{ "status": "pending", "id": "…", "url": "https://auth.openai.com/…",
"verification_code": "ABCD-EFGH", "expires_at": 1780000000 }`.

Open `url` in a new tab. `verification_code` may be shown as a manual fallback. Never render
or log a broker token.

`GET /api/openai/auth/poll/:attemptId` → `pending`, `completed` (with `auth`), or `failed`
(with `error`). Poll every 1–2s and stop on `completed` or `failed`.

## Button behaviour

1. On load, `GET /api/openai/status`.
2. Loading: `Checking OpenAI…`, button disabled.
3. `authenticated` → `OpenAI · connected` plus the plan name when available; hide the button.
4. `brokerConfigured` and not authenticated → `Sign in with OpenAI`.
5. Click → `POST /api/openai/auth/start`.
6. `already_authenticated` → refresh status and finish.
7. Otherwise open `url`, keep `id`, start polling.
8. While polling: `Finish sign-in in the OpenAI tab…`, with a cancel that stops polling locally.
9. `completed` → stop, refresh status, confirm.
10. `failed` / expired / network error → stop, offer retry.

**No overlapping requests.** Use an in-flight flag or a recursive delayed poll, never a bare
`setInterval`. Guard against duplicate clicks and honour `expires_at`.

## Once signed in

The frontend keeps using the normal routes and does not know which provider is behind them:

```http
POST /api/lyrics
POST /api/cover-art
```

Cover art comes back as an ordinary local `/covers/…` URL. Both are asynchronous and need
progress and error states.

## Acceptance checklist

- Status loads with no OpenAI key or broker token anywhere in the client.
- Authenticated state renders `OpenAI · connected`.
- Sign-in calls only `/api/openai/auth/start`; polling hits only `/api/openai/auth/poll/:id`.
- Polling stops on success, failure, cancel and expiry.
- Lyrics use `/api/lyrics`; cover art uses `/api/cover-art`.
- No browser request ever targets `192.168.1.70:8787`.
- No secret in source, client env, localStorage, URL params, logs or rendered error text.
- Existing audio generation keeps working unchanged.

## Notes for this codebase

- `server.js` already proxies `/api` to `BACKEND_HOST:BACKEND_PORT`, so relative `/api/...`
  paths work unchanged and no `API_BASE` is needed.
- `public/js/api.js` is the only module that talks HTTP; these routes belong there beside the
  existing `lyrics()` and `coverArt()` calls.
- Settings is where this surfaces — SPEC §7a names it as the home for connection state — but
  the *result* matters on Lyrics and Art, which today render honest "unavailable" states from
  `/api/health`. Those states are what should change once `authenticated` is true.
