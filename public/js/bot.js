// The CrossClash bot. It is always shown as a bot, never as a person.
//
// It "reads" the grid like a human would: a square is easier to know when more
// letters of its words are already on the board and when its word is short.
// Each turn it lays down the tiles it feels sure about, sometimes takes a
// guess (which may be wrong and cost a point), then submits.

import { cellsOfClue, cluesAt } from './engine.js';

export const BOT_LEVELS = {
  easy: { label: 'Easy', base: 0.1, fillBonus: 0.45, maxTiles: 2, guessChance: 0.35, think: [1800, 3200] },
  medium: { label: 'Medium', base: 0.35, fillBonus: 0.5, maxTiles: 4, guessChance: 0.25, think: [1500, 2800] },
  hard: { label: 'Hard', base: 0.6, fillBonus: 0.4, maxTiles: 5, guessChance: 0.12, think: [1200, 2200] },
};

/**
 * Plans the bot's whole turn from the full game state.
 * Returns { type: 'submit', placements: [{i, r, c}] } or { type: 'swap' }.
 */
export function botTurn(state, p, levelKey = 'medium', rand = Math.random) {
  const L = BOT_LEVELS[levelKey] || BOT_LEVELS.medium;
  const { puzzle, board } = state;
  const { w } = puzzle;
  const rack = state.players[p].rack;
  const usedIdx = new Set();
  const usedCell = new Set();
  const placements = [];
  const known = (r, c) => {
    let know = 0;
    for (const cl of cluesAt(puzzle, r, c)) {
      const cells = cellsOfClue(cl);
      const filled = cells.filter(([a, b]) => board[a * w + b] || usedCell.has(a * w + b)).length / cells.length;
      const shortness = cl.len <= 4 ? 0.15 : cl.len <= 6 ? 0.05 : 0;
      know = Math.max(know, L.base + L.fillBonus * filled + shortness);
    }
    return Math.min(0.97, know);
  };

  const target = 1 + Math.floor(rand() * L.maxTiles);
  for (let step = 0; step < target; step++) {
    // squares where one of the remaining tiles truly belongs
    const options = [];
    for (let k = 0; k < state.owner.length; k++) {
      if (state.owner[k] !== -1 || usedCell.has(k)) continue;
      const r = Math.floor(k / w), c = k % w;
      const i = rack.findIndex((l, idx) => !usedIdx.has(idx) && l === puzzle.rows[r][c]);
      if (i >= 0) options.push({ i, r, c, know: known(r, c) });
    }
    if (!options.length) break;
    options.sort((a, b) => b.know - a.know);
    const best = options[0];
    let pick = null;
    if (rand() < best.know) pick = best;
    else if (rand() < L.guessChance) {
      // a guess: right about half the time
      if (rand() < 0.5) pick = options[Math.floor(rand() * Math.min(3, options.length))];
      else {
        const empties = [];
        for (let k = 0; k < state.owner.length; k++) if (state.owner[k] === -1 && !usedCell.has(k)) empties.push(k);
        const k = empties[Math.floor(rand() * empties.length)];
        const r = Math.floor(k / w), c = k % w;
        const i = rack.findIndex((l, idx) => !usedIdx.has(idx) && l !== puzzle.rows[r][c]);
        if (i >= 0) pick = { i, r, c };
      }
    }
    if (!pick) break;
    placements.push({ i: pick.i, r: pick.r, c: pick.c });
    usedIdx.add(pick.i);
    usedCell.add(pick.r * w + pick.c);
  }
  if (!placements.length && state.bag.length && rand() < 0.35) return { type: 'swap' };
  return { type: 'submit', placements };
}

export function thinkTime(levelKey = 'medium', rand = Math.random) {
  const [a, b] = (BOT_LEVELS[levelKey] || BOT_LEVELS.medium).think;
  return a + rand() * (b - a);
}
