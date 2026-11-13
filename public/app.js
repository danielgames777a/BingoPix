const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
let token = localStorage.getItem('bp_token');
const urlRef = new URLSearchParams(location.search).get('ref');
if (urlRef) localStorage.setItem('bp_ref', urlRef.toUpperCase());
const savedRef = localStorage.getItem('bp_ref');
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
let me = null, S = null, sock = null, mode = 'login', timer = null, skew = 0;
const STAGES = { quadra: 'Quadra', quina: 'Quina', bingo: 'BINGO!' };

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 2800); }
async function api(p, body) {
  const r = await fetch('/api/' + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Erro');
  return j;
}

// ---------- login ----------
$$('.tabs button').forEach((b) => b.onclick = () => {
  mode = b.dataset.t; $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#pass2Wrap').classList.toggle('hide', mode !== 'register');
  $('#aBtn').textContent = mode === 'register' ? 'Criar conta e ganhar 1.000 fichas' : 'Entrar';
  $('#aPass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#aErr').textContent = '';
});
$('#eye').onclick = () => { const i = $('#aPass'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#authForm').onsubmit = async (e) => {
  e.preventDefault(); $('#aErr').textContent = '';
  const name = $('#aName').value.trim(), pass = $('#aPass').value;
  if (mode === 'register' && pass !== $('#aPass2').value) return ($('#aErr').textContent = 'As senhas não batem.');
  $('#aBtn').disabled = true;
  try { const j = await api(mode, { name, pass, ref: savedRef }); token = j.token; localStorage.setItem('bp_token', token); me = j.user; enter(); if (mode === 'register') toast('Bem-vindo! Você ganhou 1.000 fichas 🎉'); }
  catch (err) { $('#aErr').textContent = err.message; }
  $('#aBtn').disabled = false;
};
$('#logout').onclick = () => { localStorage.removeItem('bp_token'); location.reload(); };
$('#menuBtn').onclick = () => $('#menu').classList.toggle('hide');
$('#refill').onclick = async () => { try { const j = await api('refill', {}); setMe(j.user); toast('+1.000 fichas'); } catch (e) { toast(e.message); } $('#menu').classList.add('hide'); };

function setMe(u) {
  me = u; $('#bal').textContent = fmt(u.balance);
  $('#refLink').value = location.origin + '/?ref=' + u.ref; $('#refN').textContent = u.refs; $('#refE').textContent = fmt(u.refEarned); $('#who').textContent = `👤 ${u.name} · ${u.wins} prêmios · ${fmt(u.won)} fichas ganhas`; }

function enter() {
  $('#auth').classList.add('hide'); $('#game').classList.remove('hide'); setMe(me);
  buildBoard(); connect(); loadRank(); setInterval(loadRank, 30000);
}

// ---------- jogo ----------
function buildBoard() { $('#board').innerHTML = Array.from({ length: 90 }, (_, i) => `<i id="b${i + 1}">${i + 1}</i>`).join(''); }

function connect() {
  sock = io({ auth: { token } });
  sock.on('state', (s) => { const first = !S || S.no !== s.no; S = s; skew = s.now - Date.now(); render(first); });
  sock.on('ball', onBall);
  sock.on('me', setMe);
  sock.on('note', toast);
  sock.on('online', (n) => ($('#online').textContent = n));
  sock.on('chat', (list) => { $('#chatList').innerHTML = ''; list.forEach(addChat); });
  sock.on('say', addChat);
}

function render(newRound) {
  $('#online').textContent = S.online;
  $('#rNo').textContent = '#' + S.no;
  $('#pool').textContent = fmt(S.pool);
  $('#nCards').textContent = S.nCards;
  $('#price').textContent = S.price; $('#refB').textContent = S.refBonus;
  for (const k of ['quadra', 'quina', 'bingo']) {
    const el = $('#pz-' + k), p = S.prizes[k];
    el.querySelector('b').textContent = fmt(p ? p.amount : Math.floor(S.pool * S.split[k]));
    el.querySelector('em').textContent = p ? p.names.join(', ') : '';
    el.classList.toggle('done', !!p);
  }
  $('#buyBox').classList.toggle('hide', S.phase !== 'buy');
  $$('#board i').forEach((i) => i.classList.remove('on'));
  S.balls.forEach((b) => $('#b' + b).classList.add('on'));
  if (newRound && S.phase === 'buy') { $('#bigBall span').textContent = '?'; }
  drawLast();
  renderCards();
  clearInterval(timer);
  if (S.phase === 'buy') { tickCount(); timer = setInterval(tickCount, 250); $('#status').textContent = `Rodada das ${hhmm(S.endsAt)}`; $('#best').textContent = `${S.players} jogadores · compre suas cartelas!`; $('#nearBox').classList.add('hide'); }
  else if (S.phase === 'draw') { if (!S.balls.length) say('Atenção, vai começar o sorteio! Boa sorte a todos.'); $('#status').textContent = 'Sorteando…'; $('#count').textContent = S.balls.length + '/90'; showBest(S.best); }
  else { $('#nearBox').classList.add('hide'); $('#status').textContent = 'Rodada encerrada'; $('#count').textContent = 'Já já'; $('#best').textContent = 'Próxima rodada abrindo…'; }
}
function tickCount() {
  const left = Math.max(0, Math.ceil((S.endsAt - (Date.now() + skew)) / 1000));
  $('#count').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  if (!left) $('#status').textContent = 'Começando…';
}
function drawLast() { $('#last').innerHTML = S.balls.slice(-6).reverse().map((b) => `<i>${b}</i>`).join(''); }
function showBest(b) {
  $('#best').textContent = '';
  const top = (b && b.top) || [];
  $('#nearBox').classList.toggle('hide', !top.length);
  const mine = new Set(S ? S.mine.map((c) => c.id) : []);
  $('#nearList').innerHTML = top.map((x, i) => `<li class="${mine.has(x.id) ? 'me' : ''}"><span class="pos">${i + 1}</span><span class="nm">${esc(x.name)}</span><span class="nd">${x.need.map((n) => `<i>${n}</i>`).join('')}</span></li>`).join('');
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- narração ----------
let voiceOn = localStorage.getItem('bp_voice') !== '0', ptVoice = null;
function pickVoice() { const v = speechSynthesis.getVoices(); ptVoice = v.find((x) => /pt[-_]BR/i.test(x.lang)) || v.find((x) => /^pt/i.test(x.lang)) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(t, urgent) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  if (urgent) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t); u.lang = 'pt-BR'; if (ptVoice) u.voice = ptVoice; u.rate = 1.05;
  speechSynthesis.speak(u);
}
function ballText(b) { const d = String(b).split(''); return d.length === 2 ? `${d[0]}, ${d[1]}. ${b}` : `Número ${b}`; }
function setVoiceBtn() { $('#voiceBtn').textContent = voiceOn ? '🔊' : '🔇'; $('#voiceBtn').classList.toggle('off', !voiceOn); }
$('#voiceBtn').onclick = () => { voiceOn = !voiceOn; localStorage.setItem('bp_voice', voiceOn ? '1' : '0'); setVoiceBtn(); if (voiceOn) say('Narração ligada'); else speechSynthesis.cancel(); };
setVoiceBtn();
// Android/Chrome só libera a voz depois de um toque na tela
document.addEventListener('click', function prime() { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(''); speechSynthesis.speak(u); } document.removeEventListener('click', prime); });

function renderCards() {
  const drawn = new Set(S.balls);
  $('#myCount').textContent = S.mine.length ? `(${S.mine.length} · rodada #${S.no})` : '';
  if (!S.mine.length) { $('#cards').innerHTML = `<p class="empty">${S.phase === 'buy' ? 'Compre cartelas pra jogar esta rodada.' : 'Você não está nesta rodada. Compre pra próxima!'}</p>`; return; }
  const cards = S.mine.map((c) => {
    const hits = c.rows.map((r) => r.filter((n) => drawn.has(n)).length);
    const left = 15 - hits.reduce((a, b) => a + b, 0);
    return { c, hits, left };
  }).sort((a, b) => a.left - b.left);
  $('#cards').innerHTML = cards.map(({ c, hits, left }) => `
    <div class="card ${left === 0 ? 'win' : left <= 2 ? 'near' : ''}" id="c-${c.id}">
      <div class="ch"><span>Cartela ${c.id.toUpperCase()}</span><b>${left === 0 ? 'BINGO!' : 'faltam ' + left}</b></div>
      ${c.rows.map((r, i) => `<div class="row ${hits[i] === 5 ? 'full' : ''}">${r.map((n) => `<div class="n ${drawn.has(n) ? 'hit' : ''}">${n}</div>`).join('')}</div>`).join('')}
    </div>`).join('');
}

function onBall({ b, n, won, best }) {
  if (!S) return;
  S.balls.push(b);
  const bb = $('#bigBall'); bb.querySelector('span').textContent = b; bb.classList.remove('pop'); void bb.offsetWidth; bb.classList.add('pop');
  $('#b' + b).classList.add('on'); $('#count').textContent = n + '/90';
  drawLast(); showBest(best); renderCards();
  if (!won.length) say(ballText(b), true);
  for (const w of won) {
    S.prizes[w.stage] = { amount: w.amount, names: w.names };
    const el = $('#pz-' + w.stage); el.classList.add('done'); el.querySelector('b').textContent = fmt(w.amount); el.querySelector('em').textContent = w.names.join(', ');
    const mine = S.mine.some((c) => w.cards.includes(c.id));
    say(`${ballText(b)}. ${w.stage === 'bingo' ? 'Bingo!' : STAGES[w.stage] + '!'} ${w.names.join(', ')} ganhou ${w.amount} fichas`, true);
    addChat({ sys: true, t: `${STAGES[w.stage]} na bola ${n}: ${w.names.join(', ')} (+${fmt(w.amount)} fichas)` });
    if (mine) { $('.wp-t').textContent = STAGES[w.stage]; $('.wp-a').textContent = `Você ganhou ${fmt(w.amount)} fichas!`; $('#winPop').classList.remove('hide'); setTimeout(() => $('#winPop').classList.add('hide'), 3200); }
    else toast(`${STAGES[w.stage]}: ${w.names.join(', ')}`);
  }
}
$('#winPop').onclick = () => $('#winPop').classList.add('hide');

// compra
$$('.qty').forEach((b) => b.onclick = () => { const i = $('#qty'); i.value = Math.max(1, Math.min(50, (+i.value || 1) + +b.dataset.d)); updBuy(); });
$$('.quick button').forEach((b) => b.onclick = () => { $('#qty').value = b.dataset.q; updBuy(); });
$('#qty').oninput = updBuy;
function updBuy() { const n = +$('#qty').value || 1; $('#buyBtn').textContent = `Comprar ${n} cartela${n > 1 ? 's' : ''} · ${fmt(n * (S ? S.price : 10))} fichas`; }
updBuy();
$('#buyBtn').onclick = () => {
  const n = +$('#qty').value || 1; $('#buyBtn').disabled = true;
  sock.emit('buy', n, (r) => { $('#buyBtn').disabled = false; if (r.error) return toast(r.error); setMe(r.user); toast(`${n} cartela${n > 1 ? 's' : ''} comprada${n > 1 ? 's' : ''}! Boa sorte 🍀`); });
};

// chat
function addChat(m) {
  const d = document.createElement('div');
  if (m.sys) { d.className = 'sys'; d.textContent = '🏆 ' + m.t; }
  else { const b = document.createElement('b'); b.textContent = m.n + ': '; d.append(b, document.createTextNode(m.t)); }
  const box = $('#chatList'); box.append(d); box.scrollTop = box.scrollHeight;
}
$('#chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('#chatIn').value.trim(); if (v) sock.emit('say', v); $('#chatIn').value = ''; };

async function loadRank() {
  try {
    const { list, history } = await api('ranking');
    $('#rank').innerHTML = list.map((u) => `<li>${u.name.replace(/</g, '')}<b>${fmt(u.won)}</b></li>`).join('') || '<li>Ninguém ganhou ainda</li>';
    $('#hist').innerHTML = history.map((h) => `<div><b>#${h.no}</b> · ${h.balls} bolas · ${h.cards} cartelas · Bingo: ${h.prizes.bingo ? h.prizes.bingo.names.join(', ').replace(/</g, '') : '—'}</div>`).join('') || '<div>Nenhuma rodada ainda</div>';
  } catch {}
}

// início
if (token) api('me').then((j) => { me = j.user; enter(); }).catch(() => localStorage.removeItem('bp_token'));

$('#copyRef').onclick = () => { const i = $('#refLink'); i.select(); (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(() => toast('Link copiado!')).catch(() => { document.execCommand('copy'); toast('Link copiado!'); }); };
$('#shareRef').onclick = () => { const url = $('#refLink').value, text = 'Bora jogar bingo comigo no BingoPix! Rodada a cada 5 minutos: '; if (navigator.share) navigator.share({ title: 'BingoPix', text, url }).catch(() => {}); else location.href = 'https://wa.me/?text=' + encodeURIComponent(text + url); };
if (savedRef && !token) { $('#refNote').textContent = '🎁 Você foi convidado! Crie sua conta pra jogar.'; $('#refNote').classList.remove('hide'); $$('.tabs button')[1].click(); }
