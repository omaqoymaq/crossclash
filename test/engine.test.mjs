import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newGame, submit, swap, tick, viewFor, HAND_SIZE, cellsOfClue } from '../public/js/engine.js';
import { botTurn } from '../public/js/bot.js';

const pack = JSON.parse(fs.readFileSync(new URL('../puzzles/regular.json', import.meta.url)));
const puzzle = pack.puzzles[0];
const players = [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'bot', level: 'hard' }];

function homes(state, p, max = HAND_SIZE) {
  const { w } = state.puzzle;
  const out = [], usedI = new Set();
  for (let k = 0; k < state.owner.length && out.length < max; k++) {
    if (state.owner[k] !== -1) continue;
    const r = Math.floor(k / w), c = k % w;
    const i = state.players[p].rack.findIndex((l, idx) => !usedI.has(idx) && l === state.puzzle.rows[r][c]);
    if (i >= 0) { usedI.add(i); out.push({ i, r, c }); }
  }
  return out;
}
function wrongSpot(state, p, avoidI = new Set(), avoidCells = new Set()) {
  const { w } = state.puzzle;
  for (let k = 0; k < state.owner.length; k++) {
    if (state.owner[k] !== -1 || avoidCells.has(k)) continue;
    const r = Math.floor(k / w), c = k % w;
    const i = state.players[p].rack.findIndex((l, idx) => !avoidI.has(idx) && l !== state.puzzle.rows[r][c]);
    if (i >= 0) return { i, r, c };
  }
}

test('every turn starts with exactly 5 tiles and the bag holds only missing letters', () => {
  const s = newGame(puzzle, players, { seed: 1 });
  const empty = s.owner.filter((o) => o === -1).length;
  assert.equal(s.bag.length + s.players[0].rack.length + s.players[1].rack.length, empty);
  for (let t = 0; t < 6; t++) {
    assert.equal(s.players[s.turn].rack.length, HAND_SIZE);
    const h = homes(s, s.turn, 2);
    submit(s, s.turn, h);
  }
});

test('submit scores +1 right, -1 wrong, wrong tiles return to the hand', () => {
  const s = newGame(puzzle, players, { seed: 2 });
  const p = s.turn;
  const [right] = homes(s, p, 1);
  const wrong = wrongSpot(s, p, new Set([right.i]), new Set([right.r * s.puzzle.w + right.c]));
  const wrongLetter = s.players[p].rack[wrong.i];
  const res = submit(s, p, [right, wrong]);
  assert.ok(res.ok);
  assert.equal(res.breakdown.letters, 1);
  assert.equal(res.breakdown.wrong, -1);
  assert.equal(s.players[p].rack.length, HAND_SIZE - 1);
  assert.ok(s.players[p].rack.includes(wrongLetter));
  assert.equal(s.board[wrong.r * s.puzzle.w + wrong.c], '');
  assert.equal(s.turn, 1 - p);
  assert.equal(submit(s, p, []).ok, false, 'not your turn');
});

test('completing a word gives +1 per word plus its letters; 5 right gives +5', () => {
  // fill a short word by hand: give player the exact letters it needs
  const s = newGame(puzzle, players, { seed: 3 });
  const p = s.turn;
  const { w } = s.puzzle;
  const cl = s.puzzle.clues.find((c) => c.len <= 5 && cellsOfClue(c).filter(([a, b]) => s.owner[a * w + b] === -1).length >= 2);
  const open = cellsOfClue(cl).filter(([a, b]) => s.owner[a * w + b] === -1);
  // rig the hand (test only)
  const need = open.map(([a, b]) => s.puzzle.rows[a][b]);
  s.players[p].rack = need.concat(s.players[p].rack).slice(0, HAND_SIZE);
  const placements = open.map(([r, c], i) => ({ i, r, c }));
  const res = submit(s, p, placements);
  assert.ok(res.breakdown.words >= 1);
  assert.ok(res.breakdown.wordLetters >= cl.len);
  assert.equal(res.points, res.breakdown.letters + res.breakdown.words + res.breakdown.wordLetters + res.breakdown.fullHand);
  // full hand
  const s2 = newGame(puzzle, players, { seed: 4 });
  const q = s2.turn;
  const all = homes(s2, q, 5);
  if (all.length === 5) assert.equal(submit(s2, q, all).breakdown.fullHand, 5);
});

test('bad submissions are rejected', () => {
  const s = newGame(puzzle, players, { seed: 5 });
  const p = s.turn;
  assert.equal(submit(s, p, [{ i: 0, r: 0, c: 0 }]).ok, false); // clue square
  assert.equal(submit(s, p, [{ i: 9, r: 1, c: 1 }]).ok, false);
  const [a] = homes(s, p, 1);
  assert.equal(submit(s, p, [a, { ...a }]).ok, false); // same tile twice
});

test('view hides the solution and the opponent hand', () => {
  const s = newGame(puzzle, players, { seed: 6 });
  const v = viewFor(s, 0);
  assert.equal(v.puzzle.solution, null);
  assert.equal(v.players[1].rack, null);
  assert.ok(v.puzzle.clues.every((c) => !('answer' in c)));
});

test('timer: off means no deadline; timeout passes the turn after the grace period', () => {
  const off = newGame(puzzle, players, { seed: 7, turnSeconds: 0 });
  assert.equal(off.deadline, null);
  assert.equal(tick(off, Date.now() + 1e9), false);
  const s = newGame(puzzle, players, { seed: 7, turnSeconds: 30, now: 1000 });
  const p = s.turn;
  assert.equal(s.deadline, 31000);
  assert.equal(tick(s, 31500, 1500), false);
  assert.ok(tick(s, 32600, 1500));
  assert.equal(s.turn, 1 - p);
  assert.ok(swap(s, s.turn).ok);
});

test('perfect players fill the grid; bots finish at every level', () => {
  const s = newGame(puzzle, players, { seed: 8 });
  let guard = 0;
  while (s.status === 'playing' && guard++ < 2000) submit(s, s.turn, homes(s, s.turn));
  assert.equal(s.endReason, 'complete');
  for (const level of ['easy', 'medium', 'hard']) {
    const g = newGame(puzzle, [{ name: 'X', kind: 'bot', level }, { name: 'Y', kind: 'bot', level }], { seed: 9 });
    let n = 0;
    while (g.status === 'playing' && n++ < 5000) {
      const m = botTurn(g, g.turn, level);
      if (m.type === 'swap') swap(g, g.turn); else assert.ok(submit(g, g.turn, m.placements).ok);
    }
    assert.equal(g.status, 'over', level);
  }
});
