// /transcript?id=… — one saved transcript, with copy / download / delete.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { getTranscript, deleteTranscript, parseTranscriptText, fmtDuration, fmtDate, langName } from '../lib/transcripts.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#34d399', '#60a5fa', '#fb923c', '#e879f9'];
const UNKNOWN_COLOR = '#8a93b9';
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he', 'yi', 'ps', 'sd', 'ug']);
const id = new URLSearchParams(location.search).get('id') || '';

function notFound(message) {
  $('tTitle').textContent = 'Transcript not found';
  $('tMeta').innerHTML = '';
  $('transcript').innerHTML = `<div class="empty">${esc(message)}<br><br><a class="btn btn-primary" href="/library">Back to My Library</a></div>`;
}

function initials(name) {
  if (name === 'Unknown') return '?';
  const m = /^speaker\s*(\d+)$/i.exec(name.trim());
  if (m) return 'S' + m[1];
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
}

(async () => {
  if (!isConfigured) return location.replace('/auth');
  await requireUser();
  mountAccountMenu($('accountSlot'));

  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound("That link doesn't point to a transcript.");

  let row;
  try {
    row = await getTranscript(id);
  } catch (err) {
    return notFound(`Couldn't load it: ${err.message || err}`);
  }
  // RLS returns nothing for other people's transcripts, so "not yours" looks exactly like "doesn't exist".
  if (!row) return notFound("It may have been deleted, or it belongs to a different account.");

  document.title = `${row.title} — SparkScribe`;
  $('tTitle').textContent = row.title;
  $('tTitle').title = row.title;

  const groups = parseTranscriptText(row.transcript_text);
  const speakers = [...new Set(groups.map((g) => g.speaker))];
  const colorOf = new Map();
  let n = 0;
  for (const s of speakers) colorOf.set(s, s === 'Unknown' ? UNKNOWN_COLOR : COLORS[n++ % COLORS.length]);
  const words = groups.reduce((t, g) => t + g.text.split(/\s+/).filter(Boolean).length, 0);

  const chips = [
    ['Saved', fmtDate(row.created_at)],
    ['Length', fmtDuration(row.duration_seconds)],
    row.language && ['Language', langName(row.language)],
    speakers.length && ['Speakers', String(speakers.filter((s) => s !== 'Unknown').length)],
    ['Words', words.toLocaleString()],
  ].filter(Boolean);
  $('tMeta').innerHTML = chips.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');

  const rtl = RTL_LANGS.has(row.language);
  if (groups.length) {
    $('transcript').innerHTML = groups.map((g) => `
      <div class="grp" style="--c:${colorOf.get(g.speaker)}"${rtl ? ' dir="rtl"' : ''}>
        <div class="avatar">${esc(initials(g.speaker))}</div>
        <div class="grp-body">
          <div class="grp-head"><span class="who static">${esc(g.speaker)}</span><span class="grp-time">${esc(g.time)}</span></div>
          <p class="seg static">${esc(g.text)}</p>
        </div>
      </div>`).join('');
  } else {
    // not in the usual format: show it as plain text
    $('transcript').innerHTML = `<pre class="plain-transcript">${esc(row.transcript_text || '(empty)')}</pre>`;
  }

  $('tActions').classList.remove('hidden');
  const base = row.title.replace(/[\\/:*?"<>|]+/g, '_');
  $('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(row.transcript_text); toast('Copied to clipboard'); } catch { toast('Copy failed. Try .txt instead'); }
  });
  $('txtBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([row.transcript_text], { type: 'text/plain;charset=utf-8' }));
    a.download = `${base}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const dlg = $('confirmDlg');
  $('deleteBtn').addEventListener('click', () => dlg.showModal());
  // Act on the button itself rather than the dialog's `close` event, which some browsers don't fire
  // reliably for form-method="dialog". Cancel / Esc just close the dialog.
  $('confirmDelete').addEventListener('click', async (e) => {
    e.preventDefault();
    dlg.close();
    $('deleteBtn').disabled = true;
    $('deleteBtn').textContent = 'Deleting…';
    try {
      await deleteTranscript(row.id);
      location.replace('/library');
    } catch (err) {
      $('deleteBtn').disabled = false;
      $('deleteBtn').textContent = 'Delete';
      toast(err.message || 'Delete failed');
    }
  });
})();

let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
}
