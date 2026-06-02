#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/maxmusic}"
cd "$APP_DIR"

export NODE_ENV=production
export PORT="${PORT:-3000}"

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

exec node server.js