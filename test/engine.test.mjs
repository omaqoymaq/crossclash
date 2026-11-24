import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newGame, place, endTurn, swap, tick, viewFor, RACK_SIZE, cellsOfClue } from '../public/js/engine.js';
import { botMove } from '../public/js/bot.js';

const pack = JSON.parse(fs.readFileSync(new URL('../puzzles/regular.json', import.meta.url)));
const puzzle = pack.puzzles[0];
const players = [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'bot', level: 'hard' }];

function findHome(state, p) {
  const { w } = state.puzzle;
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] !== -1) continue;
    const r = Math.floor(i / w), c = i % w;
    const ri = state.players[p].rack.indexOf(state.puzzle.rows[r][c]);
    if (ri >= 0) return { ri, r, c };
  }
  return null;
}

test('bag holds exactly the unrevealed letters', () => {
  const s = newGame(puzzle, players, 1);
  const empty = s.owner.filter((o) => o === -1).length;
  assert.equal(s.bag.length + s.players[0].rack.length + s.players[1].rack.length, empty);
  assert.equal(s.players[0].rack.length, RACK_SIZE);
});

test('correct tile scores and stays, wrong tile ends the turn', () => {
  const s = newGame(puzzle, players, 2);
  const p = s.turn;
  const m = findHome(s, p);
  const res = place(s, p, m.ri, m.r, m.c);
  assert.ok(res.correct);
  assert.ok(s.players[p].score > 0);
  // wrong placement
  const { w } = s.puzzle;
  let wrong = null;
  for (let i = 0; i < s.owner.length && !wrong; i++) {
    if (s.owner[i] !== -1) continue;
    const r = Math.floor(i / w), c = i % w;
    const ri = s.players[p].rack.findIndex((l) => l !== s.puzzle.rows[r][c]);
    if (ri >= 0) wrong = { ri, r, c };
  }
  const before = s.players[p].rack.length;
  const r2 = place(s, p, wrong.ri, wrong.r, wrong.c);
  assert.equal(r2.correct, false);
  assert.equal(s.turn, 1 - p);
  assert.equal(place(s, p, 0, 0, 1).ok, false, 'not your turn');
});

test('view hides the solution and the opponent rack', () => {
  const s = newGame(puzzle, players, 3);
  const v = viewFor(s, 0);
  assert.equal(v.puzzle.solution, null);
  assert.equal(v.players[1].rack, null);
  assert.ok(v.puzzle.clues.every((c) => !('answer' in c)));
  assert.ok(!JSON.stringify(v).includes(puzzle.rows.join('')));
});

test('timeout passes the turn; swap returns tiles to the bag', () => {
  const s = newGame(puzzle, players, 4, 1000);
  const p = s.turn;
  assert.ok(tick(s, s.deadline + 1));
  assert.equal(s.turn, 1 - p);
  const q = s.turn;
  const total = s.bag.length + s.players[q].rack.length;
  assert.ok(swap(s, q).ok);
  assert.equal(s.bag.length + s.players[q].rack.length, total);
});

test('a full game between two perfect players fills the grid', () => {
  const s = newGame(puzzle, players, 5);
  let guard = 0;
  while (s.status === 'playing' && guard++ < 2000) {
    const m = findHome(s, s.turn);
    if (m) place(s, s.turn, m.ri, m.r, m.c); else endTurn(s, s.turn);
  }
  assert.equal(s.status, 'over');
  assert.equal(s.endReason, 'complete');
  assert.ok(s.owner.every((o) => o !== -1));
  // every word was completed exactly once, so word bonuses add up
  const letterPts = s.players[0].score + s.players[1].score;
  const wordBonus = puzzle.clues.filter((c) => cellsOfClue(c).some(([r, cc]) => !puzzle.revealed.some(([a, b]) => a === r && b === cc))).reduce((n, c) => n + c.len, 0);
  assert.ok(letterPts >= wordBonus);
});

test('bot games finish at every level', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const s = newGame(puzzle, [{ name: 'X', kind: 'bot', level }, { name: 'Y', kind: 'bot', level }], 6);
    let guard = 0;
    while (s.status === 'playing' && guard++ < 5000) {
      const m = botMove(s, s.turn, level);
      if (m.type === 'place') place(s, s.turn, m.rackIndex, m.r, m.c);
      else if (m.type === 'swap') swap(s, s.turn);
      else endTurn(s, s.turn);
    }
    assert.equal(s.status, 'over', level);
  }
});
