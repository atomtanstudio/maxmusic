#!/usr/bin/env bash
# Bring the MaxMusic redesign back up: app on 3020, gauntlet monitor on 3021.
# Does not touch the backend on 3010 — that one is yours to start.
set -u
cd "$(dirname "$0")"

# The backend may run on this Mac or on the LAN box that hosts ComfyUI.
# Override either of these to point somewhere else:
#   BACKEND_HOST=192.168.1.100 ./start.sh
export BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
export BACKEND_PORT="${BACKEND_PORT:-3010}"

start() { # name port command...
  local name=$1 port=$2; shift 2
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "  $name already running on :$port"
  else
    "$@" > "/tmp/maxmusic-$name.log" 2>&1 &
    sleep 1
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "  $name started on :$port"
    else
      echo "  $name FAILED — see /tmp/maxmusic-$name.log"
    fi
  fi
}

echo
echo "MaxMusic"
start app     3020 node server.js
start monitor 3021 node gauntlet-status.mjs

printf '  backend %s:%s ' "$BACKEND_HOST" "$BACKEND_PORT"
health="http://$BACKEND_HOST:$BACKEND_PORT/api/health"
if body=$(curl -fsS -m 5 "$health" 2>/dev/null); then
  field() { printf '%s' "$body" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p"; }
  echo "up (comfy: $(field comfyReachable) · lyrics: $(field lyrics) · cover art: $(field coverArt))"
else
  echo "DOWN — start it yourself; the app proxies /api to it and will 502 until you do"
fi

cat <<'EOF'

  app      http://localhost:3020
  monitor  http://localhost:3021

  Next steps are in RESUME.md
EOF
