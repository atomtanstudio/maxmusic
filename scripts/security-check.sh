#!/usr/bin/env bash
# Scan tracked project files for accidental API keys or env leaks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Checking for committed .env files…"
if git ls-files --error-unmatch .env 2>/dev/null; then
  echo "FAIL: .env is tracked by git — remove it."
  exit 1
fi

echo "Checking for sk- API key patterns in tracked files…"
if git grep -nE 'sk-[A-Za-z0-9]{16,}' -- . \
  ':(exclude)node_modules' \
  ':(exclude)_reference-music-studio' \
  ':(exclude)package-lock.json' \
  ':(exclude)scripts/security-check.sh' \
  ':(exclude).env.example' \
  2>/dev/null; then
  echo "FAIL: Possible API key found in tracked files."
  exit 1
fi

echo "Checking for MINIMAX_API_KEY= assignments in tracked files…"
if git grep -nE 'MINIMAX_API_KEY\s*=\s*sk-' -- . \
  ':(exclude)node_modules' \
  ':(exclude)_reference-music-studio' \
  2>/dev/null; then
  echo "FAIL: Possible committed server API key."
  exit 1
fi

echo "Security check passed."