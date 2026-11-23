'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find((f) => fs.existsSync(f)) || path.join(__dirname, 'index.html');
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200);
    return res.end('ok');
  }
  fs.readFile(INDEX, (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end('index.html not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function broadcast(room) {
  room.seats.forEach((s, i) => {
    if (!s.bot && s.ws && s.ws.readyState === 1) {
      try {
        s.ws.send(JSON.stringify(room.view(i)));
      } catch (e) {}
    }
  });
}

const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let room = null;
  let token = null;

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (m.t === 'ping') return send(ws, { t: 'pong' });
    if (m.t === 'join') {
      if (room) return;
      const code = String(m.room || '').replace(/\D/g, '').slice(0, 8);
      if (code.length < 4) return send(ws, { t: 'err', msg: 'Неверный код стола' });
      let r = rooms.get(code);
      if (!r) {
        if (rooms.size > 500) return send(ws, { t: 'err', msg: 'Сервер перегружен, попробуйте позже' });
        r = new Room(code, broadcast);
        rooms.set(code, r);
      }
      token = typeof m.token === 'string' && /^[\w-]{8,40}$/.test(m.token) ? m.token : crypto.randomBytes(12).toString('hex');
      const name = cleanName(m.name) || 'Игрок';
      const res = r.join(token, name, ws);
      if (res.err) return send(ws, { t: 'err', msg: res.err, fatal: true });
      room = r;
      send(ws, { t: 'joined', token });
      room.changed();
      return;
    }
    if (room) room.handle(token, m);
  });

  ws.on('close', () => {
    if (room) room.leave(ws);
  });
  ws.on('error', () => {});
});

// keep-alive (прокси хостингов рвут «молчащие» соединения) и уборка пустых комнат
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (!r.hasLive() && now - r.touched > 6 * 3600 * 1000) {
      r.clearTimers();
      rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => console.log('Дырка онлайн: http://localhost:' + PORT));
