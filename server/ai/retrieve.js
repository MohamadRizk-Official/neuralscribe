// Retrieval for Ask: picks the parts of a transcript that are relevant to a question, so long recordings
// are never sent in full for every question.
//
//   question (+ expanded keywords) → score transcript chunks (BM25) → boost chunks for a named speaker,
//   for "this part" (current playback position) and for lines behind already-extracted insights →
//   take the best chunks plus their neighbours within a token budget → lines in time order.
//
// Short transcripts are simply sent whole (cheaper than an extra keyword step, and nothing can be missed).
// Works on plain segments, so the same code can later run over many recordings' chunks.
import { estimateTokens, modelLine } from '../../src/lib/segments.js';

export const FULL_CONTEXT_TOKENS = 7000; // ≈ 25–30 minutes of speech
export const CONTEXT_BUDGET_TOKENS = 6000;
const CHUNK_MAX_S = 75;
const CHUNK_MAX_WORDS = 170;

const STOP = new Set(('a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those '
  + 'i you he she we they me him her us them my your his our their what which who whom whose when where why how do does did done '
  + 'can could would should will shall may might must have has had not no yes there here about into over than too very just also '
  + 'say said tell told talk talked mention mentioned recording transcript please explain').split(' '));

export function tokenize(text) {
  return (String(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}
function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w;
  return w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
}

export function buildChunks(segments) {
  const chunks = [];
  let cur = null;
  for (const s of segments) {
    const words = s.text.split(/\s+/).length;
    if (!cur || s.end - cur.start > CHUNK_MAX_S || cur.words + words > CHUNK_MAX_WORDS) {
      cur = { ids: [], start: s.start, end: s.end, words: 0, text: '', speakers: new Set() };
      chunks.push(cur);
    }
    cur.ids.push(s.id);
    cur.end = s.end;
    cur.words += words;
    cur.text += ' ' + s.text;
    cur.speakers.add(s.speaker.toLowerCase());
  }
  return chunks;
}

function bm25(chunks, terms) {
  const docs = chunks.map((c) => tokenize(c.text));
  const N = docs.length;
  const avg = docs.reduce((t, d) => t + d.length, 0) / (N || 1);
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const k1 = 1.4, b = 0.75;
  return docs.map((d) => {
    const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0;
    for (const [term, weight] of terms) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return score;
  });
}

const DEICTIC = /\b(this part|this section|here|just now|just said|right now|at this point|this bit|what (s?he|they) (just )?said)\b/i;

export function needsRetrieval(segments) {
  return estimateTokens(segments.map(modelLine).join('\n')) > FULL_CONTEXT_TOKENS;
}

// -> { mode: 'full' | 'retrieval', ids: [line ids in time order] }
export function selectContext(segments, { question, keywords = [], at = null, priorityIds = [], budget = CONTEXT_BUDGET_TOKENS } = {}) {
  if (!needsRetrieval(segments)) return { mode: 'full', ids: segments.map((s) => s.id) };

  const chunks = buildChunks(segments);
  const terms = new Map();
  for (const w of tokenize(question)) terms.set(w, 1);
  for (const k of keywords) for (const w of tokenize(k)) if (!terms.has(w)) terms.set(w, 0.6);
  const scores = bm25(chunks, terms);
  const top = Math.max(1e-6, ...scores);

  // a speaker named in the question ("Speaker 2", or a renamed speaker)
  const q = question.toLowerCase();
  const speakers = new Set(segments.map((s) => s.speaker.toLowerCase()));
  const named = [...speakers].filter((s) => s !== 'unknown' && new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q));
  const priority = new Set(priorityIds);

  chunks.forEach((c, i) => {
    if (named.length && named.some((s) => c.speakers.has(s))) scores[i] = scores[i] * 1.6 + top * 0.15;
    if (c.ids.some((id) => priority.has(id))) scores[i] += top * 0.8;
    if (at != null && DEICTIC.test(question) && at >= c.start - 1 && at <= c.end + 1) scores[i] += top * 2;
  });

  const cost = chunks.map((c) => estimateTokens(c.ids.map((id) => modelLine(segments[id])).join('\n')));
  const order = scores.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const chosen = new Set();
  let used = 0;
  const take = (i) => {
    if (i < 0 || i >= chunks.length || chosen.has(i) || used + cost[i] > budget) return false;
    chosen.add(i);
    used += cost[i];
    return true;
  };
  for (const i of order.slice(0, 8)) take(i); // best matches first
  for (const i of [...chosen]) { take(i - 1); take(i + 1); } // then the context around them
  for (const i of order) take(i); // fill any remaining budget with further matches

  const ids = [...chosen].sort((a, b) => a - b).flatMap((i) => chunks[i].ids);
  return { mode: 'retrieval', ids };
}

// Lines for the prompt, with "…" where the excerpts skip part of the recording.
export function formatExcerpts(segments, ids) {
  const out = [];
  let prev = null;
  for (const id of ids) {
    if (prev != null && id !== prev + 1) out.push('…');
    out.push(modelLine(segments[id]));
    prev = id;
  }
  return out.join('\n');
}
