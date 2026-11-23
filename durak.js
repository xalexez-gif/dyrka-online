'use strict';
// «Дурак» (подкидной). Карта = suit*9 + r, r: 0..8 = 6,7,8,9,10,J,Q,K,A; масть: 0♠ 1♥ 2♦ 3♣.
const { Room, BETWEEN_MS, shuffle, rnd, BOT_NAMES } = require('./game');

const DR = (c) => c % 9;
const DS = (c) => (c / 9) | 0;
const DTURN_MS = 20000;
const SPD = +process.env.GAME_SPEED || 1; // для тестов: ускорение пауз
const RESOLVE_MS = 1300 / SPD;

class DurakRoom extends Room {
  constructor(code, broadcast) {
    super(code, broadcast);
    this.game = 'durak';
    this.numSeats = 3;
    this.deck = [];
    this.trump = 0;
    this.trumpCard = -1;
    this.pairs = [];
    this.att = -1;
    this.def = -1;
    this.mode = 'attack'; // attack | defend | take | resolving
    this.passed = new Set();
    this.resolving = null;
    this.loser = -1;
  }

  // ---------- правила ----------
  beats(a, d) {
    const sa = DS(a), sd = DS(d);
    if (sa === sd) return DR(d) > DR(a);
    return sd === this.trump && sa !== this.trump;
  }
  nextAlive(from) {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const t = (from + k) % n;
      if (this.seats[t].hand.length) return t;
    }
    return -1;
  }
  attackers() {
    const n = this.seats.length, r = [];
    for (let k = 0; k < n; k++) {
      const t = (this.att + k) % n;
      if (t !== this.def && this.seats[t].hand.length) r.push(t);
    }
    return r;
  }
  actor() {
    if (this.mode === 'defend') return this.def;
    const a = this.attackers().find((x) => !this.passed.has(x));
    return a === undefined ? -1 : a;
  }
  undefended() { return this.pairs.filter((p) => p.d == null); }
  tableRanks() {
    const s = new Set();
    this.pairs.forEach((p) => { s.add(DR(p.a)); if (p.d != null) s.add(DR(p.d)); });
    return s;
  }
  room() { // сколько карт ещё можно добавить
    const d = this.seats[this.def];
    return Math.max(0, Math.min(6 - this.pairs.length, d.hand.length - this.undefended().length));
  }
  addable(i) {
    if (this.room() <= 0) return [];
    const h = this.seats[i].hand;
    if (!this.pairs.length) return [...h];
    const rk = this.tableRanks();
    return h.filter((c) => rk.has(DR(c)));
  }
  beatMap(i) {
    const h = this.seats[i].hand, m = {};
    this.pairs.forEach((p, k) => {
      if (p.d != null) return;
      h.forEach((c) => { if (this.beats(p.a, c)) (m[c] = m[c] || []).push(k); });
    });
    return m;
  }
  cost(c) { return (DS(c) === this.trump ? 100 : 0) + DR(c); }

  // ---------- команды ----------
  handle(token, m) {
    const i = this.idxOf(token);
    if (i < 0) return;
    switch (m.t) {
      case 'config':
        if (this.phase === 'lobby' && i === this.hostIdx()) {
          this.numSeats = [2, 3, 4].includes(m.seats) ? m.seats : 3;
          this.changed();
        }
        return;
      case 'play':
        if (Date.now() < this.holdUntil) return;
        if (this.mode === 'defend') this.doDefend(i, +m.card, m.on == null ? -1 : +m.on);
        else this.doAttack(i, Array.isArray(m.cards) ? m.cards.map(Number) : []);
        return;
      case 'pass':
        if (Date.now() < this.holdUntil) return;
        this.doPass(i);
        return;
      case 'take':
        if (Date.now() < this.holdUntil) return;
        this.doTake(i);
        return;
    }
    super.handle(token, m);
  }

  start() {
    const humans = this.seats.filter((s) => !s.bot);
    const n = Math.min(4, Math.max(2, this.numSeats, humans.length));
    this.numSeats = n;
    let b = 1;
    const taken = new Set(humans.map((h) => h.name.trim().toLowerCase()));
    const pool = shuffle(BOT_NAMES.filter((x) => !taken.has(x.toLowerCase())));
    while (this.seats.length < n) {
      this.seats.push({ token: 'bot' + b, name: pool.shift() || 'Бот ' + b, bot: true, ws: null, hand: [], hue: Math.floor(rnd(0, 360)), place: null, uid: null, avatar: null, rating: null, lastDelta: null, stats: { boss: 0, dyrka: 0, kons: 0 } });
      b++;
    }
    shuffle(this.seats);
    this.kon = 0;
    this.dealKon();
  }

  toLobby() {
    this.pairs = []; this.deck = []; this.att = this.def = -1; this.loser = -1; this.passed = new Set(); this.resolving = null; this.mode = 'attack';
    super.toLobby();
  }

  dealKon() {
    this.clearTimers();
    const n = this.seats.length;
    const deck = shuffle([...Array(36).keys()]);
    this.seats.forEach((s) => { s.hand = []; s.place = null; s.lastDelta = null; });
    for (let k = 0; k < 6; k++) this.seats.forEach((s) => s.hand.push(deck.pop()));
    this.deck = deck; // deck[0] — козырная карта, берут с конца
    this.trumpCard = deck[0];
    this.trump = DS(deck[0]);
    this.kon++;
    this.pairs = [];
    this.finish = [];
    this.loser = -1;
    this.resolving = null;
    this.passed = new Set();
    this.holdUntil = 0;
    let first = 0, best = 99;
    this.seats.forEach((s, i) => s.hand.forEach((c) => { if (DS(c) === this.trump && DR(c) < best) { best = DR(c); first = i; } }));
    if (best === 99) first = Math.floor(Math.random() * n);
    this.att = first;
    this.def = this.nextAlive(first);
    this.mode = 'attack';
    this.phase = 'play';
    this.note(`Раздача ${this.kon}. Козырь — ${'♠♥♦♣'[this.trump]}. Первым ходит ${this.seats[first].name}`, first, 'deal');
    this.setTurn(first);
  }

  setTurn(i) {
    this.turn = i;
    this.deadline = Date.now() + DTURN_MS;
    this.schedule();
    this.changed();
  }

  schedule() {
    clearTimeout(this.timers.act); clearTimeout(this.timers.turn);
    if (this.phase !== 'play' || this.mode === 'resolving' || !this.hasLive() || this.turn < 0) return;
    const i = this.turn, s = this.seats[i], live = !s.bot && s.ws;
    let auto = false;
    if (this.mode === 'defend') auto = i === this.def && !Object.keys(this.beatMap(i)).length;
    else auto = this.pairs.length > 0 && !this.addable(i).length;
    if (auto) this.setT('act', () => this.autoMove(i), 1200 / SPD);
    else if (!live) this.setT('act', () => this.botMove(i), rnd(900, 1800) / SPD);
    this.setT('turn', () => this.timeout(i), Math.max(0, this.deadline - Date.now()) + 250);
  }

  autoMove(i) {
    if (this.phase !== 'play' || this.turn !== i) return;
    if (this.mode === 'defend') this.doTake(i, 'auto'); else this.doPass(i, 'auto');
  }
  timeout(i) {
    if (this.phase !== 'play' || this.turn !== i) return;
    if (this.mode === 'defend') return this.doTake(i, 'timeout');
    if (!this.pairs.length) {
      const h = [...this.seats[i].hand].sort((a, b) => this.cost(a) - this.cost(b));
      return this.doAttack(i, [h[0]], 'timeout');
    }
    this.doPass(i, 'timeout');
  }

  botMove(i) {
    if (this.phase !== 'play' || this.turn !== i || this.mode === 'resolving') return;
    const s = this.seats[i];
    if (this.mode === 'defend') {
      const k = this.pairs.findIndex((p) => p.d == null);
      const opts = s.hand.filter((c) => this.beats(this.pairs[k].a, c)).sort((a, b) => this.cost(a) - this.cost(b));
      if (!opts.length) return this.doTake(i);
      const c = opts[0];
      const left = this.undefended().length;
      if (DS(c) === this.trump && DR(c) >= 5 && this.deck.length > 4 && Math.random() < 0.5) return this.doTake(i);
      if (left > 2 && DS(c) === this.trump && this.deck.length > 2 && Math.random() < 0.5) return this.doTake(i);
      return this.doDefend(i, c, k);
    }
    const add = this.addable(i).sort((a, b) => this.cost(a) - this.cost(b));
    if (!this.pairs.length) {
      const c = add[0];
      const same = add.filter((x) => DR(x) === DR(c) && x !== c && DS(x) !== this.trump);
      const go = Math.random() < 0.4 ? [c, ...same].slice(0, 2) : [c];
      return this.doAttack(i, go);
    }
    const cheap = add.filter((c) => DS(c) !== this.trump && (this.mode === 'take' || DR(c) <= 5 || this.deck.length === 0));
    if (!cheap.length || (this.mode === 'attack' && Math.random() < 0.25)) return this.doPass(i);
    if (this.mode === 'take') return this.doAttack(i, cheap.slice(0, Math.max(1, this.room())));
    this.doAttack(i, [cheap[0]]);
  }

  // ---------- действия ----------
  doAttack(i, cards, why) {
    if (this.phase !== 'play' || this.turn !== i || (this.mode !== 'attack' && this.mode !== 'take')) return;
    const s = this.seats[i];
    cards = [...new Set(cards)];
    if (!cards.length || cards.length > 6 || !cards.every((c) => s.hand.includes(c))) return;
    if (cards.length > this.room() && this.pairs.length) return;
    if (!this.pairs.length) {
      if (!cards.every((c) => DR(c) === DR(cards[0]))) return;
      if (cards.length > Math.min(6, this.seats[this.def].hand.length)) return;
    } else {
      const rk = this.tableRanks();
      if (!cards.every((c) => rk.has(DR(c)))) return;
      if (cards.length > this.room()) return;
    }
    s.hand = s.hand.filter((c) => !cards.includes(c));
    cards.forEach((c) => this.pairs.push({ a: c, d: null, by: i }));
    this.passed.clear();
    const to = this.seats[this.def].name;
    const verb = this.pairs.length === cards.length ? 'ходит' : 'подкидывает';
    this.note(`${s.name} ${verb}${why === 'timeout' ? ' (время вышло)' : ''}${this.mode === 'take' ? ' — ' + to + ' берёт' : ''}`, i, 'play');
    if (this.mode === 'take') {
      this.afterThrow();
    } else {
      this.mode = 'defend';
      this.setTurn(this.def);
    }
  }

  doDefend(i, card, on) {
    if (this.phase !== 'play' || this.mode !== 'defend' || this.turn !== i || i !== this.def) return;
    const s = this.seats[i];
    if (!s.hand.includes(card)) return;
    let k = on;
    if (!(k >= 0 && this.pairs[k] && this.pairs[k].d == null && this.beats(this.pairs[k].a, card))) {
      k = this.pairs.findIndex((p) => p.d == null && this.beats(p.a, card));
    }
    if (k < 0) return;
    s.hand = s.hand.filter((c) => c !== card);
    this.pairs[k].d = card;
    this.note(`${s.name} отбивается`, i, 'defend');
    if (this.undefended().length) return this.setTurn(i);
    if (this.pairs.length >= 6 || !s.hand.length) return this.resolve('bito');
    this.mode = 'attack';
    this.passed.clear();
    this.afterThrow();
  }

  afterThrow() { // решаем, кто ходит дальше в круге подкидывания
    let nx = this.actor();
    while (nx >= 0 && this.pairs.length && !this.addable(nx).length) { this.passed.add(nx); nx = this.actor(); }
    if (nx < 0) return this.resolve(this.mode === 'take' ? 'take' : 'bito');
    this.setTurn(nx);
  }

  doTake(i, why) {
    if (this.phase !== 'play' || this.mode !== 'defend' || this.turn !== i || i !== this.def) return;
    this.mode = 'take';
    this.passed.clear();
    this.note(`${this.seats[i].name} берёт${why === 'timeout' ? ' (время вышло)' : ''}`, i, 'take');
    this.afterThrow();
  }

  doPass(i, why) {
    if (this.phase !== 'play' || this.turn !== i || (this.mode !== 'attack' && this.mode !== 'take') || !this.pairs.length) return;
    this.passed.add(i);
    if (why === 'auto' || why === 'timeout') this.msg = `${this.seats[i].name}: ${why === 'auto' ? 'нечего подкинуть' : 'время вышло'}`;
    this.seq++; this.lastAction = { seat: i, type: 'pass', seq: this.seq };
    this.afterThrow();
  }

  resolve(kind) {
    this.clearTimers();
    this.mode = 'resolving';
    this.resolving = kind;
    this.turn = -1;
    this.holdUntil = Date.now() + RESOLVE_MS;
    this.note(kind === 'bito' ? 'Бито!' : `${this.seats[this.def].name} забирает карты`, this.def, kind === 'bito' ? 'bito' : 'took');
    this.setT('res', () => this.finishRound(kind), RESOLVE_MS);
    this.changed();
  }

  finishRound(kind) {
    if (this.phase !== 'play' || this.mode !== 'resolving') return;
    const n = this.seats.length, d = this.def, a = this.att;
    if (kind === 'take') {
      this.pairs.forEach((p) => { this.seats[d].hand.push(p.a); if (p.d != null) this.seats[d].hand.push(p.d); });
    }
    this.pairs = [];
    const order = [a];
    for (let k = 1; k < n; k++) { const t = (a + k) % n; if (t !== d && t !== a) order.push(t); }
    order.push(d);
    for (const t of [...new Set(order)]) {
      const h = this.seats[t].hand;
      while (h.length < 6 && this.deck.length) h.push(this.deck.pop());
    }
    if (!this.deck.length) {
      this.seats.forEach((s, i) => { if (!s.hand.length && s.place == null) { this.finish.push(i); s.place = this.finish.length; } });
    }
    const alive = this.seats.map((s, i) => (s.hand.length ? i : -1)).filter((i) => i >= 0);
    if (alive.length <= 1) return this.endGame(alive[0] == null ? -1 : alive[0]);
    const na = kind === 'take' ? this.nextAlive(d) : this.seats[d].hand.length ? d : this.nextAlive(d);
    this.att = na;
    this.def = this.nextAlive(na);
    this.mode = 'attack';
    this.resolving = null;
    this.holdUntil = 0;
    this.passed.clear();
    this.note(`Ходит ${this.seats[na].name}`, na, 'deal');
    this.setTurn(na);
  }

  endGame(loser) {
    this.clearTimers();
    this.loser = loser;
    if (loser >= 0) { this.finish.push(loser); this.seats[loser].place = this.finish.length; }
    this.phase = 'between';
    this.mode = 'attack';
    this.resolving = null;
    this.turn = -1;
    this.holdUntil = 0;
    this.seats.forEach((s) => (s.stats.kons += 1));
    if (this.finish.length) this.seats[this.finish[0]].stats.boss += 1;
    if (loser >= 0) this.seats[loser].stats.dyrka += 1;
    this.nextAt = Date.now() + BETWEEN_MS / (+process.env.GAME_SPEED || 1);
    this.note(loser >= 0 ? `Партия окончена. Дурак — ${this.seats[loser].name}` : 'Партия окончена — ничья', loser, 'end');
    this.scheduleNext();
    this.changed();
  }

  // ---------- что видит игрок ----------
  view(i) {
    const me = this.seats[i];
    const host = this.hostIdx();
    const mine = me ? [...me.hand].sort((a, b) => DS(a) - DS(b) || DR(a) - DR(b)) : [];
    const myTurn = this.phase === 'play' && this.turn === i && this.mode !== 'resolving';
    let legal = [], beatMap = null;
    if (myTurn) {
      if (this.mode === 'defend') { beatMap = this.beatMap(i); legal = Object.keys(beatMap).map(Number); }
      else legal = this.addable(i);
    }
    return {
      t: 'state', game: 'durak', code: this.code, phase: this.phase, kon: this.kon, numSeats: this.numSeats,
      you: i, isHost: i === host, hand: mine,
      pairs: this.pairs.map((p) => ({ a: p.a, d: p.d })), deckCount: this.deck.length,
      trump: this.trump, trumpCard: this.deck.length ? this.deck[0] : null,
      mode: this.mode, att: this.att, def: this.def, resolving: this.resolving, loser: this.loser,
      room: this.phase === 'play' && this.mode !== 'resolving' ? this.room() : 0,
      legal, beatMap,
      turn: this.turn, deadline: this.deadline, turnMs: DTURN_MS, serverNow: Date.now(), nextAt: this.nextAt,
      msg: this.msg, lastAction: this.lastAction, holdUntil: this.holdUntil, finish: this.finish,
      chat: this.chat, react: this.reaction, rated: false,
      seats: this.seats.map((s, k) => ({
        name: s.name, bot: s.bot, live: s.bot ? true : !!s.ws, count: s.hand.length, place: s.place, hue: s.hue,
        host: k === host, role: this.phase === 'play' ? (k === this.att ? 'att' : k === this.def ? 'def' : null) : null,
        stats: s.stats, uid: s.uid || null, avatar: s.avatar || null, rating: null, delta: null,
      })),
    };
  }
}

module.exports = { DurakRoom };
