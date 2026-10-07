// Local-development stand-in for the AI provider (AI_PROVIDER=mock; refused in production).
// Deterministic and crude on purpose: it exercises the whole pipeline — storage, caching, staleness,
// streaming, citations — without a key or any cost. It also deliberately returns one made-up line
// number and one invented quote, so the grounding checks are exercised on every run.
// It says nothing about real answer quality.

const parseLines = (text) =>
  [...String(text).matchAll(/^\[(\d+)\] (\d+(?::\d+)+) ([^:\n]+): (.+)$/gm)].map((m) => ({ id: Number(m[1]), speaker: m[3], text: m[4] }));
const firstSentence = (t) => (t.match(/^.*?[.!?](\s|$)/) || [t])[0].trim();
const COMMON = new Set('what about that this with they them have said from were when where which would could should there their your into does did the and for'.split(' '));
const words = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 3 && !COMMON.has(w));
const pick = (lines, re, n = 4) => lines.filter((l) => re.test(l.text)).slice(0, n);
const BOGUS = 99999;

function structured(task, lines) {
  if (task === 'expand') return { keywords: [] };
  if (task === 'overview') {
    const long = [...lines].sort((a, b) => b.text.length - a.text.length).slice(0, 4).sort((a, b) => a.id - b.id);
    const step = Math.max(1, Math.floor(lines.length / 4));
    return {
      short_summary: `[Mock] ${lines.slice(0, 2).map((l) => firstSentence(l.text)).join(' ')}`,
      key_points: [...long.map((l) => ({ text: firstSentence(l.text), refs: [l.id] })), { text: 'Ungrounded point (mock)', refs: [BOGUS] }],
      chapters: lines.length >= 8 ? [0, 1, 2, 3].map((k) => ({ title: `Mock part ${k + 1}`, summary: firstSentence(lines[k * step].text), start_ref: lines[k * step].id })) : [],
    };
  }
  if (task === 'detailed_summary') {
    const half = Math.ceil(lines.length / 2);
    return { sections: [lines.slice(0, half), lines.slice(half)].filter((p) => p.length).map((p, i) => ({ heading: i ? 'Later' : 'Beginning', points: p.slice(0, 3).map((l) => ({ text: firstSentence(l.text), refs: [l.id] })) })) };
  }
  const acts = pick(lines, /\b(will|need to|needs to|should|please|can you|send|finish|prepare)\b/i).map((l) => ({ task: firstSentence(l.text), owner: null, deadline: (l.text.match(/\b(by|before|on) ([A-Z][a-z]+day|tomorrow|next \w+)/) || [])[0] || null, refs: [l.id] }));
  const decs = pick(lines, /\b(agreed|decided|we'll go with|let's go with|final)\b/i).map((l) => ({ text: firstSentence(l.text), refs: [l.id] }));
  const dates = pick(lines, /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th))\b/i)
    .map((l) => ({ what: firstSentence(l.text), when: (l.text.match(/\b(next \w+|\w+day|tomorrow|\w+ \d{1,2}(st|nd|rd|th)?)\b/i) || ['as said'])[0], refs: [l.id] }));
  const pts = lines.slice(0, 3).map((l) => ({ text: firstSentence(l.text), refs: [l.id] }));
  const quotes = [...lines.slice(0, 2).map((l) => ({ quote: firstSentence(l.text), speaker: l.speaker, refs: [l.id] })), { quote: 'A sentence nobody ever said in this recording', speaker: 'Speaker 1', refs: [lines[0]?.id ?? 0] }];
  const type = task.split(':')[1];
  const common = { action_items: [...acts, { task: 'Invented task (mock)', owner: 'Nobody', deadline: null, refs: [BOGUS] }], decisions: decs, suggestions: [], important_dates: dates };
  switch (type) {
    case 'meeting': return { ...common, open_questions: pick(lines, /\?$/).map((l) => ({ text: l.text, refs: [l.id] })), follow_ups: [] };
    case 'lecture': return { notes: [{ heading: 'Notes (mock)', points: pts }], key_concepts: [], definitions: pick(lines, /\b(is defined as|means|refers to)\b/i).map((l) => ({ term: l.text.split(' ').slice(0, 2).join(' '), definition: l.text, refs: [l.id] })), important_topics: pts, exam_points: pick(lines, /\b(exam|test|quiz|important|remember)\b/i).map((l) => ({ text: l.text, refs: [l.id] })) };
    case 'interview': return { questions: pick(lines, /\?$/).map((l) => ({ question: l.text, asked_by: l.speaker, answer: lines.find((x) => x.id === l.id + 1)?.text || '', answered_by: lines.find((x) => x.id === l.id + 1)?.speaker || null, refs: [l.id, l.id + 1] })), major_topics: pts, notable_quotes: quotes, key_takeaways: pts };
    case 'podcast': return { main_topics: pts, key_takeaways: pts, notable_quotes: quotes };
    case 'voice_message': return { important_information: pts, requested_actions: acts, dates_times: dates };
    default: return common;
  }
}

// AI_MOCK_FAIL=1 makes every call fail, to exercise the error / retry paths.
const maybeFail = () => {
  if (process.env.AI_MOCK_FAIL === '1') throw Object.assign(new Error('Mock provider failure'), { status: 502 });
};

export function mockProvider() {
  return {
    name: 'mock',
    async complete({ task, messages }) {
      maybeFail();
      const text = messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('\n'))).join('\n');
      await new Promise((r) => setTimeout(r, 400));
      const json = structured(task, parseLines(text));
      return { text: JSON.stringify(json), json, model: 'mock', usage: { input: Math.ceil(text.length / 3.2), output: 200 } };
    },
    async stream({ messages }, onDelta) {
      maybeFail();
      const last = messages[messages.length - 1];
      const prompt = typeof last.content === 'string' ? last.content : last.content.map((c) => c.text).join('\n');
      const question = (prompt.match(/<question>\n?([\s\S]*?)\n?<\/question>/) || [, ''])[1];
      const lines = parseLines(prompt);
      const qw = new Set(words(question));
      let best = null, bestScore = 0;
      for (const l of lines) {
        const s = words(l.text).filter((w) => qw.has(w)).length;
        if (s > bestScore) { best = l; bestScore = s; }
      }
      const answer = bestScore >= 2 ? `[Mock] The closest passage says: "${firstSentence(best.text)}" [${best.id}][${BOGUS}]` : "I couldn't find that in this recording.";
      for (const piece of answer.match(/\S+\s*/g)) { onDelta(piece); await new Promise((r) => setTimeout(r, 25)); }
      return { text: answer, model: 'mock', usage: { input: Math.ceil(prompt.length / 3.2), output: 40 }, truncated: false };
    },
  };
}
