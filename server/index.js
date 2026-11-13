// BingoPix - bingo online com fichas (sem dinheiro real)
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'bingopix-' + crypto.randomBytes(8).toString('hex');
const ROUND_MIN = +process.env.ROUND_MIN || 5;       // rodada a cada N minutos pelo relógio (22:50, 22:55...)
const DRAW_MS = +process.env.DRAW_MS || 2000;        // ms entre bolas
const CARD_PRICE = +process.env.CARD_PRICE || 20;    // fichas por cartela
const AUTO = process.env.AUTO_PLAYERS != null ? +process.env.AUTO_PLAYERS : 10; // jogadores automáticos sempre online
const WELCOME = 1000;
const MAX_CARDS = 50;
const SPLIT = { quadra: 0.15, quina: 0.25, bingo: 0.60 };
const MIN_POOL = 400;          // prêmio mínimo garantido numa rodada normal
const SPECIAL_POOL = 3000;     // prêmio mínimo garantido na rodada especial (toda hora cheia)
const REF_BONUS = +process.env.REF_BONUS || 40; // fichas pro padrinho quando o indicado compra a 1ª cartela
const VIP = [
  { name: 'Bronze', min: 0, cashback: 0 },
  { name: 'Prata', min: 100, cashback: 0.02 },
  { name: 'Ouro', min: 500, cashback: 0.05 },
  { name: 'Diamante', min: 2000, cashback: 0.10 },
];

// ---------- armazenamento simples em arquivo ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, history: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db)); }, 300);
}
function vipOf(u) { const c = u.cardsTotal || 0; let i = 0; VIP.forEach((v, j) => { if (c >= v.min) i = j; }); return { i, ...VIP[i], next: VIP[i + 1] || null, cards: c }; }
const pub = (u) => ({ name: u.name, balance: u.balance, wins: u.wins || 0, won: u.won || 0, ref: u.ref, refs: u.refs || 0, refEarned: u.refEarned || 0, vip: vipOf(u), created: u.created });
function refCode() { let c; do { c = crypto.randomBytes(4).toString('hex').toUpperCase(); } while (Object.values(db.users).some((u) => u.ref === c)); return c; }
for (const u of Object.values(db.users)) { if (!u.ref) u.ref = refCode(); u.tx = u.tx || []; u.games = u.games || []; }
function tx(u, amount, desc) { u.balance += amount; u.tx.unshift({ at: Date.now(), amount, desc, bal: u.balance }); u.tx = u.tx.slice(0, 150); }
function nextSlot(t) { const ms = ROUND_MIN * 60000; return Math.ceil((t + 30000) / ms) * ms; }
const isSpecial = (t) => new Date(t).getUTCMinutes() === 0;

// ---------- http ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function auth(req, res, next) {
  try {
    const { u } = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    req.user = db.users[u]; req.k = u;
    if (!req.user) throw 0;
    next();
  } catch { res.status(401).json({ error: 'Faça login de novo.' }); }
}
const tokenFor = (k) => jwt.sign({ u: k }, JWT_SECRET, { expiresIn: '60d' });

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const pass = String(req.body.pass || '');
  if (!/^[A-Za-z0-9_.]{3,16}$/.test(name)) return res.status(400).json({ error: 'Usuário: 3 a 16 letras, números, _ ou .' });
  if (pass.length < 6) return res.status(400).json({ error: 'Senha com pelo menos 6 caracteres.' });
  const k = name.toLowerCase();
  if (db.users[k]) return res.status(400).json({ error: 'Esse usuário já existe.' });
  const by = String(req.body.ref || '').trim().toUpperCase();
  const sponsor = by && Object.entries(db.users).find(([, u]) => u.ref === by);
  const u = db.users[k] = { name, hash: bcrypt.hashSync(pass, 8), balance: 0, created: Date.now(), wins: 0, won: 0, ref: refCode(), by: sponsor ? sponsor[0] : null, refPaid: false, tx: [], games: [], cardsTotal: 0 };
  tx(u, WELCOME, 'Bônus de boas-vindas');
  save();
  res.json({ token: tokenFor(k), user: pub(u) });
});

app.post('/api/login', (req, res) => {
  const k = String(req.body.name || '').trim().toLowerCase();
  const u = db.users[k];
  if (!u || !bcrypt.compareSync(String(req.body.pass || ''), u.hash)) return res.status(400).json({ error: 'Usuário ou senha incorretos.' });
  res.json({ token: tokenFor(k), user: pub(u) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));
app.get('/api/extrato', auth, (req, res) => res.json({ list: req.user.tx || [] }));
app.get('/api/jogos', auth, (req, res) => res.json({ list: req.user.games || [] }));

app.post('/api/perfil', auth, (req, res) => {
  const { old, pass } = req.body || {};
  if (!bcrypt.compareSync(String(old || ''), req.user.hash)) return res.status(400).json({ error: 'Senha atual incorreta.' });
  if (String(pass || '').length < 6) return res.status(400).json({ error: 'Nova senha com pelo menos 6 caracteres.' });
  req.user.hash = bcrypt.hashSync(String(pass), 8); save();
  res.json({ ok: true });
});

// recarga grátis de fichas quando acabar
app.post('/api/refill', auth, (req, res) => {
  if (req.user.balance >= CARD_PRICE) return res.status(400).json({ error: 'A recarga grátis libera quando suas fichas acabarem.' });
  tx(req.user, WELCOME, 'Recarga grátis'); save();
  res.json({ user: pub(req.user) });
});

app.get('/api/rodadas', (req, res) => {
  const list = []; let t = R ? R.endsAt : nextSlot(Date.now());
  for (let i = 0; i < 24; i++) { list.push({ at: t, special: isSpecial(t), min: isSpecial(t) ? SPECIAL_POOL : MIN_POOL, price: CARD_PRICE }); t += ROUND_MIN * 60000; }
  res.json({ list, vip: VIP, history: db.history.slice(0, 20), split: SPLIT, specialPool: SPECIAL_POOL, minPool: MIN_POOL, refBonus: REF_BONUS, roundMin: ROUND_MIN });
});

app.get('/api/ranking', (req, res) => {
  res.json({ list: Object.values(db.users).sort((a, b) => (b.won || 0) - (a.won || 0)).slice(0, 10).map(pub) });
});

// ---------- jogo ----------
let roundNo = (db.history[0] && db.history[0].no) || 0;
let R = null;

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function makeCard() {
  const nums = shuffle(Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, 15);
  return { id: crypto.randomBytes(4).toString('hex'), rows: [nums.slice(0, 5), nums.slice(5, 10), nums.slice(10, 15)].map((r) => r.sort((a, b) => a - b)) };
}
const AUTO_NAMES = ['Lucas', 'Maria', 'Rafa_gyn', 'Bia.santos', 'Thiago', 'Duda', 'Carlos77', 'Lu_bingo', 'Pedrinho', 'Jessica'].slice(0, AUTO);

function newRound() {
  roundNo++;
  const at = nextSlot(Date.now());
  R = { no: roundNo, phase: 'buy', endsAt: at, special: isSpecial(at), won: {}, cards: [], balls: [], drawn: new Set(), prizes: { quadra: null, quina: null, bingo: null } };
  broadcastState();
  for (const name of AUTO_NAMES) {
    const n = 1 + crypto.randomInt(R.special ? 15 : 8);
    const t = crypto.randomInt(Math.max(1000, at - Date.now() - 3000));
    setTimeout(() => { if (R.phase !== 'buy') return; for (let i = 0; i < n; i++) R.cards.push({ ...makeCard(), owner: null, ownerName: name }); broadcastState(); }, t);
  }
  setTimeout(startDraw, at - Date.now());
}

const pool = () => Math.max(R.special ? SPECIAL_POOL : MIN_POOL, R.cards.length * CARD_PRICE);
const lineHits = (card) => card.rows.map((r) => r.filter((n) => R.drawn.has(n)).length);

function startDraw() {
  R.phase = 'draw';
  R.order = shuffle(Array.from({ length: 90 }, (_, i) => i + 1));
  broadcastState();
  const tick = () => {
    const b = R.order[R.balls.length];
    R.balls.push(b); R.drawn.add(b);
    const won = checkWinners();
    io.emit('ball', { b, n: R.balls.length, won, best: bestToGo() });
    if (R.prizes.bingo || R.balls.length >= 90) return setTimeout(finish, 6000);
    setTimeout(tick, won.length ? DRAW_MS + 3500 : DRAW_MS);
  };
  setTimeout(tick, 1500);
}

function checkWinners() {
  const out = []; const total = pool();
  for (const stage of ['quadra', 'quina', 'bingo']) {
    if (R.prizes[stage]) continue;
    const winners = R.cards.filter((c) => {
      const h = lineHits(c);
      if (stage === 'quadra') return h.some((x) => x >= 4);
      if (stage === 'quina') return h.some((x) => x === 5);
      return h.every((x) => x === 5);
    });
    if (!winners.length) break;
    const each = Math.floor((total * SPLIT[stage]) / winners.length);
    R.prizes[stage] = { amount: each, names: [...new Set(winners.map((c) => c.ownerName))], ball: R.balls.length };
    for (const c of winners) {
      const u = c.owner && db.users[c.owner];
      if (!u) continue;
      const label = { quadra: 'Quadra', quina: 'Quina', bingo: 'Bingo' }[stage];
      tx(u, each, `Prêmio ${label} · rodada #${R.no}`); u.won = (u.won || 0) + each; u.wins = (u.wins || 0) + 1;
      (R.won[c.owner] = R.won[c.owner] || []).push({ stage, amount: each });
      emitTo(c.owner, 'me', pub(u));
    }
    out.push({ stage, amount: each, names: R.prizes[stage].names, cards: winners.map((c) => c.id) });
    save();
    if (stage !== 'bingo') break;
  }
  return out;
}

function bestToGo() {
  const list = R.cards.map((c) => ({ name: c.ownerName, id: c.id, need: c.rows.flat().filter((n) => !R.drawn.has(n)).sort((a, b) => a - b) }))
    .filter((x) => x.need.length).sort((a, b) => a.need.length - b.need.length).slice(0, 5);
  return { top: list };
}

function finish() {
  R.phase = 'end';
  // histórico por jogador + cashback VIP
  const owners = {};
  for (const c of R.cards) if (c.owner) owners[c.owner] = (owners[c.owner] || 0) + 1;
  for (const [k, n] of Object.entries(owners)) {
    const u = db.users[k]; if (!u) continue;
    const prizes = R.won[k] || [];
    const wonAmt = prizes.reduce((a, p) => a + p.amount, 0);
    const v = vipOf(u); const cb = Math.floor(n * CARD_PRICE * v.cashback);
    if (cb > 0) tx(u, cb, `Cashback VIP ${v.name} · rodada #${R.no}`);
    u.games.unshift({ no: R.no, at: R.endsAt, special: R.special, cards: n, spent: n * CARD_PRICE, won: wonAmt, prizes: prizes.map((p) => p.stage), cashback: cb, balls: R.balls.length });
    u.games = u.games.slice(0, 100);
    emitTo(k, 'me', pub(u));
  }
  db.history.unshift({ no: R.no, at: R.endsAt, special: R.special, balls: R.balls.length, cards: R.cards.length, pool: pool(), prizes: R.prizes });
  db.history = db.history.slice(0, 50); save();
  broadcastState();
  setTimeout(newRound, 3000);
}

function stateFor(k) {
  return {
    no: R.no, phase: R.phase, endsAt: R.endsAt, special: R.special, now: Date.now(), balls: R.balls, price: CARD_PRICE, pool: pool(),
    nCards: R.cards.length, players: new Set(R.cards.map((c) => c.ownerName)).size, prizes: R.prizes, split: SPLIT,
    mine: k ? R.cards.filter((c) => c.owner === k).map(({ id, rows }) => ({ id, rows })) : [],
    online: io.engine.clientsCount + AUTO_NAMES.length, refBonus: REF_BONUS, roundMin: ROUND_MIN,
    best: R.phase === 'draw' ? bestToGo() : null,
  };
}
function broadcastState() { for (const s of io.sockets.sockets.values()) s.emit('state', stateFor(s.data.k)); }

// ---------- socket ----------
const server = http.createServer(app);
const io = new Server(server);
const sockOf = new Map();
function emitTo(k, ev, data) { const s = sockOf.get(k); if (s) s.forEach((x) => x.emit(ev, data)); }

io.on('connection', (s) => {
  try {
    const { u } = jwt.verify(s.handshake.auth.token || '', JWT_SECRET);
    if (db.users[u]) { s.data.k = u; if (!sockOf.has(u)) sockOf.set(u, new Set()); sockOf.get(u).add(s); }
  } catch {}
  s.emit('state', stateFor(s.data.k));
  io.emit('online', io.engine.clientsCount + AUTO_NAMES.length);

  s.on('buy', (n, cb) => {
    const k = s.data.k; const u = db.users[k];
    if (!u) return cb && cb({ error: 'Faça login.' });
    if (R.phase !== 'buy') return cb && cb({ error: 'Compras fechadas. Espere a próxima rodada.' });
    n = Math.max(1, Math.min(MAX_CARDS, parseInt(n) || 1));
    const have = R.cards.filter((c) => c.owner === k).length;
    if (have + n > MAX_CARDS) return cb && cb({ error: `Máximo de ${MAX_CARDS} cartelas por rodada.` });
    if (u.balance < n * CARD_PRICE) return cb && cb({ error: 'Fichas insuficientes.' });
    tx(u, -n * CARD_PRICE, `${n} cartela${n > 1 ? 's' : ''} · rodada #${R.no}`);
    u.cardsTotal = (u.cardsTotal || 0) + n;
    for (let i = 0; i < n; i++) R.cards.push({ ...makeCard(), owner: k, ownerName: u.name });
    if (u.by && !u.refPaid && db.users[u.by]) {
      const sp = db.users[u.by]; u.refPaid = true;
      tx(sp, REF_BONUS, `Indicação: ${u.name}`); sp.refs = (sp.refs || 0) + 1; sp.refEarned = (sp.refEarned || 0) + REF_BONUS;
      emitTo(u.by, 'me', pub(sp)); emitTo(u.by, 'note', `${u.name} entrou pelo seu link! +${REF_BONUS} fichas`);
    }
    save();
    cb && cb({ ok: true, user: pub(u) });
    broadcastState();
  });

  s.on('disconnect', () => {
    const set = sockOf.get(s.data.k); if (set) { set.delete(s); if (!set.size) sockOf.delete(s.data.k); }
    io.emit('online', io.engine.clientsCount + AUTO_NAMES.length);
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, round: R && R.no, phase: R && R.phase }));

server.listen(PORT, () => { console.log('BingoPix na porta ' + PORT); newRound(); });
