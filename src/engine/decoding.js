// Decoding helpers that plug into Transformers.js generation as logits processors.
//
// TokenLogprobRecorder — Whisper's own confidence signal: the average log-probability of the
//   tokens it chose (OpenAI's reference Whisper uses avg_logprob < -1.0 to decide a segment needs a
//   retry). Computed from the model's logits; nothing is estimated or invented.
// LanguageControl — lets Whisper choose the language of each clip itself, but only among the
//   languages detected for this recording, then forces the "transcribe" task (never translate).
import { LogitsProcessor } from '@huggingface/transformers';

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

export class LanguageControl extends LogitsProcessor {
  // allowedLangIds: token ids of the languages this clip may be in; taskIds: [transcribe, notimestamps]
  constructor(promptLen, allowedLangIds, taskIds) {
    super();
    this.promptLen = promptLen;
    this.allowed = allowedLangIds;
    this.taskIds = taskIds;
    this.langProbs = []; // per row: Map(langId -> probability among the allowed languages)
  }
  _call(input_ids, logits) {
    for (let i = 0; i < input_ids.length; i++) {
      const pos = input_ids[i].length - this.promptLen; // 0 = language slot, 1 = task, 2 = timestamps
      const data = logits[i].data;
      if (pos === 0) {
        let max = -Infinity;
        for (const id of this.allowed) max = Math.max(max, data[id]);
        let sum = 0;
        const probs = new Map();
        for (const id of this.allowed) { const p = Math.exp(data[id] - max); probs.set(id, p); sum += p; }
        for (const [id, p] of probs) probs.set(id, p / sum);
        this.langProbs[i] = probs;
        forceAmong(data, this.allowed);
      } else if (pos === 1 || pos === 2) {
        forceAmong(data, [this.taskIds[pos - 1]]);
      }
    }
    return logits;
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

// zlib-style compression ratio of the text. Whisper's reference implementation treats > 2.4 as a
// sign of repetitive hallucination ("the the the…") and retries the segment.
export async function compressionRatio(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < 20) return 1;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = await new Response(stream).arrayBuffer();
  return bytes.length / compressed.byteLength;
}
