import { newGame, submit, swap, resign, tick, viewFor, cellsOfClue, clueHash, HAND_SIZE } from './engine.js';
import { botTurn, thinkTime, BOT_LEVELS } from './bot.js';
import { RemoteGame, createRoom, roomInfo, store, seenClues, rememberClues } from './net.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ARROW = { right: '▶', down: '▼', downRight: '↳', rightDown: '⤵' };
const DIR_WORD = { across: 'Across', down: 'Down' };
const TIMER_LABEL = { 0: 'No timer', 30: '30 s', 60: '1 min', 120: '2 min', 300: '5 min' };

// ------------------------------------------------------------------ screens
function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${id}`));
  document.body.dataset.screen = id;
}

const prefs = {
  size: store.get('cc.size') || 'regular',
  level: store.get('cc.level') || 'medium',
  timer: Number(store.get('cc.timer') ?? 60),
  mode: 'bot',
  special: '', // themed puzzle for a friend room, '' for the everyday packs
};
if (!(prefs.timer in TIMER_LABEL)) prefs.timer = 60;
const nameInput = $('#name');
nameInput.value = store.get('cc.name') || '';
nameInput.addEventListener('change', () => store.set('cc.name', nameInput.value.trim()));
const playerName = () => nameInput.value.trim().slice(0, 16) || 'Player';

function setupScreen(mode) {
  prefs.mode = mode;
  const solo = mode !== 'room';
  $('#setup-title').textContent = mode === 'special' ? 'Thanksgiving special' : solo ? 'Play vs Bot' : 'Create a private room';
  $('#level-group').classList.toggle('hidden', !solo);
  $('#puzzle-group').classList.toggle('hidden', mode !== 'room');
  $('#size-group').classList.toggle('hidden', mode === 'special' || (mode === 'room' && !!prefs.special));
  $('#setup-friend').classList.toggle('hidden', mode !== 'special');
  $('#setup-go').textContent = solo ? 'Start game' : 'Create room';
  $('#setup-hint').textContent = mode === 'special'
    ? 'A Large grid where every word and clue is about Thanksgiving. You play the bot.'
    : solo ? 'The bot is clearly marked as a bot. It plays in your browser.'
    : 'You get a code and a link to send to one friend.';
  for (const [seg, key, attr] of [['#size-seg', 'size', 'size'], ['#level-seg', 'level', 'level'], ['#timer-seg', 'timer', 'timer'], ['#special-seg', 'special', 'special']]) {
    $$(`${seg} button`).forEach((b) => b.classList.toggle('on', String(b.dataset[attr]) === String(prefs[key])));
  }
  show('setup');
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  const to = go.dataset.go;
  if (to === 'home') goHome();
  else if (to === 'setup-bot') setupScreen('bot');
  else if (to === 'setup-room') { prefs.special = ''; setupScreen('room'); }
  else if (to === 'setup-special') setupScreen('special');
  else if (to === 'howto') $('#dlg-howto').showModal();
});
for (const [seg, key, attr, num] of [['#size-seg', 'size', 'size'], ['#level-seg', 'level', 'level'], ['#timer-seg', 'timer', 'timer', true]]) {
  $(seg).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    prefs[key] = num ? Number(b.dataset[attr]) : b.dataset[attr];
    store.set(`cc.${key}`, String(prefs[key]));
    $$(`${seg} button`).forEach((x) => x.classList.toggle('on', x === b));
  });
}
$('#special-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.special = b.dataset.special;
  $$('#special-seg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#size-group').classList.toggle('hidden', !!prefs.special);
});
$('#setup-friend').addEventListener('click', () => { prefs.special = 'thanksgiving'; setupScreen('room'); });
$('#setup-go').addEventListener('click', async () => {
  if (prefs.mode === 'bot') return startBotGame();
  if (prefs.mode === 'special') return startBotGame('thanksgiving');
  const btn = $('#setup-go');
  btn.disabled = true;
  try {
    const { code } = await createRoom(prefs.size, prefs.timer, prefs.special);
    enterRoom(code);
  } catch (err) {
    $('#setup-hint').textContent = navigator.onLine === false ? 'You are offline. Rooms need a connection.' : err.message;
  } finally { btn.disabled = false; }
});
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  store.set('cc.name', nameInput.value.trim());
  const code = $('#join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return toast('Room codes have 6 characters', 'bad');
  try { await roomInfo(code); enterRoom(code); } catch (err) { toast(err.message, 'bad'); }
});

function goHome() {
  leaveGame();
  try { history.replaceState(null, '', location.pathname); } catch { /* sandboxed */ }
  show('home');
}

// ------------------------------------------------------------------ local (bot) game
class LocalGame {
  constructor(puzzle, level, name, timer, special) {
    this.special = special;
    this.level = level;
    this.listeners = { view: [], room: [], error: [] };
    this.puzzle = puzzle;
    this.name = name;
    this.timer = timer;
    this.start();
    this.ticker = setInterval(() => { if (tick(this.state, Date.now(), 400)) this.changed(); }, 250);
  }
  start() {
    this.state = newGame(this.puzzle, [
      { name: this.name, kind: 'human' },
      { name: 'Bot', kind: 'bot', level: this.level },
    ], { seed: (Math.random() * 2 ** 32) >>> 0, turnSeconds: this.timer, seenClues: seenClues() });
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
    const s = this.state;
    if (s.status !== 'playing' || s.turn !== 1) { clearTimeout(this.botTimer); this.botFor = null; return; }
    if (this.botFor === s.turnNo) return;
    this.botFor = s.turnNo;
    clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => {
      if (s !== this.state || s.status !== 'playing' || s.turn !== 1) return;
      const m = botTurn(s, 1, this.level);
      if (m.type === 'swap') swap(s, 1);
      else submit(s, 1, m.placements);
      this.changed();
    }, thinkTime(this.level));
  }
  act(fn) { const res = fn(); if (res && res.ok === false) for (const cb of this.listeners.error) cb({ msg: res.error }); this.changed(); }
  submit(placements) { this.act(() => submit(this.state, 0, placements)); }
  swap() { this.act(() => swap(this.state, 0)); }
  resign() { this.act(() => resign(this.state, 0)); }
  rematch() { startBotGame(this.special); }
  destroy() { clearInterval(this.ticker); clearTimeout(this.botTimer); }
}

const packCache = {};
async function loadSoloPack(size, special) {
  const key = special ? `special-${special}` : `solo-${size}`;
  if (!packCache[key]) {
    const res = await fetch(`puzzles/${key}.json`);
    if (!res.ok) throw new Error('Could not load puzzles');
    packCache[key] = await res.json();
  }
  return packCache[key];
}

async function startBotGame(special) {
  leaveGame();
  let pack;
  try { pack = await loadSoloPack(prefs.size, special); } catch (e) { return toast(e.message, 'bad'); }
  let played = [];
  try { played = JSON.parse(store.get('cc.played') || '[]'); } catch { /* ignore */ }
  const fresh = pack.puzzles.filter((p) => !played.includes(p.id));
  const list = fresh.length ? fresh : pack.puzzles;
  const puzzle = list[Math.floor(Math.random() * list.length)];
  store.set('cc.played', JSON.stringify([...played, puzzle.id].slice(-400)));
  game = new LocalGame(puzzle, prefs.level, playerName(), prefs.timer, special);
  ui.mode = 'bot';
  bindGame(game);
  show('game');
  maybeCoach();
}

// ------------------------------------------------------------------ remote room
function enterRoom(code) {
  leaveGame();
  try { history.replaceState(null, '', `?room=${code}`); } catch { /* sandboxed */ }
  const link = `${location.origin}${location.pathname}?room=${code}`;
  $('#lobby-code').textContent = code;
  $('#lobby-link').textContent = link;
  $('#copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied', 'good'); } catch { toast(link); }
  };
  $('#share-link').classList.toggle('hidden', !navigator.share);
  $('#share-link').onclick = () => navigator.share?.({ title: 'CrossClash', text: `Join my CrossClash room: ${code}`, url: link }).catch(() => {});
  $('#lobby-status').innerHTML = '<span class="dot"></span> Connecting…';
  $('#lobby-rules').textContent = '';
  show('lobby');
  game = new RemoteGame(code, playerName());
  ui.mode = 'room';
  ui.room = null;
  game.on('room', (room) => {
    ui.room = room;
    $('#lobby-rules').textContent = `${room.title ? `${room.title} · ` : ''}${{ regular: 'Regular', large: 'Large', xl: 'ExtraLarge' }[room.size]} grid · ${TIMER_LABEL[room.timer] ?? ''} per turn`;
    if (!ui.view) {
      $('#lobby-status').innerHTML = room.seats.length < 2 ? '<span class="dot"></span> Waiting for your friend…' : 'Starting…';
    }
    renderPlayers();
    if (ui.view?.status === 'over') renderOver();
  });
  game.on('error', (e) => {
    if (e.fatal) {
      toast(e.msg, 'bad');
      if (!ui.view) $('#lobby-status').textContent = e.msg;
    } else toast(e.msg, e.transient ? '' : 'bad');
  });
  bindGame(game, true);
}

// ------------------------------------------------------------------ game UI
let game = null;
const ui = {
  view: null, sel: null, dir: 'across', armed: null, lastEvent: 0, cluesByAt: new Map(), mode: 'bot',
  showSolution: false, staged: [], stagedFor: null, autoSubmitted: null,
  pencil: false, notes: new Map(), notesKey: '',
};

// ------------------------------------------------------------------ pencil notes
// Draft letters a player jots on empty squares. They live only in this
// browser: never sent to the server or the opponent, and ignored by scoring.
function loadNotes(key) {
  ui.notesKey = key;
  ui.notes = new Map();
  try {
    const saved = JSON.parse(store.get('cc.notes') || 'null');
    if (saved && saved.key === key) ui.notes = new Map(Object.entries(saved.notes));
  } catch { /* ignore a damaged entry */ }
}
function saveNotes() {
  store.set('cc.notes', JSON.stringify({ key: ui.notesKey, notes: Object.fromEntries(ui.notes) }));
}
function canNote(r, c) { return ui.view && ui.view.status === 'playing' && isEmpty(r, c); }
function writeNote(letter) {
  if (!ui.sel || !canNote(...ui.sel)) return;
  ui.notes.set(ui.sel.join(','), letter);
  saveNotes();
  advanceNote(1);
  render();
}
function eraseNote() {
  if (!ui.sel) return;
  const k = ui.sel.join(',');
  if (ui.notes.has(k)) ui.notes.delete(k);
  else { advanceNote(-1); ui.notes.delete(ui.sel.join(',')); }
  saveNotes();
  render();
}
// step along the active word to the next (or previous) empty square
function advanceNote(step) {
  const cl = activeClue();
  if (!cl) return;
  const cells = cellsOfClue(cl);
  const idx = cells.findIndex(([a, b]) => a === ui.sel[0] && b === ui.sel[1]);
  for (let k = idx + step; k >= 0 && k < cells.length; k += step) {
    if (isEmpty(...cells[k])) { ui.sel = cells[k]; return; }
  }
}
function setPencil(on) {
  ui.pencil = on;
  const b = $('#btn-pencil');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  if (on) { ui.armed = null; focusPencil(); } else $('#pencil-input').blur();
  render();
}
// a hidden text field brings up the phone keyboard while pencil mode is on
const PENCIL_SENTINEL = '  ';
function focusPencil() {
  const inp = $('#pencil-input');
  inp.value = PENCIL_SENTINEL;
  inp.focus({ preventScroll: true });
}


function leaveGame() {
  if (game) game.destroy();
  game = null;
  ui.view = null;
  ui.staged = [];
  if (ui.pencil) setPencil(false);
  for (const d of $$('dialog')) if (d.open) d.close();
  $('#coach').classList.add('hidden');
}

function bindGame(g, remote = false) {
  g.on('view', (view) => {
    const first = !ui.view || ui.view.puzzle.id !== view.puzzle.id;
    const wasOver = ui.view?.status === 'over';
    ui.view = view;
    const turnKey = `${view.turnNo}:${view.turn}`;
    if (ui.stagedFor !== turnKey) { ui.staged = []; ui.armed = null; ui.stagedFor = turnKey; }
    if (first) {
      logSeen[0] = 0; logSeen[1] = 0;
      $$('.log ol').forEach((ol) => { ol.innerHTML = ''; });
      buildBoard(view);
      loadNotes(`${remote ? game.code || 'room' : 'bot'}:${view.puzzle.id}`);
      rememberClues(view.puzzle.clues.map((c) => clueHash(c.text)));
      ui.lastEvent = view.events.at(-1)?.n ?? 0;
      ui.showSolution = false;
      if ($('#dlg-over').open) $('#dlg-over').close();
      if (remote) show('game');
      requestAnimationFrame(sizeBoard);
    } else playEvents(view);
    render();
    if (view.status === 'over' && (!wasOver || first)) setTimeout(renderOver, 1200);
  });
  g.on('error', (e) => { if (!remote) toast(e.msg, 'bad'); });
}

function buildBoard(view) {
  const { puzzle } = view;
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
        const tx = document.createElement('span');
        tx.className = 'tx';
        tx.textContent = cl.text;
        ct.appendChild(tx);
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

// The board fills the space between the clue bar and the hand. Cells may be a
// little wider or taller than square, which gives clue text more room.
function sizeBoard() {
  if (!ui.view) return;
  const { w, h } = ui.view.puzzle;
  const wrap = $('.board-wrap');
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  const after = $('.actions').getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom;
  const availH = Math.max(window.innerHeight - top - after - 10, h * 22);
  const availW = $('.centre').clientWidth;
  const frame = 8, gap = 2;
  let cw = (availW - frame - (w - 1) * gap) / w;
  let ch = (availH - frame - (h - 1) * gap) / h;
  cw = Math.min(cw, 72, ch * 1.6);
  ch = Math.min(ch, 66, cw * 1.3);
  cw = Math.max(20, Math.floor(cw)); ch = Math.max(20, Math.floor(ch));
  const st = document.documentElement.style;
  st.setProperty('--cell-w', `${cw}px`);
  st.setProperty('--cell-h', `${ch}px`);
  st.setProperty('--cell-size', `${Math.min(cw, ch)}px`);
  fitClues(Math.min(15, Math.max(8, ch * 0.3, cw * 0.22)));
}

// Each clue gets the largest font that fits its half of the square without
// breaking a word. Only very long words fall back to breaking mid-word.
function fitClues(max) {
  for (const ct of $$('#board .ct')) {
    const tx = ct.firstChild;
    ct.classList.remove('tight');
    const fits = (px) => {
      ct.style.fontSize = `${px}px`;
      return tx.offsetHeight <= ct.clientHeight - 1 && tx.scrollWidth <= tx.clientWidth;
    };
    let lo = 6.5, hi = max;
    if (fits(hi)) continue;
    if (!fits(lo)) { ct.classList.add('tight'); continue; }
    while (hi - lo > 0.4) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    fits(lo);
  }
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(sizeBoard, 80); });
document.fonts?.ready.then(() => sizeBoard());

// ------------------------------------------------------------------ magnifier
// Hovering a clue square (or tapping one on a touch screen) shows its clues
// in large type. The magnifier button turns it on or off.
const loupe = $('#loupe');
let loupeOn = store.get('cc.loupe') !== 'off';
function hideLoupe() { loupe.classList.add('hidden'); loupe.dataset.at = ''; }
function syncLoupeButton() {
  const b = $('#btn-loupe');
  b.setAttribute('aria-pressed', String(loupeOn));
  b.classList.toggle('on', loupeOn);
  b.title = loupeOn ? 'Magnifier on' : 'Magnifier off';
  if (!loupeOn) hideLoupe();
}
function showLoupe(cell) {
  const at = `${cell.dataset.r},${cell.dataset.c}`;
  const list = ui.cluesByAt?.get(at) || [];
  if (!loupeOn || !list.length) return hideLoupe();
  if (loupe.dataset.at === at && !loupe.classList.contains('hidden')) return;
  loupe.dataset.at = at;
  loupe.replaceChildren(...list.map((cl) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    const ar = document.createElement('b'); ar.textContent = ARROW[cl.arrow];
    const tx = document.createElement('span'); tx.textContent = cl.text;
    row.append(ar, tx);
    return row;
  }));
  loupe.classList.remove('hidden');
  const r = cell.getBoundingClientRect(), l = loupe.getBoundingClientRect();
  const x = Math.min(Math.max(8, r.left + r.width / 2 - l.width / 2), window.innerWidth - l.width - 8);
  const above = r.top - l.height - 10;
  loupe.style.left = `${x}px`;
  loupe.style.top = `${above >= 8 ? above : r.bottom + 10}px`;
}
$('#btn-loupe').addEventListener('click', () => {
  loupeOn = !loupeOn;
  store.set('cc.loupe', loupeOn ? 'on' : 'off');
  syncLoupeButton();
  toast(loupeOn ? 'Magnifier on' : 'Magnifier off');
});
syncLoupeButton();
$('#board').addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const cell = e.target.closest('.cell.sq');
  if (cell) showLoupe(cell); else hideLoupe();
});
$('#board').addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideLoupe(); });
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  const cell = e.target.closest?.('#board .cell.sq');
  if (cell) showLoupe(cell); else hideLoupe();
});
window.addEventListener('scroll', hideLoupe, { passive: true });

function cellEl(r, c) { return $('#board').children[r * ui.view.puzzle.w + c]; }
function wordsAt(r, c) { return ui.view.puzzle.clues.filter((cl) => cellsOfClue(cl).some(([a, b]) => a === r && b === c)); }
function myTurn() { return ui.view && ui.view.status === 'playing' && ui.view.turn === ui.view.you; }
const stagedAt = (r, c) => ui.staged.find((s) => s.r === r && s.c === c);
const isEmpty = (r, c) => ui.view.owner[r * ui.view.puzzle.w + c] === -1;
function myRack() { return ui.view.players[ui.view.you].rack || []; }
function letterAt(r, c) {
  const v = ui.view;
  const s = stagedAt(r, c);
  return v.board[r * v.puzzle.w + c] || (s ? myRack()[s.i] : '');
}

function stage(i, r, c) {
  if (!myTurn() || !isEmpty(r, c)) return false;
  ui.staged = ui.staged.filter((s) => !(s.r === r && s.c === c) && s.i !== i);
  ui.staged.push({ i, r, c });
  return true;
}
function unstage(r, c) { ui.staged = ui.staged.filter((s) => !(s.r === r && s.c === c)); }

function doSubmit() {
  if (!myTurn()) return;
  const placements = ui.staged.map(({ i, r, c }) => ({ i, r, c }));
  ui.armed = null;
  ui.autoSubmitted = ui.stagedFor;
  game.submit(placements);
}

function render() {
  const v = ui.view;
  if (!v) return;
  const { w } = v.puzzle;
  const me = v.you;
  const board = $('#board');
  board.classList.toggle('armed', ui.armed != null && myTurn());
  board.classList.toggle('solution', ui.showSolution);
  board.classList.toggle('pencil', ui.pencil);
  let notesDirty = false;
  const selWord = ui.sel ? activeClue() : null;
  const wordCells = new Set(selWord ? cellsOfClue(selWord).map(([a, b]) => `${a},${b}`) : []);
  const rack = myRack();
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
    const st = owner === -1 ? stagedAt(r, c) : null;
    el.classList.toggle('filled', owner !== -1);
    el.classList.toggle('word', wordCells.has(`${r},${c}`));
    el.classList.toggle('sel', !!ui.sel && ui.sel[0] === r && ui.sel[1] === c);
    const nk = `${r},${c}`;
    if (owner !== -1 && ui.notes.has(nk)) { ui.notes.delete(nk); notesDirty = true; }
    const noteL = owner === -1 && !st && !ui.showSolution ? ui.notes.get(nk) : '';
    let note = el.querySelector('.note');
    if (noteL) {
      if (!note) { note = document.createElement('span'); note.className = 'note'; el.appendChild(note); }
      note.textContent = noteL;
    } else note?.remove();
    let tile = el.querySelector('.tile');
    if (owner !== -1 || st) {
      const cls = st ? 'p0 staged' : owner === 2 ? 'p2' : owner === me ? 'p0' : 'p1';
      const letter = st ? rack[st.i] : v.board[i];
      if (!tile) { tile = document.createElement('div'); el.prepend(tile); }
      const pop = !st && tile.dataset.l !== letter ? ' pop' : '';
      tile.className = `tile ${cls}${pop}`;
      tile.dataset.l = st ? '' : letter;
      tile.textContent = letter;
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
  renderLogs();
  // hand
  const rackEl = $('#rack');
  rackEl.innerHTML = '';
  rackEl.classList.toggle('waiting', !myTurn());
  const used = new Set(ui.staged.map((s) => s.i));
  if (ui.armed != null && (ui.armed >= rack.length || used.has(ui.armed))) ui.armed = null;
  rack.forEach((l, i) => {
    const b = document.createElement('button');
    b.className = 'rtile' + (ui.armed === i ? ' on' : '') + (used.has(i) ? ' used' : '');
    b.textContent = l;
    b.disabled = used.has(i);
    b.setAttribute('aria-label', `Tile ${l}`);
    b.onclick = () => onRackTap(i);
    rackEl.appendChild(b);
  });
  const n = ui.staged.length;
  $('#btn-submit').disabled = !myTurn();
  $('#btn-submit').textContent = n ? `Submit ${n} ${n === 1 ? 'tile' : 'tiles'}` : 'Pass';
  $('#btn-recall').disabled = !myTurn() || !n;
  $('#btn-swap').disabled = !myTurn() || n > 0 || v.bagCount === 0;
  const opp = v.players[1 - me];
  $('#bag-count').textContent = v.bagCount;
  $('#bag-label').classList.toggle('empty', v.bagCount === 0);
  $('#opp-tiles').textContent = `${opp.name} holds ${opp.rackCount}`;
  if (notesDirty) saveNotes();
  renderClueBar();
}

function renderPlayers() {
  const v = ui.view;
  if (!v) return;
  const me = v.you;
  [me, 1 - me].forEach((pi, slot) => {
    const p = v.players[pi];
    const el = $(`#p${slot}`);
    $('.pname', el).textContent = p.name;
    $('.avatar', el).textContent = p.kind === 'bot' ? '🤖' : (p.name.trim()[0] || '?').toUpperCase();
    const sc = $('.pscore', el);
    if (sc.textContent !== String(p.score)) { sc.textContent = p.score; sc.classList.remove('bump'); void sc.offsetWidth; sc.classList.add('bump'); }
    $('.ptag', el).textContent = p.kind === 'bot' ? `🤖 ${BOT_LEVELS[p.level]?.label || ''} bot` : slot === 0 ? 'You' : 'Friend';
    el.classList.toggle('turn', v.status === 'playing' && v.turn === pi);
    const online = ui.mode === 'room' && ui.room ? ui.room.seats[pi]?.online !== false : true;
    el.classList.toggle('offline', !online);
  });
  $('#turn-label').textContent = v.status === 'over' ? 'Game over' : myTurn() ? 'Your turn' : `${v.players[1 - me].name}'s turn`;
}

// ------------------------------------------------------------------ score logs
const logSeen = [0, 0];
function renderLogs() {
  const v = ui.view;
  const me = v.you;
  [me, 1 - me].forEach((pi, slot) => {
    const box = $(`#log${slot}`);
    $('.log-name', box).textContent = v.players[pi].name;
    const moves = (v.log || []).filter((m) => m.p === pi);
    const ol = $('ol', box);
    if (moves.length === logSeen[slot] && ol.childElementCount) return;
    logSeen[slot] = moves.length;
    ol.innerHTML = moves.length ? '' : '<li class="empty">No moves yet.</li>';
    for (const m of moves.slice().reverse()) ol.appendChild(moveItem(m));
  });
}
function moveItem(m) {
  const li = document.createElement('li');
  li.className = 'move';
  const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  const cls = m.points > 0 ? 'pos' : m.points < 0 ? 'neg' : 'zero';
  const lines = [];
  const line = (label, value, kind = '') => lines.push(`<div class="line ${kind}"><span>${label}</span><b>${value}</b></div>`);
  if (m.type === 'submit') {
    const b = m.breakdown;
    line(`Letters placed (${m.correct})`, sign(b.letters));
    if (b.words) {
      line(`Words made (${b.words})`, sign(b.words));
      lines.push(`<div class="words">${m.words.map((x) => escapeHtml(x.word)).join(', ')}</div>`);
      line(`Letters in words (${m.words.map((x) => x.len).join('+')})`, sign(b.wordLetters));
    }
    if (b.fullHand) line('All 5 tiles correct', sign(b.fullHand), 'bonus');
    if (b.wrong) line(`Wrong tiles (${-b.wrong})`, sign(b.wrong), 'minus');
  } else {
    line({ pass: 'Passed', swap: 'Swapped tiles', timeout: 'Ran out of time', resign: 'Resigned', skip: 'No tiles left, skipped' }[m.type] || m.type, '0');
  }
  li.innerHTML = `<div class="move-head"><span class="turn-no">Turn ${m.turn}</span><span class="pts ${cls}">${sign(m.points)}</span></div>${lines.join('')}<div class="total">Total ${m.score}</div>`;
  return li;
}

function activeClue() {
  if (!ui.sel) return null;
  const ws = wordsAt(ui.sel[0], ui.sel[1]);
  return ws.find((cl) => cl.dir === ui.dir) || ws[0] || null;
}

function renderClueBar() {
  const bar = $('#clue-bar');
  const v = ui.view;
  if (ui.pencil && !ui.sel) {
    bar.textContent = 'Pencil: tap an empty square and type. Only you see notes. Backspace erases.';
    return;
  }
  if (!ui.sel) {
    bar.textContent = myTurn()
      ? (ui.armed != null ? 'Now tap the square where this tile goes.' : 'Lay out your tiles, then press Submit. Tap a square to read its clue.')
      : 'Waiting for your opponent…';
    return;
  }
  const [r, c] = ui.sel;
  const active = activeClue();
  bar.innerHTML = '';
  for (const cl of wordsAt(r, c)) {
    const s = document.createElement('span');
    s.className = 'cl' + (active && active.id === cl.id ? ' active' : '');
    const pattern = cellsOfClue(cl).map(([a, b]) => letterAt(a, b) || '·').join('');
    s.innerHTML = `<b>${DIR_WORD[cl.dir]}</b>${escapeHtml(cl.text)} <span class="mono small">${pattern} (${cl.len})</span>`;
    bar.appendChild(s);
  }
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// timer: also auto-submits whatever is laid out when time runs out
setInterval(() => {
  const v = ui.view;
  if (!v || !game) return;
  const timerEl = $('.timer');
  if (!v.turnSeconds || !v.deadline || v.status !== 'playing') {
    timerEl.classList.toggle('hidden', !v.turnSeconds);
    $('#timer-text').textContent = v.turnSeconds ? '' : 'No timer';
    return;
  }
  timerEl.classList.remove('hidden');
  const left = Math.max(0, v.deadline - game.now());
  const frac = left / (v.turnSeconds * 1000);
  const bar = $('#timer-bar');
  bar.style.width = `${frac * 100}%`;
  bar.classList.toggle('low', frac < 0.2);
  $('#timer-text').textContent = `${Math.ceil(left / 1000)}s`;
  if (left <= 0 && myTurn() && ui.autoSubmitted !== ui.stagedFor) {
    if (ui.staged.length) toast('Time is up. Your tiles were submitted.');
    doSubmit();
  }
}, 250);

// ------------------------------------------------------------------ input
$('#board').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell || !ui.view) return;
  const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
  const v = ui.view;
  if (v.owner[r * v.puzzle.w + c] === 3) {
    const list = ui.cluesByAt.get(`${r},${c}`) || [];
    if (!list.length) return;
    // tapping a clue square selects the first open square of its word
    const ct = e.target.closest('.ct');
    const cl = ct ? v.puzzle.clues[Number(ct.dataset.clue)] : list[0];
    const cells = cellsOfClue(cl);
    ui.sel = cells.find(([a, b]) => isEmpty(a, b) && !stagedAt(a, b)) || cells[0];
    ui.dir = cl.dir;
    if (ui.pencil) focusPencil();
    render();
    return;
  }
  if (ui.pencil) {
    if (ui.sel && ui.sel[0] === r && ui.sel[1] === c) {
      if (wordsAt(r, c).length > 1) ui.dir = ui.dir === 'across' ? 'down' : 'across';
    } else {
      ui.sel = [r, c];
      const ws = wordsAt(r, c);
      if (ws.length === 1) ui.dir = ws[0].dir;
    }
    focusPencil();
    render();
    return;
  }
  if (ui.armed != null && isEmpty(r, c) && myTurn()) {
    stage(ui.armed, r, c);
    ui.armed = null;
    ui.sel = [r, c];
    render();
    return;
  }
  if (stagedAt(r, c) && myTurn()) {
    // tapping a tile you laid out this turn takes it back
    unstage(r, c);
    ui.sel = [r, c];
    render();
    return;
  }
  if (ui.sel && ui.sel[0] === r && ui.sel[1] === c) {
    if (wordsAt(r, c).length > 1) ui.dir = ui.dir === 'across' ? 'down' : 'across';
  } else {
    ui.sel = [r, c];
    const ws = wordsAt(r, c);
    if (ws.length === 1) ui.dir = ws[0].dir;
  }
  render();
});

function onRackTap(i) {
  if (ui.pencil) setPencil(false);
  if (!myTurn()) return toast('Wait for your turn');
  if (ui.sel && isEmpty(ui.sel[0], ui.sel[1]) && !stagedAt(ui.sel[0], ui.sel[1]) && ui.armed == null) {
    stage(i, ui.sel[0], ui.sel[1]);
    advance();
    render();
    return;
  }
  ui.armed = ui.armed === i ? null : i;
  render();
}

function advance() {
  // move the selection to the next open square of the active word
  const cl = activeClue();
  if (!cl) return;
  const cells = cellsOfClue(cl);
  const idx = cells.findIndex(([a, b]) => a === ui.sel[0] && b === ui.sel[1]);
  for (let k = idx + 1; k < cells.length; k++) {
    const [a, b] = cells[k];
    if (isEmpty(a, b) && !stagedAt(a, b)) { ui.sel = [a, b]; return; }
  }
}

document.addEventListener('keydown', (e) => {
  if (document.body.dataset.screen !== 'game' || !ui.view || $$('dialog').some((d) => d.open)) return;
  if (e.target.matches('input:not(#pencil-input)')) return;
  const v = ui.view;
  const k = e.key.toUpperCase();
  if (ui.pencil && /^[A-Z]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return writeNote(k); }
  if (ui.pencil && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); return eraseNote(); }
  if (ui.pencil && e.key === 'Enter') return;
  if (/^[A-Z]$/.test(k) && ui.sel && myTurn()) {
    const [r, c] = ui.sel;
    if (!isEmpty(r, c)) return;
    const used = new Set(ui.staged.filter((s) => !(s.r === r && s.c === c)).map((s) => s.i));
    const ri = myRack().findIndex((l, i) => l === k && !used.has(i));
    if (ri < 0) return toast(`No ${k} in your hand`);
    stage(ri, r, c);
    advance();
    render();
    e.preventDefault();
  } else if (e.key === 'Backspace' && ui.sel && myTurn()) {
    unstage(ui.sel[0], ui.sel[1]);
    render();
    e.preventDefault();
  } else if (e.key === 'Enter' && myTurn()) {
    doSubmit();
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
  } else if (e.key === 'Escape') { ui.armed = null; ui.sel = null; if (ui.pencil) setPencil(false); render(); }
});

// phone keyboards often send no usable key code, so read the hidden field instead
$('#pencil-input').addEventListener('input', () => {
  const inp = $('#pencil-input');
  const val = inp.value;
  inp.value = PENCIL_SENTINEL;
  if (!ui.pencil) return;
  if (val.length < PENCIL_SENTINEL.length) return eraseNote();
  for (const ch of val.replace(/[^a-z]/gi, '').toUpperCase()) writeNote(ch);
});
$('#btn-pencil').addEventListener('click', () => {
  setPencil(!ui.pencil);
  toast(ui.pencil ? 'Pencil on. Notes are only visible to you.' : 'Pencil off');
});

$('#btn-submit').addEventListener('click', doSubmit);
$('#btn-recall').addEventListener('click', () => { ui.staged = []; ui.armed = null; render(); });
$('#btn-swap').addEventListener('click', () => { ui.armed = null; game?.swap(); });
$('#btn-menu').addEventListener('click', () => $('#dlg-menu').showModal());
$('#dlg-menu').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  $('#dlg-menu').close();
  if (act === 'howto') $('#dlg-howto').showModal();
  if (act === 'clear-notes') { ui.notes.clear(); saveNotes(); render(); toast('Pencil notes cleared'); }
  if (act === 'resign' && ui.view?.status === 'playing') game.resign();
  if (act === 'home') goHome();
});

// ------------------------------------------------------------------ feedback
function flashWrong(list) {
  for (const { r, c, letter } of list) {
    const el = cellEl(r, c);
    if (!el) continue;
    el.dataset.miss = letter;
    el.classList.remove('miss'); void el.offsetWidth; el.classList.add('miss');
    setTimeout(() => el.classList.remove('miss'), 1500);
  }
}

function playEvents(view) {
  const me = view.you;
  for (const ev of view.events) {
    if (ev.n <= ui.lastEvent) continue;
    ui.lastEvent = ev.n;
    const mine = ev.p === me;
    const who = mine ? 'You' : view.players[ev.p]?.name;
    if (ev.type === 'submit') {
      flashWrong(ev.wrong);
      const sign = ev.points >= 0 ? '+' : '−';
      toast(`${mine ? 'You' : who} ${sign}${Math.abs(ev.points)}${ev.breakdown.fullHand ? ' · all 5 bonus!' : ''}`, mine ? (ev.points >= 0 ? 'good' : 'bad') : '');
    } else if (ev.type === 'pass') {
      if (!mine) toast(`${who} passed`);
    } else if (ev.type === 'timeout') {
      toast(mine ? 'Time is up. Turn over.' : `${who} ran out of time`, mine ? 'bad' : '');
    } else if (ev.type === 'skip') {
      toast(mine ? 'No tiles left. Your turn is skipped.' : `${who} has no tiles left`);
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
  const [mine, theirs] = [v.players[me], v.players[1 - me]];
  $('#over-title').textContent = v.winner === -1 ? "It's a draw" : v.winner === me ? 'You win!' : `${theirs.name} wins`;
  let detail = `${mine.score} – ${theirs.score}. You placed ${mine.correct} tiles and finished ${mine.words} words.`;
  if (v.endReason === 'resign') detail += v.winner === me ? ' Your opponent resigned.' : ' You resigned.';
  if (v.endReason === 'stalled') detail += ' The game stopped after 20 turns in a row without a correct tile.';
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
$('#over-board').addEventListener('click', () => { ui.showSolution = true; $('#dlg-over').close(); render(); });
$('#over-home').addEventListener('click', () => { $('#dlg-over').close(); goHome(); });

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

// ------------------------------------------------------------------ first-game coach
const COACH = [
  `These are your ${HAND_SIZE} tiles. Every one of them belongs somewhere in this grid.`,
  'Shaded squares hold clues. The arrow shows where the answer starts and which way it runs. Tap any square to read its clues above the grid.',
  'Tap a tile, then a square, to lay it down (or tap a square and type). Nothing is checked yet, and you can tap a tile to take it back.',
  'Press Submit when you are ready. Right tiles stay for +1, wrong ones come back to your hand for −1. Finished words add +1 each plus their length, and using all 5 tiles adds +5.',
];
function maybeCoach() {
  if (store.get('cc.coached2')) return;
  let step = 0;
  const el = $('#coach');
  const draw = () => {
    el.innerHTML = `<div>${COACH[step]}</div><button>${step < COACH.length - 1 ? 'Next' : 'Let’s play'}</button>`;
    $('button', el).onclick = () => {
      step++;
      if (step >= COACH.length) { el.classList.add('hidden'); store.set('cc.coached2', '1'); } else draw();
    };
  };
  el.classList.remove('hidden');
  draw();
}

// ------------------------------------------------------------------ boot
const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
show('home');
if (roomParam.length === 6) {
  $('#join-code').value = roomParam;
  if (store.get('cc.name')) roomInfo(roomParam).then(() => enterRoom(roomParam)).catch((e) => toast(e.message, 'bad'));
  else { nameInput.focus(); toast('Enter your name, then press Join'); }
}
