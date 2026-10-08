// SparkScribe intelligence: everything built on top of a saved transcript.
//
//   generateOverview()        short summary + key points + chapters, in ONE model call
//   generateDetailedSummary() structured summary for the recording type
//   generateNotes()           organized reference / study notes for the recording type
//   generateInsights()        type-specific extraction (actions, decisions, dates, quotes…)
//   askTranscript()           grounded Q&A with timestamp citations, streamed
//   (cleanTranscript is rule-based and runs in the browser: src/lib/clean.js)
//
// Cost rules enforced here:
//   * a result is generated once per (transcript version, kind, recording type) and then read from the
//     database; nothing regenerates unless the transcript changed or the user asks;
//   * concurrent requests for the same result share one generation instead of starting another;
//   * every prompt stays under ~90k tokens (Haiku's cheaper price band); longer transcripts are analysed
//     in parts and the partial results merged;
//   * Ask sends only the relevant excerpts of long transcripts, and repeated questions are answered from
//     the stored answer.
import { getProvider, taskConfig, AIError } from './provider.js';
import { createMeter } from './usage.js';
import { ANALYST_SYSTEM, ASK_SYSTEM, OVERVIEW_SCHEMA, overviewInstructions, DETAILED_SCHEMA, detailedInstructions, NOTES_SCHEMA, notesInstructions, INSIGHT_SPECS, EXPAND_SCHEMA, expandInstructions } from './prompts.js';
import { groundStructured, groundChapters, groundAnswer } from './grounding.js';
import { selectContext, needsRetrieval, formatExcerpts } from './retrieve.js';
import { segmentsFromRow, modelLine, estimateTokens, normalizeRecordingType, RECORDING_TYPES } from '../../src/lib/segments.js';

const PART_TOKENS = 80_000;
const GENERATING_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_TOKENS = 600_000; // ~30+ hours of speech; beyond this we refuse rather than run up cost
export const KINDS = ['overview', 'detailed_summary', 'notes', 'insights'];
const CHAPTER_MIN_MINUTES = 8;

function transcriptHeader(row, segments) {
  const speakers = [...new Set(segments.map((s) => s.speaker))].filter((s) => s !== 'Unknown');
  const mins = Math.round((row.duration_seconds || segments.at(-1)?.end || 0) / 60);
  return `Recording length: about ${mins} minute${mins === 1 ? '' : 's'}. Speakers: ${speakers.join(', ') || 'unknown'}.`;
}

// Split the transcript into parts that each fit one prompt.
function parts(segments) {
  const out = [];
  let cur = [], tokens = 0;
  for (const s of segments) {
    const t = estimateTokens(modelLine(s)) + 1;
    if (cur.length && tokens + t > PART_TOKENS) { out.push(cur); cur = []; tokens = 0; }
    cur.push(s);
    tokens += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

const userMessage = (header, segs, instructions) => ({
  role: 'user',
  content: [
    // No prompt caching: each analysis uses a different output schema, which changes the cached prefix, so
    // in testing cache writes (+25% input price) were never read back.
    { type: 'text', text: `${header}\n<transcript>\n${segs.map(modelLine).join('\n')}\n</transcript>` },
    { type: 'text', text: instructions },
  ],
});

// One structured analysis over the whole transcript (map-reduce when it doesn't fit one prompt).
async function analyze({ task, schema, instructions, row, segments, meter }) {
  const ai = getProvider();
  const cfg = taskConfig(task);
  const header = transcriptHeader(row, segments);
  const usage = { input: 0, output: 0 };
  const run = async (segs, extra = '') => {
    const r = await meter.call(task, () => ai.complete({ task, ...cfg, system: ANALYST_SYSTEM, schema, messages: [userMessage(header, segs, instructions + extra)] }));
    usage.input += r.usage.input; usage.output += r.usage.output;
    return r;
  };
  const chunks = parts(segments);
  if (chunks.length === 1) {
    const r = await run(segments);
    return { json: r.json, model: r.model, usage };
  }
  // long recording: analyse each part, then merge the partial results (small) in one more call
  const partial = [];
  for (const [i, p] of chunks.entries()) {
    const r = await run(p, `\n\n(This is part ${i + 1} of ${chunks.length} of a long recording; analyse this part only.)`);
    partial.push(r.json);
  }
  const reduce = taskConfig('reduce');
  const r = await meter.call(`${task}:merge`, () => ai.complete({
    task, ...reduce, system: ANALYST_SYSTEM, schema,
    messages: [{ role: 'user', content: `${header}\nA long recording was analysed in ${chunks.length} consecutive parts. Merge these partial results into one result for the whole recording, following the same instructions. Keep the line-number refs exactly as given (they refer to the full transcript), remove duplicates, and keep the most important items.\n\nInstructions for the result:\n${instructions}\n\nPartial results in order:\n${partial.map((p, i) => `<part n="${i + 1}">\n${JSON.stringify(p)}\n</part>`).join('\n')}` }],
  }));
  usage.input += r.usage.input; usage.output += r.usage.output;
  return { json: r.json, model: r.model, usage };
}

async function generateOverview(row, segments, _type, meter) {
  const minutes = (row.duration_seconds || segments.at(-1)?.end || 0) / 60;
  const withChapters = minutes >= CHAPTER_MIN_MINUTES && segments.length >= 6;
  const r = await analyze({ task: 'overview', schema: OVERVIEW_SCHEMA, instructions: overviewInstructions({ minutes, withChapters }), row, segments, meter });
  const { content, dropped } = groundStructured({ short_summary: r.json.short_summary, key_points: r.json.key_points }, segments);
  const rawChapters = withChapters ? (r.json.chapters || []).length : 0;
  content.chapters = withChapters ? groundChapters(r.json.chapters, segments) : [];
  return { ...r, content, dropped: dropped + Math.max(0, rawChapters - content.chapters.length) };
}

async function generateDetailedSummary(row, segments, type, meter) {
  const r = await analyze({ task: 'detailed_summary', schema: DETAILED_SCHEMA, instructions: detailedInstructions(type), row, segments, meter });
  const { content, dropped } = groundStructured(r.json, segments);
  content.sections = content.sections.filter((s) => s.points.length);
  return { ...r, content, dropped };
}

async function generateInsights(row, segments, type, meter) {
  const spec = INSIGHT_SPECS[type] || INSIGHT_SPECS.general;
  const r = await analyze({ task: `insights:${type}`, schema: spec.schema, instructions: spec.instructions, row, segments, meter });
  const { content, dropped } = groundStructured(r.json, segments);
  return { ...r, content, dropped };
}

async function generateNotes(row, segments, type, meter) {
  const r = await analyze({ task: 'notes', schema: NOTES_SCHEMA, instructions: notesInstructions(type), row, segments, meter });
  const { content, dropped } = groundStructured(r.json, segments);
  const ids = new Set(segments.map((s) => s.id));
  content.sections = content.sections
    .filter((s) => s.items.length)
    // a section's timestamp must be a real line: otherwise use its first supported note
    .map((s) => ({ ...s, start_ref: ids.has(Number(s.start_ref)) ? Number(s.start_ref) : s.items[0].refs[0] }));
  return { ...r, content, dropped };
}

const GENERATORS = { overview: generateOverview, detailed_summary: generateDetailedSummary, notes: generateNotes, insights: generateInsights };

function publicInsight(i) {
  return {
    kind: i.kind, recordingType: i.recording_type, status: i.status, content: i.status === 'ready' ? i.content : null,
    error: i.status === 'failed' ? i.error : null, sourceVersion: i.source_version, updatedAt: i.updated_at,
  };
}

async function loadTranscript(db, transcriptionId) {
  const row = await db.getTranscription(transcriptionId);
  if (!row) throw new AIError("This transcript doesn't exist or isn't yours.", { status: 404, code: 'not_found' });
  const { segments, coarse } = segmentsFromRow(row);
  if (!segments.length) throw new AIError('This transcript has no text to analyse.', { status: 422, code: 'empty' });
  if (estimateTokens(segments.map(modelLine).join('\n')) > MAX_TRANSCRIPT_TOKENS) {
    throw new AIError('This transcript is too long to analyse.', { status: 422, code: 'too_long' });
  }
  return { row, segments, coarse };
}

// Everything already generated for a transcript (no model calls).
export async function getState(db, transcriptionId) {
  const row = await db.getTranscription(transcriptionId);
  if (!row) throw new AIError("This transcript doesn't exist or isn't yours.", { status: 404, code: 'not_found' });
  const [insights, questions] = await Promise.all([db.listInsights(transcriptionId), db.listQuestions(transcriptionId)]);
  return {
    contentVersion: row.content_version,
    recordingType: RECORDING_TYPES.includes(row.recording_type) ? row.recording_type : null,
    insights: insights.map(publicInsight),
    questions: questions.map((q) => ({ id: q.id, question: q.question, answer: q.answer, refs: q.refs, found: q.found, sourceVersion: q.source_version, createdAt: q.created_at })),
  };
}

// Generate (or return the stored) result of one kind.
export async function generate(db, { transcriptionId, kind, recordingType, force = false, userId = null }) {
  if (!KINDS.includes(kind)) throw new AIError('Unknown analysis.', { status: 400, code: 'bad_request' });
  const type = kind === 'overview' ? 'general' : normalizeRecordingType(recordingType);
  const meter = createMeter({ feature: kind === 'overview' ? 'overview' : `${kind}:${type}`, transcriptionId, userId });
  const { row, segments } = await loadTranscript(db, transcriptionId);
  const version = row.content_version;
  const fromStorage = (insight) => { meter.finish({ cached: true }); return { insight: publicInsight(insight), cached: true }; };

  const existing = await db.getInsight(transcriptionId, kind, type);
  if (existing) {
    const fresh = existing.source_version === version;
    if (existing.status === 'ready' && fresh && !force) return fromStorage(existing);
    if (existing.status === 'generating' && Date.now() - new Date(existing.updated_at).getTime() < GENERATING_TIMEOUT_MS) {
      return fromStorage(existing); // someone else is already generating it
    }
  }
  const claimed = await db.startInsight(existing, { transcriptionId, kind, recordingType: type, version });
  if (!claimed) return fromStorage(await db.getInsight(transcriptionId, kind, type));

  try {
    const r = await GENERATORS[kind](row, segments, type, meter);
    const saved = await db.finishInsight(claimed.id, { content: r.content, model: r.model, usage: r.usage });
    // "passed" = every item the model returned pointed at real lines (nothing had to be dropped)
    meter.finish({ groundingPassed: r.dropped === 0, droppedItems: r.dropped });
    return { insight: publicInsight(saved), cached: false, dropped: r.dropped };
  } catch (err) {
    const message = err instanceof AIError ? err.message : 'Analysis failed.';
    meter.finish({ error: message });
    await db.failInsight(claimed.id, message).catch(() => {});
    throw err instanceof AIError ? err : new AIError(message);
  }
}

const normQuestion = (q) => q.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!\s]+$/, '').trim();
const INTENTS = [
  [/\b(decid|decision|agree|final|settled|go with)/i, ['decisions']],
  [/\b(action|task|to.?do|assign|responsib|follow.?up|need(s)? to do|next step)/i, ['action_items', 'requested_actions', 'follow_ups']],
  [/\b(deadline|due|date|when|schedule|appointment|by (mon|tues|wednes|thurs|fri|satur|sun)day)/i, ['important_dates', 'dates_times', 'action_items']],
  [/\b(question|unresolved|open issue)/i, ['open_questions', 'questions']],
  [/\b(priorit|goal|focus)/i, ['priorities']],
  [/\b(concern|worr|risk|problem|issue)/i, ['concerns']],
  [/\b(suggest|propos|idea|recommend)/i, ['suggestions']],
  [/\b(study|exam|test|concept|definition|important)/i, ['exam_points', 'key_concepts', 'definitions', 'important_topics']],
  [/\b(summar|main|overall|about|key point|takeaway)/i, ['key_points', 'key_takeaways', 'main_topics', 'major_topics']],
];

// Line ids behind already-extracted insights that match the question's intent: cheap, precise context
// for "what were the decisions?"-style questions on long recordings.
function intentRefs(question, insights) {
  const keys = INTENTS.filter(([re]) => re.test(question)).flatMap(([, k]) => k);
  if (!keys.length) return [];
  const ids = [];
  for (const i of insights) {
    if (i.status !== 'ready' || !i.content) continue;
    for (const k of keys) for (const item of i.content[k] || []) ids.push(...(item.refs || []));
  }
  return [...new Set(ids)].slice(0, 60);
}

// Grounded Q&A. Streams { delta } events through `emit`, then resolves with the stored answer.
export async function askTranscript(db, { transcriptionId, question, at = null, userId = null }, emit) {
  question = String(question || '').trim().slice(0, 500);
  if (!question) throw new AIError('Type a question first.', { status: 400, code: 'bad_request' });
  const { row, segments } = await loadTranscript(db, transcriptionId);
  const version = row.content_version;
  const deictic = at != null && /\b(this|here|now|just)\b/i.test(question);
  const meter = createMeter({ feature: 'ask', transcriptionId, userId });

  // the same question about the same version of the transcript: answer from storage, no model call
  if (!deictic) {
    const prev = await db.findAnswer(transcriptionId, normQuestion(question), version, normQuestion);
    if (prev) {
      emit({ type: 'cached' });
      meter.finish({ cached: true });
      return { id: prev.id, question: prev.question, answer: prev.answer, refs: prev.refs, found: prev.found, cached: true };
    }
  }

  const ai = getProvider();
  const insights = await db.listInsights(transcriptionId);
  const current = insights.filter((i) => i.source_version === version);
  let keywords = [];
  let usageIn = 0, usageOut = 0;
  if (needsRetrieval(segments)) {
    emit({ type: 'status', status: 'searching' });
    try {
      const r = await meter.call('ask:keywords', () => ai.complete({ task: 'expand', ...taskConfig('expand'), system: 'You help search transcripts.', schema: EXPAND_SCHEMA, messages: [{ role: 'user', content: expandInstructions(question) }] }));
      keywords = (r.json?.keywords || []).slice(0, 20).map(String);
      usageIn += r.usage.input; usageOut += r.usage.output;
    } catch { /* retrieval still works on the question's own words */ }
  }
  const ctx = selectContext(segments, { question, keywords, at: deictic ? Number(at) : null, priorityIds: intentRefs(question, current) });

  const overview = current.find((i) => i.kind === 'overview' && i.status === 'ready')?.content;
  const outline = ctx.mode === 'retrieval' && overview
    ? `<outline note="orientation only — cite transcript lines, not this outline">\n${overview.short_summary}\n${(overview.chapters || []).map((c) => `- ${c.title} (from line ${c.start_ref})`).join('\n')}\n</outline>\n`
    : '';
  const scope = ctx.mode === 'full' ? 'The complete transcript' : 'Excerpts of the transcript selected as relevant to the question ("…" marks skipped parts)';
  const position = deictic ? `\nThe user is currently at ${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, '0')} in the recording; "this part" refers to the lines around that time.` : '';

  const history = (await db.listQuestions(transcriptionId)).filter((q) => q.found).slice(-2);
  const messages = [];
  for (const h of history) messages.push({ role: 'user', content: `<question>\n${h.question}\n</question>` }, { role: 'assistant', content: h.answer });
  messages.push({
    role: 'user',
    content: `${transcriptHeader(row, segments)}\n${outline}<excerpts>\n${scope}:\n${formatExcerpts(segments, ctx.ids)}\n</excerpts>${position}\n\n<question>\n${question}\n</question>`,
  });

  emit({ type: 'status', status: 'answering' });
  let r;
  try {
    r = await meter.call('ask', () => ai.stream({ task: 'ask', ...taskConfig('ask'), system: ASK_SYSTEM, messages }, (text) => emit({ type: 'delta', text })));
  } catch (err) {
    meter.finish({ error: err?.message || 'failed' });
    throw err;
  }
  usageIn += r.usage.input; usageOut += r.usage.output;
  const g = groundAnswer(r.text, ctx.ids);
  // "passed" = no citation of a line the model wasn't given, and a found answer cites at least one line
  meter.finish({ groundingPassed: g.invalidCitations === 0 && !g.unsupported, droppedItems: g.invalidCitations });
  const saved = await db.saveQuestion({
    transcriptionId, question, answer: g.answer, refs: g.refs, found: g.found, version, model: r.model, usage: { input: usageIn, output: usageOut },
  });
  return { id: saved?.id, question, answer: g.answer, refs: g.refs, found: g.found, unsupported: g.unsupported, mode: ctx.mode, cached: false };
}
