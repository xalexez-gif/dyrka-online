'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');
const { DurakRoom } = require('./durak');
const { KozelRoom } = require('./kozel');
const GAMES = { dyrka: Room, durak: DurakRoom, kozel: KozelRoom };
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find((f) => fs.existsSync(f)) || path.join(__dirname, 'index.html');
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SECRET) console.warn('SECRET не задан: входы будут сбрасываться при перезапуске сервера');
const rooms = new Map();
let store;

/* ---------- токены входа ---------- */
const mac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
function signToken(id) {
  const body = id + '.' + (Date.now() + 30 * 864e5);
  return body + '.' + mac(body);
}
function verifyToken(t) {
  const p = String(t || '').split('.');
  if (p.length !== 3) return null;
  const good = Buffer.from(mac(p[0] + '.' + p[1]));
  const got = Buffer.from(p[2]);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  if (+p[1] < Date.now()) return null;
  return +p[0] || null;
}

/* ---------- ограничение частоты ---------- */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < ms);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3);

/* ---------- HTTP ---------- */
function readJson(req, limit = 120000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const authUser = async (req) => {
  const h = String(req.headers.authorization || '');
  const id = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  return id ? store.getUser(id) : null;
};

async function api(req, res, url) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/leaderboard') return json(res, 200, { top: await store.leaderboard(20) });
    if (req.method === 'GET' && p.startsWith('/api/avatar/')) {
      const img = await store.getAvatarData(p.slice(12));
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      return res.end(img.buf);
    }
    if (req.method === 'GET' && p === '/api/me') {
      const u = await authUser(req);
      return u ? json(res, 200, { user: u }) : json(res, 401, { err: 'Нужно войти' });
    }
    if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      if (limited(p + ip, 12, 10 * 60e3)) return json(res, 429, { err: 'Слишком много попыток, подождите несколько минут' });
      const b = await readJson(req, 4000);
      const r = p === '/api/register' ? await store.register(b.username, b.password) : await store.login(b.username, b.password);
      if (r.err) return json(res, 400, { err: r.err });
      return json(res, 200, { token: signToken(r.user.id), user: r.user });
    }
    if (req.method === 'POST' && p === '/api/avatar') {
      const u = await authUser(req);
      if (!u) return json(res, 401, { err: 'Нужно войти' });
      if (limited('av' + u.id, 20, 10 * 60e3)) return json(res, 429, { err: 'Слишком часто, подождите' });
      const b = await readJson(req);
      const r = await store.setAvatar(u.id, b.kind, b.kind === 'preset' ? b.value : b.data);
      return r.err ? json(res, 400, { err: r.err }) : json(res, 200, { user: r.user });
    }
    return json(res, 404, { err: 'Не найдено' });
  } catch (e) {
    console.error('api error', p, e && e.message);
    return json(res, 500, { err: 'Ошибка сервера, попробуйте ещё раз' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- рейтинг ---------- */
async function rateKon(room) {
  const seats = room.seats, n = seats.length;
  const rated = seats.filter((s) => !s.bot).length >= 2; // рейтинг меняется, только если за столом минимум двое людей
  room.lastRated = rated;
  const R = seats.map((s) => (s.uid && s.rating != null ? s.rating : 1000));
  const delta = seats.map(() => 0);
  const K = 32 / (n - 1);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = seats[i].place < seats[j].place ? 1 : 0;
      const ei = 1 / (1 + Math.pow(10, (R[j] - R[i]) / 400));
      delta[i] += K * (si - ei);
      delta[j] += K * (1 - si - (1 - ei));
    }
  }
  await Promise.all(seats.map(async (s, i) => {
    if (!s.uid) return;
    const d = rated ? Math.round(delta[i]) : 0;
    try {
      const nr = await store.applyResult(s.uid, { delta: d, place: s.place, n, rated });
      if (nr != null) s.rating = nr;
      s.lastDelta = d;
    } catch (e) { console.error('applyResult', e.message); }
  }));
}

async function refreshProfile(room, i) {
  const s = room.seats[i];
  if (!s || !s.uid) return;
  const u = await store.getUser(s.uid);
  if (u) { s.avatar = u.avatar; s.rating = u.rating; room.changed(); }
}

function broadcast(room) {
  room.seats.forEach((s, i) => {
    if (!s.bot && s.ws && s.ws.readyState === 1) {
      try { s.ws.send(JSON.stringify(room.view(i))); } catch (e) {}
    }
  });
}

/* ---------- WebSocket ---------- */
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);

function attach() {
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    let room = null, token = null, joining = false;

    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'ping') return send(ws, { t: 'pong' });
      if (m.t === 'join') {
        if (room || joining) return;
        joining = true;
        try {
          const code = String(m.room || '').replace(/\D/g, '').slice(0, 8);
          if (code.length < 4) return send(ws, { t: 'err', msg: 'Неверный код стола' });
          let user = null;
          if (m.auth) { const id = verifyToken(m.auth); if (id) user = await store.getUser(id); }
          if (ws.readyState !== 1) return;
          let r = rooms.get(code);
          if (!r) {
            if (rooms.size > 500) return send(ws, { t: 'err', msg: 'Сервер перегружен, попробуйте позже' });
            const gk = GAMES[m.game] ? m.game : 'dyrka';
            r = new GAMES[gk](code, broadcast);
            if (gk === 'dyrka') r.onKonEnd = rateKon;
            r.onProfile = refreshProfile;
            rooms.set(code, r);
          }
          token = user ? 'u:' + user.id : typeof m.token === 'string' && /^[\w-]{8,40}$/.test(m.token) ? m.token : crypto.randomBytes(12).toString('hex');
          const name = user ? user.username : cleanName(m.name) || 'Гость';
          const res = r.join(token, name, ws, user ? { uid: user.id, rating: user.rating, avatar: user.avatar } : {});
          if (res.err) return send(ws, { t: 'err', msg: res.err, fatal: true });
          room = r;
          send(ws, { t: 'joined', token: user ? null : token, uid: user ? user.id : null });
          room.changed();
        } finally { joining = false; }
        return;
      }
      if (room) room.handle(token, m);
    });
    ws.on('close', () => { if (room) room.leave(ws); });
    ws.on('error', () => {});
  });

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
    const now = Date.now();
    for (const [code, r] of rooms) {
      if (!r.hasLive() && now - r.touched > 6 * 3600 * 1000) { r.clearTimers(); rooms.delete(code); }
    }
  }, 25000);
}

(async () => {
  store = await createStore();
  attach();
  server.listen(PORT, () => console.log('Дырка онлайн: http://localhost:' + PORT));
})().catch((e) => { console.error('Не удалось запустить сервер:', e); process.exit(1); });

module.exports = { server };
