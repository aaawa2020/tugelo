import {
  GameError, fails, roomCode, findPlayer, tick, snapshot,
  validateMark, maxMarks, makeRoom, joinPlayer, applyAction, authorizeMark,
} from './rules.js';

const signalClient = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
const peerId = code => 'tugelo-pages-v1-' + code;
const label = 'tugelo-v1';
let peerLibrary;
let host = null;
let guest = null;

function peerError(error) {
  if (error.type === 'peer-unavailable') return new GameError('找不到这个房间，请确认房主仍开着游戏页面。', 404);
  if (error.type === 'unavailable-id') return new GameError('房间码已被占用。', 409);
  if (error.type === 'browser-incompatible') return new GameError('当前浏览器不支持联机，请换用新版 Chrome、Edge 或 Safari。');
  return new GameError('联机服务连接失败，请重试。', 503);
}

function loadPeer() {
  if (!peerLibrary) {
    peerLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = signalClient;
      script.async = true;
      script.onload = () => window.Peer ? resolve(window.Peer) : reject(new GameError('联机组件加载失败。', 503));
      script.onerror = () => reject(new GameError('联机组件加载失败，请重试。', 503));
      document.head.append(script);
    }).catch(error => { peerLibrary = null; throw error; });
  }
  return peerLibrary;
}

async function openPeer(id) {
  const Peer = await loadPeer();
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer();
    let ready = false;
    const finish = error => {
      clearTimeout(timeout);
      if (error) { peer.destroy(); reject(error); }
      else { ready = true; resolve(peer); }
    };
    const timeout = setTimeout(() => finish(new GameError('连接联机服务超时，请重试。', 503)), 12_000);
    peer.on('open', () => { if (!ready) finish(); });
    peer.on('error', error => { if (!ready) finish(peerError(error)); });
    peer.on('disconnected', () => {
      if (ready && !peer.destroyed) setTimeout(() => { if (peer.disconnected && !peer.destroyed) peer.reconnect(); }, 1200);
    });
  });
}

export function createPeerRoom(code, input) {
  const { room, player: owner } = makeRoom(code, input);
  let boardTurn = null;
  let events = [];
  let nonces = new Set();
  const resetBoard = () => {
    if (boardTurn === room.turnId) return;
    boardTurn = room.turnId;
    events = [];
    nonces = new Set();
  };
  const handle = (route, body, token, knownTurn = null, after = 0, now = Date.now()) => {
    if (route !== 'sync' && (!body || typeof body !== 'object' || Array.isArray(body))) fails('提交格式有误。');
    if (route === 'join') {
      const player = joinPlayer(room, body, token);
      return structuredClone({ token: player.token, room: snapshot(room, player, now) });
    }
    const player = findPlayer(room, token);
    if (!player) fails('请先加入这个房间。', 401);
    tick(room, now);
    resetBoard();
    if (route === 'sync') {
      const cursor = knownTurn === room.turnId && Number.isSafeInteger(after) && after > 0 ? after : 0;
      return structuredClone({ room: snapshot(room, player, now), marks: events.slice(cursor, cursor + 20) });
    }
    if (route !== 'act') fails('未知的房间操作。');
    if (body.action === 'mark') {
      authorizeMark(room, token, body, now);
      const event = validateMark(body);
      if (nonces.has(body.nonce)) return { ok: true };
      if (events.length >= maxMarks) fails('这轮画板已经达到笔迹上限。', 409);
      nonces.add(body.nonce);
      events.push({ id: events.length + 1, nonce: body.nonce, ...event });
      return { ok: true };
    }
    const activePlayer = applyAction(room, token, body, now);
    resetBoard();
    return activePlayer ? structuredClone({ room: snapshot(room, activePlayer, now) }) : { ok: true };
  };
  return { owner, handle };
}

function acceptConnection(session, channel) {
  if (channel.label !== label) { channel.close(); return; }
  const limits = { minuteStarted: Date.now(), calls: 0 };
  let boundToken = '';
  const idle = setTimeout(() => { if (!boundToken) channel.close(); }, 25_000);
  channel.on('data', packet => {
    if (!packet || typeof packet !== 'object' || !Number.isSafeInteger(packet.id)) return;
    const now = Date.now();
    if (now - limits.minuteStarted >= 60_000) Object.assign(limits, { minuteStarted: now, calls: 0 });
    if (++limits.calls > 2000) { channel.close(); return; }
    const { id, route, body, turn, after } = packet;
    const token = boundToken || (typeof packet.key === 'string' ? packet.key : '');
    try {
      if (JSON.stringify(packet).length > 12_000) fails('提交内容太长。', 413);
      if (token && token === session.room.owner.token) fails('房主需要在创建房间的页面操作。', 401);
      if (route === 'act' && !boundToken) fails('请先加入这个房间。', 401);
      const data = session.room.handle(route, body, token, turn, after, now);
      if (route === 'join' || route === 'sync') {
        boundToken = data.token || token;
        clearTimeout(idle);
        clearTimeout(session.departures.get(boundToken));
        session.departures.delete(boundToken);
        const previous = session.channels.get(boundToken);
        session.channels.set(boundToken, channel);
        if (previous && previous !== channel) previous.close();
      }
      channel.send({ id, data });
      if (route === 'act' && body.action === 'leave') {
        session.channels.delete(boundToken);
        boundToken = '';
      }
    } catch (error) {
      if (channel.open) channel.send({ id, error: error instanceof GameError ? error.message : '房间同步失败。', status: error.status ?? 500 });
    }
  });
  channel.on('close', () => {
    clearTimeout(idle);
    if (!boundToken || session.channels.get(boundToken) !== channel) return;
    session.channels.delete(boundToken);
    const key = boundToken;
    session.departures.set(key, setTimeout(() => {
      session.departures.delete(key);
      try { session.room.handle('act', { action: 'leave' }, key); } catch {}
    }, 22_000));
  });
}

async function createHost(body) {
  if (host) fails('你已经创建了房间。', 409);
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = roomCode();
    const room = createPeerRoom(code, body);
    try {
      const peer = await openPeer(peerId(code));
      host = { code, room, peer, channels: new Map(), departures: new Map() };
      const session = host;
      peer.on('connection', channel => acceptConnection(session, channel));
      return { token: room.owner.token, room: room.handle('sync', null, room.owner.token).room };
    } catch (error) { if (error.status !== 409) throw error; }
  }
  fails('暂时无法创建房间，请重试。', 503);
}

function guestSession(code) {
  const session = { code, peer: null, channel: null, requestId: 0, pending: new Map() };
  session.close = () => {
    if (session.closed) return;
    session.closed = true;
    if (guest === session) guest = null;
    if (!session.peer?.destroyed) session.peer?.destroy();
    for (const { reject, timer } of session.pending.values()) {
      clearTimeout(timer);
      reject(new GameError('与房主的连接中断。', 503));
    }
    session.pending.clear();
  };
  session.ready = openPeer().then(peer => new Promise((resolve, reject) => {
    session.peer = peer;
    if (session.closed) { peer.destroy(); reject(new GameError('连接已取消。', 503)); return; }
    const channel = peer.connect(peerId(code), { label, reliable: true });
    session.channel = channel;
    let ready = false;
    const finish = error => {
      clearTimeout(timeout);
      if (ready) { session.close(); return; }
      if (error) { session.close(); reject(error); }
      else { ready = true; resolve(); }
    };
    const timeout = setTimeout(() => finish(new GameError('连接房主超时。请确认房间码，或换个网络重试。', 503)), 12_000);
    channel.on('open', () => finish());
    channel.on('error', () => finish(new GameError('连接房主失败，请重试。', 503)));
    channel.on('close', () => finish(new GameError('与房主的连接已断开。', 503)));
    peer.on('error', error => { if (error.type === 'peer-unavailable') finish(peerError(error)); });
    channel.on('data', reply => {
      if (!reply || typeof reply !== 'object') return;
      const request = session.pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timer);
      session.pending.delete(reply.id);
      if (reply.error) request.reject(new GameError(reply.error, reply.status));
      else request.resolve(reply.data);
    });
  })).catch(error => { session.close(); throw error; });
  return session;
}

async function remote(code, route, body, key, turn, after) {
  if (!guest || guest.code !== code) {
    guest?.close();
    guest = guestSession(code);
  }
  const session = guest;
  await session.ready;
  const data = await new Promise((resolve, reject) => {
    const id = ++session.requestId;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      session.close();
      reject(new GameError('房间同步超时，正在重新连接。', 503));
    }, 9000);
    session.pending.set(id, { resolve, reject, timer });
    try { session.channel.send({ id, route, body: body ?? null, key, turn, after }); }
    catch {
      clearTimeout(timer);
      session.pending.delete(id);
      session.close();
      reject(new GameError('与房主的连接已断开。', 503));
    }
  });
  if (route === 'act' && body.action === 'leave') session.close();
  return data;
}

export async function peerRequest(path, body, key) {
  if (!path) return createHost(body);
  const url = new URL(path, 'https://tugelo.local');
  const [, code, route] = url.pathname.match(/^\/([A-HJ-NP-Z2-9]{6})\/(join|sync|act)$/) ?? [];
  if (!code) fails('这个房间码无效。', 404);
  const turn = url.searchParams.get('turn');
  const after = Number(url.searchParams.get('after'));
  if (host?.code === code) {
    const data = host.room.handle(route, body, key, turn, after);
    if (route === 'act' && body.action === 'leave') {
      host.peer.destroy();
      for (const timer of host.departures.values()) clearTimeout(timer);
      host = null;
    }
    return data;
  }
  return remote(code, route, body, key, turn, after);
}
