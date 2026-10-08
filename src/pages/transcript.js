// /transcript?id=… — one saved transcript, with Summary / Ask / Insights, copy / download / delete.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { getTranscript, deleteTranscript, updateRecordingType, fmtDuration, fmtDate, langName } from '../lib/transcripts.js';
import { segmentsFromRow, fmtClock, RECORDING_TYPES } from '../lib/segments.js';
import { cleanText } from '../lib/clean.js';
import { mountInsights } from '../insights/insights.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#34d399', '#60a5fa', '#fb923c', '#e879f9'];
const UNKNOWN_COLOR = '#8a93b9';
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he', 'yi', 'ps', 'sd', 'ug']);
const id = new URLSearchParams(location.search).get('id') || '';

function notFound(message) {
  $('tTitle').textContent = 'Transcript not found';
  $('tMeta').innerHTML = '';
  $('viewToggle').classList.add('hidden');
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

  const { segments, coarse } = segmentsFromRow(row);
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const colorOf = new Map();
  let n = 0;
  for (const s of speakers) colorOf.set(s, s === 'Unknown' ? UNKNOWN_COLOR : COLORS[n++ % COLORS.length]);
  const words = segments.reduce((t, s) => t + s.text.split(/\s+/).filter(Boolean).length, 0);

  const chips = [
    ['Saved', fmtDate(row.created_at)],
    ['Length', fmtDuration(row.duration_seconds)],
    row.language && ['Language', langName(row.language)],
    speakers.length && ['Speakers', String(speakers.filter((s) => s !== 'Unknown').length)],
    ['Words', words.toLocaleString()],
  ].filter(Boolean);
  $('tMeta').innerHTML = chips.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');

  // ---- transcript (Original / Clean) ----
  const rtl = RTL_LANGS.has(row.language);
  let view = 'original';
  const text = (s) => (view === 'clean' ? cleanText(s.text) : s.text);
  function renderTranscript() {
    if (!segments.length) {
      // not in the usual format: show it as plain text
      $('viewToggle').classList.add('hidden');
      $('transcript').innerHTML = `<pre class="plain-transcript">${esc(row.transcript_text || '(empty)')}</pre>`;
      return;
    }
    const groups = [];
    for (const s of segments) {
      const g = groups[groups.length - 1];
      if (g && g.speaker === s.speaker) g.items.push(s);
      else groups.push({ speaker: s.speaker, items: [s] });
    }
    $('transcript').innerHTML = groups.map((g) => `
      <div class="grp" style="--c:${colorOf.get(g.speaker)}"${rtl ? ' dir="rtl"' : ''}>
        <div class="avatar">${esc(initials(g.speaker))}</div>
        <div class="grp-body">
          <div class="grp-head"><span class="who static">${esc(g.speaker)}</span><span class="grp-time">${fmtClock(g.items[0].start)}</span></div>
          ${g.items.map((s) => `<p class="seg${player.getAttribute('src') ? '' : ' static'}" data-i="${s.id}" title="${fmtClock(s.start)}">${esc(text(s))}</p>`).join('')}
        </div>
      </div>`).join('');
  }
  $('viewToggle').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    view = b.dataset.view;
    $('viewToggle').querySelectorAll('[data-view]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderTranscript();
  });

  // ---- optional "play along": the user opens the original audio from their device (never uploaded) ----
  const player = $('attachPlayer');
  $('attachInput').addEventListener('change', () => {
    const f = $('attachInput').files[0];
    if (!f) return;
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(f);
    $('attachBar').classList.remove('hidden');
    document.body.classList.add('has-attach');
    renderTranscript();
  });
  $('attachClose').addEventListener('click', () => {
    player.pause();
    if (player.src) URL.revokeObjectURL(player.src);
    player.removeAttribute('src');
    $('attachBar').classList.add('hidden');
    document.body.classList.remove('has-attach');
    renderTranscript();
  });
  $('transcript').addEventListener('click', (e) => {
    const p = e.target.closest('.seg');
    if (!p || !player.getAttribute('src') || window.getSelection()?.toString()) return;
    player.currentTime = segments[Number(p.dataset.i)]?.start || 0;
    player.play().catch(() => {});
  });
  let lastActive = null;
  player.addEventListener('timeupdate', () => {
    const t = player.currentTime;
    let cur = null;
    for (const s of segments) { if (s.start <= t + 0.05) cur = s; else break; }
    const el = cur && $('transcript').querySelector(`.seg[data-i="${cur.id}"]`);
    if (el === lastActive) return;
    lastActive?.classList.remove('active');
    el?.classList.add('active');
    lastActive = el;
  });

  // Timestamps in Summary / Ask / Insights: play from there if the audio is open, otherwise show the line.
  function seekTo(seconds, ref) {
    if (player.getAttribute('src')) {
      player.currentTime = seconds;
      player.play().catch(() => {});
      return;
    }
    ui.showTab('transcript');
    const el = $('transcript').querySelector(`.seg[data-i="${ref}"]`) || [...$('transcript').querySelectorAll('.seg')].find((p) => segments[Number(p.dataset.i)].start >= seconds);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  let recordingType = RECORDING_TYPES.includes(row.recording_type) ? row.recording_type : null;
  const ui = mountInsights({
    tabBar: $('resTabs'),
    transcriptEls: [$('transcriptCard')],
    host: $('insightsHost'),
    ctx: {
      getId: () => row.id,
      isSignedIn: () => true,
      getSegments: () => segments,
      seek: seekTo,
      playbackTime: () => (player.getAttribute('src') ? player.currentTime || 0 : null),
      getRecordingType: () => recordingType,
      setRecordingType: async (t) => { recordingType = t; await updateRecordingType(row.id, t); },
      duration: () => row.duration_seconds || segments.at(-1)?.end || 0,
      autoGenerate: false, // reopening a saved transcript never starts generation by itself
      coarse,
    },
  });
  ui.setTranscription();
  renderTranscript();
  if (coarse && segments.length) {
    $('transcript').insertAdjacentHTML('beforebegin', '<p class="hint coarse-note">Saved before line-level timestamps were added, so links point to the start of each paragraph.</p>');
  }

  $('tActions').classList.remove('hidden');
  const base = row.title.replace(/[\\/:*?"<>|]+/g, '_');
  const exportText = () => {
    if (view !== 'clean' || !segments.length) return row.transcript_text;
    // same layout as the saved text, with the clean wording
    const out = [];
    for (const s of segments) {
      const last = out[out.length - 1];
      if (last && last.speaker === s.speaker) last.text += ' ' + cleanText(s.text);
      else out.push({ speaker: s.speaker, start: s.start, text: cleanText(s.text) });
    }
    const head = row.transcript_text.split(/\r?\n\r?\n/)[0];
    return `${head}\n\n${out.map((g) => `[${fmtClock(g.start)}] ${g.speaker}:\n${g.text}`).join('\n\n')}\n`;
  };
  $('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(exportText()); toast(view === 'clean' ? 'Copied (clean version)' : 'Copied to clipboard'); } catch { toast('Copy failed. Try .txt instead'); }
  });
  $('txtBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain;charset=utf-8' }));
    a.download = `${base}${view === 'clean' ? ' (clean)' : ''}.txt`;
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
