#!/usr/bin/env bash
# Bring the MaxMusic redesign back up: app on 3020, gauntlet monitor on 3021.
# Does not touch the backend on 3010 — that one is yours to start.
set -u
cd "$(dirname "$0")"

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

printf '  backend :3010 '
if curl -fsS -m 5 -o /dev/null http://localhost:3010/api/health 2>/dev/null; then
  art=$(curl -fsS -m 5 http://localhost:3010/api/health 2>/dev/null \
        | sed -n 's/.*"coverArt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  echo "up (cover art: ${art:-unknown})"
else
  echo "DOWN — start it yourself; the app proxies /api to it and will 502 until you do"
fi

cat <<'EOF'

  app      http://localhost:3020
  monitor  http://localhost:3021

  Next steps are in RESUME.md
EOF
