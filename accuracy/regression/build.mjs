// Builds the "never invent words" regression set from the TTS pieces made by generate.ps1.
// Everything that is not speech (silence, noise, taps, humming) has NO words in the reference, so any
// word the engine outputs there counts as an insertion. Deterministic (seeded), 16 kHz mono 16-bit.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'testset', 'regression');
const speechDir = join(out, '_speech');
const RATE = 16000;
mkdirSync(out, { recursive: true });

function readWav(path) {
  const b = readFileSync(path);
  let p = 12, fmt, data;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  const n = data.length / 2 / fmt.channels;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  // resample to 16 kHz (linear; fine for TTS)
  if (fmt.rate === RATE) return x;
  const m = Math.floor((n * RATE) / fmt.rate);
  const y = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const t = (i * fmt.rate) / RATE, k = Math.floor(t), f = t - k;
    y[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f;
  }
  return y;
}
function writeWav(path, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(path, b);
}

let seed = 4242;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const db = (d) => 10 ** (d / 20);
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / (x.length || 1));

// room tone: very quiet pinkish noise, so "silence" is like a real phone recording, not digital zero
function roomTone(sec, level = -62) {
  const x = new Float32Array(Math.round(sec * RATE));
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp = lp * 0.97 + gauss() * 0.03; x[i] = lp; }
  const k = db(level) / (rms(x) || 1);
  return x.map((v) => v * k);
}
function noise(sec, level) { return roomTone(sec, level); }
// knocks on a table: short decaying low-mid bursts at irregular intervals
function taps(sec, level = -18) {
  const x = roomTone(sec, -60);
  let t = 0.3;
  while (t < sec - 0.2) {
    const start = Math.round(t * RATE);
    const f = 180 + rand() * 220;
    for (let i = 0; i < 0.09 * RATE && start + i < x.length; i++) {
      const env = Math.exp(-i / (0.012 * RATE));
      x[start + i] += db(level) * env * (Math.sin((2 * Math.PI * f * i) / RATE) * 0.7 + gauss() * 0.5);
    }
    t += 0.35 + rand() * 0.9;
  }
  return x;
}
// closed-mouth humming ("mmm"): harmonic tone around 130 Hz with vibrato and a soft envelope
function hum(sec, level = -24) {
  const n = Math.round(sec * RATE);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f0 = 130 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t)) * (1 + 0.06 * Math.sin(2 * Math.PI * 0.3 * t));
    ph += (2 * Math.PI * f0) / RATE;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(ph * h) / (h * h);
    const env = Math.min(1, t / 0.15, (sec - t) / 0.25);
    x[i] = v * env;
  }
  const k = db(level) / (rms(x) || 1);
  return x.map((v, i) => v * k + 0);
}
function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const y = new Float32Array(n);
  let o = 0;
  for (const p of parts) { y.set(p, o); o += p.length; }
  return y;
}
function mix(a, b) { const y = Float32Array.from(a); for (let i = 0; i < y.length; i++) y[i] += b[i] ?? 0; return y; }
function gain(x, d) { const k = db(d); return x.map((v) => v * k); }

const speech = (k) => readWav(join(speechDir, `${k}.wav`));
const text = (k) => readFileSync(join(speechDir, `${k}.txt`), 'utf8').trim();
const withRoom = (x) => mix(x, roomTone(x.length / RATE));

const items = [
  ['normal_speech', 'normal English speech', () => withRoom(speech('normal')), text('normal')],
  ['silence', 'silence (room tone only)', () => roomTone(10), ''],
  ['background_noise', 'background noise only', () => noise(12, -32), ''],
  ['tapping', 'tapping on a table', () => taps(10), ''],
  ['humming', 'humming', () => hum(8), ''],
  ['thinking_sounds', '"mmm" thinking sounds, then speech', () => concat(hum(1.0, -26), roomTone(0.8), hum(1.2, -26), roomTone(0.8), withRoom(speech('think'))), text('think')],
  ['no_no_no', 'legitimate "no, no, no"', () => withRoom(speech('nonono')), text('nonono')],
  ['very_very', 'emphasised repeated word', () => withRoom(speech('very')), text('very')],
  ['low_volume', 'low-volume speech', () => withRoom(gain(speech('normal'), -30)), text('normal')],
  ['speech_then_silence', 'speech followed by 20 s of silence', () => concat(withRoom(speech('callback')), roomTone(20)), text('callback')],
  ['pause_then_speech', '15 s pause, then speech', () => concat(roomTone(15), withRoom(speech('callback'))), text('callback')],
  ['noise_while_speaking', 'background noise while speaking (≈ 5 dB SNR)', () => { const s = speech('normal'); return mix(s, noise(s.length / RATE, 20 * Math.log10(rms(s.filter((v) => Math.abs(v) > 0.01)) || 0.05) - 5)); }, text('normal')],
  ['speech_then_taps', 'speech, then tapping (the voice-note pattern)', () => concat(withRoom(speech('callback')), roomTone(0.8), taps(3), roomTone(1.5)), text('callback')],
  ['speech_then_hum', 'speech, then humming', () => concat(withRoom(speech('callback')), roomTone(0.6), hum(4)), text('callback')],
];

for (const [id, description, make, ref] of items) {
  writeWav(join(out, `${id}.wav`), make());
  writeFileSync(join(out, `${id}.ref.txt`), ref);
  writeFileSync(join(out, `${id}.meta.json`), JSON.stringify({ category: 'regression', description, speakers: 1, language: 'en', synthetic: true, nonSpeechOnly: !ref }));
  console.log('built', id);
}
