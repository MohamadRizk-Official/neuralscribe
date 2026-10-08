// Decoding helpers that plug into Transformers.js generation as logits processors.
//
// TokenLogprobRecorder — Whisper's own confidence signal: the average log-probability of the
//   tokens it chose (OpenAI's reference Whisper uses avg_logprob < -1.0 to decide a segment needs a
//   retry). Computed from the model's logits; nothing is estimated or invented.
// WhisperControl — the rules each clip is decoded under:
//   * reads Whisper's no-speech probability (the <|nospeech|> token after <|startoftranscript|>),
//   * forces language = English and task = transcribe (never translate),
//   * applies Whisper's token suppression list itself (the built-in one would hide <|nospeech|>),
//   * timestamp mode: Whisper's timestamp grammar, with timestamps limited to the clip's real length,
//   * a per-clip token budget derived from that clip's duration,
//   * a loop guard that stops a clip as soon as its output degenerates into a long run of the same
//     token(s) ("so, so, so, so…", "m m m m…") and remembers where the run began.
import { LogitsProcessor } from '@huggingface/transformers';
import { tailRepetition, isLoopRun } from './loops.js';

function logSoftmaxInto(src, dst, scale = 1) {
  let max = -Infinity;
  for (let i = 0; i < src.length; i++) if (src[i] * scale > max) max = src[i] * scale;
  let sum = 0;
  for (let i = 0; i < src.length; i++) sum += Math.exp(src[i] * scale - max);
  const lse = max + Math.log(sum);
  for (let i = 0; i < src.length; i++) dst[i] = src[i] * scale - lse;
}

export class TokenLogprobRecorder extends LogitsProcessor {
  // temperature: when sampling, the library has already divided the logits by it before custom
  // processors run; multiplying back keeps log-probs comparable with the greedy pass.
  constructor(eosId, promptLen, batch, temperature = 0) {
    super();
    this.scale = temperature > 0 ? temperature : 1;
    this.eosId = BigInt(eosId);
    this.promptLen = promptLen;
    this.prev = Array.from({ length: batch }, () => null);
    this.sum = new Float64Array(batch);
    this.count = new Uint32Array(batch);
    this.done = new Uint8Array(batch);
  }
  _call(input_ids, logits) {
    for (let i = 0; i < input_ids.length; i++) {
      const row = input_ids[i];
      // score the token chosen at the previous step, using the distribution we saved then
      if (this.prev[i] && !this.done[i] && row.length > this.promptLen) {
        const tok = row[row.length - 1];
        this.sum[i] += this.prev[i][Number(tok)];
        this.count[i]++;
        if (tok === this.eosId) this.done[i] = 1;
      }
      if (this.done[i]) continue;
      const data = logits[i].data;
      if (!this.prev[i]) this.prev[i] = new Float32Array(data.length);
      logSoftmaxInto(data, this.prev[i], this.scale);
    }
    return logits;
  }
  // the last chosen token is only known once generation has returned
  finish(sequences) {
    sequences.forEach((row, i) => {
      if (this.done[i] || !this.prev[i] || row.length <= this.promptLen) return;
      const tok = row[row.length - 1];
      this.sum[i] += this.prev[i][Number(tok)];
      this.count[i]++;
    });
    return Array.from(this.sum, (s, i) => (this.count[i] ? s / this.count[i] : 0));
  }
}

// Leave only `ids` possible. Whisper's generation config suppresses the task tokens
// (<|transcribe|> etc. are normally part of the prompt, never generated), so a forced token may
// arrive as -Infinity; it is made finite again, otherwise every token would be impossible.
function forceAmong(data, ids) {
  const keep = ids.map((id) => (Number.isFinite(data[id]) ? data[id] : 0));
  data.fill(-Infinity);
  ids.forEach((id, k) => { data[id] = keep[k]; });
}

function softmaxProb(data, id) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += Math.exp(data[i] - max);
  return Math.exp(data[id] - max) / sum;
}

export class WhisperControl extends LogitsProcessor {
  /**
   * @param {object} o
   * @param {number} o.promptLen       tokens given as decoder_input_ids (vocabulary prompt + <|startoftranscript|>)
   * @param {number[]} o.forced        tokens forced right after the prompt (<|en|>, <|transcribe|>[, <|notimestamps|>])
   * @param {number|null} o.noSpeechId <|nospeech|>
   * @param {number[]} o.suppress      Whisper's suppress_tokens
   * @param {number} o.eosId
   * @param {number[]} o.budgets       max text tokens per row
   * @param {object|null} o.timestamps { begin, noTimestampsId, maxIndex[] (per row), maxInitialIndex }
   */
  constructor({ promptLen, forced, noSpeechId, suppress, eosId, budgets, timestamps = null, blankId = null }) {
    super();
    Object.assign(this, { promptLen, forced, noSpeechId, suppress, eosId, budgets, timestamps, blankId });
    this.textStart = promptLen + forced.length;
    this.noSpeech = [];
    this.stopped = []; // 'loop' | 'budget' | undefined
    this.loopAt = []; // index (in this row's text tokens) where a detected loop began
  }
  _call(input_ids, logits) {
    const eos = this.eosId;
    for (let i = 0; i < input_ids.length; i++) {
      const row = input_ids[i];
      const data = logits[i].data;
      const pos = row.length - this.promptLen;
      if (pos === 0 && this.noSpeechId != null) this.noSpeech[i] = softmaxProb(data, this.noSpeechId);
      if (pos < this.forced.length) { forceAmong(data, [this.forced[pos]]); continue; }

      const gen = [];
      let ended = false;
      for (let k = this.textStart; k < row.length; k++) {
        const t = Number(row[k]);
        if (t === eos) { ended = true; break; }
        gen.push(t);
      }
      // A finished row keeps being stepped until the whole batch is done: keep it at <|endoftext|>.
      if (ended || this.stopped[i]) { forceAmong(data, [eos]); continue; }

      for (const id of this.suppress) data[id] = -Infinity;
      const ts = this.timestamps;
      const text = ts ? gen.filter((t) => t < ts.begin) : gen;
      if (gen.length === 0) {
        // like Whisper's begin_suppress_tokens: don't start with a blank or end immediately
        if (this.blankId != null) data[this.blankId] = -Infinity;
        if (!ts) data[eos] = -Infinity;
      }

      if (text.length >= this.budgets[i]) { this.stopped[i] = 'budget'; forceAmong(data, [eos]); continue; }
      const rep = tailRepetition(text);
      if (rep && isLoopRun(rep.unit, rep.reps)) {
        this.stopped[i] = 'loop';
        this.loopAt[i] = rep.start;
        forceAmong(data, [eos]);
        continue;
      }
      if (ts) this.timestampRules(gen, data, i);
    }
    return logits;
  }
  // Whisper's timestamp grammar (as in OpenAI's ApplyTimestampRules), plus: no timestamp past the end of
  // this clip's real audio, and no new segment once a segment has closed at the end of the audio.
  timestampRules(gen, data, i) {
    const { begin, noTimestampsId, maxIndex, maxInitialIndex } = this.timestamps;
    const eos = this.eosId;
    data[noTimestampsId] = -Infinity;
    const last = maxIndex[i];
    data.fill(-Infinity, begin + last + 1);
    if (gen.length === 0) {
      data.fill(-Infinity, 0, begin); // must start with a timestamp
      data.fill(-Infinity, begin + Math.min(maxInitialIndex, last) + 1);
      return;
    }
    const lastWasTs = gen[gen.length - 1] >= begin;
    const penultWasTs = gen.length < 2 || gen[gen.length - 2] >= begin;
    const stamps = gen.filter((t) => t >= begin);
    if (lastWasTs) {
      if (penultWasTs) data.fill(-Infinity, begin); // after a pair of timestamps: text (or end)
      else {
        data.fill(-Infinity, 0, eos); // a segment just closed: next is a timestamp or the end
        if (stamps[stamps.length - 1] - begin >= last - 25) { forceAmong(data, [eos]); return; } // closed at the end of the audio
      }
    }
    // timestamps never go backwards
    if (stamps.length) {
      const floor = lastWasTs && !penultWasTs ? stamps[stamps.length - 1] : stamps[stamps.length - 1] + 1;
      data.fill(-Infinity, begin, Math.min(floor, data.length));
    }
    // if a timestamp is more likely than any single text token, emit a timestamp
    let max = -Infinity;
    for (let k = 0; k < data.length; k++) if (data[k] > max) max = data[k];
    if (!Number.isFinite(max)) return;
    let sumTs = 0, sumAll = 0, maxText = -Infinity;
    for (let k = 0; k < data.length; k++) {
      const e = Math.exp(data[k] - max);
      sumAll += e;
      if (k >= begin) sumTs += e;
      else if (data[k] > maxText) maxText = data[k];
    }
    const lse = max + Math.log(sumAll);
    if (sumTs > 0 && Math.log(sumTs) + max - lse > maxText - lse) data.fill(-Infinity, 0, begin);
  }
}

// zlib-style compression ratio of the text. Whisper's reference implementation treats > 2.4 as a
// sign of repetitive hallucination ("the the the…") and retries the segment.
export async function compressionRatio(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < 20) return 1;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = await new Response(stream).arrayBuffer();
  return bytes.length / compressed.byteLength;
}
