#!/usr/bin/env node
// Builds generator/data/lexicon.json, the answer words and clues the generator uses.
//
//   node generator/build-lexicon.mjs [--top 4500] [path/to/wordnet/dict]
//
// Answer words: the most common English words (generator/data/common-words.txt,
// from wordfreq) that are real dictionary words in WordNet 3.0 or regular
// forms of one (plurals, -ed, -ing...). Names, abbreviations and anything
// WordNet marks as offensive are left out, as is generator/data/blocklist.txt.
//
// Clues: hand-written clues in generator/data/clues/*.txt (and the short words in
// custom-words.json) always win. Words without one get an automatic clue from
// WordNet and are marked "auto"; the puzzle CLI only uses them with --allow-auto.
// To grow the vocabulary, add lines to a file in generator/data/clues/.
//
// Output: { version: 2, words: { WORD: { f, c: [clues], hand?: true, auto?: true } } }

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const topIdx = argv.indexOf('--top');
const TOP_N = topIdx >= 0 ? Number(argv.splice(topIdx, 2)[1]) : 12000;
let dictDir = argv[0];
if (!dictDir) {
  dictDir = path.join(path.dirname(require.resolve('wordnet-db/package.json')), 'dict');
}

const POS_FILES = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };
const MIN_LEN = 3;
const MAX_LEN = 10;
// minimum total sense-tagged count across senses, by word length. Short words
// are scarce and mostly familiar, so they are allowed with zero tagged uses.
const minFreq = (len) => (len <= 4 ? 0 : len <= 6 ? 1 : 2);

const BAD_GLOSS = /\b(slur|offensive|vulgar|obscene|disparaging|derogatory|pejorative|contemptuous|sexual intercourse|genitals?|penis|vagina|testicles?|feces|excrement)\b/i;

// --- 1. read synsets -------------------------------------------------------
/** offset+pos -> { words: [{form, lower}], gloss, hypernyms: [key], bad } */
const synsets = new Map();
for (const [pos, file] of Object.entries(POS_FILES)) {
  const text = fs.readFileSync(path.join(dictDir, `data.${file}`), 'utf8');
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const bar = line.indexOf(' | ');
    const head = (bar >= 0 ? line.slice(0, bar) : line).trim().split(/\s+/);
    const gloss = bar >= 0 ? line.slice(bar + 3).trim() : '';
    const offset = head[0];
    const ssType = head[2];
    const wCnt = parseInt(head[3], 16);
    const words = [];
    let i = 4;
    for (let k = 0; k < wCnt; k++, i += 2) {
      const form = head[i].replace(/\(.*\)$/, ''); // strip adj markers like (a)
      words.push({ form, lower: form.toLowerCase() });
    }
    const pCnt = parseInt(head[i], 10);
    i++;
    const hypernyms = [];
    let usageFlag = false;
    for (let k = 0; k < pCnt; k++, i += 4) {
      const sym = head[i];
      const tOff = head[i + 1];
      const tPos = head[i + 2] === 's' ? 'a' : head[i + 2];
      if (sym === '@' || sym === '@i') hypernyms.push(tOff + tPos);
      if (sym === ';u') usageFlag = true; // domain of usage (often "obscenity", "ethnic slur", ...)
    }
    const posKey = ssType === 's' ? 'a' : ssType;
    synsets.set(offset + posKey, { words, gloss, hypernyms, bad: BAD_GLOSS.test(gloss), usageFlag, pos: posKey });
  }
}

// usage-domain synsets themselves (to recognise "obscenity", "ethnic slur" etc.)
// are flagged through their gloss already; usageFlag alone is too broad (it includes "colloquialism").

// --- 2. read sense index for frequency ----------------------------------------
/** lemma -> [{key, tag}] sorted by tag desc */
const senses = new Map();
/** any lemma (incl. multiword) -> total tag count, used to rank clue candidates */
const lemmaFreq = new Map();
const senseText = fs.readFileSync(path.join(dictDir, 'index.sense'), 'utf8');
const SS_TYPE = { 1: 'n', 2: 'v', 3: 'a', 4: 'r', 5: 'a' };
for (const line of senseText.split('\n')) {
  if (!line) continue;
  const [senseKey, offset, , tagCnt] = line.split(' ');
  const pct = senseKey.indexOf('%');
  const lemma = senseKey.slice(0, pct);
  const ssType = SS_TYPE[senseKey[pct + 1]];
  lemmaFreq.set(lemma, (lemmaFreq.get(lemma) || 0) + (parseInt(tagCnt, 10) || 0));
  if (!/^[a-z]+$/.test(lemma)) continue;
  if (lemma.length < MIN_LEN || lemma.length > MAX_LEN) continue;
  const key = offset + ssType;
  if (!synsets.has(key)) continue;
  if (!senses.has(lemma)) senses.set(lemma, []);
  senses.get(lemma).push({ key, tag: parseInt(tagCnt, 10) || 0 });
}

// --- 3. build clues ---------------------------------------------------------------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function related(answer, clue) {
  const a = answer.toLowerCase();
  const c = clue.toLowerCase();
  if (c.includes(a) || a.includes(c.replace(/[^a-z]/g, ''))) return true;
  const stem = a.slice(0, Math.min(4, a.length));
  return c.split(/[^a-z]+/).some((w) => w.length >= 3 && (w.startsWith(stem) || a.startsWith(w.slice(0, 4)) && w.length >= 4));
}

function shortGloss(gloss) {
  let g = gloss.replace(/"[^"]*"/g, '').replace(/\([^)]*\)/g, '').split(';')[0].trim();
  g = g.replace(/^(a|an|the) /i, '').replace(/\s+/g, ' ').replace(/[,:]$/, '');
  return g;
}

const words = {};
const plurals = [];
let flagged = 0;
for (const [lemma, list] of senses) {
  list.sort((x, y) => y.tag - x.tag);
  const freq = list.reduce((s, x) => s + x.tag, 0);
  if (freq < minFreq(lemma.length)) continue;
  // reject if any sense is offensive, or the lemma only exists as a proper noun
  let lowerSeen = false;
  let bad = false;
  for (const s of list) {
    const ss = synsets.get(s.key);
    if (ss.bad) bad = true;
    if (ss.words.some((w) => w.lower === lemma && w.form === lemma)) lowerSeen = true;
  }
  if (bad) { flagged++; continue; }
  if (!lowerSeen) continue;
  // drop acronyms such as "bpi" (bits per inch)
  const acronym = list.some((s) => synsets.get(s.key).words.some((w) => w.form.includes('_') && w.form.split(/[_-]/).map((x) => x[0]).join('').toLowerCase() === lemma));
  if (acronym) continue;

  const cands = new Map(); // text -> score
  const push = (raw, score) => {
    const c = raw.replace(/_/g, ' ').trim();
    if (!c || c.length > 22 || /[^A-Za-z '\-]/.test(c)) return;
    if (/[A-Z]/.test(c)) return; // proper names make poor clues
    if (related(lemma, c)) return;
    const C = cap(c);
    if ((cands.get(C) ?? -1) < score) cands.set(C, score);
  };
  const fq = (form) => lemmaFreq.get(form.toLowerCase()) || 0;
  // A: synonyms from the most frequent senses (common synonyms first)
  list.slice(0, 4).forEach((s, idx) => {
    for (const w of synsets.get(s.key).words) {
      if (w.lower === lemma) continue;
      const f = fq(w.form);
      if (f === 0 && idx > 0) continue;
      push(w.form, 100 - idx * 20 + Math.min(f, 60) + (w.form.includes('_') ? -15 : 0));
    }
  });
  // B: hypernym of the top noun sense ("oak" -> "Tree")
  const top = list.find((s) => synsets.get(s.key).pos === 'n');
  if (top) {
    for (const h of synsets.get(top.key).hypernyms) {
      const hs = synsets.get(h);
      if (hs) for (const w of hs.words.slice(0, 2)) {
        if (fq(w.form) === 0 && w.form.length > 9) continue; // obscure taxonomy terms
        push(w.form, 40 + Math.min(fq(w.form), 40));
      }
    }
  }
  // C: short gloss of the top sense
  const g = shortGloss(synsets.get(list[0].key).gloss);
  if (g.length <= 22) push(g, 30);
  const clues = [...cands.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 3);
  if (!clues.length) continue;
  words[lemma.toUpperCase()] = { f: freq, c: clues };
  // regular plurals of common nouns, clued with the (regular) plural of a noun synonym
  const nounSense = list[0] && synsets.get(list[0].key).pos === 'n';
  if (nounSense && freq >= 2 && lemma.length < MAX_LEN && /[^sxzhy]$/.test(lemma)) {
    const pl = clues.filter((c) => /^[A-Za-z]+$/.test(c) && /[^sxzhy]$/.test(c) && !/(man|ics|ese)$/.test(c)).map((c) => c + 's');
    if (pl.length) plurals.push([lemma.toUpperCase() + 'S', { f: Math.max(1, freq >> 1), c: pl }]);
  }
}

for (const [w, v] of plurals) if (!words[w]) words[w] = v;

// lemmas WordNet marks as offensive anywhere
const badLemmas = new Set();
for (const [lemma, list] of senses) if (list.some((x) => synsets.get(x.key).bad)) badLemmas.add(lemma);
const lowerLemma = (w) => senses.has(w) && senses.get(w).some((x) => synsets.get(x.key).words.some((f) => f.form === w));

// --- 4. common words -------------------------------------------------------------
const blocked = new Set();
const blockPath = path.join(here, 'data', 'blocklist.txt');
if (fs.existsSync(blockPath)) {
  for (const line of fs.readFileSync(blockPath, 'utf8').split('\n')) {
    if (line.startsWith('#')) continue;
    for (const w of line.split(/\s+/)) if (w) blocked.add(w.toLowerCase());
  }
}
function baseOf(w) {
  if (lowerLemma(w)) return w;
  const rules = [['ies', 'y'], ['es', ''], ['s', ''], ['ied', 'y'], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e'], ['er', ''], ['er', 'e'], ['est', ''], ['est', 'e'], ['ier', 'y'], ['iest', 'y']];
  for (const [suf, rep] of rules) {
    if (!w.endsWith(suf)) continue;
    const b = w.slice(0, -suf.length) + rep;
    if (b.length >= 3 && lowerLemma(b)) return b;
    if ((suf === 'ed' || suf === 'ing' || suf === 'er' || suf === 'est') && b.length > 3 && b.at(-1) === b.at(-2) && lowerLemma(b.slice(0, -1))) return b.slice(0, -1);
  }
  return null;
}
// hand-written clues: generator/data/clues/*.txt, one "WORD|Clue|Another clue" per line
const hand = {};
const clueDir = path.join(here, 'data', 'clues');
for (const f of fs.existsSync(clueDir) ? fs.readdirSync(clueDir).filter((x) => x.endsWith('.txt')).sort() : []) {
  for (const line of fs.readFileSync(path.join(clueDir, f), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [w, ...c] = t.split('|').map((x) => x.trim());
    if (w && c.length) { const W = w.toUpperCase(); hand[W] = [...new Set([...(hand[W] || []), ...c.filter(Boolean)])]; }
  }
}
const final = {};
let rank = 0;
for (const line of fs.readFileSync(path.join(here, 'data', 'common-words.txt'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [w, z] = line.split('\t');
  if (w.length < 3 || w.length > 10 || !/[aeiouy]/.test(w) || blocked.has(w)) continue;
  const base = baseOf(w);
  if (!base || badLemmas.has(base) || badLemmas.has(w) || blocked.has(base)) continue;
  const W = w.toUpperCase();
  const f = Math.round(2 ** Number(z));
  if (hand[W]) final[W] = { f, c: hand[W], hand: true };
  else if (words[W]) final[W] = { f, c: words[W].c, auto: true };
  else final[W] = { f, c: [`Form of "${base}"`], auto: true };
  if (++rank >= TOP_N) break;
}
// hand-clued words outside the top list are kept too
for (const [W, c] of Object.entries(hand)) {
  if (W.startsWith('_') || final[W] || blocked.has(W.toLowerCase())) continue;
  final[W] = { f: 30, c, hand: true };
}
const customPath = path.join(here, 'data', 'custom-words.json');
if (fs.existsSync(customPath)) {
  const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
  for (const [w, v] of Object.entries(custom)) {
    if (w.startsWith('_')) continue;
    const W = w.toUpperCase();
    final[W] = { f: v.f ?? 50, c: [...new Set([...v.c, ...(hand[W] || [])])], hand: true };
  }
}

const out = { version: 2, source: 'wordfreq common words + WordNet 3.0 (Princeton) + CrossClash hand-written clues', words: final };
const outPath = path.join(here, 'data', 'lexicon.json');
fs.writeFileSync(outPath, JSON.stringify(out));
const byLen = {};
for (const w of Object.keys(final)) byLen[w.length] = (byLen[w.length] || 0) + 1;
const nHand = Object.values(final).filter((x) => x.hand).length;
console.log(`lexicon: ${Object.keys(final).length} words, ${nHand} with hand-written clues -> ${path.relative(process.cwd(), outPath)}`);
console.log('by length:', byLen);
