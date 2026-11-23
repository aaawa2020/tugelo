const $ = selector => document.querySelector(selector);
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const colorList = [
  ['#211b35','墨黑'], ['#81808f','雾灰'], ['#ed4779','莓粉'], ['#ff6054','珊瑚红'],
  ['#f6a629','橘橙'], ['#ffdb53','柠檬黄'], ['#25b98b','薄荷绿'], ['#3d91f5','天空蓝'], ['#7a55ee','葡萄紫'],
];
const avatarColors = ['#e9dcff','#ffe4a9','#fdd8e9','#c9f4e8','#d4e7ff','#ffdbcf','#e8f4be','#eed7fc'];
const markId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
const board = $('#board');
const context = board.getContext('2d');
const dialog = $('#dialog');
const chat = $('#chat-log');
const guess = $('#guess');
const isPages = document.documentElement.dataset.transport === 'peer';

let room = null;
let token = '';
let code = '';
let epoch = 0;
let actionRevision = 0;
let serverOffset = 0;
let syncTimer;
let toastTimer;
let busy = false;
let tool = 'pen';
let color = colorList[0][0];
let active = null;
let confirmed = [];
let pending = [];
let rendered = [];
let cursor = 0;
let renderFrame = 0;
let queue = Promise.resolve();
const regionKeys = new Map();

const load = (storage, key) => { try { return storage.getItem(key) ?? ''; } catch { return ''; } };
const save = (storage, key, value) => { try { value ? storage.setItem(key, value) : storage.removeItem(key); } catch {} };

function region(selector, key, html) {
  if (regionKeys.get(selector) === key) return false;
  regionKeys.set(selector, key);
  $(selector).innerHTML = html;
  return true;
}

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2900);
}

function connection(text, offline = false) {
  $('#connection-text').textContent = text;
  $('.connection').classList.toggle('offline', offline);
}

async function request(path, body, key = token) {
  if (isPages) return (await import('./pages-peer.js?v=f4aba662da')).peerRequest(path, body, key);
  const response = await fetch('/api/rooms' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-game-token': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(9000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (!data.room && !data.ok)) {
    const error = new Error(data.error ?? '连接失败，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

function newBoard() {
  active = null;
  confirmed = [];
  pending = [];
  rendered = [];
  cursor = 0;
  context.clearRect(0, 0, board.width, board.height);
}

function acceptRoom(next) {
  if (room?.turnId !== next.turnId) newBoard();
  serverOffset = next.time - Date.now();
  room = next;
  drawUI();
}

function enter(data) {
  epoch++;
  clearTimeout(syncTimer);
  code = data.room.code;
  token = data.token;
  save(sessionStorage, 'tugelo-room-' + code, token);
  history.replaceState(null, '', '?room=' + code);
  newBoard();
  acceptRoom(data.room);
  if (dialog.open) dialog.close();
  connection('已连接');
  poll(epoch);
}

function exit() {
  epoch++;
  clearTimeout(syncTimer);
  save(sessionStorage, 'tugelo-room-' + code, '');
  history.replaceState(null, '', new URL('./', location.href));
  room = null;
  token = '';
  code = '';
  newBoard();
  drawUI();
  connection('在线联机');
}

async function poll(expectedEpoch = epoch) {
  if (!code || expectedEpoch !== epoch) return;
  const revision = actionRevision;
  const sentTurn = room?.turnId ?? '';
  try {
    const { room: next, marks } = await request('/' + code + '/sync?after=' + cursor + '&turn=' + sentTurn);
    if (expectedEpoch !== epoch || revision !== actionRevision) return;
    acceptRoom(next);
    if (marks.length) {
      const acknowledged = new Set(marks.map(mark => mark.nonce));
      confirmed.push(...marks);
      cursor = marks.at(-1).id;
      pending = pending.filter(mark => !acknowledged.has(mark.nonce));
      schedulePaint();
    }
    if (next.signalingReady === false) connection('房主信令重连中', true);
    else connection('已连接');
  } catch (error) {
    if (expectedEpoch !== epoch) return;
    if (error.status === 401 || error.status === 404) {
      exit();
      notify(error.message);
    } else {
      connection('重连中', true);
    }
  } finally {
    if (expectedEpoch === epoch && code) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => poll(expectedEpoch), room?.phase === 'draw' ? 430 : 900);
    }
  }
}

async function act(action, values = {}) {
  if (busy || !room) return false;
  busy = true;
  const current = epoch;
  try {
    const data = await request('/' + code + '/act', { action, ...values });
    if (epoch !== current) return false;
    actionRevision++;
    if (action === 'leave') exit();
    else acceptRoom(data.room);
    return true;
  } catch (error) {
    if (epoch === current) notify(error.name === 'TimeoutError' ? '连接超时，请再试一次。' : error.message);
    return false;
  } finally { busy = false; }
}

const isDrawer = () => room?.drawer === room?.me;
const canDraw = () => room?.phase === 'draw' && isDrawer() && room.deadline > Date.now() + serverOffset;
const canSpeak = () => room && (!['choose','draw'].includes(room.phase) || (!isDrawer() && !room.guessed.includes(room.me)));
const btn = (label, action, kind = 'primary', glyph = '', disabled = false) =>
  '<button type="button" class="button ' + kind + '" data-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + (glyph ? icon(glyph) : '') + label + '</button>';

function face(index) {
  const eye = index % 3 === 1 ? 'M7 12q2-2 4 0m4 0q2-2 4 0' : 'M8.5 12h.01m9 0h.01';
  const top = index % 2 ? 'M7 9Q5 5 9 5q1-4 5-1 4-1 5 4' : 'M8 8Q7 4 11 6q2-5 5-1 5-1 4 4';
  return '<span class="avatar" style="--avatar:' + avatarColors[index] + '"><svg viewBox="0 0 26 26" aria-hidden="true"><path d="M5 12q0-6 8-6t8 6v4q0 5-8 5t-8-5Z" fill="#fff8ef"/><path d="' + top + '" stroke-width="1.5"/><path d="' + eye + '" stroke-width="2"/><path d="M10 16q3 3 6 0" stroke-width="1.5"/><path d="M6.5 15h.8m11.4 0h.8" stroke="#ec8ca5" stroke-width="1.8"/></svg></span>';
}

function renderPlayers() {
  const playerList = room?.players ?? [];
  $('#player-count').textContent = playerList.length + ' / 8';
  const key = JSON.stringify([playerList, room?.me, room?.host, room?.phase, room?.drawer, room?.guessed]);
  const placeholder = (label, subtitle, glyph) => '<div class="player-row placeholder"><span class="avatar">' + icon(glyph) + '</span><div><div class="player-ident"><strong>' + label + '</strong></div><small>' + subtitle + '</small></div></div>';
  let html = playerList.map(player => {
    const drawing = ['choose','draw'].includes(room.phase) && room.drawer === player.id;
    const correct = room.phase === 'draw' && room.guessed.includes(player.id);
    return '<div class="player-row' + (drawing ? ' drawing' : correct ? ' correct' : '') + '">' + face(player.avatar)
      + '<div><div class="player-ident"><strong title="' + escape(player.name) + '">' + escape(player.name) + '</strong>'
      + (room.me === player.id ? '<em>你</em>' : '') + (room.host === player.id ? '<span title="房主">' + icon('crown') + '</span>' : '')
      + '</div><small>' + player.score + ' 分' + (drawing ? ' · 画手' : correct ? ' · 猜中' : '') + '</small></div></div>';
  }).join('');
  if (!room) html = placeholder('你', '加入后显示昵称', 'pencil') + placeholder('好友', '等待加入', 'plus');
  else if (room.phase === 'lobby' && playerList.length < 2) html += placeholder('好友', '等待加入', 'plus');
  region('#players', key, html);
  const launch = room && (room.phase === 'lobby' || room.phase === 'finished') && room.host === room.me;
  const bottom = launch
    ? btn(room.phase === 'finished' ? '再玩一局' : '开始游戏', 'start', 'primary', 'spark', playerList.length < 2)
    : '<p class="player-hint">' + (room?.phase === 'lobby' ? '等房主开始游戏' : room?.turnNumber ? '画手轮换 ' + room.turnNumber + ' / ' + room.turnTotal : '至少两人即可开局') + '</p>';
  region('#player-bottom', bottom, bottom);
}

function renderBanner() {
  const key = room?.code ?? '';
  const markup = room
    ? '<div class="room-code">房间码 <strong>' + room.code + '</strong></div>' + btn('复制邀请链接', 'copy', 'yellow', 'link')
    : '<div class="room-rule">' + icon('people') + ' 2–8 人</div><div class="room-rule">' + icon('clock') + ' 每次 75 秒</div>';
  region('#banner-action', key, markup);
  $('#banner-label').textContent = room ? '好友房间' : '好友派对';
  $('#banner-description').textContent = room
    ? (room.turnNumber ? '第 ' + room.round + ' / ' + room.rounds + ' 轮' : '共 ' + room.rounds + ' 轮，每人轮流当画手。')
    : '轮流画画，看看谁最懂你的灵魂画作。';
  $('#leave').hidden = !room;
}

const art = '<canvas class="welcome-art" width="500" height="248" aria-hidden="true"></canvas>';

function renderBoardOverlay() {
  const overlay = $('#board-overlay');
  const space = $('#drawing-space');
  const phase = room?.phase ?? 'home';
  const painter = room?.players.find(player => player.id === room.drawer);
  let html = '';
  switch (phase) {
    case 'home':
      html = art + '<h3>叫上好友，开画吧！</h3><p>创建一个房间，或输入好友分享的房间码。</p><div class="board-actions">'
        + btn('创建房间', 'create', 'primary', 'plus') + btn('加入房间', 'join', 'outline', 'door') + '</div>';
      break;
    case 'lobby':
      html = art + '<h3>等好友来，马上开画</h3><p>' + (room.players.length < 2 ? '把邀请链接发给好友，至少两人即可开局。' : '玩家已就绪，房主可以开始游戏。') + '</p><div class="board-actions">'
        + (room.host === room.me && room.players.length >= 2 ? btn('开始游戏', 'start', 'primary', 'spark') : btn('复制邀请链接', 'copy', 'soft', 'link')) + '</div>';
      break;
    case 'choose':
      html = art + '<h3>' + (isDrawer() ? '这轮你来画' : escape(painter?.name) + ' 正在选词') + '</h3>'
        + (isDrawer() ? '<p>从下面挑一个你最好发挥的词。</p><div class="word-grid">' + room.options.map((item, i) =>
          '<button type="button" class="word-option" data-word="' + i + '"><strong>' + escape(item.word) + '</strong><small>' + escape(item.category) + '</small></button>').join('') + '</div>'
          : '<p>选好词后，你就可以在聊天区猜词。</p>');
      break;
    case 'result':
      html = '<div class="answer-box"><p>本轮答案</p><h3>' + escape(room.answer?.word) + '</h3></div>';
      break;
    case 'finished': {
      const sorted = [...room.players].sort((a, b) => b.score - a.score);
      html = '<div class="result-sheet"><p>游戏结束</p><h3>最终积分</h3><ol>' + sorted.map(player =>
        '<li><div class="score-line"><span>' + escape(player.name) + '</span><strong>' + player.score + ' 分</strong></div></li>').join('') + '</ol>'
        + (room.host === room.me && room.players.length >= 2 ? '<div class="board-actions">' + btn('再玩一局', 'start', 'primary', 'spark') + '</div>' : '') + '</div>';
      break;
    }
  }
  const changed = region('#board-overlay', html, html);
  if (changed && overlay.querySelector('canvas')) drawWelcome(overlay.querySelector('canvas'));
  overlay.classList.toggle('empty', !html);
  space.classList.toggle('waiting', ['home','lobby','choose'].includes(phase));
  board.classList.toggle('can-draw', canDraw());
}

function renderBoardStatus() {
  const phase = room?.phase ?? 'home';
  const badge = (label, live = false) => '<span class="phase-badge' + (live ? ' live' : '') + '"><span></span>' + label + '</span>';
  const timer = '<span class="timer">' + icon('clock') + '<span id="seconds"></span></span>';
  let html = badge('等待开局');
  if (phase === 'choose') html = badge('选词中') + timer;
  if (phase === 'draw') {
    const word = isDrawer() ? '画 <strong>' + escape(room.answer?.word) + '</strong>'
      : '<strong>' + escape(room.hint?.category) + '</strong> · ' + room.hint?.length + ' 个字';
    html = '<span class="board-word">' + word + '</span>' + timer;
  }
  if (phase === 'result') html = badge('本轮揭晓', true) + timer;
  if (phase === 'finished') html = badge('对局结束', true);
  region('#board-status', html, html);
  updateClock();
}

function updateClock() {
  const display = $('#seconds');
  if (!display || !room?.deadline) return;
  const seconds = Math.max(0, Math.ceil((room.deadline - Date.now() - serverOffset) / 1000));
  display.textContent = (seconds < 60 ? '0:' + String(seconds).padStart(2, '0') : '1:' + String(seconds - 60).padStart(2, '0'));
  display.parentElement.classList.toggle('urgent', seconds <= 10);
}

function renderChat() {
  const messages = room?.messages ?? [{ type: 'system', text: '加入房间后，你可以在这里猜词和聊天。' }];
  const key = (room?.code ?? '-') + ':' + (messages.at(-1)?.id ?? 0) + ':' + messages.length;
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 54;
  if (region('#chat-log', key, messages.map(message => '<div class="chat-message ' + escape(message.type) + '">'
      + (message.type === 'system' ? icon('spark') : '')
      + (message.type === 'chat' ? '<b>' + escape(message.player) + '</b>' : '')
      + '<span>' + escape(message.text) + '</span></div>').join('')) && atBottom) chat.scrollTop = chat.scrollHeight;
  guess.disabled = !canSpeak();
  $('.send').disabled = guess.disabled;
  guess.placeholder = !room ? '在这里输入你的猜测…'
    : guess.disabled ? (isDrawer() ? '画手暂不能发言' : '你已猜中，等下一轮')
    : room.phase === 'draw' ? '输入你的猜测…' : '发送消息…';
}

function renderTools() {
  const enabled = canDraw();
  document.querySelectorAll('.brushbar button, .brushbar select').forEach(control => { control.disabled = !enabled; });
  document.querySelectorAll('[data-tool], [data-color]').forEach(control => {
    const selected = control.dataset.tool ? control.dataset.tool === tool : tool === 'pen' && control.dataset.color === color;
    control.classList.toggle('active', selected);
    control.setAttribute('aria-pressed', selected);
  });
}

function drawUI() {
  renderBanner();
  renderPlayers();
  renderBoardStatus();
  renderBoardOverlay();
  renderTools();
  renderChat();
}

function showDialog(title, glyph, content) {
  $('#dialog-title').textContent = title;
  $('#dialog-icon').innerHTML = icon(glyph);
  $('#dialog-body').innerHTML = content;
  if (!dialog.open) dialog.showModal();
}

function parseRoomCode(value) {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    try { return (new URL(input).searchParams.get('room') ?? '').trim().toUpperCase(); }
    catch { return ''; }
  }
  return input.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
}

function roomForm(create, preset = '') {
  showDialog(create ? '创建房间' : '加入房间', create ? 'plus' : 'door',
    '<form class="room-form"><label>你的昵称<input name="name" required maxlength="16" placeholder="取个好记的名字" autocomplete="nickname" autofocus></label>'
    + (create ? '<label>游戏轮数<select name="rounds"><option value="1">1 轮</option><option value="2">2 轮</option><option value="3" selected>3 轮</option><option value="4">4 轮</option><option value="5">5 轮</option></select></label>'
      : '<label>房间码或邀请链接<input class="code-input" name="code" required maxlength="400" placeholder="输入 6 位房间码，或粘贴链接" autocomplete="off" autocapitalize="characters"></label>')
    + '<p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">' + (create ? '创建房间' : '加入房间') + '</button></form>');
  const form = $('.room-form');
  form.elements.name.value = load(localStorage, 'tugelo-name');
  if (!create) form.elements.code.value = preset;
  (form.elements.name.value && !create && !preset ? form.elements.code : form.elements.name).focus();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const roomCode = create ? '' : parseRoomCode(form.elements.code.value);
    const errorText = form.querySelector('.form-error');
    const button = form.querySelector('button');
    if (!create && !/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode)) {
      errorText.textContent = '请输入有效的 6 位房间码，或粘贴完整的邀请链接。';
      errorText.hidden = false;
      return;
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = create ? '正在创建房间…' : '正在连接房主…';
    errorText.hidden = true;
    try {
      const data = create ? await request('', { name, rounds: Number(form.elements.rounds.value) }, '')
        : await request('/' + roomCode + '/join', { name }, load(sessionStorage, 'tugelo-room-' + roomCode));
      save(localStorage, 'tugelo-name', name);
      enter(data);
    } catch (error) {
      errorText.textContent = error.name === 'TimeoutError' ? '连接超时，请再试一次。' : error.message;
      errorText.hidden = false;
    } finally { button.disabled = false; button.textContent = label; }
  });
}

async function copyInvite() {
  if (!room) return;
  if (room.signalingReady === false) {
    notify('房主的信令暂时断开，恢复连接后好友即可加入。');
    return;
  }
  const url = new URL('./', location.href);
  url.searchParams.set('room', room.code);
  try {
    await navigator.clipboard.writeText(url.href);
    notify('邀请链接已复制');
  } catch {
    showDialog('邀请好友', 'link', '<form class="room-form"><label>复制这个链接发给好友<input readonly name="invite" value="' + escape(url.href) + '"></label></form>');
    const field = $('[name=invite]');
    field.focus();
    field.select();
  }
}

function canvasSize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const rect = board.getBoundingClientRect();
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (board.width === width && board.height === height) return;
  board.width = width;
  board.height = height;
  rendered = [];
  schedulePaint();
}

function fit(width, height) {
  const scale = Math.min(width / 1000, height / 660);
  return { scale, x: (width - 1000 * scale) / 2, y: (height - 660 * scale) / 2 };
}

function ink(mark) {
  if (!mark.points.length) return;
  const frame = fit(board.width, board.height);
  context.save();
  context.setTransform(frame.scale, 0, 0, frame.scale, frame.x, frame.y);
  context.globalCompositeOperation = mark.tool === 'eraser' ? 'destination-out' : 'source-over';
  context.fillStyle = context.strokeStyle = mark.color;
  context.lineCap = context.lineJoin = 'round';
  context.lineWidth = mark.tool === 'eraser' ? mark.width * 2.2 : mark.width;
  const [[x, y], ...rest] = mark.points;
  context.beginPath();
  if (!rest.length) {
    context.arc(x, y * .66, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(x, y * .66);
    for (const [nextX, nextY] of rest) context.lineTo(nextX, nextY * .66);
    context.stroke();
  }
  context.restore();
}

function paintBoard() {
  renderFrame = 0;
  const events = [...confirmed, ...pending];
  const isIncremental = rendered.length <= events.length && rendered.every((nonce, i) => events[i].nonce === nonce)
    && events.slice(rendered.length).every(event => event.kind === 'ink');
  if (isIncremental) {
    for (const mark of events.slice(rendered.length)) ink(mark);
  } else {
    context.clearRect(0, 0, board.width, board.height);
    const strokes = new Map();
    for (const event of events) {
      if (event.kind === 'clear') strokes.clear();
      else if (event.kind === 'undo') strokes.delete(Array.from(strokes.keys()).at(-1));
      else {
        if (!strokes.has(event.stroke)) strokes.set(event.stroke, []);
        strokes.get(event.stroke).push(event);
      }
    }
    for (const segments of strokes.values()) for (const segment of segments) ink(segment);
  }
  rendered = events.map(event => event.nonce);
  if (active) ink(active);
}

function schedulePaint() {
  if (!renderFrame) renderFrame = requestAnimationFrame(paintBoard);
}

function sendMark(mark) {
  if (!canDraw()) return;
  const entry = { ...mark, nonce: markId() };
  const currentEpoch = epoch;
  const turn = room.turnId;
  pending.push(entry);
  schedulePaint();
  queue = queue.catch(() => {}).then(async () => {
    if (epoch !== currentEpoch || room?.turnId !== turn) return;
    const body = { action: 'mark', turn, ...entry };
    try {
      try { await request('/' + code + '/act', body); }
      catch (error) { if (error.status && error.status < 500) throw error; await request('/' + code + '/act', body); }
    } catch (error) {
      if (epoch !== currentEpoch || room?.turnId !== turn) return;
      pending = pending.filter(item => item.nonce !== entry.nonce);
      schedulePaint();
      if (canDraw()) notify(error.status === 409 ? error.message : '有一笔没有同步，请再试一次。');
    }
  });
}

function point(event) {
  const rect = board.getBoundingClientRect();
  const frame = fit(rect.width, rect.height);
  const clamp = n => Math.max(0, Math.min(1000, Math.round(n)));
  return [clamp((event.clientX - rect.left - frame.x) / frame.scale), clamp((event.clientY - rect.top - frame.y) / (frame.scale * .66))];
}

function flushInk(finished = false) {
  if (!active) return;
  const { stroke, tool, color, width, points, dirty } = active;
  if (dirty) sendMark({ kind: 'ink', stroke, tool, color, width, points: [...points] });
  active = finished ? null : { ...active, points: [points.at(-1)], dirty: false, flushed: performance.now() };
}

board.addEventListener('pointerdown', event => {
  if (!canDraw() || active || event.button !== 0) return;
  event.preventDefault();
  board.setPointerCapture(event.pointerId);
  active = { pointer: event.pointerId, stroke: markId(), color, tool, width: Number($('#brush-size').value),
    points: [point(event)], dirty: true, flushed: performance.now() };
  ink(active);
});
board.addEventListener('pointermove', event => {
  if (!active || event.pointerId !== active.pointer || !canDraw()) return;
  const next = point(event);
  const prior = active.points.at(-1);
  if (next[0] === prior[0] && next[1] === prior[1]) return;
  active.points.push(next);
  active.dirty = true;
  ink({ ...active, points: [prior, next] });
  if (active.points.length >= 55 || performance.now() - active.flushed >= 110) flushInk();
});
for (const type of ['pointerup','pointercancel','lostpointercapture']) {
  board.addEventListener(type, event => { if (active?.pointer === event.pointerId) flushInk(true); });
}
new ResizeObserver(canvasSize).observe(board);

$('#swatches').innerHTML = colorList.map(([value, label]) =>
  '<button type="button" class="swatch" style="--swatch:' + value + '" data-color="' + value + '" aria-label="' + label + '" title="' + label + '"></button>').join('');

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tool) {
    tool = button.dataset.tool;
    renderTools();
  }
  if (button.dataset.color) {
    tool = 'pen';
    color = button.dataset.color;
    renderTools();
  }
  if (button.dataset.word !== undefined) void act('choose', { index: Number(button.dataset.word), turn: room?.turnId });
  switch (button.dataset.action) {
    case 'create': roomForm(true); break;
    case 'join': roomForm(false); break;
    case 'start': void act('start'); break;
    case 'copy': void copyInvite(); break;
  }
});

$('#undo').addEventListener('click', () => sendMark({ kind: 'undo' }));
$('#clear').addEventListener('click', () => {
  showDialog('清空画板？', 'trash', '<p>当前画板上的笔迹会全部清除。</p><div class="dialog-actions"><button type="button" class="button outline" id="keep-ink">取消</button><button type="button" class="button primary" id="clear-ink">清空画板</button></div>');
  $('#keep-ink').onclick = () => dialog.close();
  $('#clear-ink').onclick = () => { sendMark({ kind: 'clear' }); dialog.close(); };
});
$('#help').addEventListener('click', () => showDialog('怎么玩？', 'info',
  '<ol><li>创建房间，复制邀请链接发给好友。凑齐 2–8 人后由房主开局。</li><li>每次一人画画，选一个词后有 75 秒作画。其他人在聊天区输入猜测。</li><li>猜中越快，得分越高。每有一人猜中，画手也得 20 分。每轮所有人都画一次，最后总分最高的人获胜。</li>'
  + (isPages ? '<li>房主请保持游戏页面打开。关闭页面或离开房间将结束这间房。</li>' : '') + '</ol>'));
$('#close-dialog').addEventListener('click', () => dialog.close());
$('#leave').addEventListener('click', () => {
  showDialog('离开房间？', 'door', '<p>离开后可以用原房间码重新加入等待中的房间。</p><div class="dialog-actions"><button type="button" class="button outline" id="stay">继续玩</button><button type="button" class="button primary" id="confirm-leave">离开房间</button></div>');
  $('#stay').onclick = () => dialog.close();
  $('#confirm-leave').onclick = async () => { if (await act('leave')) dialog.close(); };
});
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = guess.value.trim();
  if (!text || !canSpeak()) return;
  if (await act('message', { text })) {
    if (guess.value.trim() === text) guess.value = '';
    if (!guess.disabled) guess.focus();
  }
});
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && canDraw()
    && !dialog.open && !event.target.closest('input, select, textarea, [contenteditable]')) {
    event.preventDefault();
    sendMark({ kind: 'undo' });
  }
});

function star(ctx, x, y, radius, fill, stroke) {
  const s = radius;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x + s * .22, y - s * .22, x + s, y);
  ctx.quadraticCurveTo(x + s * .22, y + s * .22, x, y + s);
  ctx.quadraticCurveTo(x - s * .22, y + s * .22, x - s, y);
  ctx.quadraticCurveTo(x - s * .22, y - s * .22, x, y - s);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

function pencil(ctx, x, y, angle, scale, outline) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  const shape = (fill, run) => {
    ctx.beginPath();
    run();
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.stroke();
  };
  shape('#ffcde7', () => { ctx.roundRect(-18, -78, 36, 34, 9); });
  shape('#ffd965', () => { ctx.rect(-18, -54, 36, 107); });
  shape('#ffefbc', () => { ctx.moveTo(-18, 53); ctx.lineTo(0, 83); ctx.lineTo(18, 53); });
  shape(outline, () => { ctx.moveTo(-4, 75); ctx.lineTo(0, 83); ctx.lineTo(4, 75); });
  ctx.strokeStyle = '#e7a53c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-7, -47);
  ctx.lineTo(-7, 49);
  ctx.stroke();
  ctx.restore();
}

function drawWelcome(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.fillStyle = '#ede3ff';
  ctx.beginPath();
  ctx.ellipse(124, 108, 82, 9, -.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(113, 62);
  ctx.rotate(-.125);
  ctx.fillStyle = '#e5d6ff';
  ctx.beginPath();
  ctx.roundRect(-50, -38, 99, 80, 11);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#5537a0';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.roundRect(-56, -44, 99, 80, 11);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#b197ea';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(-42, -29);
  ctx.lineTo(-15, -29);
  ctx.moveTo(-42, -21);
  ctx.lineTo(-24, -21);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-39, 14);
  ctx.bezierCurveTo(-29, -6, -16, -9, -7, 5);
  ctx.bezierCurveTo(2, -14, 15, -14, 26, 14);
  ctx.closePath();
  ctx.fillStyle = '#dcd0ff';
  ctx.fill();
  ctx.strokeStyle = '#825ae0';
  ctx.stroke();
  ctx.fillStyle = '#6143a5';
  for (const dx of [-7, 6]) {
    ctx.beginPath();
    ctx.arc(dx, 2, 1.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#6143a5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(-.5, 4, 3, .15, Math.PI - .15);
  ctx.stroke();
  ctx.restore();
  pencil(ctx, 166, 63, .63, .57, '#5537a0');
  ctx.lineWidth = 1.7;
  star(ctx, 204, 49, 12, '#ffda65', '#704bbb');
  star(ctx, 42, 72, 10, '#f7bfea', '#986ad9');
  star(ctx, 177, 15, 7, '#d9c6ff', null);
  ctx.fillStyle = '#b09adf';
  for (const [x, y] of [[48, 42], [187, 85], [217, 70]]) {
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBanner() {
  const canvas = $('#banner-art');
  canvas.width = 1150;
  canvas.height = 432;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.fillStyle = '#ffffff14';
  ctx.beginPath();
  ctx.ellipse(315, 140, 208, 82, -.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#e3caff72';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 10]);
  ctx.beginPath();
  ctx.moveTo(75, 174);
  ctx.bezierCurveTo(145, 72, 191, 204, 252, 151);
  ctx.bezierCurveTo(309, 88, 399, 101, 478, 157);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#180b694d';
  ctx.beginPath();
  ctx.ellipse(322, 169, 119, 12, -.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(300, 125);
  ctx.rotate(-.17);
  ctx.beginPath();
  ctx.roundRect(-72, -47, 144, 94, 14);
  ctx.fillStyle = '#c9b1ff';
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(-77, -53, 144, 94, 14);
  ctx.fillStyle = '#f8f1ff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#3d228c';
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#9d79f2';
  ctx.beginPath();
  ctx.moveTo(-57, -28);
  ctx.lineTo(-24, -28);
  ctx.moveTo(-57, -17);
  ctx.lineTo(-41, -17);
  ctx.stroke();
  ctx.strokeStyle = '#7244d3';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-53, 16);
  ctx.bezierCurveTo(-29, -5, -8, 8, 4, 16);
  ctx.bezierCurveTo(25, 27, 27, 1, 46, -5);
  ctx.stroke();
  star(ctx, 27, -28, 9, '#f2a7dc', null);
  ctx.restore();
  pencil(ctx, 386, 122, .85, 1, '#35217c');
  ctx.lineWidth = 2.5;
  star(ctx, 491, 81, 19, '#ffda66', '#4b2db5');
  star(ctx, 183, 89, 14, '#f6b8ec', '#5231bd');
  star(ctx, 230, 52, 9, '#e6cffb', null);
  star(ctx, 442, 161, 10, '#f6b8ec', null);
  ctx.fillStyle = '#f1d6ff';
  for (const [x, y] of [[121, 133], [212, 163], [462, 104], [516, 119], [436, 55]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

drawBanner();
drawUI();
setInterval(updateClock, 250);

const incoming = parseRoomCode(new URLSearchParams(location.search).get('room') ?? '');
if (incoming && /^[A-HJ-NP-Z2-9]{6}$/.test(incoming)) {
  const saved = load(sessionStorage, 'tugelo-room-' + incoming);
  if (saved) {
    connection('正在连接');
    request('/' + incoming + '/sync', null, saved).then(data => {
      enter({ token: saved, room: data.room });
    }).catch(error => {
      if (error.status === 401 || error.status === 404) save(sessionStorage, 'tugelo-room-' + incoming, '');
      connection('在线联机');
      roomForm(false, incoming);
    });
  } else roomForm(false, incoming);
}
