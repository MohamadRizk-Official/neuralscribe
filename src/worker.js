// Runs entirely in a Web Worker so the page stays responsive.
// Two models: Whisper (speech -> words with timestamps) and pyannote (who is speaking when).
import {
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
} from '@huggingface/transformers';

const ASR_MODELS = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  turbo: 'onnx-community/whisper-large-v3-turbo_timestamped',
};
const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';

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

async function transcribe(audio, language) {
  const out = await asr(audio, {
    language: language || null,
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: 30,
  });
  return out;
}

async function diarize(audio) {
  const inputs = await segProcessor(audio);
  const { logits } = await segModel(inputs);
  const segments = segProcessor.post_process_speaker_diarization(logits, audio.length)[0];
  const id2label = segModel.config.id2label || {};
  return segments.map((s) => ({ ...s, label: id2label[s.id] ?? String(s.id) }));
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
      transcribe(audio, language),
      wantDiarize ? diarize(audio) : Promise.resolve(null),
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
