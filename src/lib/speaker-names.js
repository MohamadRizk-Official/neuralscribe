// Speaker names in AI results after a rename.
//
// Summaries, notes, answers and everything in Create quote speakers by the name they had when the result was
// made, usually "Speaker 1". Each stored segment keeps the label it was first transcribed with (`o`, see
// lib/segments.js), so once "Speaker 1" is renamed to "Hadi" those results can say "Hadi" too, without
// regenerating them or touching transcript words. Reassigned paragraphs still mark results out of date
// (content_version), because there the facts changed, not just a name.

// segments [{ speaker, orig }] -> Map(original name -> current name), only where the rename is unambiguous
// (most of that speaker's lines carry the same new name).
export function nameMapFromSegments(segments) {
  const by = new Map();
  for (const s of segments || []) {
    if (!s.orig || s.orig === 'Unknown' || !s.speaker) continue;
    const m = by.get(s.orig) || new Map();
    m.set(s.speaker, (m.get(s.speaker) || 0) + 1);
    by.set(s.orig, m);
  }
  const out = new Map();
  for (const [orig, counts] of by) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const [name, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (name !== orig && name !== 'Unknown' && n / total >= 0.7) out.set(orig, name);
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(map) {
  if (!map.size) return null;
  // whole names only: "Speaker 1" must not touch "Speaker 10"
  const keys = [...map.keys()].sort((a, b) => b.length - a.length).map(esc);
  return new RegExp(`(?<![\\p{L}\\p{N}])(${keys.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

// plain text (exports, copies)
export function renameInText(text, map) {
  const re = matcher(map);
  return re ? String(text).replace(re, (m) => map.get(m) ?? m) : text;
}

// rendered results: every text node under `root`, except the transcript itself and form fields
export function applyNames(root, map) {
  const re = matcher(map);
  if (!re || !root) return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.transcript, input, textarea, [data-keep-names]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    re.lastIndex = 0;
    if (re.test(n.data)) { re.lastIndex = 0; n.data = n.data.replace(re, (m) => map.get(m) ?? m); }
  }
}

// keep doing it as panels re-render
export function watchNames(root, getMap) {
  if (!root || !('MutationObserver' in window)) return;
  const run = () => applyNames(root, getMap());
  new MutationObserver(run).observe(root, { childList: true, subtree: true });
  run();
}
