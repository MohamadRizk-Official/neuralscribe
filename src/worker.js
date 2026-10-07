// Runs entirely in a Web Worker so the page stays responsive. Audio never leaves the device.
//
// Pipeline:
//   0. analyse the recording (level, noise, clipping) and clean a processing copy
//      (DC offset, 70 Hz high-pass, level normalisation) — see engine/preprocess.js
//   1. pyannote segmentation on 10 s chunks  -> where speech is and which *local* voice (≤3 per chunk)
//   2. WeSpeaker ResNet34 voice fingerprint  -> one embedding per (chunk, local voice)
//   3. agglomerative clustering of embeddings -> global speakers across the whole file
//   4. cut the audio into speaker turns (silence skipped); turns longer than Whisper's 30 s window
//      are split at a pause, or — if there is no pause — with a 1 s overlap that is de-duplicated
//   5. language: detected from up to 8 clips spread across the file; mixed-language recordings let
//      Whisper pick per turn among the detected languages
//   6. Whisper transcribes the turns in batches (optionally primed with "important words")
//   7. Best Accuracy: turns Whisper itself was unsure about (avg log-prob, repetition) are retried
import {
  pipeline,
  AutoProcessor,
  AutoModel,
  AutoModelForAudioFrameClassification,
  LogitsProcessorList,
  Tensor,
} from '@huggingface/transformers';
import { analyzeAudio, preprocess } from './engine/preprocess.js';
import { mergeOverlap } from './engine/merge.js';
import { TokenLogprobRecorder, LanguageControl, compressionRatio } from './engine/decoding.js';

const ASR_MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo',
};
const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const SR = 16000;
const UNKNOWN = 'Unknown';

// Speaker detection
const SEG_CHUNK_S = 10; // pyannote segmentation is trained on 10 s windows
const EMB_CLIP_S = 5; // every fingerprint is computed on exactly 5 s (cropped or looped) so they batch
const EMB_MIN_S = 0.5; // less clean speech than this in a chunk can't be fingerprinted -> Unknown
const CLUSTER_MIN_S = 1.2; // only fingerprints with at least this much speech decide the clusters
const LINK_DIST = 0.7; // average-linkage cosine distance at which voices stop being merged
const ASSIGN_SIM = 0.25; // short/rare voices join the closest speaker only if at least this cosine-similar
const MIN_SPEAKER_S = 15; // a "speaker" needs this much speech (or 1% of the file) to count as a real person

// Turn building
const MIN_TURN_S = 0.3; // ignore blips shorter than this
const MERGE_GAP_S = 1.5; // join same-speaker speech separated by less than this
const MAX_TURN_S = 27.5; // Whisper's window is 30 s; leaves room for padding / overlap on both sides
const MIN_SPLIT_S = 16; // when a turn must be split, look for the best pause between 16 s and 27.5 s
const PAD_S = 0.2; // extra context around each clip
const OVERLAP_S = 1.0; // when a split can't land on a pause, both pieces share this much audio
const MIN_GAP_SPEECH_S = 1.0; // loud-but-unlabelled stretches shorter than this are ignored

// Whisper's own quality signals (same thresholds as OpenAI's reference implementation)
const LOGPROB_THRESHOLD = -1.0; // average token log-probability below this = model unsure
const COMPRESSION_THRESHOLD = 2.4; // highly repetitive output ("the the the…") = likely hallucination
const RETRY_TEMPERATURES = [0.2, 0.5];
const MAX_PROMPT_TOKENS = 100; // "important words" prompt budget (Whisper allows ~224)

// Every language Whisper knows; filtered against the loaded tokenizer.
const WHISPER_LANGS = 'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'.split(' ');

// Whisper sometimes "hears" these in near-silence.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|\.+|subtitles by .*|please subscribe.*)$/i;

let asr = null;
let asrKey = null; // `${model}:${device}`
let segProcessor = null;
let segModel = null;
let segDevice = null;
let embProcessor = null;
let embModel = null;
let embDevice = null;
let device = null;
let debugVoices = false;
let hasF16 = false; // WebGPU half-precision support

const post = (msg) => self.postMessage(msg);
const status = (text) => post({ type: 'status', text });
const lap0 = { t: 0 };
const lap = (label) => console.log(`[timing] ${label}: ${((performance.now() - lap0.t) / 1000).toFixed(1)}s`);
const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
};

// ---------- model loading ----------
// Why we ended up on the CPU, so the page can explain it:
//   'no-webgpu'  the browser has no WebGPU in workers   'no-adapter'  WebGPU exists but no usable GPU
//   'error'      asking for a GPU threw                 'load-failed' GPU found but the models wouldn't run on it
//   'forced'     ?cpu was in the URL (testing)
let gpuReason = null;

async function detectDevice(forceCPU = false) {
  if (device) return device;
  if (forceCPU) {
    gpuReason = 'forced';
    device = 'wasm';
    return device;
  }
  try {
    if (!self.navigator?.gpu) gpuReason = 'no-webgpu';
    else {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        hasF16 = adapter.features?.has('shader-f16') ?? false;
        device = 'webgpu';
        return device;
      }
      gpuReason = 'no-adapter';
    }
  } catch {
    gpuReason = 'error';
  }
  device = 'wasm';
  return device;
}

// Weights per model. large-v3-turbo can use 4-bit weights with fp16 maths (q4f16, ~565 MB download)
// instead of fp16 encoder + q4 decoder (~1.6 GB); the choice was made by measuring WER, see README.
let turboVariant = 'q4f16';
function asrOptions(modelKey, dev) {
  if (dev === 'webgpu') {
    if (modelKey === 'turbo' && turboVariant === 'q4f16' && hasF16) {
      return { device: 'webgpu', dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' } };
    }
    return {
      device: 'webgpu',
      dtype: {
        encoder_model: hasF16 || modelKey === 'turbo' ? 'fp16' : 'fp32',
        decoder_model_merged: 'q4',
      },
    };
  }
  return { device: 'wasm', dtype: 'q8' };
}

// Which Whisper model a mode uses. On CPU, large-v3-turbo needs minutes per 30 s of audio, so the
// strongest practical model there is "small".
export function resolveModel(mode, dev, override) {
  if (override) return override === 'turbo' && dev !== 'webgpu' ? 'small' : override;
  if (mode === 'fast') return 'base';
  return dev === 'webgpu' ? 'turbo' : 'small';
}

// Try WebGPU first, fall back to CPU if this GPU/driver can't run the model.
async function loadOnBestDevice(load, gpuOpts, cpuOpts) {
  if (device === 'webgpu') {
    try {
      return [await load(gpuOpts), 'webgpu'];
    } catch (err) {
      console.warn('WebGPU load failed, using CPU:', err);
    }
  }
  return [await load(cpuOpts), 'wasm'];
}

async function loadModels(modelKey, diarize, progress_callback) {
  let dev = await detectDevice();
  const key = `${modelKey}:${dev}:${turboVariant}`;
  if (asrKey !== key) {
    asr = null;
    try {
      asr = await pipeline('automatic-speech-recognition', ASR_MODELS[modelKey], {
        ...asrOptions(modelKey, dev),
        progress_callback,
      });
    } catch (err) {
      if (dev === 'webgpu') {
        // Some GPUs/drivers fail on WebGPU — fall back to CPU (wasm) transparently.
        status('WebGPU failed, falling back to CPU…');
        console.warn('WebGPU model load failed:', err);
        dev = device = 'wasm';
        gpuReason = 'load-failed';
        modelKey = resolveModel(null, dev, modelKey); // turbo is impractical on CPU
        asr = await pipeline('automatic-speech-recognition', ASR_MODELS[modelKey], {
          ...asrOptions(modelKey, dev),
          progress_callback,
        });
      } else {
        throw err;
      }
    }
    asrKey = `${modelKey}:${dev}:${turboVariant}`;
    asr.modelKey = modelKey;
  }
  if (diarize && !segModel) {
    segProcessor = await AutoProcessor.from_pretrained(SEG_MODEL, { progress_callback });
    [segModel, segDevice] = await loadOnBestDevice(
      (o) => AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { ...o, progress_callback }),
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'wasm', dtype: 'fp32' },
    );
  }
  if (diarize && !embModel) {
    embProcessor = await AutoProcessor.from_pretrained(EMB_MODEL, { progress_callback });
    [embModel, embDevice] = await loadOnBestDevice(
      (o) => AutoModel.from_pretrained(EMB_MODEL, { ...o, progress_callback }),
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'wasm', dtype: 'q8' },
    );
  }
  return dev;
}

// ---------- 1. segmentation ----------
// Splits combined labels ("SPEAKER_00 + SPEAKER_01") into their parts.
const parts = (label) => (label === 'NO_SPEAKER' ? [] : label.split(' + '));

async function segmentChunks(audio) {
  const chunkLen = SR * SEG_CHUNK_S;
  const n = Math.ceil(audio.length / chunkLen);
  const batch = segDevice === 'webgpu' ? 32 : 8;
  const id2label = segModel.config.id2label || {};
  const chunks = []; // [{ offset, segs: [{start,end,label}] }]

  for (let i = 0; i < n; i += batch) {
    const b = Math.min(batch, n - i);
    const data = new Float32Array(b * chunkLen); // zero-padded past the end of the audio
    for (let k = 0; k < b; k++) {
      const s = (i + k) * chunkLen;
      data.set(audio.subarray(s, Math.min(audio.length, s + chunkLen)), k * chunkLen);
    }
    const { logits } = await segModel({ input_values: new Tensor('float32', data, [b, 1, chunkLen]) });
    const results = segProcessor.post_process_speaker_diarization(logits, chunkLen);
    results.forEach((segs, k) => {
      const offset = (i + k) * SEG_CHUNK_S;
      chunks.push({
        offset,
        segs: segs
          .map((s) => ({ start: s.start + offset, end: Math.min(s.end + offset, audio.length / SR), label: id2label[s.id] ?? String(s.id) }))
          .filter((s) => s.end > s.start),
      });
    });
    status(`Finding speech… ${Math.round(((i + b) / n) * 100)}%`);
  }
  return chunks;
}

// ---------- 2. voice fingerprints ----------
// One item per (chunk, local voice), using only the parts where that voice speaks alone.
function collectVoices(audio, chunks) {
  const items = [];
  chunks.forEach((chunk, c) => {
    const byLocal = new Map();
    for (const s of chunk.segs) {
      if (s.label === 'NO_SPEAKER' || s.label.includes(' + ')) continue; // skip silence and overlap
      if (!byLocal.has(s.label)) byLocal.set(s.label, []);
      byLocal.get(s.label).push(s);
    }
    for (const [local, segs] of byLocal) {
      const dur = segs.reduce((t, s) => t + (s.end - s.start), 0);
      items.push({ key: `${c}|${local}`, chunk: c, local, segs, dur, emb: null });
    }
  });
  return items;
}

function clipForVoice(audio, segs) {
  const want = SR * EMB_CLIP_S;
  const pieces = segs.map((s) => audio.subarray(Math.floor(s.start * SR), Math.floor(s.end * SR)));
  const total = pieces.reduce((t, p) => t + p.length, 0);
  const out = new Float32Array(want);
  if (!total) return out;
  // concatenate, looping if the voice spoke for less than EMB_CLIP_S (mean/std pooling is unaffected)
  let w = 0;
  while (w < want) {
    for (const p of pieces) {
      const take = Math.min(p.length, want - w);
      out.set(p.subarray(0, take), w);
      w += take;
      if (w >= want) break;
    }
  }
  return out;
}

async function embedVoices(audio, items) {
  const todo = items.filter((it) => it.dur >= EMB_MIN_S);
  const batch = embDevice === 'webgpu' ? 16 : 4;
  for (let i = 0; i < todo.length; i += batch) {
    const group = todo.slice(i, i + batch);
    const feats = [];
    for (const it of group) feats.push((await embProcessor(clipForVoice(audio, it.segs))).input_features);
    const [, F, D] = feats[0].dims;
    const data = new Float32Array(group.length * F * D);
    feats.forEach((f, k) => data.set(f.data, k * F * D));
    const out = await embModel({ input_features: new Tensor('float32', data, [group.length, F, D]) });
    const embs = out.last_hidden_state ?? out.embeddings ?? Object.values(out)[0];
    const dim = embs.dims[1];
    group.forEach((it, k) => { it.emb = normalize(embs.data.slice(k * dim, (k + 1) * dim)); });
    status(`Recognizing voices… ${Math.round(((i + group.length) / todo.length) * 100)}%`);
  }
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// ---------- 3. clustering ----------
// Average-linkage agglomerative clustering on cosine distance. On real meetings this is far more
// stable than centroid linkage, which tends to snowball everything into one giant cluster.
// Phase 1 merges until the closest clusters are LINK_DIST apart. If the user said how many people
// there are, phase 2 keeps merging the closest *substantial* clusters until that many remain
// (tiny outlier clusters are ignored there — they get folded in or marked Unknown afterwards).
function clusterVoices(items, numSpeakers, minSpeakerS) {
  const pts = items.filter((it) => it.emb && it.dur >= CLUSTER_MIN_S);
  const n = pts.length;
  if (!n) return [];
  const dim = pts[0].emb.length;

  const D = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i * n + j] = D[j * n + i] = 1 - dot(pts[i].emb, pts[j].emb);
  const size = new Int32Array(n).fill(1);
  const dur = Float64Array.from(pts, (p) => p.dur);
  const members = pts.map((p) => [p]);
  const alive = new Uint8Array(n).fill(1);
  const best = new Int32Array(n).fill(-1);
  const bestD = new Float32Array(n).fill(Infinity);
  const refreshBest = (i) => {
    best[i] = -1;
    bestD[i] = Infinity;
    for (let j = 0; j < n; j++) if (j !== i && alive[j] && D[i * n + j] < bestD[i]) { bestD[i] = D[i * n + j]; best[i] = j; }
  };
  for (let i = 0; i < n; i++) refreshBest(i);

  const merge = (i, j) => {
    // Lance–Williams update for average linkage
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === i || k === j) continue;
      D[i * n + k] = D[k * n + i] = (size[i] * D[i * n + k] + size[j] * D[j * n + k]) / (size[i] + size[j]);
    }
    size[i] += size[j];
    dur[i] += dur[j];
    members[i].push(...members[j]);
    alive[j] = 0;
    // average linkage never brings a cluster closer, so only neighbours of i or j need a refresh
    for (let k = 0; k < n; k++) if (alive[k] && (k === i || best[k] === i || best[k] === j)) refreshBest(k);
  };

  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k++) if (alive[k] && best[k] >= 0 && (i < 0 || bestD[k] < bestD[i])) i = k;
    if (i < 0 || bestD[i] > LINK_DIST) break;
    merge(i, best[i]);
  }

  if (numSpeakers) {
    for (;;) {
      const big = [];
      for (let k = 0; k < n; k++) if (alive[k] && dur[k] >= minSpeakerS) big.push(k);
      if (big.length <= numSpeakers) break;
      let bi = -1, bj = -1, bd = Infinity;
      for (const x of big) for (const y of big) if (x < y && D[x * n + y] < bd) { bd = D[x * n + y]; bi = x; bj = y; }
      merge(bi, bj);
    }
  }

  const clusters = [];
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const c = new Float32Array(dim);
    for (const p of members[i]) for (let d = 0; d < dim; d++) c[d] += p.emb[d];
    clusters.push({ members: members[i], centroid: normalize(c), dur: dur[i] });
  }
  return clusters;
}

// Gives every (chunk, local voice) a global speaker label (or Unknown).
function labelVoices(items, numSpeakers) {
  const totalSpeech = items.reduce((t, it) => t + it.dur, 0);
  const minSpeakerS = Math.max(MIN_SPEAKER_S, totalSpeech * 0.01);
  const clusters = clusterVoices(items, numSpeakers, minSpeakerS);

  // Tiny clusters are usually a real speaker on a bad-mic moment (or a cough / laugh). Fold them
  // into the closest real speaker when similar enough; otherwise they really are an unknown voice.
  let big = clusters.filter((c) => c.dur >= minSpeakerS);
  let small = clusters.filter((c) => c.dur < minSpeakerS);
  if (!big.length) { big = clusters; small = []; }
  const nearest = (emb) => {
    let bi = -1, bs = -Infinity;
    big.forEach((c, i) => { const s = dot(emb, c.centroid); if (s > bs) { bs = s; bi = i; } });
    return [bi, bs];
  };

  const label = new Map(); // key -> cluster index in `big`, or -1 for unknown
  big.forEach((c, i) => c.members.forEach((p) => label.set(p.key, i)));
  for (const c of small) {
    const [bi, bs] = nearest(c.centroid);
    for (const p of c.members) label.set(p.key, bs >= ASSIGN_SIM ? bi : -1);
  }
  for (const it of items) {
    if (label.has(it.key)) continue;
    if (!it.emb) continue; // resolved below from neighbouring chunks
    const [bi, bs] = nearest(it.emb);
    label.set(it.key, bs >= ASSIGN_SIM ? bi : -1);
  }

  // Too little speech to fingerprint: if it touches the chunk edge and the neighbouring chunk has a
  // voice running across the same edge, it is almost certainly the same person mid-sentence.
  const byChunk = new Map();
  for (const it of items) { if (!byChunk.has(it.chunk)) byChunk.set(it.chunk, []); byChunk.get(it.chunk).push(it); }
  const EDGE = 0.25;
  for (const it of items) {
    if (label.has(it.key)) continue;
    const t0 = it.chunk * SEG_CHUNK_S;
    const t1 = t0 + SEG_CHUNK_S;
    let inherited = -1;
    const touchesStart = it.segs.some((s) => s.start - t0 < EDGE);
    const touchesEnd = it.segs.some((s) => t1 - s.end < EDGE);
    for (const [cond, other, edge] of [[touchesStart, it.chunk - 1, t0], [touchesEnd, it.chunk + 1, t1]]) {
      if (!cond || inherited >= 0) continue;
      for (const o of byChunk.get(other) || []) {
        const l = label.get(o.key);
        if (l >= 0 && o.segs.some((s) => Math.abs((other < it.chunk ? s.end : s.start) - edge) < EDGE)) { inherited = l; break; }
      }
    }
    label.set(it.key, inherited);
  }

  // Name clusters in order of first appearance.
  const order = new Map();
  for (const it of [...items].sort((a, b) => a.chunk - b.chunk)) {
    const ci = label.get(it.key);
    if (ci >= 0 && !order.has(ci)) order.set(ci, `SPEAKER_${String(order.size).padStart(2, '0')}`);
  }
  const names = new Map();
  for (const [key, ci] of label) names.set(key, ci >= 0 ? order.get(ci) : UNKNOWN);
  return names;
}

async function diarize(audio, numSpeakers) {
  status('Finding speech…');
  const chunks = await segmentChunks(audio);
  lap('segmentation');

  const items = collectVoices(audio, chunks);
  status('Recognizing voices…');
  await embedVoices(audio, items);
  lap(`fingerprints (${items.filter((i) => i.emb).length})`);

  if (debugVoices) post({ type: 'debug', voices: items.map((it) => ({ key: it.key, chunk: it.chunk, dur: it.dur, emb: it.emb ? Array.from(it.emb) : null })) });
  status('Grouping voices into speakers…');
  const names = labelVoices(items, numSpeakers);
  lap('clustering');

  const segments = [];
  chunks.forEach((chunk, c) => {
    for (const s of chunk.segs) {
      const local = parts(s.label)[0];
      if (!local) continue;
      segments.push({ start: s.start, end: s.end, speaker: names.get(`${c}|${local}`) ?? UNKNOWN });
    }
  });
  return segments;
}

// ---------- 4. turns ----------
// RMS energy in 100 ms frames; used to find speech the speaker model missed and to pick quiet cut points.
function frameEnergy(audio) {
  const frame = SR / 10;
  const n = Math.floor(audio.length / frame);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * frame, end = j + frame; j < end; j++) sum += audio[j] * audio[j];
    rms[i] = Math.sqrt(sum / frame);
  }
  return rms;
}

function energyRuns(rms) {
  if (!rms.length) return [];
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(floor * 3, 0.008);
  const runs = [];
  let start = -1;
  let quiet = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] > thr) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet > 3) {
      runs.push({ start: start / 10, end: (i - quiet + 1) / 10 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start: start / 10, end: rms.length / 10 });
  return runs.filter((r) => r.end - r.start >= MIN_GAP_SPEECH_S);
}

// Parts of `run` not covered by the (time-ordered) `speech` segments.
function subtract(run, speech) {
  const out = [];
  let cur = run.start;
  for (const s of speech) {
    if (s.end <= cur) continue;
    if (s.start >= run.end) break;
    if (s.start > cur) out.push({ start: cur, end: s.start });
    cur = Math.max(cur, s.end);
  }
  if (cur < run.end) out.push({ start: cur, end: run.end });
  return out.filter((x) => x.end - x.start >= MIN_GAP_SPEECH_S);
}

// Turns longer than Whisper's window are split. Prefer the quietest moment (300 ms average) between
// 16 s and 27.5 s into the turn. If even that moment is clearly speech, the cut is "hard": both
// pieces then include OVERLAP_S of shared audio and the duplicated words are removed after
// transcription (engine/merge.js), so a word sitting on the cut isn't lost.
function splitLong(turn, rms, silenceRms, out) {
  let { start } = turn;
  let hardStart = false;
  while (turn.end - start > MAX_TURN_S) {
    const from = Math.floor((start + MIN_SPLIT_S) * 10);
    const to = Math.min(rms.length - 2, Math.floor((start + MAX_TURN_S) * 10));
    let best = to;
    let bestRms = Infinity;
    for (let f = Math.max(1, from); f <= to; f++) {
      const avg = (rms[f - 1] + rms[f] + rms[f + 1]) / 3;
      if (avg < bestRms) { bestRms = avg; best = f; }
    }
    const cut = Math.min(best / 10, start + MAX_TURN_S);
    const hard = !(bestRms <= silenceRms);
    out.push({ ...turn, start, end: cut, hardStart, hardEnd: hard });
    hardStart = hard;
    start = cut;
  }
  out.push({ ...turn, start, hardStart, hardEnd: false });
}

function buildTurns(audio, segments) {
  const rms = frameEnergy(audio);
  const runs = energyRuns(rms);
  const sorted = Float32Array.from(rms).sort();
  const silenceRms = Math.max((sorted[Math.floor(sorted.length * 0.1)] || 0) * 2, 0.003);

  let items;
  if (segments) {
    const speech = [...segments].sort((a, b) => a.start - b.start);
    items = speech.slice();
    // Loud audio the speaker model didn't label becomes "Unknown" instead of being dropped.
    for (const r of runs) for (const g of subtract(r, speech)) items.push({ ...g, speaker: UNKNOWN });
  } else {
    items = runs.map((r) => ({ ...r, speaker: 'SPEAKER_00' }));
  }
  items.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === it.speaker && it.start - last.end <= MERGE_GAP_S) last.end = Math.max(last.end, it.end);
    else merged.push({ ...it });
  }

  const turns = [];
  for (const t of merged.filter((t) => t.end - t.start >= MIN_TURN_S)) splitLong(t, rms, silenceRms, turns);
  return turns;
}

// ---------- 5. Whisper ----------
const tokenId = (tok, name) => tok.convert_tokens_to_ids(name);

// Whisper always sees 30 s of log-mel frames. Computing the spectrogram of 30 s for a 2 s clip is
// mostly wasted work, so we only compute the real frames (plus a short zero tail) and fill the rest
// with the value silence normalises to — (max log-mel − 8 + 4) / 4, i.e. max(normalised) − 2.
async function featuresFor(clips) {
  const fe = asr.processor.feature_extractor;
  const { n_samples, hop_length, n_fft, nb_max_frames: frames, feature_size: mels } = fe.config;
  const data = new Float32Array(clips.length * mels * frames);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const len = Math.min(n_samples, Math.ceil((c.length + 2 * n_fft) / hop_length) * hop_length);
    const f = (await fe(c, { max_length: len })).input_features;
    const T = f.dims[2];
    const src = f.data;
    let mx = -Infinity;
    for (let k = 0; k < src.length; k++) if (src[k] > mx) mx = src[k];
    const base = i * mels * frames;
    for (let m = 0; m < mels; m++) {
      data.set(src.subarray(m * T, (m + 1) * T), base + m * frames);
      if (T < frames) data.fill(mx - 2, base + m * frames + T, base + (m + 1) * frames);
    }
  }
  return new Tensor('float32', data, [clips.length, mels, frames]);
}

// Audio for one turn: a little context on both sides, or the full overlap at a hard split.
// Times stay in original-recording seconds; the clip is just a view into the same samples.
const clipFor = (audio, t) =>
  audio.subarray(
    Math.max(0, Math.floor((t.start - (t.hardStart ? OVERLAP_S : PAD_S)) * SR)),
    Math.min(audio.length, Math.ceil((t.end + (t.hardEnd ? OVERLAP_S : PAD_S)) * SR)),
  );
const clipSeconds = (t) => t.end - t.start + (t.hardStart ? OVERLAP_S : PAD_S) + (t.hardEnd ? OVERLAP_S : PAD_S);

// Token ids of every language the loaded model supports.
function languageTokens(tok) {
  const unk = tok.unk_token_id ?? tok.model?.tokens_to_ids?.get?.('<|endoftext|>');
  const map = new Map(); // id -> code
  for (const code of WHISPER_LANGS) {
    const id = tok.convert_tokens_to_ids(`<|${code}|>`);
    if (id != null && id !== unk && !map.has(id)) map.set(id, code);
  }
  return map;
}

// "Important words" become a Whisper prompt: <|startofprev|> + " Hadi Salame, SparkScribe, …"
// which biases spelling towards them (same mechanism as OpenAI's initial_prompt).
function vocabularyPrompt(tok, words) {
  const list = (words || []).map((w) => String(w).trim()).filter(Boolean);
  if (!list.length) return [];
  let ids = tok.encode(' ' + list.join(', ') + '.', { add_special_tokens: false });
  if (ids.length > MAX_PROMPT_TOKENS) ids = ids.slice(-MAX_PROMPT_TOKENS);
  return [tokenId(tok, '<|startofprev|>'), ...ids];
}

// Language: sample up to 8 clips spread across the recording (longest turn in each eighth),
// ask Whisper for its language probabilities on each, and weight them by clip length.
// If a second language holds a real share (≥15% of the evidence, or one clip that is clearly
// in it), the recording is treated as mixed and Whisper picks per turn among those languages.
async function detectLanguages(audio, turns, langIds) {
  const tok = asr.tokenizer;
  const total = audio.length / SR;
  const buckets = new Map();
  for (const t of turns) {
    const b = Math.min(7, Math.floor((t.start / total) * 8));
    const cur = buckets.get(b);
    if (!cur || t.end - t.start > cur.end - cur.start) buckets.set(b, t);
  }
  const sample = [...buckets.values()].filter((t) => t.end - t.start >= 1.5);
  if (!sample.length) sample.push(...[...turns].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3));
  if (!sample.length) return { codes: ['en'], scores: {} };

  const allIds = [...langIds.keys()];
  const control = new LanguageControl(1, allIds, [tokenId(tok, '<|transcribe|>'), tokenId(tok, '<|notimestamps|>')]);
  const processors = new LogitsProcessorList();
  processors.push(control);
  const inputs = await featuresFor(sample.map((t) => clipFor(audio, t)));
  await asr.model.generate({
    inputs,
    decoder_input_ids: sample.map(() => [tokenId(tok, '<|startoftranscript|>')]),
    max_new_tokens: 1,
    begin_suppress_tokens: null,
    logits_processor: processors,
  });

  const score = new Map();
  let weightSum = 0;
  const confident = new Set();
  sample.forEach((t, i) => {
    const w = Math.min(30, t.end - t.start);
    weightSum += w;
    const probs = control.langProbs[i];
    if (!probs) return;
    for (const [id, p] of probs) score.set(id, (score.get(id) || 0) + p * w);
    const [topId, topP] = [...probs].sort((a, b) => b[1] - a[1])[0];
    if (topP >= 0.6 && t.end - t.start >= 3) confident.add(topId);
  });
  const ranked = [...score].map(([id, s]) => [id, s / weightSum]).sort((a, b) => b[1] - a[1]);
  const picked = ranked.filter(([id, share], k) => k === 0 || share >= 0.15 || confident.has(id)).slice(0, 3);
  return {
    codes: picked.map(([id]) => langIds.get(id)),
    scores: Object.fromEntries(ranked.slice(0, 5).map(([id, s]) => [langIds.get(id), +s.toFixed(3)])),
  };
}

// One batched Whisper pass over `idx` turns. Returns text + Whisper's own confidence per turn.
async function decodeBatch(audio, turns, idx, { languages, langIds, vocabIds, temperature = 0 }) {
  const tok = asr.tokenizer;
  const sot = tokenId(tok, '<|startoftranscript|>');
  const transcribe = tokenId(tok, '<|transcribe|>');
  const noTs = tokenId(tok, '<|notimestamps|>');
  const fixed = languages.length === 1;
  const prompt = fixed
    ? [...vocabIds, sot, tokenId(tok, `<|${languages[0]}|>`), transcribe, noTs]
    : [...vocabIds, sot]; // language / task chosen inside generation by LanguageControl
  const forced = fixed ? 0 : 3;

  const processors = new LogitsProcessorList();
  let control = null;
  if (!fixed) {
    const ids = languages.map((c) => tokenId(tok, `<|${c}|>`));
    control = new LanguageControl(prompt.length, ids, [transcribe, noTs]);
    processors.push(control);
  }
  const recorder = new TokenLogprobRecorder(tok.eos_token_id ?? tokenId(tok, '<|endoftext|>'), prompt.length + forced, idx.length, temperature);
  processors.push(recorder);

  const longest = Math.max(...idx.map((k) => clipSeconds(turns[k])));
  const maxNew = Math.min(447 - prompt.length, Math.ceil(longest * 9) + 24 + forced); // runaway-repetition guard
  const inputs = await featuresFor(idx.map((k) => clipFor(audio, turns[k])));
  const out = await asr.model.generate({
    inputs,
    decoder_input_ids: idx.map(() => prompt),
    begin_suppress_tokens: null, // its index is derived from the (batched) prompt length
    max_new_tokens: maxNew,
    logits_processor: processors,
    ...(temperature > 0 ? { do_sample: true, temperature, top_k: 0 } : {}),
  });
  const rows = out.tolist();
  const avg = recorder.finish(rows);
  const eos = BigInt(tok.eos_token_id ?? tokenId(tok, '<|endoftext|>'));

  return Promise.all(
    idx.map(async (k, j) => {
      const row = rows[j];
      const gen = row.slice(prompt.length);
      const text = tok.decode(gen, { skip_special_tokens: true }).trim();
      const language = fixed ? languages[0] : langIds.get(Number(gen[0])) || languages[0];
      const hitLimit = !gen.includes(eos) && gen.length >= maxNew;
      return { text, avgLogprob: avg[j], compression: await compressionRatio(text), language, hitLimit };
    }),
  );
}

const normWords = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}'\s]+/gu, ' ').split(/\s+/).filter(Boolean);

function needsRetry(r, turn, vocabWords) {
  if (!r.text) return false;
  if (r.hitLimit || r.compression > COMPRESSION_THRESHOLD || r.avgLogprob < LOGPROB_THRESHOLD) return true;
  // a short clip that comes back as just the "important words" is the prompt leaking, not speech
  if (vocabWords.size && turn.end - turn.start < 4) {
    const w = normWords(r.text);
    if (w.length >= 2 && w.every((x) => vocabWords.has(x))) return true;
  }
  return false;
}

// Better = no repetition problem first, then higher average log-probability.
const betterThan = (a, b) => {
  const okA = a.compression <= COMPRESSION_THRESHOLD && !a.hitLimit;
  const okB = b.compression <= COMPRESSION_THRESHOLD && !b.hitLimit;
  if (okA !== okB) return okA;
  return a.avgLogprob > b.avgLogprob;
};

async function transcribeTurns(audio, turns, opts) {
  const { batchSize, secondPass, onProgress } = opts;
  // Longest first, so each batch holds turns of similar length (a batch takes as long as its longest member).
  const order = turns.map((_, i) => i).sort((a, b) => turns[b].end - turns[b].start - (turns[a].end - turns[a].start));
  const total = turns.reduce((s, t) => s + (t.end - t.start), 0);
  const results = new Array(turns.length);
  let doneSec = 0;

  for (let i = 0; i < order.length; i += batchSize) {
    const idx = order.slice(i, i + batchSize);
    const batch = await decodeBatch(audio, turns, idx, opts);
    idx.forEach((k, j) => { results[k] = batch[j]; });
    doneSec += idx.reduce((s, k) => s + (turns[k].end - turns[k].start), 0);
    onProgress(doneSec, total);
  }

  const stats = { retried: 0, improved: 0 };
  if (secondPass) {
    const vocabWords = new Set(normWords((opts.vocabulary || []).join(' ')));
    let flagged = order.filter((k) => needsRetry(results[k], turns[k], vocabWords));
    stats.retried = flagged.length;
    if (flagged.length) {
      post({ type: 'stage', stage: 'review' });
      const flaggedSec = flagged.reduce((s, k) => s + (turns[k].end - turns[k].start), 0);
      let reviewed = 0;
      const attempts = [
        ...(opts.vocabIds.length ? [{ temperature: 0, vocabIds: [] }] : []), // without the prompt
        ...RETRY_TEMPERATURES.map((temperature) => ({ temperature })),
      ];
      for (const [n, attempt] of attempts.entries()) {
        if (!flagged.length) break;
        status(`Re-checking ${flagged.length} difficult part${flagged.length === 1 ? '' : 's'} (attempt ${n + 1} of ${attempts.length})…`);
        for (let i = 0; i < flagged.length; i += batchSize) {
          const idx = flagged.slice(i, i + batchSize);
          const batch = await decodeBatch(audio, turns, idx, { ...opts, ...attempt });
          idx.forEach((k, j) => {
            if (batch[j].text && betterThan(batch[j], results[k])) {
              if (!results[k].retriedBetter) stats.improved++;
              results[k] = { ...batch[j], retriedBetter: true };
            }
          });
          if (n === 0) {
            reviewed += idx.reduce((s, k) => s + (turns[k].end - turns[k].start), 0);
            post({ type: 'run-progress', done: reviewed, total: flaggedSec, part: 'review' });
          }
        }
        flagged = flagged.filter((k) => needsRetry(results[k], turns[k], vocabWords));
      }
    }
  }
  return { results, stats };
}

// Join hard-split pieces of the same turn, dropping the words transcribed twice in the overlap.
function mergeSplitPieces(turns, results) {
  let removed = 0;
  for (let i = 0; i + 1 < turns.length; i++) {
    if (!turns[i].hardEnd || !turns[i + 1].hardStart || turns[i].speaker !== turns[i + 1].speaker) continue;
    const m = mergeOverlap(results[i].text, results[i + 1].text);
    results[i] = { ...results[i], text: m.a };
    results[i + 1] = { ...results[i + 1], text: m.b };
    removed += m.removed;
  }
  return removed;
}

self.addEventListener('message', async (e) => {
  const { type } = e.data;
  if (type === 'detect') {
    post({ type: 'device', device: await detectDevice(e.data.forceCPU), reason: gpuReason });
    return;
  }
  if (type !== 'run') return;

  const {
    audio,
    mode = 'best',
    model: modelOverride = '',
    language = '',
    diarize: wantDiarize = true,
    numSpeakers = 0,
    vocabulary = [],
    preprocess: doPreprocess = true,
    secondPass,
  } = e.data;
  debugVoices = !!e.data.debug;
  if (e.data.turboVariant) turboVariant = e.data.turboVariant;
  try {
    // 0. analyse + clean the processing copy (the original file is untouched)
    post({ type: 'stage', stage: 'analyze' });
    const quality = analyzeAudio(audio);
    const prep = doPreprocess ? preprocess(audio, quality) : null;
    post({ type: 'quality', quality, preprocessing: prep });

    const dev0 = await detectDevice();
    const modelKey = resolveModel(mode, dev0, modelOverride);
    post({ type: 'stage', stage: 'load' });
    const dev = await loadModels(modelKey, wantDiarize, (p) => post({ type: 'progress', ...p }));
    post({ type: 'device', device: dev, reason: gpuReason });

    lap0.t = performance.now();
    let segments = null;
    post({ type: 'stage', stage: 'speakers' });
    if (wantDiarize) segments = await diarize(audio, numSpeakers);
    else status('Detecting speech…');

    const turns = buildTurns(audio, segments);
    if (!turns.length) throw new Error('No speech was found in this file.');

    post({ type: 'stage', stage: 'run' });
    const tok = asr.tokenizer;
    const langIds = languageTokens(tok);
    let languages;
    let langScores = null;
    if (language) {
      languages = [language]; // the user's choice is always respected
    } else if (Array.isArray(e.data.languages) && e.data.languages.length) {
      languages = e.data.languages; // testing / accuracy lab: force a candidate set (exercises per-turn choice)
    } else {
      status('Detecting language…');
      const det = await detectLanguages(audio, turns, langIds);
      languages = det.codes;
      langScores = det.scores;
      post({ type: 'language', language: languages[0], languages });
      lap(`language=${languages.join('+')} ${JSON.stringify(langScores)}`);
    }

    const vocabIds = vocabularyPrompt(tok, vocabulary);
    const heavy = asr.modelKey === 'turbo' || asr.modelKey === 'small';
    const batchSize = dev === 'webgpu' ? (heavy ? 4 : 16) : 2;
    const { results, stats } = await transcribeTurns(audio, turns, {
      batchSize,
      languages,
      langIds,
      vocabIds,
      vocabulary,
      secondPass: secondPass ?? mode === 'best',
      onProgress: (done, total) => {
        post({ type: 'run-progress', done, total });
        status(`Transcribing… ${Math.round((done / total) * 100)}% (${fmt(done)} of ${fmt(total)} of speech)`);
      },
    });
    const overlapWordsRemoved = mergeSplitPieces(turns, results);
    lap(`whisper (${turns.length} turns, retried ${stats.retried}, improved ${stats.improved})`);

    const lines = [];
    turns.forEach((t, i) => {
      const r = results[i];
      const dur = t.end - t.start;
      if (!r.text || (dur < 3 && HALLUCINATIONS.test(r.text))) return;
      lines.push({
        start: t.start,
        end: t.end,
        speaker: t.speaker,
        text: r.text,
        language: r.language,
        // Whisper's own signal, after any retry. Shown as "worth double-checking", never as a percentage.
        uncertain: r.avgLogprob < LOGPROB_THRESHOLD,
      });
    });
    const usedLangs = [...new Set(lines.map((l) => l.language))];
    post({
      type: 'complete',
      lines,
      language: languages.length === 1 ? languages[0] : usedLangs[0] || languages[0],
      ms: performance.now() - lap0.t,
      device: dev,
      stats: {
        mode,
        model: asr.modelKey,
        turboVariant: asr.modelKey === 'turbo' ? turboVariant : undefined,
        languages: usedLangs,
        languageScores: langScores,
        vocabularyTokens: Math.max(0, vocabIds.length - 1),
        turns: turns.length,
        hardSplits: turns.filter((t) => t.hardEnd).length,
        cleanSplits: turns.filter((t, i) => i + 1 < turns.length && !t.hardEnd && turns[i + 1].speaker === t.speaker && Math.abs(turns[i + 1].start - t.end) < 1e-6).length,
        overlapWordsRemoved,
        retried: stats.retried,
        improved: stats.improved,
        uncertain: lines.filter((l) => l.uncertain).length,
        confidence: (() => {
          const v = results.filter((r) => r.text).map((r) => r.avgLogprob).sort((x, y) => x - y);
          const c = results.map((r) => r.compression).sort((x, y) => y - x);
          return v.length ? { min: +v[0].toFixed(3), p10: +v[Math.floor(v.length * 0.1)].toFixed(3), median: +v[v.length >> 1].toFixed(3), maxCompression: +c[0].toFixed(2) } : null;
        })(),
        preprocessing: prep,
      },
    });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
});
