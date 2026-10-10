// Runs the speaker test set gently: one recording at a time, capped CPU threads, below-normal priority, a memory
// stop, and a saved result after every recording. A rerun skips every result already saved for the same speaker
// code, so an interrupted run resumes where it stopped.
//
//   node accuracy/diarize-run.mjs <out-dir> [--only name,name] [--threads 8] [--max-rss-mb 6000] [--min-free-mb 4000]
//                                           [--timeout-min 20] [--list]
//
// Names are "<recording>-auto" or "<recording>-n<count>" (see JOBS). Results: <out-dir>/<name>-v3.json, one line per
// recording in <out-dir>/progress.jsonl (time, CPU, peak memory, pass/fail). Speaker code: the committed
// src/engine/diarize.js; the run refuses to start if that file has uncommitted changes.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(args[0] || '');
const THREADS = Number(opt('--threads', 8));
const MAX_RSS_MB = Number(opt('--max-rss-mb', 6000));
const MIN_FREE_MB = Number(opt('--min-free-mb', 4000));
const TIMEOUT_MS = Number(opt('--timeout-min', 20)) * 60e3;
const TAG = 'v3';

const A = 'accuracy/testset/ami', S = 'accuracy/testset/diar-scenarios', P = 'accuracy/testset/private';
const JOBS = [];
const add = (name, audio, n, rttm) => {
  for (const k of [0, n]) JOBS.push({ name: `${name}-${k ? `n${k}` : 'auto'}`, audio, n: k, rttm });
};
add('coffee', `${P}/coffee_qazzaz_23m.mp4`, 3, null);
add('two-short-interruptions', `${S}/two-short-interruptions.wav`, 2, `${S}/two-short-interruptions.rttm`);
for (const m of ['ES2004a', 'TS3003a', 'IS1009a', 'EN2002b']) add(m, `${A}/${m}.Mix-Headset.wav`, 4, `${A}/${m}.rttm`);
add('ES2004a-far', `${A}/ES2004a.Array1-01.wav`, 4, `${A}/ES2004a.rttm`);
for (const [name, n] of [['one-speaker-variation', 1], ['one-speaker-distance', 1], ['one-speaker-noise-volume', 1], ['one-speaker-everything', 1],
  ['three-long-return', 3], ['five-speakers', 5], ['similar-voices', 3], ['noise-and-distance', 3]]) add(name, `${S}/${name}.wav`, n, `${S}/${name}.rttm`);

if (args.includes('--list') || !args[0]) { console.log(JOBS.map((j) => j.name).join('\n')); process.exit(args[0] ? 0 : 1); }
const only = opt('--only')?.split(',');
const jobs = only ? only.map((n) => JOBS.find((j) => j.name === n) || (() => { throw new Error(`unknown job ${n}`); })()) : JOBS;

// ---------- the speaker code under test ----------
const ENGINE = resolve(ROOT, 'src/engine/diarize.js');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--', 'src/engine/diarize.js')) throw new Error('src/engine/diarize.js has uncommitted changes: commit first, so results match a commit');
const commit = git('rev-parse', '--short', 'HEAD');
const engineHash = createHash('sha256').update(readFileSync(ENGINE)).digest('hex');

// ---------- one heavy run at a time ----------
mkdirSync(OUT, { recursive: true });
const LOCK = resolve(OUT, '.lock');
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
  if (alive) throw new Error(`another test run (pid ${pid}) is using ${OUT}`);
}
writeFileSync(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch { /* gone */ } };
process.on('exit', unlock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unlock(); process.exit(130); });

const valid = (f) => {
  try { const r = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(r.segments) && r.run?.engineHash === engineHash; } catch { return false; }
};
const rssMB = (pid) => {
  try {
    const line = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = /"([\d,.\s]+) K"/.exec(line); return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : 0;
  } catch { return 0; }
};
const cpuTimes = () => os.cpus().reduce((t, c) => { const s = Object.values(c.times).reduce((a, b) => a + b, 0); t.busy += s - c.times.idle; t.all += s; return t; }, { busy: 0, all: 0 });

function runOne(job, out) {
  return new Promise((done) => {
    const argv = ['accuracy/diarize-eval.mjs', job.audio, '--speakers', String(job.n), ...(job.rttm ? ['--rttm', job.rttm] : []), '--json', out, '--quiet'];
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, DIAR_THREADS: String(THREADS), DIAR_OFFLINE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    let err = '', stop = null, peak = 0, machine = [], last = cpuTimes();
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const watch = setInterval(() => {
      const rss = rssMB(child.pid); peak = Math.max(peak, rss);
      const now = cpuTimes(); machine.push((now.busy - last.busy) / Math.max(1, now.all - last.all)); last = now;
      const freeMB = os.freemem() / 2 ** 20;
      if (rss > MAX_RSS_MB) stop = `memory limit: run used ${rss} MB (limit ${MAX_RSS_MB})`;
      else if (freeMB < MIN_FREE_MB) stop = `computer low on memory: ${Math.round(freeMB)} MB free (limit ${MIN_FREE_MB})`;
      else if (Date.now() - t0 > TIMEOUT_MS) stop = `time limit ${TIMEOUT_MS / 60e3} min`;
      if (stop) child.kill();
    }, 5000);
    child.on('exit', (code) => {
      clearInterval(watch);
      const wallS = (Date.now() - t0) / 1000;
      const ok = !stop && code === 0 && valid(out);
      let run = {};
      try { run = JSON.parse(readFileSync(out, 'utf8')).run || {}; } catch { /* failed */ }
      const avg = machine.length ? machine.reduce((a, b) => a + b, 0) / machine.length : 0;
      done({ job: job.name, ok, wallS: +wallS.toFixed(1), cpuS: run.cpuS ?? null, avgCores: run.cpuS ? +(run.cpuS / wallS).toFixed(1) : null,
        peakRssMB: Math.max(run.peakRssMB || 0, peak), machineCpuAvgPct: Math.round(100 * avg), machineCpuPeakPct: Math.round(100 * Math.max(0, ...machine)),
        error: ok ? null : stop || `exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`, stopSuite: !!stop && !stop.startsWith('time') });
    });
  });
}

console.log(`speaker code ${commit} (${engineHash.slice(0, 12)}), ${THREADS} threads, below-normal priority, stop at ${MAX_RSS_MB} MB per run or < ${MIN_FREE_MB} MB free`);
let k = 0;
for (const job of jobs) {
  k++;
  const out = resolve(OUT, `${job.name}-${TAG}.json`);
  if (valid(out)) { console.log(`[${k}/${jobs.length}] ${job.name}: already done for this code, skipped`); continue; }
  console.log(`[${k}/${jobs.length}] ${job.name}: running…`);
  const r = await runOne(job, out);
  appendFileSync(resolve(OUT, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), commit, engineHash, threads: THREADS, ...r }) + '\n');
  console.log(`[${k}/${jobs.length}] ${job.name}: ${r.ok ? 'saved' : `FAILED (${r.error})`} · ${r.wallS}s · ${r.avgCores ?? '?'} cores avg · peak ${r.peakRssMB} MB · machine CPU ${r.machineCpuAvgPct}% avg / ${r.machineCpuPeakPct}% peak · ${jobs.length - k} left`);
  if (r.stopSuite) { console.log('stopped: resource limit reached'); process.exit(2); }
}
console.log('done');
