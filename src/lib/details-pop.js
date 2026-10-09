// "Details" on a recording: a small panel next to the button with what is useful to know about it
// (length, speakers, type, language, how it was processed). Closes on Escape, an outside click or the button.
import { esc } from './account.js';

let open = null;
function close() {
  if (!open) return;
  open.anchor.setAttribute('aria-expanded', 'false');
  open.el.remove();
  document.removeEventListener('pointerdown', open.outside, true);
  document.removeEventListener('keydown', open.key);
  open = null;
}

// rows: [[label, value, note?]]
export function toggleDetails(anchor, title, rows) {
  if (open?.anchor === anchor) return close();
  close();
  const el = document.createElement('div');
  el.className = 'details-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="dp-title">${esc(title)}</div><dl>${rows.filter(Boolean).map(([k, v, note]) => `<dt>${esc(k)}</dt><dd>${esc(v)}${note ? `<span>${esc(note)}</span>` : ''}</dd>`).join('')}</dl>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(12, Math.min(r.left, innerWidth - el.offsetWidth - 12))}px`;
  el.style.top = `${r.bottom + 8 + el.offsetHeight > innerHeight - 12 ? Math.max(12, r.top - el.offsetHeight - 8) : r.bottom + 8}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  open = { anchor, el, outside, key };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  document.addEventListener('keydown', key);
}
addEventListener('scroll', close, { passive: true });
