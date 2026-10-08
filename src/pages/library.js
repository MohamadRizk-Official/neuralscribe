// /library — the signed-in user's personal archive: Recent / All / Favorites / Folders, filters, sorting,
// search across every transcript (with timestamps), favorites, folders, rename and bulk actions.
// Data comes a page at a time from the database (src/lib/library.js); nothing here calls an AI service.
import { isConfigured } from '../lib/supabase.js';
import { mountAccountMenu, requireUser, esc } from '../lib/account.js';
import { fmtDuration } from '../lib/transcripts.js';
import { fmtClock, RECORDING_TYPE_LABEL } from '../lib/segments.js';
import {
  PAGE_SIZE, SEARCH_PAGE_SIZE, listLibrary, searchLibrary, libraryStats, listFolders, renameTranscript, setFavorite,
  deleteTranscripts, removeFromFolder, renameFolder, deleteFolder, createFolder, highlight, fmtHours,
} from '../lib/library.js';
import { promptDialog, confirmDialog, confirmDeleteRecordings, folderPicker, toast } from '../library/dialogs.js';

const $ = (id) => document.getElementById(id);
const TYPES = ['lecture', 'meeting', 'voice_message', 'interview', 'podcast', 'general'];
const TYPE_PLURAL = { lecture: 'Lectures', meeting: 'Meetings', voice_message: 'Voice Messages', interview: 'Interviews', podcast: 'Podcasts', general: 'General' };
const VIEWS = ['recent', 'all', 'favorites', 'folders'];
const SORTS = ['newest', 'oldest', 'longest', 'shortest', 'az'];

const EMPTY = {
  library: ['Your library is empty', 'Transcribe a recording while you’re signed in and it’s saved here, searchable and private to you.', true],
  favorites: ['No favorites yet', 'Tap the star on any recording to keep it here.'],
  folder: ['This folder is empty', 'Open a recording’s ⋯ menu and choose Folders, or use Select to add several at once.'],
  date: ['Nothing from this period', 'Try a longer time range.'],
  lecture: ['No lectures yet', 'Upload a lecture to start building your study library.', true],
  meeting: ['No meetings yet', 'Transcribe a meeting and its decisions and action items are one click away.', true],
  voice_message: ['No voice messages yet', 'Drop in a WhatsApp or voice note to keep it searchable.', true],
  interview: ['No interviews yet', 'Transcribe an interview to keep every question and answer searchable.', true],
  podcast: ['No podcasts yet', 'Transcribe an episode to search everything that was said.', true],
  general: ['No general recordings', 'Recordings without a type show up here.'],
};

const ICON = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
};

// ---------- state (mirrored in the URL so Back / reload / sharing a link with yourself work) ----------
const st = {
  view: 'all', folder: null, type: null, date: '', sort: 'newest', q: '',
  rows: [], total: null, offset: 0, loading: false, done: false,
  results: [], resOffset: 0, resDone: false,
  folders: [], stats: null,
  selecting: false, selected: new Set(),
};
let token = 0; // ignore responses from requests that were superseded

function readUrl() {
  const p = new URLSearchParams(location.search);
  st.view = VIEWS.includes(p.get('view')) ? p.get('view') : 'all';
  st.folder = /^[0-9a-f-]{36}$/i.test(p.get('folder') || '') ? p.get('folder') : null;
  if (st.folder) st.view = 'folders';
  st.type = TYPES.includes(p.get('type')) ? p.get('type') : null;
  st.date = ['7', '30', '365'].includes(p.get('date')) ? p.get('date') : '';
  st.sort = SORTS.includes(p.get('sort')) ? p.get('sort') : 'newest';
  st.q = (p.get('q') || '').slice(0, 200);
}
function writeUrl(push = false) {
  const p = new URLSearchParams();
  if (st.view !== 'all' && !st.folder) p.set('view', st.view);
  if (st.folder) p.set('folder', st.folder);
  if (st.type) p.set('type', st.type);
  if (st.date) p.set('date', st.date);
  if (st.sort !== 'newest') p.set('sort', st.sort);
  if (st.q) p.set('q', st.q);
  const url = `/library${p.toString() ? `?${p}` : ''}`;
  if (url !== location.pathname + location.search) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

const searching = () => st.q.trim().length >= 2;
const sinceDate = () => (st.date ? new Date(Date.now() - Number(st.date) * 86400000) : null);
const folderName = (id) => st.folders.find((f) => f.id === id)?.name;
const listView = () => (st.folder ? 'all' : st.view === 'recent' ? 'recent' : st.view === 'favorites' ? 'favorites' : 'all');

function shortDate(iso) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
const badge = (type) => (type && type !== 'general' ? `<span class="type-badge t-${type}">${esc(RECORDING_TYPE_LABEL[type])}</span>` : '');
const openUrl = (id, extra = '') => `/transcript?id=${encodeURIComponent(id)}${extra}`;

// ---------- header stats + type chips ----------
function renderStats() {
  const s = st.stats;
  if (!s) return;
  const n = Number(s.recordings);
  $('libStats').textContent = n
    ? [`${n} recording${n === 1 ? '' : 's'}`, `${fmtHours(Number(s.seconds))} transcribed`, `${s.this_month} this month`].join(' · ')
    : 'Nothing saved yet';
}
function renderTypeChips() {
  const by = st.stats?.by_type || {};
  const present = TYPES.filter((t) => by[t] > 0);
  // a type filter only helps once there is more than one kind of recording (or one is already chosen)
  if (present.length < 2 && !st.type) { $('typeChips').innerHTML = ''; return; }
  const chip = (t, label, n) => `<button type="button" class="type-chip${st.type === t ? ' on' : ''}" data-type="${t || ''}" aria-pressed="${st.type === t}">${esc(label)}${n != null ? ` <span>${n}</span>` : ''}</button>`;
  $('typeChips').innerHTML = chip(null, 'All types') + present.map((t) => chip(t, TYPE_PLURAL[t], by[t])).join('')
    + (st.type && !present.includes(st.type) ? chip(st.type, TYPE_PLURAL[st.type], 0) : '');
}

// ---------- chrome: tabs, toolbar, folder header ----------
function renderChrome() {
  const activeView = st.folder ? 'folders' : st.view;
  $('viewTabs').querySelectorAll('[data-view]').forEach((b) => {
    const on = !searching() && b.dataset.view === activeView;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const folderOverview = st.view === 'folders' && !st.folder;
  $('toolbar').hidden = searching() || folderOverview;
  $('sortSel').hidden = st.view === 'recent' && !st.folder; // Recent is always "recently opened"
  $('sortSel').value = st.sort;
  $('dateSel').value = st.date;
  $('selectBtn').textContent = st.selecting ? 'Done' : 'Select';
  $('selectBtn').setAttribute('aria-pressed', String(st.selecting));
  $('qClear').hidden = !st.q;
  renderTypeChips();

  const fh = $('folderHead');
  if (st.folder && !searching()) {
    const name = folderName(st.folder) || 'Folder';
    fh.hidden = false;
    fh.innerHTML = `<button class="btn btn-ghost btn-sm" type="button" data-act="folders">${ICON.back}<span>Folders</span></button>
      <h2 class="folder-title">${ICON.folder}<span>${esc(name)}</span></h2>
      <div class="folder-actions"><button class="btn btn-ghost btn-sm" type="button" data-act="rename-folder">Rename</button>
      <button class="btn btn-ghost btn-sm" type="button" data-act="delete-folder">Delete folder</button></div>`;
  } else {
    fh.hidden = true;
    fh.innerHTML = '';
  }
  renderBulkBar();
}

// ---------- recordings list ----------
function cardHtml(r) {
  const sel = st.selected.has(r.id);
  const meta = [shortDate(r.created_at), fmtDuration(r.duration_seconds), r.speaker_count ? `${r.speaker_count} speaker${r.speaker_count === 1 ? '' : 's'}` : null]
    .filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
  const preview = r.summary
    ? `<p class="lib-preview">${esc(r.summary)}</p>`
    : r.preview ? `<p class="lib-preview quote">“${esc(r.preview)}”</p>` : '';
  const folders = st.folder ? '' : (r.folder_ids || []).map(folderName).filter(Boolean).slice(0, 3)
    .map((n) => `<span class="lib-folder">${ICON.folder}${esc(n)}</span>`).join('');
  return `<article class="panel lib-card${sel ? ' selected' : ''}${st.selecting ? ' selecting' : ''}" data-id="${r.id}">
    ${st.selecting ? `<label class="lib-check"><input type="checkbox" ${sel ? 'checked' : ''} aria-label="Select ${esc(r.title)}" /></label>` : ''}
    <a class="lib-card-main" href="${openUrl(r.id)}">
      <div class="lib-card-top"><span class="lib-title">${esc(r.title)}</span>${badge(r.recording_type)}</div>
      <div class="lib-meta mono">${meta}${r.status !== 'completed' ? `<span class="warn">${esc(r.status)}</span>` : ''}</div>
      ${preview}
      ${folders ? `<div class="lib-folders">${folders}</div>` : ''}
    </a>
    <div class="lib-card-actions">
      <button class="icon-btn star${r.is_favorite ? ' on' : ''}" type="button" data-act="star" aria-pressed="${r.is_favorite}" aria-label="${r.is_favorite ? 'Remove from favorites' : 'Add to favorites'}" title="${r.is_favorite ? 'Favorite' : 'Add to favorites'}">${ICON.star}</button>
      <button class="icon-btn" type="button" data-act="menu" aria-label="More actions for ${esc(r.title)}">${ICON.more}</button>
    </div>
  </article>`;
}

function emptyHtml() {
  let key = 'library';
  if (st.folder) key = 'folder';
  else if (st.type) key = st.type;
  else if (st.view === 'favorites') key = 'favorites';
  else if (st.date) key = 'date';
  const [title, text, cta] = EMPTY[key];
  return `<div class="panel lib-empty">
    <div class="lib-empty-icon" aria-hidden="true">${key === 'favorites' ? ICON.star : key === 'folder' ? ICON.folder : '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}</div>
    <h2>${esc(title)}</h2><p>${esc(text)}</p>
    ${cta ? '<a class="btn btn-primary" href="/">Transcribe something</a>' : ''}
    ${st.type && st.type !== 'general' ? '<p class="lib-empty-hint">Tip: set a recording’s type from its Notes or Insights tab.</p>' : ''}
  </div>`;
}

function renderList() {
  const list = $('libList');
  if (!st.rows.length) {
    list.innerHTML = st.loading ? '<div class="lib-skel"></div><div class="lib-skel"></div><div class="lib-skel"></div>' : emptyHtml();
  } else {
    list.innerHTML = st.rows.map(cardHtml).join('');
  }
  renderMore();
}
function renderMore() {
  const more = $('libMore');
  if (searching()) {
    more.innerHTML = st.results.length && !st.resDone
      ? `<button class="btn btn-ghost" type="button" data-act="more-results"${st.loading ? ' disabled' : ''}>${st.loading ? 'Searching…' : 'More results'}</button>` : '';
    return;
  }
  if (st.view === 'folders' && !st.folder) { more.innerHTML = ''; return; }
  more.innerHTML = st.rows.length && !st.done
    ? `<button class="btn btn-ghost" type="button" data-act="more"${st.loading ? ' disabled' : ''}>${st.loading ? 'Loading…' : `Show more${st.total ? ` (${st.total - st.rows.length} left)` : ''}`}</button>`
    : st.rows.length > PAGE_SIZE ? `<p class="lib-end mono">${st.rows.length} recordings</p>` : '';
}

async function loadRows(reset = true) {
  const my = ++token;
  if (reset) { st.rows = []; st.offset = 0; st.done = false; st.total = null; }
  st.loading = true;
  renderList();
  try {
    const { rows, total } = await listLibrary({
      view: listView(), type: st.type, folder: st.folder, since: sinceDate(),
      sort: st.view === 'recent' && !st.folder ? 'recent' : st.sort, offset: st.offset, limit: PAGE_SIZE,
    });
    if (my !== token) return;
    st.rows = reset ? rows : [...st.rows, ...rows];
    if (total != null) st.total = total;
    st.offset += rows.length;
    st.done = rows.length < PAGE_SIZE || (st.total != null && st.rows.length >= st.total);
  } catch (err) {
    if (my !== token) return;
    st.loading = false;
    $('libList').innerHTML = `<div class="panel lib-empty"><h2>Couldn’t load your library</h2><p>${esc(err.message || err)}</p><button class="btn btn-primary" type="button" data-act="retry">Try again</button></div>`;
    $('libMore').innerHTML = '';
    return;
  }
  st.loading = false;
  renderList();
}

// ---------- folders overview ----------
function renderFolders() {
  const tiles = st.folders.map((f) => `<a class="panel folder-tile" href="/library?folder=${f.id}" data-folder="${f.id}">
      <span class="folder-tile-ic">${ICON.folder}</span>
      <span class="folder-tile-name">${esc(f.name)}</span>
      <span class="folder-tile-n mono">${f.count} recording${f.count === 1 ? '' : 's'}</span></a>`).join('');
  $('libList').innerHTML = `<div class="folder-grid">
    <button class="panel folder-tile new" type="button" data-act="new-folder"><span class="folder-tile-ic">${ICON.plus}</span><span class="folder-tile-name">New folder</span><span class="folder-tile-n mono">e.g. Biology 101</span></button>
    ${tiles}</div>
    ${st.folders.length ? '' : '<p class="lib-empty-hint center">Folders keep related recordings together — a course, a client, a project. A recording can be in more than one folder, and deleting a folder never deletes recordings.</p>'}`;
  $('libMore').innerHTML = '';
}
async function loadFolders() {
  try { st.folders = await listFolders(); } catch { st.folders = []; }
}

// ---------- search ----------
function hitTime(r, h) {
  if (h.start == null) return '';
  return r.coarse
    ? `<span class="sr-time coarse" title="Start of the paragraph (saved before line-level timestamps)">¶ ${fmtClock(h.start)}</span>`
    : `<span class="sr-time">${fmtClock(h.start)}</span>`;
}
function hitUrl(r, h) {
  if (h.start == null) return openUrl(r.transcription_id);
  return openUrl(r.transcription_id, `&t=${Math.floor(h.start * 100) / 100}${h.line != null ? `&line=${h.line}` : ''}`);
}
function resultHtml(r) {
  const transcriptHits = r.hits.filter((h) => h.source === 'transcript');
  const noteHits = r.hits.filter((h) => h.source === 'notes');
  const extra = r.match_count - transcriptHits.length;
  const why = [];
  if (r.title_match) why.push('Title');
  if (r.match_count) why.push(`${r.match_count} match${r.match_count === 1 ? '' : 'es'} in transcript`);
  if (!r.match_count && noteHits.length) why.push('Notes only');
  const hit = (h) => `<li class="sr-hit${h.source === 'notes' ? ' notes' : ''}"><a href="${hitUrl(r, h)}">
      ${h.source === 'notes' ? '<span class="sr-tag" title="AI-generated Notes, not the transcript">Notes</span>' : hitTime(r, h)}
      ${h.source === 'transcript' && h.speaker ? `<span class="sr-sp">${esc(h.speaker)}</span>` : ''}
      <span class="sr-snip">${highlight(h.snippet)}</span></a></li>`;
  return `<article class="panel sr-item">
    <div class="sr-head"><a class="sr-title" href="${openUrl(r.transcription_id)}">${r.title_match ? highlightTitle(r.title) : esc(r.title)}</a>${badge(r.recording_type)}</div>
    <div class="lib-meta mono"><span>${esc(shortDate(r.created_at))}</span><span>${esc(fmtDuration(r.duration_seconds))}</span><span class="sr-why">${esc(why.join(' · '))}</span></div>
    ${transcriptHits.length || noteHits.length ? `<ul class="sr-hits">${transcriptHits.map(hit).join('')}${noteHits.map(hit).join('')}</ul>` : ''}
    ${extra > 0 ? `<a class="sr-more" href="${hitUrl(r, transcriptHits[0])}">+ ${extra} more match${extra === 1 ? '' : 'es'} in this recording</a>` : ''}
  </article>`;
}
function highlightTitle(title) {
  const q = st.q.trim();
  const i = title.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(title);
  return esc(title.slice(0, i)) + '<mark>' + esc(title.slice(i, i + q.length)) + '</mark>' + esc(title.slice(i + q.length));
}
function renderResults() {
  const q = st.q.trim();
  const head = `<div class="sr-summary"><span>${st.loading && !st.results.length ? 'Searching' : st.results.length ? 'Results' : 'No matches'} for “${esc(q)}”</span>
    <button class="btn btn-ghost btn-sm" type="button" data-act="clear-search">Clear</button></div>`;
  let body;
  if (st.loading && !st.results.length) body = '<div class="lib-skel"></div><div class="lib-skel"></div>';
  else if (!st.results.length) body = `<div class="panel lib-empty"><h2>No matches</h2><p>Search looks in titles, transcripts, speaker names and your Notes. Try another word, or put an exact phrase in quotes.</p></div>`;
  else body = st.results.map(resultHtml).join('');
  $('libList').innerHTML = head + body;
  renderMore();
}
async function runSearch(reset = true) {
  const my = ++token;
  if (reset) { st.results = []; st.resOffset = 0; st.resDone = false; }
  st.loading = true;
  renderResults();
  try {
    const rows = await searchLibrary(st.q.trim(), { offset: st.resOffset, limit: SEARCH_PAGE_SIZE });
    if (my !== token) return;
    st.results = reset ? rows : [...st.results, ...rows];
    st.resOffset += rows.length;
    st.resDone = rows.length < SEARCH_PAGE_SIZE;
  } catch (err) {
    if (my !== token) return;
    st.loading = false;
    $('libList').innerHTML = `<div class="panel lib-empty"><h2>Search didn’t work</h2><p>${esc(err.message || err)}</p><button class="btn btn-primary" type="button" data-act="retry">Try again</button></div>`;
    return;
  }
  st.loading = false;
  renderResults();
}

// ---------- refresh whatever is on screen ----------
async function refresh({ push = false } = {}) {
  writeUrl(push);
  renderChrome();
  if (searching()) return runSearch(true);
  if (st.view === 'folders' && !st.folder) { await loadFolders(); return renderFolders(); }
  return loadRows(true);
}
async function refreshStats() {
  try { st.stats = await libraryStats(); } catch { /* the header stays as it was */ }
  renderStats();
  renderTypeChips();
}

// ---------- selection / bulk actions ----------
function renderBulkBar() {
  const bar = $('bulkBar');
  bar.hidden = !st.selecting;
  document.body.classList.toggle('has-bulk', st.selecting);
  if (!st.selecting) return;
  const n = st.selected.size;
  $('bulkCount').textContent = n ? `${n} selected` : 'Tap recordings to select';
  const allFav = n && [...st.selected].every((id) => st.rows.find((r) => r.id === id)?.is_favorite);
  bar.querySelector('[data-bulk=favorite]').textContent = allFav ? 'Unfavorite' : 'Favorite';
  bar.querySelectorAll('[data-bulk]:not([data-bulk=cancel])').forEach((b) => { b.disabled = !n; });
}
function setSelecting(on) {
  st.selecting = on;
  st.selected.clear();
  renderChrome();
  if (!searching() && !(st.view === 'folders' && !st.folder)) renderList();
}
function toggleSelected(id) {
  if (st.selected.has(id)) st.selected.delete(id); else st.selected.add(id);
  const card = $('libList').querySelector(`.lib-card[data-id="${id}"]`);
  card?.classList.toggle('selected', st.selected.has(id));
  const box = card?.querySelector('.lib-check input');
  if (box) box.checked = st.selected.has(id);
  renderBulkBar();
}

async function bulk(action) {
  const ids = [...st.selected];
  if (!ids.length && action !== 'cancel') return;
  if (action === 'cancel') return setSelecting(false);
  if (action === 'favorite') {
    const value = !ids.every((id) => st.rows.find((r) => r.id === id)?.is_favorite);
    try { await setFavorite(ids, value); toast(value ? `Added ${ids.length} to favorites` : `Removed ${ids.length} from favorites`); } catch (e) { return toast(e.message || 'That didn’t work'); }
  } else if (action === 'folder') {
    return folderPicker({ ids, onChange: async () => { await loadFolders(); toast('Folders updated'); setSelecting(false); refresh(); } });
  } else if (action === 'delete') {
    if (!(await confirmDeleteRecordings(ids.length))) return;
    try { const n = await deleteTranscripts(ids); toast(`Deleted ${n} recording${n === 1 ? '' : 's'}`); } catch (e) { return toast(e.message || 'Delete failed'); }
    refreshStats();
  }
  setSelecting(false);
  refresh();
}

// ---------- per-recording menu ----------
function recordingMenu(row) {
  const dlg = document.createElement('dialog');
  dlg.className = 'confirm sheet menu-dlg';
  dlg.innerHTML = `<h3 class="menu-title">${esc(row.title)}</h3>
    <div class="menu-list">
      <button type="button" data-m="open">Open</button>
      <button type="button" data-m="rename">Rename</button>
      <button type="button" data-m="star">${row.is_favorite ? 'Remove from favorites' : 'Add to favorites'}</button>
      <button type="button" data-m="folders">Folders…</button>
      ${st.folder ? `<button type="button" data-m="unfolder">Remove from “${esc(folderName(st.folder) || 'this folder')}”</button>` : ''}
      <button type="button" data-m="delete" class="danger">Delete…</button>
    </div>
    <div class="confirm-actions"><button class="btn btn-ghost" type="button" data-m="close">Cancel</button></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 200));
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) return dlg.close();
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    dlg.close();
    if (m === 'open') location.href = openUrl(row.id);
    else if (m === 'rename') renameRow(row);
    else if (m === 'star') toggleStar(row);
    else if (m === 'folders') folderPicker({ ids: [row.id], currentIds: row.folder_ids || [], onChange: async (ids) => { row.folder_ids = ids; await loadFolders(); toast('Folders updated'); if (st.folder && !ids.includes(st.folder)) refresh(); else renderList(); } });
    else if (m === 'unfolder') { try { await removeFromFolder(st.folder, row.id); toast('Removed from folder'); await loadFolders(); refresh(); } catch (ex) { toast(ex.message || 'That didn’t work'); } }
    else if (m === 'delete') {
      if (!(await confirmDeleteRecordings(1, row.title))) return;
      try { await deleteTranscripts(row.id); toast('Recording deleted'); refreshStats(); refresh(); } catch (ex) { toast(ex.message || 'Delete failed'); }
    }
  });
  dlg.showModal();
}
async function renameRow(row) {
  const title = await promptDialog({ title: 'Rename recording', label: 'Name', value: row.title, submit: (v) => renameTranscript(row.id, v) });
  if (!title) return;
  row.title = title;
  toast('Renamed');
  renderList();
}
async function toggleStar(row) {
  const value = !row.is_favorite;
  row.is_favorite = value;
  renderList();
  try {
    await setFavorite(row.id, value);
    if (st.stats) st.stats.favorites = Number(st.stats.favorites) + (value ? 1 : -1);
    if (!value && st.view === 'favorites' && !st.folder) refresh();
  } catch (e) { row.is_favorite = !value; renderList(); toast(e.message || 'That didn’t work'); }
}

// ---------- folder actions ----------
async function newFolder() {
  const name = await promptDialog({ title: 'New folder', label: 'Folder name', placeholder: 'e.g. Biology 101', maxLength: 80, confirmLabel: 'Create', submit: createFolder });
  if (!name) return;
  toast(`Created “${name}”`);
  await loadFolders();
  renderFolders();
}
async function renameCurrentFolder() {
  const id = st.folder;
  const name = await promptDialog({ title: 'Rename folder', label: 'Folder name', value: folderName(id) || '', maxLength: 80, submit: (v) => renameFolder(id, v) });
  if (!name) return;
  await loadFolders();
  renderChrome();
  toast('Folder renamed');
}
async function deleteCurrentFolder() {
  const id = st.folder;
  const f = st.folders.find((x) => x.id === id);
  const ok = await confirmDialog({
    title: 'Delete this folder?',
    bodyHtml: `<p>“${esc(f?.name || 'This folder')}” will be removed. ${f?.count ? `The ${f.count} recording${f.count === 1 ? '' : 's'} in it stay in your library — only the folder goes.` : 'It’s empty.'}</p>`,
    confirmLabel: 'Delete folder', danger: true,
  });
  if (!ok) return;
  try { await deleteFolder(id); } catch (e) { return toast(e.message || 'Couldn’t delete the folder'); }
  toast('Folder deleted');
  st.folder = null;
  st.view = 'folders';
  await loadFolders();
  refresh({ push: true });
}

// ---------- events ----------
function bind() {
  $('viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    st.view = b.dataset.view;
    st.folder = null;
    st.q = '';
    $('q').value = '';
    if (st.selecting) { st.selecting = false; st.selected.clear(); }
    refresh({ push: true });
  });

  let debounce;
  $('q').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const before = searching();
      st.q = $('q').value;
      if (!searching() && !before) { $('qClear').hidden = !st.q; return; }
      refresh();
    }, 280);
  });
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(debounce); st.q = $('q').value; $('q').blur(); refresh(); });
  const clearSearch = () => { st.q = ''; $('q').value = ''; refresh(); };
  $('qClear').addEventListener('click', () => { clearSearch(); $('q').focus(); });
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.q) { e.preventDefault(); clearSearch(); } });

  $('typeChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    st.type = b.dataset.type || null;
    refresh();
  });
  $('dateSel').addEventListener('change', () => { st.date = $('dateSel').value; refresh(); });
  $('sortSel').addEventListener('change', () => { st.sort = $('sortSel').value; refresh(); });
  $('selectBtn').addEventListener('click', () => setSelecting(!st.selecting));
  $('bulkBar').addEventListener('click', (e) => { const b = e.target.closest('[data-bulk]'); if (b) bulk(b.dataset.bulk); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.selecting && !document.querySelector('dialog[open]')) setSelecting(false); });

  $('folderHead').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'folders') { st.folder = null; st.view = 'folders'; refresh({ push: true }); }
    else if (a === 'rename-folder') renameCurrentFolder();
    else if (a === 'delete-folder') deleteCurrentFolder();
  });

  $('libList').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'retry') return refresh();
    if (act === 'clear-search') return clearSearch();
    if (act === 'new-folder') return newFolder();
    const tile = e.target.closest('[data-folder]');
    if (tile && !e.metaKey && !e.ctrlKey) { e.preventDefault(); st.folder = tile.dataset.folder; st.view = 'folders'; return refresh({ push: true }); }
    const card = e.target.closest('.lib-card');
    if (!card) return;
    const row = st.rows.find((r) => r.id === card.dataset.id);
    if (!row) return;
    if (act === 'star') { e.preventDefault(); return toggleStar(row); }
    if (act === 'menu') { e.preventDefault(); return recordingMenu(row); }
    if (st.selecting) { e.preventDefault(); toggleSelected(row.id); }
  });
  $('libMore').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'more' && !st.loading) loadRows(false);
    if (act === 'more-results' && !st.loading) runSearch(false);
  });
  // load the next page automatically when the end of the list comes into view
  new IntersectionObserver((entries) => {
    if (!entries.some((x) => x.isIntersecting) || st.loading) return;
    if (searching()) { if (st.results.length && !st.resDone) runSearch(false); }
    else if (st.rows.length && !st.done && !(st.view === 'folders' && !st.folder)) loadRows(false);
  }, { rootMargin: '400px' }).observe($('libMore'));

  window.addEventListener('popstate', () => { readUrl(); $('q').value = st.q; refresh(); });
  // coming back to this tab (e.g. after renaming a recording elsewhere): show current data
  window.addEventListener('pageshow', (e) => { if (e.persisted) { refreshStats(); refresh(); } });
}

(async () => {
  if (!isConfigured) return location.replace('/auth');
  await requireUser();
  mountAccountMenu($('accountSlot'));
  readUrl();
  $('q').value = st.q;
  bind();
  await Promise.all([refreshStats(), loadFolders()]);
  refresh();
})();
