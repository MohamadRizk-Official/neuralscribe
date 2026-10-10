// Scores a run of the private 23:22 recording against the user's own listening answers
// (accuracy/testset/private/coffee-truth.json). Speaker numbers there follow a reference run (v1); another run's
// labels are matched to them by overlap first.  usage: node accuracy/diarize-truth.mjs <reference-run.json> <run.json>
import { readFileSync } from 'node:fs';
const [refRun, runF] = process.argv.slice(2);
const truth = JSON.parse(readFileSync(new URL('./testset/private/coffee-truth.json', import.meta.url), 'utf8')).spans;
const sec = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
const A = JSON.parse(readFileSync(refRun, 'utf8')).segments, B = JSON.parse(readFileSync(runF, 'utf8')).segments;
const at = (segs, t) => segs.filter((x) => !x.overlap && x.start <= t && x.end > t).map((x) => x.speaker);
// label in B -> speaker number of the reference run, by shared time
const votes = new Map();
for (let t = 0; t < 1402; t += 0.25) { const a = at(A, t)[0], b = at(B, t)[0]; if (a && b && a !== 'Unknown' && b !== 'Unknown') { const k = `${b}|${a}`; votes.set(k, (votes.get(k) || 0) + 1); } }
const num = { SPEAKER_00: 1, SPEAKER_01: 2, SPEAKER_02: 3 };
const map = new Map();
for (const [k] of [...votes].sort((p, q) => q[1] - p[1])) { const [b, a] = k.split('|'); if (!map.has(b) && ![...map.values()].includes(num[a])) map.set(b, num[a]); }
let right = 0, wrong = 0, unk = 0; const bad = [];
for (const [s, e, who] of truth) {
  const c = new Map(); let ov = 0, n = 0;
  for (let t = sec(s); t < sec(e); t += 0.05) { n++; const segs = B.filter((x) => x.start <= t && x.end > t); if (segs.some((x) => x.overlap)) ov++; for (const x of segs) if (!x.overlap) c.set(x.speaker, (c.get(x.speaker) || 0) + 1); }
  const top = [...c].sort((p, q) => q[1] - p[1])[0];
  const got = top && top[0] !== 'Unknown' ? map.get(top[0]) : null;
  if (got === who) right++; else if (!got) { unk++; bad.push(`${s} expected ${who}, got ${top ? 'Unknown' : ov ? 'overlap' : 'nothing'}`); } else { wrong++; bad.push(`${s} expected ${who}, got ${got}`); }
}
console.log(JSON.stringify({ moments: truth.length, right, wrong, unknownOrOverlap: unk, misses: bad }));
