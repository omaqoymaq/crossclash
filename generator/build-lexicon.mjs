#!/usr/bin/env node
// Builds generator/data/lexicon.json (answer words + short clues) from the
// WordNet 3.0 database (Princeton WordNet license, see generator/data/WORDNET-LICENSE).
//
// Usage: node generator/build-lexicon.mjs [path/to/wordnet/dict]
//
// Output format: { "version": 1, "words": { "WORD": { "f": freq, "c": ["Clue", ...] } } }
// Hand-written words/clues in generator/data/custom-words.json are merged on top
// (they win over WordNet), and generator/data/blocklist.txt removes words.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let dictDir = process.argv[2];
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

// --- 4. overrides ----------------------------------------------------------------
const customPath = path.join(here, 'data', 'custom-words.json');
if (fs.existsSync(customPath)) {
  const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
  for (const [w, v] of Object.entries(custom)) {
    if (w.startsWith('_')) continue;
    words[w.toUpperCase()] = { f: v.f ?? 50, c: v.c };
  }
}
const blockPath = path.join(here, 'data', 'blocklist.txt');
if (fs.existsSync(blockPath)) {
  for (const w of fs.readFileSync(blockPath, 'utf8').split(/\s+/)) {
    if (w && !w.startsWith('#')) delete words[w.toUpperCase()];
  }
}

const out = { version: 1, source: 'WordNet 3.0 (Princeton) + CrossClash custom words', words };
const outPath = path.join(here, 'data', 'lexicon.json');
fs.writeFileSync(outPath, JSON.stringify(out));
const byLen = {};
for (const w of Object.keys(words)) byLen[w.length] = (byLen[w.length] || 0) + 1;
console.log(`lexicon: ${Object.keys(words).length} words (${flagged} flagged as offensive) -> ${path.relative(process.cwd(), outPath)}`);
console.log('by length:', byLen);
