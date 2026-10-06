// Runs entirely in a Web Worker so the page stays responsive.
// Two models: Whisper (speech -> words with timestamps) and pyannote (who is speaking when).
import {
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
  WhisperTextStreamer,
} from '@huggingface/transformers';

const ASR_MODELS = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  turbo: 'onnx-community/whisper-large-v3-turbo_timestamped',
};
const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const SAMPLE_RATE = 16000;

// Whisper window settings (seconds). The pipeline slides a 30 s window with 5 s overlap each side.
const CHUNK_S = 30;
const STRIDE_S = CHUNK_S / 6;

// Speaker detection is run in windows so an hour of audio doesn't need gigabytes of RAM.
// Adjacent windows overlap; the overlap is used to match "who is who" across windows.
const DIAR_WINDOW_S = 240;
const DIAR_OVERLAP_S = 20;

let asr = null;
let asrKey = null; // `${model}:${device}`
let segProcessor = null;
let segModel = null;
let device = null;

const post = (msg) => self.postMessage(msg);

async function detectDevice() {
  if (device) return device;
  try {
    if (self.navigator?.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
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
        encoder_model: modelKey === 'turbo' ? 'fp16' : 'fp32',
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
        post({ type: 'status', text: 'WebGPU failed, falling back to CPU…' });
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

// ---------- transcription ----------
async function transcribe(audio, language, onProgress) {
  const windowLen = SAMPLE_RATE * CHUNK_S;
  const jump = windowLen - 2 * SAMPLE_RATE * STRIDE_S;
  const totalWindows = audio.length <= windowLen ? 1 : Math.ceil((audio.length - windowLen) / jump) + 1;
  let done = 0;
  let windowStart = 0;

  const streamer = new WhisperTextStreamer(asr.tokenizer, {
    skip_prompt: true,
    callback_function: () => {}, // we only want timestamps, not partial text
    on_chunk_start: (t) => onProgress?.({ done, total: totalWindows, seconds: windowStart + t }),
    on_finalize: () => {
      done++;
      windowStart = (done * jump) / SAMPLE_RATE;
      onProgress?.({ done, total: totalWindows, seconds: windowStart });
    },
  });

  onProgress?.({ done: 0, total: totalWindows, seconds: 0 });
  return asr(audio, {
    language: language || null,
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: CHUNK_S,
    stride_length_s: STRIDE_S,
    streamer,
  });
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

async function diarize(audio, onProgress) {
  const win = SAMPLE_RATE * DIAR_WINDOW_S;
  const ov = SAMPLE_RATE * DIAR_OVERLAP_S;
  if (audio.length <= win + ov) {
    onProgress?.({ done: 0, total: 1 });
    const segs = await diarizeWindow(audio);
    onProgress?.({ done: 1, total: 1 });
    return segs;
  }

  const starts = [];
  for (let s = 0; s < audio.length; s += win - ov) {
    starts.push(s);
    if (s + win >= audio.length) break;
  }

  let result = [];
  let prevSegs = null; // previous window's segments, already in global labels
  let nextGlobal = 0;

  for (let i = 0; i < starts.length; i++) {
    onProgress?.({ done: i, total: starts.length });
    const s0 = starts[i];
    const chunk = audio.subarray(s0, Math.min(audio.length, s0 + win));
    const offset = s0 / SAMPLE_RATE;
    const local = (await diarizeWindow(chunk)).map((seg) => ({ ...seg, start: seg.start + offset, end: seg.end + offset }));

    // Build local -> global label mapping.
    const map = new Map();
    if (prevSegs) {
      // Score co-occurrence inside the overlap region between the previous window's global labels and this window's local ones.
      const ovStart = offset;
      const ovEnd = offset + DIAR_OVERLAP_S;
      const score = new Map(); // `${local}|${global}` -> seconds
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
  onProgress?.({ done: starts.length, total: starts.length });
  return result;
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
    const [transcript, segments] = await Promise.all([
      transcribe(audio, language, (p) => post({ type: 'run-progress', part: 'asr', ...p })),
      wantDiarize ? diarize(audio, (p) => post({ type: 'run-progress', part: 'diar', ...p })) : Promise.resolve(null),
    ]);
    const ms = performance.now() - t0;

    post({
      type: 'complete',
      transcript: { text: transcript.text, chunks: transcript.chunks || [] },
      segments,
      ms,
      device: dev,
    });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
});
