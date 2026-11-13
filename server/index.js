// BingoPix - versão de teste com fichas (sem dinheiro real)
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'bingopix-teste-' + crypto.randomBytes(8).toString('hex');
const ROUND_MIN = +process.env.ROUND_MIN || 5;       // rodada a cada N minutos pelo relógio (22:50, 22:55...)
const DRAW_MS = +process.env.DRAW_MS || 2000;        // ms entre bolas
const CARD_PRICE = +process.env.CARD_PRICE || 20;    // fichas por cartela
const AUTO = process.env.AUTO_PLAYERS != null ? +process.env.AUTO_PLAYERS : 10; // jogadores automáticos sempre online
const WELCOME = 1000;
const MAX_CARDS = 50;
const SPLIT = { quadra: 0.15, quina: 0.25, bingo: 0.60 };
const MIN_POOL = 400;
const REF_BONUS = +process.env.REF_BONUS || 40; // fichas pro padrinho quando o indicado compra a 1ª cartela // prêmio mínimo garantido (fichas)

// ---------- armazenamento simples em arquivo ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, history: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  }, 300);
}
const pub = (u) => ({ name: u.name, balance: u.balance, wins: u.wins || 0, won: u.won || 0, ref: u.ref, refs: u.refs || 0, refEarned: u.refEarned || 0 });
function refCode() { let c; do { c = crypto.randomBytes(4).toString('hex').toUpperCase(); } while (Object.values(db.users).some((u) => u.ref === c)); return c; }
for (const u of Object.values(db.users)) if (!u.ref) u.ref = refCode();
function nextSlot(t) { const ms = ROUND_MIN * 60000; return Math.ceil((t + 30000) / ms) * ms; }

// ---------- http ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const { u } = jwt.verify(t, JWT_SECRET);
    req.user = db.users[u];
    if (!req.user) throw 0;
    next();
  } catch { res.status(401).json({ error: 'Faça login de novo.' }); }
}

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const pass = String(req.body.pass || '');
  if (!/^[A-Za-z0-9_.]{3,16}$/.test(name)) return res.status(400).json({ error: 'Usuário: 3 a 16 letras, números, _ ou .' });
  if (pass.length < 6) return res.status(400).json({ error: 'Senha com pelo menos 6 caracteres.' });
  const k = name.toLowerCase();
  if (db.users[k]) return res.status(400).json({ error: 'Esse usuário já existe.' });
  const by = String(req.body.ref || '').trim().toUpperCase();
  const sponsor = by && Object.entries(db.users).find(([, u]) => u.ref === by);
  db.users[k] = { name, hash: bcrypt.hashSync(pass, 8), balance: WELCOME, created: Date.now(), wins: 0, won: 0, ref: refCode(), by: sponsor ? sponsor[0] : null, refPaid: false };
  save();
  res.json({ token: jwt.sign({ u: k }, JWT_SECRET, { expiresIn: '30d' }), user: pub(db.users[k]) });
});

app.post('/api/login', (req, res) => {
  const k = String(req.body.name || '').trim().toLowerCase();
  const u = db.users[k];
  if (!u || !bcrypt.compareSync(String(req.body.pass || ''), u.hash)) return res.status(400).json({ error: 'Usuário ou senha incorretos.' });
  res.json({ token: jwt.sign({ u: k }, JWT_SECRET, { expiresIn: '30d' }), user: pub(u) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

// recarga grátis de fichas quando acabar (é só teste)
app.post('/api/refill', auth, (req, res) => {
  if (req.user.balance >= CARD_PRICE) return res.status(400).json({ error: 'Você ainda tem fichas.' });
  req.user.balance += WELCOME; save();
  res.json({ user: pub(req.user) });
});

app.get('/api/ranking', (req, res) => {
  const list = Object.values(db.users).sort((a, b) => (b.won || 0) - (a.won || 0)).slice(0, 10).map(pub);
  res.json({ list, history: db.history.slice(0, 15) });
});

// ---------- jogo ----------
let roundNo = (db.history[0] && db.history[0].no) || 0;
let R = null; // rodada atual

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function makeCard() {
  // 3 linhas x 5 números, 1-90, linhas ordenadas
  const nums = shuffle(Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, 15);
  const rows = [nums.slice(0, 5), nums.slice(5, 10), nums.slice(10, 15)].map((r) => r.sort((a, b) => a - b));
  return { id: crypto.randomBytes(4).toString('hex'), rows };
}
const AUTO_NAMES = ['Lucas', 'Maria', 'Rafa_gyn', 'Bia.santos', 'Thiago', 'Duda', 'Carlos77', 'Lu_bingo', 'Pedrinho', 'Jessica'].slice(0, AUTO);

function newRound() {
  roundNo++;
  const at = nextSlot(Date.now());
  R = { no: roundNo, phase: 'buy', endsAt: at, cards: [], balls: [], drawn: new Set(), prizes: { quadra: null, quina: null, bingo: null } };
  broadcastState();
  // jogadores automáticos compram aos poucos durante a janela de compra
  for (const name of AUTO_NAMES) {
    const n = 1 + crypto.randomInt(8);
    const t = crypto.randomInt(Math.max(1000, at - Date.now() - 3000));
    setTimeout(() => { if (R.phase !== 'buy') return; for (let i = 0; i < n; i++) R.cards.push({ ...makeCard(), owner: null, ownerName: name }); broadcastState(); }, t);
  }
  setTimeout(startDraw, at - Date.now());
}

function pool() { return Math.max(MIN_POOL, R.cards.length * CARD_PRICE); }

function lineHits(card) { return card.rows.map((r) => r.filter((n) => R.drawn.has(n)).length); }

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
  const out = [];
  const total = pool();
  for (const stage of ['quadra', 'quina', 'bingo']) {
    if (R.prizes[stage]) continue;
    const winners = R.cards.filter((c) => {
      const h = lineHits(c);
      if (stage === 'quadra') return h.some((x) => x >= 4);
      if (stage === 'quina') return h.some((x) => x === 5);
      return h.every((x) => x === 5);
    });
    if (!winners.length) break; // prêmios saem em ordem
    const each = Math.floor((total * SPLIT[stage]) / winners.length);
    R.prizes[stage] = { amount: each, names: winners.map((c) => c.ownerName), ball: R.balls.length };
    for (const c of winners) {
      if (c.owner && db.users[c.owner]) {
        const u = db.users[c.owner]; u.balance += each; u.won = (u.won || 0) + each; u.wins = (u.wins || 0) + 1;
        const s = sockOf.get(c.owner); if (s) s.forEach((x) => x.emit('me', pub(u)));
      }
    }
    out.push({ stage, amount: each, names: R.prizes[stage].names, cards: winners.map((c) => c.id) });
    save();
    if (stage !== 'bingo') break; // um prêmio por bola (exceto empate de etapa)
  }
  return out;
}

function bestToGo() {
  // top 5 cartelas mais perto da cartela cheia, com os números que faltam
  const list = R.cards.map((c) => ({ name: c.ownerName, id: c.id, need: c.rows.flat().filter((n) => !R.drawn.has(n)).sort((a, b) => a - b) }))
    .filter((x) => x.need.length).sort((a, b) => a.need.length - b.need.length).slice(0, 5);
  return { top: list, left: list[0] ? list[0].need.length : 0, who: list[0] ? list[0].name : '' };
}

function finish() {
  R.phase = 'end';
  db.history.unshift({ no: R.no, at: Date.now(), balls: R.balls.length, cards: R.cards.length, pool: pool(), prizes: R.prizes });
  db.history = db.history.slice(0, 50); save();
  broadcastState();
  setTimeout(newRound, 3000);
}

function stateFor(k) {
  return {
    no: R.no, phase: R.phase, endsAt: R.endsAt, now: Date.now(), balls: R.balls, price: CARD_PRICE, pool: pool(),
    nCards: R.cards.length, players: new Set(R.cards.map((c) => c.ownerName)).size, prizes: R.prizes, split: SPLIT,
    mine: k ? R.cards.filter((c) => c.owner === k).map(({ id, rows }) => ({ id, rows })) : [],
    online: io.engine.clientsCount + AUTO_NAMES.length, refBonus: REF_BONUS, roundMin: ROUND_MIN, best: R.phase === 'draw' ? bestToGo() : null,
  };
}
function broadcastState() { for (const s of io.sockets.sockets.values()) s.emit('state', stateFor(s.data.k)); }

// ---------- socket ----------
const server = http.createServer(app);
const io = new Server(server);
const sockOf = new Map();
const chat = [];

io.on('connection', (s) => {
  try {
    const { u } = jwt.verify(s.handshake.auth.token || '', JWT_SECRET);
    if (db.users[u]) { s.data.k = u; if (!sockOf.has(u)) sockOf.set(u, new Set()); sockOf.get(u).add(s); }
  } catch {}
  s.emit('state', stateFor(s.data.k));
  s.emit('chat', chat);
  io.emit('online', io.engine.clientsCount + AUTO_NAMES.length);

  s.on('buy', (n, cb) => {
    const k = s.data.k; const u = db.users[k];
    if (!u) return cb && cb({ error: 'Faça login.' });
    if (R.phase !== 'buy') return cb && cb({ error: 'Compras fechadas. Espere a próxima rodada.' });
    n = Math.max(1, Math.min(MAX_CARDS, parseInt(n) || 1));
    const have = R.cards.filter((c) => c.owner === k).length;
    if (have + n > MAX_CARDS) return cb && cb({ error: `Máximo de ${MAX_CARDS} cartelas por rodada.` });
    if (u.balance < n * CARD_PRICE) return cb && cb({ error: 'Fichas insuficientes.' });
    u.balance -= n * CARD_PRICE;
    for (let i = 0; i < n; i++) R.cards.push({ ...makeCard(), owner: k, ownerName: u.name });
    if (u.by && !u.refPaid && db.users[u.by]) {
      const sp = db.users[u.by]; u.refPaid = true;
      sp.balance += REF_BONUS; sp.refs = (sp.refs || 0) + 1; sp.refEarned = (sp.refEarned || 0) + REF_BONUS;
      const ss = sockOf.get(u.by); if (ss) ss.forEach((x) => { x.emit('me', pub(sp)); x.emit('note', `${u.name} entrou pelo seu link! +${REF_BONUS} fichas`); });
    }
    save();
    cb && cb({ ok: true, user: pub(u) });
    broadcastState();
  });

  s.on('say', (t) => {
    const u = db.users[s.data.k]; if (!u) return;
    t = String(t || '').trim().slice(0, 140); if (!t) return;
    const m = { n: u.name, t, at: Date.now() };
    chat.push(m); if (chat.length > 60) chat.shift();
    io.emit('say', m);
  });

  s.on('disconnect', () => {
    const set = sockOf.get(s.data.k); if (set) { set.delete(s); if (!set.size) sockOf.delete(s.data.k); }
    io.emit('online', io.engine.clientsCount + AUTO_NAMES.length);
  });
});

// conversa dos jogadores automáticos
const AUTO_TALK = ['boa noite galera', 'bora bingo', 'falta 1 aqui 😅', 'essa rodada é minha', 'vem 7!', 'quase', 'boa sorte pessoal', 'kkkk', 'vem quina', 'tô com 20 cartelas hoje', 'eita', 'parabéns quem ganhou', 'próxima eu levo', 'alguém de goiânia?', 'vem 90'];
function autoChat() {
  if (AUTO_NAMES.length && io.engine.clientsCount) {
    const m = { n: AUTO_NAMES[crypto.randomInt(AUTO_NAMES.length)], t: AUTO_TALK[crypto.randomInt(AUTO_TALK.length)], at: Date.now() };
    chat.push(m); if (chat.length > 60) chat.shift(); io.emit('say', m);
  }
  setTimeout(autoChat, 35000 + crypto.randomInt(60000));
}
setTimeout(autoChat, 20000);

app.get('/api/health', (req, res) => res.json({ ok: true, round: R && R.no, phase: R && R.phase }));

server.listen(PORT, () => { console.log('BingoPix na porta ' + PORT); newRound(); });
