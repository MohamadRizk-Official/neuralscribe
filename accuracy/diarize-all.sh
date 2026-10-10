#!/usr/bin/env bash
# Full speaker test set: AMI meetings (headset + far mic), the labelled scenarios, and the private 23:22 recording,
# each in Auto and with the true speaker count. One JSON per run in $1.
# usage: bash accuracy/diarize-all.sh <out-dir> <tag> [module]
set -u
OUT="$1"; TAG="$2"; MOD="${3:-}"; mkdir -p "$OUT"
A=accuracy/testset/ami; T=accuracy/testset/diar-scenarios
run() { local name="$1" audio="$2" n="$3" rttm="${4:-}"
  node accuracy/diarize-eval.mjs "$audio" --speakers "$n" ${rttm:+--rttm "$rttm"} --json "$OUT/$name-$([ "$n" = 0 ] && echo auto || echo "n$n")-$TAG.json" ${MOD:+--module "$MOD"} --quiet; }
for m in ES2004a TS3003a IS1009a EN2002b; do run "$m" "$A/$m.Mix-Headset.wav" 0 "$A/$m.rttm"; run "$m" "$A/$m.Mix-Headset.wav" 4 "$A/$m.rttm"; done
run ES2004a-far "$A/ES2004a.Array1-01.wav" 0 "$A/ES2004a.rttm"; run ES2004a-far "$A/ES2004a.Array1-01.wav" 4 "$A/ES2004a.rttm"
for c in one-speaker-variation:1 one-speaker-distance:1 one-speaker-noise-volume:1 one-speaker-everything:1 two-short-interruptions:2 three-long-return:3 five-speakers:5 similar-voices:3 noise-and-distance:3; do
  IFS=: read -r name n <<< "$c"; run "$name" "$T/$name.wav" 0 "$T/$name.rttm"; run "$name" "$T/$name.wav" "$n" "$T/$name.rttm"; done
run coffee accuracy/testset/private/coffee_qazzaz_23m.mp4 0; run coffee accuracy/testset/private/coffee_qazzaz_23m.mp4 3
echo "done $TAG"
