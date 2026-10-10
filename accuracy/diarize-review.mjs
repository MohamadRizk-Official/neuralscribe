// Builds a local listening page (accuracy/testset/private/speaker-check-2.html) for the moments where two runs of
// the private 23:22 recording disagree: time, label before, label now, the words there (Whisper base, this
// machine), and buttons to say who is really talking. Speaker numbers follow the reference run (the numbering
// the user already knows); the other run's labels are matched to it by shared time.
//   node accuracy/diarize-review.mjs <before.json> <after.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [aF, bF] = process.argv.slice(2);
const A = JSON.parse(readFileSync(aF, 'utf8')).segments;
const B = JSON.parse(readFileSync(bF, 'utf8')).segments;
const FR = 0.05, DUR = 1402.1;
const lab = (segs, t) => {
  const s = segs.filter((x) => x.start <= t && x.end > t);
  if (!s.length) return null;
  if (s.some((x) => x.overlap)) return 'OVERLAP';
  return s[0].speaker;
};
const num = { SPEAKER_00: 1, SPEAKER_01: 2, SPEAKER_02: 3 };

// B labels -> A numbers by shared time
const votes = new Map();
for (let t = 0; t < DUR; t += 0.25) {
  const a = lab(A, t), b = lab(B, t);
  if (num[a] && b && b !== 'Unknown' && b !== 'OVERLAP') votes.set(`${b}|${a}`, (votes.get(`${b}|${a}`) || 0) + 1);
}
const map = new Map();
for (const [k] of [...votes].sort((p, q) => q[1] - p[1])) {
  const [b, a] = k.split('|');
  if (!map.has(b) && ![...map.values()].includes(num[a])) map.set(b, num[a]);
}
const name = (l, side) => {
  if (l === 'OVERLAP') return 'Several people at once';
  if (l === 'Unknown' || l == null) return 'Unknown';
  return `Speaker ${side === 'a' ? num[l] : map.get(l) ?? '?'}`;
};

const rows = [];
let cur = null;
for (let t = 0; t < DUR; t += FR) {
  const la = lab(A, t), lb = lab(B, t);
  const a = name(la, 'a'), b = name(lb, 'b');
  const diff = la != null && lb != null && a !== b;
  if (diff && cur && cur.a === a && cur.b === b && t - cur.end <= 0.2) cur.end = t + FR;
  else if (diff) { cur = { start: t, end: t + FR, a, b }; rows.push(cur); }
}
const list = rows.filter((r) => r.end - r.start >= 0.6);

// the words in each moment (rough, only to help find it)
globalThis.self ??= globalThis;
const dir = resolve(ROOT, 'node_modules/@ffmpeg/core/dist/esm');
globalThis.location ??= { href: pathToFileURL(resolve(dir, 'ffmpeg-core.js')).href };
const { default: cf } = await import(pathToFileURL(resolve(dir, 'ffmpeg-core.js')).href);
const core = await cf({ wasmBinary: readFileSync(resolve(dir, 'ffmpeg-core.wasm')), locateFile: (p) => resolve(dir, p) });
core.FS.writeFile('in.mp4', readFileSync(resolve(ROOT, 'accuracy/testset/private/coffee_qazzaz_23m.mp4')));
core.exec('-i', 'in.mp4', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'o.raw');
const raw = core.FS.readFile('o.raw');
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
const { pipeline, env } = await import('@huggingface/transformers');
env.allowRemoteModels = false; // the model is already on this machine; never download
const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', { device: 'cpu', dtype: 'fp32', session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 } });
for (const r of list) {
  const clip = audio.subarray(Math.floor(Math.max(0, r.start - 0.2) * 16000), Math.ceil((r.end + 0.2) * 16000));
  r.words = (await asr(clip, { language: 'en', task: 'transcribe' })).text.trim();
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const anchors = { 1: [[968.1, 976], [1101.1, 1109]], 2: [[223.3, 231], [914.8, 923]], 3: [[586.2, 594], [830, 838]] };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const css = `body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#12183a;margin:0;padding:24px 16px}
main{max-width:860px;margin:0 auto}h1{font-size:26px;margin:0 0 6px}p{color:#3c4470}
.voices{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0 24px}
.voice{background:#fff;border:1px solid #d9dcef;border-radius:14px;padding:12px}.voice b{display:block;font-size:18px;margin-bottom:6px}
.c1{border-top:4px solid #0891b2}.c2{border-top:4px solid #7c3aed}.c3{border-top:4px solid #db2777}
button{font:inherit;cursor:pointer;border-radius:10px;border:1px solid #c9cde6;background:#fff;padding:6px 12px;margin:2px}
button:hover{border-color:#7c3aed}
.row{background:#fff;border:1px solid #d9dcef;border-radius:14px;padding:12px 14px;margin:10px 0}.t{font-weight:700}
.w{color:#3c4470;font-style:italic;margin:4px 0 6px}
.labels{display:flex;gap:14px;flex-wrap:wrap;font-size:14px;margin:6px 0}.labels span{background:#f0f1f8;border-radius:8px;padding:2px 8px}
.pick button.on{background:#12183a;color:#fff;border-color:#12183a}
#out{white-space:pre-wrap;background:#fff;border:1px solid #d9dcef;border-radius:12px;padding:12px;font-family:monospace}
@media(max-width:600px){.voices{grid-template-columns:1fr}}`;

const script = `const rows=${JSON.stringify(list.map((r) => ({ t: fmt(r.start) })))};
const a=document.getElementById('a');let stop=0;
a.addEventListener('timeupdate',()=>{if(stop&&a.currentTime>=stop){a.pause();stop=0;}});
document.addEventListener('click',(e)=>{
  const p=e.target.closest('[data-play]');
  if(p){const [s,t]=p.dataset.play.split(',').map(Number);a.currentTime=Math.max(0,s);stop=t;a.play();return;}
  const v=e.target.closest('[data-v]');
  if(v){const row=v.closest('.row');row.querySelectorAll('[data-v]').forEach((b)=>b.classList.toggle('on',b===v));
    const ans=JSON.parse(localStorage.getItem('ans2')||'{}');ans[row.dataset.i]=v.dataset.v;localStorage.setItem('ans2',JSON.stringify(ans));}
});
const saved=JSON.parse(localStorage.getItem('ans2')||'{}');
for(const [i,v] of Object.entries(saved)){document.querySelector('.row[data-i="'+i+'"] [data-v="'+v+'"]')?.classList.add('on');}
document.getElementById('copy').addEventListener('click',()=>{
  const ans=JSON.parse(localStorage.getItem('ans2')||'{}');
  const txt=rows.map((r,i)=>(i+1)+' ('+r.t+'): '+(ans[i]||'-')).join(', ');
  document.getElementById('out').textContent=txt;navigator.clipboard?.writeText(txt).catch(()=>{});
});`;

const voices = [1, 2, 3].map((n) => `<div class="voice c${n}"><b>Speaker ${n}</b>${anchors[n].map((x, i) => `<button data-play="${x[0]},${x[1]}">▶ Sample ${i + 1}</button>`).join('')}</div>`).join('');
const items = list.map((r, i) => `<div class="row" data-i="${i}"><span class="t">${i + 1}. At ${fmt(r.start)}</span> <button data-play="${(r.start - 0.4).toFixed(2)},${(r.end + 0.4).toFixed(2)}">▶ Play</button>
<div class="labels"><span>Before this round: <b>${esc(r.a)}</b></span><span>Now: <b>${esc(r.b)}</b></span></div>
<div class="w">“${esc(r.words)}”</div>
<div class="pick">Who is talking? ${[1, 2, 3].map((n) => `<button data-v="${n}">Speaker ${n}</button>`).join('')}<button data-v="S">Several people at once</button><button data-v="?">Not sure</button></div></div>`).join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Speaker check 2</title><style>${css}</style></head><body><main>
<h1>Who is talking? (round 2)</h1>
<p>Only the moments that changed in this round. Same voices as last time: listen to the samples first. For each moment press <b>Play</b> and click who you hear, or "Several people at once" if people talk over each other. At the end press <b>Copy my answers</b> and paste them to Claude.</p>
<audio id="a" src="coffee_qazzaz_23m.mp4" preload="auto"></audio>
<div class="voices">${voices}</div>
<h2>${list.length} moments</h2>
${items}
<p><button id="copy">Copy my answers</button></p><div id="out"></div>
<script>${script}</script></main></body></html>`;

writeFileSync(resolve(ROOT, 'accuracy/testset/private/speaker-check-2.html'), html);
writeFileSync(resolve(ROOT, 'accuracy/testset/private/speaker-check-2-key.json'), JSON.stringify(list, null, 1));
console.log(list.length, 'moments');
