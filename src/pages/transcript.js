// /transcript?id=…[&t=seconds&line=n] — one saved transcript, with Summary / Notes / Ask / Insights, rename,
// favorite, folders, copy / download / delete. t/line (from Library search) open it at that moment.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { getTranscript, updateRecordingType, fmtDuration, fmtDate, langName } from '../lib/transcripts.js';
import { renameTranscript, setFavorite, deleteTranscripts, markOpened, getRecordingMeta, listFolders } from '../lib/library.js';
import { promptDialog, confirmDialog, confirmDeleteRecordings, folderPicker, toast } from '../library/dialogs.js';
import { segmentsFromRow, fmtClock, RECORDING_TYPES } from '../lib/segments.js';
import { cleanText } from '../lib/clean.js';
import { mountInsights } from '../insights/insights.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#34d399', '#60a5fa', '#fb923c', '#e879f9'];
const UNKNOWN_COLOR = '#8a93b9';
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he', 'yi', 'ps', 'sd', 'ug']);
const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const startAt = Number.isFinite(parseFloat(params.get('t'))) ? Math.max(0, parseFloat(params.get('t'))) : null;
const startLine = /^d+$/.test(params.get('line') || '') ? Number(params.get('line')) : null;

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

  const showTitle = () => {
    document.title = `${row.title} — SparkScribe`;
    $('tTitle').textContent = row.title;
    $('tTitle').title = row.title;
  };
  showTitle();
  markOpened(row.id); // for the Library's "Recent" view

  const { segments, coarse } = segmentsFromRow(row);
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const colorOf = new Map();
  let n = 0;
  for (const s of speakers) colorOf.set(s, s === 'Unknown' ? UNKNOWN_COLOR : COLORS[n++ % COLORS.length]);
  const words = segments.reduce((t, s) => t + s.text.split(/\s+/).filter(Boolean).length, 0);

  // primary line: length · speakers · type; the rest sits behind "Details"
  const chip = ([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`;
  const primary = [['Length', fmtDuration(row.duration_seconds)], speakers.length && ['Speakers', String(speakers.filter((s) => s !== 'Unknown').length)]].filter(Boolean);
  const details = [['Saved', fmtDate(row.created_at)], row.language && ['Language', langName(row.language)], ['Words', words.toLocaleString()]].filter(Boolean);
  $('tMeta').innerHTML = primary.map(chip).join('')
    + '<span class="type-slot" id="typeSlot"></span>'
    + '<button type="button" class="meta-btn details-btn" id="detailsBtn" aria-expanded="false" aria-controls="tDetails">Details</button>';
  $('tMeta').insertAdjacentHTML('afterend', `<div class="meta-chips meta-details" id="tDetails" hidden>${details.map(chip).join('')}</div>`);
  $('detailsBtn').addEventListener('click', () => {
    const open = $('tDetails').hidden;
    $('tDetails').hidden = !open;
    $('detailsBtn').setAttribute('aria-expanded', String(open));
  });

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
    if (startAt != null && !player.dataset.started) { player.dataset.started = '1'; player.currentTime = startAt; }
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

  // Timestamps in Summary / Notes / Ask / Insights: play from there if the audio is open, otherwise show the line.
  function seekTo(seconds, ref, { instant = false } = {}) {
    if (player.getAttribute('src')) {
      player.currentTime = seconds;
      player.play().catch(() => {});
      return;
    }
    ui.showTab('transcript');
    const el = $('transcript').querySelector(`.seg[data-i="${ref}"]`) || [...$('transcript').querySelectorAll('.seg')].find((p) => segments[Number(p.dataset.i)].start >= seconds);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
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
      typeSlot: () => $('typeSlot'),
      duration: () => row.duration_seconds || segments.at(-1)?.end || 0,
      autoGenerate: false, // reopening a saved transcript never starts generation by itself
      coarse,
      title: () => row.title,
      createdAt: () => row.created_at,
      toast,
      confirm: (title, text, okLabel, danger) => confirmDialog({ title, bodyHtml: `<p>${esc(text)}</p>`, confirmLabel: okLabel, danger }),
    },
  });
  ui.setTranscription();
  renderTranscript();
  if (coarse && segments.length) {
    $('transcript').insertAdjacentHTML('beforebegin', '<p class="hint coarse-note">Saved before line-level timestamps were added, so links point to the start of each paragraph.</p>');
  }
  // opened from a Library search result: jump straight to that line (or, for older saves, that paragraph)
  if (startAt != null && segments.length) {
    const byLine = !coarse && startLine != null && segments[startLine] && Math.abs(segments[startLine].start - startAt) < 1 ? segments[startLine] : null;
    const target = byLine || [...segments].reverse().find((x) => x.start <= startAt + 0.01) || segments[0];
    seekTo(target.start, target.id, { instant: true });
  }

  $('tActions').classList.remove('hidden');
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
    try { await navigator.clipboard.writeText(exportText()); toast(view === 'clean' ? 'Copied (clean version)' : 'Copied to clipboard'); } catch { toast('Copy failed. Try Export instead'); }
  });
  // transcript, summary, notes, insights and anything created, as PDF / Word / Markdown / text / subtitles
  $('exportBtn').addEventListener('click', () => ui.openExport(view === 'clean' ? 'transcript_clean' : 'transcript'));

  $('deleteBtn').addEventListener('click', async () => {
    if (!(await confirmDeleteRecordings(1, row.title))) return;
    $('deleteBtn').disabled = true;
    $('deleteBtn').textContent = 'Deleting…';
    try {
      await deleteTranscripts(row.id);
      location.replace('/library');
    } catch (err) {
      $('deleteBtn').disabled = false;
      $('deleteBtn').textContent = 'Delete';
      toast(err.message || 'Delete failed');
    }
  });

  // ---- rename / favorite / folders ----
  $('renameBtn').hidden = false;
  $('renameBtn').addEventListener('click', async () => {
    const title = await promptDialog({ title: 'Rename recording', label: 'Name', value: row.title, submit: (v) => renameTranscript(row.id, v) });
    if (!title) return;
    row.title = title;
    showTitle();
    toast('Renamed');
  });
  let meta = { isFavorite: !!row.is_favorite, folderIds: [] };
  let folders = [];
  const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  const renderMeta = () => {
    $('favBtn').classList.toggle('on', meta.isFavorite);
    $('favBtn').setAttribute('aria-pressed', String(meta.isFavorite));
    $('favBtn').title = meta.isFavorite ? 'Remove from favorites' : 'Add to favorites';
    $('tFolders').innerHTML = folders.filter((f) => meta.folderIds.includes(f.id))
      .map((f) => `<a class="lib-folder" href="/library?folder=${encodeURIComponent(f.id)}">${folderIcon}${esc(f.name)}</a>`).join('');
  };
  const loadMeta = async () => {
    try {
      const [m, list] = await Promise.all([getRecordingMeta(row.id), listFolders()]);
      if (m) meta = m;
      folders = list;
    } catch { /* favorites and folders are extras; the transcript still works without them */ }
    renderMeta();
  };
  renderMeta();
  loadMeta();
  $('favBtn').addEventListener('click', async () => {
    meta.isFavorite = !meta.isFavorite;
    renderMeta();
    try { await setFavorite(row.id, meta.isFavorite); toast(meta.isFavorite ? 'Added to favorites' : 'Removed from favorites'); }
    catch (err) { meta.isFavorite = !meta.isFavorite; renderMeta(); toast(err.message || 'That didn’t work'); }
  });
  $('foldersBtn').addEventListener('click', () => folderPicker({ ids: [row.id], currentIds: meta.folderIds, onChange: () => loadMeta() }));
})();

