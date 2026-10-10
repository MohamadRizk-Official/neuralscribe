// /transcript?id=…[&t=seconds&line=n] — one saved transcript, with Summary / Notes / Ask / Insights, rename,
// favorite, folders, copy / download / delete. t/line (from Library search) open it at that moment.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { mountMascot } from '../mascot/mascot.js';
import { mascotSignal } from '../mascot/bus.js';
import { getTranscript, updateRecordingType, updateTranscriptText, fmtDuration, fmtDate, langName } from '../lib/transcripts.js';
import { nameMapFromSegments } from '../lib/speaker-names.js';
import { renameTranscript, setFavorite, deleteTranscripts, markOpened, getRecordingMeta, listFolders } from '../lib/library.js';
import { promptDialog, confirmDialog, confirmDeleteRecordings, folderPicker, toast } from '../library/dialogs.js';
import { segmentsFromRow, segmentsToStored, fmtClock, RECORDING_TYPES, RECORDING_TYPE_LABEL, OVERLAP_LABEL } from '../lib/segments.js';
import { toggleDetails } from '../lib/details-pop.js';
import { relatedMaterialHtml, bindRelatedMaterial } from '../lib/related-material.js';
import { cleanText } from '../lib/clean.js';
import { mountInsights } from '../insights/insights.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#34d399', '#60a5fa', '#fb923c', '#e879f9'];
const UNKNOWN_COLOR = '#8a93b9';
const OVERLAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
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
  mountMascot({ page: 'transcript' });

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
  // a speaker keeps the same color everywhere for the whole recording (renames carry it along)
  const colorOf = new Map();
  let n = 0;
  for (const s of speakers) colorOf.set(s, s === 'Unknown' ? UNKNOWN_COLOR : COLORS[n++ % COLORS.length]);
  const nextColor = () => COLORS.find((c) => ![...colorOf.values()].includes(c)) || COLORS[colorOf.size % COLORS.length];
  let recordingType = RECORDING_TYPES.includes(row.recording_type) ? row.recording_type : null;
  const words = segments.reduce((t, s) => t + s.text.split(/\s+/).filter(Boolean).length, 0);

  function renderHeader() {
    // one line: length · speakers · type, and Details for the rest
    const real = new Set(segments.map((x) => x.speaker).filter((x) => x !== 'Unknown')).size;
    const chip = ([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`;
    const primary = [['Length', fmtDuration(row.duration_seconds)], segments.length && ['Speakers', String(real)]].filter(Boolean);
    $('tMeta').innerHTML = primary.map(chip).join('')
      + '<span class="type-slot" id="typeSlot"></span>'
      + '<button type="button" class="meta-btn details-btn" id="detailsBtn" aria-expanded="false" aria-haspopup="dialog">Details</button>';
    $('detailsBtn').addEventListener('click', (e) => toggleDetails(e.currentTarget, 'Recording details', [
      ['Length', fmtDuration(row.duration_seconds)],
      segments.length && ['Speakers', String(real), segments.some((x) => x.speaker === 'Unknown') ? 'plus some unclear parts' : ''],
      ['Recording type', RECORDING_TYPE_LABEL[recordingType] || (document.getElementById('typeSlot')?.innerText.replace(/^Type\s*/i, '').replace(/\s+/g, ' ').trim() || 'Auto')],
      row.language && ['Language', langName(row.language)],
      ['Words', words.toLocaleString()],
      ['Saved', fmtDate(row.created_at)],
      ['Audio', 'Stays on your device', 'only the transcript text is saved'],
    ]));
  }
  renderHeader();
  $('relatedResult').innerHTML = relatedMaterialHtml('result');
  bindRelatedMaterial($('relatedResult'));

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
      if (g && g.speaker === s.speaker && !!g.overlap === !!s.overlap) g.items.push(s);
      else groups.push({ speaker: s.speaker, overlap: !!s.overlap, items: [s] });
    }
    $('transcript').innerHTML = groups.map((g) => `
      <div class="grp${g.overlap ? ' overlap' : ''}" style="--c:${g.overlap ? UNKNOWN_COLOR : colorOf.get(g.speaker)}"${rtl ? ' dir="rtl"' : ''}>
        <div class="avatar">${g.overlap ? OVERLAP_ICON : esc(initials(g.speaker))}</div>
        <div class="grp-body">
          <div class="grp-head">${coarse ? `<span class="who static">${esc(g.speaker)}</span>` : `<button class="who" type="button" data-g="${g.items[0].id}" aria-haspopup="menu" title="Change or rename this speaker"><span class="who-name">${esc(g.overlap ? OVERLAP_LABEL : g.speaker)}</span>${CHEVRON}</button>`}<span class="grp-time">${fmtClock(g.items[0].start)}</span></div>
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
  player.addEventListener('play', () => mascotSignal('audio-play'));
  player.addEventListener('pause', () => mascotSignal('audio-pause'));
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
    const who = e.target.closest('.who[data-g]');
    if (who) { openSpeakerMenu(who, Number(who.dataset.g)); return; }
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

  // ---- speakers: rename everywhere, or say who really said a paragraph ----
  // Changes are saved to the recording (transcript words are never touched). The database then bumps the
  // recording's version, so results made before show "out of date"; a plain rename also shows the new name
  // inside those results right away (lib/speaker-names.js).
  const groupOf = (firstId) => {
    const out = [];
    let i = segments.findIndex((s) => s.id === firstId);
    const sp = segments[i]?.speaker;
    while (i >= 0 && i < segments.length && segments[i].speaker === sp) out.push(segments[i++]);
    return out;
  };
  let menuEl = null;
  const closeMenu = () => { menuEl?.remove(); menuEl = null; document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  function openSpeakerMenu(anchor, firstId) {
    closeMenu();
    const group = groupOf(firstId);
    const cur = group[0]?.speaker;
    if (!cur) return;
    const others = [...new Set(segments.map((s) => s.speaker))].filter((s) => s !== cur && s !== 'Unknown');
    const items = [{ title: 'This part was said by' }, ...others.map((s) => ({ label: s, color: colorOf.get(s), run: () => move(group, s) })),
      { label: 'Someone new…', color: nextColor(), run: async () => { const name = await askName('Who said this?', ''); if (name) move(group, name); } }];
    if (cur !== 'Unknown') items.push({ label: 'Unknown', color: UNKNOWN_COLOR, run: () => move(group, 'Unknown') });
    if (cur !== 'Unknown') items.push('hr', { label: `Rename ${cur} everywhere…`, run: async () => { const name = await askName(`Rename ${cur}`, cur); if (name && name !== cur) rename(cur, name); } });
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.setAttribute('role', 'menu');
    for (const it of items) {
      if (it === 'hr') { menuEl.appendChild(document.createElement('hr')); continue; }
      if (it.title) { const t = document.createElement('div'); t.className = 'menu-title'; t.textContent = it.title; menuEl.appendChild(t); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (it.color) b.style.setProperty('--c', it.color);
      b.innerHTML = `${it.color ? '<span class="sw"></span>' : ''}<span>${esc(it.label)}</span>`;
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    const r = anchor.getBoundingClientRect();
    menuEl.style.position = 'fixed';
    menuEl.style.left = `${Math.max(12, Math.min(r.left, innerWidth - menuEl.offsetWidth - 12))}px`;
    menuEl.style.top = `${r.bottom + 6 + menuEl.offsetHeight > innerHeight - 12 ? Math.max(12, r.top - menuEl.offsetHeight - 6) : r.bottom + 6}px`;
    menuEl.querySelector('button')?.focus({ preventScroll: true });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }
  const askName = (title, value) => promptDialog({ title, label: 'Name', value, submit: (v) => v.trim().slice(0, 60) });
  function move(group, to) {
    if (!colorOf.has(to)) colorOf.set(to, to === 'Unknown' ? UNKNOWN_COLOR : nextColor());
    for (const s of group) { s.orig ??= s.speaker; s.speaker = to; delete s.overlap; }
    afterSpeakerChange(`Moved to ${to}`);
  }
  function rename(from, to) {
    // naming someone after an existing speaker merges the two (same color)
    if (!colorOf.has(to)) colorOf.set(to, colorOf.get(from));
    for (const s of segments) if (s.speaker === from) { s.orig ??= s.speaker; s.speaker = to; }
    afterSpeakerChange(`Renamed to ${to}`);
  }
  async function afterSpeakerChange(msg) {
    const y = scrollY;
    renderTranscript();
    renderHeader();
    ui.refreshType();
    scrollTo({ top: y });
    // the saved text keeps its first block (title / length line) and is rebuilt from the segments below it
    const names = [...new Set(segments.map((s) => s.speaker).filter((s) => s !== 'Unknown'))];
    const head = (row.transcript_text || '').split(/\r?\n\r?\n/)[0]
      .replace(/^(Length: .*?· Speakers: )(.*)$/m, (_, pre, was) => pre + (/^\d+$/.test(was.trim()) ? names.length : names.join(', ')));
    const paras = [];
    for (const s of segments) {
      const last = paras[paras.length - 1];
      const who = s.overlap ? OVERLAP_LABEL : s.speaker;
      if (last && last.speaker === who) last.text += ' ' + s.text;
      else paras.push({ speaker: who, start: s.start, text: s.text });
    }
    const text = `${head}\n\n${paras.map((g) => `[${fmtClock(g.start)}] ${g.speaker}:\n${g.text}`).join('\n\n')}\n`;
    try {
      await updateTranscriptText(row.id, text, segmentsToStored(segments));
      row.transcript_text = text;
      toast(`${msg} · saved`);
      ui.transcriptChanged(); // results made before now show "out of date"
    } catch (err) {
      toast(`Couldn't save: ${err.message || err}`);
    }
  }

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
      nameMap: () => nameMapFromSegments(segments),
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
      const who = s.overlap ? OVERLAP_LABEL : s.speaker;
      if (last && last.speaker === who) last.text += ' ' + cleanText(s.text);
      else out.push({ speaker: who, start: s.start, text: cleanText(s.text) });
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

