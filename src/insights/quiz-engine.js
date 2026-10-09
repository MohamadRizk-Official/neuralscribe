// Practice Quiz engine: pure functions, no DOM. The questions are the stored, grounded quiz (generated once);
// everything here only decides WHICH stored question comes next, in what option order, and how it's scored.
// Nothing here calls the AI, so starting, retaking or retaking only the missed questions is free.
//
// A run is a queue of items { qi, order }: qi = index of the stored question, order = the order its options
// are shown in. Keeping the queue explicit is what later lets an adaptive mode insert items (repeat a weak
// concept, a harder follow-up, spaced review) without changing the screens.
import { shortAnswerCorrect } from './tools.js';

const shuffled = (arr) => arr.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

/**
 * @param {object[]} questions  stored quiz questions
 * @param {{ only?: number[]|null, shuffle?: boolean }} o
 *   only: retake just these question indices; shuffle: new option order for multiple choice (the correct
 *   answer is the same text, only its position changes; True / False keep their natural order)
 */
export function newRun(questions, { only = null, shuffle = false } = {}) {
  const pick = only?.length ? only.filter((i) => questions[i]) : questions.map((_, i) => i);
  return {
    kind: only?.length ? 'missed' : 'full',
    items: pick.map((qi) => {
      const n = questions[qi].options?.length || 0;
      const base = [...Array(n).keys()];
      return { qi, order: shuffle && questions[qi].type === 'multiple_choice' ? shuffled(base) : base };
    }),
    i: 0,
    answers: [],          // per item: { given, correct, overridden? }
    done: false,
  };
}

export const currentItem = (run) => run.items[run.i];
export const answeredCount = (run) => run.answers.filter(Boolean).length;
export const correctCount = (run) => run.answers.filter((a) => a?.correct).length;

// grade one answer for the current item; choices must match exactly, short answers are checked leniently
export function answer(run, questions, given) {
  const q = questions[currentItem(run).qi];
  const correct = q.type === 'short_answer' ? shortAnswerCorrect(given, q) : given === q.answer;
  run.answers[run.i] = { given, correct };
  return correct;
}
// the learner says their short answer was right
export function overrideCorrect(run) { if (run.answers[run.i]) { run.answers[run.i].correct = true; run.answers[run.i].overridden = true; } }

// → true when that was the last item
export function advance(run) {
  if (run.i < run.items.length - 1) { run.i++; return false; }
  run.done = true;
  return true;
}

// summary of a finished run: indices of stored questions answered right / missed
export function summary(run) {
  const strong = [], missed = [];
  run.items.forEach((it, k) => (run.answers[k]?.correct ? strong : missed).push(it.qi));
  return { strong, missed, score: strong.length, total: run.items.length };
}
