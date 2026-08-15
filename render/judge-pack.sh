#!/bin/bash
# Builds the blind-judging pack from a rendered video: full-res singles at the
# story beats, an overview contact sheet, and consecutive-frame filmstrips at
# the moments where motion quality shows. Judges see these and nothing else.
#
#   ./render/judge-pack.sh render/out/osmw-v1.mp4 /path/to/outdir
set -euo pipefail
VID="$1"
OUT="$2"
mkdir -p "$OUT"

# Full-res story beats: title, verse pop, redact, crack, chorus build, stamps,
# mono verse, invert flip, tag, wall drop, chant strobe, constellation, endcard.
for T in 6.0 13.8 19.2 25.2 29.0 34.6 41.5 53.0 61.5 66.0 87.5 105.0 118.0; do
  ffmpeg -v error -y -ss "$T" -i "$VID" -frames:v 1 "$OUT/beat-$T.png"
done

# Overview: one frame every 8 seconds, 15 tiles.
ffmpeg -v error -y -i "$VID" -vf "fps=1/8,scale=480:-1,tile=5x3" -frames:v 1 -update 1 "$OUT/contact.png"

# Motion strips: 9 consecutive-ish frames around four kinetic moments.
ffmpeg -v error -y -ss 0.55 -i "$VID" -vf "select='not(mod(n,2))',scale=480:-1,tile=3x3" -frames:v 1 -update 1 "$OUT/strip-slam.png"
ffmpeg -v error -y -ss 24.2 -i "$VID" -vf "select='not(mod(n,3))',scale=480:-1,tile=3x3" -frames:v 1 -update 1 "$OUT/strip-crack.png"
ffmpeg -v error -y -ss 51.9 -i "$VID" -vf "select='not(mod(n,3))',scale=480:-1,tile=3x3" -frames:v 1 -update 1 "$OUT/strip-flip.png"
ffmpeg -v error -y -ss 86.4 -i "$VID" -vf "select='not(mod(n,3))',scale=480:-1,tile=3x3" -frames:v 1 -update 1 "$OUT/strip-chant.png"

ls -la "$OUT"
