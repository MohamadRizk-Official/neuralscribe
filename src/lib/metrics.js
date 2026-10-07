// Accuracy metrics for transcripts: Word Error Rate (WER), Character Error Rate (CER) and an
// aligned word diff for manual review. Pure functions — used by the eval page and accuracy/score.mjs.
//
// WER = (substitutions + deletions + insertions) / reference words, after normalisation.
// CER is the same on characters (spaces removed) — more meaningful for Arabic, where clitics and
// spelling variants make word boundaries fuzzy.

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

// Normalise for fair comparison: case, punctuation, Unicode forms and common Arabic spelling
// variants (alef forms, alef maqsura, taa marbuta, diacritics) shouldn't count as errors.
export function normalizeText(text, { arabic = true } = {}) {
  let t = String(text || '').normalize('NFKC').toLowerCase();
  if (arabic) {
    t = t
      .replace(ARABIC_DIACRITICS, '')
      .replace(TATWEEL, '')
      .replace(/[إأآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي');
  }
  return t
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ') // punctuation (incl. Arabic ، ؛ ؟) -> space
    .replace(/(^|\s)'+|'+(?=\s|$)/g, ' ') // quotes at word edges
    .replace(/\s+/g, ' ')
    .trim();
}

export const words = (text, opts) => normalizeText(text, opts).split(' ').filter(Boolean);

// Levenshtein alignment with backtrace. Returns counts and the aligned operations.
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const d = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = 0; i <= n; i++) d[i * W] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const del = d[(i - 1) * W + j] + 1;
      const ins = d[i * W + j - 1] + 1;
      d[i * W + j] = Math.min(sub, del, ins);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  let S = 0, D = 0, I = 0, C = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * W + j] === d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] === hyp[j - 1]) { ops.push({ op: 'ok', ref: ref[i - 1], hyp: hyp[j - 1] }); C++; }
      else { ops.push({ op: 'sub', ref: ref[i - 1], hyp: hyp[j - 1] }); S++; }
      i--; j--;
    } else if (i > 0 && d[i * W + j] === d[(i - 1) * W + j] + 1) {
      ops.push({ op: 'del', ref: ref[i - 1] }); D++; i--;
    } else {
      ops.push({ op: 'ins', hyp: hyp[j - 1] }); I++; j--;
    }
  }
  ops.reverse();
  return { S, D, I, C, N: n, ops };
}

export function wer(refText, hypText, opts) {
  const a = align(words(refText, opts), words(hypText, opts));
  return { ...a, wer: a.N ? (a.S + a.D + a.I) / a.N : a.I ? 1 : 0 };
}

export function cer(refText, hypText, opts) {
  const chars = (t) => [...normalizeText(t, opts).replace(/\s+/g, '')];
  const a = align(chars(refText), chars(hypText));
  return { S: a.S, D: a.D, I: a.I, N: a.N, cer: a.N ? (a.S + a.D + a.I) / a.N : a.I ? 1 : 0 };
}

// How many of the "important words" appear correctly in the hypothesis (case/punctuation-insensitive).
export function termRecall(terms, hypText) {
  const hyp = ` ${normalizeText(hypText)} `;
  const list = terms.map((t) => normalizeText(t)).filter(Boolean);
  const found = list.filter((t) => hyp.includes(` ${t} `));
  return { found: found.length, total: list.length, missing: list.filter((t) => !found.includes(t)) };
}

export const pct = (x) => (x * 100).toFixed(1) + '%';
