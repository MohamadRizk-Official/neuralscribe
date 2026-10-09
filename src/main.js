import { decodeToMono16k, peaks } from './audio.js';
import { isConfigured } from './lib/supabase.js';
import { mountAccountMenu, getSession } from './lib/account.js';
import { saveTranscript, updateTranscriptText, updateRecordingType, stashPending, peekPending, clearPending } from './lib/transcripts.js';
import { toStoredSegments, RECORDING_TYPES } from './lib/segments.js';
import { cleanText } from './lib/clean.js';
import { mountInsights } from './insights/insights.js';
import { sparkPulse } from './lib/brand.js';
import { mountMascot } from './mascot/mascot.js';
import { mascotSignal, mascotTravel } from './mascot/bus.js';

const $ = (id) => document.getElementById(id);
const els = {
  dropPanel: $('dropPanel'), dropzone: $('dropzone'), fileInput: $('fileInput'),
  modelSelect: $('modelSelect'), speakersSelect: $('speakersSelect'),
  progressPanel: $('progressPanel'), fileName: $('fileName'), fileSub: $('fileSub'), cancelBtn: $('cancelBtn'),
  wave: $('wave'), waveSweep: $('waveSweep'), waveWrap: $('waveWrap'), sweepHead: $('sweepHead'), steps: $('steps'), stageLabel: $('stageLabel'), statusLine: $('statusLine'),
  pctNum: $('pctNum'), etaText: $('etaText'), pctBar: $('pctBar'), downloads: $('downloads'),
  resultsPanel: $('resultsPanel'), resTitle: $('resTitle'), resMeta: $('resMeta'),
  searchInput: $('searchInput'), searchCount: $('searchCount'),
  copyBtn: $('copyBtn'), exportBtn: $('exportBtn'), newBtn: $('newBtn'),
  timeline: $('timeline'), timelineCanvas: $('timelineCanvas'), playhead: $('playhead'), tlHover: $('tlHover'),
  speakerList: $('speakerList'), spkCount: $('spkCount'), transcript: $('transcript'),
  player: $('player'), playBtn: $('playBtn'), backBtn: $('backBtn'), fwdBtn: $('fwdBtn'), pbTime: $('pbTime'),
  pbSeek: $('pbSeek'), speedBtn: $('speedBtn'), followBtn: $('followBtn'),
  errorPanel: $('errorPanel'), errorText: $('errorText'), retryBtn: $('retryBtn'),
  deviceChip: $('deviceChip'), menu: $('menu'), cpuNote: $('cpuNote'), cpuWhy: $('cpuWhy'),
  modeInputs: [...document.querySelectorAll('input[name="mode"]')], modeNote: $('modeNote'),
  advanced: $('advanced'), advSummary: $('advSummary'), vocabInput: $('vocabInput'),
  qualityChip: $('qualityChip'), speakersStepLabel: $('speakersStepLabel'),
  muteBtn: $('muteBtn'), volSlider: $('volSlider'),
  recTypeSelect: $('recTypeSelect'), viewToggle: $('viewToggle'),
};

const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#34d399', '#60a5fa', '#fb923c', '#e879f9'];
const UNKNOWN = 'Unknown';
const UNKNOWN_COLOR = '#8a93b9';
const STEPS = ['decode', 'analyze', 'load', 'speakers', 'run', 'review', 'done'];
const STAGE_LABEL = {
  decode: 'Preparing audio', analyze: 'Analyzing recording', load: 'Loading AI models', speakers: 'Finding who is speaking',
  run: 'Transcribing', review: 'Re-checking difficult parts', done: 'Finalizing transcript',
};
// share of the overall progress bar each stage covers
const STAGE_SPAN = { decode: [0, 6], analyze: [6, 8], load: [8, 18], speakers: [18, 32], run: [32, 92], review: [92, 99], done: [100, 100] };
// one-time model downloads shown to the user (MB, rounded): Whisper + speaker models
const DOWNLOAD_MB = { fast: { webgpu: 200, wasm: 110 }, best: { webgpu: 600, wasm: 280 } };
const QUALITY_LABEL = { good: 'Good', fair: 'Fair', difficult: 'Difficult' };
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';

const FORCE_CPU = new URLSearchParams(location.search).has('cpu'); // testing: behave like a computer without GPU
let worker = null;
let currentFile = null;
let objectUrl = null;
let state = null; // set when a file starts; filled with results on completion
let run = null; // progress bookkeeping for the current file

// ---------- settings memory (per browser, best-effort) ----------
// The app was renamed from NeuralScribe: settings saved under the old keys are moved over once, so nobody
// loses their mode, speakers, important words or volume.
function migrateKey(store, oldKey, newKey) {
  try {
    const old = store.getItem(oldKey);
    if (old != null && store.getItem(newKey) == null) store.setItem(newKey, old);
    if (old != null) store.removeItem(oldKey);
  } catch {}
}
migrateKey(localStorage, 'neuralscribe.prefs', 'sparkscribe.prefs');
migrateKey(sessionStorage, 'neuralscribe.volume', 'sparkscribe.volume');

const PREF_KEY = 'sparkscribe.prefs';
const modeValue = () => els.modeInputs.find((i) => i.checked)?.value || 'best';
const vocabulary = () => els.vocabInput.value.split(/[,\n;]+/).map((w) => w.trim()).filter(Boolean).slice(0, 60);
try {
  const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  if (p.v === 2) { // older saved settings used model names as "accuracy"; start those users on the new defaults
    if (p.mode) els.modeInputs.forEach((i) => { i.checked = i.value === p.mode; });
    if (p.model !== undefined) els.modelSelect.value = p.model;
    if (p.vocab) els.vocabInput.value = p.vocab;
  }
  if (p.speakers) els.speakersSelect.value = p.speakers;
} catch {}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      v: 2, mode: modeValue(), model: els.modelSelect.value,
      speakers: els.speakersSelect.value, vocab: els.vocabInput.value,
    }));
  } catch {}
}
function updateSettingsUI() {
  const sp = els.speakersSelect.value;
  const speakers = sp === 'auto' ? 'Auto speakers' : sp === 'off' ? 'No speaker labels' : els.speakersSelect.selectedOptions[0].textContent;
  const n = vocabulary().length;
  const type = els.recTypeSelect.value ? els.recTypeSelect.selectedOptions[0].textContent : '';
  els.advSummary.textContent = [speakers, type, n ? `${n} important word${n === 1 ? '' : 's'}` : '', els.modelSelect.value ? 'Custom model' : ''].filter(Boolean).join(' · ');
  updateModeNote();
}
function updateModeNote() {
  const dev = deviceInfo.dev;
  if (!dev) { els.modeNote.textContent = ''; return; }
  const mode = modeValue();
  const custom = els.modelSelect.value;
  const parts = [];
  if (custom) parts.push('Using the model chosen in Advanced settings.');
  else if (mode === 'best' && dev !== 'webgpu') parts.push('Without a GPU, Best Accuracy uses a lighter model so it finishes in reasonable time.');
  if (!custom) parts.push(`First use downloads about ${DOWNLOAD_MB[mode][dev === 'webgpu' ? 'webgpu' : 'wasm']} MB of AI models once; after that they load from your browser's cache.`);
  els.modeNote.textContent = parts.join(' ');
}
[els.modelSelect, els.speakersSelect].forEach((s) => s.addEventListener('change', () => { savePrefs(); updateSettingsUI(); }));
els.recTypeSelect.addEventListener('change', updateSettingsUI);
els.modeInputs.forEach((i) => i.addEventListener('change', () => { savePrefs(); updateSettingsUI(); }));
els.vocabInput.addEventListener('input', () => { savePrefs(); updateSettingsUI(); });

// Important words as removable chips. The hidden #vocabInput stays the source of truth (comma separated),
// so saving, the summary line and the speech-model hint work exactly as before.
{
  const list = $('vocabList'), entry = $('vocabEntry'), box = $('vocabChips');
  const draw = () => {
    list.innerHTML = vocabulary().map((w, i) => `<li class="chip-word"><span>${esc(w)}</span><button type="button" data-i="${i}" aria-label="Remove ${esc(w)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></li>`).join('');
  };
  const write = (words) => { els.vocabInput.value = words.join(', '); els.vocabInput.dispatchEvent(new Event('input')); draw(); };
  const add = (text) => {
    const cur = vocabulary(), seen = new Set(cur.map((w) => w.toLowerCase()));
    for (const w of String(text).split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean)) {
      if (!seen.has(w.toLowerCase()) && cur.length < 60) { cur.push(w.slice(0, 60)); seen.add(w.toLowerCase()); }
    }
    write(cur);
  };
  if (list && entry && box) {
    entry.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && entry.value.trim()) { e.preventDefault(); add(entry.value); entry.value = ''; }
      else if (e.key === 'Backspace' && !entry.value && vocabulary().length) { const w = vocabulary(); w.pop(); write(w); }
    });
    entry.addEventListener('paste', (e) => {
      const t = e.clipboardData?.getData('text') || '';
      if (/[,\n;]/.test(t)) { e.preventDefault(); add(t); }
    });
    entry.addEventListener('blur', () => { if (entry.value.trim()) { add(entry.value); entry.value = ''; } });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const w = vocabulary(); w.splice(Number(b.dataset.i), 1); write(w);
      entry.focus();
    });
    box.addEventListener('click', (e) => { if (e.target === box || e.target === list) entry.focus(); });
    draw();
  }
}

// ---------- worker ----------
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (e) => showError(e.message || 'The processing worker crashed.'));
  return worker;
}
function killWorker() {
  if (worker) { worker.terminate(); worker = null; }
}
getWorker().postMessage({ type: 'detect', forceCPU: FORCE_CPU });

function onWorkerMessage({ data }) {
  switch (data.type) {
    case 'device': setDevice(data.device, data.reason); break;
    case 'stage': setStage(data.stage); break;
    case 'status': onStatus(data.text); break;
    case 'progress': onDownload(data); break;
    case 'run-progress': setStagePct((data.done / data.total) * 100); break;
    case 'quality': showQuality(data.quality, data.preprocessing); break;
    case 'language': if (state) state.language = data.language; break;
    case 'complete': onComplete(data); break;
    case 'debug': window.__dbg = data; break;
    case 'error': showError(data.message + (data.stack ? '\n\n' + data.stack : '')); break;
  }
}

let deviceInfo = { dev: null, reason: null };
function setDevice(dev, reason) {
  // the page itself may have WebGPU even when the background worker doesn't
  if (dev !== 'webgpu' && reason === 'no-webgpu' && 'gpu' in navigator) reason = 'worker-only';
  deviceInfo = { dev, reason };
  els.deviceChip.classList.add('ok');
  els.deviceChip.classList.toggle('cpu', dev !== 'webgpu');
  els.deviceChip.innerHTML = dev === 'webgpu'
    ? '<span class="dot"></span>GPU accelerated'
    : '<span class="dot"></span>CPU mode <span class="why">why?</span>';
  els.deviceChip.title = dev === 'webgpu' ? 'Running on your graphics card' : 'Running on the processor only. Click to see why.';
  els.cpuNote.classList.toggle('hidden', dev === 'webgpu');
  // On CPU the large model needs minutes per 30 s of audio (an hour-long file would take many hours),
  // so it is only offered with a GPU.
  const turbo = els.modelSelect.querySelector('option[value="turbo"]');
  if (turbo) {
    turbo.disabled = dev !== 'webgpu';
    turbo.textContent = dev === 'webgpu' ? 'Whisper large-v3 turbo' : 'Whisper large-v3 turbo (needs a GPU)';
  }
  if (dev !== 'webgpu' && els.modelSelect.value === 'turbo') els.modelSelect.value = '';
  updateSettingsUI();
}

const CPU_REASONS = {
  'no-webgpu': ["This browser can't use the graphics card", "It doesn't support WebGPU, which is what lets a web page use the GPU. Open the site in the latest <b>Google Chrome</b> or <b>Microsoft Edge</b> on Windows, Mac or Android. Firefox, older Safari and Chrome on Linux usually stay on the CPU."],
  'worker-only': ['This browser only half-supports the GPU', 'It offers WebGPU on the page but not to the background worker this app runs in. The latest <b>Google Chrome</b> or <b>Microsoft Edge</b> supports both.'],
  'no-adapter': ["The browser couldn't use your graphics card", "WebGPU is supported, but no usable GPU was offered. Usually one of these fixes it:<br>• Browser settings → System → turn on <b>Use graphics acceleration when available</b>, then restart the browser.<br>• Update your graphics driver (NVIDIA, AMD or Intel).<br>• Don't use it over Remote Desktop or in a virtual machine.<br>• Open <code>chrome://gpu</code>: if WebGPU says &quot;Disabled&quot;, your GPU is on the browser's block list."],
  'error': ["The graphics card didn't respond", 'Asking the browser for the GPU failed. Restart the browser, update your graphics driver, and make sure graphics acceleration is on in the browser settings.'],
  'load-failed': ["Your GPU couldn't run the AI models", 'A GPU was found, but loading the models on it failed, usually because of an old driver or too little graphics memory. Update your graphics driver, close other heavy tabs and games, and reload.'],
  'forced': ['CPU mode was forced', 'The address contains <code>?cpu</code>, which is a testing switch. Remove it to use the GPU.'],
};
function showDeviceInfo() {
  if (deviceInfo.dev === 'webgpu') {
    openInfo(els.deviceChip, 'Using your graphics card', 'WebGPU is working, so transcription runs on your GPU. All models are available.');
    return;
  }
  const [title, body] = CPU_REASONS[deviceInfo.reason] || CPU_REASONS['no-webgpu'];
  openInfo(els.deviceChip, title, `${body}<br><br>Everything still works on the CPU, just slower. <b>Fast</b> runs about twice as fast as real time on a typical laptop; <b>Best Accuracy</b> uses a lighter model than it would on a GPU.`);
}
els.deviceChip.addEventListener('click', showDeviceInfo);
els.deviceChip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDeviceInfo(); } });
els.cpuWhy.addEventListener('click', (e) => { e.preventDefault(); showDeviceInfo(); });

// ---------- file intake ----------
['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('over'); }));
// moving between the box's own children fires dragleave too: only a real exit ends the drag-over state
els.dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); if (!els.dropzone.contains(e.relatedTarget)) els.dropzone.classList.remove('over'); });
els.dropzone.addEventListener('drop', (e) => { e.preventDefault(); els.dropzone.classList.remove('over'); });
els.dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) start(f); });
els.fileInput.addEventListener('change', () => { const f = els.fileInput.files?.[0]; if (f) start(f); els.fileInput.value = ''; });
window.addEventListener('paste', (e) => {
  if (!els.dropPanel.classList.contains('hidden')) { const f = [...(e.clipboardData?.files || [])][0]; if (f) start(f); }
});
// let people drop a file anywhere on the home screen
window.addEventListener('dragover', (e) => { if (!els.dropPanel.classList.contains('hidden')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (els.dropPanel.classList.contains('hidden') || els.dropzone.contains(e.target)) return;
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) start(f);
});

els.cancelBtn.addEventListener('click', reset);
els.newBtn.addEventListener('click', reset);
els.retryBtn.addEventListener('click', reset);

function show(panel) {
  [els.dropPanel, els.progressPanel, els.resultsPanel, els.errorPanel].forEach((p) => p.classList.toggle('hidden', p !== panel));
  window.scrollTo({ top: 0 });
}
function reset() {
  killWorker();
  getWorker().postMessage({ type: 'detect', forceCPU: FORCE_CPU });
  els.player.pause();
  els.player.removeAttribute('src');
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  state = null; currentFile = null; run = null;
  resetSave();
  insights.reset();
  setView('original');
  els.searchInput.value = '';
  closeMenu();
  show(els.dropPanel);
  mascotSignal('reset');
}
function showError(msg) {
  els.errorText.textContent = msg;
  show(els.errorPanel);
  mascotSignal('error');
}

// ---------- progress ----------
function setStage(stage) {
  if (!run) return;
  run.stage = stage;
  run.stageStart = performance.now();
  run.stagePct = 0;
  if (stage === 'review') els.steps.querySelector('[data-step="review"]').classList.remove('hidden');
  layoutSteps();
  const idx = STEPS.indexOf(stage);
  els.steps.querySelectorAll('li').forEach((li) => {
    const i = STEPS.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx || stage === 'done');
    li.classList.toggle('active', i === idx && stage !== 'done');
  });
  els.stageLabel.textContent = STAGE_LABEL[stage] || '';
  els.etaText.textContent = '';
  if (stage === 'load') els.statusLine.textContent = 'First run downloads the AI models once; after that they load from cache.';
  if (stage === 'speakers' && run.diarize === false) els.stageLabel.textContent = 'Detecting speech';
  renderPct();
}
function setStagePct(p) {
  if (!run) return;
  run.stagePct = Math.max(run.stagePct, Math.min(100, p));
  renderPct();
}
function renderPct() {
  const [a, b] = STAGE_SPAN[run.stage] || [0, 0];
  const overall = Math.max(run.overall || 0, a + ((b - a) * run.stagePct) / 100);
  run.overall = overall;
  els.pctNum.innerHTML = `${Math.floor(overall)}<small>%</small>`;
  els.pctBar.style.width = overall + '%';
  els.waveSweep.style.width = overall + '%';
  els.sweepHead.style.left = overall + '%'; // the bolt rides the edge of what's been read
  if (run.stage === 'run' || run.stage === 'speakers' || run.stage === 'review') {
    const elapsed = (performance.now() - run.stageStart) / 1000;
    const p = run.stagePct / 100;
    if (p > 0.03 && elapsed > 4) els.etaText.textContent = `≈ ${fmtDur(elapsed * (1 - p) / p)} left in this step`;
  }
}
function layoutSteps() {
  const visible = [...els.steps.querySelectorAll('li')].filter((li) => !li.classList.contains('hidden')).length;
  els.steps.style.gridTemplateColumns = `repeat(${visible}, 1fr)`;
}

// Audio quality: real measurements from the worker (level, noise floor, clipping). Echo isn't measured.
function showQuality(q, prep) {
  if (!q || !state) return;
  state.quality = q;
  state.preprocessing = prep;
  const chip = els.qualityChip;
  chip.className = `quality q-${q.rating}`;
  chip.innerHTML = `<span class="q-dot"></span>Audio quality: <b>${QUALITY_LABEL[q.rating]}</b>${q.issues.length ? ` · ${esc(q.issues[0].toLowerCase())}` : ''}`;
  chip.onclick = () => showQualityInfo(chip);
}
function showQualityInfo(anchor) {
  const q = state?.quality;
  if (!q) return;
  const m = q.measured;
  const rows = [
    ['Speech level', `${m.speechLevelDb} dBFS`],
    ['Background level', `${m.noiseLevelDb} dBFS`],
    ['Speech-to-noise', m.snrDb >= 60 ? '60+ dB (no audible noise)' : `${m.snrDb} dB`],
    ['Clipped audio', m.clippedPercent ? `${m.clippedPercent}% of samples` : 'none'],
  ];
  const prep = state.preprocessing;
  const prepText = prep
    ? `Before transcribing, a working copy was cleaned up: DC offset removed, rumble below ${prep.highpassHz} Hz filtered${prep.gainDb ? `, volume adjusted by ${prep.gainDb > 0 ? '+' : ''}${prep.gainDb} dB` : ''}. No noise removal is applied, and your original file is untouched.`
    : '';
  openInfo(anchor, `Audio quality: ${QUALITY_LABEL[q.rating]}`,
    `${q.issues.length ? `<b>${q.issues.map(esc).join(', ')}.</b><br>` : 'No problems measured.<br>'}<br>${rows.map(([k, v]) => `${k}: <b>${v}</b>`).join('<br>')}<br><br>${prepText}<br><br><span style="color:var(--dim)">Measured from the audio itself. Echo and people talking over each other aren't measured.</span>`);
}

function onStatus(text) {
  els.statusLine.textContent = text;
  const m = /(\d+)%/.exec(text);
  if (!m || !run) return;
  const v = Number(m[1]);
  if (run.stage === 'decode') setStagePct(v);
  else if (run.stage === 'speakers') {
    if (text.startsWith('Finding')) setStagePct(v * 0.5);
    else if (text.startsWith('Recognizing')) setStagePct(50 + v * 0.5);
  }
}

const downloads = new Map();
function onDownload(p) {
  if (!p.file) return;
  if (p.status === 'progress') {
    let d = downloads.get(p.file);
    if (!d) {
      const row = document.createElement('div');
      row.className = 'dl';
      row.innerHTML = '<span class="lbl"></span><div class="bar"><i></i></div>';
      els.downloads.appendChild(row);
      d = { row, loaded: 0, total: 0 };
      downloads.set(p.file, d);
    }
    d.loaded = p.loaded || 0;
    d.total = p.total || 0;
    const pct = Math.min(100, p.progress || 0);
    d.row.querySelector('.lbl').textContent = `${p.file.split('/').pop()} · ${pct.toFixed(0)}%${p.total ? ` of ${(p.total / 1e6).toFixed(0)} MB` : ''}`;
    d.row.querySelector('.bar i').style.width = pct + '%';
  } else if (p.status === 'done') {
    const d = downloads.get(p.file);
    if (d) { d.loaded = d.total; d.row.remove(); }
  }
  let l = 0, t = 0;
  for (const d of downloads.values()) { l += d.loaded; t += d.total; }
  if (t) setStagePct((l / t) * 100);
}

async function start(file) {
  currentFile = file;
  els.waveWrap.classList.remove('done');
  sparkPulse();
  mascotSignal('file-accepted');
  setTimeout(() => { if (currentFile === file && run) mascotSignal('working'); }, 900);
  downloads.clear();
  els.downloads.innerHTML = '';
  els.statusLine.textContent = '';
  els.fileName.textContent = file.name;
  els.fileSub.textContent = `${(file.size / 1e6).toFixed(1)} MB · ${file.type || 'unknown type'}`;
  const speakersChoice = els.speakersSelect.value;
  const diarize = speakersChoice !== 'off';
  els.speakersStepLabel.textContent = diarize ? 'Find speakers' : 'Detect speech';
  els.steps.querySelector('[data-step="review"]').classList.add('hidden');
  els.qualityChip.className = 'quality hidden';
  layoutSteps();
  run = { stage: 'decode', stageStart: performance.now(), stagePct: 0, overall: 0, t0: performance.now(), diarize };
  show(els.progressPanel);
  setStage('decode');
  drawWave(null);

  let decoded;
  try {
    const forceFFmpeg = new URLSearchParams(location.search).has('ffmpeg');
    decoded = await decodeToMono16k(file, onStatus, { forceFFmpeg });
  } catch (err) {
    showError(`Couldn't read "${file.name}". It may not contain audio, or the format isn't supported.\n\n${err.message || err}`);
    return;
  }
  if (currentFile !== file) return; // cancelled while decoding
  els.fileSub.textContent += ` · ${fmtTime(decoded.duration)}`;
  drawWave(peaks(decoded.samples, 700));

  const q = new URLSearchParams(location.search);
  const samples = decoded.samples;
  const mode = modeValue();
  const recordingType = RECORDING_TYPES.includes(els.recTypeSelect.value) ? els.recTypeSelect.value : null;
  state = { duration: decoded.duration, language: 'en', mode, recordingType, view: 'original' };
  getWorker().postMessage({
    type: 'run',
    audio: samples,
    mode,
    model: els.modelSelect.value, // '' = automatic for the mode
    language: 'en', // V1 transcribes English only
    diarize,
    numSpeakers: diarize && speakersChoice !== 'auto' ? Number(speakersChoice) : Number(q.get('k')) || 0,
    vocabulary: vocabulary(),
    debug: q.has('debug'),
  }, [samples.buffer]);
}

function drawWave(pk) {
  const base = els.wave;
  const dpr = window.devicePixelRatio || 1;
  const W = base.clientWidth || 800, H = 96;
  let sweepCanvas = els.waveSweep.querySelector('canvas');
  if (!sweepCanvas) { sweepCanvas = document.createElement('canvas'); els.waveSweep.appendChild(sweepCanvas); }
  for (const [c, lit] of [[base, false], [sweepCanvas, true]]) {
    c.width = W * dpr; c.height = H * dpr;
    if (lit) c.style.width = W + 'px'; // the lit copy is revealed by its parent's width
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    if (!pk) continue;
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#22d3ee'); g.addColorStop(0.55, '#a78bfa'); g.addColorStop(1, '#f472b6');
    ctx.fillStyle = lit ? g : '#8a93b9';
    let max = 0;
    for (const v of pk) max = Math.max(max, v);
    const n = pk.length, bw = W / n;
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, (pk[i] / (max || 1)) * (H - 14));
      ctx.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 0.6), h);
    }
  }
}

// ---------- results ----------
function onComplete({ lines, language, ms, device, stats }) {
  setStage('done');
  const speakers = new Map();
  let n = 0;
  for (const l of lines) {
    if (speakers.has(l.speaker)) continue;
    if (l.speaker === UNKNOWN) speakers.set(UNKNOWN, { name: 'Unknown', color: UNKNOWN_COLOR });
    else { speakers.set(l.speaker, { name: `Speaker ${n + 1}`, color: COLORS[n % COLORS.length] }); n++; }
  }
  state = { ...state, lines, speakers, language: language || state.language, ms, device, stats, nextId: 1, activeIdx: -1, query: '' };

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(currentFile);
  els.player.src = objectUrl;
  els.player.playbackRate = 1;
  els.speedBtn.textContent = '1×';

  els.resTitle.textContent = currentFile.name.replace(/\.[^.]+$/, '');
  els.resTitle.title = currentFile.name;
  els.waveWrap.classList.add('done');
  sparkPulse();
  mascotSignal('transcribe-done');
  setTimeout(() => {
    show(els.resultsPanel);
    renderAll();
    autoSave(); // in addition to showing the result; a failure never touches what's on screen
    setTimeout(() => mascotSignal('results-shown'), 700);
  }, 900);
}

function renderAll() {
  pruneSpeakers();
  renderMeta();
  renderSpeakers();
  renderTranscript();
  drawTimeline();
  updatePlayhead();
}

function pruneSpeakers() {
  const used = new Set(state.lines.map((l) => l.speaker));
  for (const id of [...state.speakers.keys()]) if (!used.has(id)) state.speakers.delete(id);
}

const spk = (id) => state.speakers.get(id) || { name: id, color: UNKNOWN_COLOR };
const realSpeakers = () => [...state.speakers.keys()].filter((id) => id !== UNKNOWN);

let detailsOpen = false;
function renderMeta() {
  const words = state.lines.reduce((t, l) => t + l.text.split(/\s+/).filter(Boolean).length, 0);
  const langs = 'English'; // V1 transcribes English only
  const chip = ([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`;
  // primary: what most people want at a glance; the technical rest is one click away under "Details"
  const primary = [['Length', fmtTime(state.duration)], ['Speakers', String(realSpeakers().length)]];
  const details = [
    ['Mode', state.mode === 'fast' ? 'Fast' : 'Best Accuracy'],
    ['Language', langs],
    ['Words', words.toLocaleString()],
    ['Processed in', `${fmtDur(state.ms / 1000)} · ${state.device === 'webgpu' ? 'GPU' : 'CPU'}`],
  ];
  const unsure = state.lines.filter((l) => l.uncertain).length;
  els.resMeta.innerHTML = primary.map(chip).join('')
    + '<span class="type-slot" id="typeSlot"></span>'
    + (state.quality ? `<button type="button" class="meta-btn q-${state.quality.rating}" data-act="quality">Audio <b>${QUALITY_LABEL[state.quality.rating]}</b></button>` : '')
    + (unsure ? `<button type="button" class="meta-btn unsure" data-act="unsure">${unsure} part${unsure === 1 ? '' : 's'} to double-check</button>` : '')
    + `<button type="button" class="meta-btn details-btn" data-act="details" aria-expanded="${detailsOpen}" aria-controls="resDetails">Details</button>`
    + `<div class="meta-details" id="resDetails"${detailsOpen ? '' : ' hidden'}>${details.map(chip).join('')}</div>`;
  els.resMeta.querySelector('[data-act="details"]').addEventListener('click', (e) => {
    detailsOpen = !detailsOpen;
    $('resDetails').hidden = !detailsOpen;
    e.currentTarget.setAttribute('aria-expanded', String(detailsOpen));
  });
  try { insights.refreshType(); } catch { /* the header can render before the tabs exist; they draw it then */ }
  els.resMeta.querySelector('[data-act="quality"]')?.addEventListener('click', (e) => showQualityInfo(e.currentTarget));
  els.resMeta.querySelector('[data-act="unsure"]')?.addEventListener('click', (e) => {
    const first = els.transcript.querySelector('.seg.uncertain');
    openInfo(e.currentTarget, 'Worth double-checking', 'The speech model reported low confidence for the passages underlined with dots (its average token probability was low, even after a second attempt). They may contain mistakes. Click a passage to hear it.');
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function talkStats() {
  const stats = new Map();
  for (const l of state.lines) {
    const s = stats.get(l.speaker) || { time: 0, count: 0 };
    s.time += l.end - l.start;
    s.count++;
    stats.set(l.speaker, s);
  }
  return stats;
}

function speakerOrder() {
  const stats = talkStats();
  return [...state.speakers.keys()].sort((a, b) => {
    if (a === UNKNOWN) return 1;
    if (b === UNKNOWN) return -1;
    return (stats.get(b)?.time || 0) - (stats.get(a)?.time || 0);
  });
}

function initials(name) {
  if (name === 'Unknown') return '?';
  const m = /^speaker\s*(\d+)$/i.exec(name.trim());
  if (m) return 'S' + m[1];
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function renderSpeakers() {
  const stats = talkStats();
  const total = [...stats.values()].reduce((t, s) => t + s.time, 0) || 1;
  const order = speakerOrder();
  els.spkCount.textContent = `${realSpeakers().length} detected`;
  els.speakerList.innerHTML = '';
  for (const id of order) {
    const s = spk(id);
    const st = stats.get(id) || { time: 0, count: 0 };
    const pct = (st.time / total) * 100;
    const card = document.createElement('div');
    card.className = 'spk';
    card.dataset.id = id;
    card.style.setProperty('--c', s.color);
    card.innerHTML = `
      <div class="avatar">${esc(initials(s.name))}</div>
      <div class="spk-info">
        <input class="spk-name" value="${esc(s.name)}" spellcheck="false" aria-label="Speaker name" />
        <div class="spk-meta">${fmtDur(st.time)} · ${pct.toFixed(0)}% · ${st.count} part${st.count === 1 ? '' : 's'}</div>
        <div class="spk-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>
      <button class="icon-btn" type="button" title="More">${DOTS}</button>`;
    const input = card.querySelector('.spk-name');
    input.addEventListener('input', () => {
      const v = input.value.trim();
      if (!v) return;
      s.name = v;
      card.querySelector('.avatar').textContent = initials(v);
      els.transcript.querySelectorAll(`.grp[data-sp="${cssEsc(id)}"]`).forEach((g) => {
        g.querySelector('.who-name').textContent = v;
        g.querySelector('.avatar').textContent = initials(v);
      });
      drawTimeline();
      scheduleSync();
    });
    input.addEventListener('blur', () => { if (!input.value.trim()) input.value = s.name; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    card.querySelector('.icon-btn').addEventListener('click', (e) => openSpeakerMenu(e.currentTarget, id));
    els.speakerList.appendChild(card);
  }
}

function openSpeakerMenu(anchor, id) {
  const others = speakerOrder().filter((o) => o !== id);
  const items = [];
  const first = state.lines.find((l) => l.speaker === id);
  if (first) items.push({ label: 'Play their first line', onClick: () => seek(first.start, true) });
  if (others.length) {
    items.push('hr', { title: `Merge ${spk(id).name} into…` });
    for (const o of others) items.push({ label: spk(o).name, color: spk(o).color, onClick: () => reassign((l) => l.speaker === id, o) });
  }
  openMenu(anchor, items);
}

// ---------- transcript ----------
// Original = exactly as transcribed (always what is saved and synced). Clean = a reading view with
// hesitations and repeated words removed by fixed rules (lib/clean.js); the original is never changed.
const cleanCache = new Map();
function lineText(i) {
  const t = state.lines[i].text;
  if (state.view !== 'clean') return t;
  if (!cleanCache.has(t)) cleanCache.set(t, cleanText(t));
  return cleanCache.get(t);
}
function setView(view) {
  els.viewToggle.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  if (!state) return;
  state.view = view;
  if (state.lines) { const y = window.scrollY; renderTranscript(); window.scrollTo({ top: y }); }
}
els.viewToggle.addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

function groups() {
  const out = [];
  state.lines.forEach((l, i) => {
    const g = out[out.length - 1];
    if (g && g.speaker === l.speaker) g.idx.push(i);
    else out.push({ speaker: l.speaker, idx: [i] });
  });
  return out;
}

// Right-to-left if most letters are Arabic/Hebrew script (works per paragraph for mixed recordings).
function isRtlText(text) {
  const rtl = (text.match(/[\u0590-\u08FF]/g) || []).length;
  const ltr = (text.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/g) || []).length;
  return rtl > ltr;
}

function renderTranscript() {
  const q = state.query.trim();
  const re = q ? new RegExp(escRe(q), 'gi') : null;
  let matches = 0;
  const frag = document.createDocumentFragment();
  state.segEls = new Array(state.lines.length);
  for (const g of groups()) {
    const s = spk(g.speaker);
    const el = document.createElement('div');
    el.className = 'grp';
    el.dataset.sp = g.speaker;
    el.style.setProperty('--c', s.color);
    const groupText = g.idx.map((i) => lineText(i)).join(' ');
    el.dir = isRtlText(groupText) ? 'rtl' : 'ltr';
    const first = state.lines[g.idx[0]];
    el.innerHTML = `<div class="avatar">${esc(initials(s.name))}</div>
      <div class="grp-body">
        <div class="grp-head"><button class="who" type="button" title="Change speaker"><span class="who-name">${esc(s.name)}</span>${CHEVRON}</button><button class="grp-time" type="button" title="Play from ${fmtTime(first.start)}">${fmtTime(first.start)}</button></div>
      </div>`;
    const body = el.querySelector('.grp-body');
    for (const i of g.idx) {
      const p = document.createElement('p');
      p.className = state.lines[i].uncertain ? 'seg uncertain' : 'seg';
      p.dataset.i = i;
      p.title = state.lines[i].uncertain ? `${fmtTime(state.lines[i].start)} · low model confidence, worth double-checking` : fmtTime(state.lines[i].start);
      if (re) {
        const html = esc(lineText(i)).replace(new RegExp(escRe(esc(q)), 'gi'), (m) => { matches++; return `<mark>${m}</mark>`; });
        p.innerHTML = html;
      } else {
        p.textContent = lineText(i);
      }
      state.segEls[i] = p;
      body.appendChild(p);
    }
    el.querySelector('.who').addEventListener('click', (e) => openReassignMenu(e.currentTarget, g));
    el.querySelector('.grp-time').addEventListener('click', () => seek(first.start, true));
    frag.appendChild(el);
  }
  els.transcript.innerHTML = '';
  if (!state.lines.length) els.transcript.innerHTML = '<div class="empty">No speech was recognised in this file.</div>';
  els.transcript.appendChild(frag);
  els.searchCount.textContent = q ? `${matches} match${matches === 1 ? '' : 'es'}` : '';
  state.matchCursor = -1;
  state.activeIdx = -1;
  updateActive(true);
}

els.transcript.addEventListener('click', (e) => {
  const p = e.target.closest('.seg');
  if (!p || window.getSelection()?.toString()) return; // allow selecting text to copy
  seek(state.lines[Number(p.dataset.i)].start, true);
});

function openReassignMenu(anchor, g) {
  const cur = g.speaker;
  const items = [{ title: 'This part was said by' }];
  for (const id of speakerOrder()) {
    if (id === cur || id === UNKNOWN) continue;
    items.push({ label: spk(id).name, color: spk(id).color, onClick: () => reassignGroup(g, id) });
  }
  items.push('hr');
  items.push({ label: 'Someone new', color: COLORS[realSpeakers().length % COLORS.length], onClick: () => reassignGroup(g, newSpeaker()) });
  if (cur !== UNKNOWN) items.push({ label: 'Unknown', color: UNKNOWN_COLOR, onClick: () => reassignGroup(g, UNKNOWN) });
  openMenu(anchor, items);
}

function newSpeaker() {
  const id = `NEW_${state.nextId++}`;
  const n = realSpeakers().length;
  state.speakers.set(id, { name: `Speaker ${n + 1}`, color: COLORS[n % COLORS.length] });
  return id;
}

function reassignGroup(g, to) {
  const set = new Set(g.idx);
  reassign((l, i) => set.has(i), to);
}

function reassign(pred, to) {
  if (to === UNKNOWN && !state.speakers.has(UNKNOWN)) state.speakers.set(UNKNOWN, { name: 'Unknown', color: UNKNOWN_COLOR });
  state.lines.forEach((l, i) => { if (pred(l, i)) l.speaker = to; });
  const y = window.scrollY;
  renderAll();
  window.scrollTo({ top: y });
  toast('Updated');
  scheduleSync();
}

// search (always searches the transcript, so it brings that tab forward)
els.searchInput.addEventListener('focus', () => insights.showTab('transcript'));
let searchTimer;
els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { if (state?.lines) { state.query = els.searchInput.value; renderTranscript(); } }, 140);
});
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !state?.lines) return;
  const marks = [...els.transcript.querySelectorAll('mark')];
  if (!marks.length) return;
  marks.forEach((m) => m.classList.remove('cur'));
  state.matchCursor = (state.matchCursor + (e.shiftKey ? -1 : 1) + marks.length) % marks.length;
  const m = marks[state.matchCursor];
  m.classList.add('cur');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  els.searchCount.textContent = `${state.matchCursor + 1} / ${marks.length}`;
});

// ---------- timeline ----------
function timelineLayout() {
  const narrow = els.timeline.clientWidth < 560;
  const ids = speakerOrder();
  const lane = 14, gap = 6;
  return { ids, lane, gap, labelW: narrow ? 0 : 118, H: ids.length * (lane + gap) - gap };
}

function drawTimeline() {
  if (!state?.lines) return;
  const c = els.timelineCanvas;
  c.width = 0;
  const { ids, lane, gap, labelW, H } = timelineLayout();
  const W = els.timeline.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  c.width = W * dpr; c.height = H * dpr; c.style.height = H + 'px';
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const span = W - labelW;
  const d = state.duration || 1;
  ids.forEach((id, row) => {
    const y = row * (lane + gap);
    const s = spk(id);
    ctx.fillStyle = 'rgba(140,160,255,0.06)';
    roundRect(ctx, labelW, y, span, lane, 4);
    ctx.fill();
    if (labelW) {
      ctx.fillStyle = s.color;
      ctx.font = '600 11.5px "Space Grotesk", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      let name = s.name;
      while (name.length > 3 && ctx.measureText(name).width > labelW - 16) name = name.slice(0, -2) + '…';
      ctx.fillText(name, 0, y + lane / 2 + 1);
    }
    ctx.fillStyle = s.color;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 6;
    for (const l of state.lines) {
      if (l.speaker !== id) continue;
      const x0 = labelW + (l.start / d) * span;
      const w = Math.max(1.5, ((l.end - l.start) / d) * span);
      roundRect(ctx, x0, y + 2, w, lane - 4, 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function timeAt(clientX) {
  const rect = els.timeline.getBoundingClientRect();
  const { labelW } = timelineLayout();
  const x = clientX - rect.left - labelW;
  return Math.max(0, Math.min(1, x / (rect.width - labelW))) * state.duration;
}
els.timeline.addEventListener('click', (e) => { if (state?.lines) seek(timeAt(e.clientX), true); });
els.timeline.addEventListener('mousemove', (e) => {
  if (!state?.lines) return;
  const rect = els.timeline.getBoundingClientRect();
  els.tlHover.style.left = `${e.clientX - rect.left}px`;
  els.tlHover.textContent = fmtTime(timeAt(e.clientX));
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state?.lines && !els.resultsPanel.classList.contains('hidden')) { drawTimeline(); updatePlayhead(); } }, 120);
});

// ---------- player ----------
function seek(t, play = false) {
  els.player.currentTime = Math.max(0, t);
  if (play) els.player.play().catch(() => {});
  updatePlayhead();
  updateActive(true);
}
els.playBtn.addEventListener('click', () => (els.player.paused ? els.player.play().catch(() => {}) : els.player.pause()));
els.backBtn.addEventListener('click', () => seek(els.player.currentTime - 10));
els.fwdBtn.addEventListener('click', () => seek(els.player.currentTime + 10));
els.player.addEventListener('play', () => { els.playBtn.classList.add('playing'); mascotSignal('audio-play'); });
els.player.addEventListener('pause', () => { els.playBtn.classList.remove('playing'); mascotSignal('audio-pause'); });
els.player.addEventListener('timeupdate', () => { updatePlayhead(); updateActive(false); });
els.pbSeek.addEventListener('input', () => {
  if (!state?.duration) return;
  els.player.currentTime = (els.pbSeek.value / 1000) * state.duration;
  updatePlayhead();
  updateActive(true);
});
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
els.speedBtn.addEventListener('click', () => {
  const i = (SPEEDS.indexOf(els.player.playbackRate) + 1) % SPEEDS.length;
  els.player.playbackRate = SPEEDS[i];
  els.speedBtn.textContent = `${SPEEDS[i]}×`;
});
// ---------- playback volume ----------
// Listening volume only: it sets the <audio> element's volume. The decoded samples used for
// transcription were taken from the file before playback and are never affected.
const VOL_KEY = 'sparkscribe.volume';
const VOL_ICONS = {
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m16.5 9.5 5 5m0-5-5 5"/></svg>',
  low: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5"/></svg>',
  high: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M19 7a7 7 0 0 1 0 10"/></svg>',
};
const vol = { level: 100, muted: false };
try {
  const saved = JSON.parse(sessionStorage.getItem(VOL_KEY) || 'null');
  if (saved && Number.isFinite(saved.level)) { vol.level = Math.max(0, Math.min(100, saved.level)); vol.muted = !!saved.muted; }
} catch {}
function applyVolume() {
  const silent = vol.muted || vol.level === 0;
  els.player.volume = vol.level / 100;
  els.player.muted = vol.muted;
  els.volSlider.value = String(silent ? 0 : vol.level);
  const shown = silent ? 0 : vol.level;
  els.volSlider.style.background = `linear-gradient(90deg, var(--cyan) 0%, var(--violet) ${shown}%, rgba(140,160,255,.16) ${shown}%)`;
  els.volSlider.setAttribute('aria-valuetext', silent ? 'muted' : `${vol.level}%`);
  els.muteBtn.innerHTML = VOL_ICONS[silent ? 'muted' : vol.level < 50 ? 'low' : 'high'];
  els.muteBtn.title = silent ? 'Unmute (M)' : `Mute (M) · volume ${vol.level}%`;
  els.muteBtn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  els.muteBtn.classList.toggle('is-muted', silent);
  try { sessionStorage.setItem(VOL_KEY, JSON.stringify(vol)); } catch {}
}
function toggleMute() {
  if (vol.muted || vol.level === 0) {
    vol.muted = false;
    if (vol.level === 0) vol.level = 50;
  } else vol.muted = true;
  applyVolume();
}
els.muteBtn.addEventListener('click', toggleMute);
els.volSlider.addEventListener('input', () => {
  vol.level = Number(els.volSlider.value);
  vol.muted = vol.level === 0;
  applyVolume();
});
applyVolume();

els.followBtn.addEventListener('click', () => {
  els.followBtn.classList.toggle('on');
  if (els.followBtn.classList.contains('on')) updateActive(true);
});

function updatePlayhead() {
  if (!state?.duration) return;
  const t = els.player.currentTime || 0;
  const d = state.duration;
  if (document.activeElement !== els.pbSeek) els.pbSeek.value = Math.round((t / d) * 1000);
  els.pbSeek.style.background = `linear-gradient(90deg, var(--cyan) 0%, var(--violet) ${(t / d) * 100}%, rgba(140,160,255,.16) ${(t / d) * 100}%)`;
  els.pbTime.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  const { labelW } = timelineLayout();
  const W = els.timeline.clientWidth;
  els.playhead.style.left = `${labelW + (t / d) * (W - labelW)}px`;
}

// The line being spoken right now: last line that started before t (binary search).
function lineAt(t) {
  const L = state.lines;
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans >= 0 && t > L[ans].end + 1.5) return -1;
  return ans;
}

let lastUserScroll = 0;
['wheel', 'touchmove'].forEach((ev) => window.addEventListener(ev, () => { lastUserScroll = performance.now(); }, { passive: true }));

function updateActive(force) {
  if (!state?.segEls) return;
  const idx = lineAt(els.player.currentTime || 0);
  if (idx === state.activeIdx && !force) return;
  state.segEls[state.activeIdx]?.classList.remove('active');
  state.activeIdx = idx;
  const el = state.segEls[idx];
  el?.classList.add('active');
  const speaker = idx >= 0 ? state.lines[idx].speaker : null;
  els.speakerList.querySelectorAll('.spk').forEach((c) => c.classList.toggle('speaking', !els.player.paused && c.dataset.id === speaker));
  const following = els.followBtn.classList.contains('on') && !els.player.paused && performance.now() - lastUserScroll > 4000;
  if (el && (following || (force && !els.player.paused))) {
    const r = el.getBoundingClientRect();
    if (r.top < 90 || r.bottom > window.innerHeight - 110) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

document.addEventListener('keydown', (e) => {
  if (!state?.lines || els.resultsPanel.classList.contains('hidden')) return;
  if (e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
  if (e.key === ' ') { e.preventDefault(); els.playBtn.click(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(els.player.currentTime - 5); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(els.player.currentTime + 5); }
  else if (e.key === '/' ) { e.preventDefault(); els.searchInput.focus(); }
  else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute(); }
});

// ---------- menu ----------
function openMenu(anchor, items) {
  const m = els.menu;
  m.innerHTML = '';
  for (const it of items) {
    if (it === 'hr') { m.appendChild(document.createElement('hr')); continue; }
    if (it.title) {
      const t = document.createElement('div');
      t.className = 'menu-title';
      t.textContent = it.title;
      m.appendChild(t);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.color) b.style.setProperty('--c', it.color);
    b.innerHTML = `${it.color ? '<span class="sw"></span>' : ''}<span>${esc(it.label)}</span>`;
    b.addEventListener('click', () => { closeMenu(); it.onClick(); });
    m.appendChild(b);
  }
  m.classList.remove('hidden', 'menu-info');
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 12);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
  m.style.left = `${Math.max(12, left)}px`;
  m.style.top = `${top}px`;
  m.querySelector('button')?.focus({ preventScroll: true });
  setTimeout(() => document.addEventListener('pointerdown', outsideMenu), 0);
}
function openInfo(anchor, title, html) {
  const m = els.menu;
  m.innerHTML = `<div class="info"><div class="info-title">${esc(title)}</div><div class="info-body">${html}</div></div>`;
  m.classList.remove('hidden');
  m.classList.add('menu-info');
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(12, Math.min(r.right - mw, window.innerWidth - mw - 12))}px`;
  m.style.top = `${Math.max(12, Math.min(r.bottom + 8, window.innerHeight - mh - 12))}px`;
  setTimeout(() => document.addEventListener('pointerdown', outsideMenu), 0);
}
function outsideMenu(e) { if (!els.menu.contains(e.target)) closeMenu(); }
function closeMenu() {
  els.menu.classList.add('hidden');
  els.menu.classList.remove('menu-info');
  document.removeEventListener('pointerdown', outsideMenu);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('scroll', closeMenu, { passive: true });

// ---------- export ----------
// Exports follow the view on screen (Original or Clean). The copy saved to the library is always Original.
function toTxt(view = 'original') {
  const text = (i) => (view === 'clean' ? lineText(i) : state.lines[i].text);
  const names = realSpeakers().map((id) => spk(id).name).join(', ');
  const head = `${currentFile?.name || 'Transcript'}\nLength: ${fmtTime(state.duration)} · Speakers: ${names || '—'}\n\n`;
  return head + groups().map((g) => {
    const first = state.lines[g.idx[0]];
    return `[${fmtTime(first.start)}] ${spk(g.speaker).name}:\n${g.idx.map(text).join(' ')}`;
  }).join('\n\n') + '\n';
}
const segmentsPayload = () => toStoredSegments(state.lines, (id) => spk(id).name);
const base = () => (currentFile?.name || 'transcript').replace(/\.[^.]+$/, '');
els.copyBtn.addEventListener('click', async () => {
  const clean = state.view === 'clean';
  try { await navigator.clipboard.writeText(toTxt(state.view)); toast(clean ? 'Copied (clean version)' : 'Copied to clipboard'); } catch { toast('Copy failed — try .txt instead'); }
});
// one export system: transcript (original or clean), summary, notes and created items, in every format
els.exportBtn.addEventListener('click', () => insights.openExport(state.view === 'clean' ? 'transcript_clean' : 'transcript'));

// ---------- account: save to My Library ----------
// Only the finished transcript text (plus title, length, language) is stored. Audio never leaves the device.
let session = null;
const save = { id: null, status: 'idle', error: '', timer: null };
const CLOUD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17l9-10"/></svg>';
const WARN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4m0 3v.01"/></svg>';

// ---------- Summary / Notes / Ask / Insights tabs ----------
// Built from the saved transcript (transcript text only; audio never leaves this device).
const insights = mountInsights({
  tabBar: $('resTabs'),
  transcriptEls: [$('timelineCard'), $('resBody')],
  host: $('insightsHost'),
  ctx: {
    getId: () => save.id,
    isSignedIn: () => Boolean(isConfigured && session),
    signIn: () => signInToSave(),
    saving: () => ['saving', 'pending', 'syncing'].includes(save.status),
    getSegments: () => (state?.lines || []).map((l, i) => ({ id: i, start: l.start, end: l.end, speaker: spk(l.speaker).name, text: l.text })),
    seek: (t) => seek(t, true),
    playbackTime: () => (els.player.getAttribute('src') ? els.player.currentTime || 0 : null),
    getRecordingType: () => state?.recordingType || null,
    setRecordingType: async (t) => { state.recordingType = t; if (save.id) await updateRecordingType(save.id, t); },
    duration: () => state?.duration || 0,
    autoGenerate: true, // a fresh transcription: summarize automatically once the user has turned summaries on
    coarse: false,
    title: () => base(),
    createdAt: () => null,
    toast: (m) => toast(m),
    typeSlot: () => $('typeSlot'),
  },
});

// Park the transcript in this browser, sign in, then it's saved automatically on return.
function signInToSave() {
  if (!stashPending(savePayload())) return toast("Couldn't hold the transcript for sign-in. Export it first.");
  location.href = `/auth?next=${encodeURIComponent('/?save=pending')}`;
}

if (isConfigured) {
  mountAccountMenu(document.getElementById('accountSlot'), {
    onChange: (s) => {
      const signedInNow = !session && s;
      session = s;
      insights.refresh();
      if (!state?.lines) return;
      if (signedInNow && save.status === 'signed-out') doSave(); // signed in from elsewhere: save what's on screen
      else if (!s && save.status === 'idle') autoSave();
      else renderSaveBar();
    },
  });
  resumePendingSave();
}

function resetSave() {
  clearTimeout(save.timer);
  Object.assign(save, { id: null, status: 'idle', error: '', timer: null });
  els.saveBar?.classList.add('hidden');
}

const savePayload = () => ({
  title: base(), durationSeconds: state.duration, language: state.language, text: toTxt('original'),
  segments: segmentsPayload(), recordingType: state.recordingType || null,
});

async function autoSave() {
  if (!isConfigured || !state?.lines?.length) return;
  session = session ?? (await getSession());
  if (!session) { save.status = 'signed-out'; return renderSaveBar(); }
  await doSave();
}

async function doSave() {
  if (save.id) return syncNow();
  save.status = 'saving';
  renderSaveBar();
  try {
    save.id = await saveTranscript(savePayload());
    save.status = 'saved';
    insights.setTranscription();
  } catch (err) {
    save.status = 'error';
    save.error = err.message || String(err);
  }
  renderSaveBar();
}

// Speaker renames / reassignments after saving update the saved copy too.
function scheduleSync() {
  if (!save.id) return;
  clearTimeout(save.timer);
  save.status = 'pending';
  renderSaveBar();
  save.timer = setTimeout(syncNow, 1200);
}
async function syncNow() {
  clearTimeout(save.timer);
  if (!save.id || !state?.lines) return;
  save.status = 'syncing';
  renderSaveBar();
  try {
    await updateTranscriptText(save.id, toTxt('original'), segmentsPayload());
    save.status = 'saved';
    insights.transcriptChanged(); // earlier summaries now show as out of date
  } catch (err) {
    save.status = 'sync-error';
    save.error = err.message || String(err);
  }
  renderSaveBar();
}

function renderSaveBar() {
  insights.refresh(); // the Summary/Ask tabs depend on the transcript being saved
  const bar = els.saveBar || (els.saveBar = document.getElementById('saveBar'));
  if (!bar || !isConfigured || !state?.lines) return bar?.classList.add('hidden');
  const views = {
    'signed-out': ['muted', CLOUD, 'Not saved. Sign in to keep this transcript in your library.', '<button class="btn btn-ghost btn-sm" type="button" data-act="signin">Sign in to save</button>'],
    saving: ['busy', CLOUD, 'Saving to My Library…', ''],
    pending: ['busy', CLOUD, 'Saving your changes…', ''],
    syncing: ['busy', CLOUD, 'Saving your changes…', ''],
    saved: ['ok', CHECK, 'Saved to My Library <span class="save-note">· transcript text only, audio stays on this device</span>', `<a class="btn btn-ghost btn-sm" href="/transcript?id=${encodeURIComponent(save.id || '')}">Open saved copy</a>`],
    error: ['bad', WARN, `Couldn't save to your library: ${esc(save.error)}. Your transcript is still here, and you can export it.`, '<button class="btn btn-ghost btn-sm" type="button" data-act="retry">Retry</button>'],
    'sync-error': ['bad', WARN, `Couldn't save your latest edits: ${esc(save.error)}`, '<button class="btn btn-ghost btn-sm" type="button" data-act="retry">Retry</button>'],
  };
  const v = views[save.status];
  if (!v) return bar.classList.add('hidden');
  const [kind, icon, text, action] = v;
  bar.className = `save-bar ${kind}`;
  bar.innerHTML = `<span class="save-icon">${icon}</span><span class="save-text">${text}</span>${action}`;
  bar.querySelector('[data-act="retry"]')?.addEventListener('click', doSave);
  bar.querySelector('[data-act="signin"]')?.addEventListener('click', signInToSave);
  bar.querySelector('a[href^="/transcript"]')?.addEventListener('click', mascotTravel); // the mascot follows to the saved copy
}

// Back from signing in with a parked transcript: save it, then open it.
async function resumePendingSave() {
  const params = new URLSearchParams(location.search);
  const pending = peekPending();
  if (params.has('save')) history.replaceState(null, '', '/');
  if (!pending) return;
  const s = await getSession();
  if (!s) return; // stays parked until they sign in
  const note = document.createElement('div');
  note.className = 'pending-card panel';
  note.innerHTML = `<span class="spinner sm" aria-hidden="true"></span><span>Saving “${esc(pending.title)}” to My Library…</span>`;
  document.body.appendChild(note);
  try {
    const id = await saveTranscript(pending);
    clearPending();
    location.replace(`/transcript?id=${encodeURIComponent(id)}`);
  } catch (err) {
    note.innerHTML = `<span class="save-icon bad">${WARN}</span><span>Couldn't save “${esc(pending.title)}”: ${esc(err.message || err)}</span><button class="btn btn-ghost btn-sm" type="button">Retry</button>`;
    note.querySelector('button').addEventListener('click', () => { note.remove(); resumePendingSave(); });
  }
}

// ---------- utils ----------
function fmtTime(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}
function langName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function cssEsc(s) { return window.CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// ---------- home: brand motion, "Hear it. Understand it. Use it." demos, cursor glow ----------
setTimeout(() => sparkPulse(), 700); // one pulse when the page opens

// small product demos: tabs (Summary / Notes / Ask) and tool chips (Quiz / Study Guide / ...)
function demoSwitch(buttons, panel, attr, pressedAttr) {
  buttons.forEach((b) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.setAttribute(pressedAttr, String(x === b)));
    panel.querySelectorAll('[data-for]').forEach((d) => { d.hidden = d.dataset.for !== b.dataset[attr]; });
  }));
}
{
  const u = document.querySelector('[data-hear-panel="understand"]');
  const c = document.querySelector('[data-hear-panel="create"]');
  if (u) demoSwitch([...document.querySelectorAll('[data-hear]')], u, 'hear', 'aria-selected');
  if (c) demoSwitch([...document.querySelectorAll('[data-make]')], c, 'make', 'aria-pressed');
}

// ---------- home polish: upload spark, transcript demo ----------
const calmMotion = matchMedia('(prefers-reduced-motion: reduce)');
const onLanding = () => !els.dropPanel.classList.contains('hidden') && !document.hidden;

// The spark above "Drop a file or browse" ignites once on every new pointer entry (light runs from the bolt
// out through the bars), resets when the pointer leaves, and plays a stronger version when a file is dragged
// in. The energy edge pauses while the upload area is off screen or the window is in the background.
{
  const icon = els.dropzone.querySelector('.dz-icon');
  let dragInside = false;
  const ignite = (strong) => {
    if (calmMotion.matches || !icon) return;
    icon.classList.remove('dz-spark', 'dz-spark-strong');
    void icon.offsetWidth;                         // restart the animation from the beginning
    icon.classList.add(strong ? 'dz-spark-strong' : 'dz-spark');
  };
  els.dropzone.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') ignite(false); });
  els.dropzone.addEventListener('pointerleave', () => { if (!dragInside) icon?.classList.remove('dz-spark', 'dz-spark-strong'); });
  els.dropzone.addEventListener('dragenter', () => { if (!dragInside) { dragInside = true; ignite(true); } });
  const dragOut = () => { dragInside = false; icon?.classList.remove('dz-spark', 'dz-spark-strong'); };
  els.dropzone.addEventListener('dragleave', (e) => { if (!els.dropzone.contains(e.relatedTarget)) dragOut(); });
  els.dropzone.addEventListener('drop', dragOut);

  let onScreen = true;
  const still = () => els.dropzone.classList.toggle('dz-still', !onScreen || document.hidden || !document.hasFocus());
  if ('IntersectionObserver' in window) new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; still(); }).observe(els.dropzone);
  document.addEventListener('visibilitychange', still);
  window.addEventListener('blur', still);
  window.addEventListener('focus', still);
}

// "what." has a soft echo: three faint copies (cyan, violet, pink) that drift a few pixels AGAINST the pointer,
// like an after-image of a sound. The word itself never moves. Mouse only; off with reduce motion.
{
  const echo = document.getElementById('heroEcho');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
  const tick = () => {
    x += (tx - x) * 0.12; y += (ty - y) * 0.12;
    echo.style.setProperty('--ex', x.toFixed(3)); echo.style.setProperty('--ey', y.toFixed(3));
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  if (echo) {
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !fine.matches || calmMotion.matches || !onLanding()) return;
      const r = echo.getBoundingClientRect();
      tx = -Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)));
      ty = -Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
      if (!raf) raf = requestAnimationFrame(tick);
    }, { passive: true });
  }
}

// The transcript example plays along slowly while it is on screen (like the real Play along view).
{
  const lines = [...document.querySelectorAll('.hear-lines > div')];
  let timer = 0, i = lines.findIndex((l) => l.classList.contains('hl'));
  const step = () => {
    if (calmMotion.matches || !onLanding()) return;
    lines.forEach((l) => l.classList.remove('hl'));
    i = (i + 1) % lines.length;
    lines[i].classList.add('hl');
  };
  if (lines.length && 'IntersectionObserver' in window) {
    new IntersectionObserver(([en]) => {
      clearInterval(timer);
      if (en.isIntersecting) timer = setInterval(step, 2600);
    }, { threshold: 0.4 }).observe(lines[0].parentElement);
  }
  // like the real transcript: click a line (its timestamp) to jump there
  lines.forEach((l, n) => {
    l.tabIndex = 0;
    l.setAttribute('role', 'button');
    const go = () => { lines.forEach((x) => x.classList.remove('hl')); l.classList.add('hl'); i = n; clearInterval(timer); timer = setInterval(step, 2600); };
    l.addEventListener('click', go);
    l.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// the mascot: a small audio companion (src/mascot/mascot.js)
mountMascot({ page: 'home' });
