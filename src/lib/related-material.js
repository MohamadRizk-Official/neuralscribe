// Recording + Documents: where slides and PDFs will be added. The recording stays the main input; a document is
// optional context. Not live yet, so every entry point says "Coming soon" and explains what it will do, and
// nothing is uploaded or read. (Planned: PDF and PowerPoint, read on this device; Notes, Ask, Quiz, Flashcards
// and Study Guide use both; sources show "Recording · 24:18" and "Slide 14".)
import { toggleDetails } from './details-pop.js';

const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

// mode: 'processing' (while the recording is being transcribed) or 'result' (a finished recording)
export function relatedMaterialHtml(mode) {
  const label = mode === 'processing' ? 'Add slides or PDF' : 'Add related material';
  return `<div class="related-row" data-related>
    <button type="button" class="related-add" aria-haspopup="dialog" aria-expanded="false">${PLUS}<span>${label}</span></button>
    <span class="related-kinds">PowerPoint · PDF · optional</span>
    <span class="soon-tag sm">Coming soon</span>
  </div>`;
}

export function bindRelatedMaterial(root) {
  root?.querySelectorAll('[data-related] .related-add').forEach((b) => b.addEventListener('click', () => toggleDetails(b, 'Slides and PDFs · coming soon', [
    ['Add', 'The lecture slides, a PDF, or a meeting deck, now or later'],
    ['Then', 'Notes, Ask, Quiz, Flashcards and Study Guide use both the recording and the document'],
    ['Sources', 'Answers point to “Recording · 24:18” and “Slide 14”'],
    ['Privacy', 'Read on your device, like your audio'],
  ])));
}
