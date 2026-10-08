// Detecting pathological repetition in Whisper output — runaway loops like "so, so, so, so…" or
// "m m m m…" — without touching ordinary emphasis ("no, no, no", "very, very important").
// Pure functions: used by the decoder (engine/decoding.js, worker.js) and by the unit tests.

// A run is pathological — not emphasis — when one token/word repeats 8+ times in a row, or a unit of
// 2–8 tokens (2–4 words) repeats 6+ times. People repeat for emphasis 2–4 times.
export const LOOP_SINGLE_REPS = 8;
export const LOOP_UNIT_REPS = 6;
export const isLoopRun = (unitLen, reps) => (unitLen === 1 && reps >= LOOP_SINGLE_REPS) || (unitLen > 1 && reps >= LOOP_UNIT_REPS);

// Longest run at the END of a token list made of one repeated unit of 1–8 tokens.
// Returns { unit, reps, start } (start = index where the run begins) or null.
export function tailRepetition(toks) {
  let best = null;
  for (let p = 1; p <= 8 && p * 2 <= toks.length; p++) {
    let reps = 1;
    const n = toks.length;
    outer: while ((reps + 1) * p <= n) {
      for (let j = 0; j < p; j++) if (toks[n - (reps + 1) * p + j] !== toks[n - p + j]) break outer;
      reps++;
    }
    if (reps >= 2 && (!best || reps * p > best.reps * best.unit)) best = { unit: p, reps, start: n - reps * p };
  }
  return best;
}

const wordKey = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
export const wordKeys = (s) => s.split(/\s+/).map(wordKey).filter(Boolean);

// Word-level loop removal on decoded text. Finds a trailing run of one repeated 1–4 word unit and,
// if it is pathological — or `unit` says the decoder was already stopped for looping on it — removes
// the run. A repeated multi-word phrase keeps one copy ("I hope so. I hope so. I hope so…" ->
// "I hope so."); a repeated single word/sound keeps none ("you know? so so so so…" -> "you know?").
// Returns { text, loop } or null when there is nothing pathological.
export function cutTextLoop(text, unit = null) {
  const words = text.split(/\s+/).filter(Boolean);
  const keys = words.map(wordKey);
  const n = keys.length;
  const runOf = (u) => {
    let reps = 0;
    while ((reps + 1) * u.length <= n && u.every((k, j) => keys[n - (reps + 1) * u.length + j] === k)) reps++;
    return reps;
  };
  const candidates = unit?.length ? [unit] : [1, 2, 3, 4].map((p) => keys.slice(n - p)).filter((u) => u.length && u.every(Boolean));
  for (const u of candidates) {
    const reps = runOf(u);
    if (!reps || (!unit && !isLoopRun(u.length, reps))) continue;
    let start = n - reps * u.length;
    // a loop that stopped mid-phrase ("…so. I hope so. I") is the same run, rotated: extend it back
    while (start > 0 && keys[start - 1] === keys[start - 1 + u.length]) start--;
    const keep = u.length >= 2 ? words.slice(start, start + u.length) : [];
    return { text: tidyCut([...words.slice(0, start), ...keep].join(' ')), loop: { unit: u.join(' '), repeats: reps, removedWords: n - start - keep.length } };
  }
  return null;
}

// Punctuation debris (",,,,,") is never meaningful; everything else is left exactly as decoded.
export const tidy = (s) => s.replace(/([,;:])(\s*[,;:])+/g, '$1').trim();
// After a loop was cut: no dangling punctuation where the run started ("you know?, " -> "you know?").
export const tidyCut = (s) => tidy(s).replace(/([.!?])\s*[,;:]+/g, '$1').replace(/\s*[,;:]\s*$/, '').trim();
