// Builds the labelled diarization scenarios in accuracy/testset/diar-scenarios/ from real voices in the AMI
// meetings (accuracy/testset/ami): clean single-speaker turns are cut out and re-assembled into new
// conversations whose "who spoke when" is known exactly, with controlled difficulties:
//
//   one-speaker-variation   1 person; some turns pitched up/down, louder/quieter, one from further away
//   two-short-interruptions 2 people; many 0.5–1.5 s interjections ("yeah", "right")
//   three-long-return       3 people, ~20 min; one leaves for 7 minutes and comes back; long silences
//   five-speakers           5 people from two meetings
//   similar-voices          two women whose voices are close (AMI FEE013 / FEE016) plus one man
//   noise-and-distance      3 people with steady background noise; one moves away from the mic halfway
//
// Writes <name>.wav (16 kHz mono) and <name>.rttm. Deterministic (seeded). Needs the AMI files first.
//   node accuracy/diarize-build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AMI = resolve(ROOT, 'accuracy/testset/ami');
const OUT = resolve(ROOT, 'accuracy/testset/diar-scenarios');
mkdirSync(OUT, { recursive: true });
const SR = 16000;

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

function readWav(path) {
  const b = readFileSync(path);
  let o = 12, fmt = null, data = null;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') { data = b.subarray(o + 8, Math.min(b.length, o + 8 + size)); break; } // some files over-declare the size
    o += 8 + size + (size & 1);
  }
  if (fmt.bits !== 16 || fmt.sr !== SR) throw new Error(`${path}: expected 16 kHz 16-bit`);
  const n = Math.floor(data.length / 2 / fmt.ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return x;
}
function writeWav(path, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(path, b);
}
const rttmOf = (meeting) => readFileSync(resolve(AMI, `${meeting}.rttm`), 'utf8').split('\n').filter((l) => l.startsWith('SPEAKER'))
  .map((l) => l.trim().split(/\s+/)).map((p) => ({ start: +p[3], end: +p[3] + +p[4], spk: p[7] }));

// clean turns: a speaker alone (no one else within 0.3 s), cut 0.05 s inside the edges
const cache = new Map();
function turnsOf(meeting) {
  if (cache.has(meeting)) return cache.get(meeting);
  const audio = readWav(resolve(AMI, `${meeting}.Mix-Headset.wav`));
  const ref = rttmOf(meeting).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of ref) {
    const last = merged.findLast((m) => m.spk === r.spk);
    if (last && r.start - last.end < 0.4 && merged[merged.length - 1] === last) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const clean = merged.filter((m) => !ref.some((o) => o.spk !== m.spk && o.start < m.end + 0.3 && o.end > m.start - 0.3));
  const by = new Map();
  for (const m of clean) {
    const a = Math.floor((m.start + 0.05) * SR), b = Math.floor((m.end - 0.05) * SR);
    if (b - a < 0.4 * SR) continue;
    (by.get(m.spk) || by.set(m.spk, []).get(m.spk)).push(audio.slice(a, b));
  }
  cache.set(meeting, by);
  return by;
}
const voice = (meeting, spk) => { const t = turnsOf(meeting).get(spk); if (!t) throw new Error(`${meeting}/${spk}: no clean turns`); return t; };
function take(pool, minS, maxS) { // a turn of roughly minS–maxS seconds (consecutive clean turns joined)
  const want = (minS + rnd() * (maxS - minS)) * SR;
  const parts = []; let len = 0, i = Math.floor(rnd() * pool.length), guard = 0;
  while (len < want && guard++ < 50) { const p = pool[i++ % pool.length]; parts.push(p); len += p.length + 0.15 * SR; }
  const out = new Float32Array(Math.min(len, Math.max(want, parts[0].length)));
  let w = 0;
  for (const p of parts) { if (w >= out.length) break; out.set(p.subarray(0, Math.min(p.length, out.length - w)), w); w += p.length + Math.floor(0.15 * SR); }
  return out;
}

// effects
const gain = (x, db) => x.map((v) => v * 10 ** (db / 20));
// The same person speaking higher or lower: pitch moves, the voice's resonances (formants) stay. LPC envelopes
// are measured every 10 ms; the excitation (the residual after removing the envelope) is resampled to the new
// pitch and re-filtered with the envelope of the matching moment. Tempo changes with pitch, like natural speech.
// (Plain resampling would also move the formants, which sounds like a different, larger/smaller person.)
function pitch(x, semis) {
  const r = 2 ** (semis / 12), N = 400, H = 160, P = 16;
  const frames = [];
  for (let s = 0; s + N <= x.length; s += H) {
    const R = new Float64Array(P + 1);
    for (let k = 0; k <= P; k++) { let t = 0; for (let i = k; i < N; i++) { const w1 = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N), w2 = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - k)) / N); t += x[s + i] * w1 * x[s + i - k] * w2; } R[k] = t; }
    let a = new Float64Array(P + 1); a[0] = 1;
    if (R[0] > 1e-9) {
      R[0] *= 1.0001; let err = R[0];
      for (let i = 1; i <= P; i++) {
        let acc = R[i]; for (let j = 1; j < i; j++) acc += a[j] * R[i - j];
        const k = -acc / err, na = Float64Array.from(a);
        for (let j = 1; j < i; j++) na[j] = a[j] + k * a[i - j];
        na[i] = k; a = na; err *= 1 - k * k;
      }
    }
    frames.push(a);
  }
  if (!frames.length) return x;
  const coef = (t) => frames[Math.min(frames.length - 1, Math.max(0, Math.round((t - N / 2) / H)))];
  // excitation: inverse-filter with the envelope of each moment
  const e = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const a = coef(i); let t = x[i]; for (let j = 1; j <= P; j++) t += a[j] * (x[i - j] || 0); e[i] = t; }
  // new pitch: read the excitation r times faster, re-filter with the envelope at the same source moment
  const out = new Float32Array(Math.floor(x.length / r));
  for (let i = 0; i < out.length; i++) {
    const q = i * r, k = Math.floor(q), fr = q - k;
    const a = coef(q);
    let t = (e[k] || 0) * (1 - fr) + (e[k + 1] || 0) * fr;
    for (let j = 1; j <= P; j++) t -= a[j] * (out[i - j] || 0);
    out[i] = Number.isFinite(t) ? Math.max(-4, Math.min(4, t)) : 0;
  }
  let pi = 0, po = 0;
  for (const v of x) pi = Math.max(pi, Math.abs(v));
  for (const v of out) po = Math.max(po, Math.abs(v));
  if (po) for (let i = 0; i < out.length; i++) out[i] *= pi / po;
  return out;
}
function far(x) { // further from the mic: quieter, duller, with room echo
  const y = new Float32Array(x.length + SR / 2);
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp += 0.35 * (x[i] - lp); y[i] += lp * 0.45; }
  for (const [d, g] of [[0.023, 0.35], [0.041, 0.28], [0.067, 0.2], [0.11, 0.14], [0.17, 0.09]]) {
    const o = Math.floor(d * SR);
    for (let i = 0; i < x.length; i++) y[i + o] += y[i] * g;
  }
  return y;
}
const noiseBed = (n, level) => { const y = new Float32Array(n); let b = 0; for (let i = 0; i < n; i++) { b = 0.97 * b + 0.03 * (rnd() * 2 - 1); y[i] = (b * 3 + (rnd() * 2 - 1) * 0.3) * level; } return y; };

function build(name, script) {
  const pieces = [], ref = []; let t = 0;
  for (const s of script) {
    if (s.gap) { t += s.gap; continue; }
    let a = s.audio;
    pieces.push({ at: Math.floor(t * SR), a });
    ref.push({ start: t, end: t + a.length / SR, spk: s.who });
    t += a.length / SR + (s.after ?? 0.35 + rnd() * 0.5);
  }
  const x = new Float32Array(Math.ceil((t + 0.5) * SR));
  for (const p of pieces) for (let i = 0; i < p.a.length && p.at + i < x.length; i++) x[p.at + i] += p.a[i];
  return { x, ref, name };
}
function save({ x, ref, name }, noise = 0) {
  if (noise) { const n = noiseBed(x.length, noise); for (let i = 0; i < x.length; i++) x[i] += n[i]; }
  writeWav(resolve(OUT, `${name}.wav`), x);
  writeFileSync(resolve(OUT, `${name}.rttm`), ref.map((r) => `SPEAKER ${name} 1 ${r.start.toFixed(3)} ${(r.end - r.start).toFixed(3)} <NA> <NA> ${r.spk} <NA> <NA>`).join('\n') + '\n');
  const spk = new Set(ref.map((r) => r.spk));
  console.log(`${name}: ${(x.length / SR / 60).toFixed(1)} min, ${spk.size} speakers, ${ref.length} turns`);
}

// voices (AMI ids: first letter F/M = woman/man)
const A = voice('ES2004a', 'FEE013'), B = voice('ES2004a', 'MEE014'), C = voice('ES2004a', 'FEE016'), Dv = voice('ES2004a', 'MEO015');
const E = voice('IS1009a', [...turnsOf('IS1009a').keys()][0]), F = voice('TS3003a', [...turnsOf('TS3003a').keys()][1]);

// 1 speaker with variation
{
  const s = [];
  for (let i = 0; i < 40; i++) {
    let a = take(A, 3, 12);
    if (i % 7 === 3) a = pitch(a, 2.5); else if (i % 7 === 5) a = pitch(a, -2);
    if (i % 5 === 2) a = gain(a, -9); if (i % 9 === 4) a = gain(a, 5);
    if (i === 30 || i === 31) a = far(a);
    s.push({ who: 'A', audio: a, after: rnd() < 0.2 ? 3 + rnd() * 4 : 0.4 + rnd() * 0.8 });
  }
  save(build('one-speaker-variation', s));
}
// 2 speakers, short interruptions
{
  const s = [];
  for (let i = 0; i < 60; i++) {
    const main = i % 2 ? 'A' : 'B';
    s.push({ who: main, audio: take(main === 'A' ? A : B, 4, 14) });
    if (rnd() < 0.6) s.push({ who: main === 'A' ? 'B' : 'A', audio: take(main === 'A' ? B : A, 0.5, 1.5), after: 0.2 });
  }
  save(build('two-short-interruptions', s));
}
// 3 speakers, ~20 min, one leaves for 7 minutes and returns; long silences
{
  const s = []; let t = 0;
  while (t < 20 * 60) {
    const away = t > 6 * 60 && t < 13 * 60;
    const who = away ? pick(['A', 'B']) : pick(['A', 'B', 'C']);
    const a = take({ A, B, C }[who], 2, 16);
    s.push({ who, audio: a, after: rnd() < 0.08 ? 6 + rnd() * 6 : 0.3 + rnd() * 0.7 });
    t += a.length / SR + 1;
  }
  save(build('three-long-return', s));
}
// 5 speakers
{
  const V = { A, B, C, D: Dv, E }, s = [];
  for (let i = 0; i < 90; i++) { const who = pick(Object.keys(V)); s.push({ who, audio: take(V[who], 1.5, 12) }); }
  save(build('five-speakers', s));
}
// similar voices: two women (A, C) + one man (B), with short answers
{
  const s = [];
  for (let i = 0; i < 70; i++) { const who = pick(['A', 'C', 'A', 'C', 'B']); s.push({ who, audio: take({ A, B, C }[who], rnd() < 0.3 ? 0.6 : 2, rnd() < 0.3 ? 1.5 : 10) }); }
  save(build('similar-voices', s));
}
// background noise + one speaker moves away from the mic halfway
{
  const s = [];
  for (let i = 0; i < 70; i++) {
    const who = pick(['A', 'B', 'F']);
    let a = take({ A, B, F }[who], 2, 12);
    if (who === 'B' && i > 35) a = far(a);
    s.push({ who, audio: a });
  }
  save(build('noise-and-distance', s), 0.012);
}
