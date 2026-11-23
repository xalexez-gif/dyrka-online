'use strict';
// «Козёл» на четверых (две пары). Карта = suit*9 + r, r: 1..8 = 7,8,9,10,J,Q,K,A (шестёрок нет); масть: 0♠ 1♥ 2♦ 3♣.
const { Room, BETWEEN_MS, shuffle, rnd, BOT_NAMES } = require('./game');

const KR = (c) => c % 9;
const KS = (c) => (c / 9) | 0;
const SPD = +process.env.GAME_SPEED || 1;
const KTURN_MS = 15000;
const REVEAL_MS = 1500 / SPD;
const LIMIT = 12;
const SHAMOK = 3 * 9 + 1; // 7♣
const QC = 3 * 9 + 6; // Q♣
const SUIT_ORD = [3, 0, 1, 2]; // ♣ ♠ ♥ ♦ — порядок дам и валетов

const isTrump = (c) => KR(c) === 6 || KR(c) === 5 || KS(c) === 3;
function tPower(c) {
  if (c === SHAMOK) return 100;
  const r = KR(c), s = KS(c);
  if (r === 6) return 90 - SUIT_ORD.indexOf(s);
  if (r === 5) return 80 - SUIT_ORD.indexOf(s);
  return { 8: 70, 4: 69, 7: 68, 3: 67, 2: 66 }[r] || 60; // трефы: A,10,K,9,8
}
const pPower = (c) => ({ 8: 5, 4: 4, 7: 3, 3: 2, 2: 1, 1: 0 }[KR(c)] || 0);
const pts = (c) => ({ 8: 11, 4: 10, 7: 4, 6: 3, 5: 2 }[KR(c)] || 0);
const power = (c) => (isTrump(c) ? 100 + tPower(c) : pPower(c));

class KozelRoom extends Room {
  constructor(code, broadcast) {
    super(code, broadcast);
    this.game = 'kozel';
    this.numSeats = 4;
    this.stock = [];
    this.trick = []; // [{seat, card}]
    this.leader = 0;
    this.dealer = 0;
    this.trickNo = 0;
    this.praised = false;
    this.won = [[], []]; // карты, взятые командами
    this.pen = [0, 0];
    this.winner = -1; // победитель завершённой взятки (пока показываем)
    this.reveal = false;
    this.roundPts = null;
    this.special = null;
    this.gameOver = false;
    this.loserTeam = -1;
  }

  team(i) { return i % 2; }

  // ---------- правила ----------
  legal(i) {
    const h = this.seats[i].hand;
    if (!this.trick.length) {
      const plain = h.filter((c) => !isTrump(c));
      if (this.praised && this.trickNo === 0) return [...h];
      return plain.length ? plain : [...h];
    }
    const first = this.trick[0].card;
    if (isTrump(first)) {
      const t = h.filter(isTrump);
      return t.length ? t : [...h];
    }
    const s = KS(first);
    const same = h.filter((c) => !isTrump(c) && KS(c) === s);
    return same.length ? same : [...h];
  }
  trickWinner(trick) {
    const first = trick[0].card;
    const led = isTrump(first) ? 'T' : KS(first);
    let best = trick[0];
    for (const t of trick) {
      const c = t.card;
      if (isTrump(c)) { if (!isTrump(best.card) || tPower(c) > tPower(best.card)) best = t; }
      else if (!isTrump(best.card) && led !== 'T' && KS(c) === led && pPower(c) > pPower(best.card)) best = t;
    }
    return best.seat;
  }

  // ---------- команды ----------
  handle(token, m) {
    const i = this.idxOf(token);
    if (i < 0) return;
    switch (m.t) {
      case 'config': return;
      case 'play':
        if (Date.now() < this.holdUntil) return;
        this.doPlay(i, +m.card);
        return;
      case 'praise':
        if (this.phase === 'play' && this.turn === i && !this.trick.length && this.trickNo === 0 && !this.reveal) {
          this.praised = !this.praised;
          this.note(this.praised ? `${this.seats[i].name} хвалится — может ходить козырем` : `${this.seats[i].name} отказывается от хвалёнки`, i, 'praise');
          this.changed();
        }
        return;
    }
    super.handle(token, m);
  }

  start() {
    const humans = this.seats.filter((s) => !s.bot);
    this.numSeats = 4;
    const place = [0, 2, 1, 3]; // люди садятся парами: первые двое — партнёры
    const seats = new Array(4).fill(null);
    humans.slice(0, 4).forEach((h, k) => (seats[place[k]] = h));
    let b = 1;
    const taken = new Set(humans.map((h) => h.name.trim().toLowerCase()));
    const pool = shuffle(BOT_NAMES.filter((x) => !taken.has(x.toLowerCase())));
    for (let k = 0; k < 4; k++) {
      if (seats[k]) continue;
      seats[k] = { token: 'bot' + b, name: pool.shift() || 'Бот ' + b, bot: true, ws: null, hand: [], hue: Math.floor(rnd(0, 360)), place: null, uid: null, avatar: null, rating: null, lastDelta: null, stats: { boss: 0, dyrka: 0, kons: 0 } };
      b++;
    }
    this.seats = seats;
    this.kon = 0;
    this.pen = [0, 0];
    this.gameOver = false;
    this.loserTeam = -1;
    this.dealer = Math.floor(Math.random() * 4);
    this.dealKon();
  }

  toLobby() {
    this.trick = []; this.stock = []; this.reveal = false; this.pen = [0, 0]; this.gameOver = false; this.loserTeam = -1; this.roundPts = null; this.special = null; this.won = [[], []];
    super.toLobby();
  }

  dealKon() {
    this.clearTimers();
    if (this.gameOver) { this.pen = [0, 0]; this.gameOver = false; this.loserTeam = -1; this.kon = 0; }
    const deck = shuffle([...Array(36).keys()].filter((c) => KR(c) !== 0));
    this.seats.forEach((s) => { s.hand = []; s.place = null; });
    for (let k = 0; k < 4; k++) this.seats.forEach((s) => s.hand.push(deck.pop()));
    this.stock = deck;
    this.kon++;
    this.dealer = (this.dealer + 1) % 4;
    this.leader = this.dealer;
    this.trick = [];
    this.trickNo = 0;
    this.praised = false;
    this.won = [[], []];
    this.winner = -1;
    this.reveal = false;
    this.roundPts = null;
    this.special = null;
    this.holdUntil = 0;
    this.phase = 'play';
    this.note(`Раунд ${this.kon}. Заходит ${this.seats[this.leader].name}`, this.leader, 'deal');
    this.setTurn(this.leader);
  }

  setTurn(i) {
    this.turn = i;
    this.deadline = Date.now() + KTURN_MS;
    this.schedule();
    this.changed();
  }

  schedule() {
    clearTimeout(this.timers.act); clearTimeout(this.timers.turn);
    if (this.phase !== 'play' || this.reveal || !this.hasLive() || this.turn < 0) return;
    const i = this.turn, s = this.seats[i], live = !s.bot && s.ws;
    if (!live) this.setT('act', () => this.botMove(i), rnd(800, 1600) / SPD);
    else if (this.legal(i).length === 1) this.setT('act', () => this.doPlay(i, this.legal(i)[0]), 900 / SPD); // единственный ход — делается сам
    this.setT('turn', () => this.timeout(i), Math.max(0, this.deadline - Date.now()) + 250);
  }

  timeout(i) {
    if (this.phase !== 'play' || this.turn !== i || this.reveal) return;
    const l = this.legal(i).sort((a, b) => power(a) - power(b));
    this.doPlay(i, l[0], 'timeout');
  }

  botMove(i) {
    if (this.phase !== 'play' || this.turn !== i || this.reveal) return;
    const l = this.legal(i);
    const byPow = [...l].sort((a, b) => power(a) - power(b));
    const cheap = [...l].sort((a, b) => pts(a) - pts(b) || power(a) - power(b));
    if (!this.trick.length) return this.doPlay(i, cheap[0]);
    // кто сейчас берёт
    const cur = this.trickWinner(this.trick);
    const mate = this.team(cur) === this.team(i);
    const last = this.trick.length === 3;
    const sim = (c) => this.trickWinner([...this.trick, { seat: i, card: c }]) === i;
    const winners = byPow.filter(sim);
    const sum = this.trick.reduce((a, t) => a + pts(t.card), 0);
    if (mate) {
      if (last || power(this.trick.find((t) => t.seat === cur).card) >= 100 + 77) {
        const rich = [...l].sort((a, b) => pts(b) - pts(a) || power(a) - power(b));
        return this.doPlay(i, rich[0]);
      }
      return this.doPlay(i, cheap[0]);
    }
    if (winners.length && (sum >= 4 || last || Math.random() < 0.55)) {
      // берём самой дешёвой выигрывающей картой
      const w = [...winners].sort((a, b) => pts(a) - pts(b) || power(a) - power(b));
      return this.doPlay(i, w[0]);
    }
    this.doPlay(i, cheap[0]);
  }

  doPlay(i, card, why) {
    if (this.phase !== 'play' || this.turn !== i || this.reveal) return;
    const s = this.seats[i];
    if (!s.hand.includes(card) || !this.legal(i).includes(card)) return;
    s.hand = s.hand.filter((c) => c !== card);
    this.trick.push({ seat: i, card });
    this.note(`${s.name} ходит${why === 'timeout' ? ' (время вышло)' : ''}`, i, 'play');
    if (this.trick.length < 4) return this.setTurn((i + 1) % 4);
    // взятка собрана
    this.clearTimers();
    this.winner = this.trickWinner(this.trick);
    this.reveal = true;
    this.turn = -1;
    this.holdUntil = Date.now() + REVEAL_MS;
    this.note(`Взятку берёт ${this.seats[this.winner].name}`, this.winner, 'trick');
    this.setT('res', () => this.afterTrick(), REVEAL_MS);
    this.changed();
  }

  afterTrick() {
    if (this.phase !== 'play' || !this.reveal) return;
    const w = this.winner, cards = this.trick.map((t) => t.card);
    // дама треф и семёрка треф от разных команд — раунд сразу заканчивается
    const q = this.trick.find((t) => t.card === QC), sh = this.trick.find((t) => t.card === SHAMOK);
    this.won[this.team(w)].push(...cards);
    this.trick = [];
    this.reveal = false;
    this.winner = -1;
    this.holdUntil = 0;
    this.trickNo++;
    if (q && sh && this.team(q.seat) !== this.team(sh.seat)) return this.endRound({ penTeam: this.team(q.seat), amount: 4, special: `Дама треф и шамок в одной взятке — паре ${this.seats[q.seat].name} сразу 4 штрафных очка` });
    if (this.stock.length) {
      for (let k = 0; k < 4; k++) { const t = (w + k) % 4; if (this.stock.length) this.seats[t].hand.push(this.stock.pop()); }
    }
    if (!this.seats.some((s) => s.hand.length)) return this.endRound(null);
    this.leader = w;
    this.setTurn(w);
  }

  endRound(sp) {
    this.clearTimers();
    const p = [0, 1].map((t) => this.won[t].reduce((a, c) => a + pts(c), 0));
    this.roundPts = p;
    let msg;
    if (sp) { this.pen[sp.penTeam] += sp.amount; this.special = sp.special; msg = sp.special; }
    else if (p[0] > 60) { this.pen[1] += 2; msg = 'Пара 1 выиграла раунд: ' + p[0] + ' : ' + p[1]; }
    else if (p[1] > 60) { this.pen[0] += 2; msg = 'Пара 2 выиграла раунд: ' + p[1] + ' : ' + p[0]; }
    else msg = 'Ровно 60 : 60 — штрафных очков нет';
    this.seats.forEach((s) => (s.stats.kons += 1));
    this.phase = 'between';
    this.turn = -1;
    this.trick = [];
    this.reveal = false;
    this.holdUntil = 0;
    this.gameOver = this.pen[0] >= LIMIT || this.pen[1] >= LIMIT;
    if (this.gameOver) {
      this.loserTeam = this.pen[0] >= LIMIT && this.pen[0] >= this.pen[1] ? 0 : 1;
      this.seats.forEach((s, i) => { if (this.team(i) !== this.loserTeam) s.stats.boss += 1; else s.stats.dyrka += 1; });
      msg += '. Игра окончена';
    }
    this.nextAt = Date.now() + (BETWEEN_MS + (this.gameOver ? 8000 : 0)) / SPD;
    this.note(msg, -1, 'end');
    this.scheduleNext();
    this.changed();
  }

  // ---------- что видит игрок ----------
  view(i) {
    const me = this.seats[i];
    const host = this.hostIdx();
    const hand = me ? [...me.hand].sort((a, b) => (isTrump(a) - isTrump(b)) || (isTrump(a) ? tPower(b) - tPower(a) : KS(a) - KS(b) || pPower(b) - pPower(a))) : [];
    const myTurn = this.phase === 'play' && this.turn === i && !this.reveal;
    return {
      t: 'state', game: 'kozel', code: this.code, phase: this.phase, kon: this.kon, numSeats: 4,
      you: i, isHost: i === host, hand,
      trick: this.trick, led: this.trick.length ? this.trick[0].seat : this.leader, trickNo: this.trickNo, stock: this.stock.length,
      winner: this.winner, reveal: this.reveal, praised: this.praised,
      canPraise: myTurn && !this.trick.length && this.trickNo === 0 && hand.some(isTrump) && hand.some((c) => !isTrump(c)),
      legal: myTurn ? this.legal(i) : [],
      pen: this.pen, limit: LIMIT, roundPts: this.phase === 'between' ? this.roundPts : null,
      tricksWon: this.won.map((w) => w.length / 4), special: this.special, gameOver: this.gameOver, loserTeam: this.loserTeam,
      turn: this.turn, deadline: this.deadline, turnMs: KTURN_MS, serverNow: Date.now(), nextAt: this.nextAt,
      msg: this.msg, lastAction: this.lastAction, holdUntil: this.holdUntil, finish: [],
      chat: this.chat, react: this.reaction, rated: false,
      seats: this.seats.map((s, k) => ({
        name: s.name, bot: s.bot, live: s.bot ? true : !!s.ws, count: s.hand.length, place: null, hue: s.hue,
        host: k === host, team: k % 2, role: null, dealer: k === this.dealer,
        stats: s.stats, uid: s.uid || null, avatar: s.avatar || null, rating: null, delta: null,
      })),
    };
  }
}

module.exports = { KozelRoom, isTrump, tPower, pts };
