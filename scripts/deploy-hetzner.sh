#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/maxmusic}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-maxmusic}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-0}"

cd "$APP_DIR"

if [ "$SKIP_GIT_SYNC" != "1" ]; then
  echo "==> Fetching latest code from ${DEPLOY_BRANCH}"
  git fetch origin
  git checkout "$DEPLOY_BRANCH"
  git pull --ff-only origin "$DEPLOY_BRANCH"
else
  echo "==> Skipping git sync; using code synced from GitHub Actions"
fi

if [ -f ".env" ]; then
  echo "==> Loading environment from .env"
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

PORT="${PORT:-3000}"
REMOTE_HEALTHCHECK_URL="${REMOTE_HEALTHCHECK_URL:-http://127.0.0.1:${PORT}/api/health}"

mkdir -p uploads public/tracks public/covers

echo "==> Installing dependencies"
npm ci --omit=dev --no-audit --no-fund

echo "==> Restarting ${SERVICE_NAME}"
sudo systemctl restart "$SERVICE_NAME"

echo "==> Waiting for health check"
sleep 3
curl --fail --silent --show-error "$REMOTE_HEALTHCHECK_URL" >/dev/null

echo "==> Deploy finished successfully"
