// CrossClash game engine. Pure logic, shared by the browser (solo vs bot) and
// the Cloudflare Durable Object (1v1 rooms). The full rules are in docs/RULES.md.
//
// A turn: the player lays any tiles they like on empty squares (nothing is
// checked yet), then submits. On submit:
//   +1 per correct tile (it stays on the board)
//   -1 per wrong tile (it goes back to the hand)
//   +1 per word completed by this submission, plus +1 per letter of each such word
//   +5 when all 5 tiles of the hand were placed correctly
// The hand is refilled to exactly 5 tiles for every turn (while the bag lasts).

export const HAND_SIZE = 5;
export const FULL_HAND_BONUS = 5;
export const TIMER_CHOICES = [0, 30, 60, 120, 300]; // seconds; 0 = no timer
export const TIMEOUT_GRACE_MS = 1500; // clients auto-submit at 0; the server waits a little longer

export const cellsOfClue = (cl) =>
  Array.from({ length: cl.len }, (_, k) => (cl.dir === 'across' ? [cl.start[0], cl.start[1] + k] : [cl.start[0] + k, cl.start[1]]));

/**
 * Creates a new game state.
 * @param {object} puzzle full puzzle including answers (rows contain the solution)
 * @param {{name:string, kind:'human'|'bot', level?:string}[]} players exactly two
 * @param {{seed?:number, now?:number, turnSeconds?:number}} opts
 */
export function newGame(puzzle, players, opts = {}) {
  const seed = opts.seed ?? Date.now();
  const now = opts.now ?? Date.now();
  const turnSeconds = TIMER_CHOICES.includes(opts.turnSeconds) ? opts.turnSeconds : 60;
  const { w, h } = puzzle;
  const board = new Array(w * h).fill('');
  const owner = new Array(w * h).fill(-1); // -1 empty, 0/1 player, 2 starter letter, 3 clue square
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (puzzle.rows[r][c] === '#') owner[r * w + c] = 3;
  for (const [r, c] of puzzle.revealed) { board[r * w + c] = puzzle.rows[r][c]; owner[r * w + c] = 2; }
  const bag = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (owner[r * w + c] === -1) bag.push(puzzle.rows[r][c]);
  const state = {
    v: 2,
    rngState: seed >>> 0,
    puzzle,
    turnSeconds,
    board,
    owner,
    bag,
    players: players.map((p) => ({ name: p.name, kind: p.kind, level: p.level, score: 0, rack: [], correct: 0, wrong: 0, words: 0 })),
    turn: 0,
    turnNo: 1,
    deadline: null,
    status: 'playing',
    winner: null,
    events: [],
    log: [], // every move, kept for the score logs
    passStreak: 0,
  };
  shuffleBag(state);
  state.turn = Math.floor(nextRand(state) * 2);
  refill(state, 0);
  refill(state, 1);
  startTurn(state, now);
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
  while (rack.length < HAND_SIZE && state.bag.length) rack.push(state.bag.pop());
}

function startTurn(state, now) {
  refill(state, state.turn);
  state.deadline = state.turnSeconds ? now + state.turnSeconds * 1000 : null;
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
 * Scores a set of placements without changing anything. Used by submit() and
 * by the bot. placements: [{ i: rackIndex, r, c }]
 */
export function scoreSubmission(state, p, placements) {
  const { puzzle, board } = state;
  const { w, h } = puzzle;
  const rack = state.players[p].rack;
  const seenIdx = new Set();
  const seenCell = new Set();
  for (const pl of placements) {
    const { i, r, c } = pl;
    if (!Number.isInteger(i) || !Number.isInteger(r) || !Number.isInteger(c)) return { error: 'Bad move' };
    if (i < 0 || i >= rack.length || seenIdx.has(i)) return { error: 'No such tile' };
    if (r < 0 || c < 0 || r >= h || c >= w) return { error: 'Off the board' };
    const k = r * w + c;
    if (state.owner[k] !== -1 || seenCell.has(k)) return { error: 'That square is taken' };
    seenIdx.add(i); seenCell.add(k);
  }
  const correct = [];
  const wrong = [];
  for (const pl of placements) {
    const letter = rack[pl.i];
    (letter === puzzle.rows[pl.r][pl.c] ? correct : wrong).push({ ...pl, letter });
  }
  const filled = new Set(correct.map(({ r, c }) => r * w + c));
  const words = [];
  for (const cl of puzzle.clues) {
    const cells = cellsOfClue(cl);
    if (!cells.some(([a, b]) => filled.has(a * w + b))) continue;
    if (cells.every(([a, b]) => board[a * w + b] || filled.has(a * w + b))) words.push(cl);
  }
  const fullHand = correct.length === HAND_SIZE;
  const wordLetters = words.reduce((n, cl) => n + cl.len, 0);
  const breakdown = {
    letters: correct.length,
    wrong: -wrong.length,
    words: words.length,
    wordLetters,
    fullHand: fullHand ? FULL_HAND_BONUS : 0,
  };
  const points = breakdown.letters + breakdown.wrong + breakdown.words + breakdown.wordLetters + breakdown.fullHand;
  return { correct, wrong, words, breakdown, points };
}

/** Player p submits their placed tiles. An empty list is a pass. */
export function submit(state, p, placements = [], now = Date.now()) {
  if (state.status !== 'playing') return { ok: false, error: 'Game is over' };
  if (state.turn !== p) return { ok: false, error: 'Not your turn' };
  if (!Array.isArray(placements) || placements.length > HAND_SIZE) return { ok: false, error: 'Bad move' };
  const res = scoreSubmission(state, p, placements);
  if (res.error) return { ok: false, error: res.error };
  const { w } = state.puzzle;
  const player = state.players[p];
  for (const { r, c, letter } of res.correct) { state.board[r * w + c] = letter; state.owner[r * w + c] = p; }
  const used = new Set(res.correct.map((x) => x.i));
  player.rack = player.rack.filter((_, i) => !used.has(i));
  player.score += res.points;
  player.correct += res.correct.length;
  player.wrong += res.wrong.length;
  player.words += res.words.length;
  state.log.push({
    turn: state.turnNo, p, type: placements.length ? 'submit' : 'pass',
    correct: res.correct.length, wrong: res.wrong.length,
    words: res.words.map((cl) => ({ word: cl.answer, len: cl.len })),
    breakdown: res.breakdown, points: res.points, score: player.score,
  });
  event(state, {
    type: placements.length ? 'submit' : 'pass',
    p,
    correct: res.correct.map(({ r, c, letter }) => ({ r, c, letter })),
    wrong: res.wrong.map(({ r, c, letter }) => ({ r, c, letter })),
    words: res.words.map((cl) => cl.id),
    breakdown: res.breakdown,
    points: res.points,
  });
  state.passStreak = res.correct.length ? 0 : state.passStreak + 1;
  if (state.owner.every((o) => o !== -1)) { finish(state, 'complete'); return { ok: true, ...summary(res) }; }
  nextTurn(state, now);
  return { ok: true, ...summary(res) };
}

const summary = (res) => ({ points: res.points, breakdown: res.breakdown, correct: res.correct.length, wrong: res.wrong.length });

function nextTurn(state, now) {
  state.turn = 1 - state.turn;
  state.turnNo++;
  // safety valve: 20 turns in a row without a correct tile ends the game
  if (state.passStreak >= 20) { finish(state, 'stalled'); return; }
  startTurn(state, now);
}

/** Swap the whole hand for new tiles; uses up the turn. */
export function swap(state, p, now = Date.now()) {
  if (state.status !== 'playing' || state.turn !== p) return { ok: false, error: 'Not your turn' };
  if (!state.bag.length) return { ok: false, error: 'The bag is empty' };
  const player = state.players[p];
  state.bag.push(...player.rack);
  player.rack = [];
  shuffleBag(state);
  refill(state, p);
  event(state, { type: 'swap', p });
  state.log.push({ turn: state.turnNo, p, type: 'swap', points: 0, score: player.score });
  state.passStreak++;
  nextTurn(state, now);
  return { ok: true };
}

export function resign(state, p) {
  if (state.status !== 'playing') return { ok: false };
  event(state, { type: 'resign', p });
  state.log.push({ turn: state.turnNo, p, type: 'resign', points: 0, score: state.players[p].score });
  finish(state, 'resign', 1 - p);
  return { ok: true };
}

/** Called periodically: a turn whose time ran out passes with nothing placed. */
export function tick(state, now = Date.now(), grace = 0) {
  if (state.status === 'playing' && state.deadline && now >= state.deadline + grace) {
    event(state, { type: 'timeout', p: state.turn });
    state.log.push({ turn: state.turnNo, p: state.turn, type: 'timeout', points: 0, score: state.players[state.turn].score });
    state.passStreak++;
    nextTurn(state, now);
    return true;
  }
  return false;
}

function finish(state, reason, forcedWinner = null) {
  state.status = 'over';
  state.endReason = reason;
  state.deadline = null;
  const [a, b] = state.players.map((p) => p.score);
  state.winner = forcedWinner ?? (a === b ? -1 : a > b ? 0 : 1);
  event(state, { type: 'over', reason, winner: state.winner });
}

/** What player `viewer` is allowed to see (no solution, no opponent hand). */
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
    turnSeconds: state.turnSeconds,
    players: state.players.map((p, i) => ({
      name: p.name, kind: p.kind, level: p.level, score: p.score, correct: p.correct, wrong: p.wrong, words: p.words,
      rackCount: p.rack.length,
      rack: i === viewer ? p.rack : null,
    })),
    turn: state.turn,
    turnNo: state.turnNo,
    deadline: state.deadline,
    status: state.status,
    winner: state.winner,
    endReason: state.endReason ?? null,
    events: state.events.slice(-12),
    log: state.log || [],
  };
}
