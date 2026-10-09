// Speaker-detection ("who spoke when") test runner. Runs the app's own diarization code
// (src/engine/diarize.js) in Node with the same models, on CPU, and scores it.
//
//   node accuracy/diarize-eval.mjs <audio> [--speakers N] [--rttm ref.rttm] [--json out.json] [--label name]
//
// With an RTTM reference (e.g. the AMI meetings in accuracy/testset/ami) it reports:
//   speaker count, missed / false-alarm / confusion time (DER-style), Unknown time,
//   false and missed speaker changes, and IDENTITY SWAPS: a real person's turns carried by a label that
//   belongs to someone else, or one person's label changing partway through the recording.
// Without a reference (a private recording) it reports a per-minute speaker timeline and a voice-consistency
// check: every turn's voice compared with every speaker's average voice, flagging turns that sound more like
// another speaker than the one they were given.
//
// Audio never leaves this machine. Everything is decoded with the app's bundled ffmpeg (wasm).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!file) { console.error('usage: node accuracy/diarize-eval.mjs <audio> [--speakers N] [--rttm ref.rttm] [--json out.json]'); process.exit(1); }
const numSpeakers = Number(opt('--speakers', 0)) || 0;
const rttmPath = opt('--rttm');
const jsonOut = opt('--json');
const label = opt('--label', basename(file));
const quiet = args.includes('--quiet');

// ---------- decode (ffmpeg.wasm, like the app's fallback decoder) ----------
async function decode(path) {
  globalThis.self ??= globalThis;
  globalThis.location ??= { href: pathToFileURL(resolve(ROOT, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js')).href };
  const dir = resolve(ROOT, 'node_modules/@ffmpeg/core/dist/esm');
  const { default: createFFmpegCore } = await import(pathToFileURL(resolve(dir, 'ffmpeg-core.js')).href);
  const core = await createFFmpegCore({ wasmBinary: readFileSync(resolve(dir, 'ffmpeg-core.wasm')), locateFile: (p) => resolve(dir, p) });
  const ext = path.split('.').pop();
  core.FS.writeFile(`in.${ext}`, readFileSync(path));
  core.exec('-i', `in.${ext}`, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'out.raw');
  const raw = core.FS.readFile('out.raw');
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}

// ---------- models (same ids and fp32 weights as the app on WebGPU; CPU here) ----------
const T = await import('@huggingface/transformers');
const { analyzeAudio, preprocess } = await import(pathToFileURL(resolve(ROOT, 'src/engine/preprocess.js')).href);
// --module lets an experiment run a modified copy of the diarization code against the same scoring
const D = await import(pathToFileURL(resolve(opt('--module') || resolve(ROOT, 'src/engine/diarize.js'))).href);
const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

const t0 = performance.now();
const audio = await decode(resolve(file));
const quality = analyzeAudio(audio);
preprocess(audio, quality);
const segProcessor = await T.AutoProcessor.from_pretrained(SEG_MODEL);
const segModel = await T.AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { device: 'cpu', dtype: 'fp32' });
const embProcessor = await T.AutoProcessor.from_pretrained(EMB_MODEL);
const embModel = await T.AutoModel.from_pretrained(EMB_MODEL, { device: 'cpu', dtype: 'fp32' });
const timings = [];
D.configureDiarizer({
  segModel, segProcessor, segDevice: 'cpu', embModel, embProcessor, embDevice: 'cpu', Tensor: T.Tensor,
  status: () => {}, lap: (l) => timings.push(l), post: () => {},
});
const { segments, stats } = await D.diarize(audio, numSpeakers);
const dur = audio.length / D.SR;
const elapsed = (performance.now() - t0) / 1000;

// ---------- helpers ----------
const FR = 0.01; // 10 ms frames
const nF = Math.ceil(dur / FR);
const hypFrames = Array.from({ length: nF }, () => new Set());
for (const s of segments) for (let f = Math.floor(s.start / FR); f < Math.min(nF, Math.ceil(s.end / FR)); f++) hypFrames[f].add(s.speaker);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const hypRuns = (() => {
  const runs = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 0.5) last.end = Math.max(last.end, s.end);
    else runs.push({ speaker: s.speaker, start: s.start, end: s.end });
  }
  return runs;
})();
const labels = [...new Set(segments.map((s) => s.speaker))].filter((l) => l !== D.UNKNOWN);
const talk = (l) => hypFrames.reduce((t, f) => t + (f.has(l) ? FR : 0), 0);
const report = { label, file: basename(file), duration: +dur.toFixed(1), chosenSpeakers: numSpeakers || 'auto', elapsedS: +elapsed.toFixed(1),
  detectedSpeakers: labels.length, speakerTime: Object.fromEntries(labels.map((l) => [l, +talk(l).toFixed(1)])),
  unknownS: +talk(D.UNKNOWN).toFixed(1), smoothing: stats };

// ---------- scored against a reference ----------
if (rttmPath) {
  const ref = readFileSync(rttmPath, 'utf8').split('\n').filter((l) => l.startsWith('SPEAKER'))
    .map((l) => l.trim().split(/\s+/)).map((p) => ({ start: +p[3], end: +p[3] + +p[4], speaker: p[7] }));
  const refFrames = Array.from({ length: nF }, () => new Set());
  for (const s of ref) for (let f = Math.floor(s.start / FR); f < Math.min(nF, Math.ceil(s.end / FR)); f++) refFrames[f].add(s.speaker);
  const refSpk = [...new Set(ref.map((r) => r.speaker))];

  // optimal one-to-one map hyp label -> ref speaker (by overlapping time); small sets, so brute force
  const ov = new Map();
  for (let f = 0; f < nF; f++) for (const h of hypFrames[f]) for (const r of refFrames[f]) ov.set(`${h}|${r}`, (ov.get(`${h}|${r}`) || 0) + FR);
  let bestMap = new Map(), bestScore = -1;
  const hyps = labels.slice(0, 9);
  const search = (i, used, map, score) => {
    if (i === hyps.length) { if (score > bestScore) { bestScore = score; bestMap = new Map(map); } return; }
    search(i + 1, used, map, score); // this label maps to nobody
    for (const r of refSpk) if (!used.has(r)) {
      used.add(r); map.set(hyps[i], r);
      search(i + 1, used, map, score + (ov.get(`${hyps[i]}|${r}`) || 0));
      used.delete(r); map.delete(hyps[i]);
    }
  };
  search(0, new Set(), new Map(), 0);

  // DER-style accounting over single-speaker reference frames (overlap reported separately)
  let refSpeech = 0, missed = 0, unknown = 0, confusion = 0, fa = 0, overlap = 0;
  for (let f = 0; f < nF; f++) {
    const r = refFrames[f], h = [...hypFrames[f]];
    if (r.size > 1) { overlap += FR; continue; }
    if (!r.size) { if (h.some((x) => x !== D.UNKNOWN)) fa += FR; continue; }
    refSpeech += FR;
    const [rs] = r;
    const real = h.filter((x) => x !== D.UNKNOWN);
    if (!h.length) missed += FR;
    else if (!real.length) unknown += FR;
    else if (!real.some((x) => bestMap.get(x) === rs)) confusion += FR;
  }

  // identity per reference turn: the label carrying most of each turn (≥ 1.5 s of single-speaker speech)
  const turns = [];
  for (const s of [...ref].sort((a, b) => a.start - b.start)) {
    if (s.end - s.start < 1.5) continue;
    const count = new Map(); let n = 0;
    for (let f = Math.floor(s.start / FR); f < Math.min(nF, Math.ceil(s.end / FR)); f++) {
      if (refFrames[f].size !== 1) continue;
      n++;
      for (const h of hypFrames[f]) count.set(h, (count.get(h) || 0) + 1);
    }
    if (n < 100) continue;
    const [top, c] = [...count].filter(([h]) => h !== D.UNKNOWN).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    turns.push({ ref: s.speaker, start: s.start, end: s.end, label: c / n >= 0.5 ? top : null });
  }
  // wrong-identity turns: carried by a label that belongs to another person
  const wrongTurns = turns.filter((t) => t.label && bestMap.get(t.label) !== t.ref);
  // identity changes: per person, how often the carrying label changes between consecutive turns
  const changes = []; const perPerson = {};
  for (const r of refSpk) {
    const seq = turns.filter((t) => t.ref === r && t.label);
    let k = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i].label !== seq[i - 1].label) { k++; changes.push({ ref: r, at: fmt(seq[i].start), from: seq[i - 1].label, to: seq[i].label }); }
    const firstHalf = seq.filter((t) => t.start < dur / 2), secondHalf = seq.filter((t) => t.start >= dur / 2);
    const major = (list) => { const m = new Map(); for (const t of list) m.set(t.label, (m.get(t.label) || 0) + (t.end - t.start)); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || null; };
    perPerson[r] = { turns: seq.length, labelChanges: k, mainLabelFirstHalf: major(firstHalf), mainLabelSecondHalf: major(secondHalf) };
  }
  // speaker changes at turn level (±1 s)
  const refChanges = []; const sortedRef = [...ref].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedRef.length; i++) if (sortedRef[i].speaker !== sortedRef[i - 1].speaker) refChanges.push(sortedRef[i].start);
  const hypChanges = []; const realRuns = hypRuns.filter((r) => r.speaker !== D.UNKNOWN);
  for (let i = 1; i < realRuns.length; i++) if (realRuns[i].speaker !== realRuns[i - 1].speaker) hypChanges.push(realRuns[i].start);
  const near = (a, list) => list.some((b) => Math.abs(a - b) <= 1.0);
  Object.assign(report, {
    referenceSpeakers: refSpk.length,
    speakerCountCorrect: labels.length === refSpk.length,
    mapping: Object.fromEntries(bestMap),
    singleSpeakerSpeechS: +refSpeech.toFixed(1), overlapS: +overlap.toFixed(1),
    missedPct: +(100 * missed / refSpeech).toFixed(2), unknownPct: +(100 * unknown / refSpeech).toFixed(2),
    confusionPct: +(100 * confusion / refSpeech).toFixed(2), falseAlarmPct: +(100 * fa / refSpeech).toFixed(2),
    derPct: +(100 * (missed + unknown + confusion + fa) / refSpeech).toFixed(2),
    turnsScored: turns.length, wrongIdentityTurns: wrongTurns.length, wrongIdentityPct: +(100 * wrongTurns.length / Math.max(1, turns.filter((t) => t.label).length)).toFixed(1),
    identitySwaps: changes.length, perPerson,
    speakerChanges: { reference: refChanges.length, detected: hypChanges.length,
      missed: refChanges.filter((c) => !near(c, hypChanges)).length, false: hypChanges.filter((c) => !near(c, refChanges)).length },
    swapExamples: changes.slice(0, 12),
  });
} else {
  // ---------- no reference: timeline + voice consistency ----------
  const runs = hypRuns.filter((r) => r.speaker !== D.UNKNOWN && r.end - r.start >= 2);
  const embs = await D.embedClips(audio, runs.map((r) => [{ start: r.start, end: r.end }]));
  const cent = new Map();
  runs.forEach((r, i) => { const c = cent.get(r.speaker) || new Float32Array(embs[i].length); for (let d = 0; d < c.length; d++) c[d] += embs[i][d] * (r.end - r.start); cent.set(r.speaker, c); });
  for (const [k, c] of cent) { let n = 0; for (const v of c) n += v * v; n = Math.sqrt(n) || 1; cent.set(k, c.map((v) => v / n)); }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const suspicious = [];
  runs.forEach((r, i) => {
    const own = dot(embs[i], cent.get(r.speaker));
    let other = null, os = -1;
    for (const [k, c] of cent) if (k !== r.speaker) { const v = dot(embs[i], c); if (v > os) { os = v; other = k; } }
    if (other && os > own) suspicious.push({ at: fmt(r.start), len: +(r.end - r.start).toFixed(1), given: r.speaker, soundsLike: other, own: +own.toFixed(2), other: +os.toFixed(2) });
  });
  const perMinute = [];
  for (let m = 0; m < Math.ceil(dur / 60); m++) {
    const row = {};
    for (let f = Math.floor(m * 60 / FR); f < Math.min(nF, Math.floor((m + 1) * 60 / FR)); f++) for (const h of hypFrames[f]) row[h] = (row[h] || 0) + FR;
    perMinute.push(`${String(m).padStart(2, '0')}: ` + Object.entries(row).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}s`).join(', '));
  }
  Object.assign(report, { turnsChecked: runs.length, turnsSoundingLikeAnotherSpeaker: suspicious.length,
    suspiciousTurns: suspicious.slice(0, 40), perMinute,
    runs: hypRuns.map((r) => `${fmt(r.start)}-${fmt(r.end)} ${r.speaker}`) });
}

if (!quiet) {
  const { runs, perMinute, suspiciousTurns, swapExamples, ...head } = report;
  console.log(JSON.stringify(head, null, 2));
  if (swapExamples?.length) console.log('identity changes:', JSON.stringify(swapExamples));
  if (perMinute) console.log(perMinute.join('\n'));
  if (suspiciousTurns?.length) console.log('turns that sound like another speaker:\n' + suspiciousTurns.map((s) => `  ${s.at} (${s.len}s) given ${s.given}, sounds like ${s.soundsLike} (${s.own} vs ${s.other})`).join('\n'));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...report, segments }, null, 1));
