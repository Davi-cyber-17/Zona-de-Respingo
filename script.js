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
const PREFIX = 'zonaderespingo-room-';
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
    // aplica a direção escolhida pelo jogador (nunca dá meia-volta de 180°)
    if (r.q.length) { const nd = r.q.shift(); if (nd !== (r.d + 2) % 4) r.d = nd; }
    // se bater na parede, vira sozinho
    for (let t = 0; t < 4; t++) {
      const [dx, dy] = DIRS[r.d], nx = r.x + dx, ny = r.y + dy;
      if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) { r.x = nx; r.y = ny; break; }
      r.d = (r.d + 1) % 4;
    }
    paint(r, i);
  });
}
function hostDir(slot, d) {
  if (phase !== 'play' && phase !== 'count') return;
  d = d | 0;
  if (d < 0 || d > 3) return;
  const r = rollers[slot];
  if (!r) return;
  const last = r.q.length ? r.q[r.q.length - 1] : r.d;
  if (d === last || d === (last + 2) % 4) return;
  if (r.q.length >= 2) r.q.shift();
  r.q.push(d);
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
    document.querySelector('.c' + i + ' span').textContent = Math.round(p) + '%';
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
function layout() {
  const game = $('game'), stage = $('stage'), hud = $('hud'), keys = $('keys'), wrap = $('boardWrap');
  const cs = getComputedStyle(game);
  const W = game.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = game.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (W <= 0 || H <= 0) return;
  const G = 8;
  const local = mode === 'local';
  const act = [0, 1, 2, 3].filter(i => local ? active[i] : i === mySlot);
  const cnt = fn => act.filter(fn).length;
  const hudH = hud.offsetHeight || 48;
  const keysH = cs.display === 'none' || getComputedStyle(keys).display === 'none' ? 0 : keys.offsetHeight + 8;

  // simula o espaço usado por botões de tamanho pb e devolve o maior tabuleiro possível
  const plan = (land, pb) => {
    const g = pb * .14, pw = pb * 3 + g * 2, ph = pb * 2 + g;
    let A, B;
    if (!local) { A = 0; B = 1; }
    else if (land) { A = cnt(s => !(s & 1)); B = cnt(s => s & 1); }
    else { A = cnt(s => !(s >> 1)); B = cnt(s => s >> 1); }
    const nd = (A > 0) + (B > 0), mx = Math.max(A, B);
    if (!land) {
      const rowW = mx * pw + (mx - 1) * G;
      const availH = H - hudH - keysH - nd * (ph + G);
      return { ok: rowW <= W && availH > 120, w: Math.min(W, availH * COLS / ROWS) };
    }
    const colH = mx * ph + (mx - 1) * G;
    const availH = H - hudH - keysH;
    return { ok: colH <= availH && W - nd * (pw + G) > 100, w: Math.min(availH * COLS / ROWS, W - nd * (pw + G)) };
  };
  // escolhe o maior botão que ainda deixa o tabuleiro grande
  const choose = land => {
    const hi = local ? 72 : 84, lo = 44;
    const wMin = plan(land, lo).w;
    let best = lo;
    for (let pb = hi; pb >= lo; pb -= 2) {
      const p = plan(land, pb);
      if (p.ok && p.w >= wMin * .82) { best = pb; break; }
    }
    return { pb: best, w: plan(land, best).w };
  };
  const P = choose(false), L = choose(true);
  const land = W > H ? L.w >= P.w * .97 : L.w > P.w * 1.03;
  const pick = land ? L : P;
  const pb = pick.pb;
  const w = Math.max(120, Math.floor(pick.w)), h = Math.floor(w * ROWS / COLS);

  game.style.setProperty('--pb', pb + 'px');
  stage.classList.toggle('land', land);
  wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
  wrap.style.setProperty('--cb', Math.max(32, Math.min(56, w * .13)) + 'px');
  hud.style.width = w + 'px';
  const dA = $('dockA'), dB = $('dockB');
  [dA, dB].forEach(d => { d.style.width = ''; d.style.height = ''; });
  if (land) { dA.style.height = dB.style.height = h + 'px'; }
  else { dA.style.width = dB.style.width = W + 'px'; }
  placePads(land);

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

/* ===== Entrada (o jogador escolhe a direção) ===== */
const SCHEMES = {                       // ordem: cima, esquerda, baixo, direita
  wasd:   { keys: ['w', 'a', 's', 'd'], txt: 'W A S D' },
  arrows: { keys: ['arrowup', 'arrowleft', 'arrowdown', 'arrowright'], txt: 'setas' },
  ijkl:   { keys: ['i', 'j', 'k', 'l'], txt: 'I J K L' },
  tfgh:   { keys: ['t', 'f', 'g', 'h'], txt: 'T F G H' }
};
const LOCAL_MAP = {                     // qual teclado cada jogador usa no modo local
  2: { 0: 'wasd', 3: 'arrows' },
  3: { 0: 'wasd', 1: 'arrows', 3: 'ijkl' },
  4: { 0: 'wasd', 1: 'arrows', 2: 'tfgh', 3: 'ijkl' }
};
const DIR_OF = [3, 2, 1, 0];            // posição na tabela acima -> índice em DIRS (cima, esquerda, baixo, direita)
let pads = [null, null, null, null], keyMap = {};

function sendDir(slot, d) {
  if (navigator.vibrate) navigator.vibrate(6);
  if (mode === 'client') { if (hostConn && hostConn.open) hostConn.send({ t: 'dir', d }); }
  else hostDir(slot, d);
}
function flashPad(slot, d) {
  const p = pads[slot]; if (!p) return;
  const b = p.querySelector('[data-d="' + d + '"]'); if (!b) return;
  b.classList.add('press'); setTimeout(() => b.classList.remove('press'), 110);
}
function buildPads() {
  [$('dockA'), $('dockB')].forEach(d => d.innerHTML = '');
  pads = [null, null, null, null]; keyMap = {};
  const local = mode === 'local';
  const list = local ? [0, 1, 2, 3].filter(i => active[i]) : [mySlot];
  const NAME_DIR = ['right', 'down', 'left', 'up'];
  list.forEach(s => {
    const el = document.createElement('div');
    el.className = 'pad'; el.style.color = COLORS[s];
    el.dataset.h = local ? (s & 1 ? 'r' : 'l') : 'c';
    el.dataset.v = local ? (s >> 1 ? 'b' : 't') : 'c';
    const sch = local ? SCHEMES[LOCAL_MAP[localCount][s]] : null;
    const labels = local ? (sch === SCHEMES.arrows ? null : sch.keys.map(k => k.toUpperCase())) : ['W', 'A', 'S', 'D'];
    [3, 2, 1, 0].forEach((d, idx) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.d = d; b.className = 'dir ' + NAME_DIR[d];
      b.setAttribute('aria-label', NAMES[s] + ': ' + NAME_DIR[d]);
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5 21 18H3z"/></svg>' + (labels ? '<small>' + labels[idx] + '</small>' : '');
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('press'); sendDir(s, d); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, () => b.classList.remove('press')));
      b.addEventListener('contextmenu', e => e.preventDefault());
      el.appendChild(b);
    });
    pads[s] = el;
    if (local) sch.keys.forEach((k, idx) => { keyMap[k] = [s, DIR_OF[idx]]; });
  });
  if (!local) {
    [SCHEMES.wasd, SCHEMES.arrows].forEach(sc => sc.keys.forEach((k, idx) => { keyMap[k] = [mySlot, DIR_OF[idx]]; }));
  }
  $('keys').textContent = local
    ? list.map(s => NAMES[s] + ': ' + SCHEMES[LOCAL_MAP[localCount][s]].txt).join('  •  ')
    : 'Escolha a direção com W A S D, com as setas ou deslizando no tabuleiro.';
}
function placePads(land) {
  const local = mode === 'local';
  [0, 1, 2, 3].forEach(s => {
    const el = pads[s]; if (!el) return;
    const toB = !local ? true : (land ? (s & 1) : (s >> 1));
    $(toB ? 'dockB' : 'dockA').appendChild(el);
  });
}
window.addEventListener('keydown', e => {
  if (!$('game').classList.contains('active')) return;
  const k = e.key.toLowerCase();
  const m = keyMap[k];
  if (!m) return;
  e.preventDefault();
  if (e.repeat) return;
  if (!active[m[0]]) return;
  sendDir(m[0], m[1]); flashPad(m[0], m[1]);
});
/* deslizar o dedo no tabuleiro (modo online) */
let swipe = null;
canvas.addEventListener('pointerdown', e => { e.preventDefault(); if (mode !== 'local') swipe = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointermove', e => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
  sendDir(mySlot, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
  swipe.x = e.clientX; swipe.y = e.clientY;
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => canvas.addEventListener(ev, () => { swipe = null; }));
function setupCorners() {
  document.querySelectorAll('.corner').forEach(b => {
    const s = [0, 1, 2, 3].find(i => b.classList.contains('c' + i));
    b.className = 'corner c' + s;
    if (!active[s]) b.classList.add('off');
    else if (mode !== 'local') b.classList.add(s === mySlot ? 'me' : 'dim');
  });
  buildPads();
}

/* ===== Menus ===== */
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('btnLocal').onclick = () => show('localSetup');
$('btnOnline').onclick = () => { setStatus(''); show('onlineMenu'); };
$('btnOnlineBack').onclick = () => { cleanup(); show('menu'); };

function updateLocalKeys() {
  const set = { 2: [0, 3], 3: [0, 1, 3], 4: [0, 1, 2, 3] }[localCount];
  $('localKeys').textContent = set.map(s => NAMES[s] + ': ' + SCHEMES[LOCAL_MAP[localCount][s]].txt).join('  •  ') + '. Também dá para tocar nos botões da tela.';
}
document.querySelectorAll('#localCount .chip').forEach(c => c.onclick = () => {
  localCount = +c.dataset.n;
  document.querySelectorAll('#localCount .chip').forEach(x => x.classList.toggle('sel', x === c));
  updateLocalKeys();
});
document.querySelector('#localCount .chip').classList.add('sel');
updateLocalKeys();
$('btnLocalStart').onclick = startLocal;
$('btnExit').onclick = () => { cleanup(); show('menu'); };
$('btnAgain').onclick = () => (mode === 'local' ? startLocal() : backToLobby());

function startLocal() {
  cleanup();
  mode = 'local'; mySlot = 0;
  const set = { 2: [0, 3], 3: [0, 1, 3], 4: [0, 1, 2, 3] }[localCount];
  active = [0, 1, 2, 3].map(i => set.includes(i));
  setupCorners(); show('game'); runHost();
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
    c.on('data', m => { if (m && m.t === 'dir') hostDir(s, m.d); });
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
  setupCorners(); show('game'); runHost();
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
      active = m.a; inGame = true; resetView(); setupCorners(); show('game'); break;
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
