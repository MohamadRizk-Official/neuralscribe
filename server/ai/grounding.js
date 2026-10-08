// Checks model output against the transcript before anything is stored or shown.
//  * every `refs` list keeps only line numbers that exist (and, for Ask, that were actually sent);
//  * items (key points, actions, decisions, dates, quotes…) without a valid reference are dropped;
//  * quotes, and the evidence behind decisions and action items, must appear word for word in the
//    cited lines, otherwise the item is dropped;
//  * chapters get their timestamps from real lines, in time order, never from the model.
import { citedIds, splitCitations, isNegativeAnswer } from '../../src/lib/segments.js';

const MAX_REFS = 5;
const MIN_CHAPTER_S = 20;

export function cleanRefs(refs, isValid) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  for (const r of refs) {
    const id = Number(r);
    if (Number.isInteger(id) && isValid(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_REFS) break;
  }
  return out.sort((a, b) => a - b);
}

const norm = (s) => String(s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A quote is genuine if its normalised words occur in the cited lines (neighbours included, since a
// sentence can run across two lines).
function quoteIsVerbatim(quote, refs, byId) {
  const q = norm(quote);
  if (!q || q.split(' ').length < 2) return false;
  const ids = new Set();
  for (const r of refs) for (const d of [-1, 0, 1]) if (byId.has(r + d)) ids.add(r + d);
  const hay = norm([...ids].sort((a, b) => a - b).map((i) => byId.get(i).text).join(' '));
  return hay.includes(q);
}

// Recursively validate a structured result. Returns { content, dropped } where dropped counts removed items.
export function groundStructured(content, segments) {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const isValid = (id) => byId.has(id);
  let dropped = 0;

  const walk = (value, key) => {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        const v = walk(item, key);
        if (v === undefined) { dropped++; continue; }
        out.push(v);
      }
      return out;
    }
    if (value && typeof value === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(value)) o[k] = k === 'refs' ? cleanRefs(v, isValid) : walk(v, k);
      // every item that is supposed to point at the transcript must point at a real line; an item the
      // model could not ground is dropped rather than shown as if it were in the recording
      if ('refs' in o && !o.refs.length) return undefined;
      if ('quote' in o && !quoteIsVerbatim(o.quote, o.refs, byId)) return undefined;
      // a decision or action item only counts if the words showing it are really in the transcript
      if ('evidence' in o && !quoteIsVerbatim(o.evidence, o.refs, byId)) return undefined;
      return o;
    }
    return typeof value === 'string' ? value.trim() : value;
  };
  return { content: walk(content, ''), dropped };
}

// Chapters: real start lines and times, sorted, no duplicates, first one at the start, very short
// chapters merged into the previous one.
export function groundChapters(chapters, segments) {
  if (!Array.isArray(chapters) || !segments.length) return [];
  const byId = new Map(segments.map((s) => [s.id, s]));
  const list = chapters
    .filter((c) => c && byId.has(Number(c.start_ref)) && String(c.title || '').trim())
    .map((c) => ({ title: String(c.title).trim(), summary: String(c.summary || '').trim(), start_ref: Number(c.start_ref) }))
    .sort((a, b) => byId.get(a.start_ref).start - byId.get(b.start_ref).start);
  const out = [];
  for (const c of list) {
    const t = byId.get(c.start_ref).start;
    const prev = out[out.length - 1];
    if (prev && t - byId.get(prev.start_ref).start < MIN_CHAPTER_S) continue;
    out.push(c);
  }
  if (out.length) out[0].start_ref = segments[0].id; // the first chapter covers the beginning
  return out.length >= 2 ? out : [];
}

// Ask answers: drop citations of lines the model was not given, report which lines are cited.
export function groundAnswer(text, allowedIds) {
  const allowed = new Set(allowedIds);
  const raw = String(text || '').trim();
  const parts = splitCitations(raw, (id) => allowed.has(id));
  const answer = parts.map((p) => (p.refs ? `[${p.refs.join(', ')}]` : p.text)).join('').trim();
  const refs = citedIds(answer);
  const invalid = citedIds(raw).filter((id) => !allowed.has(id));
  // found = the answer reports something from the recording (with citations). An uncited answer that says
  // what wasn't mentioned is a valid "not in the recording" answer; any other uncited answer is unsupported.
  const found = refs.length > 0 || !isNegativeAnswer(answer);
  return { answer, refs, found, unsupported: found && !refs.length, invalidCitations: invalid.length };
}
