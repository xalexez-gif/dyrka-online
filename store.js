'use strict';
// Хранилище аккаунтов: PostgreSQL (если задан DATABASE_URL) или память (для локальной проверки).
const crypto = require('crypto');

const NAME_RE = /^[\p{L}\p{N}_\- ]{3,16}$/u;
const PRESETS = 12;

const scrypt = (pw, salt) =>
  new Promise((res, rej) => crypto.scrypt(pw, Buffer.from(salt, 'hex'), 32, { N: 16384 }, (e, k) => (e ? rej(e) : res(k.toString('hex')))));

function checkCreds(username, password) {
  const name = String(username || '').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(name)) return { err: 'Логин: 3–16 символов — буквы, цифры, пробел, _ или -' };
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) return { err: 'Пароль: минимум 6 символов' };
  return { name };
}

function pubUser(r) {
  return {
    id: r.id, username: r.username, rating: r.rating, games: r.games, boss: r.boss, dyrka: r.dyrka,
    avatar: r.avatar_kind === 'preset' ? { k: 'preset', v: r.avatar_val } : r.avatar_kind === 'upload' ? { k: 'upload', u: r.id, ver: r.avatar_ver } : null,
  };
}

function parseImage(data) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m || data.length > 70000) return null;
  const buf = Buffer.from(m[2], 'base64');
  const sig = buf.slice(0, 12);
  const isJpg = sig[0] === 0xff && sig[1] === 0xd8;
  const isPng = sig.slice(0, 4).toString('hex') === '89504e47';
  const isWebp = sig.slice(0, 4).toString() === 'RIFF' && sig.slice(8, 12).toString() === 'WEBP';
  const mime = isJpg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : null;
  return mime ? { mime, buf } : null;
}

/* ------------------------------ память ------------------------------ */
function memoryStore() {
  const users = new Map();
  const byName = new Map();
  let next = 1;
  const imgs = new Map();
  return {
    kind: 'memory',
    async init() {},
    async register(username, password) {
      const c = checkCreds(username, password);
      if (c.err) return c;
      if (byName.has(c.name.toLowerCase())) return { err: 'Такой логин уже занят' };
      const salt = crypto.randomBytes(16).toString('hex');
      const u = { id: next++, username: c.name, salt, hash: await scrypt(password, salt), rating: 1000, games: 0, boss: 0, dyrka: 0, avatar_kind: null, avatar_val: null, avatar_ver: 0 };
      users.set(u.id, u);
      byName.set(c.name.toLowerCase(), u.id);
      return { user: pubUser(u) };
    },
    async login(username, password) {
      const id = byName.get(String(username || '').trim().replace(/\s+/g, ' ').toLowerCase());
      const u = users.get(id);
      const salt = u ? u.salt : '00'.repeat(16);
      const h = await scrypt(String(password || ''), salt);
      if (!u || h !== u.hash) return { err: 'Неверный логин или пароль' };
      return { user: pubUser(u) };
    },
    async getUser(id) { const u = users.get(+id); return u ? pubUser(u) : null; },
    async setAvatar(id, kind, value) {
      const u = users.get(+id);
      if (!u) return { err: 'Нет такого аккаунта' };
      if (kind === 'preset') {
        const n = /^p(\d+)$/.exec(String(value));
        if (!n || +n[1] >= PRESETS) return { err: 'Нет такого аватара' };
        u.avatar_kind = 'preset'; u.avatar_val = value;
      } else if (kind === 'upload') {
        const img = parseImage(value);
        if (!img) return { err: 'Нужна картинка JPG, PNG или WebP' };
        imgs.set(u.id, img); u.avatar_kind = 'upload'; u.avatar_val = null;
      } else return { err: 'Неверный запрос' };
      u.avatar_ver++;
      return { user: pubUser(u) };
    },
    async getAvatarData(id) { return imgs.get(+id) || null; },
    async applyResult(id, { delta, place, n, rated }) {
      const u = users.get(+id);
      if (!u) return null;
      u.games++;
      if (place === 1) u.boss++;
      if (place === n) u.dyrka++;
      if (rated) u.rating = Math.max(100, u.rating + delta);
      return u.rating;
    },
    async leaderboard(limit = 20) {
      return [...users.values()].filter((u) => u.games > 0).sort((a, b) => b.rating - a.rating || b.games - a.games).slice(0, limit).map(pubUser);
    },
  };
}

/* ----------------------------- PostgreSQL ----------------------------- */
function pgStore(url) {
  const { Pool } = require('pg');
  let host = '';
  try { host = new URL(url).hostname; } catch (e) {}
  const useSsl = host.includes('.') && host !== 'localhost' && process.env.PGSSL !== 'disable';
  const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, max: 5 });
  pool.on('error', (e) => console.error('pg pool error', e.message));
  const COLS = `id, username, rating, games, boss, dyrka, avatar_kind, avatar_ver, CASE WHEN avatar_kind = 'preset' THEN avatar_val END AS avatar_val`;
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT UNIQUE NOT NULL,
        salt TEXT NOT NULL, hash TEXT NOT NULL,
        avatar_kind TEXT, avatar_val TEXT, avatar_ver INT NOT NULL DEFAULT 0,
        rating INT NOT NULL DEFAULT 1000, games INT NOT NULL DEFAULT 0, boss INT NOT NULL DEFAULT 0, dyrka INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS users_rating_idx ON users (rating DESC)');
    },
    async register(username, password) {
      const c = checkCreds(username, password);
      if (c.err) return c;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await scrypt(password, salt);
      try {
        const r = await pool.query(`INSERT INTO users (username, username_lc, salt, hash) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`, [c.name, c.name.toLowerCase(), salt, hash]);
        return { user: pubUser(r.rows[0]) };
      } catch (e) {
        if (e.code === '23505') return { err: 'Такой логин уже занят' };
        throw e;
      }
    },
    async login(username, password) {
      const lc = String(username || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const r = await pool.query(`SELECT ${COLS}, salt, hash FROM users WHERE username_lc = $1`, [lc]);
      const row = r.rows[0];
      const h = await scrypt(String(password || ''), row ? row.salt : '00'.repeat(16));
      if (!row || h !== row.hash) return { err: 'Неверный логин или пароль' };
      return { user: pubUser(row) };
    },
    async getUser(id) {
      const r = await pool.query(`SELECT ${COLS} FROM users WHERE id = $1`, [+id || 0]);
      return r.rows[0] ? pubUser(r.rows[0]) : null;
    },
    async setAvatar(id, kind, value) {
      let val;
      if (kind === 'preset') {
        const n = /^p(\d+)$/.exec(String(value));
        if (!n || +n[1] >= PRESETS) return { err: 'Нет такого аватара' };
        val = value;
      } else if (kind === 'upload') {
        if (!parseImage(value)) return { err: 'Нужна картинка JPG, PNG или WebP' };
        val = value;
      } else return { err: 'Неверный запрос' };
      const r = await pool.query(`UPDATE users SET avatar_kind = $2, avatar_val = $3, avatar_ver = avatar_ver + 1 WHERE id = $1 RETURNING ${COLS}`, [+id || 0, kind, val]);
      return r.rows[0] ? { user: pubUser(r.rows[0]) } : { err: 'Нет такого аккаунта' };
    },
    async getAvatarData(id) {
      const r = await pool.query(`SELECT avatar_val FROM users WHERE id = $1 AND avatar_kind = 'upload'`, [+id || 0]);
      return r.rows[0] ? parseImage(r.rows[0].avatar_val) : null;
    },
    async applyResult(id, { delta, place, n, rated }) {
      const r = await pool.query(
        `UPDATE users SET games = games + 1, boss = boss + $2, dyrka = dyrka + $3, rating = CASE WHEN $4 THEN GREATEST(100, rating + $5) ELSE rating END WHERE id = $1 RETURNING rating`,
        [+id || 0, place === 1 ? 1 : 0, place === n ? 1 : 0, !!rated, Math.round(delta)]
      );
      return r.rows[0] ? r.rows[0].rating : null;
    },
    async leaderboard(limit = 20) {
      const r = await pool.query(`SELECT ${COLS} FROM users WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT $1`, [limit]);
      return r.rows.map(pubUser);
    },
  };
}

async function createStore() {
  const url = process.env.DATABASE_URL;
  const s = url ? pgStore(url) : memoryStore();
  await s.init();
  console.log('Хранилище аккаунтов:', s.kind);
  return s;
}

module.exports = { createStore, parseImage, NAME_RE, PRESETS };
