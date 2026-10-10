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
//   5. V1 is English only: every clip is decoded as English speech -> English text (never translated)
//   6. Whisper transcribes the turns in batches (optionally primed with "important words"), each clip
//      under WhisperControl (engine/decoding.js): no-speech probability, a token budget from the clip's
//      own length, and a guard that stops runaway repetition; output is read only up to <|endoftext|>
//   7. Best Accuracy: turns Whisper itself was unsure about (avg log-prob, repetition, a stopped loop)
//      are retried; clips Whisper judges to be non-speech produce no text
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
import { TokenLogprobRecorder, WhisperControl, compressionRatio } from './engine/decoding.js';
import { tailRepetition, cutTextLoop, wordKeys, tidy, tidyCut } from './engine/loops.js';
import { SR, UNKNOWN, configureDiarizer, diarize, frameEnergy, energyRuns, subtract } from './engine/diarize.js';

const ASR_MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo',
};
const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

// Turn building
const MIN_TURN_S = 0.3; // ignore blips shorter than this
const MERGE_GAP_S = 1.5; // join same-speaker speech separated by less than this
const MAX_TURN_S = 27.5; // Whisper's window is 30 s; leaves room for padding / overlap on both sides
const MIN_SPLIT_S = 16; // when a turn must be split, look for the best pause between 16 s and 27.5 s
const PAD_S = 0.2; // extra context around each clip
const OVERLAP_S = 1.0; // when a split can't land on a pause, both pieces share this much audio

// Whisper's own quality signals (same thresholds as OpenAI's reference implementation)
const LOGPROB_THRESHOLD = -1.0; // average token log-probability below this = model unsure
const COMPRESSION_THRESHOLD = 2.4; // highly repetitive output ("the the the…") = likely hallucination
const RETRY_TEMPERATURES = [0.2, 0.5];
const MAX_PROMPT_TOKENS = 100; // "important words" prompt budget (Whisper allows ~224)
const NO_SPEECH_THRESHOLD = 0.6; // Whisper's own "this clip has no speech" probability (OpenAI uses 0.6)
const TOKENS_PER_S = 7; // ceiling on text tokens per second of audio (fast English speech is ~4–5)
const DECODE_TIMESTAMPS = false; // Whisper timestamp mode; accuracy lab can switch it on (e.data.timestamps)

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

// ---------- 4. turns ----------
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
    for (const r of runs) for (const g of subtract(r, speech)) items.push({ ...g, speaker: UNKNOWN, fill: true });
  } else {
    items = runs.map((r) => ({ ...r, speaker: 'SPEAKER_00' }));
  }
  items.sort((a, b) => a.start - b.start);

  // Recognised speech and "only loud" stretches (fills: tapping, noise, breath, or a missed word) are
  // never merged into one clip: a voice clip that runs on into noise is where Whisper invents text.
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    // overlapping speech (several people at once) stays its own clip too, never merged into a speaker's turn
    if (last && last.speaker === it.speaker && !!last.fill === !!it.fill && !!last.overlap === !!it.overlap && it.start - last.end <= MERGE_GAP_S) last.end = Math.max(last.end, it.end);
    else merged.push({ ...it, fill: !!it.fill, overlap: !!it.overlap });
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

// "Important words" become a Whisper prompt: <|startofprev|> + " Hadi Salame, SparkScribe, …"
// which biases spelling towards them (same mechanism as OpenAI's initial_prompt).
function vocabularyPrompt(tok, words) {
  const list = (words || []).map((w) => String(w).trim()).filter(Boolean);
  if (!list.length) return [];
  let ids = tok.encode(' ' + list.join(', ') + '.', { add_special_tokens: false });
  if (ids.length > MAX_PROMPT_TOKENS) ids = ids.slice(-MAX_PROMPT_TOKENS);
  return [tokenId(tok, '<|startofprev|>'), ...ids];
}

// One batched Whisper pass over `idx` turns. Returns text + Whisper's own signals per turn.
// Every clip is decoded as English speech -> English text (task "transcribe", never "translate").
async function decodeBatch(audio, turns, idx, { vocabIds, temperature = 0, timestamps = DECODE_TIMESTAMPS }) {
  const tok = asr.tokenizer;
  const eosId = tok.eos_token_id ?? tokenId(tok, '<|endoftext|>');
  const noTs = tokenId(tok, '<|notimestamps|>');
  // <|startoftranscript|> is the prompt; language/task are forced token by token so the no-speech
  // probability can be read at the first step (it is defined right after <|startoftranscript|>).
  const prompt = [...vocabIds, tokenId(tok, '<|startoftranscript|>')];
  const forced = [tokenId(tok, '<|en|>'), tokenId(tok, '<|transcribe|>'), ...(timestamps ? [] : [noTs])];
  const secs = idx.map((k) => clipSeconds(turns[k]));
  const tsBegin = noTs + 1;

  const control = new WhisperControl({
    promptLen: prompt.length,
    forced,
    noSpeechId: noSpeechToken(tok),
    suppress: suppressList(),
    eosId,
    blankId: tok.encode(' ', { add_special_tokens: false })[0] ?? null,
    // at most ~7 tokens per second of audio (fast speech is ~4–5): a clip can't "say" more than that
    budgets: secs.map((s) => Math.ceil(s * TOKENS_PER_S) + 12),
    timestamps: timestamps ? { begin: tsBegin, noTimestampsId: noTs, maxIndex: secs.map((s) => Math.round(s / 0.02)), maxInitialIndex: 50 } : null,
  });
  const recorder = new TokenLogprobRecorder(eosId, prompt.length + forced.length, idx.length, temperature);
  const processors = new LogitsProcessorList();
  processors.push(control);
  processors.push(recorder);

  const longest = Math.max(...secs);
  const maxNew = Math.min(447 - prompt.length, forced.length + Math.ceil(longest * TOKENS_PER_S) + 12 + (timestamps ? 64 : 0) + 2);
  const inputs = await featuresFor(idx.map((k) => clipFor(audio, turns[k])));
  const out = await asr.model.generate({
    inputs,
    decoder_input_ids: idx.map(() => prompt),
    begin_suppress_tokens: null, // handled per row by WhisperControl
    suppress_tokens: null, // applied by WhisperControl after it has read the no-speech probability
    max_new_tokens: maxNew,
    logits_processor: processors,
    ...(temperature > 0 ? { do_sample: true, temperature, top_k: 0 } : {}),
  });
  const rows = out.tolist();
  const avg = recorder.finish(rows);

  return Promise.all(
    idx.map(async (k, j) => {
      // Read each row only up to its own <|endoftext|>. Transformers.js keeps generating for rows that
      // have finished until the whole batch is done; whatever follows <|endoftext|> is not transcript
      // (reading it is what produced "so, so, so…" / "m m m…" after the last real word).
      const gen = [];
      for (const t of rows[j].slice(prompt.length + forced.length)) {
        const n = Number(t);
        if (n === eosId) break;
        gen.push(n);
      }
      const textIds = gen.filter((t) => t < tsBegin);
      const stopped = control.stopped[j];
      let text = tok.decode(textIds, { skip_special_tokens: true });
      let loop = null;
      if (stopped === 'loop') {
        // the guard stopped a runaway repetition: remove the whole run of that unit from the end
        const r = tailRepetition(textIds);
        const unit = tok.decode(textIds.slice(r.start, r.start + r.unit), { skip_special_tokens: true });
        const cut = cutTextLoop(text, wordKeys(unit));
        if (cut) ({ text, loop } = cut);
      } else {
        const cut = cutTextLoop(text); // the same check on words, for runs the token check didn't stop
        if (cut) ({ text, loop } = cut);
      }
      text = loop ? tidyCut(text) : tidy(text);
      return {
        text,
        avgLogprob: avg[j],
        compression: await compressionRatio(text),
        noSpeech: control.noSpeech[j] ?? 0,
        loop,
        hitLimit: stopped === 'budget',
        language: 'en',
      };
    }),
  );
}

let suppressCache = null;
function suppressList() {
  if (!suppressCache) suppressCache = (asr.model.generation_config?.suppress_tokens || []).filter((id) => id !== noSpeechToken(asr.tokenizer));
  return suppressCache;
}
function noSpeechToken(tok) {
  for (const name of ['<|nospeech|>', '<|nocaptions|>']) {
    const id = tok.convert_tokens_to_ids(name);
    if (id != null && id !== tok.unk_token_id) return id;
  }
  return null;
}

const normWords = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}'\s]+/gu, ' ').split(/\s+/).filter(Boolean);

// Whisper says there is no speech, and what it produced anyway is unconvincing (OpenAI's rule), or the
// stretch was only "loud" (never recognised as a voice by the speech detector) and the text has no
// real support: Whisper leans towards no-speech, isn't confident, or produced one of its stock
// "silence" phrases. (large-v3-turbo's no-speech probability is ~0 even on pure humming, so for
// Best Accuracy the confidence and stock-phrase checks are what catch non-speech.)
const FILL_MIN_LOGPROB = -0.5;
// A whole clip that comes back as one low-confidence "word" ("Oum." for a hum) is a sound, not speech;
// a real one-word reply ("Yes.", "Okay.") is decoded with far higher confidence.
const SINGLE_WORD_MIN_LOGPROB = -0.7;
function isNoSpeech(r, turn) {
  if (r.noSpeech > NO_SPEECH_THRESHOLD && r.avgLogprob < LOGPROB_THRESHOLD) return true;
  if (turn.fill && (r.noSpeech > 0.5 || r.avgLogprob < FILL_MIN_LOGPROB || HALLUCINATIONS.test(r.text))) return true;
  if (r.text.split(/\s+/).filter(Boolean).length === 1 && r.avgLogprob < SINGLE_WORD_MIN_LOGPROB) return true;
  return false;
}

function needsRetry(r, turn, vocabWords) {
  if (!r.text) return false;
  if (isNoSpeech(r, turn)) return false; // silence/noise: nothing to recover
  if (r.loop || r.hitLimit || r.compression > COMPRESSION_THRESHOLD || r.avgLogprob < LOGPROB_THRESHOLD) return true;
  // a short clip that comes back as just the "important words" is the prompt leaking, not speech
  if (vocabWords.size && turn.end - turn.start < 4) {
    const w = normWords(r.text);
    if (w.length >= 2 && w.every((x) => vocabWords.has(x))) return true;
  }
  return false;
}

// Better = no repetition problem first, then higher average log-probability. (A loop is very
// confident — high log-probability — so "no loop" has to be decided before confidence.)
const betterThan = (a, b) => {
  const okA = a.compression <= COMPRESSION_THRESHOLD && !a.hitLimit && !a.loop;
  const okB = b.compression <= COMPRESSION_THRESHOLD && !b.hitLimit && !b.loop;
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

  const trace = opts.trace; // accuracy lab only: every attempt per turn
  const note = (k, attempt, r, chosen) => trace?.push({ turn: k, attempt, text: r.text, avgLogprob: +r.avgLogprob.toFixed(3), compression: +r.compression.toFixed(2), noSpeech: +(r.noSpeech ?? 0).toFixed(3), loop: r.loop, hitLimit: r.hitLimit, chosen });
  for (let i = 0; i < order.length; i += batchSize) {
    const idx = order.slice(i, i + batchSize);
    const batch = await decodeBatch(audio, turns, idx, opts);
    idx.forEach((k, j) => { results[k] = batch[j]; note(k, 'greedy', batch[j], true); });
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
            note(k, attempt.temperature ? `t=${attempt.temperature}` : 'no-prompt', batch[j], !!(batch[j].text && betterThan(batch[j], results[k])));
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
    configureDiarizer({ segModel, segProcessor, segDevice, embModel, embProcessor, embDevice, Tensor, debugVoices, status, lap, post });
    let segments = null;
    let diarStats = null;
    post({ type: 'stage', stage: 'speakers' });
    if (wantDiarize) ({ segments, stats: diarStats } = await diarize(audio, numSpeakers));
    else status('Detecting speech…');

    const turns = buildTurns(audio, segments);
    if (!turns.length) {
      // silence / noise only: an empty transcript, never invented words (and not an error)
      post({ type: 'complete', lines: [], language: 'en', ms: performance.now() - lap0.t, device: dev, stats: { mode, model: asr.modelKey, languages: ['en'], turns: 0, noSpeechFound: true, preprocessing: prep, speakers: diarStats } });
      return;
    }

    post({ type: 'stage', stage: 'run' });
    const tok = asr.tokenizer;
    // V1 is English only: every clip is decoded as English speech -> English text. No language
    // detection, never Whisper's "translate" task.
    post({ type: 'language', language: 'en', languages: ['en'] });

    const vocabIds = vocabularyPrompt(tok, vocabulary);
    const heavy = asr.modelKey === 'turbo' || asr.modelKey === 'small';
    const batchSize = dev === 'webgpu' ? (heavy ? 4 : 16) : 2;
    const asrTrace = e.data.trace ? [] : null;
    const { results, stats } = await transcribeTurns(audio, turns, {
      trace: asrTrace,
      batchSize,
      vocabIds,
      ...(typeof e.data.timestamps === 'boolean' && { timestamps: e.data.timestamps }),
      vocabulary,
      secondPass: secondPass ?? mode === 'best',
      onProgress: (done, total) => {
        post({ type: 'run-progress', done, total });
        status(`Transcribing… ${Math.round((done / total) * 100)}% (${fmt(done)} of ${fmt(total)} of speech)`);
      },
    });
    const beforeMerge = asrTrace ? results.map((r) => r.text) : null;
    const overlapWordsRemoved = mergeSplitPieces(turns, results);
    lap(`whisper (${turns.length} turns, retried ${stats.retried}, improved ${stats.improved})`);

    const lines = [];
    const dropped = { noSpeech: 0, hallucination: 0 };
    turns.forEach((t, i) => {
      const r = results[i];
      const dur = t.end - t.start;
      if (!r.text) return;
      if (isNoSpeech(r, t)) { dropped.noSpeech++; return; }
      if (dur < 3 && HALLUCINATIONS.test(r.text)) { dropped.hallucination++; return; }
      lines.push({
        start: t.start,
        end: t.end,
        speaker: t.speaker,
        ...(t.overlap && { overlap: true }), // several people at once: shown as overlapping speech
        text: r.text,
        language: 'en',
        // Whisper's own signals, after any retry: low confidence, or a runaway repetition that was cut.
        // Shown as "worth double-checking", never as a percentage.
        uncertain: r.avgLogprob < LOGPROB_THRESHOLD || !!r.loop,
      });
    });
    post({
      type: 'complete',
      lines,
      language: 'en',
      ms: performance.now() - lap0.t,
      device: dev,
      stats: {
        mode,
        model: asr.modelKey,
        turboVariant: asr.modelKey === 'turbo' ? turboVariant : undefined,
        languages: ['en'],
        loopsCut: results.filter((r) => r.loop).length,
        loopWordsRemoved: results.reduce((s, r) => s + (r.loop?.removedWords || 0), 0),
        droppedAsNoSpeech: dropped.noSpeech,
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
        speakers: diarStats,
        ...(asrTrace && {
          trace: {
            turns: turns.map((t, i) => ({ i, start: +t.start.toFixed(2), end: +t.end.toFixed(2), speaker: t.speaker, fill: !!t.fill, hardStart: !!t.hardStart, hardEnd: !!t.hardEnd, noSpeech: +(results[i].noSpeech ?? 0).toFixed(3), loop: results[i].loop, beforeMerge: beforeMerge[i], afterMerge: results[i].text })),
            attempts: asrTrace,
          },
        }),
      },
    });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
});
