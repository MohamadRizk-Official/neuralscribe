#!/usr/bin/env node
// Score one transcript against a reference:
//   node accuracy/score.mjs reference.txt hypothesis.txt [--terms "Hadi Salame, SparkScribe"] [--diff]
// Prints WER, CER, error counts and (with --diff) the aligned words for manual review.
// Exported transcripts (.txt from the app) can be passed directly: speaker/timestamp header lines
// like "[0:14] Speaker 1:" and the two-line file header are stripped first.
import { readFileSync } from 'node:fs';
import { wer, cer, termRecall, pct } from '../src/lib/metrics.js';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node accuracy/score.mjs reference.txt hypothesis.txt [--terms "a, b"] [--diff]');
  process.exit(1);
}
const stripExport = (t) => {
  let lines = t.split(/\r?\n/);
  if (lines[1]?.startsWith('Length:')) lines = lines.slice(2); // "<file name>" + "Length: … · Speakers: …"
  return lines.filter((l) => !/^\[\d{1,2}(:\d{2}){1,2}\] .+:$/.test(l)).join(' ');
};

const ref = stripExport(readFileSync(args[0], 'utf8'));
const hyp = stripExport(readFileSync(args[1], 'utf8'));
const w = wer(ref, hyp);
const c = cer(ref, hyp);
console.log(`WER ${pct(w.wer)}  (S ${w.S}, D ${w.D}, I ${w.I}, N ${w.N})`);
console.log(`CER ${pct(c.cer)}  (S ${c.S}, D ${c.D}, I ${c.I}, N ${c.N})`);
const ti = args.indexOf('--terms');
if (ti >= 0) {
  const r = termRecall(args[ti + 1].split(','), hyp);
  console.log(`Important words found ${r.found}/${r.total}${r.missing.length ? `  missing: ${r.missing.join(', ')}` : ''}`);
}
if (args.includes('--diff')) {
  console.log(
    w.ops
      .map((o) => (o.op === 'ok' ? o.ref : o.op === 'sub' ? `[${o.ref}→${o.hyp}]` : o.op === 'del' ? `[-${o.ref}]` : `[+${o.hyp}]`))
      .join(' '),
  );
}
