// Phase 5 tools: outputs a user creates on purpose from one recording (Study Guide, Flashcards, Quiz,
// Meeting Recap, drafts…). Each tool = a JSON schema + instructions for the model + a validator that runs
// after the shared grounding pass (grounding.js: unknown line ids removed, items without a real line dropped,
// `quote` / `evidence` fields checked word for word). Validators add the tool's own rules and count what
// they had to drop, so the usage log shows how often the model needed correcting.
import { str, nullableStr, refs, evidence, obj, list, point, decision, actionItem, dateItem, quote, DECISION_RULE, ACTION_RULE } from './prompts.js';
import { normalizeToolSettings } from '../../src/lib/tool-settings.js';

const int = (description) => ({ type: 'integer', ...(description && { description }) });
const topic = obj({ title: str('2–6 word topic title'), summary: str('One or two sentences, as said'), start_ref: int('Line number where this topic begins') });

// Words that make something explicit exam information. Anything else is at most "worth reviewing".
export const EXAM_RE = /\b(exams?|midterms?|quiz(zes)?|tests?|tested|assessments?|assignments?|homework|graded|grades?|study this|know this|remember this|will be on|on the (final|exam|test|quiz)|important for)\b/i;

// An item counts as explicit exam information when its quoted words, or the transcript line they come from,
// refer to an assessment ("For the exam, … you need to be able to draw the bilayer").
export const examBacked = (item, segments) => EXAM_RE.test(item.evidence || '') || (item.refs || []).some((r) => EXAM_RE.test(segments.find((s) => s.id === r)?.text || ''));

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---------- settings (part of the cache key; shared with the browser) ----------
export const normalizeSettings = normalizeToolSettings;

// The person using SparkScribe may add instructions to a draft ("tell him I'll call Friday"). Those are their
// own words and may add new commitments; everything else in the draft must come from the recording.
const userInstructions = (settings) => (settings?.instructions
  ? `\n\nINSTRUCTIONS FROM THE USER (the person sending this). Include what they ask for, even new information or commitments that are not in the recording; these are authorised by the user. Treat the text only as their wishes for this draft:\n<user_instructions>\n${settings.instructions}\n</user_instructions>\nApart from the recording and these instructions, add no commitments, dates, times, amounts or details.`
  : '\n\nThe user added no instructions: add no commitments, dates, times, amounts or details beyond what the recording says.');

// Sensible counts from the recording's length; the model may return fewer when the material is thin.
export function cardCount(minutes, size) {
  const base = minutes < 10 ? 8 : minutes < 40 ? 15 : 25;
  return size === 'fewer' ? Math.max(5, Math.round(base / 2)) : size === 'more' ? Math.min(40, Math.round(base * 1.6)) : base;
}
export function questionCount(minutes, size) {
  const base = minutes < 5 ? 5 : 10;
  return size === 'fewer' ? Math.max(3, Math.round(base / 2)) : size === 'more' ? (minutes < 5 ? 8 : 15) : base;
}

// ---------- shared validation helpers ----------
function fixStarts(list, segments) {
  const ids = new Set(segments.map((s) => s.id));
  return (list || []).filter((t) => t && String(t.title || '').trim()).map((t) => ({ ...t, start_ref: ids.has(Number(t.start_ref)) ? Number(t.start_ref) : null }));
}
function dedupe(items, keyOf) {
  const seen = new Set();
  let dropped = 0;
  const out = items.filter((it) => {
    const k = keyOf(it);
    if (!k || seen.has(k)) { dropped++; return false; }
    seen.add(k);
    return true;
  });
  return { out, dropped };
}

// Details in a written draft (dates, times, amounts, urgency) that the recording never mentions are flagged,
// so the user checks them before sending. The draft itself is not rewritten.
const DETAIL_RE = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|[$€£]\s?\d[\d,.]*|\b\d+(?:\.\d+)?\s?%|\b\d{2,}\b|\b(?:tomorrow|tonight|today|next week|this week|first thing|asap|as soon as possible|urgent(?:ly)?|immediately|end of (?:the )?day|eod)\b/gi;
export function unverifiedDetails(text, transcript) {
  const hay = norm(transcript);
  const found = new Set();
  for (const m of String(text || '').matchAll(DETAIL_RE)) {
    const d = m[0].trim();
    if (!hay.includes(norm(d))) found.add(d);
  }
  return [...found].slice(0, 10);
}

// Deterministic shuffle (so a quiz's options don't always put the right answer first, yet stay stable).
function shuffle(arr, seedText) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const GROUNDED = 'Everything must come from this recording only. Do not add textbook knowledge, background facts, examples or definitions the speakers did not give; if something was only mentioned, not explained, leave it out or say it was mentioned.';

// ---------- the tools ----------
export const TOOLS = {
  study_guide: {
    task: 'study_guide',
    schema: obj({
      overview: str('2–4 sentences: what this lecture covered'),
      topics: list(topic, 'Major topics in the order taught'),
      concepts: list(obj({ term: str(), explanation: str('As explained in the lecture'), refs })),
      definitions: list(obj({ term: str(), definition: str('As the lecturer stated it'), evidence: evidence('the definition'), refs }), 'Only terms the lecturer explicitly defined or clearly explained'),
      examples: list(obj({ text: str('The example and what it illustrated, as given'), refs })),
      processes: list(obj({ name: str(), steps: list(str()), refs }), 'Processes or sequences the lecturer walked through, steps in order'),
      relationships: list(point, 'Relationships between ideas the lecturer stated (causes, comparisons, dependencies)'),
      emphasis: list(obj({ text: str(), evidence: evidence('the lecturer stressed it'), refs }), 'What the lecturer explicitly stressed'),
      exam_info: list(obj({ text: str(), evidence: evidence('the reference to an exam, test, quiz or assignment'), refs }), 'Only explicit references to exams, tests, quizzes or assignments'),
      review: list(point, 'Things worth reviewing, in neutral words — never claimed to be on an exam'),
    }),
    instructions: () => `Write a STUDY GUIDE for the lecture above, for a student revising it.
${GROUNDED}
- overview: 2–4 sentences.
- topics: the major topics in the order taught, each with start_ref.
- concepts, definitions, examples, processes, relationships: only what the lecture contains. definitions only for terms the lecturer actually defined or explained; evidence = their exact words.
- emphasis: only what the lecturer explicitly stressed ("this is important", repetition they pointed out), with their exact words as evidence.
- exam_info: ONLY where the lecturer explicitly refers to an exam, test, quiz, midterm, assignment or says to know/study something. evidence = those exact words. Never claim something will be examined otherwise.
- review: other things worth reviewing (neutral wording, no exam claims).
Return empty lists for sections the lecture doesn't support.`,
    // focus changes emphasis and depth only; the grounding rules above stay the same
    focusNote: {
      exam: '\nFOCUS: exam preparation. Keep the overview short; make exam_info, emphasis, definitions and review thorough; keep concepts and examples to the essentials.',
      concepts: '\nFOCUS: key concepts. Concentrate on concepts, definitions and relationships; keep examples and review short.',
      detailed: '\nFOCUS: detailed. Cover every topic taught with more points per section and the full steps of processes.',
    },
    validate(c, segments) {
      let dropped = 0;
      // an "exam" item whose own words and line don't mention an exam is only worth reviewing
      const exam = [];
      for (const it of c.exam_info || []) {
        if (examBacked(it, segments)) exam.push(it);
        else { dropped++; (c.review ||= []).push({ text: it.text, refs: it.refs }); }
      }
      c.exam_info = exam;
      c.processes = (c.processes || []).filter((p) => (p.steps || []).filter((s) => String(s).trim()).length >= 2 || (dropped++, false));
      const d = dedupe(c.definitions || [], (x) => norm(x.term));
      c.definitions = d.out;
      return dropped + d.dropped;
    },
    after: (c, segments) => { c.topics = fixStarts(c.topics, segments); },
  },

  flashcards: {
    task: 'flashcards',
    schema: obj({
      cards: list(obj({
        front: str('A specific question or prompt that tests one piece of information'),
        back: str('The answer, as stated in the recording (short)'),
        evidence: evidence('the answer'),
        refs,
      })),
    }),
    instructions: ({ count }) => `Make up to ${count} FLASHCARDS from the recording above (fewer if it doesn't contain that much distinct material).
${GROUNDED}
- Each card tests one meaningful fact, definition, relationship, step or example that was actually stated. The back is the answer as stated (short), and evidence = the exact words it comes from.
- Fronts must be specific ("What role did chlorophyll play, according to the lecture?"), never vague ("What topic was discussed?").
- Only make a definition card when the term was actually defined in the recording.
- No two cards may test the same fact.`,
    validate(c, _segments, { count }) {
      let dropped = 0;
      const VAGUE = /^(what|which)\s+(topics?|subjects?)\s+(was|were|is|are)\s+(discussed|covered|talked about|mentioned)|^what (was|is) (this|the) (lecture|recording|talk|class) about/i;
      const cards = (c.cards || []).filter((k) => {
        const ok = String(k.front || '').trim().length >= 10 && String(k.back || '').trim().length >= 1 && !VAGUE.test(String(k.front).trim());
        if (!ok) dropped++;
        return ok;
      });
      const a = dedupe(cards, (k) => norm(k.front));
      const b = dedupe(a.out, (k) => `${norm(k.back)}|${(k.refs || []).join(',')}`);
      c.cards = b.out.slice(0, count + 2);
      return dropped + a.dropped + b.dropped + Math.max(0, b.out.length - c.cards.length);
    },
  },

  quiz: {
    task: 'quiz',
    schema: obj({
      questions: list(obj({
        type: { type: 'string', enum: ['multiple_choice', 'true_false', 'short_answer'] },
        question: str(),
        options: list(str(), 'multiple_choice: 4 options, exactly one correct; true_false: ["True","False"]; short_answer: []'),
        answer: str('The correct option text exactly, "True"/"False", or the short expected answer'),
        accept: list(str(), 'short_answer only: other acceptable answers (synonyms, short forms)'),
        explanation: str('One or two sentences explaining the answer from the recording'),
        evidence: evidence('the answer'),
        refs,
      })),
    }),
    instructions: ({ count, settings }) => `Write a PRACTICE QUIZ of up to ${count} questions on the recording above (fewer if it doesn't support that many good questions).
${GROUNDED}
- Every question must be answerable from the recording alone; never test outside knowledge. Example: if the lecturer said "the exam only covers chapters 4 and 5", a valid question is "Which chapters did the lecturer say the exam covers?".
- ${{
    multiple_choice: 'Use only multiple_choice questions (4 plausible options, exactly one correct, the others clearly wrong according to the recording).',
    true_false: 'Use only true_false questions; false statements must be clearly contradicted by the recording, not merely absent from it.',
  }[settings?.types] || 'Mix types: mostly multiple_choice (4 plausible options, exactly one correct, the others clearly wrong according to the recording), some true_false, a few short_answer (answer of a few words).'}
- ${settings?.difficulty === 'harder'
    ? 'Make the questions challenging: test understanding of explanations, relationships, sequences and distinctions rather than single words, with plausible distractors — but every answer must still be stated in the recording.'
    : 'Standard difficulty: test the important points clearly.'}
- answer must be the exact text of the correct option for multiple_choice, "True" or "False" for true_false.
- evidence = the exact words of the recording that give the answer. No two questions may test the same fact.`,
    validate(c, _segments, { settings }) {
      let dropped = 0;
      const out = [];
      for (const q of c.questions || []) {
        const question = String(q.question || '').trim();
        const answer = String(q.answer || '').trim();
        if (question.length < 8 || !answer) { dropped++; continue; }
        if (q.type === 'multiple_choice') {
          const opts = [...new Map((q.options || []).map((o) => String(o).trim()).filter(Boolean).map((o) => [norm(o), o])).values()];
          const correct = opts.filter((o) => norm(o) === norm(answer));
          if (opts.length < 3 || opts.length > 5 || correct.length !== 1) { dropped++; continue; }
          out.push({ ...q, question, answer: correct[0], options: shuffle(opts, question), accept: [] });
        } else if (q.type === 'true_false') {
          const a = /^true$/i.test(answer) ? 'True' : /^false$/i.test(answer) ? 'False' : null;
          if (!a) { dropped++; continue; }
          out.push({ ...q, question, answer: a, options: ['True', 'False'], accept: [] });
        } else if (q.type === 'short_answer') {
          if (answer.length > 120) { dropped++; continue; }
          out.push({ ...q, question, answer, options: [], accept: (q.accept || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6) });
        } else dropped++;
      }
      // a "multiple choice only" / "true or false only" quiz keeps only that type
      const wanted = settings?.types && settings.types !== 'mixed' ? settings.types : null;
      const typed = wanted ? out.filter((q) => q.type === wanted || (dropped++, false)) : out;
      const d = dedupe(typed, (q) => norm(q.question));
      c.questions = d.out;
      return dropped + d.dropped;
    },
  },

  definitions: {
    task: 'definitions',
    schema: obj({ definitions: list(obj({ term: str(), definition: str('As stated or explained in the recording'), evidence: evidence('the definition or explanation'), refs })) }),
    instructions: () => `List the KEY DEFINITIONS from the lecture above.
${GROUNDED}
Include a term only if the lecturer explicitly defined it or meaningfully explained what it is. A term that was only mentioned does not get a definition. definition = what the lecturer said (lightly cleaned, same meaning); evidence = their exact words.`,
    validate(c) { const d = dedupe(c.definitions || [], (x) => norm(x.term)); c.definitions = d.out; return d.dropped; },
  },

  exam_points: {
    task: 'exam_points',
    schema: obj({
      explicit: list(obj({ text: str(), evidence: evidence('the reference to an exam, test, quiz, assignment, or "know/study this"'), refs }), 'Only what the lecturer explicitly connected to assessment'),
      worth_reviewing: list(obj({ text: str(), reason: str('Neutral reason, e.g. "stressed twice", "lecturer called it key"'), refs }), 'Other points that seem worth reviewing'),
    }),
    instructions: () => `From the lecture above, list POSSIBLE EXAM POINTS in two strictly separate groups.
${GROUNDED}
- explicit: ONLY where the lecturer actually refers to an exam, test, quiz, midterm, assignment, grading, or says "know this", "study this", "this will be on…", "important for the exam". evidence = those exact words.
- worth_reviewing: points that seem important (stressed, repeated, called key) but were NOT tied to an assessment. Never say these will be examined.`,
    validate(c, segments) {
      let dropped = 0;
      const explicit = [];
      for (const it of c.explicit || []) {
        if (examBacked(it, segments)) explicit.push(it);
        else { dropped++; (c.worth_reviewing ||= []).push({ text: it.text, reason: 'Not tied to an exam in the recording', refs: it.refs }); }
      }
      c.explicit = explicit;
      return dropped;
    },
  },

  meeting_recap: {
    task: 'meeting_recap',
    schema: obj({
      overview: str('3–5 sentences: purpose and outcome of the meeting, with the speakers\' own certainty'),
      topics: list(topic, 'Topics discussed, in order'),
      decisions: list(decision),
      action_items: list(actionItem),
      open_questions: list(point),
      follow_ups: list(point),
      important_dates: list(dateItem),
    }),
    instructions: () => `Write a MEETING RECAP of the meeting above.
- overview: purpose and outcome in 3–5 sentences, keeping the speakers' level of certainty.
- topics: what was discussed, in order, with start_ref.
- ${DECISION_RULE}
- ${ACTION_RULE}
- open_questions: questions raised and not resolved. follow_ups: things someone said should be checked, revisited or scheduled.
- important_dates: dates and deadlines exactly as said.
A discussion, suggestion, preference or priority is not a decision. Return empty lists when nothing qualifies.`,
    validate: () => 0,
    after(c, segments) {
      c.topics = fixStarts(c.topics, segments);
      // participants come from the transcript's own speaker labels, never from the model
      const counts = new Map();
      for (const s of segments) if (s.speaker !== 'Unknown') counts.set(s.speaker, (counts.get(s.speaker) || 0) + 1);
      c.participants = [...counts].sort((a, b) => b[1] - a[1]).map(([label, lines]) => ({ label, lines }));
    },
  },

  action_plan: {
    task: 'action_plan',
    schema: obj({ tasks: list(actionItem) }),
    instructions: () => `Build an ACTION PLAN from the recording above: every task someone said they will do, was asked to do, or said needs to be done.
- ${ACTION_RULE}
Do not add tasks that would merely make sense; only ones the speakers stated. Return an empty list if there are none.`,
    validate: () => 0,
  },

  followup_email: {
    task: 'followup_email',
    schema: obj({
      subject: str(),
      body: str('The email, plain text with line breaks'),
      facts: list(obj({ fact: str('One fact, decision, task, owner, deadline, price or commitment the email states'), evidence: evidence('it'), refs })),
    }),
    instructions: ({ settings }) => `Draft a FOLLOW-UP EMAIL after the meeting above, for one of the participants to send.
- Goal of the email: ${{
    recap: 'recap the meeting and the next steps.',
    confirm: 'confirm the decisions that were explicitly agreed (only those) and who does what.',
    request: 'ask the relevant people for updates on the open items and tasks that were stated.',
    custom: 'as described in the user instructions below.',
  }[settings?.goal] || 'recap the meeting and the next steps.'}
- The wording can be polished and professional, but every fact, decision, task, owner, deadline, price and commitment taken from the meeting must keep its certainty ("we're considering…" stays considering; a suggestion is not presented as agreed).
- Do not invent commitments, owners, dates or numbers. Leave unknowns as placeholders in square brackets, e.g. [recipient name], [your name].
- facts: list every fact from the meeting that the email states, each with the exact supporting words as evidence. (Things that come only from the user instructions are not listed here.)
- Keep it concise: a greeting, the content for the goal, a closing.${userInstructions(settings)}`,
    validate(c, _s, { transcriptText, settings }) {
      c.unverified = unverifiedDetails(`${c.subject}\n${c.body}`, `${transcriptText} ${settings?.instructions || ''}`);
      return 0;
    },
  },

  reply_draft: {
    task: 'reply_draft',
    schema: obj({
      reply: str('The reply, plain text'),
      addresses: list(obj({ request: str('What the sender asked or said that the reply responds to'), evidence: evidence('it'), refs })),
    }),
    instructions: ({ settings }) => `Draft a short, natural REPLY to the voice message above, for the person who received it.
- What the reply should do: ${{
    acknowledge: 'acknowledge the message warmly and briefly.',
    confirm: 'confirm / agree to what the sender asked — without adding specifics (times, amounts) they did not ask for.',
    question: 'ask the sender a clarifying question (or two) about what they said. The reply MUST contain at least one real question.',
    follow_up: 'follow up on what the sender said and move it forward.',
    decline: 'politely decline what was asked, without inventing a reason.',
    custom: 'as described in the user instructions below.',
  }[settings?.intent] || 'acknowledge the message warmly and briefly.'}
- Respond to what the sender actually asked or said, in their terms. Keep their urgency and certainty exactly: "no rush" stays relaxed, "sometime tomorrow" does not become "first thing tomorrow", "maybe" stays maybe.
- Do not promise anything the person replying would have to decide (times, amounts, yes/no to a decision) unless the user instructions say so; otherwise leave a placeholder in square brackets, e.g. [time], or stay neutral.
- addresses: the requests/points from the message that the reply responds to, each with the exact words as evidence.${userInstructions(settings)}`,
    validate(c, _s, { transcriptText, settings }) {
      // details the user asked for are authorised; only flag what neither the message nor the user said
      c.unverified = unverifiedDetails(c.reply, `${transcriptText} ${settings?.instructions || ''}`);
      return 0;
    },
  },

  interview_qa: {
    task: 'interview_qa',
    schema: obj({
      is_interview: { type: 'boolean', description: 'false if the recording is not really a question-and-answer exchange' },
      pairs: list(obj({ question: str('The question as asked, lightly cleaned'), asked_by: nullableStr(), response: str('Faithful summary of the answer, same certainty'), answered_by: nullableStr(), refs })),
      quotes: list(quote, 'Memorable lines, copied word for word from one transcript line'),
    }),
    instructions: () => `Turn the recording above into an INTERVIEW Q&A.
- pairs: every real question that was asked and answered, in order. asked_by / answered_by = speaker labels (null if unclear). response = a faithful summary of the answer keeping its certainty. refs = the question line and the answer lines.
- If the recording is not really a question-and-answer exchange, set is_interview = false and return only the genuine questions, if any. Never force statements into Q&A form.
- quotes: 3–6 memorable lines copied word for word from a single transcript line (no paraphrase, no merging lines).`,
    validate: () => 0,
  },

  episode_notes: {
    task: 'episode_notes',
    schema: obj({
      summary: str('3–5 sentence episode summary'),
      outline: list(topic, 'Chapter outline in order'),
      takeaways: list(point),
      quotes: list(quote, 'Memorable lines, copied word for word from one transcript line'),
    }),
    instructions: () => `Write EPISODE NOTES for the podcast above.
${GROUNDED}
- summary: 3–5 sentences.
- outline: chapter outline in order, each with start_ref where the topic begins.
- takeaways: the most useful takeaways, as the speakers stated them (attributed where it matters).
- quotes: 3–6 memorable lines copied word for word from a single transcript line.`,
    validate: () => 0,
    after: (c, segments) => { c.outline = fixStarts(c.outline, segments); },
  },
};

export const ARTIFACT_KINDS = Object.keys(TOOLS);
