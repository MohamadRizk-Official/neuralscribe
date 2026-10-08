// Accuracy lab (dev only). Runs the same worker the app uses, item by item, for each configuration,
// then scores the hypothesis against the reference transcript.
import { decodeToMono16k } from '../audio.js';
import { wer, cer, termRecall, pct, speakerAttribution } from '../lib/metrics.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_CONFIGS = [
  { label: 'Fast', mode: 'fast' },
  { label: 'Best Accuracy', mode: 'best' },
];
$('configs').value = JSON.stringify(DEFAULT_CONFIGS, null, 1);

let items = []; // { name, file|url, ref, meta }
let results = [];
window.__evalResults = () => results; // for scripted runs

$('loadSet').addEventListener('click', async () => {
  const base = $('setPath').value.replace(/\/?$/, '/');
  const idx = await (await fetch(base + 'index.json')).json();
  items = await Promise.all(idx.items.map(async (it) => ({
    name: it.name,
    url: base + it.audio,
    ref: await (await fetch(base + it.ref)).text(),
    meta: it.meta ? JSON.parse((await (await fetch(base + it.meta)).text()).replace(/^﻿/, '')) : {},
    turns: it.turns ? JSON.parse((await (await fetch(base + it.turns)).text()).replace(/^﻿/, '')) : null,
  })));
  $('setInfo').textContent = `${items.length} items: ${items.map((i) => i.name).join(', ')}`;
});

$('folder').addEventListener('change', async () => {
  const files = [...$('folder').files];
  const by = new Map();
  for (const f of files) {
    const m = /^(.*?)(\.ref\.txt|\.meta\.json|\.[a-z0-9]+)$/i.exec(f.name);
    if (!m) continue;
    const e = by.get(m[1]) || {};
    if (m[2] === '.ref.txt') e.ref = f; else if (m[2] === '.meta.json') e.meta = f; else if (m[2] === '.json' && f.name.endsWith('.turns.json')) e.turns = f; else if (/^\.(wav|mp3|m4a|mp4|ogg|opus|webm|flac|aac|mov)$/i.test(m[2])) e.audio = f;
    by.set(m[1], e);
  }
  items = [];
  for (const [name, e] of by) {
    if (!e.audio || !e.ref) continue;
    items.push({ name, file: e.audio, ref: await e.ref.text(), meta: e.meta ? JSON.parse((await e.meta.text()).replace(/^﻿/, '')) : {}, turns: e.turns ? JSON.parse((await e.turns.text()).replace(/^﻿/, '')) : null });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  $('setInfo').textContent = `${items.length} items with references from the folder.`;
});

function runOnce(worker, audio, settings) {
  return new Promise((resolve, reject) => {
    const onMsg = ({ data }) => {
      if (data.type === 'status') $('status').textContent = data.text;
      if (data.type === 'complete') { worker.removeEventListener('message', onMsg); resolve(data); }
      if (data.type === 'error') { worker.removeEventListener('message', onMsg); reject(new Error(data.message)); }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'run', audio, ...settings }, [audio.buffer]);
  });
}

$('run').addEventListener('click', async () => {
  const configs = JSON.parse($('configs').value);
  const filter = $('filter').value ? new RegExp($('filter').value) : null;
  const todo = items.filter((it) => !filter || filter.test(it.name));
  results = [];
  $('run').disabled = true;
  const worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'detect' });
  try {
    for (const cfg of configs) {
      for (const it of todo) {
        $('status').textContent = `${cfg.label}: ${it.name}…`;
        const file = it.file || new File([await (await fetch(it.url)).blob()], it.name + '.wav');
        const decoded = await decodeToMono16k(file, () => {});
        const settings = {
          mode: 'best', language: it.meta.language || '', diarize: true, numSpeakers: 0, vocabulary: [],
          ...cfg,
        };
        if ($('useMetaSpeakers').checked && it.meta.speakers && cfg.numSpeakers === undefined) settings.numSpeakers = it.meta.speakers;
        if ($('useMetaVocab').checked && it.meta.vocabulary && cfg.vocabulary === undefined) settings.vocabulary = it.meta.vocabulary;
        const t0 = performance.now();
        let out, error = null;
        try { out = await runOnce(worker, decoded.samples, settings); } catch (e) { error = e.message; }
        const ms = performance.now() - t0;
        const hyp = out ? out.lines.map((l) => l.text).join(' ') : '';
        const w = wer(it.ref, hyp);
        const c = cer(it.ref, hyp);
        const speakersFound = out ? new Set(out.lines.map((l) => l.speaker).filter((s) => s !== 'Unknown')).size : 0;
        const attr = out && it.turns ? speakerAttribution(Array.isArray(it.turns) ? it.turns : [it.turns], out.lines) : null;
        results.push({
          config: cfg.label, item: it.name, category: it.meta.category || '', duration: decoded.duration, ms, rtf: ms / 1000 / decoded.duration,
          wer: w.wer, S: w.S, D: w.D, I: w.I, N: w.N, cer: c.cer,
          terms: it.meta.vocabulary ? termRecall(it.meta.vocabulary, hyp) : null,
          speakersExpected: it.meta.speakers ?? null, speakersFound,
          retried: out?.stats?.retried ?? null, uncertain: out?.stats?.uncertain ?? null, model: out?.stats?.model ?? cfg.model ?? '', stats: out?.stats ?? null,
          attr, lines: out?.lines?.map((l) => `[${l.start.toFixed(1)}–${l.end.toFixed(1)}] ${l.speaker}: ${l.text}`) ?? [],
          hyp, ref: it.ref, ops: w.ops, error,
        });
        render();
      }
    }
    $('status').textContent = 'Done.';
  } finally {
    worker.terminate();
    $('run').disabled = false;
    $('dl').disabled = !results.length;
  }
});

function render() {
  const byCfg = new Map();
  for (const r of results) {
    const a = byCfg.get(r.config) || { S: 0, D: 0, I: 0, N: 0, sec: 0, ms: 0, termsF: 0, termsT: 0, spkOk: 0, spkN: 0, n: 0, attrE: 0, attrW: 0, unk: 0, fc: 0, mc: 0 };
    if (r.attr) { a.attrE += r.attr.errors; a.attrW += r.attr.words; a.unk += r.attr.unknownWords; a.fc += r.attr.falseChanges; a.mc += r.attr.missedChanges; }
    a.S += r.S; a.D += r.D; a.I += r.I; a.N += r.N; a.sec += r.duration; a.ms += r.ms; a.n++;
    if (r.terms) { a.termsF += r.terms.found; a.termsT += r.terms.total; }
    if (r.speakersExpected) { a.spkN++; if (r.speakersExpected === r.speakersFound) a.spkOk++; }
    byCfg.set(r.config, a);
  }
  $('summary').innerHTML = `<table><tr><th>Config</th><th>Items</th><th>WER (pooled)</th><th>S / D / I</th><th>Important words</th><th>Speaker count right</th><th>Words to wrong speaker</th><th>Unknown words</th><th>False / missed changes</th><th>Speed</th></tr>${[...byCfg].map(([k, a]) => `<tr><td>${k}</td><td>${a.n}</td><td>${pct((a.S + a.D + a.I) / Math.max(1, a.N))}</td><td>${a.S} / ${a.D} / ${a.I} of ${a.N}</td><td>${a.termsT ? `${a.termsF}/${a.termsT}` : '—'}</td><td>${a.spkN ? `${a.spkOk}/${a.spkN}` : '—'}</td><td>${a.attrW ? `${pct(a.attrE / a.attrW)} (${a.attrE})` : '—'}</td><td>${a.attrW ? a.unk : '—'}</td><td>${a.attrW ? `${a.fc} / ${a.mc}` : '—'}</td><td>${(a.sec / (a.ms / 1000)).toFixed(1)}× real time</td></tr>`).join('')}</table>`;
  $('details').innerHTML = `<table><tr><th>Config</th><th>Item</th><th>Category</th><th>WER</th><th>CER</th><th>Words</th><th>Speakers</th><th>Wrong spk / Unknown / false / missed</th><th>Retried</th><th>Time</th></tr>${results.map((r, i) => `<tr><td>${r.config}</td><td>${r.item}</td><td>${r.category}</td><td>${r.error ? 'ERROR' : pct(r.wer)}</td><td>${pct(r.cer)}</td><td>${r.terms ? `${r.terms.found}/${r.terms.total}` : '—'}</td><td>${r.speakersExpected ? `${r.speakersFound}/${r.speakersExpected}` : r.speakersFound}</td><td>${r.attr ? `${r.attr.errors} / ${r.attr.unknownWords} / ${r.attr.falseChanges} / ${r.attr.missedChanges}` : '—'}</td><td>${r.retried ?? '—'}</td><td>${(r.ms / 1000).toFixed(1)}s</td></tr><tr><td colspan="10"><details><summary class="muted">diff${r.error ? ` — ${r.error}` : ''}</summary><div class="diff" style="margin-bottom:8px">${r.lines.map((l) => `<div>${l.replace(/[<>&]/g, '')}</div>`).join('')}</div><div class="diff">${r.ops.map((o) => o.op === 'ok' ? o.ref : o.op === 'sub' ? `<span class="sub">${o.ref}→${o.hyp}</span>` : o.op === 'del' ? `<span class="del">${o.ref}</span>` : `<span class="ins">${o.hyp}</span>`).join(' ')}</div></details></td></tr>`).join('')}</table>`;
  window.__results = results;
}

$('dl').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(results.map(({ ops, ...r }) => r), null, 2)], { type: 'application/json' }));
  a.download = `accuracy-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`;
  a.click();
});
