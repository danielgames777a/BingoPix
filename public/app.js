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
$('#refill').onclick = async () => { try { const j = await api('refill', {}); setMe(j.user); toast('+1.000 fichas'); } catch (e) { toast(e.message); } };

function setMe(u) {
  me = u; $('#bal').textContent = fmt(u.balance);
  $('#refLink').value = location.origin + '/?ref=' + u.ref; $('#refN').textContent = u.refs; $('#refE').textContent = fmt(u.refEarned);
  $('#drName').textContent = u.name.toUpperCase(); $('#drVip').textContent = '👑 VIP ' + u.vip.name;
  $('#wBal').textContent = fmt(u.balance); $('#wWon').textContent = fmt(u.won); $('#wWins').textContent = u.wins; $('#wRef').textContent = fmt(u.refEarned);
  $('#pName').textContent = u.name; $('#pSince').textContent = new Date(u.created).toLocaleDateString('pt-BR'); $('#pVip').textContent = u.vip.name;
}

function enter() {
  $('#auth').classList.add('hide'); $('#game').classList.remove('hide'); setMe(me);
  buildBoard(); connect(); go(location.hash.slice(1) || 'vivo');
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
}

function render(newRound) {
  $('#online').textContent = S.online;
  $('#rNo').textContent = String(S.no).padStart(6, '0');
  const d = new Date(S.endsAt); $('#vDate').textContent = d.toLocaleDateString('pt-BR'); $('#vTime').textContent = d.toLocaleTimeString('pt-BR');
  $('#pool').textContent = fmt(S.pool);
  $('#nCards').textContent = S.nCards;
  $('#price').textContent = S.price; $('#refB').textContent = S.refBonus; $('#specialTag').classList.toggle('hide', !S.special);
  for (const k of ['quadra', 'quina', 'bingo']) {
    const el = $('#pz-' + k), p = S.prizes[k];
    el.querySelector('b').textContent = fmt(p ? p.amount : Math.floor(S.pool * S.split[k]));
    el.querySelector('em').textContent = p ? p.names.join(', ') : '';
    el.classList.toggle('done', !!p);
  }
  markCur();
  $('#buyBox').classList.toggle('hide', S.phase !== 'buy');
  paintBoard();
  if (newRound && S.phase === 'buy') { $('#bigBall span').textContent = '?'; }
  drawLast();
  renderCards();
  clearInterval(timer);
  if (S.phase === 'buy') { tickCount(); timer = setInterval(tickCount, 250); $('#status').textContent = `Próximo sorteio ${hhmm(S.endsAt)}`; $('#best').textContent = `${S.players} jogadores · compras abertas`; $('#nearBox').classList.add('hide'); }
  else if (S.phase === 'draw') { if (!S.balls.length) voz('start'); $('#status').textContent = 'Sorteio ao vivo'; $('#best').textContent = ''; $('#count').textContent = 'ORDEM ' + S.balls.length; showBest(S.best); }
  else { $('#nearBox').classList.add('hide'); $('#status').textContent = 'Rodada encerrada'; $('#count').textContent = 'ORDEM ' + S.balls.length; $('#best').textContent = 'Próxima rodada abrindo…'; }
}
function tickCount() {
  const left = Math.max(0, Math.ceil((S.endsAt - (Date.now() + skew)) / 1000));
  $('#count').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  if (!left) $('#status').textContent = 'Começando…';
}
function drawLast() { const p = S.balls.slice(0, -1).slice(-3).reverse(); $('#prev').innerHTML = [0, 1, 2].map((i) => `<i class="${p[i] ? 'f' : ''}">${p[i] || ''}</i>`).join(''); if (S.balls.length) $('#bigBall span').textContent = S.balls[S.balls.length - 1]; }
function paintBoard() { $$('#board i').forEach((i) => (i.className = '')); S.balls.forEach((b, i) => ($('#b' + b).className = i === S.balls.length - 1 ? 'cur' : 'on')); }
function markCur() { const st = !S.prizes.quadra ? 'quadra' : !S.prizes.quina ? 'quina' : 'bingo'; ['quadra', 'quina', 'bingo'].forEach((k) => $('#pz-' + k).classList.toggle('cur', k === st && S.phase !== 'end')); }
function showBest(b) {
  const top = (b && b.top) || [];
  $('#nearBox').classList.toggle('hide', !top.length);
  if (!top.length) return;
  $('#faltamH').textContent = 'FALTAM · ' + { quadra: 'QUADRA', quina: 'QUINA', bingo: 'BINGO' }[b.stage];
  const mine = new Set(S ? S.mine.map((c) => c.id) : []);
  $('#nearList').innerHTML = top.map((x) => {
    let nums = x.need.slice(0, 5), extra = x.need.length - 5;
    if (extra > 0) nums = x.need.slice(0, 4);
    const cells = nums.map((n) => `<i>${n}</i>`).join('') + (extra > 0 ? `<i class="more">+${extra + 1}</i>` : '') + '<i class="g"></i>'.repeat(Math.max(0, 5 - nums.length - (extra > 0 ? 1 : 0)));
    return `<div class="tr ${mine.has(x.cupom) ? 'me' : ''}"><span class="cp">${x.cupom}</span><span class="nm">${esc(x.name)}</span><span class="nd">${cells}</span></div>`;
  }).join('');
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- narração ----------
// narração com voz masculina gravada (arquivos em /voz)
let voiceOn = localStorage.getItem('bp_voice') !== '0', voiceReady = false;
const player = new Audio(); player.preload = 'auto';
const vq = [];
function playNext() { if (!vq.length) return; player.src = '/voz/' + vq.shift() + '.mp3'; player.play().catch(() => { voiceReady = false; $('#voiceTip').classList.remove('hide'); }); }
player.onended = playNext;
function voz(keys, urgent) {
  if (!voiceOn) return;
  if (!voiceReady) { $('#voiceTip').classList.remove('hide'); return; }
  if (urgent) { vq.length = 0; }
  vq.push(...[].concat(keys));
  if (urgent || player.paused || player.ended) playNext();
}
function unlockVoice() { voiceReady = true; $('#voiceTip').classList.add('hide'); vq.length = 0; vq.push('on'); playNext(); }
// pré-carrega as vozes
setTimeout(() => { for (let n = 1; n <= 90; n++) fetch('/voz/' + n + '.mp3').catch(() => {}); }, 3000);
function setVoiceBtn() { $('#voiceBtn').textContent = voiceOn ? '🔊' : '🔇'; $('#voiceBtn').classList.toggle('off', !voiceOn); }
$('#voiceBtn').onclick = (e) => { e.stopPropagation(); voiceOn = !voiceOn; localStorage.setItem('bp_voice', voiceOn ? '1' : '0'); setVoiceBtn(); if (voiceOn) unlockVoice(); else { player.pause(); vq.length = 0; $('#voiceTip').classList.add('hide'); } };
setVoiceBtn();
$('#voiceTip').onclick = (e) => { e.stopPropagation(); voiceOn = true; localStorage.setItem('bp_voice', '1'); setVoiceBtn(); unlockVoice(); };
document.addEventListener('click', () => { if (voiceOn && !voiceReady) unlockVoice(); }, { once: true });

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
      <div class="ch"><span>Cupom ${c.id}</span><b>${left === 0 ? 'BINGO!' : 'faltam ' + left}</b></div>
      ${c.rows.map((r, i) => `<div class="row ${hits[i] === 5 ? 'full' : ''}">${r.map((n) => `<div class="n ${drawn.has(n) ? 'hit' : ''}">${n}</div>`).join('')}</div>`).join('')}
    </div>`).join('');
}

function onBall({ b, n, won, best }) {
  if (!S) return;
  S.balls.push(b);
  const bb = $('#bigBall'); bb.querySelector('span').textContent = b; bb.classList.remove('pop'); void bb.offsetWidth; bb.classList.add('pop');
  paintBoard(); $('#count').textContent = 'ORDEM ' + n;
  drawLast(); showBest(best); renderCards();
  voz(String(b), true);
  for (const w of won) {
    S.prizes[w.stage] = { amount: w.amount, names: w.names };
    const el = $('#pz-' + w.stage); el.classList.add('done'); markCur(); el.querySelector('b').textContent = fmt(w.amount); el.querySelector('em').textContent = w.names.join(', ');
    const mine = S.mine.some((c) => w.cards.includes(c.id));
    voz(w.stage);
    if (mine) { $('.wp-t').textContent = STAGES[w.stage]; $('.wp-a').textContent = `Você ganhou ${fmt(w.amount)} fichas!`; $('#winPop').classList.remove('hide'); setTimeout(() => $('#winPop').classList.add('hide'), 3200); }
    else toast(`${STAGES[w.stage]}: ${w.names.join(', ')}`);
  }
}
$('#winPop').onclick = () => $('#winPop').classList.add('hide');

// compra
$$('.qty').forEach((b) => b.onclick = () => { const i = $('#qty'); i.value = Math.max(1, Math.min(50, (+i.value || 1) + +b.dataset.d)); updBuy(); });
$$('.quick button').forEach((b) => b.onclick = () => { $('#qty').value = b.dataset.q; updBuy(); });
$('#qty').oninput = updBuy;
function updBuy() { const n = +$('#qty').value || 1; $('#buyBtn').textContent = `Comprar ${n} cartela${n > 1 ? 's' : ''} · ${fmt(n * (S ? S.price : 20))} fichas`; }
updBuy();
$('#buyBtn').onclick = () => {
  const n = +$('#qty').value || 1; $('#buyBtn').disabled = true;
  sock.emit('buy', n, (r) => { $('#buyBtn').disabled = false; if (r.error) return toast(r.error); setMe(r.user); toast(`${n} cartela${n > 1 ? 's' : ''} comprada${n > 1 ? 's' : ''}! Boa sorte 🍀`); });
};

// início
if (token) api('me').then((j) => { me = j.user; enter(); }).catch(() => localStorage.removeItem('bp_token'));

$('#copyRef').onclick = () => { const i = $('#refLink'); i.select(); (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(() => toast('Link copiado!')).catch(() => { document.execCommand('copy'); toast('Link copiado!'); }); };
$('#shareRef').onclick = () => { const url = $('#refLink').value, text = 'Bora jogar bingo comigo no BingoPix! Rodada a cada 5 minutos: '; window.open('https://wa.me/?text=' + encodeURIComponent(text + url), '_blank'); return; location.href = 'https://wa.me/?text=' + encodeURIComponent(text + url); };
if (savedRef && !token) { $('#refNote').textContent = '🎁 Você foi convidado! Crie sua conta pra jogar.'; $('#refNote').classList.remove('hide'); $$('.tabs button')[1].click(); }

// ---------- menu e telas ----------
const VIEWS = ['vivo', 'rodadas', 'especiais', 'carteira', 'extrato', 'vip', 'indique', 'historico', 'ajuda', 'perfil'];
function openDrawer(o) { $('#drawer').classList.toggle('on', o); $('#drawerBg').classList.toggle('hide', !o); }
$('#menuBtn').onclick = () => openDrawer(true);
$('#drClose').onclick = $('#drawerBg').onclick = () => openDrawer(false);
document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) { go(b.dataset.go); openDrawer(false); } });
window.onhashchange = () => go(location.hash.slice(1) || 'vivo', true);
function go(v, fromHash) {
  if (!VIEWS.includes(v)) v = 'vivo';
  VIEWS.forEach((x) => $('#v-' + x).classList.toggle('hide', x !== v));
  $$('.dr-items button, .dr-foot button').forEach((b) => b.classList.toggle('on', b.dataset.go === v));
  if (!fromHash && location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  window.scrollTo(0, 0);
  ({ rodadas: loadRodadas, especiais: loadRodadas, extrato: loadExtrato, historico: loadJogos, vip: loadVip }[v] || (() => {}))();
}
const dt = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const prizeNames = (p) => p ? p.names.map(esc).join(', ') : '—';
async function loadRodadas() {
  const j = await api('rodadas');
  $('#spPool').textContent = fmt(j.specialPool);
  $('#schedList').innerHTML = j.list.slice(0, 12).map((r, i) => `<div class="item ${r.special ? 'sp' : ''}"><div><b>${hhmm(r.at)}</b>${r.special ? ' <span class="badge">⭐ Especial</span>' : ''}<small>${i === 0 ? (S && S.phase === 'buy' ? 'Compras abertas agora' : 'Próxima') : 'Cartela ' + r.price + ' fichas'}</small></div><div class="r"><small>garantido</small><b>${fmt(r.min)}</b></div></div>`).join('');
  $('#histList').innerHTML = j.history.map((h) => `<div class="item"><div><b>#${h.no} · ${hhmm(h.at)}</b>${h.special ? ' <span class="badge">⭐</span>' : ''}<small>${h.balls} bolas · ${h.cards} cartelas · Bingo: ${prizeNames(h.prizes.bingo)}</small></div><div class="r"><small>prêmio</small><b>${fmt(h.pool)}</b></div></div>`).join('') || '<p class="sub">Nenhuma rodada ainda.</p>';
  $('#spList').innerHTML = j.list.filter((r) => r.special).slice(0, 6).map((r) => `<div class="item sp"><div><b>${dt(r.at)}</b><small>Quadra ${fmt(r.min * j.split.quadra)} · Quina ${fmt(r.min * j.split.quina)} · Bingo ${fmt(r.min * j.split.bingo)}</small></div><div class="r"><small>garantido</small><b>${fmt(r.min)}</b></div></div>`).join('') || '<p class="sub">A próxima especial aparece aqui.</p>';
}
async function loadExtrato() {
  const { list } = await api('extrato');
  $('#txList').innerHTML = list.map((t) => `<div class="item"><div><b>${esc(t.desc)}</b><small>${dt(t.at)} · saldo ${fmt(t.bal)}</small></div><div class="r ${t.amount < 0 ? 'neg' : 'pos'}"><b>${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</b></div></div>`).join('') || '<p class="sub">Sem movimentações ainda.</p>';
}
async function loadJogos() {
  const { list } = await api('jogos');
  const nm = { quadra: 'Quadra', quina: 'Quina', bingo: 'Bingo' };
  $('#gamesList').innerHTML = list.map((g) => `<div class="item ${g.won ? 'win' : ''}"><div><b>Rodada #${g.no} · ${dt(g.at)}</b>${g.special ? ' <span class="badge">⭐</span>' : ''}<small>${g.cards} cartela${g.cards > 1 ? 's' : ''} · ${fmt(g.spent)} fichas${g.prizes.length ? ' · ' + g.prizes.map((p) => nm[p]).join(', ') : ''}${g.cashback ? ' · cashback ' + g.cashback : ''}</small></div><div class="r ${g.won ? 'pos' : ''}"><small>ganhou</small><b>${fmt(g.won)}</b></div></div>`).join('') || '<p class="sub">Você ainda não jogou nenhuma rodada.</p>';
}
async function loadVip() {
  const [{ user }, j] = await Promise.all([api('me'), api('rodadas')]); setMe(user);
  const v = user.vip, pct = v.next ? Math.min(100, ((v.cards - v.min) / (v.next.min - v.min)) * 100) : 100;
  $('#vipNow').innerHTML = `<small>Seu nível</small><b>👑 ${v.name}</b><div class="bar"><i style="width:${pct}%"></i></div><small>${v.next ? `${v.cards} de ${v.next.min} cartelas para ${v.next.name}` : 'Nível máximo!'}</small>`;
  $('#vipLevels').innerHTML = j.vip.map((l, i) => `<div class="item ${i === v.i ? 'cur' : ''}"><div><b>${l.name}</b><small>a partir de ${l.min} cartelas</small></div><div class="r"><small>cashback</small><b>${Math.round(l.cashback * 100)}%</b></div></div>`).join('');
}
$('#pwForm').onsubmit = async (e) => {
  e.preventDefault(); $('#pErr').textContent = '';
  try { await api('perfil', { old: $('#pOld').value, pass: $('#pNew').value }); toast('Senha alterada!'); e.target.reset(); } catch (err) { $('#pErr').textContent = err.message; }
};
