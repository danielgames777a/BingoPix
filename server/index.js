// BingoPix — protótipo estritamente simulado. Não realiza cobranças nem transferências reais.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const {
  CARD_PRICE_CENTS,
  DEPOSIT_MIN_CENTS,
  DEPOSIT_MAX_CENTS,
  FIRST_DEPOSIT_BONUS_CENTS,
  NORMAL_PRIZE_CAP_CENTS,
  SPECIAL_PRIZE_CAP_CENTS,
  PRIZE_SPLIT,
  ensureWallet,
  totalWalletCents,
  spendForCards,
  splitPrizePool,
  randomRoundPoolCents,
} = require('./finance');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || `bingopix-test-${crypto.randomBytes(24).toString('hex')}`;
const ROUND_MIN = Number(process.env.ROUND_MIN) || 5;
const DRAW_MS = Number(process.env.DRAW_MS) || 3000;
const MAX_CARDS = 50;
const TEST_MODE = true;
const VIP = [
  { name: 'Bronze', min: 0, cashback: 0 },
  { name: 'Prata', min: 100, cashback: 0 },
  { name: 'Ouro', min: 500, cashback: 0 },
  { name: 'Diamante', min: 2000, cashback: 0 },
];

// O protótipo usa JSON local apenas para testes. Não armazene dados Pix reais aqui.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
let loadedData = {};
try { loadedData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let db = { schemaVersion: 2, users: {}, history: [], deposits: [], withdrawals: [], ...loadedData };
db.users ||= {};
db.history ||= [];
db.deposits ||= [];
db.withdrawals ||= [];

// Saldos antigos eram fichas fictícias e não podem virar dinheiro. Migrações limpam esses valores.
if ((loadedData.schemaVersion || 1) < 2) {
  db.history = [];
  db.deposits = [];
  db.withdrawals = [];
  for (const user of Object.values(db.users)) {
    user.cashCents = 0;
    user.bonusCents = 0;
    user.firstDepositBonusGranted = false;
    user.tx = [];
    user.games = [];
    user.wonCents = 0;
    user.schemaVersion = 2;
  }
  db.schemaVersion = 2;
}
db.schemaVersion = 2;
for (const user of Object.values(db.users)) {
  ensureWallet(user);
  user.ref ||= crypto.randomBytes(4).toString('hex').toUpperCase();
  user.tx ||= [];
  user.games ||= [];
  user.wins ||= 0;
  user.wonCents ||= 0;
  user.cardsTotal ||= 0;
  user.refs ||= 0;
  user.refPaid ||= false;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  }, 100);
}

function vipOf(user) {
  const cards = user.cardsTotal || 0;
  let index = 0;
  VIP.forEach((level, i) => { if (cards >= level.min) index = i; });
  return { i: index, ...VIP[index], next: VIP[index + 1] || null, cards };
}

function pendingWithdrawalCents(userKey) {
  return db.withdrawals
    .filter((request) => request.ownerKey === userKey && request.status === 'pending')
    .reduce((total, request) => total + request.amountCents, 0);
}

function publicUser(userKey) {
  const user = db.users[userKey];
  if (!user) return null;
  ensureWallet(user);
  const adminUser = String(process.env.ADMIN_USER || '').trim().toLowerCase();
  return {
    name: user.name,
    balanceCents: totalWalletCents(user),
    cashCents: user.cashCents,
    bonusCents: user.bonusCents,
    withdrawableCents: Math.max(0, user.cashCents - pendingWithdrawalCents(userKey)),
    wins: user.wins || 0,
    wonCents: user.wonCents || 0,
    ref: user.ref,
    refs: user.refs || 0,
    vip: vipOf(user),
    created: user.created,
    firstDepositBonusGranted: Boolean(user.firstDepositBonusGranted),
    isAdmin: Boolean(adminUser && adminUser === userKey),
    testMode: true,
  };
}

function recordTransaction(user, wallet, amountCents, description) {
  user.tx.unshift({
    at: Date.now(),
    wallet,
    amountCents,
    description,
    cashCents: user.cashCents,
    bonusCents: user.bonusCents,
  });
  user.tx = user.tx.slice(0, 200);
}

function transaction(user, wallet, amountCents, description) {
  ensureWallet(user);
  if (!Number.isSafeInteger(amountCents)) throw new Error('Valor inválido.');
  const key = wallet === 'bonus' ? 'bonusCents' : 'cashCents';
  if (user[key] + amountCents < 0) throw new Error('Saldo insuficiente.');
  user[key] += amountCents;
  recordTransaction(user, wallet, amountCents, description);
}

function refCode() {
  let code;
  do { code = crypto.randomBytes(4).toString('hex').toUpperCase(); }
  while (Object.values(db.users).some((user) => user.ref === code));
  return code;
}

function nextSlot(time) {
  const interval = ROUND_MIN * 60_000;
  return Math.ceil((time + 30_000) / interval) * interval;
}
const isSpecial = (time) => new Date(time).getUTCMinutes() === 0;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function auth(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) throw new Error('missing token');
    const { u } = jwt.verify(header.slice(7), JWT_SECRET);
    req.k = u;
    req.user = db.users[u];
    if (!req.user) throw new Error('unknown user');
    ensureWallet(req.user);
    next();
  } catch {
    res.status(401).json({ error: 'Faça login novamente.' });
  }
}

function adminOnly(req, res, next) {
  const adminUser = String(process.env.ADMIN_USER || '').trim().toLowerCase();
  if (!adminUser) return res.status(503).json({ error: 'O painel administrativo ainda não foi configurado para este teste.' });
  if (req.k !== adminUser) return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  next();
}

const tokenFor = (key) => jwt.sign({ u: key }, JWT_SECRET, { expiresIn: '60d' });

app.get('/api/config', (_req, res) => {
  res.json({
    testMode: true,
    paymentProvider: 'simulado',
    depositMinCents: DEPOSIT_MIN_CENTS,
    depositMaxCents: DEPOSIT_MAX_CENTS,
    cardPriceCents: CARD_PRICE_CENTS,
    firstDepositBonusCents: FIRST_DEPOSIT_BONUS_CENTS,
    prizeCapsCents: { normal: NORMAL_PRIZE_CAP_CENTS, special: SPECIAL_PRIZE_CAP_CENTS },
    prizeSplit: PRIZE_SPLIT,
  });
});

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.pass || '');
  if (!/^[A-Za-z0-9_.]{3,16}$/.test(name)) return res.status(400).json({ error: 'Usuário: use 3 a 16 letras, números, _ ou .' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  const key = name.toLowerCase();
  if (db.users[key]) return res.status(400).json({ error: 'Esse usuário já existe.' });
  const referral = String(req.body.ref || '').trim().toUpperCase();
  const sponsor = referral && Object.entries(db.users).find(([, user]) => user.ref === referral);
  const user = db.users[key] = {
    name,
    hash: bcrypt.hashSync(password, 10),
    cashCents: 0,
    bonusCents: 0,
    firstDepositBonusGranted: false,
    created: Date.now(),
    wins: 0,
    wonCents: 0,
    ref: refCode(),
    by: sponsor ? sponsor[0] : null,
    refPaid: false,
    refs: 0,
    tx: [],
    games: [],
    cardsTotal: 0,
    schemaVersion: 2,
  };
  save();
  res.json({ token: tokenFor(key), user: publicUser(key) });
});

app.post('/api/login', (req, res) => {
  const key = String(req.body.name || '').trim().toLowerCase();
  const user = db.users[key];
  if (!user || !bcrypt.compareSync(String(req.body.pass || ''), user.hash)) {
    return res.status(400).json({ error: 'Usuário ou senha incorretos.' });
  }
  res.json({ token: tokenFor(key), user: publicUser(key) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.k) }));
app.get('/api/extrato', auth, (req, res) => res.json({ list: req.user.tx || [] }));
app.get('/api/jogos', auth, (req, res) => res.json({ list: req.user.games || [] }));
app.get('/api/rodadas', (req, res) => {
  const list = [];
  let time = R ? R.endsAt : nextSlot(Date.now());
  for (let i = 0; i < 24; i++) {
    const special = isSpecial(time);
    list.push({
      at: time,
      special,
      maxPrizeCents: special ? SPECIAL_PRIZE_CAP_CENTS : NORMAL_PRIZE_CAP_CENTS,
      priceCents: CARD_PRICE_CENTS,
    });
    time += ROUND_MIN * 60_000;
  }
  res.json({
    list,
    vip: VIP,
    history: db.history.slice(0, 20),
    split: PRIZE_SPLIT,
    specialPoolCents: SPECIAL_PRIZE_CAP_CENTS,
    normalPoolCents: NORMAL_PRIZE_CAP_CENTS,
    roundMin: ROUND_MIN,
    testMode: true,
  });
});

app.get('/api/ranking', (_req, res) => {
  res.json({ list: Object.entries(db.users)
    .sort(([, a], [, b]) => (b.wonCents || 0) - (a.wonCents || 0))
    .slice(0, 10)
    .map(([key]) => publicUser(key)) });
});

app.post('/api/perfil', auth, (req, res) => {
  const { old, pass } = req.body || {};
  if (!bcrypt.compareSync(String(old || ''), req.user.hash)) return res.status(400).json({ error: 'Senha atual incorreta.' });
  if (String(pass || '').length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
  req.user.hash = bcrypt.hashSync(String(pass), 10);
  save();
  res.json({ ok: true });
});

app.post('/api/refill', auth, (_req, res) => res.status(410).json({ error: 'A recarga grátis foi removida. O saldo começa em R$ 0,00.' }));

// Depósitos e confirmações são 100% simulados: nenhuma chamada é feita à InfinitePay.
app.get('/api/depositos', auth, (req, res) => {
  const list = db.deposits.filter((deposit) => deposit.ownerKey === req.k).slice(-25).reverse();
  res.json({ list, testMode: true });
});

app.post('/api/depositos', auth, (req, res) => {
  const amountCents = Number(req.body.amountCents);
  if (!Number.isSafeInteger(amountCents) || amountCents < DEPOSIT_MIN_CENTS || amountCents > DEPOSIT_MAX_CENTS) {
    return res.status(400).json({ error: 'No teste, o depósito deve ser de R$ 5,00 a R$ 50,00.' });
  }
  const deposit = {
    id: `dep_${crypto.randomBytes(8).toString('hex')}`,
    ownerKey: req.k,
    amountCents,
    status: 'pending_test',
    createdAt: Date.now(),
  };
  db.deposits.push(deposit);
  save();
  res.status(201).json({ deposit, testMode: true, message: 'Depósito de teste criado. Nenhuma cobrança real foi iniciada.' });
});

app.post('/api/depositos/:id/confirmar-teste', auth, (req, res) => {
  const deposit = db.deposits.find((item) => item.id === req.params.id && item.ownerKey === req.k);
  if (!deposit) return res.status(404).json({ error: 'Depósito de teste não encontrado.' });
  if (deposit.status !== 'pending_test') return res.status(409).json({ error: 'Esse depósito de teste já foi confirmado ou encerrado.' });
  deposit.status = 'confirmed_test';
  deposit.confirmedAt = Date.now();
  transaction(req.user, 'cash', deposit.amountCents, 'Depósito de teste confirmado');
  let bonusGranted = false;
  if (!req.user.firstDepositBonusGranted) {
    req.user.firstDepositBonusGranted = true;
    transaction(req.user, 'bonus', FIRST_DEPOSIT_BONUS_CENTS, 'Bônus de teste do primeiro depósito');
    bonusGranted = true;
  }
  save();
  res.json({ deposit, user: publicUser(req.k), bonusGranted, testMode: true });
});

app.get('/api/saques', auth, (req, res) => {
  const list = db.withdrawals.filter((request) => request.ownerKey === req.k).slice(-25).reverse();
  res.json({ list, testMode: true });
});

app.post('/api/saques', auth, (req, res) => {
  const amountCents = Number(req.body.amountCents);
  const pixType = String(req.body.pixType || '');
  const allowedPixTypes = new Set(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Informe um valor de saque válido.' });
  if (!allowedPixTypes.has(pixType)) return res.status(400).json({ error: 'Escolha o tipo da chave Pix para o teste.' });
  const available = Math.max(0, req.user.cashCents - pendingWithdrawalCents(req.k));
  if (amountCents > available) return res.status(400).json({ error: 'O valor excede o saldo disponível para saque.' });

  // A chave Pix não é enviada pelo cliente à API nem gravada no JSON de teste.
  const request = {
    id: `saq_${crypto.randomBytes(8).toString('hex')}`,
    ownerKey: req.k,
    ownerName: req.user.name,
    amountCents,
    pixType,
    status: 'pending',
    createdAt: Date.now(),
    testMode: true,
  };
  db.withdrawals.push(request);
  save();
  res.status(201).json({ request, user: publicUser(req.k), testMode: true, message: 'Solicitação de teste criada. Nenhuma transferência será feita.' });
});

app.get('/api/admin/saques', auth, adminOnly, (_req, res) => {
  const list = db.withdrawals.slice().reverse().map(({ id, ownerName, amountCents, pixType, status, createdAt, handledAt }) => ({
    id, ownerName, amountCents, pixType, status, createdAt, handledAt,
  }));
  res.json({ list, testMode: true });
});

app.post('/api/admin/saques/:id', auth, adminOnly, (req, res) => {
  const request = db.withdrawals.find((item) => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Solicitação não encontrada.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Essa solicitação já foi analisada.' });
  const action = String(req.body.action || '');
  if (!['paid_test', 'rejected'].includes(action)) return res.status(400).json({ error: 'Ação de teste inválida.' });
  const user = db.users[request.ownerKey];
  if (!user) return res.status(404).json({ error: 'Conta da pessoa solicitante não encontrada.' });
  if (action === 'paid_test') {
    if (user.cashCents < request.amountCents) return res.status(409).json({ error: 'Saldo sacável insuficiente para concluir o registro de teste.' });
    transaction(user, 'cash', -request.amountCents, 'Saque manual simulado');
  }
  request.status = action;
  request.handledAt = Date.now();
  save();
  emitTo(request.ownerKey, 'me', publicUser(request.ownerKey));
  emitTo(request.ownerKey, 'note', action === 'paid_test' ? 'Pagamento manual simulado como concluído.' : 'Solicitação de saque de teste recusada.');
  res.json({ request: { id: request.id, status: request.status, handledAt: request.handledAt }, user: publicUser(request.ownerKey), testMode: true });
});

// ---------- jogo ----------
let roundNo = (db.history[0] && db.history[0].no) || 0;
let R = null;
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function makeCard() {
  const numbers = shuffle(Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, 15);
  return { id: String(10000 + crypto.randomInt(190000)), rows: [numbers.slice(0, 5), numbers.slice(5, 10), numbers.slice(10, 15)].map((row) => row.sort((a, b) => a - b)) };
}

function newRound() {
  roundNo++;
  const endsAt = nextSlot(Date.now());
  const special = isSpecial(endsAt);
  const poolCents = randomRoundPoolCents(special);
  R = {
    no: roundNo,
    phase: 'buy',
    endsAt,
    special,
    poolCents,
    prizeShares: splitPrizePool(poolCents),
    won: {},
    cards: [],
    balls: [],
    drawn: new Set(),
    prizes: { quadra: null, quina: null, bingo: null },
  };
  broadcastState();
  setTimeout(startDraw, Math.max(0, endsAt - Date.now()));
}

const pool = () => R.poolCents;
const lineHits = (card) => card.rows.map((row) => row.filter((number) => R.drawn.has(number)).length);

function startDraw() {
  if (!R || R.phase !== 'buy') return;
  R.phase = 'draw';
  R.order = shuffle(Array.from({ length: 90 }, (_, i) => i + 1));
  broadcastState();
  const tick = () => {
    const ball = R.order[R.balls.length];
    R.balls.push(ball);
    R.drawn.add(ball);
    const won = checkWinners();
    io.emit('ball', { b: ball, n: R.balls.length, won, best: bestToGo() });
    if (R.prizes.bingo || R.balls.length >= 90) return setTimeout(finish, 6000);
    setTimeout(tick, won.length ? DRAW_MS + 3500 : DRAW_MS);
  };
  setTimeout(tick, 1500);
}

function checkWinners() {
  const output = [];
  for (const stage of ['quadra', 'quina', 'bingo']) {
    if (R.prizes[stage]) continue;
    const winners = R.cards.filter((card) => {
      const hits = lineHits(card);
      if (stage === 'quadra') return hits.some((count) => count >= 4);
      if (stage === 'quina') return hits.some((count) => count === 5);
      return hits.every((count) => count === 5);
    });
    if (!winners.length) break;
    const stageTotalCents = R.prizeShares[stage];
    const eachCents = Math.floor(stageTotalCents / winners.length);
    const names = [...new Set(winners.map((card) => card.ownerName))];
    R.prizes[stage] = { amountCents: eachCents, totalCents: stageTotalCents, names, ball: R.balls.length };
    for (const card of winners) {
      const user = card.owner && db.users[card.owner];
      if (!user) continue;
      const label = { quadra: 'Quadra', quina: 'Quina', bingo: 'Bingo' }[stage];
      transaction(user, 'cash', eachCents, `Prêmio simulado ${label} · rodada #${R.no}`);
      user.wonCents = (user.wonCents || 0) + eachCents;
      user.wins = (user.wins || 0) + 1;
      (R.won[card.owner] = R.won[card.owner] || []).push({ stage, amountCents: eachCents });
      emitTo(card.owner, 'me', publicUser(card.owner));
    }
    output.push({ stage, amountCents: eachCents, names, cards: winners.map((card) => card.id) });
    save();
    if (stage !== 'bingo') break;
  }
  return output;
}

function bestToGo() {
  const stage = !R.prizes.quadra ? 'quadra' : !R.prizes.quina ? 'quina' : 'bingo';
  const list = R.cards.map((card) => {
    const missing = card.rows.map((row) => row.filter((number) => !R.drawn.has(number)));
    let need;
    let count;
    if (stage === 'bingo') {
      need = missing.flat().sort((a, b) => a - b);
      count = need.length;
    } else {
      const best = missing.slice().sort((a, b) => a.length - b.length)[0];
      need = best;
      count = stage === 'quadra' ? Math.max(0, best.length - 1) : best.length;
    }
    return { cupom: card.id, name: card.ownerName, need, cnt: count };
  }).sort((a, b) => a.cnt - b.cnt || a.need.length - b.need.length).slice(0, 10);
  return { stage, top: list };
}

function finish() {
  if (!R || R.phase === 'end') return;
  R.phase = 'end';
  const owners = {};
  for (const card of R.cards) if (card.owner) owners[card.owner] = (owners[card.owner] || 0) + 1;
  for (const [key, count] of Object.entries(owners)) {
    const user = db.users[key];
    if (!user) continue;
    const prizes = R.won[key] || [];
    const wonCents = prizes.reduce((total, prize) => total + prize.amountCents, 0);
    user.games.unshift({
      no: R.no,
      at: R.endsAt,
      special: R.special,
      cards: count,
      spentCents: count * CARD_PRICE_CENTS,
      wonCents,
      prizes: prizes.map((prize) => prize.stage),
      cashbackCents: 0,
      balls: R.balls.length,
    });
    user.games = user.games.slice(0, 100);
    emitTo(key, 'me', publicUser(key));
  }
  db.history.unshift({
    no: R.no,
    at: R.endsAt,
    special: R.special,
    balls: R.balls.length,
    cards: R.cards.length,
    poolCents: pool(),
    prizes: R.prizes,
  });
  db.history = db.history.slice(0, 50);
  save();
  broadcastState();
  setTimeout(newRound, 3000);
}

function stateFor(userKey) {
  return {
    no: R.no,
    phase: R.phase,
    endsAt: R.endsAt,
    special: R.special,
    now: Date.now(),
    balls: R.balls,
    priceCents: CARD_PRICE_CENTS,
    poolCents: pool(),
    nCards: R.cards.length,
    players: new Set(R.cards.map((card) => card.ownerName)).size,
    prizes: R.prizes,
    split: PRIZE_SPLIT,
    mine: userKey ? R.cards.filter((card) => card.owner === userKey).map(({ id, rows }) => ({ id, rows })) : [],
    online: io.engine.clientsCount,
    roundMin: ROUND_MIN,
    prizeCapsCents: { normal: NORMAL_PRIZE_CAP_CENTS, special: SPECIAL_PRIZE_CAP_CENTS },
    best: R.phase === 'draw' ? bestToGo() : null,
    testMode: true,
  };
}
function broadcastState() {
  if (!R) return;
  for (const socket of io.sockets.sockets.values()) socket.emit('state', stateFor(socket.data.k));
}

const server = http.createServer(app);
const io = new Server(server);
const socketByUser = new Map();
function emitTo(userKey, event, data) {
  const sockets = socketByUser.get(userKey);
  if (sockets) for (const socket of sockets) socket.emit(event, data);
}

io.on('connection', (socket) => {
  try {
    const { u } = jwt.verify(socket.handshake.auth.token || '', JWT_SECRET);
    if (db.users[u]) {
      socket.data.k = u;
      if (!socketByUser.has(u)) socketByUser.set(u, new Set());
      socketByUser.get(u).add(socket);
    }
  } catch {}
  socket.emit('state', stateFor(socket.data.k));
  io.emit('online', io.engine.clientsCount);

  socket.on('buy', (rawQuantity, callback) => {
    const key = socket.data.k;
    const user = key && db.users[key];
    if (!user) return callback && callback({ error: 'Faça login para comprar cartelas.' });
    if (R.phase !== 'buy') return callback && callback({ error: 'As compras fecharam. Aguarde a próxima rodada.' });
    const quantity = Math.max(1, Math.min(MAX_CARDS, parseInt(rawQuantity, 10) || 1));
    const alreadyOwned = R.cards.filter((card) => card.owner === key).length;
    if (alreadyOwned + quantity > MAX_CARDS) return callback && callback({ error: `Máximo de ${MAX_CARDS} cartelas por rodada.` });
    const totalCents = quantity * CARD_PRICE_CENTS;
    const availableCashCents = Math.max(0, user.cashCents - pendingWithdrawalCents(key));
    if (user.bonusCents + availableCashCents < totalCents) {
      return callback && callback({ error: 'Saldo insuficiente. Faça um depósito de teste para continuar.' });
    }
    try {
      const spent = spendForCards(user, totalCents);
      if (spent.bonusUsedCents) recordTransaction(user, 'bonus', -spent.bonusUsedCents, `Compra de ${quantity} cartela${quantity > 1 ? 's' : ''} · rodada #${R.no}`);
      if (spent.cashUsedCents) recordTransaction(user, 'cash', -spent.cashUsedCents, `Compra de ${quantity} cartela${quantity > 1 ? 's' : ''} · rodada #${R.no}`);
      user.cardsTotal = (user.cardsTotal || 0) + quantity;
      for (let i = 0; i < quantity; i++) R.cards.push({ ...makeCard(), owner: key, ownerName: user.name });
      if (user.by && !user.refPaid && db.users[user.by]) {
        const sponsor = db.users[user.by];
        user.refPaid = true;
        sponsor.refs = (sponsor.refs || 0) + 1;
        emitTo(user.by, 'me', publicUser(user.by));
        emitTo(user.by, 'note', `${user.name} entrou pelo seu link.`);
      }
      save();
      callback && callback({ ok: true, user: publicUser(key), testMode: true });
      broadcastState();
    } catch (error) {
      callback && callback({ error: error.message || 'Não foi possível comprar as cartelas.' });
    }
  });

  socket.on('disconnect', () => {
    const set = socketByUser.get(socket.data.k);
    if (set) {
      set.delete(socket);
      if (!set.size) socketByUser.delete(socket.data.k);
    }
    io.emit('online', io.engine.clientsCount);
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, testMode: true, round: R && R.no, phase: R && R.phase }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BingoPix em modo de teste na porta ${PORT}; sem cobranças ou transferências reais.`);
  newRound();
});
