// Creates degraded copies of clean synthetic recordings (see manifest.json "variants").
// Deterministic (seeded noise), so results are reproducible run to run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'testset', 'synthetic');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));

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
  if (fmt.bits !== 16) throw new Error('expected 16-bit PCM');
  const n = data.length / 2 / fmt.channels;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  return { x, rate: fmt.rate };
}

function writeWav(path, x, rate) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(path, b);
}

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

function biquad(x, rate, type, f0, q = 0.707) {
  const w = (2 * Math.PI * f0) / rate, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function addNoise(x, rate, snrDb, rumble = false) {
  // pinkish noise (1st-order low-passed white) — closer to room/street noise than pure white
  let noise = Float32Array.from(x, () => gauss());
  noise = biquad(noise, rate, 'lp', 2500);
  if (rumble) {
    const low = biquad(biquad(Float32Array.from(x, () => gauss()), rate, 'lp', 120), rate, 'lp', 120);
    for (let i = 0; i < noise.length; i++) noise[i] = noise[i] * 0.4 + low[i] * 6;
  }
  const speechRms = rms(x.filter((v) => Math.abs(v) > 0.01)) || rms(x);
  const k = speechRms / (rms(noise) * 10 ** (snrDb / 20));
  return x.map((v, i) => v + noise[i] * k);
}

function echo(x, rate) {
  // small-room reverb: a few decaying early reflections + a diffuse tail
  const y = Float32Array.from(x);
  for (const [ms, g] of [[23, 0.45], [41, 0.35], [67, 0.28], [97, 0.2], [151, 0.14], [233, 0.09]]) {
    const d = Math.round((ms / 1000) * rate);
    for (let i = d; i < y.length; i++) y[i] += x[i - d] * g;
  }
  const peak = y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return peak > 0.98 ? y.map((v) => (v * 0.98) / peak) : y;
}

function phone(x, rate) {
  // telephone band (300–3400 Hz), resampled down to 8 kHz and back up, light distortion
  let y = biquad(biquad(x, rate, 'hp', 300), rate, 'lp', 3400);
  const step = rate / 8000;
  const down = new Float32Array(Math.floor(y.length / step));
  for (let i = 0; i < down.length; i++) down[i] = y[Math.floor(i * step)];
  y = new Float32Array(x.length);
  for (let i = 0; i < y.length; i++) y[i] = down[Math.min(down.length - 1, Math.floor(i / step))];
  return y.map((v) => Math.tanh(v * 2.2) / 2.2);
}

for (const v of manifest.variants) {
  for (const id of v.from) {
    const { x, rate } = readWav(join(out, `${id}.wav`));
    let y = Float32Array.from(x);
    if (v.phone) y = phone(y, rate);
    if (v.echo) y = echo(y, rate);
    if (v.noiseSnrDb != null) y = addNoise(y, rate, v.noiseSnrDb, v.rumble);
    if (v.gainDb != null) y = y.map((s) => s * 10 ** (v.gainDb / 20));
    y = y.map((s) => Math.max(-1, Math.min(1, s))); // hard clip like a real ADC
    const name = `${id}__${v.suffix}`;
    writeWav(join(out, `${name}.wav`), y, rate);
    writeFileSync(join(out, `${name}.ref.txt`), readFileSync(join(out, `${id}.ref.txt`)));
    const meta = JSON.parse(readFileSync(join(out, `${id}.meta.json`), 'utf8').replace(/^﻿/, ''));
    writeFileSync(join(out, `${name}.meta.json`), JSON.stringify({ ...meta, category: v.category, degradedFrom: id }, null, 2));
    console.log(`wrote ${name}`);
  }
}
