// /library — the signed-in user's saved transcripts, newest first.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { listTranscripts, fmtDuration, fmtDate, langName } from '../lib/transcripts.js';

const $ = (id) => document.getElementById(id);

(async () => {
  if (!isConfigured) return location.replace('/auth');
  await requireUser();
  mountAccountMenu($('accountSlot'));

  try {
    const rows = await listTranscripts();
    $('libCount').textContent = rows.length ? `${rows.length} transcript${rows.length === 1 ? '' : 's'}` : 'Nothing saved yet';
    if (!rows.length) {
      $('libList').innerHTML = `<div class="panel lib-empty">
        <div class="lib-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
        <h2>Your library is empty</h2>
        <p>Transcribe a recording while you're signed in and it will be saved here automatically.</p>
        <a class="btn btn-primary" href="/">Transcribe something</a>
      </div>`;
      return;
    }
    $('libList').innerHTML = rows.map((r) => `
      <a class="panel lib-item" href="/transcript?id=${encodeURIComponent(r.id)}">
        <div class="lib-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h10M4 18h7"/></svg></div>
        <div class="lib-main">
          <div class="lib-title">${esc(r.title)}</div>
          <div class="lib-meta mono">
            <span>${esc(fmtDate(r.created_at))}</span>
            <span>${esc(fmtDuration(r.duration_seconds))}</span>
            ${r.language ? `<span>${esc(langName(r.language))}</span>` : ''}
            ${r.status !== 'completed' ? `<span class="warn">${esc(r.status)}</span>` : ''}
          </div>
        </div>
        <svg class="lib-go" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </a>`).join('');
  } catch (err) {
    $('libCount').textContent = '';
    $('libList').innerHTML = `<div class="panel lib-empty"><h2>Couldn't load your library</h2><p>${esc(err.message || err)}</p><button class="btn btn-primary" type="button" onclick="location.reload()">Try again</button></div>`;
  }
})();
