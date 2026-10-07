// Copies accuracy/testset into a built eval bundle so `npm run eval:serve` can serve it.
import { cpSync, existsSync } from 'node:fs';
const out = process.argv[2] || 'dist-eval';
if (existsSync('accuracy/testset')) cpSync('accuracy/testset', `${out}/accuracy/testset`, { recursive: true });
console.log(`test sets copied into ${out}/accuracy/testset`);
