// Runs entirely in a Web Worker so the page stays responsive.
//
// Pipeline:
//   1. pyannote segmentation  -> who is speaking when (fast: seconds per hour of audio)
//   2. cut the audio into speaker turns, skipping silence
//   3. Whisper decodes many turns at once (batched) -> text for each turn
//
// Transcribing per speaker turn (instead of sliding a window over everything) is what makes this
// fast: silence is never processed, windows don't overlap, and the GPU decodes a whole batch of
// turns for the same per-step cost as one.
import {
  pipeline,
  AutoProcessor,
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
const SR = 16000;
const UNKNOWN = 'Unknown';

// Turn building
const MIN_TURN_S = 0.3; // ignore blips shorter than this
const MERGE_GAP_S = 0.8; // join same-speaker segments separated by less than this
const MAX_TURN_S = 28; // Whisper's window is 30 s
const PAD_S = 0.2; // extra context around each clip
const MIN_GAP_SPEECH_S = 0.6; // loud-but-unlabelled stretches shorter than this are ignored

// Speaker detection windows (keeps memory flat on hour-long files)
const DIAR_WINDOW_S = 240;
const DIAR_OVERLAP_S = 20;

let asr = null;
let asrKey = null; // `${model}:${device}`
let segProcessor = null;
let segModel = null;
let device = null;
let hasF16 = false; // WebGPU half-precision support

const post = (msg) => self.postMessage(msg);
const status = (text) => post({ type: 'status', text });
const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  if (diarize && (!segProcessor || !segModel)) {
    [segProcessor, segModel] = await Promise.all([
      AutoProcessor.from_pretrained(SEG_MODEL, { progress_callback }),
      AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, {
        device: 'wasm',
        dtype: 'fp32',
        progress_callback,
      }),
    ]);
  }
  return dev;
}

// ---------- speaker detection ----------
async function diarizeWindow(samples) {
  const inputs = await segProcessor(samples);
  const { logits } = await segModel(inputs);
  const segs = segProcessor.post_process_speaker_diarization(logits, samples.length)[0];
  const id2label = segModel.config.id2label || {};
  return segs.map((s) => ({ start: s.start, end: s.end, confidence: s.confidence, label: id2label[s.id] ?? String(s.id) }));
}

// Splits combined labels ("SPEAKER_00 + SPEAKER_01") into their parts.
const parts = (label) => (label === 'NO_SPEAKER' ? [] : label.split(' + '));

async function diarize(audio) {
  const win = SR * DIAR_WINDOW_S;
  const ov = SR * DIAR_OVERLAP_S;
  if (audio.length <= win + ov) return diarizeWindow(audio);

  const starts = [];
  for (let s = 0; s < audio.length; s += win - ov) {
    starts.push(s);
    if (s + win >= audio.length) break;
  }

  let result = [];
  let prevSegs = null; // previous window's segments, already in global labels
  let nextGlobal = 0;

  for (let i = 0; i < starts.length; i++) {
    status(`Detecting speakers… ${i + 1}/${starts.length}`);
    const s0 = starts[i];
    const chunk = audio.subarray(s0, Math.min(audio.length, s0 + win));
    const offset = s0 / SR;
    const local = (await diarizeWindow(chunk)).map((seg) => ({ ...seg, start: seg.start + offset, end: seg.end + offset }));

    // Build local -> global label mapping using the overlap with the previous window.
    const map = new Map();
    if (prevSegs) {
      const ovStart = offset;
      const ovEnd = offset + DIAR_OVERLAP_S;
      const score = new Map(); // `${local}|${global}` -> seconds of co-occurrence
      for (const a of local) {
        for (const la of parts(a.label)) {
          for (const b of prevSegs) {
            const o = Math.min(a.end, b.end, ovEnd) - Math.max(a.start, b.start, ovStart);
            if (o <= 0) continue;
            for (const gb of parts(b.label)) {
              const k = `${la}|${gb}`;
              score.set(k, (score.get(k) || 0) + o);
            }
          }
        }
      }
      // Greedy one-to-one assignment by strongest overlap.
      const usedGlobal = new Set();
      [...score.entries()]
        .sort((x, y) => y[1] - x[1])
        .forEach(([k, v]) => {
          const [l, g] = k.split('|');
          if (v < 0.5 || map.has(l) || usedGlobal.has(g)) return;
          map.set(l, g);
          usedGlobal.add(g);
        });
    }
    const toGlobal = (l) => {
      if (!map.has(l)) map.set(l, `SPEAKER_${String(nextGlobal++).padStart(2, '0')}`);
      return map.get(l);
    };
    const globalSegs = local.map((seg) => ({
      ...seg,
      label: seg.label === 'NO_SPEAKER' ? 'NO_SPEAKER' : parts(seg.label).map(toGlobal).join(' + '),
    }));

    // Stitch: keep previous window up to the middle of the overlap, this window after it.
    if (prevSegs) {
      const cut = offset + DIAR_OVERLAP_S / 2;
      result = result.filter((seg) => seg.start < cut).map((seg) => ({ ...seg, end: Math.min(seg.end, cut) }));
      for (const seg of globalSegs) {
        if (seg.end <= cut) continue;
        result.push({ ...seg, start: Math.max(seg.start, cut) });
      }
    } else {
      result = globalSegs;
    }
    prevSegs = globalSegs;
  }
  return result;
}

// ---------- turn building ----------
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
    for (let f = from; f < to && f < rms.length; f++) if (rms[f] < rms[best] || best >= rms.length) best = f;
    const cut = Math.min(best / 10, start + MAX_TURN_S);
    out.push({ ...turn, start, end: cut });
    start = cut;
  }
  out.push({ ...turn, start });
}

function buildTurns(audio, segments) {
  const dur = audio.length / SR;
  const rms = frameEnergy(audio);
  const runs = energyRuns(rms);

  let items;
  if (segments) {
    const speech = segments
      .filter((s) => s.label !== 'NO_SPEAKER')
      .map((s) => ({ start: s.start, end: Math.min(s.end, dur), speaker: parts(s.label)[0] }))
      .sort((a, b) => a.start - b.start);
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

// ---------- Whisper ----------
const tokenId = (tok, name) => tok.convert_tokens_to_ids(name);

async function featuresFor(clips) {
  const feats = await Promise.all(clips.map((c) => asr.processor(c)));
  const [, mels, frames] = feats[0].input_features.dims;
  const data = new Float32Array(clips.length * mels * frames);
  feats.forEach((f, i) => data.set(f.input_features.data, i * mels * frames));
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

  for (let i = 0; i < order.length; i += batchSize) {
    const idx = order.slice(i, i + batchSize);
    const longest = turns[idx[0]].end - turns[idx[0]].start + 2 * PAD_S;
    const inputs = await featuresFor(idx.map((k) => clipFor(audio, turns[k])));
    const out = await asr.model.generate({
      inputs,
      decoder_input_ids: idx.map(() => prompt), // one row per clip
      begin_suppress_tokens: null, // its index is derived from the (batched) prompt length
      max_new_tokens: Math.min(440, Math.ceil(longest * 9) + 24), // guard against runaway repetition
    });
    const decoded = tok.batch_decode(out, { skip_special_tokens: true });
    idx.forEach((k, j) => { texts[k] = decoded[j].trim(); });
    doneSec += idx.reduce((s, k) => s + (turns[k].end - turns[k].start), 0);
    status(`Transcribing… ${Math.round((doneSec / total) * 100)}% (${fmt(doneSec)} of ${fmt(total)} of speech) — you can leave this tab open in the background.`);
  }
  return texts;
}

self.addEventListener('message', async (e) => {
  const { type } = e.data;
  if (type === 'detect') {
    post({ type: 'device', device: await detectDevice() });
    return;
  }
  if (type !== 'run') return;

  const { audio, model, language, diarize: wantDiarize } = e.data;
  try {
    post({ type: 'stage', stage: 'load' });
    const dev = await loadModels(model, wantDiarize, (p) => post({ type: 'progress', ...p }));
    post({ type: 'device', device: dev });

    post({ type: 'stage', stage: 'run' });
    const t0 = performance.now();
    const lap = (label) => console.log(`[timing] ${label}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

    let segments = null;
    if (wantDiarize) {
      status('Detecting speakers…');
      segments = await diarize(audio);
      lap('speakers');
    }

    const turns = buildTurns(audio, segments);
    if (!turns.length) throw new Error('No speech was found in this file.');

    let lang = language;
    if (!lang) {
      status('Detecting language…');
      lang = await detectLanguage(audio, turns);
      post({ type: 'language', language: lang });
      lap(`language=${lang}`);
    }

    const batchSize = dev === 'webgpu' ? (model === 'turbo' || model === 'small' ? 4 : 8) : 2;
    const texts = await transcribeTurns(audio, turns, lang, batchSize);
    lap('whisper');

    const lines = turns
      .map((t, i) => ({ start: t.start, end: t.end, speaker: t.speaker, text: texts[i] }))
      .filter((l) => l.text);
    post({ type: 'complete', lines, language: lang, ms: performance.now() - t0, device: dev });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
});
