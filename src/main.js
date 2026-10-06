import { decodeToMono16k, peaks } from './audio.js';

const $ = (id) => document.getElementById(id);
const els = {
  dropPanel: $('dropPanel'), dropzone: $('dropzone'), fileInput: $('fileInput'),
  modelSelect: $('modelSelect'), langSelect: $('langSelect'), diarizeToggle: $('diarizeToggle'),
  progressPanel: $('progressPanel'), fileName: $('fileName'), fileSub: $('fileSub'),
  cancelBtn: $('cancelBtn'), wave: $('wave'), steps: $('steps'), loadNote: $('loadNote'),
  downloads: $('downloads'), statusLine: $('statusLine'),
  resultsPanel: $('resultsPanel'), resultsSub: $('resultsSub'), speakerLegend: $('speakerLegend'),
  player: $('player'), transcript: $('transcript'),
  copyBtn: $('copyBtn'), txtBtn: $('txtBtn'), srtBtn: $('srtBtn'), newBtn: $('newBtn'),
  errorPanel: $('errorPanel'), errorText: $('errorText'), retryBtn: $('retryBtn'),
  deviceChip: $('deviceChip'),
};

const SPEAKER_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#34d399', '#60a5fa'];
const UNKNOWN = 'Unknown';
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he']);

let worker = null;
let currentFile = null;
let objectUrl = null;
let state = null; // { lines: [{start,end,speaker,text}], names: Map<speakerId,name>, duration }

// ---------- worker ----------
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (e) => showError(e.message || 'Worker crashed'));
  return worker;
}
function killWorker() {
  if (worker) { worker.terminate(); worker = null; }
}
getWorker().postMessage({ type: 'detect' });

function onWorkerMessage({ data }) {
  switch (data.type) {
    case 'device': setDevice(data.device); break;
    case 'stage': setStep(data.stage); break;
    case 'status': els.statusLine.textContent = data.text; break;
    case 'progress': onProgress(data); break;
    case 'language': if (state) state.language = data.language; break;
    case 'complete': onComplete(data); break;
    case 'error': showError(data.message + (data.stack ? '\n\n' + data.stack : '')); break;
  }
}

function setDevice(dev) {
  els.deviceChip.classList.add('ok');
  els.deviceChip.innerHTML = `<span class="dot"></span>${dev === 'webgpu' ? 'GPU accelerated' : 'CPU mode'}`;
  if (dev !== 'webgpu') {
    const turbo = els.modelSelect.querySelector('option[value="turbo"]');
    if (turbo) turbo.disabled = true;
  }
}

// ---------- file intake ----------
['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('over'); }));
els.dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) start(f); });
els.fileInput.addEventListener('change', () => { const f = els.fileInput.files?.[0]; if (f) start(f); els.fileInput.value = ''; });
window.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) start(f); });

els.cancelBtn.addEventListener('click', reset);
els.newBtn.addEventListener('click', reset);
els.retryBtn.addEventListener('click', reset);

function show(panel) {
  [els.dropPanel, els.progressPanel, els.resultsPanel, els.errorPanel].forEach((p) => p.classList.toggle('hidden', p !== panel));
}
function reset() {
  killWorker();
  getWorker().postMessage({ type: 'detect' });
  els.player.pause();
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  state = null; currentFile = null;
  els.downloads.innerHTML = ''; els.statusLine.textContent = ''; els.loadNote.textContent = '';
  els.steps.querySelectorAll('li').forEach((li) => li.classList.remove('active', 'done'));
  show(els.dropPanel);
}
function showError(msg) {
  els.errorText.textContent = msg;
  show(els.errorPanel);
}

function setStep(stage) {
  const order = ['decode', 'load', 'run', 'done'];
  const idx = order.indexOf(stage);
  els.steps.querySelectorAll('li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx || stage === 'done');
    li.classList.toggle('active', i === idx && stage !== 'done');
  });
  if (stage === 'run') els.statusLine.textContent = 'Working… long recordings can take a few minutes.';
  if (stage === 'load') els.statusLine.textContent = 'First run downloads the models once; after that they load from cache.';
}

const bars = new Map();
function onProgress(p) {
  if (p.status === 'progress' && p.file) {
    let row = bars.get(p.file);
    if (!row) {
      row = document.createElement('div');
      row.className = 'dl';
      row.innerHTML = `<span class="lbl"></span><div class="bar"><i></i></div>`;
      els.downloads.appendChild(row);
      bars.set(p.file, row);
    }
    const pct = Math.min(100, p.progress || 0);
    row.querySelector('.lbl').textContent = `${p.file.split('/').pop()} — ${pct.toFixed(0)}%${p.total ? ` of ${(p.total / 1e6).toFixed(0)} MB` : ''}`;
    row.querySelector('.bar i').style.width = pct + '%';
  } else if (p.status === 'done' && p.file) {
    const row = bars.get(p.file);
    if (row) { row.remove(); bars.delete(p.file); }
  } else if (p.status === 'ready') {
    els.loadNote.textContent = '';
  }
}

async function start(file) {
  currentFile = file;
  bars.clear(); els.downloads.innerHTML = '';
  els.fileName.textContent = file.name;
  els.fileSub.textContent = `${(file.size / 1e6).toFixed(1)} MB · ${file.type || 'unknown type'}`;
  show(els.progressPanel);
  setStep('decode');

  let decoded;
  try {
    const forceFFmpeg = new URLSearchParams(location.search).has('ffmpeg');
    decoded = await decodeToMono16k(file, (text) => { els.statusLine.textContent = text; }, { forceFFmpeg });
  } catch (err) {
    showError(`Could not decode "${file.name}". This browser may not support that format.\n\n${err.message || err}`);
    return;
  }
  els.fileSub.textContent += ` · ${fmtTime(decoded.duration)}`;
  drawWave(peaks(decoded.samples, 600));

  const model = els.modelSelect.value;
  const language = els.langSelect.value;
  const diarize = els.diarizeToggle.checked;
  const samples = decoded.samples;
  getWorker().postMessage({ type: 'run', audio: samples, model, language, diarize }, [samples.buffer]);
  state = { duration: decoded.duration, language };
}

function drawWave(pk) {
  const c = els.wave;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = 80;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#22d3ee'); g.addColorStop(0.55, '#a78bfa'); g.addColorStop(1, '#f472b6');
  ctx.fillStyle = g;
  const n = pk.length, bw = W / n;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, pk[i] * (H - 8));
    ctx.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 1), h);
  }
}

// ---------- results ----------
function onComplete({ lines, language, ms, device }) {
  setStep('done');
  const speakerIds = [...new Set(lines.map((l) => l.speaker))];
  const names = new Map();
  let n = 1;
  for (const id of speakerIds) names.set(id, id === UNKNOWN ? UNKNOWN : `Speaker ${n++}`);
  state = { ...state, lines, names, speakerIds, language };
  els.resultsSub.textContent = `${currentFile.name} · ${fmtTime(state.duration)} · ${speakerIds.filter((s) => s !== UNKNOWN).length} speaker(s) · processed in ${fmtTime(ms / 1000)} on ${device === 'webgpu' ? 'GPU' : 'CPU'}`;

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(currentFile);
  els.player.src = objectUrl;

  renderTranscript();
  setTimeout(() => show(els.resultsPanel), 350);
}

function renderTranscript() {
  const { lines, names, speakerIds, language } = state;
  const color = (id) => (id === UNKNOWN ? '#8b93b8' : SPEAKER_COLORS[speakerIds.filter((s) => s !== UNKNOWN).indexOf(id) % SPEAKER_COLORS.length]);

  els.speakerLegend.innerHTML = '';
  for (const id of speakerIds) {
    const chip = document.createElement('span');
    chip.className = 'spk-chip';
    chip.style.setProperty('--c', color(id));
    chip.innerHTML = `<span class="sw"></span><span>${esc(names.get(id))}</span>`;
    els.speakerLegend.appendChild(chip);
  }

  const rtl = RTL_LANGS.has(language) || /[؀-ۿ֐-׿]/.test(lines.slice(0, 20).map((l) => l.text).join(''));
  els.transcript.innerHTML = '';
  lines.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'line';
    row.dataset.i = i;
    row.style.setProperty('--c', color(l.speaker));
    if (rtl) row.dir = 'rtl';
    row.innerHTML = `<span class="t">${fmtTime(l.start)}</span><span class="s" contenteditable="true" spellcheck="false" title="Click to rename">${esc(names.get(l.speaker))}</span><span class="x">${esc(l.text)}</span>`;
    const nameEl = row.querySelector('.s');
    nameEl.addEventListener('click', (e) => e.stopPropagation());
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
    nameEl.addEventListener('blur', () => {
      const v = nameEl.textContent.trim();
      if (v && v !== names.get(l.speaker)) { names.set(l.speaker, v); renderTranscript(); }
      else nameEl.textContent = names.get(l.speaker);
    });
    row.addEventListener('click', () => { els.player.currentTime = l.start; els.player.play(); });
    els.transcript.appendChild(row);
  });
}

els.player.addEventListener('timeupdate', () => {
  if (!state?.lines) return;
  const t = els.player.currentTime;
  const idx = state.lines.findIndex((l, i) => t >= l.start && (i === state.lines.length - 1 || t < state.lines[i + 1].start));
  els.transcript.querySelectorAll('.line').forEach((r) => r.classList.toggle('playing', Number(r.dataset.i) === idx));
});

// ---------- export ----------
function toTxt() {
  return state.lines.map((l) => `[${fmtTime(l.start)}] ${state.names.get(l.speaker)}: ${l.text}`).join('\n');
}
function toSrt() {
  return state.lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${state.names.get(l.speaker)}: ${l.text}\n`).join('\n');
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const base = () => (currentFile?.name || 'transcript').replace(/\.[^.]+$/, '');
els.copyBtn.addEventListener('click', async () => { await navigator.clipboard.writeText(toTxt()); toast('Copied to clipboard'); });
els.txtBtn.addEventListener('click', () => download(base() + '.txt', toTxt()));
els.srtBtn.addEventListener('click', () => download(base() + '.srt', toSrt()));

// ---------- utils ----------
function fmtTime(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}
function srtTime(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}
