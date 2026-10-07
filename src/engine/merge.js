// Joining two transcripts of overlapping audio chunks (A then B, where B starts ~1 s before A ends).
// The overlap is transcribed twice, so the end of A and the start of B repeat a few words.
// We find the longest run of words where A's tail matches B's head and keep it only once.

const norm = (w) => w.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}']+/gu, '');

export function mergeOverlap(aText, bText, maxWords = 12) {
  const A = aText.trim().split(/\s+/).filter(Boolean);
  const B = bText.trim().split(/\s+/).filter(Boolean);
  if (!A.length || !B.length) return { a: aText.trim(), b: bText.trim(), removed: 0 };
  const na = A.map(norm);
  const nb = B.map(norm);

  for (let k = Math.min(maxWords, na.length, nb.length); k >= 1; k--) {
    let mismatches = 0;
    for (let i = 0; i < k; i++) if (na[na.length - k + i] !== nb[i]) mismatches++;
    const ok = mismatches === 0 ? k >= 2 || na.at(-1).length >= 4 : k >= 4 && mismatches <= 1;
    if (ok) return { a: A.join(' '), b: B.slice(k).join(' '), removed: k };
  }

  // A cut off mid-word at the boundary ("the budg") and B has the whole word ("budget is…")
  const last = na.at(-1);
  if (last.length >= 3 && nb[0] !== last && nb[0].startsWith(last)) {
    return { a: A.slice(0, -1).join(' '), b: B.join(' '), removed: 1 };
  }
  return { a: A.join(' '), b: B.join(' '), removed: 0 };
}
