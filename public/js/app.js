import { newGame, place, endTurn, swap, resign, tick, viewFor, LETTER_POINTS, TURN_SECONDS, cellsOfClue } from './engine.js';
import { botMove, thinkTime, BOT_LEVELS } from './bot.js';
import { RemoteGame, createRoom, roomInfo, store } from './net.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SIZE_LABEL = { regular: 'Regular', large: 'Large', xl: 'ExtraLarge' };
const ARROW = { right: '▶', down: '▼', downRight: '↳', rightDown: '⤵' };
const DIR_WORD = { across: 'Across', down: 'Down' };

// ------------------------------------------------------------------ screens
function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${id}`));
  document.body.dataset.screen = id;
}

const prefs = {
  size: store.get('cc.size') || 'regular',
  level: store.get('cc.level') || 'medium',
  mode: 'bot',
};
const nameInput = $('#name');
nameInput.value = store.get('cc.name') || '';
nameInput.addEventListener('change', () => store.set('cc.name', nameInput.value.trim()));
const playerName = () => nameInput.value.trim().slice(0, 16) || 'Player';

function setupScreen(mode) {
  prefs.mode = mode;
  $('#setup-title').textContent = mode === 'bot' ? 'Play vs Bot' : 'Create a private room';
  $('#level-group').classList.toggle('hidden', mode !== 'bot');
  $('#setup-go').textContent = mode === 'bot' ? 'Start game' : 'Create room';
  $('#setup-hint').textContent = mode === 'bot'
    ? 'The bot is clearly marked as a bot. It plays in your browser, so this works offline too.'
    : 'You get a code and a link to send to one friend.';
  $$('#size-seg button').forEach((b) => b.classList.toggle('on', b.dataset.size === prefs.size));
  $$('#level-seg button').forEach((b) => b.classList.toggle('on', b.dataset.level === prefs.level));
  show('setup');
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  const to = go.dataset.go;
  if (to === 'home') { leaveGame(); history.replaceState(null, '', location.pathname); show('home'); }
  else if (to === 'setup-bot') setupScreen('bot');
  else if (to === 'setup-room') setupScreen('room');
  else if (to === 'howto') $('#dlg-howto').showModal();
});
$('#size-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.size = b.dataset.size; store.set('cc.size', prefs.size);
  $$('#size-seg button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#level-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.level = b.dataset.level; store.set('cc.level', prefs.level);
  $$('#level-seg button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#setup-go').addEventListener('click', async () => {
  if (prefs.mode === 'bot') return startBotGame();
  const btn = $('#setup-go');
  btn.disabled = true;
  try {
    const { code } = await createRoom(prefs.size);
    enterRoom(code);
  } catch (err) {
    $('#setup-hint').textContent = navigator.onLine === false ? 'You are offline. Rooms need a connection.' : err.message;
  } finally { btn.disabled = false; }
});
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return toast('Room codes have 6 characters', 'bad');
  try { await roomInfo(code); enterRoom(code); } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ local (bot) game
class LocalGame {
  constructor(puzzle, level, name) {
    this.level = level;
    this.listeners = { view: [], room: [], error: [] };
    this.puzzle = puzzle;
    this.name = name;
    this.start();
    this.timer = setInterval(() => { if (tick(this.state)) this.changed(); }, 500);
  }
  start() {
    this.state = newGame(this.puzzle, [
      { name: this.name, kind: 'human' },
      { name: `Bot`, kind: 'bot', level: this.level },
    ], (Math.random() * 2 ** 32) >>> 0);
    queueMicrotask(() => this.changed());
  }
  on(type, cb) { this.listeners[type].push(cb); return this; }
  now() { return Date.now(); }
  changed() {
    const view = viewFor(this.state, 0);
    for (const cb of this.listeners.view) cb(view);
    this.scheduleBot();
  }
  scheduleBot() {
    clearTimeout(this.botTimer);
    if (this.state.status !== 'playing' || this.state.turn !== 1) return;
    this.botTimer = setTimeout(() => {
      const s = this.state;
      if (s.status !== 'playing' || s.turn !== 1) return;
      const m = botMove(s, 1, this.level);
      if (m.type === 'place') place(s, 1, m.rackIndex, m.r, m.c);
      else if (m.type === 'swap') swap(s, 1);
      else endTurn(s, 1);
      this.changed();
    }, thinkTime(this.level));
  }
  act(fn) { const res = fn(); if (res && res.ok === false) for (const cb of this.listeners.error) cb({ msg: res.error }); this.changed(); }
  place(i, r, c) { this.act(() => place(this.state, 0, i, r, c)); }
  end() { this.act(() => endTurn(this.state, 0)); }
  swap() { this.act(() => swap(this.state, 0)); }
  resign() { this.act(() => resign(this.state, 0)); }
  rematch() { startBotGame(); }
  destroy() { clearInterval(this.timer); clearTimeout(this.botTimer); }
}

const packCache = {};
async function loadSoloPack(size) {
  if (!packCache[size]) {
    const res = await fetch(`puzzles/solo-${size}.json`);
    if (!res.ok) throw new Error('Could not load puzzles');
    packCache[size] = await res.json();
  }
  return packCache[size];
}

async function startBotGame() {
  leaveGame();
  let pack;
  try { pack = await loadSoloPack(prefs.size); } catch (e) { return toast(e.message, 'bad'); }
  const played = JSON.parse(store.get('cc.played') || '[]');
  const fresh = pack.puzzles.filter((p) => !played.includes(p.id));
  const list = fresh.length ? fresh : pack.puzzles;
  const puzzle = list[Math.floor(Math.random() * list.length)];
  store.set('cc.played', JSON.stringify([...played, puzzle.id].slice(-400)));
  game = new LocalGame(puzzle, prefs.level, playerName());
  ui.mode = 'bot';
  bindGame(game);
  show('game');
  maybeCoach();
}

// ------------------------------------------------------------------ remote room
function enterRoom(code) {
  leaveGame();
  history.replaceState(null, '', `?room=${code}`);
  const link = `${location.origin}${location.pathname}?room=${code}`;
  $('#lobby-code').textContent = code;
  $('#lobby-link').textContent = link;
  $('#copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied', 'good'); } catch { toast(link); }
  };
  $('#share-link').classList.toggle('hidden', !navigator.share);
  $('#share-link').onclick = () => navigator.share?.({ title: 'CrossClash', text: `Join my CrossClash room: ${code}`, url: link }).catch(() => {});
  $('#lobby-status').innerHTML = '<span class="dot"></span> Connecting…';
  show('lobby');
  game = new RemoteGame(code, playerName());
  ui.mode = 'room';
  ui.room = null;
  game.on('room', (room) => {
    ui.room = room;
    if (!ui.view) {
      const n = room.seats.length;
      $('#lobby-status').innerHTML = n < 2 ? '<span class="dot"></span> Waiting for your friend…' : 'Starting…';
    }
    renderPlayers();
    if (ui.view?.status === 'over') renderOver();
  });
  game.on('error', (e) => {
    if (e.fatal) {
      toast(e.msg, 'bad');
      if (!ui.view) { $('#lobby-status').textContent = e.msg; }
    } else toast(e.msg, e.transient ? '' : 'bad');
  });
  bindGame(game, true);
}

// ------------------------------------------------------------------ game UI
let game = null;
const ui = { view: null, puzzleId: null, sel: null, dir: 'across', armed: null, lastEvent: 0, cluesByAt: new Map(), mode: 'bot', showSolution: false };

function leaveGame() {
  if (game) game.destroy();
  game = null;
  ui.view = null;
  ui.puzzleId = null;
  for (const d of $$('dialog')) if (d.open) d.close();
}

function bindGame(g, remote = false) {
  g.on('view', (view) => {
    const first = !ui.view || ui.view.puzzle.id !== view.puzzle.id;
    const wasOver = ui.view?.status === 'over';
    ui.view = view;
    if (first) { buildBoard(view); ui.lastEvent = view.events.at(-1)?.n ?? 0; ui.showSolution = false; $('#dlg-over').open && $('#dlg-over').close(); if (remote) show('game'); }
    else playEvents(view);
    render();
    if (view.status === 'over' && (!wasOver || first)) setTimeout(renderOver, 900);
  });
  g.on('error', (e) => { if (!remote) toast(e.msg, 'bad'); });
}

function buildBoard(view) {
  const { puzzle } = view;
  ui.puzzleId = puzzle.id;
  ui.sel = null; ui.armed = null;
  ui.cluesByAt = new Map();
  for (const cl of puzzle.clues) {
    const k = `${cl.at[0]},${cl.at[1]}`;
    if (!ui.cluesByAt.has(k)) ui.cluesByAt.set(k, []);
    ui.cluesByAt.get(k).push(cl);
  }
  const board = $('#board');
  board.style.setProperty('--w', puzzle.w);
  board.innerHTML = '';
  for (let r = 0; r < puzzle.h; r++) for (let c = 0; c < puzzle.w; c++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.r = r; cell.dataset.c = c;
    if (puzzle.squares[r][c] === '#') {
      cell.classList.add('sq');
      const list = ui.cluesByAt.get(`${r},${c}`) || [];
      if (!list.length) cell.classList.add('empty');
      for (const cl of list) {
        const ct = document.createElement('div');
        ct.className = 'ct';
        ct.dataset.clue = cl.id;
        ct.textContent = cl.text;
        const ar = document.createElement('span');
        ar.className = `arrow ${cl.arrow}`;
        ar.textContent = ARROW[cl.arrow];
        ct.appendChild(ar);
        cell.appendChild(ct);
      }
    }
    board.appendChild(cell);
  }
  sizeBoard();
}

function sizeBoard() {
  if (!ui.view) return;
  const { w, h } = ui.view.puzzle;
  const wrap = $('.board-wrap');
  const top = wrap.getBoundingClientRect().top;
  const reserved = 150; // rack + actions
  const availH = window.innerHeight - top - reserved;
  const availW = Math.min(window.innerWidth, 720) - 20;
  const cell = Math.max(22, Math.floor(Math.min(availW / w, availH / h, 58)));
  document.documentElement.style.setProperty('--cell', `${cell}px`);
}
window.addEventListener('resize', sizeBoard);

function cellEl(r, c) { return $('#board').children[r * ui.view.puzzle.w + c]; }

function wordsAt(r, c) {
  return ui.view.puzzle.clues.filter((cl) => cellsOfClue(cl).some(([a, b]) => a === r && b === c));
}

function myTurn() { return ui.view && ui.view.status === 'playing' && ui.view.turn === ui.view.you; }

function render() {
  const v = ui.view;
  if (!v) return;
  const { w } = v.puzzle;
  const me = v.you;
  // board
  const board = $('#board');
  board.classList.toggle('armed', ui.armed != null && myTurn());
  board.classList.toggle('solution', ui.showSolution);
  const selWord = ui.sel ? activeClue() : null;
  const wordCells = new Set(selWord ? cellsOfClue(selWord).map(([a, b]) => `${a},${b}`) : []);
  for (let i = 0; i < v.board.length; i++) {
    const r = Math.floor(i / w), c = i % w;
    const el = board.children[i];
    const owner = v.owner[i];
    if (owner === 3) {
      for (const ct of el.children) {
        const cl = v.puzzle.clues[Number(ct.dataset.clue)];
        ct.classList.toggle('hl', selWord?.id === cl.id);
        ct.classList.toggle('done', cellsOfClue(cl).every(([a, b]) => v.board[a * w + b]));
      }
      continue;
    }
    el.classList.toggle('filled', owner !== -1);
    el.classList.toggle('word', wordCells.has(`${r},${c}`));
    el.classList.toggle('sel', !!ui.sel && ui.sel[0] === r && ui.sel[1] === c);
    let tile = el.querySelector('.tile');
    if (owner !== -1) {
      const cls = owner === 2 ? 'p2' : owner === me ? 'p0' : 'p1';
      if (!tile) { tile = document.createElement('div'); el.prepend(tile); }
      tile.className = `tile ${cls}${tile.dataset.l ? '' : ' pop'}`;
      tile.dataset.l = v.board[i];
      tile.textContent = v.board[i];
      el.querySelector('.sol')?.remove();
    } else {
      tile?.remove();
      const sol = el.querySelector('.sol');
      if (ui.showSolution && v.puzzle.solution) {
        if (!sol) { const s = document.createElement('span'); s.className = 'sol'; s.textContent = v.puzzle.solution[r][c]; el.appendChild(s); }
      } else sol?.remove();
    }
  }
  renderPlayers();
  // rack
  const rackEl = $('#rack');
  const rack = v.players[me].rack || [];
  rackEl.innerHTML = '';
  rackEl.classList.toggle('waiting', !myTurn());
  if (ui.armed != null && ui.armed >= rack.length) ui.armed = null;
  rack.forEach((l, i) => {
    const b = document.createElement('button');
    b.className = 'rtile' + (ui.armed === i ? ' on' : '');
    b.innerHTML = `${l}<small>${LETTER_POINTS[l]}</small>`;
    b.setAttribute('aria-label', `Tile ${l}, ${LETTER_POINTS[l]} points`);
    b.onclick = () => onRackTap(i);
    rackEl.appendChild(b);
  });
  $('#btn-end').disabled = !myTurn();
  $('#btn-swap').disabled = !myTurn() || v.turnPlaced > 0 || v.bagCount === 0;
  $('#bag-label').textContent = `${v.bagCount} in bag`;
  renderClueBar();
}

function renderPlayers() {
  const v = ui.view;
  if (!v) return;
  const me = v.you;
  const order = [me, 1 - me];
  order.forEach((pi, slot) => {
    const p = v.players[pi];
    const el = $(`#p${slot}`);
    $('.pname', el).textContent = p.name;
    $('.pscore', el).textContent = p.score;
    let tag = '';
    if (p.kind === 'bot') tag = `🤖 ${BOT_LEVELS[p.level]?.label || ''} bot`;
    else tag = slot === 0 ? 'You' : 'Friend';
    $('.ptag', el).textContent = tag;
    el.classList.toggle('turn', v.status === 'playing' && v.turn === pi);
    const online = ui.mode === 'room' && ui.room ? ui.room.seats[pi]?.online !== false : true;
    el.classList.toggle('offline', !online);
  });
  $('#turn-label').textContent = v.status === 'over' ? 'Game over' : myTurn() ? (v.turnPlaced ? `Your turn · ${v.turnPlaced} placed` : 'Your turn') : `${v.players[1 - me].name}'s turn`;
}

function activeClue() {
  if (!ui.sel) return null;
  const [r, c] = ui.sel;
  if (ui.view.owner[r * ui.view.puzzle.w + c] === 3) return ui.selClue ?? null;
  const ws = wordsAt(r, c);
  return ws.find((cl) => cl.dir === ui.dir) || ws[0] || null;
}

function renderClueBar() {
  const bar = $('#clue-bar');
  const v = ui.view;
  if (!ui.sel) {
    bar.textContent = myTurn() ? (ui.armed != null ? 'Now tap the square where this tile goes.' : 'Pick a tile, then tap its square. Tap a square to read its clue.') : 'Waiting for your opponent…';
    return;
  }
  const [r, c] = ui.sel;
  const active = activeClue();
  const list = v.owner[r * v.puzzle.w + c] === 3 ? ui.cluesByAt.get(`${r},${c}`) || [] : wordsAt(r, c);
  bar.innerHTML = '';
  for (const cl of list) {
    const s = document.createElement('span');
    s.className = 'cl' + (active && active.id === cl.id ? ' active' : '');
    const pattern = cellsOfClue(cl).map(([a, b]) => v.board[a * v.puzzle.w + b] || '·').join('');
    s.innerHTML = `<b>${DIR_WORD[cl.dir]}</b>${escapeHtml(cl.text)} <span class="mono small">${pattern} (${cl.len})</span>`;
    bar.appendChild(s);
  }
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// timer
setInterval(() => {
  const v = ui.view;
  if (!v || !game) return;
  const left = Math.max(0, v.deadline - game.now());
  const frac = v.status === 'playing' ? left / (TURN_SECONDS * 1000) : 0;
  const bar = $('#timer-bar');
  bar.style.width = `${frac * 100}%`;
  bar.classList.toggle('low', frac < 0.25);
}, 250);

// ------------------------------------------------------------------ input
$('#board').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell || !ui.view) return;
  const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
  const v = ui.view;
  const i = r * v.puzzle.w + c;
  if (v.owner[i] === 3) {
    const list = ui.cluesByAt.get(`${r},${c}`) || [];
    if (!list.length) return;
    // tapping a clue square selects the first empty square of its word
    const ct = e.target.closest('.ct');
    const cl = ct ? v.puzzle.clues[Number(ct.dataset.clue)] : list[0];
    const cells = cellsOfClue(cl);
    const target = cells.find(([a, b]) => v.owner[a * v.puzzle.w + b] === -1) || cells[0];
    ui.sel = target; ui.dir = cl.dir;
    render();
    return;
  }
  if (ui.armed != null && v.owner[i] === -1 && myTurn()) {
    const ri = ui.armed;
    ui.armed = null;
    ui.sel = [r, c];
    game.place(ri, r, c);
    return;
  }
  if (ui.sel && ui.sel[0] === r && ui.sel[1] === c) {
    const ws = wordsAt(r, c);
    if (ws.length > 1) ui.dir = ui.dir === 'across' ? 'down' : 'across';
  } else {
    ui.sel = [r, c];
    const ws = wordsAt(r, c);
    if (ws.length === 1) ui.dir = ws[0].dir;
  }
  render();
});

function onRackTap(i) {
  if (!myTurn()) return toast('Wait for your turn');
  const v = ui.view;
  if (ui.sel && v.owner[ui.sel[0] * v.puzzle.w + ui.sel[1]] === -1 && ui.armed == null) {
    game.place(i, ui.sel[0], ui.sel[1]);
    advance();
    return;
  }
  ui.armed = ui.armed === i ? null : i;
  render();
}

function advance() {
  // after placing, move the selection to the next empty square of the active word
  const cl = activeClue();
  if (!cl) return;
  const v = ui.view;
  const cells = cellsOfClue(cl);
  const idx = cells.findIndex(([a, b]) => a === ui.sel[0] && b === ui.sel[1]);
  for (let k = idx + 1; k < cells.length; k++) {
    const [a, b] = cells[k];
    if (v.owner[a * v.puzzle.w + b] === -1) { ui.sel = [a, b]; return; }
  }
}

document.addEventListener('keydown', (e) => {
  if (document.body.dataset.screen !== 'game' || !ui.view || $$('dialog').some((d) => d.open)) return;
  if (e.target.matches('input')) return;
  const v = ui.view;
  const k = e.key.toUpperCase();
  if (/^[A-Z]$/.test(k) && ui.sel && myTurn()) {
    const rack = v.players[v.you].rack || [];
    const ri = rack.indexOf(k);
    if (ri < 0) return toast(`No ${k} in your rack`);
    if (v.owner[ui.sel[0] * v.puzzle.w + ui.sel[1]] !== -1) return;
    game.place(ri, ui.sel[0], ui.sel[1]);
    advance();
    e.preventDefault();
  } else if (e.key === 'Enter' && myTurn()) {
    game.end();
  } else if (e.key.startsWith('Arrow') && ui.sel) {
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    let [r, c] = ui.sel;
    for (let s = 0; s < 20; s++) {
      r += d[0]; c += d[1];
      if (r < 0 || c < 0 || r >= v.puzzle.h || c >= v.puzzle.w) break;
      if (v.owner[r * v.puzzle.w + c] !== 3) { ui.sel = [r, c]; ui.dir = d[0] ? 'down' : 'across'; break; }
    }
    render();
    e.preventDefault();
  } else if (e.key === 'Escape') { ui.armed = null; ui.sel = null; render(); }
});

$('#btn-end').addEventListener('click', () => { ui.armed = null; game?.end(); });
$('#btn-swap').addEventListener('click', () => { ui.armed = null; game?.swap(); });
$('#btn-menu').addEventListener('click', () => $('#dlg-menu').showModal());
$('#dlg-menu').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  $('#dlg-menu').close();
  if (act === 'howto') $('#dlg-howto').showModal();
  if (act === 'resign' && ui.view?.status === 'playing') game.resign();
  if (act === 'home') { leaveGame(); history.replaceState(null, '', location.pathname); show('home'); }
});

// ------------------------------------------------------------------ feedback
function playEvents(view) {
  const me = view.you;
  for (const ev of view.events) {
    if (ev.n <= ui.lastEvent) continue;
    ui.lastEvent = ev.n;
    const mine = ev.p === me;
    const who = mine ? 'You' : view.players[ev.p]?.name;
    if (ev.type === 'place') {
      let msg = `${mine ? '+' : `${who} +`}${ev.points}`;
      if (ev.words.length) msg += ` · finished ${ev.words.length > 1 ? `${ev.words.length} words` : 'a word'}`;
      if (ev.fullRack) msg += ' · full rack bonus!';
      if (mine || ev.words.length || ev.fullRack) toast(msg, mine ? 'good' : '');
    } else if (ev.type === 'miss') {
      const el = cellEl(ev.r, ev.c);
      if (el) { el.dataset.miss = ev.letter; el.classList.remove('miss'); void el.offsetWidth; el.classList.add('miss'); setTimeout(() => el.classList.remove('miss'), 1500); }
      toast(mine ? `${ev.letter} doesn't go there. Turn over.` : `${who} missed with ${ev.letter}`, mine ? 'bad' : '');
    } else if (ev.type === 'end' && !mine) {
      if (ev.reason === 'timeout') toast(`${who} ran out of time`);
    } else if (ev.type === 'end' && mine && ev.reason === 'timeout') {
      toast('Time is up. Turn over.', 'bad');
    } else if (ev.type === 'swap' && !mine) {
      toast(`${who} swapped tiles`);
    } else if (ev.type === 'resign') {
      toast(mine ? 'You resigned' : `${who} resigned`);
    }
  }
}

function renderOver() {
  const v = ui.view;
  if (!v || v.status !== 'over') return;
  const me = v.you;
  const [a, b] = [v.players[me].score, v.players[1 - me].score];
  const title = v.winner === -1 ? "It's a draw" : v.winner === me ? 'You win!' : `${v.players[1 - me].name} wins`;
  $('#over-title').textContent = title;
  let detail = `${a} – ${b}.`;
  if (v.endReason === 'resign') detail += v.winner === me ? ' Your opponent resigned.' : ' You resigned.';
  if (v.endReason === 'stalled') detail += ' The game stalled after many turns without a correct tile.';
  $('#over-detail').textContent = detail;
  const again = $('#over-again');
  if (ui.mode === 'room') {
    const r = ui.room?.rematch || [false, false];
    again.textContent = r[me] ? 'Waiting for your friend…' : r[1 - me] ? 'Accept rematch' : 'Ask for a rematch';
    again.disabled = r[me];
  } else { again.textContent = 'Play again'; again.disabled = false; }
  if (!$('#dlg-over').open && !ui.showSolution) $('#dlg-over').showModal();
}
$('#over-again').addEventListener('click', () => { game?.rematch(); if (ui.mode === 'bot') $('#dlg-over').close(); });
$('#over-board').addEventListener('click', () => { ui.showSolution = true; $('#dlg-over').close(); render(); toast('Tap ☰ for the menu'); });
$('#over-home').addEventListener('click', () => { $('#dlg-over').close(); leaveGame(); history.replaceState(null, '', location.pathname); show('home'); });

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 1900);
}

// ------------------------------------------------------------------ first-game coach
const COACH = [
  'These are your 6 tiles. Every one of them belongs somewhere in this grid.',
  'Shaded squares hold clues. The arrow shows where the answer starts and which way it runs. Tap any square to read its clues above the grid.',
  'Tap a tile, then tap the square where it belongs. Right = points and it stays. Wrong = it bounces back and your turn ends.',
  'Finishing a word scores its length on top, and using all 6 tiles in one turn gives +10. Not sure? Press End turn.',
];
function maybeCoach() {
  if (store.get('cc.coached')) return;
  let step = 0;
  const el = $('#coach');
  const draw = () => {
    el.innerHTML = `<div>${COACH[step]}</div><button>${step < COACH.length - 1 ? 'Next' : 'Let’s play'}</button>`;
    $('button', el).onclick = () => {
      step++;
      if (step >= COACH.length) { el.classList.add('hidden'); store.set('cc.coached', '1'); } else draw();
    };
  };
  el.classList.remove('hidden');
  draw();
}

// ------------------------------------------------------------------ boot
const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (roomParam.length === 6) {
  show('home');
  $('#join-code').value = roomParam;
  if (store.get('cc.name')) roomInfo(roomParam).then(() => enterRoom(roomParam)).catch((e) => toast(e.message, 'bad'));
  else { nameInput.focus(); toast('Enter your name, then press Join'); }
} else {
  show('home');
}
