/* ============================================================
   BLACKJACK ROYALE — Backend autoritativo
   Node.js + Express + ws
   Tutta la logica di gioco vive QUI (anti-cheat):
   il client invia solo intenzioni (bet / hit / stand / double / split),
   il server valida, aggiorna lo stato e lo trasmette a tutti.
   ============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ---------------- Economia fiches ---------------- */
const WELCOME_BONUS = 500_000;     // primo accesso assoluto
const TIMED_BONUS = 150_000;       // ricarica automatica
const BONUS_INTERVAL_MS = 15 * 60 * 1000; // ogni 15 minuti

const BALANCES_FILE = path.join(__dirname, 'balances.json');
let balances = {};
try { balances = JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8')); } catch (_) { balances = {}; }

let saveTimer = null;
function saveBalances() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(BALANCES_FILE, JSON.stringify(balances), () => {});
  }, 500);
}
function getBalance(pid) {
  if (!(pid in balances)) { balances[pid] = WELCOME_BONUS; saveBalances(); return { balance: WELCOME_BONUS, welcome: true }; }
  return { balance: balances[pid], welcome: false };
}
function setBalance(pid, v) { balances[pid] = Math.max(0, Math.round(v)); saveBalances(); }

/* ---------------- Costanti di gioco ---------------- */
const MAX_PLAYERS = 5;
const NUM_DECKS = 6;
const TURN_MS = 30_000;         // tempo per decisione
const PAYOUT_PAUSE_MS = 6_000;  // pausa risultati
const MIN_BET = 1_000;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function buildShoe() {
  const shoe = [];
  for (let d = 0; d < NUM_DECKS; d++)
    for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  // Fisher–Yates
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}
function cardValue(r) {
  if (r === 'A') return 11;
  if (r === 'J' || r === 'Q' || r === 'K') return 10;
  return parseInt(r, 10);
}
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += cardValue(c.r); if (c.r === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
function isBlackjack(hand) {
  return !hand.split && hand.cards.length === 2 && handValue(hand.cards).total === 21;
}

/* ---------------- Stanze ---------------- */
const rooms = new Map();

function makeRoom(id) {
  const room = {
    id,
    hostId: null,
    tableStyle: 1,
    players: [],            // max 5, ordine = posto al tavolo
    shoe: buildShoe(),
    dealer: { cards: [], hidden: true },
    phase: 'lobby',         // lobby | betting | playing | dealer | payout
    betEndsAt: null,
    turnEndsAt: null,
    turn: null,             // { playerId, handIndex }
    round: 0,
    timers: {},
  };
  rooms.set(id, room);
  return room;
}
function clearRoomTimers(room) {
  for (const k of Object.keys(room.timers)) { clearTimeout(room.timers[k]); delete room.timers[k]; }
}

function draw(room) {
  if (room.shoe.length < 52) room.shoe = buildShoe(); // rimescola il sabot quando è quasi vuoto
  return room.shoe.pop();
}

/* ---------------- Stato inviato ai client ---------------- */
function publicState(room) {
  const showHole = !room.dealer.hidden;
  return {
    type: 'state',
    roomId: room.id,
    hostId: room.hostId,
    tableStyle: room.tableStyle,
    phase: room.phase,
    round: room.round,
    betEndsAt: room.betEndsAt,
    turnEndsAt: room.turnEndsAt,
    turn: room.turn,
    nextBonusAt,
    dealer: {
      cards: room.dealer.cards.map((c, i) =>
        (i === 1 && !showHole) ? { hidden: true } : c),
      value: showHole && room.dealer.cards.length ? handValue(room.dealer.cards).total : null,
    },
    players: room.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, cardStyle: p.cardStyle,
      balance: balances[p.id] ?? 0,
      connected: p.connected,
      bet: p.bet,
      hands: p.hands.map(h => ({
        cards: h.cards, bet: h.bet, doubled: h.doubled, split: h.split,
        done: h.done, result: h.result || null,
        value: handValue(h.cards).total,
      })),
    })),
  };
}
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) if (p.ws && p.ws.readyState === 1) p.ws.send(data);
}
function sync(room) { broadcast(room, publicState(room)); }
function send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }

/* ---------------- Flusso di gioco ---------------- */
function maybeStartBetting(room) {
  if (room.phase !== 'lobby' && room.phase !== 'payout') return;
  if (room.players.length === 0) { room.phase = 'lobby'; sync(room); return; }
  room.phase = 'betting';
  room.betEndsAt = null;                  // nessun timer: attende il via dell'host
  for (const p of room.players) { p.bet = 0; p.hands = []; }
  room.dealer = { cards: [], hidden: true };
  room.turn = null;
  sync(room);
}

/* La mano NON parte mai da sola: solo l'host può avviarla ("start"),
   con qualsiasi numero di giocatori (da 1 a 5), purché almeno uno abbia puntato. */
function hostStart(room, player) {
  if (room.phase !== 'betting') return;
  if (player.id !== room.hostId) return;                      // solo l'admin
  if (!room.players.some(p => p.bet > 0)) {
    send(player, { type: 'toast', msg: 'Serve almeno una puntata per avviare la mano.' });
    return;
  }
  startRound(room);
}

function startRound(room) {
  if (room.phase !== 'betting') return;
  const bettors = room.players.filter(p => p.bet > 0);
  if (bettors.length === 0) { maybeStartBetting(room); return; }

  room.phase = 'playing';
  room.round++;
  room.betEndsAt = null;
  room.dealer = { cards: [], hidden: true };

  for (const p of room.players) {
    p.hands = p.bet > 0
      ? [{ cards: [], bet: p.bet, doubled: false, split: false, done: false, result: null }]
      : [];
  }
  // Distribuzione realistica: un giro di carte a testa, poi il secondo
  for (let pass = 0; pass < 2; pass++) {
    for (const p of bettors) p.hands[0].cards.push(draw(room));
    room.dealer.cards.push(draw(room));
  }
  // Blackjack naturali
  for (const p of bettors) if (isBlackjack(p.hands[0])) p.hands[0].done = true;

  // Se il banco ha blackjack, la mano finisce subito
  if (handValue(room.dealer.cards).total === 21) {
    room.dealer.hidden = false;
    return settle(room);
  }
  nextTurn(room);
}

function nextTurn(room) {
  clearTimeout(room.timers.turn);
  for (const p of room.players) {
    for (let i = 0; i < p.hands.length; i++) {
      if (!p.hands[i].done) {
        room.turn = { playerId: p.id, handIndex: i };
        room.turnEndsAt = Date.now() + TURN_MS;
        room.timers.turn = setTimeout(() => {
          const hand = p.hands[i];
          if (hand && !hand.done) { hand.done = true; }  // auto-stand
          nextTurn(room);
        }, TURN_MS);
        sync(room);
        return;
      }
    }
  }
  // Nessuna mano da giocare → tocca al banco
  room.turn = null;
  room.turnEndsAt = null;
  dealerPlay(room);
}

function dealerPlay(room) {
  room.phase = 'dealer';
  room.dealer.hidden = false;
  sync(room);

  // Il banco pesca con ritmo umano; sta su QUALSIASI 17 (soft o hard)
  const anyLive = room.players.some(p =>
    p.hands.some(h => handValue(h.cards).total <= 21 && !isBlackjack(h)));

  const step = () => {
    const v = handValue(room.dealer.cards).total;
    if (anyLive && v < 17) {
      room.dealer.cards.push(draw(room));
      sync(room);
      room.timers.dealer = setTimeout(step, 900);
    } else {
      settle(room);
    }
  };
  room.timers.dealer = setTimeout(step, 900);
}

function settle(room) {
  room.phase = 'payout';
  room.dealer.hidden = false;
  const dv = handValue(room.dealer.cards).total;
  const dealerBJ = room.dealer.cards.length === 2 && dv === 21;

  for (const p of room.players) {
    let credit = 0;
    for (const h of p.hands) {
      const v = handValue(h.cards).total;
      if (v > 21) { h.result = 'lose'; continue; }
      if (dealerBJ) { h.result = isBlackjack(h) ? 'push' : 'lose'; }
      else if (isBlackjack(h)) { h.result = 'blackjack'; }        // paga 3:2
      else if (dv > 21 || v > dv) { h.result = 'win'; }
      else if (v === dv) { h.result = 'push'; }
      else { h.result = 'lose'; }

      if (h.result === 'blackjack') credit += h.bet * 2.5;
      else if (h.result === 'win') credit += h.bet * 2;
      else if (h.result === 'push') credit += h.bet;
    }
    if (credit > 0) setBalance(p.id, (balances[p.id] ?? 0) + credit);
  }
  sync(room);

  room.timers.next = setTimeout(() => {
    // Rimuove chi si è disconnesso durante la mano
    room.players = room.players.filter(p => p.connected);
    if (!room.players.find(x => x.id === room.hostId) && room.players[0]) room.hostId = room.players[0].id;
    reseat(room);
    room.phase = 'lobby';
    maybeStartBetting(room);
  }, PAYOUT_PAUSE_MS);
}

function reseat(room) { room.players.forEach((p, i) => { p.seat = i; }); }

/* ---------------- Azioni del giocatore ---------------- */
function currentHand(room, player) {
  if (!room.turn || room.turn.playerId !== player.id) return null;
  return player.hands[room.turn.handIndex] || null;
}

function handleAction(room, player, move) {
  const hand = currentHand(room, player);
  if (!hand || hand.done || room.phase !== 'playing') return;

  if (move === 'hit') {
    hand.cards.push(draw(room));
    const v = handValue(hand.cards).total;
    if (v >= 21) hand.done = true;
    if (v > 21) hand.result = 'lose';
    hand.done ? nextTurn(room) : sync(room);

  } else if (move === 'stand') {
    hand.done = true;
    nextTurn(room);

  } else if (move === 'double') {
    const bal = balances[player.id] ?? 0;
    if (hand.cards.length !== 2 || hand.doubled || bal < hand.bet) return;
    setBalance(player.id, bal - hand.bet);
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(draw(room));            // esattamente una carta, poi sta
    hand.done = true;
    if (handValue(hand.cards).total > 21) hand.result = 'lose';
    nextTurn(room);

  } else if (move === 'split') {
    const bal = balances[player.id] ?? 0;
    const ok = hand.cards.length === 2 &&
               cardValue(hand.cards[0].r) === cardValue(hand.cards[1].r) &&
               player.hands.length === 1 && bal >= hand.bet;
    if (!ok) return;
    setBalance(player.id, bal - hand.bet);
    const [c1, c2] = hand.cards;
    const splitAces = c1.r === 'A';
    const mk = (c) => ({ cards: [c, draw(room)], bet: hand.bet, doubled: false, split: true, done: splitAces, result: null });
    player.hands = [mk(c1), mk(c2)];
    // Con assi divisi si riceve una sola carta per mano (regola classica);
    // 21 dopo split non è blackjack naturale.
    for (const h of player.hands) if (handValue(h.cards).total >= 21) h.done = true;
    nextTurn(room);
  }
}

/* ---------------- Bonus temporizzato globale ---------------- */
let nextBonusAt = Date.now() + BONUS_INTERVAL_MS;
setInterval(() => {
  nextBonusAt = Date.now() + BONUS_INTERVAL_MS;
  for (const room of rooms.values()) {
    for (const p of room.players) {
      if (!p.connected) continue;
      setBalance(p.id, (balances[p.id] ?? 0) + TIMED_BONUS);
      send(p, { type: 'bonus', amount: TIMED_BONUS, balance: balances[p.id] });
    }
    sync(room);
  }
}, BONUS_INTERVAL_MS);

/* ---------------- HTTP + WebSocket ---------------- */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null, player = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'MAIN';
      const pid = String(msg.playerId || '').slice(0, 64);
      const name = String(msg.name || 'Player').slice(0, 16).trim() || 'Player';
      if (!pid) return;

      room = rooms.get(roomId) || makeRoom(roomId);
      const existing = room.players.find(p => p.id === pid);

      if (existing) {                       // riconnessione
        existing.ws = ws; existing.connected = true; existing.name = name;
        player = existing;
      } else {
        if (room.players.length >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'error', code: 'full', msg: 'Tavolo pieno (max 5 giocatori).' }));
          return;
        }
        const { welcome } = getBalance(pid);
        player = {
          id: pid, name, ws, connected: true,
          seat: room.players.length, cardStyle: 1,
          bet: 0, hands: [],
        };
        room.players.push(player);
        if (!room.hostId) room.hostId = pid;
        if (welcome) send(player, { type: 'welcome', amount: WELCOME_BONUS });
      }
      send(player, { type: 'joined', playerId: pid, roomId: room.id });
      if (room.phase === 'lobby') maybeStartBetting(room); else sync(room);
      return;
    }

    if (!room || !player) return;

    switch (msg.type) {
      case 'bet': {
        if (room.phase !== 'betting') return;
        const amount = Math.round(Number(msg.amount) || 0);
        const bal = balances[player.id] ?? 0;
        if (amount < MIN_BET || amount > bal + player.bet) return;
        // Riallinea il saldo alla nuova puntata (permette modifica/annullo prima del via)
        setBalance(player.id, bal + player.bet - amount);
        player.bet = amount;
        sync(room);
        break;
      }
      case 'start':
        hostStart(room, player);
        break;
      case 'clearBet': {
        if (room.phase !== 'betting' || player.bet === 0) return;
        setBalance(player.id, (balances[player.id] ?? 0) + player.bet);
        player.bet = 0;
        sync(room);
        break;
      }
      case 'action':
        handleAction(room, player, String(msg.move));
        break;
      case 'tableStyle': {
        if (player.id !== room.hostId) return;      // solo l'host
        const s = Math.min(10, Math.max(1, msg.style | 0));
        room.tableStyle = s;
        sync(room);
        break;
      }
      case 'cardStyle': {
        const s = Math.min(10, Math.max(1, msg.style | 0));
        player.cardStyle = s;
        sync(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room || !player) return;
    player.connected = false;
    if (room.phase === 'lobby' || room.phase === 'betting') {
      if (player.bet > 0) setBalance(player.id, (balances[player.id] ?? 0) + player.bet);
      room.players = room.players.filter(p => p.id !== player.id);
      if (room.hostId === player.id) room.hostId = room.players[0]?.id || null;
      reseat(room);
      if (room.players.length === 0) { clearRoomTimers(room); rooms.delete(room.id); return; }
      sync(room);
    } else if (room.phase === 'playing' && room.turn?.playerId === player.id) {
      for (const h of player.hands) h.done = true;  // auto-stand su tutte le mani
      nextTurn(room);
    } else {
      sync(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`♠ Blackjack Royale attivo su http://localhost:${PORT}`);
});
