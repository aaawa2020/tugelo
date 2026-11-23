const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const colors = new Set(['#211b35','#81808f','#ed4779','#ff6054','#f6a629','#ffdb53','#25b98b','#3d91f5','#7a55ee']);
const turns = 75_000;
const maxMarks = 2_500;
const groups = {
  '动物': ['长颈鹿','大熊猫','袋鼠','猫头鹰','企鹅','小乌龟','章鱼','刺猬','小螃蟹','海豚','松鼠','水母','羊驼','河马','萤火虫','比目鱼','变色龙','火烈鸟','啄木鸟','北极熊','蜗牛','小蝌蚪'],
  '食物': ['冰淇淋','珍珠奶茶','生日蛋糕','西瓜','烤红薯','菠萝','寿司','巧克力','小笼包','薯条','爆米花','甜甜圈','糖葫芦','煎鸡蛋','披萨','肉夹馍','火锅','蛋挞','三明治','棉花糖'],
  '日常': ['闹钟','望远镜','自行车','雨伞','吹风机','行李箱','订书机','照相机','太阳眼镜','回旋镖','滑板','吉他','溜冰鞋','购物车','救生圈','钥匙','纸飞机','地球仪','存钱罐','红绿灯'],
  '地方': ['游乐园','火山','海底世界','图书馆','公交站','动物园','足球场','医院','电影院','沙漠','地铁站','摩天轮','灯塔','滑雪场','火车站'],
  '动作': ['打篮球','跳绳','放风筝','做俯卧撑','洗衣服','拍照','钓鱼','划船','吹泡泡','打喷嚏','游泳','跳广场舞','踢毽子','骑马','堆雪人','扔飞盘','跳高'],
};
const words = Object.entries(groups).flatMap(([category, list]) => list.map(word => ({ category, word })));

class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const fails = (message, status) => { throw new GameError(message, status); };
const clean = (input, length) => typeof input === 'string' ? [...input.trim().replace(/[\s\u0000-\u001f]+/g, ' ')].slice(0, length).join('') : '';
const normal = input => input.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), value => alphabet[value % 32]).join('');
const findPlayer = (room, token) => room.players.find(player => player.token === token);
const writer = room => room.players.find(player => player.id === room.drawer);
const playerInfo = ({ id, name, avatar, score }) => ({ id, name, avatar, score });

function message(room, type, text, player = null) {
  room.messages.push({ id: ++room.messageId, type, text, player: player?.name ?? null, avatar: player?.avatar ?? null });
  if (room.messages.length > 70) room.messages.shift();
}

function newPlayer(room, name) {
  const avatar = Array.from({ length: 8 }, (_, i) => i).find(i => !room.players.some(player => player.avatar === i));
  return { id: crypto.randomUUID(), token: crypto.randomUUID(), name, avatar, score: 0 };
}

function chooseOptions(room) {
  const available = words.filter(item => !room.used.includes(item.word));
  const chosen = [];
  while (chosen.length < 3) {
    const index = Math.floor(Math.random() * available.length);
    chosen.push(available.splice(index, 1)[0]);
  }
  return chosen;
}

function nextTurn(room, now) {
  do { room.turn++; } while (room.turn < room.order.length && !room.players.some(p => p.id === room.order[room.turn]));
  if (room.turn >= room.order.length) {
    room.phase = 'finished';
    room.deadline = null;
    return;
  }
  room.drawer = room.order[room.turn];
  room.turnId = crypto.randomUUID();
  room.phase = 'choose';
  room.deadline = now + 18_000;
  room.answer = null;
  room.options = chooseOptions(room);
  room.guessed = [];
  message(room, 'system', writer(room).name + ' 正在选词。');
}

function beginDrawing(room, index, now) {
  room.answer = room.options[index];
  room.used.push(room.answer.word);
  room.options = [];
  room.phase = 'draw';
  room.deadline = now + turns;
  message(room, 'system', writer(room).name + ' 开始画画了！');
}

function endTurn(room, now) {
  room.phase = 'result';
  room.deadline = now + 5_000;
  if (room.answer) message(room, 'system', '本轮答案是「' + room.answer.word + '」。');
}

function tick(room, now) {
  if (!room.deadline || now < room.deadline) return false;
  if (room.phase === 'choose') beginDrawing(room, 0, now);
  else if (room.phase === 'draw') endTurn(room, now);
  else if (room.phase === 'result') nextTurn(room, now);
  else return false;
  return true;
}

function snapshot(room, player, now) {
  const canSee = player.id === room.drawer || room.phase === 'result' || room.phase === 'finished';
  return {
    code: room.code, host: room.host, me: player.id, players: room.players.map(playerInfo),
    phase: room.phase, rounds: room.rounds, round: Math.min(room.rounds, Math.floor(Math.max(0, room.turn) / (room.seats || 1)) + 1),
    turnId: room.turnId, turnNumber: Math.max(0, Math.min(room.order.length, room.turn + 1)), turnTotal: room.order.length,
    drawer: room.drawer, deadline: room.deadline, time: now,
    answer: canSee ? room.answer : null,
    hint: room.answer ? { category: room.answer.category, length: [...room.answer.word].length } : null,
    options: room.phase === 'choose' && player.id === room.drawer ? room.options : [],
    guessed: room.guessed, messages: room.messages,
  };
}

function validateMark(body) {
  if (!/^[a-z0-9-]{10,50}$/i.test(body.nonce ?? '') || !/^[a-z0-9-]{10,50}$/i.test(body.turn ?? '')) fails('无效的画板操作。');
  if (body.kind === 'clear' || body.kind === 'undo') return { kind: body.kind };
  if (body.kind !== 'ink' || !/^[a-z0-9-]{10,50}$/i.test(body.stroke ?? '') || !colors.has(body.color)
      || ![3, 6, 11, 20].includes(body.width) || !['pen','eraser'].includes(body.tool)
      || !Array.isArray(body.points) || !body.points.length || body.points.length > 70
      || !body.points.every(point => Array.isArray(point) && point.length === 2 && point.every(n => Number.isInteger(n) && n >= 0 && n <= 1000))) {
    fails('无效的画板操作。');
  }
  return { kind: 'ink', stroke: body.stroke, color: body.color, width: body.width, tool: body.tool, points: body.points };
}

function makeRoom(code, body) {
  const name = clean(body.name, 16);
  if (!name) fails('请输入昵称。');
  const rounds = [1, 2, 3, 4, 5].includes(body.rounds) ? body.rounds : 3;
  const room = { code, host: null, rounds, phase: 'lobby', players: [], order: [], turn: -1, turnId: null,
    drawer: null, deadline: null, answer: null, options: [], guessed: [], messages: [], messageId: 0, used: [] };
  const player = newPlayer(room, name);
  room.players.push(player);
  room.host = player.id;
  message(room, 'system', name + ' 创建了房间。');
  return { room, player };
}

function joinPlayer(room, body, token) {
  const name = clean(body.name, 16);
  const existing = token && findPlayer(room, token);
  if (existing) return existing;
  if (!name) fails('请输入昵称。');
  if (!['lobby', 'finished'].includes(room.phase)) fails('这一局已经开始，等这局结束后再加入吧。', 409);
  if (room.players.length >= 8) fails('房间已经满员。', 409);
  const player = newPlayer(room, name);
  room.players.push(player);
  if (!room.host) room.host = player.id;
  message(room, 'system', name + ' 加入了房间。');
  return player;
}

function applyAction(room, token, body, now = Date.now()) {
  const player = findPlayer(room, token);
  if (!player) fails('请先加入这个房间。', 401);
  tick(room, now);
  switch (body.action) {
    case 'start':
      if (room.host !== player.id || !['lobby','finished'].includes(room.phase)) fails('当前无法开始新对局。', 409);
      if (room.players.length < 2) fails('至少需要两位玩家。');
      room.players.forEach(person => { person.score = 0; });
      room.seats = room.players.length;
      room.order = Array.from({ length: room.rounds }, () => room.players.map(person => person.id)).flat();
      room.turn = -1;
      room.used = [];
      room.messages = [];
      nextTurn(room, now);
      break;
    case 'choose':
      if (room.phase !== 'choose' || room.drawer !== player.id || room.turnId !== body.turn || ![0, 1, 2].includes(body.index)) fails('选词时间已结束。', 409);
      beginDrawing(room, body.index, now);
      break;
    case 'message': {
      const text = clean(body.text, 80);
      if (!text) fails('请输入内容。');
      if (now - (player.lastMessage || 0) < 600) fails('发送太快了，稍等一下。', 429);
      if (['choose','draw'].includes(room.phase) && (room.drawer === player.id || room.guessed.includes(player.id))) {
        fails('请等本轮结束后再发言。', 409);
      }
      player.lastMessage = now;
      if (room.phase === 'draw' && normal(text) === normal(room.answer.word)) {
        const points = 30 + Math.ceil((room.deadline - now) / turns * 70);
        player.score += points;
        writer(room).score += 20;
        room.guessed.push(player.id);
        message(room, 'correct', player.name + ' 猜对了！ +' + points + ' 分', player);
        if (room.players.every(person => person.id === room.drawer || room.guessed.includes(person.id))) endTurn(room, now);
      } else {
        message(room, 'chat', text, player);
      }
      break;
    }
    case 'leave':
      room.players = room.players.filter(person => person.id !== player.id);
      if (room.host === player.id) room.host = room.players[0]?.id ?? null;
      message(room, 'system', player.name + ' 离开了房间。');
      if (['choose', 'draw', 'result'].includes(room.phase)) {
        if (room.players.length < 2) {
          Object.assign(room, { phase: 'lobby', deadline: null, answer: null, drawer: null, turnId: null, options: [], turn: -1, order: [], guessed: [] });
          message(room, 'system', '玩家不足两人，已回到等待大厅。');
        } else if (room.drawer === player.id) {
          nextTurn(room, now);
        } else if (room.phase === 'draw' && room.players.every(person => person.id === room.drawer || room.guessed.includes(person.id))) {
          endTurn(room, now);
        }
      }
      return null;
    default:
      fails('未知的房间操作。');
  }
  return player;
}

function authorizeMark(room, token, body, now) {
  const player = findPlayer(room, token);
  if (!player) fails('请先加入这个房间。', 401);
  if (room.drawer !== player.id || room.phase !== 'draw' || now >= room.deadline || room.turnId !== body.turn) {
    fails('画画时间已结束。', 409);
  }
}

export { GameError, fails, roomCode, findPlayer, tick, snapshot, validateMark, maxMarks, makeRoom, joinPlayer, applyAction, authorizeMark };
