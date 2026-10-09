// Shows where two diarization runs of the same recording disagree, with the words spoken there, so a person
// who knows the voices can check which run is right by listening at those times.
//
//   node accuracy/diarize-diff.mjs <audio> <before.json> <after.json> [--min 1.5] [--md out.md]
//
// before/after are --json outputs of accuracy/diarize-eval.mjs. Each stretch where the label differs
// (≥ --min seconds) is transcribed with Whisper base (on this machine) and listed with both labels.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [audioPath, aPath, bPath] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const opt = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const MIN = Number(opt('--min', 1.5));
const FR = 0.05;

const A = JSON.parse(readFileSync(aPath, 'utf8')), B = JSON.parse(readFileSync(bPath, 'utf8'));
const dur = Math.max(A.duration, B.duration);
const frames = (segs) => { const f = new Array(Math.ceil(dur / FR)).fill(null); for (const s of segs) for (let i = Math.floor(s.start / FR); i < Math.min(f.length, Math.ceil(s.end / FR)); i++) f[i] = s.speaker; return f; };
const fa = frames(A.segments), fb = frames(B.segments);
const diffs = [];
let cur = null;
for (let i = 0; i < fa.length; i++) {
  const d = fa[i] && fb[i] && fa[i] !== fb[i];
  if (d && cur && cur.a === fa[i] && cur.b === fb[i] && i - cur.endF <= 4) cur.endF = i + 1;
  else if (d) { cur = { startF: i, endF: i + 1, a: fa[i], b: fb[i] }; diffs.push(cur); }
}
const list = diffs.map((d) => ({ start: d.startF * FR, end: d.endF * FR, before: d.a, after: d.b })).filter((d) => d.end - d.start >= MIN);

// words in each stretch (Whisper base, CPU)
globalThis.self ??= globalThis;
const dir = resolve(ROOT, 'node_modules/@ffmpeg/core/dist/esm');
globalThis.location ??= { href: pathToFileURL(resolve(dir, 'ffmpeg-core.js')).href };
const { default: createFFmpegCore } = await import(pathToFileURL(resolve(dir, 'ffmpeg-core.js')).href);
const core = await createFFmpegCore({ wasmBinary: readFileSync(resolve(dir, 'ffmpeg-core.wasm')), locateFile: (p) => resolve(dir, p) });
const ext = audioPath.split('.').pop();
core.FS.writeFile(`in.${ext}`, readFileSync(audioPath));
core.exec('-i', `in.${ext}`, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'out.raw');
const raw = core.FS.readFile('out.raw');
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
const { pipeline } = await import('@huggingface/transformers');
const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', { device: 'cpu', dtype: 'fp32' });
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const rows = [];
for (const d of list) {
  const clip = audio.subarray(Math.floor(d.start * 16000), Math.ceil(d.end * 16000));
  const { text } = await asr(clip, { language: 'en', task: 'transcribe' });
  rows.push(`| ${fmt(d.start)}–${fmt(d.end)} | ${(d.end - d.start).toFixed(1)} s | ${d.before} | **${d.after}** | ${text.trim().replace(/\|/g, '/')} |`);
}
const md = `| Time | Length | Before | After | Words |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
console.log(md);
const out = opt('--md', null);
if (out) writeFileSync(out, md);
