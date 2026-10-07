// Writes index.json for a test-set folder so the eval page can load it from the dev server.
//   node accuracy/make-index.mjs accuracy/testset/synthetic
// A test item is <name>.<audio ext> + <name>.ref.txt (+ optional <name>.meta.json).
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const dir = process.argv[2] || 'accuracy/testset/synthetic';
const AUDIO = new Set(['.wav', '.mp3', '.m4a', '.mp4', '.ogg', '.opus', '.webm', '.flac', '.aac', '.mov']);
const items = readdirSync(dir)
  .filter((f) => AUDIO.has(extname(f).toLowerCase()))
  .map((f) => {
    const name = basename(f, extname(f));
    return { name, audio: f, ref: existsSync(join(dir, `${name}.ref.txt`)) ? `${name}.ref.txt` : null, meta: existsSync(join(dir, `${name}.meta.json`)) ? `${name}.meta.json` : null };
  })
  .filter((it) => it.ref)
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(dir, 'index.json'), JSON.stringify({ items }, null, 2));
console.log(`index.json: ${items.length} items with references in ${dir}`);
