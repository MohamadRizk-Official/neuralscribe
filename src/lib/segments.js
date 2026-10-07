// Transcript segments: the line-level form of a transcript (start, end, speaker, text) that summaries,
// chapters and Ask answers point into. Shared by the browser and the server functions, so both agree on
// line numbers and timestamps. Pure functions only (no browser or Node APIs).
//
// Stored in transcriptions.segments as [{ s, e, sp, t }] (compact keys). Older saved transcripts have no
// segments; for those the paragraphs of transcript_text are used, with a timestamp per paragraph only.

export const RECORDING_TYPES = ['general', 'lecture', 'meeting', 'interview', 'podcast', 'voice_message'];
export const RECORDING_TYPE_LABEL = {
  general: 'General', lecture: 'Lecture', meeting: 'Meeting', interview: 'Interview', podcast: 'Podcast', voice_message: 'Voice Message',
};
export const normalizeRecordingType = (t) => (RECORDING_TYPES.includes(t) ? t : 'general');

const round2 = (x) => Math.round(x * 100) / 100;

// Browser result lines -> stored form. `nameOf` maps a speaker id to the display name the user sees.
export function toStoredSegments(lines, nameOf) {
  return lines.map((l) => ({ s: round2(l.start), e: round2(l.end), sp: nameOf(l.speaker), t: l.text }));
}

export function parseClock(str) {
  const p = String(str).split(':').map(Number);
  if (p.some((n) => !Number.isFinite(n))) return 0;
  return p.reduce((t, n) => t * 60 + n, 0);
}

export function fmtClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
}

// Paragraphs of the .txt format: "[0:14] Speaker 1:\ntext…"
function paragraphsFromText(text) {
  const groups = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\[(\d{1,2}(?::\d{2}){1,2})\] (.+):$/.exec(line);
    if (m) { cur = { start: parseClock(m[1]), speaker: m[2], text: '' }; groups.push(cur); }
    else if (cur && line.trim()) cur.text += (cur.text ? ' ' : '') + line.trim();
  }
  return groups;
}

// A transcription row -> [{ id, start, end, speaker, text }] where id is the line number used everywhere.
// `coarse` is true when only paragraph timestamps exist (older saves).
export function segmentsFromRow(row) {
  if (Array.isArray(row?.segments) && row.segments.length) {
    const segments = row.segments
      .filter((x) => x && typeof x.t === 'string')
      .map((x, id) => ({ id, start: Number(x.s) || 0, end: Number(x.e) || Number(x.s) || 0, speaker: String(x.sp || 'Unknown'), text: x.t.trim() }));
    return { segments, coarse: false };
  }
  const paras = paragraphsFromText(row?.transcript_text);
  const segments = paras.map((p, id) => ({
    id, start: p.start, end: paras[id + 1]?.start ?? (row?.duration_seconds || p.start), speaker: p.speaker, text: p.text,
  }));
  return { segments, coarse: true };
}

// Line format given to the model: "[12] 3:41 Speaker 1: text". The id in brackets is what it cites.
export const modelLine = (s) => `[${s.id}] ${fmtClock(s.start)} ${s.speaker}: ${s.text}`;

// Rough token estimate (no tokenizer in the browser/edge). Errs high on purpose: ~3.2 chars per token.
export const estimateTokens = (text) => Math.ceil(String(text).length / 3.2);

// Citations in model text: [12], [12, 15], [12][15]. Returns the distinct ids in order of appearance.
const CITE_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
export function citedIds(text) {
  const out = [];
  for (const m of String(text).matchAll(CITE_RE)) {
    for (const n of m[1].split(',')) {
      const id = Number(n.trim());
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

// Split text into plain parts and citation groups, keeping only ids allowed by `isValid`.
// -> [{ text } | { refs: [ids] }]; citations with no valid ids disappear.
export function splitCitations(text, isValid) {
  const parts = [];
  let last = 0;
  for (const m of String(text).matchAll(CITE_RE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const refs = m[1].split(',').map((n) => Number(n.trim())).filter(isValid);
    if (refs.length) parts.push({ refs });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  // tidy spaces left before punctuation by removed citations ("Friday [99]." -> "Friday.")
  return parts.map((p) => (p.text != null ? { text: p.text.replace(/\s+([.,;:!?])/g, '$1') } : p));
}

export const NOT_FOUND = "I couldn't find that in this recording.";
export const isNotFound = (text) => /^\s*I couldn[’']t find that in this recording/i.test(String(text));
