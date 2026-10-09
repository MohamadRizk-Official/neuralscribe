#!/usr/bin/env bash
# Runs the diarization test runner over the labelled AMI meetings (Auto and with the true speaker count)
# and the private recordings, writing one JSON per run into $1 and a one-line summary per run.
# usage: bash accuracy/diarize-suite.sh <out-dir> [tag]
set -u
OUT="$1"; TAG="${2:-run}"; mkdir -p "$OUT"
A=accuracy/testset/ami
run() { # name audio speakers [rttm]
  local name="$1" audio="$2" n="$3" rttm="${4:-}"
  local j="$OUT/$name-$([ "$n" = 0 ] && echo auto || echo "n$n")-$TAG.json"
  node accuracy/diarize-eval.mjs "$audio" --speakers "$n" ${rttm:+--rttm "$rttm"} --json "$j" --quiet
  node -e "const r=require(process.argv[1]);const s=r.speakerChanges||{};console.log([r.label,'n='+r.chosenSpeakers,'found='+r.detectedSpeakers+(r.referenceSpeakers?'/'+r.referenceSpeakers:''),r.derPct!=null?'DER='+r.derPct+'% conf='+r.confusionPct+'% unk='+r.unknownPct+'% wrongTurns='+r.wrongIdentityTurns+' swaps='+r.identitySwaps+' falseChg='+s.false+' missChg='+s.missed:'unknown='+r.unknownS+'s suspicious='+r.turnsSoundingLikeAnotherSpeaker+'/'+r.turnsChecked, r.elapsedS+'s'].join('  '))" "$(cygpath -w "$j" 2>/dev/null || echo "$j")"
}
for m in ES2004a TS3003a IS1009a EN2002b; do
  run "$m" "$A/$m.Mix-Headset.wav" 0 "$A/$m.rttm"
  run "$m" "$A/$m.Mix-Headset.wav" 4 "$A/$m.rttm"
done
run ES2004a-far "$A/ES2004a.Array1-01.wav" 0 "$A/ES2004a.rttm"
run ES2004a-far "$A/ES2004a.Array1-01.wav" 4 "$A/ES2004a.rttm"
run coffee accuracy/testset/private/coffee_qazzaz_23m.mp4 0
run coffee accuracy/testset/private/coffee_qazzaz_23m.mp4 3
