#!/usr/bin/env bash
# The original launcher: app on 3020, against a separate studio backend.
# Does not touch that backend — that one is yours to start.
#
# For a self-contained install, use `node scripts/start-native.mjs` instead;
# see README.md. This script is kept for setups that predate it.
set -u
cd "$(dirname "$0")"

# Point these at whichever machine runs the studio backend:
#   BACKEND_HOST=192.0.2.10 ./start.sh
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
start app 3020 node server.js

printf '  backend %s:%s ' "$BACKEND_HOST" "$BACKEND_PORT"
health="http://$BACKEND_HOST:$BACKEND_PORT/api/health"
if body=$(curl -fsS -m 5 "$health" 2>/dev/null); then
  field() { printf '%s' "$body" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p"; }
  echo "up (comfy: $(field comfyReachable) · lyrics: $(field lyrics) · cover art: $(field coverArt))"
else
  echo "DOWN — start it yourself; the app proxies /api to it and will 502 until you do"
fi

cat <<'EOF'

  app  http://localhost:3020

EOF
