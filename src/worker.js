// Runs entirely in a Web Worker so the page stays responsive.
//
// Pipeline (same idea as pyannote's speaker-diarization-3.1, then Whisper on top):
//   1. pyannote segmentation on 10 s chunks  -> where speech is and which *local* voice (≤3 per chunk)
//   2. WeSpeaker ResNet34 voice fingerprint  -> one embedding per (chunk, local voice)
//   3. agglomerative clustering of embeddings -> global speakers across the whole file
//   4. cut the audio into speaker turns (silence skipped), Whisper transcribes them in batches
import {
  pipeline,
  AutoProcessor,
  AutoModel,
  AutoModelForAudioFrameClassification,
  Tensor,
} from '@huggingface/transformers';

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
const MAX_TURN_S = 28; // Whisper's window is 30 s
const PAD_S = 0.2; // extra context around each clip
const MIN_GAP_SPEECH_S = 1.0; // loud-but-unlabelled stretches shorter than this are ignored

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
async function detectDevice() {
  if (device) return device;
  try {
    if (self.navigator?.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        hasF16 = adapter.features?.has('shader-f16') ?? false;
        device = 'webgpu';
        return device;
      }
    }
  } catch {}
  device = 'wasm';
  return device;
}

function asrOptions(modelKey, dev) {
  if (dev === 'webgpu') {
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
  const key = `${modelKey}:${dev}`;
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
        dev = device = 'wasm';
        asr = await pipeline('automatic-speech-recognition', ASR_MODELS[modelKey], {
          ...asrOptions(modelKey, dev),
          progress_callback,
        });
      } else {
        throw err;
      }
    }
    asrKey = `${modelKey}:${dev}`;
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

function splitLong(turn, rms, out) {
  let { start } = turn;
  while (turn.end - start > MAX_TURN_S) {
    // cut at the quietest 100 ms frame in the last 5 s of the window
    const from = Math.floor((start + MAX_TURN_S - 5) * 10);
    const to = Math.floor((start + MAX_TURN_S) * 10);
    let best = to;
    for (let f = from; f < to && f < rms.length; f++) if (best >= rms.length || rms[f] < rms[best]) best = f;
    const cut = Math.min(best / 10, start + MAX_TURN_S);
    out.push({ ...turn, start, end: cut });
    start = cut;
  }
  out.push({ ...turn, start });
}

function buildTurns(audio, segments) {
  const rms = frameEnergy(audio);
  const runs = energyRuns(rms);

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
  for (const t of merged.filter((t) => t.end - t.start >= MIN_TURN_S)) splitLong(t, rms, turns);
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

const clipFor = (audio, t) =>
  audio.subarray(Math.max(0, Math.floor((t.start - PAD_S) * SR)), Math.min(audio.length, Math.ceil((t.end + PAD_S) * SR)));

// Ask the model which language it hears (it predicts a language token right after <|startoftranscript|>).
async function detectLanguage(audio, turns) {
  const tok = asr.tokenizer;
  const sample = [...turns].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
  if (!sample.length) return 'en';
  const inputs = await featuresFor(sample.map((t) => clipFor(audio, t)));
  const out = await asr.model.generate({
    inputs,
    decoder_input_ids: sample.map(() => [tokenId(tok, '<|startoftranscript|>')]),
    max_new_tokens: 1,
    begin_suppress_tokens: null, // its index is derived from the (batched) prompt length
  });
  const votes = new Map();
  for (const row of out.tolist()) {
    const m = /^<\|([a-z]{2,3})\|>$/.exec(tok.decode([row[row.length - 1]], { skip_special_tokens: false }));
    if (m) votes.set(m[1], (votes.get(m[1]) || 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'en';
}

async function transcribeTurns(audio, turns, language, batchSize) {
  const tok = asr.tokenizer;
  const prompt = [
    tokenId(tok, '<|startoftranscript|>'),
    tokenId(tok, `<|${language}|>`),
    tokenId(tok, '<|transcribe|>'),
    tokenId(tok, '<|notimestamps|>'),
  ];
  // Longest first, so each batch holds turns of similar length (a batch takes as long as its longest member).
  const order = turns.map((_, i) => i).sort((a, b) => turns[b].end - turns[b].start - (turns[a].end - turns[a].start));
  const total = turns.reduce((s, t) => s + (t.end - t.start), 0);
  const texts = new Array(turns.length).fill('');
  let doneSec = 0;
  const prof = { feat: 0, gen: 0, steps: 0, maxed: 0, batches: 0 };

  for (let i = 0; i < order.length; i += batchSize) {
    const idx = order.slice(i, i + batchSize);
    const longest = turns[idx[0]].end - turns[idx[0]].start + 2 * PAD_S;
    let t = performance.now();
    const inputs = await featuresFor(idx.map((k) => clipFor(audio, turns[k])));
    prof.feat += performance.now() - t;
    t = performance.now();
    const maxNew = Math.min(440, Math.ceil(longest * 9) + 24); // guard against runaway repetition
    const out = await asr.model.generate({
      inputs,
      decoder_input_ids: idx.map(() => prompt), // one row per clip
      begin_suppress_tokens: null, // its index is derived from the (batched) prompt length
      max_new_tokens: maxNew,
    });
    prof.gen += performance.now() - t;
    prof.batches++;
    prof.steps += out.dims[1] - prompt.length;
    if (out.dims[1] - prompt.length >= maxNew) prof.maxed++;
    const decoded = tok.batch_decode(out, { skip_special_tokens: true });
    idx.forEach((k, j) => {
      const text = decoded[j].trim();
      const dur = turns[k].end - turns[k].start;
      texts[k] = dur < 3 && HALLUCINATIONS.test(text) ? '' : text;
    });
    doneSec += idx.reduce((s, k) => s + (turns[k].end - turns[k].start), 0);
    post({ type: 'run-progress', done: doneSec, total });
    status(`Transcribing… ${Math.round((doneSec / total) * 100)}% (${fmt(doneSec)} of ${fmt(total)} of speech)`);
  }
  const durs = turns.map((t) => t.end - t.start).sort((a, b) => a - b);
  console.log('[timing] whisper profile', JSON.stringify({ ...prof, feat: Math.round(prof.feat), gen: Math.round(prof.gen), turns: turns.length, under2s: durs.filter((d) => d < 2).length, median: durs[durs.length >> 1]?.toFixed(1) }));
  return texts;
}

self.addEventListener('message', async (e) => {
  const { type } = e.data;
  if (type === 'detect') {
    post({ type: 'device', device: await detectDevice() });
    return;
  }
  if (type !== 'run') return;

  const { audio, model, language, diarize: wantDiarize, numSpeakers = 0 } = e.data;
  debugVoices = !!e.data.debug;
  try {
    post({ type: 'stage', stage: 'load' });
    const dev = await loadModels(model, wantDiarize, (p) => post({ type: 'progress', ...p }));
    post({ type: 'device', device: dev });

    lap0.t = performance.now();
    let segments = null;
    if (wantDiarize) {
      post({ type: 'stage', stage: 'speakers' });
      segments = await diarize(audio, numSpeakers);
    }

    post({ type: 'stage', stage: 'run' });
    const turns = buildTurns(audio, segments);
    if (!turns.length) throw new Error('No speech was found in this file.');

    let lang = language;
    if (!lang) {
      status('Detecting language…');
      lang = await detectLanguage(audio, turns);
      post({ type: 'language', language: lang });
      lap(`language=${lang}`);
    }

    const batchSize = dev === 'webgpu' ? (model === 'turbo' || model === 'small' ? 4 : 16) : 2;
    const texts = await transcribeTurns(audio, turns, lang, batchSize);
    lap(`whisper (${turns.length} turns)`);

    const lines = turns
      .map((t, i) => ({ start: t.start, end: t.end, speaker: t.speaker, text: texts[i] }))
      .filter((l) => l.text);
    post({ type: 'complete', lines, language: lang, ms: performance.now() - lap0.t, device: dev });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
});
