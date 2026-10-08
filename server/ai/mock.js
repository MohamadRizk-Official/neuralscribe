// Local-development stand-in for the AI provider (AI_PROVIDER=mock; refused in production).
// Deterministic and crude on purpose: it exercises the whole pipeline — storage, caching, staleness,
// streaming, citations — without a key or any cost. It also deliberately returns one made-up line
// number, one invented quote and one decision with invented evidence, so the grounding checks are
// exercised on every run.
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
  // Phase 5 tools: deliberately include items the validators must reject (made-up evidence, a vague card,
  // a malformed quiz question, an exam claim without exam words)
  const L = (i) => lines[Math.min(i, lines.length - 1)] || { id: 0, text: '' };
  const ev = (l) => firstSentence(l.text);
  if (task === 'study_guide') {
    return {
      overview: `[Mock] ${ev(L(0))}`, topics: [{ title: 'Mock topic', summary: ev(L(0)), start_ref: L(0).id }],
      concepts: [{ term: 'Mock concept', explanation: ev(L(1)), refs: [L(1).id] }],
      definitions: [{ term: 'Mock term', definition: ev(L(1)), evidence: ev(L(1)), refs: [L(1).id] }, { term: 'Invented', definition: 'x', evidence: 'words nobody said at all', refs: [L(1).id] }],
      examples: [], processes: [{ name: 'One step only', steps: ['a'], refs: [L(0).id] }], relationships: [],
      emphasis: [], exam_info: [{ text: 'Not really an exam point', evidence: ev(L(0)), refs: [L(0).id] }], review: [],
    };
  }
  if (task === 'flashcards') {
    return { cards: [
      { front: `What did the speaker say about ${words(L(0).text)[0] || 'this'}?`, back: ev(L(0)), evidence: ev(L(0)), refs: [L(0).id] },
      { front: `What did the speaker say about ${words(L(0).text)[0] || 'this'}?`, back: ev(L(0)), evidence: ev(L(0)), refs: [L(0).id] },
      { front: 'What topic was discussed?', back: 'Stuff', evidence: ev(L(1)), refs: [L(1).id] },
      { front: 'A card with invented evidence?', back: 'No', evidence: 'nobody ever said this sentence', refs: [L(1).id] },
    ] };
  }
  if (task === 'quiz') {
    return { questions: [
      { type: 'multiple_choice', question: `Which statement matches the recording?`, options: [ev(L(0)), 'Option B', 'Option C', 'Option D'], answer: ev(L(0)), accept: [], explanation: 'Said at the start.', evidence: ev(L(0)), refs: [L(0).id] },
      { type: 'true_false', question: 'The recording has a first line?', options: ['True', 'False'], answer: 'true', accept: [], explanation: 'It does.', evidence: ev(L(0)), refs: [L(0).id] },
      { type: 'multiple_choice', question: 'Malformed: answer not among the options?', options: ['A', 'B', 'C', 'D'], answer: 'E', accept: [], explanation: '', evidence: ev(L(0)), refs: [L(0).id] },
      { type: 'short_answer', question: 'What is the first word of the recording?', options: [], answer: words(L(0).text)[0] || 'x', accept: [], explanation: '', evidence: ev(L(0)), refs: [L(0).id] },
    ] };
  }
  if (task === 'definitions') return { definitions: [{ term: 'Mock term', definition: ev(L(1)), evidence: ev(L(1)), refs: [L(1).id] }] };
  if (task === 'exam_points') return { explicit: [{ text: 'Claimed exam point without exam words', evidence: ev(L(0)), refs: [L(0).id] }], worth_reviewing: [] };
  if (task === 'meeting_recap') return { overview: `[Mock] ${ev(L(0))}`, topics: [{ title: 'Mock', summary: ev(L(0)), start_ref: BOGUS }], decisions: [], action_items: [], open_questions: [], follow_ups: [], important_dates: [] };
  if (task === 'action_plan') return { tasks: [{ task: 'Mock task', owner: null, deadline: null, evidence: ev(L(0)), refs: [L(0).id] }] };
  if (task === 'followup_email') return { subject: 'Follow-up', body: 'Hi [name],\nAs agreed, the price is $49 and we will ship by Monday.\nThanks', facts: [{ fact: 'something', evidence: ev(L(0)), refs: [L(0).id] }] };
  if (task === 'reply_draft') return { reply: 'Sure, I will send it first thing tomorrow.', addresses: [{ request: 'send the file', evidence: ev(L(0)), refs: [L(0).id] }] };
  if (task === 'interview_qa') return { is_interview: true, pairs: [{ question: L(0).text, asked_by: L(0).speaker, response: ev(L(1)), answered_by: L(1).speaker, refs: [L(0).id, L(1).id] }], quotes: [{ quote: ev(L(1)), speaker: L(1).speaker, refs: [L(1).id] }, { quote: 'A made-up quote nobody said', speaker: 'Speaker 1', refs: [L(0).id] }] };
  if (task === 'episode_notes') return { summary: `[Mock] ${ev(L(0))}`, outline: [{ title: 'Start', summary: ev(L(0)), start_ref: L(0).id }], takeaways: [{ text: ev(L(1)), refs: [L(1).id] }], quotes: [] };
  if (task === 'notes') {
    const half = Math.ceil(lines.length / 2);
    return {
      sections: [lines.slice(0, half), lines.slice(half)].filter((p) => p.length).map((p, i) => ({
        heading: i ? 'Later topic (mock)' : 'First topic (mock)',
        start_ref: i ? p[0].id : BOGUS, // an invalid section start, which the server must repair
        items: [...p.slice(0, 3).map((l, k) => ({ type: 'point', text: firstSentence(l.text), key: k === 0, refs: [l.id] })), { type: 'detail', text: 'Ungrounded note (mock)', key: false, refs: [BOGUS] }],
      })),
    };
  }
  const acts = pick(lines, /\b(will|need to|needs to|should|please|can you|send|finish|prepare)\b/i).map((l) => ({ task: firstSentence(l.text), owner: null, deadline: (l.text.match(/\b(by|before|on) ([A-Z][a-z]+day|tomorrow|next \w+)/) || [])[0] || null, evidence: firstSentence(l.text), refs: [l.id] }));
  const decs = pick(lines, /\b(agreed|decided|we'll go with|let's go with|final)\b/i).map((l) => ({ text: firstSentence(l.text), evidence: firstSentence(l.text), refs: [l.id] }));
  if (lines.length) decs.push({ text: 'Invented decision (mock)', evidence: 'we all agreed on something nobody said', refs: [lines[0].id] });
  const dates = pick(lines, /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th))\b/i)
    .map((l) => ({ what: firstSentence(l.text), when: (l.text.match(/\b(next \w+|\w+day|tomorrow|\w+ \d{1,2}(st|nd|rd|th)?)\b/i) || ['as said'])[0], refs: [l.id] }));
  const pts = lines.slice(0, 3).map((l) => ({ text: firstSentence(l.text), refs: [l.id] }));
  const quotes = [...lines.slice(0, 2).map((l) => ({ quote: firstSentence(l.text), speaker: l.speaker, refs: [l.id] })), { quote: 'A sentence nobody ever said in this recording', speaker: 'Speaker 1', refs: [lines[0]?.id ?? 0] }];
  const type = task.split(':')[1];
  const common = { action_items: [...acts, { task: 'Invented task (mock)', owner: 'Nobody', deadline: null, evidence: 'nothing', refs: [BOGUS] }], decisions: decs, suggestions: [], priorities: [], concerns: [], important_dates: dates };
  switch (type) {
    case 'meeting': return { ...common, open_questions: pick(lines, /\?$/).map((l) => ({ text: l.text, refs: [l.id] })), follow_ups: [] };
    case 'lecture': return { key_concepts: [], definitions: pick(lines, /\b(is defined as|means|refers to)\b/i).map((l) => ({ term: l.text.split(' ').slice(0, 2).join(' '), definition: l.text, refs: [l.id] })), important_topics: pts, exam_points: pick(lines, /\b(exam|test|quiz|important|remember)\b/i).map((l) => ({ text: l.text, refs: [l.id] })) };
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
      const answer = bestScore >= 2 ? `[Mock] The closest passage says: "${firstSentence(best.text)}" [${best.id}][${BOGUS}]` : `[Mock] The recording doesn't mention that (${question.replace(/\?$/, '').slice(0, 60)}).`;
      for (const piece of answer.match(/\S+\s*/g)) { onDelta(piece); await new Promise((r) => setTimeout(r, 25)); }
      return { text: answer, model: 'mock', usage: { input: Math.ceil(prompt.length / 3.2), output: 40 }, truncated: false };
    },
  };
}
