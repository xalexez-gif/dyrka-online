'use strict';
// Логика игры «Дырка». Карта = число 0..31: ранг = id % 8 (7,8,9,10,J,Q,K,A), масть = id >> 3 (♠ ♥ ♦ ♣).

const TURN_MS = 15000;
const BETWEEN_MS = 9000;
const AD = 2 * 8 + 7; // туз бубен
const rankOf = (id) => id % 8;
const suitOf = (id) => id >> 3;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const byRank = (a, b) => rankOf(a) - rankOf(b) || suitOf(a) - suitOf(b);
const rnd = (a, b) => a + Math.random() * (b - a);

class Room {
  constructor(code, broadcast) {
    this.code = code;
    this.broadcast = broadcast;
    this.seats = [];
    this.numSeats = 3;
    this.phase = 'lobby'; // lobby | play | between
    this.kon = 0;
    this.table = null; // {cards, by, rank, count}
    this.turn = -1;
    this.deadline = 0;
    this.finish = [];
    this.msg = '';
    this.seq = 0;
    this.lastAction = null;
    this.exchange = null;
    this.roles = null;
    this.prevKey = null;
    this.nextAt = 0;
    this.chat = [];
    this.touched = Date.now();
    this.timers = {};
    this.onKonEnd = null;
    this.onProfile = null;
  }

  // ---------- вспомогательное ----------
  changed() {
    this.touched = Date.now();
    this.broadcast(this);
  }
  hasLive() {
    return this.seats.some((s) => !s.bot && s.ws);
  }
  idxOf(token) {
    return this.seats.findIndex((s) => !s.bot && s.token === token);
  }
  hostIdx() {
    let i = this.seats.findIndex((s) => !s.bot && s.ws);
    if (i < 0) i = this.seats.findIndex((s) => !s.bot);
    return i;
  }
  key() {
    return this.seats.map((s) => (s.bot ? 'bot' : s.token)).join('|');
  }
  clearTimers() {
    for (const k of Object.keys(this.timers)) clearTimeout(this.timers[k]);
    this.timers = {};
  }
  setT(name, fn, ms) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(fn, ms);
  }
  active() {
    return this.seats.map((s, i) => (s.hand.length ? i : -1)).filter((i) => i >= 0);
  }
  nextActive(from) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const t = (from + i) % n;
      if (this.seats[t].hand.length) return t;
    }
    return -1;
  }
  groups(hand) {
    const g = {};
    for (const c of hand) (g[rankOf(c)] = g[rankOf(c)] || []).push(c);
    return g;
  }
  canBeat(hand) {
    if (!this.table) return true;
    const g = this.groups(hand);
    return Object.keys(g).some((r) => +r > this.table.rank && g[r].length >= this.table.count);
  }
  note(msg, seat, type) {
    this.msg = msg;
    this.seq++;
    this.lastAction = { seat, type, seq: this.seq };
  }

  // ---------- вход / выход ----------
  join(token, name, ws, info = {}) {
    this.touched = Date.now();
    const i = this.idxOf(token);
    if (i >= 0) {
      const s = this.seats[i];
      if (s.ws && s.ws !== ws) { try { s.ws.close(4000, 'replaced'); } catch (e) {} }
      s.ws = ws;
      s.name = name || s.name;
      Object.assign(s, { uid: info.uid || null, avatar: info.avatar || null, rating: info.rating == null ? null : info.rating });
      this.afterConnChange();
      return { ok: true };
    }
    const mk = () => ({ token, name, bot: false, ws, hand: [], hue: Math.floor(rnd(0, 360)), place: null, uid: info.uid || null, avatar: info.avatar || null, rating: info.rating == null ? null : info.rating, lastDelta: null, stats: { boss: 0, dyrka: 0, kons: 0 } });
    if (this.phase === 'lobby') {
      if (this.seats.filter((s) => !s.bot).length >= 4) return { err: 'Стол заполнен (максимум 4 человека)' };
      this.seats.push(mk());
      this.note(name + ' садится за стол', this.seats.length - 1, 'join');
      return { ok: true };
    }
    // игра идёт: занимаем место бота
    const bi = this.seats.findIndex((s) => s.bot);
    if (bi < 0) return { err: 'Все места заняты людьми' };
    const old = this.seats[bi];
    const s = mk();
    s.hand = old.hand;
    s.place = old.place;
    this.seats[bi] = s;
    this.note(name + ' заменяет бота', bi, 'join');
    this.afterConnChange();
    return { ok: true };
  }

  leave(ws) {
    const i = this.seats.findIndex((s) => s.ws === ws);
    if (i < 0) return;
    this.seats[i].ws = null;
    if (this.phase === 'lobby') {
      // в лобби место освобождаем сразу
      this.seats.splice(i, 1);
    }
    this.afterConnChange();
  }

  afterConnChange() {
    if (this.phase === 'play') this.schedule();
    if (this.phase === 'between') this.scheduleNext();
    this.changed();
  }

  // ---------- команды игроков ----------
  handle(token, m) {
    const i = this.idxOf(token);
    if (i < 0) return;
    switch (m.t) {
      case 'profile':
        if (this.onProfile) this.onProfile(this, i);
        break;
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text) return;
        this.chat.push({ name: this.seats[i].name, seat: i, text, at: Date.now() });
        if (this.chat.length > 40) this.chat.shift();
        this.changed();
        break;
      }
      case 'config':
        if (this.phase === 'lobby' && i === this.hostIdx()) {
          this.numSeats = m.seats === 4 ? 4 : 3;
          this.changed();
        }
        break;
      case 'start':
        if (this.phase === 'lobby' && i === this.hostIdx()) this.start();
        break;
      case 'next':
        if (this.phase === 'between' && i === this.hostIdx()) this.dealKon();
        break;
      case 'end':
        if (i === this.hostIdx() && this.phase !== 'lobby') this.toLobby();
        break;
      case 'play':
        this.doPlay(i, Array.isArray(m.cards) ? m.cards.map(Number) : []);
        break;
      case 'pass':
        if (this.phase === 'play' && this.turn === i && this.table) this.doPass(i, false);
        break;
    }
  }

  start() {
    const humans = this.seats.filter((s) => !s.bot);
    const n = Math.max(this.numSeats, humans.length);
    this.numSeats = n;
    let b = 1;
    while (this.seats.length < n) {
      this.seats.push({ token: 'bot' + b, name: 'Бот ' + b, bot: true, ws: null, hand: [], hue: Math.floor(rnd(0, 360)), place: null, uid: null, avatar: null, rating: null, lastDelta: null, stats: { boss: 0, dyrka: 0, kons: 0 } });
      b++;
    }
    shuffle(this.seats);
    this.kon = 0;
    this.prevKey = null;
    this.dealKon();
  }

  toLobby() {
    this.clearTimers();
    this.seats = this.seats.filter((s) => !s.bot);
    this.seats.forEach((s) => { s.hand = []; s.place = null; s.stats = { boss: 0, dyrka: 0, kons: 0 }; });
    this.phase = 'lobby';
    this.kon = 0;
    this.table = null;
    this.turn = -1;
    this.finish = [];
    this.exchange = null;
    this.roles = null;
    this.prevKey = null;
    this.msg = 'Игра окончена. Можно начать заново';
    this.changed();
  }

  // ---------- кон ----------
  dealKon() {
    this.clearTimers();
    const n = this.seats.length;
    const deck = shuffle([...Array(32).keys()]);
    this.seats.forEach((s) => { s.hand = []; s.place = null; s.lastDelta = null; });
    deck.forEach((c, i) => this.seats[i % n].hand.push(c));
    this.kon++;
    this.table = null;
    this.exchange = null;
    this.roles = null;
    const same = this.prevKey === this.key() && this.finish.length === n;
    let first;
    if (same) {
      const boss = this.finish[0];
      const dyrka = this.finish[n - 1];
      const bh = this.seats[boss].hand;
      const dh = this.seats[dyrka].hand;
      const gave = [...dh].sort(byRank).slice(-2);
      const got = [...bh].sort(byRank).slice(0, 2);
      this.seats[dyrka].hand = dh.filter((c) => !gave.includes(c)).concat(got);
      this.seats[boss].hand = bh.filter((c) => !got.includes(c)).concat(gave);
      this.exchange = { boss, dyrka, gave, got };
      this.roles = { boss, dyrka };
      first = dyrka;
      this.note(`Кон ${this.kon}. ${this.seats[dyrka].name} отдаёт две старшие и ходит первым`, first, 'deal');
    } else {
      first = this.seats.findIndex((s) => s.hand.includes(AD));
      this.note(`Кон ${this.kon}. Первым ходит ${this.seats[first].name} (туз бубен)`, first, 'deal');
    }
    this.finish = [];
    this.phase = 'play';
    this.setTurn(first);
  }

  setTurn(i) {
    this.turn = i;
    this.deadline = Date.now() + TURN_MS;
    this.schedule();
    this.changed();
  }

  schedule() {
    this.clearTimers();
    if (this.phase !== 'play' || !this.hasLive()) return;
    const i = this.turn;
    const s = this.seats[i];
    const live = !s.bot && s.ws;
    if (this.table && !this.canBeat(s.hand)) {
      this.setT('act', () => this.doPass(i, 'auto'), 1100);
    } else if (!live) {
      this.setT('act', () => this.botMove(i), rnd(900, 1700));
    }
    this.setT('turn', () => this.timeout(i), Math.max(0, this.deadline - Date.now()) + 250);
  }

  timeout(i) {
    if (this.phase !== 'play' || this.turn !== i) return;
    if (this.table) return this.doPass(i, 'timeout');
    const g = this.groups(this.seats[i].hand);
    const low = Math.min(...Object.keys(g).map(Number));
    this.doPlay(i, g[low], 'timeout');
  }

  botMove(i) {
    if (this.phase !== 'play' || this.turn !== i) return;
    const s = this.seats[i];
    const g = this.groups(s.hand);
    const ranks = Object.keys(g).map(Number).sort((a, b) => a - b);
    if (!this.table) {
      const r = ranks[0];
      return this.doPlay(i, g[r]);
    }
    const opts = ranks.filter((r) => r > this.table.rank && g[r].length >= this.table.count);
    if (!opts.length) return this.doPass(i, 'auto');
    const r = opts[0];
    const cheap = s.hand.length <= this.table.count * 2 || r < 5 || s.hand.length <= 5;
    if (!cheap && Math.random() < 0.35) return this.doPass(i, false);
    const pick = shuffle([...g[r]]).slice(0, this.table.count);
    this.doPlay(i, pick);
  }

  doPlay(i, ids, why) {
    if (this.phase !== 'play' || this.turn !== i) return;
    const s = this.seats[i];
    if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length) return;
    if (!ids.every((c) => s.hand.includes(c))) return;
    const rank = rankOf(ids[0]);
    if (!ids.every((c) => rankOf(c) === rank)) return;
    if (this.table && (ids.length !== this.table.count || rank <= this.table.rank)) return;
    s.hand = s.hand.filter((c) => !ids.includes(c));
    const label = ids.length > 1 ? ` ×${ids.length}` : '';
    this.table = { cards: [...ids].sort(byRank), by: i, rank, count: ids.length };
    this.note(`${s.name} ходит${label}${why === 'timeout' ? ' (время вышло)' : ''}`, i, 'play');
    if (!s.hand.length) {
      this.finish.push(i);
      s.place = this.finish.length;
    }
    const act = this.active();
    if (act.length <= 1) {
      if (act.length === 1) {
        this.finish.push(act[0]);
        this.seats[act[0]].place = this.finish.length;
      }
      return this.endKon();
    }
    this.setTurn(this.nextActive(i));
  }

  doPass(i, why) {
    if (this.phase !== 'play' || this.turn !== i || !this.table) return;
    const s = this.seats[i];
    const n = this.seats.length;
    const txt = why === 'auto' ? `${s.name}: нечем бить — пас` : why === 'timeout' ? `${s.name}: время вышло — пас` : `${s.name} пасует`;
    this.note(txt, i, 'pass');
    for (let k = 1; k <= n; k++) {
      const t = (i + k) % n;
      if (t === this.table.by) {
        const leader = this.seats[t].hand.length ? t : this.nextActive(t);
        this.table = null;
        this.msg = `Круг закрыт — ${this.seats[leader].name} заходит заново`;
        return this.setTurn(leader);
      }
      if (this.seats[t].hand.length) return this.setTurn(t);
    }
  }

  endKon() {
    this.clearTimers();
    this.phase = 'between';
    const n = this.seats.length;
    this.seats.forEach((s) => (s.stats.kons += 1));
    this.seats[this.finish[0]].stats.boss += 1;
    this.seats[this.finish[n - 1]].stats.dyrka += 1;
    this.prevKey = this.key();
    this.table = null;
    this.turn = -1;
    this.nextAt = Date.now() + BETWEEN_MS;
    this.note(`Кон ${this.kon} окончен. Дырка — ${this.seats[this.finish[n - 1]].name}`, this.finish[n - 1], 'end');
    this.scheduleNext();
    this.changed();
    if (this.onKonEnd) {
      const kon = this.kon;
      Promise.resolve(this.onKonEnd(this))
        .then(() => { if (this.kon === kon) this.changed(); })
        .catch((e) => console.error('onKonEnd', e && e.message));
    }
  }

  scheduleNext() {
    clearTimeout(this.timers.next);
    if (this.phase !== 'between' || !this.hasLive()) return;
    this.timers.next = setTimeout(() => this.dealKon(), Math.max(500, this.nextAt - Date.now()));
  }

  // ---------- что видит игрок ----------
  view(i) {
    const me = this.seats[i];
    const host = this.hostIdx();
    return {
      t: 'state',
      code: this.code,
      phase: this.phase,
      kon: this.kon,
      numSeats: this.numSeats,
      you: i,
      isHost: i === host,
      hand: me ? [...me.hand].sort(byRank) : [],
      table: this.table,
      turn: this.turn,
      deadline: this.deadline,
      turnMs: TURN_MS,
      serverNow: Date.now(),
      nextAt: this.nextAt,
      msg: this.msg,
      lastAction: this.lastAction,
      exchange: this.exchange,
      rated: !!this.lastRated,
      finish: this.finish,
      chat: this.chat,
      seats: this.seats.map((s, k) => ({
        name: s.name,
        bot: s.bot,
        live: s.bot ? true : !!s.ws,
        count: s.hand.length,
        place: s.place,
        hue: s.hue,
        host: k === host,
        role: this.roles ? (this.roles.boss === k ? 'boss' : this.roles.dyrka === k ? 'dyrka' : null) : null,
        stats: s.stats,
        uid: s.uid || null,
        avatar: s.avatar || null,
        rating: s.rating == null ? null : s.rating,
        delta: s.lastDelta == null ? null : s.lastDelta,
      })),
    };
  }
}

module.exports = { Room, TURN_MS, BETWEEN_MS, rankOf, suitOf };
