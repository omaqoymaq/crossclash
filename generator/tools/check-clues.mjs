// Flags hand-written clues that give their own answer away.
//   node generator/tools/check-clues.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'clues');
let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [w, ...cs] = line.split('|');
    const W = w.trim().toUpperCase();
    const stem = W.length > 4 ? W.slice(0, Math.max(4, W.length - 2)) : W;
    for (const c of cs) {
      const words = c.toUpperCase().split(/[^A-Z]+/);
      if (words.some((x) => x === W || (x.length >= 4 && x.startsWith(stem)))) { console.log(`${f}: ${W} | ${c}`); bad++; }
    }
  }
}
console.log(`${bad} clue(s) contain their answer`);
