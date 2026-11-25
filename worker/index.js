// CrossClash server: one Cloudflare Worker that serves the static game from
// /public and hosts private 1v1 rooms, one Durable Object per room.
//
//   POST /api/rooms            {size, timer, special?}  -> {code}
//   GET  /api/rooms/:code              -> {exists, size, seats}
//   GET  /api/rooms/:code/ws           WebSocket (see public/js/net.js for the protocol)
//
// Rooms use the WebSocket Hibernation API, so an idle room costs nothing while
// players think. Turn timers and room expiry use Durable Object alarms.

import { newGame, submit, swap, resign, tick, viewFor, TIMER_CHOICES, TIMEOUT_GRACE_MS } from '../public/js/engine.js';
import regular from '../puzzles/regular.json';
import large from '../puzzles/large.json';
import xl from '../puzzles/xl.json';
import thanksgiving from '../public/puzzles/special-thanksgiving.json';

// themed one-off puzzles a room can be created with; add new specials here
const SPECIALS = { thanksgiving };

// every 4th puzzle is published for solo play, so rooms only use the others
const ROOM_PUZZLES = Object.fromEntries(
  Object.entries({ regular, large, xl }).map(([k, pack]) => [k, pack.puzzles.filter((_, i) => i % 4 !== 0)]),
);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // a room lives 6 hours after its last activity

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return env.ASSETS.fetch(request);

    if (parts[1] === 'rooms' && parts.length === 2 && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const special = Object.hasOwn(SPECIALS, body.special) ? body.special : '';
      const size = special ? SPECIALS[special].size : ROOM_PUZZLES[body.size] ? body.size : 'regular';
      const timer = TIMER_CHOICES.includes(Number(body.timer)) ? Number(body.timer) : 60;
      for (let attempt = 0; attempt < 5; attempt++) {
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(`https://room/init?code=${code}&size=${size}&timer=${timer}&special=${special}`, { method: 'POST' });
        if (res.ok) return json({ code, size, timer, special });
      }
      return json({ error: 'Could not create a room, please try again' }, 503);
    }

    if (parts[1] === 'rooms' && parts[2]) {
      const code = parts[2].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'That room code does not look right' }, 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      if (parts[3] === 'ws') return stub.fetch(`https://room/ws`, request);
      return stub.fetch('https://room/info');
    }
    return json({ error: 'Not found' }, 404);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async load() {
    if (!this.room) this.room = (await this.ctx.storage.get('room')) || null;
    return this.room;
  }

  async save() {
    this.room.touched = Date.now();
    await this.ctx.storage.put('room', this.room);
    await this.schedule();
  }

  async schedule() {
    const r = this.room;
    const expiry = r.touched + ROOM_TTL_MS;
    const next = r.game && r.game.status === 'playing' && r.game.deadline ? Math.min(r.game.deadline + TIMEOUT_GRACE_MS + 100, expiry) : expiry;
    await this.ctx.storage.setAlarm(next);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (await this.load()) return json({ error: 'taken' }, 409);
      this.room = {
        code: url.searchParams.get('code'),
        size: url.searchParams.get('size'),
        timer: Number(url.searchParams.get('timer')),
        special: url.searchParams.get('special') || '',
        created: Date.now(),
        seats: [], // [{token, name}]
        game: null,
        rematch: [false, false],
        played: [],
      };
      await this.save();
      return json({ ok: true });
    }
    const room = await this.load();
    if (url.pathname === '/info') {
      if (!room) return json({ exists: false }, 404);
      return json({ exists: true, size: room.size, timer: room.timer, special: room.special || '', seats: room.seats.length, playing: !!room.game });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ seat: null });
      if (!room) {
        server.send(JSON.stringify({ t: 'error', fatal: true, msg: 'This room does not exist or has expired.' }));
        server.close(4404, 'no room');
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  sockets() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, seat: ws.deserializeAttachment()?.seat }));
  }

  online() {
    const on = [false, false];
    for (const { seat } of this.sockets()) if (seat === 0 || seat === 1) on[seat] = true;
    return on;
  }

  broadcast() {
    const r = this.room;
    const online = this.online();
    for (const { ws, seat } of this.sockets()) {
      if (seat !== 0 && seat !== 1) continue;
      this.send(ws, {
        t: 'room',
        code: r.code,
        size: r.size,
        timer: r.timer,
        special: r.special || '',
        title: SPECIALS[r.special]?.title || '',
        seat,
        seats: r.seats.map((s, i) => ({ name: s.name, online: online[i] })),
        rematch: r.rematch,
      });
      if (r.game) this.send(ws, { t: 'state', view: viewFor(r.game, seat), now: Date.now() });
    }
  }

  startGame() {
    const r = this.room;
    const pool = SPECIALS[r.special] ? SPECIALS[r.special].puzzles : ROOM_PUZZLES[r.size];
    const unplayed = pool.filter((p) => !r.played.includes(p.id));
    const list = unplayed.length ? unplayed : pool;
    const puzzle = list[Math.floor(Math.random() * list.length)];
    r.played.push(puzzle.id);
    r.game = newGame(puzzle, r.seats.map((s) => ({ name: s.name, kind: 'human' })), {
      seed: crypto.getRandomValues(new Uint32Array(1))[0],
      turnSeconds: r.timer,
      seenClues: r.seats.flatMap((s) => s.seen || []),
    });
    r.rematch = [false, false];
  }

  async webSocketMessage(ws, raw) {
    const room = await this.load();
    if (!room) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();

    if (msg.t === 'ping') return this.send(ws, { t: 'pong', now });

    if (msg.t === 'hello') {
      const name = String(msg.name || 'Player').replace(/[^\p{L}\p{N} _.\-']/gu, '').trim().slice(0, 16) || 'Player';
      let seat = room.seats.findIndex((s) => msg.token && s.token === msg.token);
      if (seat < 0) {
        if (room.seats.length >= 2) {
          this.send(ws, { t: 'error', fatal: true, msg: 'This room already has two players.' });
          ws.close(4409, 'full');
          return;
        }
        const token = crypto.randomUUID();
        room.seats.push({ token, name });
        seat = room.seats.length - 1;
      } else if (!room.game) {
        room.seats[seat].name = name;
      }
      // hashes of clues this player has already seen, so new games can prefer fresh ones
      if (Array.isArray(msg.seen)) room.seats[seat].seen = msg.seen.filter((x) => typeof x === 'string' && x.length <= 8).slice(-2000);
      ws.serializeAttachment({ seat });
      // a newer tab for the same seat replaces older sockets
      for (const s of this.sockets()) if (s.ws !== ws && s.seat === seat) { s.ws.serializeAttachment({ seat: null }); try { s.ws.close(4000, 'replaced'); } catch {} }
      this.send(ws, { t: 'welcome', seat, token: room.seats[seat].token });
      if (!room.game && room.seats.length === 2) this.startGame();
      await this.save();
      this.broadcast();
      return;
    }

    const seat = att.seat;
    if (seat !== 0 && seat !== 1) return;
    const g = room.game;
    let res = { ok: true };
    if (msg.t === 'rematch') {
      if (!g || g.status !== 'over') return;
      room.rematch[seat] = true;
      if (room.rematch[0] && room.rematch[1]) this.startGame();
    } else if (!g) {
      return;
    } else if (msg.t === 'submit') {
      tick(g, now, TIMEOUT_GRACE_MS);
      const list = Array.isArray(msg.placements) ? msg.placements.slice(0, 5).map((x) => ({ i: Number(x.i), r: Number(x.r), c: Number(x.c) })) : [];
      res = submit(g, seat, list, now);
    } else if (msg.t === 'swap') {
      res = swap(g, seat, now);
    } else if (msg.t === 'resign') {
      res = resign(g, seat);
    } else {
      return;
    }
    if (!res.ok) this.send(ws, { t: 'error', msg: res.error });
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    if (await this.load()) this.broadcast();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    if (now >= room.touched + ROOM_TTL_MS) {
      for (const { ws } of this.sockets()) { this.send(ws, { t: 'error', fatal: true, msg: 'This room has expired.' }); try { ws.close(4410, 'expired'); } catch {} }
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    if (room.game && tick(room.game, now, TIMEOUT_GRACE_MS)) {
      await this.save();
      this.broadcast();
    } else {
      await this.schedule();
    }
  }
}
