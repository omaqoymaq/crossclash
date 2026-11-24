#!/usr/bin/env node
// Generates (or tops up) puzzle packs used by the game.
//
//   node generator/cli.mjs --size regular --count 100 [--seed 42] [--out public/puzzles]
//   node generator/cli.mjs --size all --count 50
//   node generator/cli.mjs --print --size large        # print one puzzle as text
//   --allow-auto   also use words whose clue was made automatically (default: hand-written clues only)
//   --reclue       refresh clue texts in existing packs from the current lexicon
//   --report       list answers in the packs that still have automatic clues
//   --theme NAME   make one special puzzle from data/themes/NAME.txt only (e.g. --theme thanksgiving --size large)
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
const index = buildIndex(lexicon, { handOnly: !args['allow-auto'] });

// --theme NAME: one special puzzle where every answer comes from data/themes/NAME.txt
// ("WORD|Clue|Clue" per line), written to public/puzzles/special-NAME.json.
if (args.retheme) {
  // refresh a special puzzle's clues from its theme file (after adding themed clues for gap words)
  const file = path.join(soloDir, `special-${args.retheme}.json`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const theme = {};
  for (const line of fs.readFileSync(path.join(here, 'data', 'themes', `${args.retheme}.txt`), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [w, ...c] = line.split('|').map((x) => x.trim());
    theme[w] = c.filter(Boolean);
  }
  const missing = [];
  for (const p of pack.puzzles) for (const c of p.clues) {
    if (theme[c.answer]) { c.options = theme[c.answer]; c.text = c.options[0]; } else missing.push(c.answer);
  }
  fs.writeFileSync(file, JSON.stringify(pack));
  console.log(missing.length ? `still without a themed clue: ${missing.join(' ')}` : 'every clue is themed');
  process.exit(0);
}
if (args.theme) {
  const words = {};
  for (const line of fs.readFileSync(path.join(here, 'data', 'themes', `${args.theme}.txt`), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [w, ...c] = line.split('|').map((x) => x.trim());
    if (/^[A-Z]+$/.test(w) && c.length) words[w] = { f: 50, c: c.filter(Boolean), hand: true };
  }
  // theme words are marked "hand" and strongly preferred; ordinary hand-clued words may fill the gaps
  // (--strict: theme words only). Gap words are listed so they can get a themed clue in the theme file.
  const pool = {};
  // long words (the anchors) always come from the theme
  if (!args.strict) for (const [w, e] of Object.entries(lexicon)) if (e.hand && w.length < 8) pool[w] = { ...e, hand: false };
  Object.assign(pool, words);
  const themeIndex = buildIndex(pool, { handOnly: !!args.strict });
  const size = sizes[0];
  const t0 = Date.now();
  for (let tries = 0; tries < Number(args.tries || 200); tries++) {
    const p = generatePuzzle({ size, index: themeIndex, seed: seed++, maxTemplates: 400, maxNodes: 4000, handBoost: 12, anchors: args.anchors != null ? Number(args.anchors) : undefined });
    if (!p || validatePuzzle(p, pool).length) continue;
    for (const c of p.clues) if (words[c.answer]) { c.options = [...words[c.answer].c]; c.text = c.options[0]; }
    const gaps = p.clues.filter((c) => !words[c.answer]).map((c) => c.answer);
    if (gaps.length > Number(args['max-gaps'] ?? 0)) { console.log(`seed ${p.stats.seed}: ${gaps.length} non-theme words: ${gaps.join(' ')}`); continue; }
    p.theme = args.theme;
    p.title = args.title || args.theme;
    fs.mkdirSync(soloDir, { recursive: true });
    const out = path.join(soloDir, `special-${args.theme}.json`);
    fs.writeFileSync(out, JSON.stringify({ size, count: 1, title: p.title, puzzles: [p] }));
    console.log(p.rows.join('\n'));
    if (gaps.length) console.log(`non-theme words (add themed clues to the theme file, then run --retheme): ${gaps.join(' ')}`);
    console.log(`${p.clues.length} words (${p.clues.filter((c) => c.anchor).length} long anchors), seed ${p.stats.seed}, ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(process.cwd(), out)}`);
    process.exit(0);
  }
  console.error('no themed puzzle found; add more theme words or raise --tries');
  process.exit(1);
}

if (args.print) {
  const p = generatePuzzle({ size: sizes[0], index, seed });
  if (!p) { console.error('failed'); process.exit(1); }
  console.log(p.rows.join('\n'));
  for (const c of p.clues) console.log(`${c.at} ${c.arrow.padEnd(9)} ${c.answer.padEnd(10)} ${c.text}`);
  console.log(p.stats);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
if (args.report || args.reclue) {
  const missing = new Map();
  for (const size of sizes) {
    const file = path.join(outDir, `${size}.json`);
    if (!fs.existsSync(file)) continue;
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = 0;
    for (const p of pack.puzzles) for (const c of p.clues) {
      const e = lexicon[c.answer];
      if (!e || !e.hand) missing.set(c.answer, (missing.get(c.answer) || 0) + 1);
      else if (args.reclue && !e.c.includes(c.text)) { c.text = e.c[(p.id.charCodeAt(3) + c.id) % e.c.length]; changed++; }
    }
    if (args.reclue) {
      fs.writeFileSync(file, JSON.stringify(pack));
      const solo = pack.puzzles.filter((_, i) => i % 4 === 0);
      fs.writeFileSync(path.join(soloDir, `solo-${size}.json`), JSON.stringify({ size, count: solo.length, puzzles: solo }));
      console.log(`${size}: ${changed} clues refreshed`);
    }
  }
  console.log(`${missing.size} answers without a hand-written clue`);
  if (args.report) console.log([...missing.keys()].sort().join('\n'));
  process.exit(0);
}
for (const size of sizes) {
  const file = path.join(outDir, `${size}.json`);
  const pack = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { size, puzzles: [] };
  const ids = new Set(pack.puzzles.map((p) => p.id));
  const usage = new Map();
  for (const p of pack.puzzles) for (const c of p.clues) usage.set(c.answer, (usage.get(c.answer) || 0) + 1);

  let made = 0, failed = 0;
  const t0 = Date.now();
  while (made < count && failed < count * 5 + 10) {
    const p = generatePuzzle({ size, index, seed: seed++, avoid: usage, maxTemplates: 2500, maxNodes: 3000 });
    if (!p || ids.has(p.id)) { failed++; continue; }
    const problems = validatePuzzle(p, lexicon);
    if (problems.length) { console.warn(`rejected ${p.id}:`, problems.slice(0, 3)); failed++; continue; }
    pack.puzzles.push(p);
    ids.add(p.id);
    for (const c of p.clues) usage.set(c.answer, (usage.get(c.answer) || 0) + 1);
    made++;
    if (made % 10 === 0) process.stdout.write(`  ${size}: ${made}/${count}\r`);
  }
  pack.generatedWith = 'CrossClash arrowword generator v2 (long anchor words, rotating clues)';
  pack.count = pack.puzzles.length;
  fs.writeFileSync(file, JSON.stringify(pack));
  fs.mkdirSync(soloDir, { recursive: true });
  const solo = pack.puzzles.filter((_, i) => i % 4 === 0);
  fs.writeFileSync(path.join(soloDir, `solo-${size}.json`), JSON.stringify({ size, count: solo.length, puzzles: solo }));
  console.log(`${size}: +${made} (failed ${failed}) -> ${pack.puzzles.length} total in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
