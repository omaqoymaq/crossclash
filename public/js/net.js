// Client side of a private 1v1 room.
//
// Protocol (JSON over one WebSocket per player):
//   client -> server  {t:'hello', name, token?}  first message; token re-claims a seat after a reload
//                     {t:'submit', placements:[{i, r, c}]}  hand tile i on square (r,c); [] = pass
//                     {t:'swap'} {t:'resign'} {t:'rematch'} {t:'ping'}
//   server -> client  {t:'welcome', seat, token}
//                     {t:'room', code, size, timer, seat, seats:[{name, online}], rematch:[bool,bool]}
//                     {t:'state', view, now}     view = engine.viewFor(state, seat)
//                     {t:'error', msg, fatal?}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export async function createRoom(size, timer) {
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size, timer }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not create a room');
  return data;
}

export async function roomInfo(code) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That room does not exist or has expired.');
  return data;
}

export class RemoteGame {
  constructor(code, name) {
    this.code = code;
    this.name = name;
    this.listeners = { view: [], room: [], error: [] };
    this.closed = false;
    this.retry = 0;
    this.clockOffset = 0;
    this.connect();
    this.pinger = setInterval(() => this.sendRaw({ t: 'ping' }), 25000);
  }

  on(type, cb) { this.listeners[type].push(cb); return this; }
  emit(type, data) { for (const cb of this.listeners[type]) cb(data); }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${this.code}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.sendRaw({ t: 'hello', name: this.name, token: store.get(`cc.token.${this.code}`) || undefined, seen: seenClues() });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'welcome') { this.seat = msg.seat; store.set(`cc.token.${this.code}`, msg.token); }
      else if (msg.t === 'room') this.emit('room', msg);
      else if (msg.t === 'state') { this.clockOffset = msg.now - Date.now(); this.emit('view', msg.view); }
      else if (msg.t === 'error') { if (msg.fatal) this.closed = true; this.emit('error', msg); }
    };
    ws.onclose = () => {
      if (this.closed) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.emit('error', { msg: 'Connection lost, reconnecting…', transient: true });
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  sendRaw(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  now() { return Date.now() + this.clockOffset; }
  submit(placements) { this.sendRaw({ t: 'submit', placements }); }
  swap() { this.sendRaw({ t: 'swap' }); }
  resign() { this.sendRaw({ t: 'resign' }); }
  rematch() { this.sendRaw({ t: 'rematch' }); }
  destroy() { this.closed = true; clearInterval(this.pinger); try { this.ws.close(); } catch {} }
}

export { store };

/** Hashes of clue texts this browser has already been shown (newest last). */
export function seenClues() {
  try { return JSON.parse(store.get('cc.seenClues') || '[]'); } catch { return []; }
}
export function rememberClues(hashes) {
  const seen = seenClues();
  const have = new Set(seen);
  const add = hashes.filter((h) => !have.has(h));
  if (add.length) store.set('cc.seenClues', JSON.stringify([...seen, ...add].slice(-2000)));
}
