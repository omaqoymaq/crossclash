// CrossClash game engine. Pure logic, shared by the browser (solo vs bot) and
// the Cloudflare Durable Object (1v1 rooms). The full rules are in docs/RULES.md.

export const RACK_SIZE = 6;
export const TURN_SECONDS = 60;
export const FULL_RACK_BONUS = 10;
export const LETTER_POINTS = {
  A: 1, E: 1, I: 1, O: 1, N: 1, R: 1, S: 1, T: 1, U: 2, L: 2, D: 2,
  G: 3, C: 3, M: 3, P: 3, B: 3, H: 3, F: 4, W: 4, Y: 4, V: 5, K: 5,
  J: 8, X: 8, Q: 9, Z: 9,
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const cellsOfClue = (cl) =>
  Array.from({ length: cl.len }, (_, k) => (cl.dir === 'across' ? [cl.start[0], cl.start[1] + k] : [cl.start[0] + k, cl.start[1]]));

/**
 * Creates a new game state.
 * @param {object} puzzle full puzzle including answers (rows contain the solution)
 * @param {{name:string, kind:'human'|'bot', level?:string}[]} players exactly two
 * @param {number} seed
 */
export function newGame(puzzle, players, seed = Date.now(), now = Date.now()) {
  const { w, h } = puzzle;
  const board = new Array(w * h).fill('');
  const owner = new Array(w * h).fill(-1); // -1 empty, 0/1 player, 2 starter letter, 3 clue square
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (puzzle.rows[r][c] === '#') owner[r * w + c] = 3;
  for (const [r, c] of puzzle.revealed) { board[r * w + c] = puzzle.rows[r][c]; owner[r * w + c] = 2; }
  const bag = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    if (owner[r * w + c] === -1) bag.push(puzzle.rows[r][c]);
  }
  const state = {
    v: 1,
    seed,
    rngState: seed >>> 0,
    puzzle,
    board,
    owner,
    bag,
    players: players.map((p) => ({ name: p.name, kind: p.kind, level: p.level, score: 0, rack: [], misses: 0, placed: 0 })),
    turn: 0,
    turnNo: 1,
    turnPlaced: 0,
    deadline: now + TURN_SECONDS * 1000,
    status: 'playing',
    winner: null,
    events: [],
    passStreak: 0,
  };
  shuffleBag(state);
  const first = Math.floor(nextRand(state) * 2);
  state.turn = first;
  refill(state, 0);
  refill(state, 1);
  return state;
}

function nextRand(state) {
  // deterministic, serialisable RNG (state survives JSON round trips)
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffleBag(state) {
  const b = state.bag;
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand(state) * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
}

function refill(state, p) {
  const rack = state.players[p].rack;
  while (rack.length < RACK_SIZE && state.bag.length) rack.push(state.bag.pop());
}

function event(state, e) {
  state.events.push({ n: (state.events.at(-1)?.n ?? 0) + 1, ...e });
  if (state.events.length > 40) state.events.splice(0, state.events.length - 40);
}

/** Words (clues) that run through a cell. */
export function cluesAt(puzzle, r, c) {
  return puzzle.clues.filter((cl) => cellsOfClue(cl).some(([a, b]) => a === r && b === c));
}

/**
 * Player p places rack tile rackIndex on cell (r,c).
 * Returns { ok, error?, correct?, points?, words?, turnEnded? }.
 */
export function place(state, p, rackIndex, r, c, now = Date.now()) {
  if (state.status !== 'playing') return { ok: false, error: 'Game is over' };
  if (state.turn !== p) return { ok: false, error: 'Not your turn' };
  const { w, h } = state.puzzle;
  if (r < 0 || c < 0 || r >= h || c >= w) return { ok: false, error: 'Off the board' };
  const i = r * w + c;
  if (state.owner[i] !== -1) return { ok: false, error: 'That square is taken' };
  const player = state.players[p];
  const letter = player.rack[rackIndex];
  if (!letter) return { ok: false, error: 'No such tile' };
  const answer = state.puzzle.rows[r][c];
  if (letter !== answer) {
    player.misses++;
    event(state, { type: 'miss', p, r, c, letter });
    endTurn(state, p, now, 'miss');
    return { ok: true, correct: false, turnEnded: true };
  }
  player.rack.splice(rackIndex, 1);
  state.board[i] = letter;
  state.owner[i] = p;
  state.turnPlaced++;
  player.placed++;
  let points = LETTER_POINTS[letter] || 1;
  const words = [];
  for (const cl of cluesAt(state.puzzle, r, c)) {
    if (cellsOfClue(cl).every(([a, b]) => state.board[a * w + b])) {
      words.push(cl.answer ?? cl.id);
      points += cl.len;
    }
  }
  let fullRack = false;
  if (state.turnPlaced === RACK_SIZE) { points += FULL_RACK_BONUS; fullRack = true; }
  player.score += points;
  state.passStreak = 0;
  event(state, { type: 'place', p, r, c, letter, points, words, fullRack });
  const boardFull = state.owner.every((o) => o !== -1);
  if (boardFull) { finish(state, 'complete'); return { ok: true, correct: true, points, words, turnEnded: true }; }
  if (player.rack.length === 0) { endTurn(state, p, now, 'rack'); return { ok: true, correct: true, points, words, turnEnded: true }; }
  return { ok: true, correct: true, points, words, turnEnded: false };
}

/** Ends player p's turn voluntarily ('done'), by timeout ('timeout'), after a miss or empty rack. */
export function endTurn(state, p, now = Date.now(), reason = 'done') {
  if (state.status !== 'playing' || state.turn !== p) return { ok: false, error: 'Not your turn' };
  state.passStreak = state.turnPlaced === 0 ? state.passStreak + 1 : 0;
  if (reason !== 'miss') event(state, { type: 'end', p, reason, placed: state.turnPlaced });
  refill(state, p);
  state.turn = 1 - p;
  state.turnNo++;
  state.turnPlaced = 0;
  state.deadline = now + TURN_SECONDS * 1000;
  // safety valve: 12 turns in a row without a correct tile ends the game
  if (state.passStreak >= 12) finish(state, 'stalled');
  return { ok: true };
}

/** Swap the whole rack for new tiles; uses up the turn. Only before placing anything this turn. */
export function swap(state, p, now = Date.now()) {
  if (state.status !== 'playing' || state.turn !== p) return { ok: false, error: 'Not your turn' };
  if (state.turnPlaced > 0) return { ok: false, error: 'You already placed tiles this turn' };
  if (!state.bag.length) return { ok: false, error: 'The bag is empty' };
  const player = state.players[p];
  state.bag.push(...player.rack);
  player.rack = [];
  shuffleBag(state);
  event(state, { type: 'swap', p });
  endTurn(state, p, now, 'swap');
  return { ok: true };
}

export function resign(state, p) {
  if (state.status !== 'playing') return { ok: false };
  event(state, { type: 'resign', p });
  finish(state, 'resign', 1 - p);
  return { ok: true };
}

/** Called periodically: ends a turn whose time ran out. */
export function tick(state, now = Date.now()) {
  if (state.status === 'playing' && now >= state.deadline) {
    endTurn(state, state.turn, now, 'timeout');
    return true;
  }
  return false;
}

function finish(state, reason, forcedWinner = null) {
  state.status = 'over';
  state.endReason = reason;
  const [a, b] = state.players.map((p) => p.score);
  state.winner = forcedWinner ?? (a === b ? -1 : a > b ? 0 : 1);
  event(state, { type: 'over', reason, winner: state.winner });
}

/** What player `viewer` is allowed to see (no solution, no opponent rack). */
export function viewFor(state, viewer) {
  const { puzzle } = state;
  const over = state.status === 'over';
  return {
    puzzle: {
      id: puzzle.id, size: puzzle.size, w: puzzle.w, h: puzzle.h,
      clues: puzzle.clues.map(({ answer, ...rest }) => rest),
      // once the game ends, everyone may see the full solution
      solution: over ? puzzle.rows : null,
      squares: puzzle.rows.map((row) => row.replace(/[^#]/g, '.')),
    },
    board: state.board,
    owner: state.owner,
    bagCount: state.bag.length,
    you: viewer,
    players: state.players.map((p, i) => ({
      name: p.name, kind: p.kind, level: p.level, score: p.score, placed: p.placed, misses: p.misses,
      rackCount: p.rack.length,
      rack: i === viewer ? p.rack : null,
    })),
    turn: state.turn,
    turnNo: state.turnNo,
    turnPlaced: state.turnPlaced,
    deadline: state.deadline,
    status: state.status,
    winner: state.winner,
    endReason: state.endReason ?? null,
    events: state.events.slice(-12),
  };
}
