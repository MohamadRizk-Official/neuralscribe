// "Clean" reading view of a transcript line. Rule-based on purpose: it can only delete obvious filler
// and immediate repetitions, so it can never invent words, summarise, or change meaning, and it costs
// nothing. The original text is never modified; callers keep both.
//
// Removes:  hesitation sounds (um, uh, erm, er, ah, hmm, mm)
//           immediate repeated words ("the the") and repeated short phrases ("I think I think")
//           stutter fragments ("I- I", "w- we")
// Keeps:    words that can carry meaning (like, you know, so, well, actually, I mean), numbers, negations,
//           and anything in other languages (only English hesitation sounds are listed).

const FILLER = '(?:u+h*m+|u+h+|e+r+m+|e+r+|a+h+|h+m+|m+h*m+)';
// a filler at the start of a sentence: drop it and capitalise the word that now starts the sentence
const LEAD_FILLER_RE = new RegExp(`(^|[.!?…]\\s+)${FILLER}[,.…]*\\s+(\\p{L})`, 'giu');
// a filler anywhere else, with the comma that usually follows it
const FILLER_RE = new RegExp(`(^|[\\s,;:—-])${FILLER}(?=[\\s,.;:!?…—-]|$)[,…]*`, 'giu');

export function cleanText(text) {
  const original = String(text || '');
  if (!original.trim()) return original;
  let t = original;

  t = t.replace(LEAD_FILLER_RE, (m, lead, c) => lead + c.toUpperCase());
  t = t.replace(new RegExp(`,\\s*${FILLER},(?=\\s)`, 'giu'), ''); // "We, uh, need" -> "We need"
  t = t.replace(FILLER_RE, (m, lead) => (lead === '' ? '' : ' '));

  // stutters: "I- I think" -> "I think", "w- we" -> "we"
  t = t.replace(/(^|\s)(\p{L}{1,3})[-–]\s+(?=(\p{L}+))/gu, (m, lead, frag, next) =>
    next.toLowerCase().startsWith(frag.toLowerCase()) ? lead : m);

  // repeated phrases: "I think, I think" -> "I think" (2–4 words, optional comma); single words only when
  // directly repeated without a comma ("the the"), so emphasis like "no, no, no" is kept. Letters only:
  // repeated numbers ("2 2") may be meaningful and are left alone.
  const w = "\\p{L}[\\p{L}'’]*";
  for (let n = 4; n >= 1; n--) {
    const phrase = Array.from({ length: n }, () => w).join('\\s+');
    const sep = n === 1 ? '\\s+' : ',?\\s+';
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(${phrase})(?:${sep}\\1)+(?![\\p{L}\\p{N}])`, 'giu');
    t = t.replace(re, '$1');
  }

  t = t
    .replace(/\s+([,.;:!?…])/g, '$1') // space before punctuation
    .replace(/,(?=[.!?…])/g, '') // ",." left by a removed filler
    .replace(/^[\s,;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // a line that was only filler stays visible rather than vanishing silently
  return /[\p{L}\p{N}]/u.test(t) ? t : original;
}
