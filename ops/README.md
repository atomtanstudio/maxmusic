# Hetzner production — maxmusic

Same deploy model as **PromptSilo**: push to `main` → GitHub Actions rsync → `scripts/deploy-hetzner.sh` → `systemctl restart maxmusic`.

## Server layout

| Path | Purpose |
|------|---------|
| `/srv/maxmusic` | App checkout (synced by Actions; no `.git` required) |
| `/srv/maxmusic/.env` | Secrets (`MINIMAX_API_KEY`, optional `ALLOWED_ORIGINS`) — **never commit** |
| `127.0.0.1:3002` | Node app (systemd) |
| Caddy | Public HTTPS → `maxmusic.atomtan.studio` |

## One-time bootstrap (SSH)

```bash
sudo mkdir -p /srv/maxmusic
sudo chown rich:rich /srv/maxmusic

# First deploy can be empty; GitHub Actions will fill the directory on first push.
mkdir -p /srv/maxmusic/uploads /srv/maxmusic/public/tracks /srv/maxmusic/public/covers

# Env file (example)
cat > /srv/maxmusic/.env <<'EOF'
NODE_ENV=production
PORT=3002
# Optional server-wide MiniMax key; omit for bring-your-own-key in Settings
# MINIMAX_API_KEY=your-key-here
# ALLOWED_ORIGINS=https://maxmusic.atomtan.studio
EOF
chmod 600 /srv/maxmusic/.env

# systemd
sudo cp /srv/maxmusic/ops/systemd/maxmusic.service /etc/systemd/system/maxmusic.service
sudo systemctl daemon-reload
sudo systemctl enable --now maxmusic

# Allow deploy user to restart without password (adjust user if not `rich`)
echo 'rich ALL=(root) NOPASSWD: /usr/bin/systemctl restart maxmusic, /usr/bin/systemctl status maxmusic' | sudo tee /etc/sudoers.d/maxmusic-deploy
sudo visudo -cf /etc/sudoers.d/maxmusic-deploy

# Caddy — add ops/caddy/Caddyfile.maxmusic block to /etc/caddy/Caddyfile, then:
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

DNS: `maxmusic.atomtan.studio` → your Hetzner server IP.

## GitHub Actions secrets

Reuse the same repo/org secrets as **atomtan.studio** / PromptSilo:

| Secret | Example |
|--------|---------|
| `ATOMTANSTUDIO_HOST` | Server IP or hostname |
| `ATOMTANSTUDIO_USER` | `rich` |
| `ATOMTANSTUDIO_DEPLOY_SSH_KEY` | Deploy private key (raw or base64) |

Workflow: [.github/workflows/deploy-hetzner.yml](../.github/workflows/deploy-hetzner.yml)

## Manual deploy

```bash
ssh rich@YOUR_SERVER
cd /srv/maxmusic
./scripts/deploy-hetzner.sh
```

## Notes

- `uploads/`, `public/tracks/`, and `public/covers/` are **excluded from rsync** so generated media on the server is not wiped.
- `node_modules` is installed on the server during deploy (`npm ci --omit=dev`).
