// The CrossClash bot. It is always shown as a bot, never as a person.
//
// It "reads" the grid like a human would: a square is easier to know when more
// letters of its words are already on the board and when its word is short.
// Each level sets how much it knows, how often it guesses, and when it stops.

import { cellsOfClue, cluesAt } from './engine.js';

export const BOT_LEVELS = {
  easy: { label: 'Easy', base: 0.12, fillBonus: 0.45, maxTiles: 2, guessChance: 0.3, think: [1400, 2600] },
  medium: { label: 'Medium', base: 0.3, fillBonus: 0.45, maxTiles: 4, guessChance: 0.2, think: [1000, 2000] },
  hard: { label: 'Hard', base: 0.45, fillBonus: 0.45, maxTiles: 5, guessChance: 0.1, think: [700, 1400] },
};

/**
 * Decides the bot's next action given the full game state.
 * Returns { type: 'place', rackIndex, r, c } | { type: 'end' } | { type: 'swap' }.
 */
export function botMove(state, p, levelKey = 'medium', rand = Math.random) {
  const L = BOT_LEVELS[levelKey] || BOT_LEVELS.medium;
  const { puzzle, board } = state;
  const { w } = puzzle;
  const rack = state.players[p].rack;
  if (state.turnPlaced >= L.maxTiles && rand() < 0.7) return { type: 'end' };

  // how well does the bot "know" each empty square?
  const options = [];
  for (let r = 0; r < puzzle.h; r++) for (let c = 0; c < w; c++) {
    if (state.owner[r * w + c] !== -1) continue;
    const letter = puzzle.rows[r][c];
    const ri = rack.indexOf(letter);
    if (ri < 0) continue;
    let know = 0;
    for (const cl of cluesAt(puzzle, r, c)) {
      const cells = cellsOfClue(cl);
      const filled = cells.filter(([a, b]) => board[a * w + b]).length / cells.length;
      const shortness = cl.len <= 4 ? 0.15 : cl.len <= 6 ? 0.05 : 0;
      know = Math.max(know, L.base + L.fillBonus * filled + shortness);
    }
    options.push({ r, c, ri, know: Math.min(0.97, know) });
  }
  if (!options.length) {
    if (state.turnPlaced === 0 && state.bag.length) return { type: 'swap' };
    return { type: 'end' };
  }
  options.sort((a, b) => b.know - a.know);
  // roll for the square it knows best; a success means the bot "knows" the answer
  const best = options[0];
  if (rand() < best.know) return { type: 'place', rackIndex: best.ri, r: best.r, c: best.c };
  if (state.turnPlaced === 0 && options[1] && rand() < options[1].know) {
    return { type: 'place', rackIndex: options[1].ri, r: options[1].r, c: options[1].c };
  }
  // nothing known: maybe take a risk with a guess, otherwise stop
  if (state.turnPlaced === 0 || rand() < L.guessChance) {
    if (rand() < 0.5) {
      const o = options[Math.floor(rand() * Math.min(3, options.length))];
      return { type: 'place', rackIndex: o.ri, r: o.r, c: o.c };
    }
    // a wrong guess: put a tile on a square where it does not belong
    const empties = [];
    for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === -1) empties.push(i);
    const i = empties[Math.floor(rand() * empties.length)];
    const r = Math.floor(i / w), c = i % w;
    const ri = rack.findIndex((l) => l !== puzzle.rows[r][c]);
    if (ri >= 0) return { type: 'place', rackIndex: ri, r, c };
  }
  if (state.turnPlaced === 0 && state.bag.length && rand() < 0.3) return { type: 'swap' };
  return { type: 'end' };
}

export function thinkTime(levelKey = 'medium', rand = Math.random) {
  const [a, b] = (BOT_LEVELS[levelKey] || BOT_LEVELS.medium).think;
  return a + rand() * (b - a);
}
