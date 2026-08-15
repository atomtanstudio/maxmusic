#!/bin/bash
# Builds the blind-judging pack from a rendered video: full-res singles at the
# story beats, an overview contact sheet, and consecutive-frame filmstrips at
# the moments where motion quality shows. Judges see these and nothing else.
#
#   ./render/judge-pack.sh <video> <outdir> [beats] [strips]
#     beats   comma-separated timestamps for full-res singles
#     strips  comma-separated name:start pairs for 3x3 motion strips
#
# Defaults are the OSMW beat map, kept so old rounds stay reproducible.
set -euo pipefail
VID="$1"
OUT="$2"
BEATS="${3:-6.0,13.8,19.2,25.2,29.0,34.6,41.5,53.0,61.5,66.0,87.5,105.0,118.0}"
STRIPS="${4:-slam:0.55,crack:24.2,flip:51.9,chant:86.4}"
mkdir -p "$OUT"

IFS=',' read -ra TS <<< "$BEATS"
for T in "${TS[@]}"; do
  ffmpeg -v error -y -ss "$T" -i "$VID" -frames:v 1 "$OUT/beat-$T.png"
done

# Overview: one frame every 8 seconds.
ffmpeg -v error -y -i "$VID" -vf "fps=1/8,scale=480:-1,tile=5x3" -frames:v 1 -update 1 "$OUT/contact.png"

IFS=',' read -ra SP <<< "$STRIPS"
for S in "${SP[@]}"; do
  NAME="${S%%:*}"
  T="${S##*:}"
  ffmpeg -v error -y -ss "$T" -i "$VID" -vf "select='not(mod(n,3))',scale=480:-1,tile=3x3" -frames:v 1 -update 1 "$OUT/strip-$NAME.png"
done

ls "$OUT" | head -30
