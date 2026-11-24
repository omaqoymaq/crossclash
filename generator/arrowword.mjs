// CrossClash arrowword generator.
//
// Standalone and dependency-free: runs in Node (see cli.mjs) or in a browser.
// Produces "arrowword" (Scandinavian-style) grids where clues live inside grid
// squares and point with an arrow to the word they describe, tuned for
// CrossClash's tile-duel rules (see docs/RULES.md):
//
//  * every letter square belongs to at least one clued word, so every tile a
//    player draws has a findable home;
//  * a few starter letters are revealed so both players have a foothold;
//  * rare letters (J, Q, X, Z) are capped so racks stay playable;
//  * no word repeats inside a puzzle, and the CLI spreads words across a pack.
//
// Arrow kinds (clue square -> first letter of the word):
//   right      clue square is left of the word, word runs right
//   down       clue square is above the word, word runs down
//   downRight  clue square is above the word's first letter, word runs right
//   rightDown  clue square is left of the word's first letter, word runs down

export const SIZES = {
  regular: { w: 9, h: 9, maxLen: 7, label: 'Regular' },
  large: { w: 11, h: 12, maxLen: 6, label: 'Large' },
  xl: { w: 13, h: 15, maxLen: 6, label: 'ExtraLarge' },
};

const RARE = new Set(['J', 'Q', 'X', 'Z']);

// ---------------------------------------------------------------- utilities
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  // FNV-1a 32-bit, hex
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

// ---------------------------------------------------------------- word index
/**
 * Prepares a lexicon ({ WORD: { f, c: [clues] } }) for fast pattern lookups.
 * Reuse the returned index across many generatePuzzle calls.
 */
export function buildIndex(lexiconWords, { minLen = 2, maxLen = 10, handOnly = false } = {}) {
  const byLen = new Map();
  for (const [word, entry] of Object.entries(lexiconWords)) {
    if (!/^[A-Z]+$/.test(word) || word.length < minLen || word.length > maxLen) continue;
    if (!entry.c || !entry.c.length) continue;
    if (handOnly && !entry.hand) continue;
    if (word.length > 2 && !/[AEIOUY]/.test(word)) continue; // skip abbreviations
    if (!byLen.has(word.length)) byLen.set(word.length, []);
    byLen.get(word.length).push(word);
  }
  const index = new Map();
  for (const [len, words] of byLen) {
    words.sort();
    const nWords32 = Math.ceil(words.length / 32);
    // bits[pos][letter] -> Uint32Array bitset over words
    const bits = [];
    for (let p = 0; p < len; p++) {
      const row = [];
      for (let l = 0; l < 26; l++) row.push(new Uint32Array(nWords32));
      bits.push(row);
    }
    words.forEach((w, i) => {
      for (let p = 0; p < len; p++) bits[p][w.charCodeAt(p) - 65][i >>> 5] |= 1 << (i & 31);
    });
    const freq = words.map((w) => lexiconWords[w].f || 0);
    const hand = words.map((w) => !!lexiconWords[w].hand);
    index.set(len, { words, bits, nWords32, freq, hand });
  }
  const allowed = new Set([...byLen.values()].flat());
  return { index, lexicon: lexiconWords, allowed };
}

/** Returns a bitset of words of length len that match pattern (array of letters or null). */
function matchSet(entry, pattern) {
  const out = new Uint32Array(entry.nWords32).fill(0xffffffff);
  const extra = entry.words.length & 31;
  if (extra) out[entry.nWords32 - 1] = (1 << extra) - 1 >>> 0;
  for (let p = 0; p < pattern.length; p++) {
    const ch = pattern[p];
    if (!ch) continue;
    const b = entry.bits[p][ch.charCodeAt(0) - 65];
    for (let k = 0; k < out.length; k++) out[k] &= b[k];
  }
  return out;
}

function countSet(set) {
  let n = 0;
  for (let k = 0; k < set.length; k++) if (set[k]) n += popcount(set[k]);
  return n;
}

function listSet(set) {
  const res = [];
  for (let k = 0; k < set.length; k++) {
    let v = set[k];
    while (v) {
      const t = v & -v;
      res.push((k << 5) + (31 - Math.clz32(t)));
      v ^= t;
    }
  }
  return res;
}

// ---------------------------------------------------------------- template
/**
 * Builds a random arrowword layout. cells[r][c] is true for a clue square.
 * Border pattern: clue squares on even columns of row 0 and even rows of
 * column 0; interior clue squares split runs into words of length 2..maxLen.
 */
export function makeTemplate(w, h, maxLen, rand) {
  const clue = Array.from({ length: h }, () => new Array(w).fill(false));
  for (let c = 0; c < w; c += 2) clue[0][c] = true;
  for (let r = 0; r < h; r += 2) clue[r][0] = true;

  // Break long runs with interior clue squares. Alternate across/down passes.
  const target = () => 3 + Math.floor(rand() * (maxLen - 2)); // preferred word length
  for (let pass = 0; pass < 6; pass++) {
    // across runs
    for (let r = 1; r < h; r++) {
      let c = 0;
      while (c < w) {
        if (clue[r][c]) { c++; continue; }
        let e = c;
        while (e < w && !clue[r][e]) e++;
        const len = e - c;
        if (len > maxLen || (len > 4 && rand() < 0.25)) {
          const cut = c + Math.min(len - 3, Math.max(2, target()));
          if (cut > c + 1 && cut < e - (len > maxLen ? 1 : 3) && canPlace(clue, r, cut, w, h)) clue[r][cut] = true;
        }
        c = e;
      }
    }
    // down runs
    for (let c = 1; c < w; c++) {
      let r = 0;
      while (r < h) {
        if (clue[r][c]) { r++; continue; }
        let e = r;
        while (e < h && !clue[e][c]) e++;
        const len = e - r;
        if (len > maxLen || (len > 4 && rand() < 0.25)) {
          const cut = r + Math.min(len - 3, Math.max(2, target()));
          if (cut > r + 1 && cut < e - (len > maxLen ? 1 : 3) && canPlace(clue, cut, c, w, h)) clue[cut][c] = true;
        }
        r = e;
      }
    }
  }
  return clue;
}

function canPlace(clue, r, c, w, h) {
  if (r < 1 || c < 1) return false;
  // avoid clumps: no orthogonally adjacent interior clue squares
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 1 && cc >= 1 && rr < h && cc < w && clue[rr][cc]) return false;
  }
  return true;
}

/** Extracts word slots and assigns each to a clue square. Returns null if the layout is invalid. */
export function analyse(clue, w, h, maxLen) {
  const slots = [];
  const inWord = Array.from({ length: h }, () => new Array(w).fill(0));
  const addRuns = (dir) => {
    const outer = dir === 'across' ? h : w;
    const inner = dir === 'across' ? w : h;
    for (let a = 0; a < outer; a++) {
      let b = 0;
      while (b < inner) {
        const [r0, c0] = dir === 'across' ? [a, b] : [b, a];
        if (clue[r0][c0]) { b++; continue; }
        let e = b;
        while (e < inner && !(dir === 'across' ? clue[a][e] : clue[e][a])) e++;
        const len = e - b;
        if (len >= 2) {
          if (len > maxLen) return false;
          const cells = [];
          for (let k = b; k < e; k++) cells.push(dir === 'across' ? [a, k] : [k, a]);
          cells.forEach(([r, c]) => inWord[r][c]++);
          slots.push({ dir, len, cells, start: cells[0] });
        }
        b = e;
      }
    }
    return true;
  };
  if (!addRuns('across') || !addRuns('down')) return null;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (!clue[r][c] && !inWord[r][c]) return null;

  // candidate clue squares for each slot
  const isClue = (r, c) => r >= 0 && c >= 0 && r < h && c < w && clue[r][c];
  for (const s of slots) {
    const [r, c] = s.start;
    s.options = [];
    if (s.dir === 'across') {
      if (isClue(r, c - 1)) s.options.push({ at: [r, c - 1], arrow: 'right' });
      if (isClue(r - 1, c)) s.options.push({ at: [r - 1, c], arrow: 'downRight' });
    } else {
      if (isClue(r - 1, c)) s.options.push({ at: [r - 1, c], arrow: 'down' });
      if (isClue(r, c - 1)) s.options.push({ at: [r, c - 1], arrow: 'rightDown' });
    }
    if (!s.options.length) return null;
  }
  // bipartite matching, each clue square holds at most 2 clues (Kuhn's algorithm)
  const owner = new Map(); // "r,c#k" -> slot index
  const keyOf = (o, k) => `${o.at[0]},${o.at[1]}#${k}`;
  const tryAssign = (si, seen) => {
    for (const o of slots[si].options) {
      for (let k = 0; k < 2; k++) {
        const key = keyOf(o, k);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!owner.has(key) || tryAssign(owner.get(key), seen)) {
          owner.set(key, si);
          slots[si].clueAt = o.at;
          slots[si].arrow = o.arrow;
          return true;
        }
      }
    }
    return false;
  };
  // prefer straight arrows: they are easier to read
  slots.forEach((s) => s.options.sort((a, b) => (a.arrow === 'right' || a.arrow === 'down' ? 0 : 1) - (b.arrow === 'right' || b.arrow === 'down' ? 0 : 1)));
  for (let i = 0; i < slots.length; i++) if (!tryAssign(i, new Set())) return null;
  // recompute final assignment from owner map (augmenting paths may have moved slots)
  for (const [key, si] of owner) {
    const [rc] = key.split('#');
    const at = rc.split(',').map(Number);
    const s = slots[si];
    const o = s.options.find((x) => x.at[0] === at[0] && x.at[1] === at[1]);
    s.clueAt = o.at;
    s.arrow = o.arrow;
  }
  // every clue square should carry at least one clue (except the corner, which may be decorative)
  const used = new Set(slots.map((s) => `${s.clueAt[0]},${s.clueAt[1]}`));
  let empty = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (clue[r][c] && !used.has(`${r},${c}`)) empty++;
  return { slots, emptyClueSquares: empty };
}

// ---------------------------------------------------------------- fill
function fill(slots, w, h, idx, rand, opts) {
  const grid = Array.from({ length: h }, () => new Array(w).fill(null));
  const cellSlots = new Map(); // "r,c" -> [{si, pos}]
  slots.forEach((s, si) => s.cells.forEach(([r, c], pos) => {
    const k = r * w + c;
    if (!cellSlots.has(k)) cellSlots.set(k, []);
    cellSlots.get(k).push({ si, pos });
  }));
  const assigned = new Array(slots.length).fill(null);
  const usedWords = new Set();
  let nodes = 0;
  const avoid = opts.avoid || new Map();

  const pattern = (s) => s.cells.map(([r, c]) => grid[r][c]);
  const candidates = (s) => {
    const entry = idx.index.get(s.len);
    if (!entry) return null;
    return matchSet(entry, pattern(s));
  };

  const order = (s, set) => {
    const entry = idx.index.get(s.len);
    const ids = listSet(set);
    // weighted random order: common words first, previously used words last
    const scored = ids.map((i) => {
      const word = entry.words[i];
      const f = entry.freq[i];
      const penalty = avoid.get(word) || 0;
      // prefer common words and words with hand-written clues
      return { word, key: Math.log2(2 + f) * 0.6 + rand() * 2.2 - penalty * 0.6 - (word.length === 2 ? 1 : 0) + (entry.hand[i] ? 3 : 0) };
    });
    scored.sort((a, b) => b.key - a.key);
    return scored.slice(0, opts.branch || 24).map((x) => x.word);
  };

  const solve = () => {
    if (++nodes > opts.maxNodes) return false;
    // choose unassigned slot with fewest candidates (MRV)
    let best = -1, bestSet = null, bestCount = Infinity;
    for (let si = 0; si < slots.length; si++) {
      if (assigned[si]) continue;
      const set = candidates(slots[si]);
      if (!set) return false;
      const n = countSet(set);
      if (n === 0) return false;
      if (n < bestCount) { best = si; bestSet = set; bestCount = n; }
      if (n === 1) break;
    }
    if (best < 0) return true;
    const s = slots[best];
    for (const word of order(s, bestSet)) {
      if (usedWords.has(word)) continue;
      if (opts.rareLimit != null) {
        let rare = 0;
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (grid[r][c] && RARE.has(grid[r][c])) rare++;
        const add = s.cells.reduce((n, [r, c], p) => n + (!grid[r][c] && RARE.has(word[p]) ? 1 : 0), 0);
        if (rare + add > opts.rareLimit) continue;
      }
      const placed = [];
      s.cells.forEach(([r, c], p) => { if (!grid[r][c]) { grid[r][c] = word[p]; placed.push([r, c]); } });
      assigned[best] = word;
      usedWords.add(word);
      // auto-assign crossing slots that became complete, checking validity & uniqueness
      const completed = [];
      let ok = true;
      for (const [r, c] of placed) {
        for (const { si } of cellSlots.get(r * w + c)) {
          if (assigned[si]) continue;
          const pat = pattern(slots[si]);
          if (pat.every(Boolean)) {
            const wd = pat.join('');
            const entry = idx.index.get(wd.length);
            if (!entry || usedWords.has(wd) || !idx.allowed.has(wd)) { ok = false; break; }
            assigned[si] = wd; usedWords.add(wd); completed.push(si);
          }
        }
        if (!ok) break;
      }
      if (ok && solve()) return true;
      for (const si of completed) { usedWords.delete(assigned[si]); assigned[si] = null; }
      usedWords.delete(word);
      assigned[best] = null;
      for (const [r, c] of placed) grid[r][c] = null;
      if (nodes > opts.maxNodes) return false;
    }
    return false;
  };
  const ok = solve();
  return ok ? { grid, words: assigned, nodes } : null;
}

// ---------------------------------------------------------------- puzzle
/**
 * Generates one puzzle.
 * @param {object} args
 * @param {'regular'|'large'|'xl'} args.size
 * @param {{index:Map, lexicon:object}} args.index  from buildIndex()
 * @param {number} [args.seed]
 * @param {Map<string,number>} [args.avoid]  word -> how strongly to avoid (reuse across a pack)
 * @returns {object|null} puzzle with solution (see docs/PUZZLE-FORMAT.md)
 */
export function generatePuzzle({ size = 'regular', index, seed = Date.now(), avoid, maxTemplates = 600, maxNodes = 1500 }) {
  const spec = SIZES[size];
  if (!spec) throw new Error(`unknown size ${size}`);
  const rand = mulberry32(seed);
  const { w, h, maxLen } = spec;
  for (let attempt = 0; attempt < maxTemplates; attempt++) {
    const clue = makeTemplate(w, h, maxLen, rand);
    const layout = analyse(clue, w, h, maxLen);
    if (!layout || layout.emptyClueSquares > 1) continue;
    const { slots } = layout;
    const letters = slots.length && clue.flat().filter((x) => !x).length;
    if (letters < w * h * 0.55) continue;
    const res = fill(slots, w, h, index, rand, { maxNodes, avoid, rareLimit: Math.max(2, Math.round(letters / 30)) });
    if (!res) continue;
    return finalize({ size, spec, clue, slots, res, rand, index, seed, attempt });
  }
  return null;
}

function finalize({ size, spec, clue, slots, res, rand, index, seed, attempt }) {
  const { w, h } = spec;
  const rows = [];
  for (let r = 0; r < h; r++) {
    let line = '';
    for (let c = 0; c < w; c++) line += clue[r][c] ? '#' : res.grid[r][c];
    rows.push(line);
  }
  const clues = slots.map((s, i) => {
    const answer = res.words[i];
    const options = index.lexicon[answer].c;
    return {
      id: i,
      at: s.clueAt,
      arrow: s.arrow,
      dir: s.dir,
      start: s.start,
      len: s.len,
      answer,
      text: options[Math.floor(rand() * options.length)],
    };
  });
  // order clues inside each square: the first listed goes in the top half
  clues.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || (a.dir === 'across' ? -1 : 1));
  clues.forEach((c, i) => { c.id = i; });

  // starter letters: one letter in roughly every third long word, spread out,
  // never completing a word on its own.
  const revealed = new Set();
  const longWords = shuffle(clues.filter((c) => c.len >= 4), rand);
  const want = Math.max(3, Math.round(clues.length / 4));
  for (const c of longWords) {
    if (revealed.size >= want) break;
    const cells = cellsOf(c);
    const p = 1 + Math.floor(rand() * (c.len - 2));
    const [r, cc] = cells[p];
    const k = `${r},${cc}`;
    const near = [...revealed].some((x) => { const [a, b] = x.split(',').map(Number); return Math.abs(a - r) + Math.abs(b - cc) < 2; });
    if (!near) revealed.add(k);
  }
  const bag = {};
  let letterCount = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    if (clue[r][c] || revealed.has(`${r},${c}`)) continue;
    const ch = res.grid[r][c];
    bag[ch] = (bag[ch] || 0) + 1;
    letterCount++;
  }
  const solution = rows.join('');
  return {
    id: `${size[0].toUpperCase()}${hashString(solution)}`,
    size,
    w,
    h,
    rows,
    clues,
    revealed: [...revealed].map((k) => k.split(',').map(Number)),
    stats: { words: clues.length, tiles: letterCount, bag, seed, templateAttempts: attempt + 1, fillNodes: res.nodes },
  };
}

export function cellsOf(clue) {
  const [r, c] = clue.start;
  return Array.from({ length: clue.len }, (_, k) => (clue.dir === 'across' ? [r, c + k] : [r + k, c]));
}

/** Strips answers so the puzzle can be sent to players. */
export function publicView(p) {
  const revealed = new Set(p.revealed.map(([r, c]) => `${r},${c}`));
  return {
    id: p.id, size: p.size, w: p.w, h: p.h,
    rows: p.rows.map((row, r) => [...row].map((ch, c) => (ch === '#' ? '#' : revealed.has(`${r},${c}`) ? ch : '.')).join('')),
    clues: p.clues.map(({ answer, ...rest }) => rest),
    revealed: p.revealed,
  };
}

/** Sanity checks a generated puzzle against a lexicon; returns list of problems. */
export function validatePuzzle(p, lexicon) {
  const problems = [];
  const seen = new Set();
  for (const c of p.clues) {
    const word = cellsOf(c).map(([r, cc]) => p.rows[r][cc]).join('');
    if (word !== c.answer) problems.push(`clue ${c.id}: grid spells ${word}, answer ${c.answer}`);
    if (!lexicon[word]) problems.push(`clue ${c.id}: ${word} not in lexicon`);
    if (seen.has(word)) problems.push(`duplicate word ${word}`);
    seen.add(word);
    const [ar, ac] = c.at;
    if (p.rows[ar][ac] !== '#') problems.push(`clue ${c.id}: clue square ${ar},${ac} is not a clue square`);
  }
  const perSquare = {};
  for (const c of p.clues) { const k = c.at.join(','); perSquare[k] = (perSquare[k] || 0) + 1; }
  for (const [k, n] of Object.entries(perSquare)) if (n > 2) problems.push(`square ${k} holds ${n} clues`);
  const covered = new Set();
  for (const c of p.clues) for (const [r, cc] of cellsOf(c)) covered.add(`${r},${cc}`);
  for (let r = 0; r < p.h; r++) for (let cc = 0; cc < p.w; cc++) {
    if (p.rows[r][cc] !== '#' && !covered.has(`${r},${cc}`)) problems.push(`cell ${r},${cc} not in any word`);
  }
  return problems;
}
