/* ============================================================
   BLACKJACK ROYALE — Client
   Rendering guidato dallo stato del server + animazioni fluide
   (solo transform/opacity, via Web Animations API → 60fps).
   ============================================================ */

'use strict';

/* ---------------- Identità e stanza ---------------- */
const params = new URLSearchParams(location.search);
let roomId = (params.get('room') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
if (!roomId) {
  roomId = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
  history.replaceState(null, '', `?room=${roomId}`);
}
let playerId = localStorage.getItem('bj_pid');
if (!playerId) { playerId = crypto.randomUUID(); localStorage.setItem('bj_pid', playerId); }
let myCardStyle = parseInt(localStorage.getItem('bj_back') || '1', 10);

/* ---------------- Riferimenti DOM ---------------- */
const $ = (id) => document.getElementById(id);
const el = {
  joinOverlay: $('joinOverlay'), nameInput: $('nameInput'), joinBtn: $('joinBtn'),
  joinBacks: $('joinBacks'), joinError: $('joinError'),
  roomCode: $('roomCode'), copyLink: $('copyLink'),
  ledgerRows: $('ledgerRows'), bonusTimer: $('bonusTimer'), bonusBarFill: $('bonusBarFill'),
  dealerCards: $('dealerCards'), dealerValue: $('dealerValue'), dealerAvatar: $('dealerAvatar'),
  phaseBanner: $('phaseBanner'), shoe: $('shoe'), seats: $('seats'),
  betControls: $('betControls'),
  myBetLabel: $('myBetLabel'), clearBet: $('clearBet'),
  startBtn: $('startBtn'), waitHost: $('waitHost'),
  actionControls: $('actionControls'), turnTimerBar: $('turnTimerBar'),
  btnHit: $('btnHit'), btnStand: $('btnStand'), btnDouble: $('btnDouble'), btnSplit: $('btnSplit'),
  openTableStyles: $('openTableStyles'), openCardStyles: $('openCardStyles'),
  tableStylePanel: $('tableStylePanel'), tableStyleGrid: $('tableStyleGrid'),
  cardStylePanel: $('cardStylePanel'), cardStyleGrid: $('cardStyleGrid'),
  toasts: $('toasts'),
};
el.roomCode.textContent = roomId;

const fmt = (n) => Math.round(n).toLocaleString('it-IT');

/* ---------------- WebSocket ---------------- */
let ws = null, joined = false, state = null;
const prev = { cards: {}, faceUp: {}, bets: {}, balances: {}, phase: null };

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { if (joined) sendJoin(); };
  ws.onclose = () => setTimeout(connect, 1200);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') { onState(msg); }
    else if (msg.type === 'welcome') toast(`🎁 Bonus di benvenuto: +${fmt(msg.amount)} fiches!`, 'gold');
    else if (msg.type === 'bonus') toast(`⏰ Ricarica automatica: +${fmt(msg.amount)} fiches`, 'gold');
    else if (msg.type === 'toast') toast(msg.msg);
    else if (msg.type === 'error' && msg.code === 'full') {
      el.joinError.textContent = msg.msg; el.joinOverlay.hidden = false;
    }
  };
}
const wsSend = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
function sendJoin() {
  wsSend({ type: 'join', roomId, playerId, name: el.nameInput.value.trim() || 'Player' });
  wsSend({ type: 'cardStyle', style: myCardStyle });
}
connect();

/* ---------------- Ingresso ---------------- */
el.nameInput.value = localStorage.getItem('bj_name') || '';
el.joinBtn.onclick = () => {
  const name = el.nameInput.value.trim();
  if (!name) { el.joinError.textContent = 'Inserisci un nome per sederti.'; return; }
  localStorage.setItem('bj_name', name);
  joined = true;
  sendJoin();
  el.joinOverlay.hidden = true;
};
el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinBtn.click(); });

el.copyLink.onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('🔗 Link copiato! Invialo ai tuoi amici.'); }
  catch { toast(location.href); }
};

/* ---------------- Pannelli personalizzazione ---------------- */
const TABLE_COLORS = ['#1d6b45','#1c3f66','#6e1f2c','#26262a','#7a5a17','#4b2a63','#0f5c58','#6b3d1c','#24505f','#59203f'];
const TABLE_NAMES = ['Verde Classico','Blu Notte','Rosso Bordeaux','Nero Carbonio','Oro Premium','Viola Imperiale','Petrolio','Terra di Siena','Acciaio Artico','Rosa Notturno'];
const BACK_NAMES = ['Retrò','Cyberpunk','Geometrico','Minimalista','Royale','Smeraldo','Cosmo','Art Déco','Circo','Abisso'];

function buildBacksGrid(container, onPick) {
  container.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const b = document.createElement('button');
    b.className = `back-swatch b-${i}` + (i === myCardStyle ? ' selected' : '');
    b.title = BACK_NAMES[i - 1];
    b.onclick = () => { onPick(i); [...container.children].forEach((c, j) => c.classList.toggle('selected', j === i - 1)); };
    container.appendChild(b);
  }
}
buildBacksGrid(el.joinBacks, (i) => { myCardStyle = i; localStorage.setItem('bj_back', i); });
buildBacksGrid(el.cardStyleGrid, (i) => {
  myCardStyle = i; localStorage.setItem('bj_back', i);
  wsSend({ type: 'cardStyle', style: i });
  toast(`🂠 Dorso carte: ${BACK_NAMES[i - 1]}`);
});

el.tableStyleGrid.innerHTML = '';
TABLE_COLORS.forEach((c, idx) => {
  const b = document.createElement('button');
  b.className = 'table-swatch';
  b.style.background = `radial-gradient(circle at 50% 30%, ${c}, #000 160%)`;
  b.title = TABLE_NAMES[idx];
  b.onclick = () => wsSend({ type: 'tableStyle', style: idx + 1 });
  el.tableStyleGrid.appendChild(b);
});

el.openTableStyles.onclick = () => { el.tableStylePanel.hidden = !el.tableStylePanel.hidden; el.cardStylePanel.hidden = true; };
el.openCardStyles.onclick  = () => { el.cardStylePanel.hidden = !el.cardStylePanel.hidden; el.tableStylePanel.hidden = true; };
document.querySelectorAll('.picker-close').forEach(b => b.onclick = () => { $(b.dataset.close).hidden = true; });

/* ---------------- Puntate ---------------- */
document.querySelectorAll('.chip-btn').forEach(btn => {
  btn.onclick = () => {
    const me = myPlayer(); if (!me || state?.phase !== 'betting') return;
    const add = parseInt(btn.dataset.v, 10);
    if (me.balance < add) { toast('Fiches insufficienti per questa puntata.'); return; }
    wsSend({ type: 'bet', amount: me.bet + add });
    flyChip(btn.getBoundingClientRect(), seatSpotRect(me.seat));
  };
});
el.clearBet.onclick = () => wsSend({ type: 'clearBet' });
el.startBtn.onclick = () => wsSend({ type: 'start' });

/* ---------------- Azioni ---------------- */
el.btnHit.onclick    = () => wsSend({ type: 'action', move: 'hit' });
el.btnStand.onclick  = () => wsSend({ type: 'action', move: 'stand' });
el.btnDouble.onclick = () => wsSend({ type: 'action', move: 'double' });
el.btnSplit.onclick  = () => wsSend({ type: 'action', move: 'split' });

/* ---------------- Utility ---------------- */
function myPlayer() { return state?.players.find(p => p.id === playerId) || null; }
function seatSpotRect(seat) {
  const s = el.seats.querySelector(`.seat[data-pos="${seat}"] .seat-spot`);
  return s ? s.getBoundingClientRect() : el.seats.getBoundingClientRect();
}
function toast(text, cls = '') {
  const t = document.createElement('div');
  t.className = `toast ${cls}`; t.textContent = text;
  el.toasts.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 3200);
}

/* ---------------- Carte: creazione e animazioni ---------------- */
const RED = new Set(['♥', '♦']);
function makeCard(card, backStyle) {
  const root = document.createElement('div');
  root.className = 'card';
  const inner = document.createElement('div');
  inner.className = 'card-inner';

  const face = document.createElement('div');
  if (card && !card.hidden) {
    face.className = 'card-face' + (RED.has(card.s) ? ' red' : '');
    face.innerHTML =
      `<div class="cf-corner">${card.r}<small>${card.s}</small></div>` +
      `<div class="cf-pip">${card.s}</div>` +
      `<div class="cf-corner cf-bottom">${card.r}<small>${card.s}</small></div>`;
  } else {
    face.className = 'card-face';
  }
  const back = document.createElement('div');
  back.className = `card-back b-${backStyle}`;
  inner.append(face, back);
  root.appendChild(inner);
  return root;
}

/* Lancio dal sabot con traiettoria curva (Web Animations API) */
function dealAnimation(cardEl, delay = 0, thenFlip = false) {
  const shoeRect = el.shoe.getBoundingClientRect();
  const cardRect = cardEl.getBoundingClientRect();
  const dx = shoeRect.left + shoeRect.width / 2 - (cardRect.left + cardRect.width / 2);
  const dy = shoeRect.top + shoeRect.height / 2 - (cardRect.top + cardRect.height / 2);

  cardEl.style.opacity = '0';
  dealerMood('dealing');
  const anim = cardEl.animate([
    { transform: `translate(${dx}px, ${dy}px) rotate(-32deg) scale(.8)`, opacity: 1, offset: 0 },
    { transform: `translate(${dx * .5}px, ${dy * .5 - 46}px) rotate(-12deg) scale(.95)`, opacity: 1, offset: .55 },
    { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1, offset: 1 },
  ], { duration: 480, delay, easing: 'cubic-bezier(.22,.75,.3,1)', fill: 'backwards' });
  anim.onfinish = () => {
    cardEl.style.opacity = '1';
    if (thenFlip) requestAnimationFrame(() => cardEl.classList.add('face-up'));
    dealerMood('idle');
  };
}
function instantFaceUp(cardEl) {
  const inner = cardEl.querySelector('.card-inner');
  inner.style.transition = 'none';
  cardEl.classList.add('face-up');
  requestAnimationFrame(() => { inner.style.transition = ''; });
}

/* Fiche che vola tra due punti dello schermo */
function flyChip(fromRect, toRect, delay = 0) {
  const chip = document.createElement('div');
  chip.className = 'fly-chip';
  chip.style.left = `${fromRect.left + fromRect.width / 2 - 17}px`;
  chip.style.top  = `${fromRect.top + fromRect.height / 2 - 17}px`;
  document.body.appendChild(chip);
  const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
  const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
  chip.animate([
    { transform: 'translate(0,0) scale(1)' },
    { transform: `translate(${dx * .5}px, ${dy * .5 - 30}px) scale(1.1)`, offset: .55 },
    { transform: `translate(${dx}px, ${dy}px) scale(.85)` },
  ], { duration: 520, delay, easing: 'cubic-bezier(.25,.8,.3,1)', fill: 'forwards' })
  .onfinish = () => chip.remove();
}
function dealerMood(mood) { el.dealerAvatar.dataset.mood = mood; }

/* ---------------- Rendering dello stato ---------------- */
const PHASE_TEXT = {
  lobby:   'In attesa di giocatori…',
  betting: 'Fate le vostre puntate',
  playing: 'Si gioca — buona fortuna',
  dealer:  'Il banco gioca la sua mano',
  payout:  'Risultati della mano',
};
const RESULT_TEXT = { win: 'VINTO', lose: 'PERSO', push: 'PARI', blackjack: 'BLACKJACK!' };

function onState(s) {
  state = s;
  document.body.className = `t-style-${s.tableStyle}`;
  el.phaseBanner.textContent = PHASE_TEXT[s.phase] || '';

  renderLedger(s);
  renderDealer(s);
  renderSeats(s);
  renderControls(s);

  const me = myPlayer();
  el.openTableStyles.hidden = !(me && s.hostId === playerId);
  [...el.tableStyleGrid.children].forEach((c, i) => c.classList.toggle('selected', i + 1 === s.tableStyle));

  if (s.phase === 'payout' && prev.phase !== 'payout') payoutAnimations(s);
  if (s.phase === 'betting' && prev.phase !== 'betting') { prev.cards = {}; prev.faceUp = {}; }
  prev.phase = s.phase;
}

function renderLedger(s) {
  el.ledgerRows.innerHTML = '';
  for (const p of s.players) {
    const row = document.createElement('div');
    row.className = 'ledger-row' + (p.id === playerId ? ' me' : '');
    row.innerHTML = `<span class="l-name">${escapeHtml(p.name)}${p.id === s.hostId ? ' ★' : ''}</span>
                     <span class="l-bal">${fmt(p.balance)}</span>`;
    if (prev.balances[p.id] !== undefined && prev.balances[p.id] !== p.balance) {
      row.classList.add('bumped');
      setTimeout(() => row.classList.remove('bumped'), 300);
    }
    prev.balances[p.id] = p.balance;
    el.ledgerRows.appendChild(row);
  }
}

function renderDealer(s) {
  syncCardsRow(el.dealerCards, 'dealer', s.dealer.cards, 4); // il banco usa un dorso neutro
  if (s.dealer.value != null) {
    el.dealerValue.hidden = false;
    el.dealerValue.textContent = s.dealer.value;
    el.dealerValue.className = 'hand-value' + (s.dealer.value > 21 ? ' bust' : '');
  } else { el.dealerValue.hidden = true; }
}

function renderSeats(s) {
  // Ricrea i sedili solo se cambia la composizione dei giocatori
  const sig = s.players.map(p => p.id + p.seat).join('|');
  if (el.seats.dataset.sig !== sig) {
    el.seats.dataset.sig = sig;
    el.seats.innerHTML = '';
    for (const p of s.players) {
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.dataset.pos = p.seat;
      seat.dataset.pid = p.id;
      seat.innerHTML = `
        <div class="seat-hands"></div>
        <div class="seat-spot"><span class="seat-bet"></span></div>
        <div class="seat-name"></div>`;
      el.seats.appendChild(seat);
    }
  }

  for (const p of s.players) {
    const seat = el.seats.querySelector(`.seat[data-pid="${p.id}"]`);
    if (!seat) continue;
    seat.classList.toggle('is-me', p.id === playerId);
    seat.classList.toggle('disconnected', !p.connected);
    seat.classList.toggle('is-turn', s.turn?.playerId === p.id);
    seat.querySelector('.seat-name').innerHTML =
      (p.id === s.hostId ? '<span class="host-star">★</span> ' : '') + escapeHtml(p.name);
    seat.querySelector('.seat-bet').textContent = p.bet > 0 ? fmt(p.bet) : '';

    const handsWrap = seat.querySelector('.seat-hands');
    // Allinea il numero di contenitori-mano
    while (handsWrap.children.length < Math.max(1, p.hands.length)) {
      const h = document.createElement('div');
      h.className = 'hand';
      h.innerHTML = '<div class="cards-row"></div><div class="hand-value" hidden></div>';
      handsWrap.appendChild(h);
    }
    while (handsWrap.children.length > Math.max(1, p.hands.length)) handsWrap.lastChild.remove();

    p.hands.forEach((h, hi) => {
      const handEl = handsWrap.children[hi];
      handEl.classList.toggle('is-active-hand',
        s.turn?.playerId === p.id && s.turn?.handIndex === hi && p.hands.length > 1);
      syncCardsRow(handEl.querySelector('.cards-row'), `p${p.id}h${hi}`, h.cards, p.cardStyle, true);
      const val = handEl.querySelector('.hand-value');
      if (h.cards.length) {
        val.hidden = false;
        val.textContent = h.value + (h.doubled ? ' ×2' : '');
        val.className = 'hand-value' + (h.value > 21 ? ' bust' : (h.result === 'blackjack' || (h.value === 21 && h.cards.length === 2 && !h.split) ? ' bj' : ''));
      } else val.hidden = true;
    });
    if (p.hands.length === 0) {
      const row = handsWrap.children[0]?.querySelector('.cards-row');
      if (row) { row.innerHTML = ''; }
      const val = handsWrap.children[0]?.querySelector('.hand-value');
      if (val) val.hidden = true;
    }
  }
}

/* Sincronizza una fila di carte: anima solo le carte nuove e i flip nuovi */
function syncCardsRow(row, key, cards, backStyle, faceUpAll = false) {
  const prevCount = prev.cards[key] || 0;

  if (cards.length < prevCount || cards.length === 0) {
    row.innerHTML = ''; prev.cards[key] = 0; prev.faceUp[key] = 0;
  }
  // Ricostruzione completa se la fila è vuota ma ci sono carte pregresse (es. riconnessione)
  if (row.children.length !== Math.min(cards.length, prev.cards[key] || 0)) {
    row.innerHTML = '';
    for (let i = 0; i < (prev.cards[key] || 0) && i < cards.length; i++) {
      const c = makeCard(cards[i], backStyle);
      if (faceUpAll || !cards[i].hidden) instantFaceUp(c);
      row.appendChild(c);
    }
  }
  // Carte nuove → animazione di lancio dal sabot
  for (let i = row.children.length; i < cards.length; i++) {
    const c = makeCard(cards[i], backStyle);
    row.appendChild(c);
    const shouldFlip = faceUpAll || !cards[i].hidden;
    dealAnimation(c, (i - prevCount) * 140, shouldFlip);
  }
  // Carta coperta del banco che viene rivelata → sostituisci e flip
  cards.forEach((card, i) => {
    const cardEl = row.children[i];
    if (!cardEl) return;
    const isUp = cardEl.classList.contains('face-up');
    if (!card.hidden && !isUp && i < prevCount) {
      const fresh = makeCard(card, backStyle);
      row.replaceChild(fresh, cardEl);
      requestAnimationFrame(() => fresh.classList.add('face-up'));
    }
  });
  prev.cards[key] = cards.length;
}

function renderControls(s) {
  const me = myPlayer();
  const isBetting = s.phase === 'betting' && !!me;
  el.betControls.hidden = !isBetting;
  if (me) el.myBetLabel.textContent = fmt(me.bet);

  // Avvio riservato all'host: parte con 1, 2, 3, 4 o 5 giocatori (basta una puntata)
  const iAmHost = me && s.hostId === playerId;
  el.startBtn.hidden = !(isBetting && iAmHost);
  el.startBtn.disabled = !s.players.some(p => p.bet > 0);
  el.waitHost.hidden = !(isBetting && !iAmHost);

  const myTurn = s.phase === 'playing' && s.turn?.playerId === playerId;
  el.actionControls.hidden = !myTurn;
  if (myTurn && me) {
    const hand = me.hands[s.turn.handIndex];
    const two = hand.cards.length === 2;
    el.btnDouble.disabled = !(two && !hand.doubled && me.balance >= hand.bet);
    el.btnSplit.disabled = !(two && me.hands.length === 1 &&
      cardVal(hand.cards[0].r) === cardVal(hand.cards[1].r) && me.balance >= hand.bet);
  }
}
function cardVal(r) { return r === 'A' ? 11 : (['J','Q','K'].includes(r) ? 10 : parseInt(r, 10)); }

/* ---------------- Animazioni di fine mano ---------------- */
function payoutAnimations(s) {
  dealerMood('collect');
  setTimeout(() => dealerMood('idle'), 1400);
  const ledgerRect = el.ledgerRows.getBoundingClientRect();

  for (const p of s.players) {
    const seat = el.seats.querySelector(`.seat[data-pid="${p.id}"]`);
    if (!seat || p.hands.length === 0) continue;
    const spot = seat.querySelector('.seat-spot').getBoundingClientRect();

    p.hands.forEach((h, hi) => {
      if (!h.result) return;
      const tag = document.createElement('div');
      tag.className = `result-tag ${h.result}`;
      tag.textContent = RESULT_TEXT[h.result];
      seat.appendChild(tag);
      setTimeout(() => tag.remove(), 4500);

      const won = h.result === 'win' || h.result === 'blackjack' || h.result === 'push';
      const chips = h.result === 'blackjack' ? 5 : 3;
      for (let i = 0; i < chips; i++) {
        if (won) flyChip(spot, ledgerRect, hi * 120 + i * 90);       // vincita → verso il saldo
        else     flyChip(spot, el.dealerCards.getBoundingClientRect(), hi * 120 + i * 90); // persa → al banco
      }
    });
  }
}

/* ---------------- Timer animati (rAF) ---------------- */
function tick() {
  const now = Date.now();
  if (state?.turnEndsAt && state.phase === 'playing') {
    const frac = Math.max(0, (state.turnEndsAt - now) / 30000);
    el.turnTimerBar.style.transform = `scaleX(${frac})`;
  }

  if (state?.nextBonusAt) {
    const ms = Math.max(0, state.nextBonusAt - now);
    const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
    el.bonusTimer.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    el.bonusBarFill.style.width = `${100 - (ms / (15 * 60 * 1000)) * 100}%`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
