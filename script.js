'use strict';
/* ===== Configuração ===== */
const COLS = 15, ROWS = 26, CELLS = COLS * ROWS;
const TICK = 110;          // ms por passo do rolo
const PLAY_SEC = 60, COUNT_SEC = 3;
const COLORS = ['#18D2FF', '#5CFF6B', '#FFC93C', '#FF4D6D'];
const NAMES = ['Azul', 'Verde', 'Amarelo', 'Vermelho'];
const BG = '#0a0f1e';
// STUN + TURN: ajudam a conectar celular e computador mesmo em redes diferentes (4G, Wi-Fi, NAT restrito)
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
        username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
};
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // direita, baixo, esquerda, cima (sentido horário)
const STARTS = [
  { x: 1, y: 1, d: 0 }, { x: COLS - 2, y: 1, d: 1 },
  { x: 1, y: ROWS - 2, d: 3 }, { x: COLS - 2, y: ROWS - 2, d: 2 }
];
const PREFIX = 'paintfight-room-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const $ = id => document.getElementById(id);
const show = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  if (id === 'game') { layout(); keepAwake(); }
};
let wakeLock = null;
function keepAwake() {
  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('game').classList.contains('active')) keepAwake(); });

/* ===== Estado geral ===== */
let mode = 'local';            // 'local' | 'host' | 'client'
let mySlot = 0;
let active = [false, false, false, false];
let slots = [true, false, false, false];
let peer = null, conns = [null, null, null, null], hostConn = null;
let inGame = false, timer = null, localCount = 2;

/* ===== Simulação (roda no anfitrião / local) ===== */
const grid = new Uint8Array(CELLS);
let rollers = [null, null, null, null];
let phase = 'count', ticks = 0;

function paint(r, i) {
  const [dx, dy] = DIRS[r.d];
  for (let k = -1; k <= 1; k++) {
    const x = r.x - dy * k, y = r.y + dx * k;
    if (x >= 0 && x < COLS && y >= 0 && y < ROWS) grid[y * COLS + x] = i + 1;
  }
}
function newGame() {
  grid.fill(0);
  rollers = STARTS.map((s, i) => active[i] ? { x: s.x, y: s.y, d: s.d, q: [] } : null);
  rollers.forEach((r, i) => r && paint(r, i));
}
function step() {
  rollers.forEach((r, i) => {
    if (!r) return;
    if (r.q.length) r.d = (r.d + r.q.shift() + 4) % 4;
    for (let t = 0; t < 4; t++) {
      const [dx, dy] = DIRS[r.d], nx = r.x + dx, ny = r.y + dy;
      if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) { r.x = nx; r.y = ny; break; }
      r.d = (r.d + 1) % 4;
    }
    paint(r, i);
  });
}
function hostTurn(slot, dir) {
  if (phase !== 'play') return;
  const r = rollers[slot];
  if (r && r.q.length < 2) r.q.push(dir === -1 ? -1 : 1);
}
function runHost() {
  clearInterval(timer);
  inGame = true;
  newGame();
  resetView();
  phase = 'count';
  ticks = Math.round(COUNT_SEC * 1000 / TICK);
  pushState();
  timer = setInterval(hostTick, TICK);
}
function hostTick() {
  if (phase === 'count') {
    if (--ticks <= 0) { phase = 'play'; ticks = Math.round(PLAY_SEC * 1000 / TICK); }
  } else if (phase === 'play') {
    step();
    if (--ticks <= 0) { phase = 'end'; clearInterval(timer); }
  }
  pushState();
}
function pushState() {
  const st = {
    t: 's', ph: phase, k: ticks,
    g: Array.prototype.join.call(grid, ''),
    r: rollers.map(r => r ? [r.x, r.y, r.d] : null)
  };
  applyState(st);
  if (mode === 'host') broadcast(st);
}

/* ===== Visão (o que é desenhado, igual para todos) ===== */
const view = { ph: '', k: 0, g: new Uint8Array(CELLS), r: [null, null, null, null], stamp: 0, endShown: false };
function resetView() {
  view.ph = ''; view.r = [null, null, null, null]; view.g.fill(0); view.endShown = false;
  $('end').classList.remove('show'); $('count').classList.remove('show');
}
function applyState(st) {
  view.ph = st.ph; view.k = st.k;
  for (let i = 0; i < CELLS; i++) view.g[i] = st.g.charCodeAt(i) - 48;
  for (let i = 0; i < 4; i++) {
    const s = st.r[i];
    if (!s) { view.r[i] = null; continue; }
    const v = view.r[i];
    if (!v) view.r[i] = { px: s[0], py: s[1], x: s[0], y: s[1], d: s[2] };
    else { v.px = v.x; v.py = v.y; v.x = s[0]; v.y = s[1]; v.d = s[2]; }
  }
  view.stamp = performance.now();
  updateUI();
}
function scores() {
  const c = [0, 0, 0, 0, 0];
  for (let i = 0; i < CELLS; i++) c[view.g[i]]++;
  return c;
}
function updateUI() {
  const c = scores();
  const bars = $('bar').children;
  for (let i = 0; i < 4; i++) {
    const p = c[i + 1] / CELLS * 100;
    $('sc' + i).lastElementChild.textContent = Math.round(p) + '%';
    bars[i].style.width = p + '%';
  }
  const sec = Math.ceil(view.k * TICK / 1000);
  $('time').textContent = view.ph === 'play' ? sec : view.ph === 'end' ? 0 : PLAY_SEC;
  const cnt = $('count');
  if (view.ph === 'count') { cnt.textContent = sec; cnt.classList.add('show'); } else cnt.classList.remove('show');
  if (view.ph === 'end' && !view.endShown) { view.endShown = true; showEnd(c); }
}
function showEnd(c) {
  const list = [0, 1, 2, 3].filter(i => active[i]).sort((a, b) => c[b + 1] - c[a + 1]);
  const tie = list.length > 1 && c[list[0] + 1] === c[list[1] + 1];
  $('winner').textContent = tie ? 'Empate!' : (mode !== 'local' && list[0] === mySlot ? 'Você venceu!' : NAMES[list[0]] + ' venceu!');
  $('ranking').innerHTML = list.map(i =>
    `<li><i style="background:${COLORS[i]}"></i>${NAMES[i]}${mode !== 'local' && i === mySlot ? ' (você)' : ''}<b>${Math.round(c[i + 1] / CELLS * 100)}%</b></li>`).join('');
  const isHost = mode !== 'client';
  $('btnAgain').style.display = isHost ? '' : 'none';
  $('endWait').style.display = isHost ? 'none' : '';
  $('end').classList.add('show');
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
}

/* ===== Desenho ===== */
const canvas = $('board'), ctx = canvas.getContext('2d');
const ctl = [];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function place(p, local) {
  $('game').classList.toggle('land', p.land);
  const dock = $('dock'), sideL = $('sideL'), sideR = $('sideR');
  [dock, sideL, sideR].forEach(el => el.replaceChildren());
  const pads = {};
  const padFor = (cont, slot, single) => {
    const key = cont.id + slot;
    if (pads[key]) return pads[key];
    const d = document.createElement('div');
    d.className = 'pad p' + slot;
    d.style.width = (single ? p.bw : p.bw * 2 + 8) + 'px';
    if (local) { const l = document.createElement('div'); l.className = 'plabel'; l.textContent = NAMES[slot]; d.appendChild(l); }
    cont.appendChild(d);
    return (pads[key] = d);
  };
  ctl.forEach(c => {
    const single = p.land && !local;
    const cont = !p.land ? dock : local ? (c.slot % 2 === 0 ? sideL : sideR) : (c.dir < 0 ? sideL : sideR);
    padFor(cont, c.slot, single).appendChild(c.el);
    c.el.style.width = p.bw + 'px'; c.el.style.height = p.bh + 'px';
  });
}
function layout() {
  const hud = $('hud'), dock = $('dock'), wrap = $('boardWrap');
  const vw = window.innerWidth, vh = window.innerHeight, MAXW = 620;
  const local = mode === 'local';
  const slotList = [...new Set(ctl.map(c => c.slot))];
  const n = Math.max(1, slotList.length);
  const hudH = hud.offsetHeight || 64;
  let plan = null, w;

  if (vw >= vh * 1.1) {                       // celular/tablet deitado, desktop: botões nas laterais
    const availH = vh - hudH - 10;
    w = Math.min(MAXW, Math.floor(availH * COLS / ROWS));
    const sideW = (vw - w - 32) / 2;
    if (sideW >= 90) {
      if (local) {
        const left = slotList.filter(s => s % 2 === 0).length, right = slotList.filter(s => s % 2 === 1).length;
        const maxc = Math.max(left, right, 1);
        const bw = Math.floor((Math.min(sideW - 8, 280) - 8) / 2);
        const bh = Math.floor(clamp(Math.min(bw * .9, availH / maxc - 32), 0, 90));
        if (bw >= 40 && bh >= 38) plan = { land: true, bw, bh };
      } else {
        const bw = Math.floor(Math.min(sideW - 12, 180));
        const bh = Math.floor(clamp(Math.min(availH * .55, bw * 1.1), 0, 200));
        if (bw >= 56 && bh >= 56) plan = { land: true, bw, bh };
      }
    }
  }
  if (plan) {
    place(plan, local);
  } else {                                    // em pé: botões embaixo do tabuleiro
    const cols = local ? (n <= 3 ? n : 2) : 1;
    const padW = local ? (vw - 16 - (cols - 1) * 10) / cols : Math.min(vw - 16, 480);
    const bw = Math.floor((padW - 8) / 2);
    const bh = Math.floor(local ? clamp(bw * .62, 44, 66) : clamp(vh * .12, 60, 100));
    dock.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)';
    place({ land: false, bw, bh }, local);
    const availH = vh - hudH - dock.offsetHeight - 10;
    w = Math.floor(Math.min(vw - 8, availH * COLS / ROWS, MAXW));
  }
  w = Math.max(100, w);
  const h = Math.floor(w * ROWS / COLS);
  wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
  hud.style.width = Math.max(w, Math.min(vw - 8, 230)) + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
}
function rr(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}
function drawRoller(cx, cy, ang, col, cs) {
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(ang);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = col; ctx.shadowBlur = cs * .9;
  ctx.lineWidth = cs * .14; ctx.strokeStyle = col; ctx.fillStyle = BG;
  ctx.beginPath(); ctx.moveTo(-cs * .4, 0); ctx.lineTo(-cs * .85, 0); ctx.stroke();
  rr(-cs * 1.7, -cs * .25, cs * .85, cs * .5, cs * .2); ctx.fill(); ctx.stroke();
  rr(-cs * .4, -cs * 1.5, cs * .8, cs * 3, cs * .3); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = .4; ctx.fillStyle = col;
  rr(-cs * .3, -cs * 1.4, cs * .6, cs * 2.8, cs * .22); ctx.fill();
  ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = cs * .06;
  ctx.beginPath(); ctx.moveTo(0, -cs * 1.15); ctx.lineTo(0, cs * 1.15); ctx.stroke();
  ctx.restore();
}
function draw() {
  requestAnimationFrame(draw);
  if (!$('game').classList.contains('active') || !canvas.width) return;
  const W = canvas.width, H = canvas.height, cs = W / COLS;
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(120,170,255,.08)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = 1; x < COLS; x++) { ctx.moveTo(x * cs, 0); ctx.lineTo(x * cs, H); }
  for (let y = 1; y < ROWS; y++) { ctx.moveTo(0, y * cs); ctx.lineTo(W, y * cs); }
  ctx.stroke();
  const pad = Math.max(1, cs * .06), rad = cs * .2;
  for (let i = 0; i < CELLS; i++) {
    const v = view.g[i];
    if (!v) continue;
    const x = (i % COLS) * cs, y = Math.floor(i / COLS) * cs;
    ctx.fillStyle = COLORS[v - 1]; ctx.globalAlpha = .88;
    rr(x + pad, y + pad, cs - pad * 2, cs - pad * 2, rad); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const t = Math.min(1, (performance.now() - view.stamp) / TICK);
  view.r.forEach((r, i) => {
    if (!r) return;
    const x = r.px + (r.x - r.px) * t, y = r.py + (r.y - r.py) * t;
    const [dx, dy] = DIRS[r.d];
    drawRoller((x + .5) * cs, (y + .5) * cs, Math.atan2(dy, dx), COLORS[i], cs);
  });
}
requestAnimationFrame(draw);
const relayout = () => { if ($('game').classList.contains('active')) layout(); };
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', () => setTimeout(relayout, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', relayout);

/* ===== Entrada: botões ◀ ▶ (virar à esquerda / direita) + teclado ===== */
const KEYMAP = [['q', 'w'], ['o', 'p'], ['z', 'x'], ['n', 'm']];   // [esquerda, direita] de cada jogador no modo local
const ICON = {
  '-1': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4 7 12l8 8"/></svg>',
  '1': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l8 8-8 8"/></svg>'
};
function turn(slot, dir) {
  if (navigator.vibrate) navigator.vibrate(8);
  if (mode === 'client') { if (hostConn && hostConn.open) hostConn.send({ t: 'turn', d: dir }); }
  else hostTurn(slot, dir);
}
function mkBtn(slot, dir) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tbtn';
  b.setAttribute('aria-label', (dir < 0 ? 'Virar à esquerda' : 'Virar à direita') + ' - ' + NAMES[slot]);
  b.dataset.key = (mode === 'local' ? KEYMAP[slot][dir > 0 ? 1 : 0] : dir < 0 ? 'A' : 'D').toUpperCase();
  b.innerHTML = ICON[dir];
  b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('on'); turn(slot, dir); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, () => b.classList.remove('on')));
  return { slot, dir, el: b };
}
function press(slot, dir) {
  const c = ctl.find(x => x.slot === slot && x.dir === dir);
  if (c) { c.el.classList.add('on'); setTimeout(() => c.el.classList.remove('on'), 90); }
  turn(slot, dir);
}
window.addEventListener('keydown', e => {
  if (!$('game').classList.contains('active') || e.repeat) return;
  const k = e.key.toLowerCase();
  if (mode === 'local') {
    for (let s = 0; s < 4; s++) {
      if (!active[s]) continue;
      const i = KEYMAP[s].indexOf(k);
      if (i >= 0) { e.preventDefault(); press(s, i ? 1 : -1); return; }
    }
  } else if (k === 'a' || k === 'arrowleft') { e.preventDefault(); press(mySlot, -1); }
  else if (k === 'd' || k === 'arrowright') { e.preventDefault(); press(mySlot, 1); }
});
document.addEventListener('contextmenu', e => { if ($('game').classList.contains('active')) e.preventDefault(); });
function setupGame() {
  ctl.length = 0;
  const list = mode === 'local' ? [0, 1, 2, 3].filter(i => active[i]) : [mySlot];
  list.forEach(s => [-1, 1].forEach(d => ctl.push(mkBtn(s, d))));
  for (let i = 0; i < 4; i++) {
    const el = $('sc' + i);
    el.style.display = active[i] ? '' : 'none';
    el.classList.toggle('me', mode !== 'local' && i === mySlot);
  }
}

/* ===== Menus ===== */
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('btnLocal').onclick = () => show('localSetup');
$('btnOnline').onclick = () => { setStatus(''); show('onlineMenu'); };
$('btnOnlineBack').onclick = () => { cleanup(); show('menu'); };

document.querySelectorAll('#localCount .chip').forEach(c => c.onclick = () => {
  localCount = +c.dataset.n;
  document.querySelectorAll('#localCount .chip').forEach(x => x.classList.toggle('sel', x === c));
});
document.querySelector('#localCount .chip').classList.add('sel');
$('btnLocalStart').onclick = startLocal;
$('btnExit').onclick = () => { cleanup(); show('menu'); };
$('btnAgain').onclick = () => (mode === 'local' ? startLocal() : backToLobby());

function startLocal() {
  cleanup();
  mode = 'local'; mySlot = 0;
  const set = { 2: [0, 3], 3: [0, 1, 3], 4: [0, 1, 2, 3] }[localCount];
  active = [0, 1, 2, 3].map(i => set.includes(i));
  setupGame(); show('game'); runHost();
}

/* ===== Online ===== */
function setStatus(m) { $('onlineStatus').textContent = m; }
function cleanup() {
  clearInterval(timer); inGame = false;
  if (peer) { try { peer.destroy(); } catch (e) {} }
  peer = null; conns = [null, null, null, null]; hostConn = null;
  slots = [true, false, false, false]; mode = 'local';
}
function fail(msg) { cleanup(); show('onlineMenu'); setStatus(msg); }
function broadcast(m) { conns.forEach(c => c && c.open && c.send(m)); }
function randCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }

$('btnCreate').onclick = () => { setStatus('Criando sala...'); createRoom(); };
function createRoom(tries = 0) {
  cleanup();
  const code = randCode();
  peer = new Peer(PREFIX + code, PEER_OPTS);
  peer.on('open', () => {
    mode = 'host'; mySlot = 0; slots = [true, false, false, false];
    $('roomCode').textContent = code; $('codeHint').textContent = 'Toque no código para copiar e envie aos amigos.';
    renderLobby(); show('lobby');
  });
  peer.on('connection', onGuest);
  peer.on('error', e => {
    if (e.type === 'unavailable-id' && tries < 5) return createRoom(tries + 1);
    fail('Não foi possível criar a sala (' + e.type + ').');
  });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
}
function onGuest(c) {
  c.on('open', () => {
    let s = -1;
    for (let i = 1; i < 4; i++) if (!slots[i]) { s = i; break; }
    if (inGame || s < 0) { c.send({ t: 'full' }); setTimeout(() => c.close(), 400); return; }
    conns[s] = c; slots[s] = true;
    c.send({ t: 'hello', slot: s });
    broadcastLobby();
    c.on('data', m => { if (m && m.t === 'turn') hostTurn(s, m.d); });
    c.on('close', () => {
      conns[s] = null;
      if (!inGame) { slots[s] = false; broadcastLobby(); }
    });
  });
}
function broadcastLobby() { broadcast({ t: 'lobby', slots }); renderLobby(); }
function renderLobby() {
  $('players').innerHTML = [0, 1, 2, 3].map(i => {
    const label = slots[i]
      ? `Jogador ${i + 1} (${NAMES[i]})${i === mySlot ? ' - você' : ''}${i === 0 ? ' - anfitrião' : ''}`
      : 'Aguardando jogador...';
    return `<li class="${slots[i] ? '' : 'empty'}"><i style="background:${COLORS[i]}"></i>${label}</li>`;
  }).join('');
  const n = slots.filter(Boolean).length;
  $('btnStart').style.display = mode === 'host' ? '' : 'none';
  $('btnStart').disabled = n < 2;
  $('waitHost').style.display = mode === 'client' ? '' : 'none';
}
$('roomCode').onclick = () => {
  const code = $('roomCode').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
  $('codeHint').textContent = 'Código copiado!';
};
$('btnLink').onclick = () => {
  const link = location.origin + location.pathname + '?sala=' + $('roomCode').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
  $('codeHint').textContent = 'Link copiado! Quem abrir entra direto na sala.';
};
$('btnLeave').onclick = () => { cleanup(); show('menu'); };
$('btnStart').onclick = () => {
  if (slots.filter(Boolean).length < 2) return;
  active = slots.slice();
  broadcast({ t: 'start', a: active });
  setupGame(); show('game'); runHost();
};
function backToLobby() {
  clearInterval(timer); inGame = false;
  for (let s = 1; s < 4; s++) if (!conns[s]) slots[s] = false;
  resetView();
  broadcast({ t: 'toLobby' });
  broadcastLobby();
  show('lobby');
}

$('btnJoin').onclick = joinRoom;
function joinRoom() {
  const code = $('inpCode').value.trim().toUpperCase();
  if (code.length !== 4) return setStatus('Digite o código de 4 caracteres.');
  cleanup(); setStatus('Conectando...');
  let done = false;
  const to = setTimeout(() => { if (!done) fail('Não foi possível conectar. Confira o código e a internet.'); }, 15000);
  peer = new Peer(undefined, PEER_OPTS);
  peer.on('open', () => {
    const c = peer.connect(PREFIX + code, { reliable: true });
    hostConn = c;
    c.on('open', () => { done = true; clearTimeout(to); mode = 'client'; });
    c.on('data', onHostMsg);
    c.on('close', () => {
      if (mode !== 'client') return;
      fail('A sala foi encerrada.');
    });
  });
  peer.on('error', e => {
    clearTimeout(to);
    fail(e.type === 'peer-unavailable' ? 'Sala não encontrada.' : 'Erro de conexão (' + e.type + ').');
  });
}
function onHostMsg(m) {
  if (!m) return;
  switch (m.t) {
    case 'full': fail('Sala cheia ou jogo em andamento.'); break;
    case 'hello':
      mySlot = m.slot; $('roomCode').textContent = $('inpCode').value.trim().toUpperCase();
      $('codeHint').textContent = 'Você entrou na sala.';
      break;
    case 'lobby':
      slots = m.slots; renderLobby();
      if (!$('lobby').classList.contains('active') && !inGame) show('lobby');
      break;
    case 'start':
      active = m.a; inGame = true; resetView(); setupGame(); show('game'); break;
    case 's': applyState(m); break;
    case 'toLobby': inGame = false; resetView(); show('lobby'); break;
  }
}

/* Entrada direta pelo link da sala (?sala=ABCD) */
(() => {
  const c = new URLSearchParams(location.search).get('sala');
  if (!c) return;
  $('inpCode').value = c.toUpperCase().slice(0, 4);
  show('onlineMenu');
  setTimeout(joinRoom, 300);
})();
