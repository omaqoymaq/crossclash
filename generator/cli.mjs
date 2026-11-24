#!/usr/bin/env node
// Generates (or tops up) puzzle packs used by the game.
//
//   node generator/cli.mjs --size regular --count 100 [--seed 42] [--out public/puzzles]
//   node generator/cli.mjs --size all --count 50
//   node generator/cli.mjs --print --size large        # print one puzzle as text
//
// Full packs live in puzzles/<size>.json (bundled into the server for 1v1
// rooms, never served publicly). Every 4th puzzle is also copied, with
// answers, to public/puzzles/solo-<size>.json for offline play vs the bot, and
// those puzzles are excluded from rooms so a room's answers are never public. Running again appends new, unique
// puzzles (duplicate grids are skipped) and steers away from words that the
// pack already uses a lot, so packs stay varied as they grow.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIZES, buildIndex, generatePuzzle, validatePuzzle } from './arrowword.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const sizes = args.size === 'all' || !args.size ? Object.keys(SIZES) : [args.size];
const count = Number(args.count || 1);
const outDir = path.resolve(args.out || path.join(here, '..', 'puzzles'));
const soloDir = path.resolve(args.solo || path.join(here, '..', 'public', 'puzzles'));
let seed = args.seed ? Number(args.seed) : (Date.now() & 0x7fffffff);

const lexicon = JSON.parse(fs.readFileSync(path.join(here, 'data', 'lexicon.json'), 'utf8')).words;
const index = buildIndex(lexicon);

if (args.print) {
  const p = generatePuzzle({ size: sizes[0], index, seed });
  if (!p) { console.error('failed'); process.exit(1); }
  console.log(p.rows.join('\n'));
  for (const c of p.clues) console.log(`${c.at} ${c.arrow.padEnd(9)} ${c.answer.padEnd(10)} ${c.text}`);
  console.log(p.stats);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of sizes) {
  const file = path.join(outDir, `${size}.json`);
  const pack = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { size, puzzles: [] };
  const ids = new Set(pack.puzzles.map((p) => p.id));
  const usage = new Map();
  for (const p of pack.puzzles) for (const c of p.clues) usage.set(c.answer, (usage.get(c.answer) || 0) + 1);

  let made = 0, failed = 0;
  const t0 = Date.now();
  while (made < count && failed < count * 5 + 10) {
    const p = generatePuzzle({ size, index, seed: seed++, avoid: usage });
    if (!p || ids.has(p.id)) { failed++; continue; }
    const problems = validatePuzzle(p, lexicon);
    if (problems.length) { console.warn(`rejected ${p.id}:`, problems.slice(0, 3)); failed++; continue; }
    pack.puzzles.push(p);
    ids.add(p.id);
    for (const c of p.clues) usage.set(c.answer, (usage.get(c.answer) || 0) + 1);
    made++;
    if (made % 10 === 0) process.stdout.write(`  ${size}: ${made}/${count}\r`);
  }
  pack.generatedWith = 'CrossClash arrowword generator v1';
  pack.count = pack.puzzles.length;
  fs.writeFileSync(file, JSON.stringify(pack));
  fs.mkdirSync(soloDir, { recursive: true });
  const solo = pack.puzzles.filter((_, i) => i % 4 === 0);
  fs.writeFileSync(path.join(soloDir, `solo-${size}.json`), JSON.stringify({ size, count: solo.length, puzzles: solo }));
  console.log(`${size}: +${made} (failed ${failed}) -> ${pack.puzzles.length} total in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
