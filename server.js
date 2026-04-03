const crypto = require('crypto');
const path = require('path');
const http = require('http');

const express = require('express');
const helmet = require('helmet');
const { customAlphabet } = require('nanoid');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '64kb' }));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'ws:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

const ipBuckets = new Map();
const wsIpBuckets = new Map();

function getClientIp(req) {
  return (req.ip || req.socket.remoteAddress || 'unknown').toString();
}

function isRateLimited(bucketMap, key, limit, windowMs) {
  const now = Date.now();
  const bucket = bucketMap.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucketMap.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

function apiRateLimit(limit, windowMs) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${ip}:${req.path}`;

    if (isRateLimited(ipBuckets, key, limit, windowMs)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    return next();
  };
}

app.use('/api', apiRateLimit(60, 60_000));

function cleanText(text, maxLen) {
  if (typeof text !== 'string') return '';
  return text.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, maxLen);
}

const makeRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const makeId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const rooms = new Map();
const wsClients = new Map();

const QUESTION_SET = [
  {
    id: 'q1',
    prompt: 'What planet is known as the Red Planet?',
    options: ['Mars', 'Jupiter', 'Venus', 'Saturn'],
    answerIndex: 0,
    difficulty: 1
  },
  {
    id: 'q2',
    prompt: 'Which language runs in a web browser?',
    options: ['Java', 'C', 'Python', 'JavaScript'],
    answerIndex: 3,
    difficulty: 1
  },
  {
    id: 'q3',
    prompt: 'What is 9 x 8?',
    options: ['72', '81', '63', '69'],
    answerIndex: 0,
    difficulty: 1
  },
  {
    id: 'q4',
    prompt: 'Which protocol secures web traffic?',
    options: ['HTTP', 'FTP', 'HTTPS', 'SMTP'],
    answerIndex: 2,
    difficulty: 2
  },
  {
    id: 'q5',
    prompt: 'What data structure uses FIFO?',
    options: ['Stack', 'Queue', 'Tree', 'Graph'],
    answerIndex: 1,
    difficulty: 2
  },
  {
    id: 'q6',
    prompt: 'How many bits are in a byte?',
    options: ['4', '8', '16', '32'],
    answerIndex: 1,
    difficulty: 1
  }
];

function signPayload(payload) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(JSON.stringify(payload));
  return hmac.digest('hex');
}

function createToken(payload) {
  const safePayload = { ...payload, iat: Date.now() };
  const signature = signPayload(safePayload);
  return Buffer.from(JSON.stringify({ p: safePayload, s: signature })).toString('base64url');
}

function verifyToken(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed?.p || !parsed?.s) return null;
    const expected = signPayload(parsed.p);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.s))) return null;
    return parsed.p;
  } catch {
    return null;
  }
}

function sortLeaderboard(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, streak: p.streak, strikes: p.strikes }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function broadcastRoom(roomCode, payload) {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const player of room.players.values()) {
    const ws = wsClients.get(player.id);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

function sendToPlayer(playerId, payload) {
  const ws = wsClients.get(playerId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function roomPublicState(room) {
  return {
    code: room.code,
    status: room.status,
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length,
    leaderboard: sortLeaderboard(room),
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready }))
  };
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateQuestionForPlayer(question) {
  const indices = question.options.map((_, idx) => idx);
  const shuffled = shuffleArray(indices);
  return {
    id: question.id,
    prompt: question.prompt,
    difficulty: question.difficulty,
    options: shuffled.map((idx) => question.options[idx]),
    map: shuffled
  };
}

function scheduleQuestionTimeout(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
  }

  room.roundTimer = setTimeout(() => {
    finalizeQuestion(room.code);
  }, room.roundDurationMs + 100);
}

function startQuestion(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'active') return;

  if (room.questionIndex >= room.questions.length) {
    room.status = 'finished';
    broadcastRoom(roomCode, {
      type: 'game_over',
      room: roomPublicState(room),
      winner: sortLeaderboard(room)[0] || null
    });
    return;
  }

  room.answers.clear();
  room.roundStartedAt = Date.now();
  const question = room.questions[room.questionIndex];

  for (const player of room.players.values()) {
    const qView = generateQuestionForPlayer(question);
    room.currentQuestionViews.set(player.id, qView);
    sendToPlayer(player.id, {
      type: 'question',
      questionIndex: room.questionIndex,
      totalQuestions: room.questions.length,
      endsAt: room.roundStartedAt + room.roundDurationMs,
      question: {
        id: qView.id,
        prompt: qView.prompt,
        options: qView.options,
        difficulty: qView.difficulty
      }
    });
  }

  broadcastRoom(roomCode, {
    type: 'room_update',
    room: roomPublicState(room)
  });

  scheduleQuestionTimeout(room);
}

function computePoints({ correct, elapsedMs, difficulty, streak, usedPowerup }) {
  if (!correct) return 0;
  const maxWindow = 12_000;
  const speedFactor = Math.max(0.35, 1 - elapsedMs / maxWindow);
  const base = 400 + difficulty * 160;
  const streakBonus = Math.min(250, streak * 30);
  const powerupBonus = usedPowerup === 'double' ? 1.8 : 1;
  return Math.floor((base * speedFactor + streakBonus) * powerupBonus);
}

function finalizeQuestion(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'active') return;

  const question = room.questions[room.questionIndex];

  for (const player of room.players.values()) {
    if (!room.answers.has(player.id)) {
      player.streak = 0;
    }
  }

  broadcastRoom(roomCode, {
    type: 'answer_reveal',
    correctAnswer: question.options[question.answerIndex],
    leaderboard: sortLeaderboard(room)
  });

  room.questionIndex += 1;
  room.currentQuestionViews.clear();

  setTimeout(() => startQuestion(roomCode), 2500);
}

function removePlayer(room, playerId) {
  room.players.delete(playerId);
  room.answers.delete(playerId);
  room.currentQuestionViews.delete(playerId);

  if (room.players.size === 0) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    rooms.delete(room.code);
    return;
  }

  broadcastRoom(room.code, {
    type: 'room_update',
    room: roomPublicState(room)
  });
}

app.post('/api/rooms', apiRateLimit(20, 60_000), (req, res) => {
  const hostName = cleanText(req.body?.hostName, 20);
  if (!hostName) {
    return res.status(400).json({ error: 'Invalid host name' });
  }

  const code = makeRoomCode();
  const hostId = makeId();

  const questions = shuffleArray(QUESTION_SET).slice(0, 5);

  const room = {
    code,
    hostId,
    status: 'lobby',
    players: new Map(),
    questions,
    questionIndex: 0,
    roundDurationMs: 12_000,
    roundStartedAt: null,
    roundTimer: null,
    answers: new Map(),
    currentQuestionViews: new Map(),
    createdAt: Date.now()
  };

  room.players.set(hostId, {
    id: hostId,
    name: hostName,
    score: 0,
    streak: 0,
    ready: true,
    strikes: 0,
    usedPowerup: null
  });

  rooms.set(code, room);

  const hostToken = createToken({ roomCode: code, playerId: hostId, role: 'host' });

  return res.status(201).json({
    roomCode: code,
    playerId: hostId,
    token: hostToken,
    room: roomPublicState(room)
  });
});

app.post('/api/rooms/:code/join', apiRateLimit(25, 60_000), (req, res) => {
  const roomCode = cleanText(req.params.code, 6).toUpperCase();
  const name = cleanText(req.body?.name, 20);

  if (!name) {
    return res.status(400).json({ error: 'Invalid player name' });
  }

  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== 'lobby') {
    return res.status(400).json({ error: 'Game already started' });
  }

  if (room.players.size >= 60) {
    return res.status(403).json({ error: 'Room full' });
  }

  const playerId = makeId();
  room.players.set(playerId, {
    id: playerId,
    name,
    score: 0,
    streak: 0,
    ready: true,
    strikes: 0,
    usedPowerup: null
  });

  const token = createToken({ roomCode, playerId, role: 'player' });

  broadcastRoom(roomCode, {
    type: 'room_update',
    room: roomPublicState(room)
  });

  return res.json({ playerId, token, room: roomPublicState(room) });
});

app.post('/api/rooms/:code/start', apiRateLimit(20, 60_000), (req, res) => {
  const roomCode = cleanText(req.params.code, 6).toUpperCase();
  const token = req.body?.token;

  if (typeof token !== 'string') {
    return res.status(401).json({ error: 'Token required' });
  }

  const payload = verifyToken(token);
  if (!payload || payload.roomCode !== roomCode || payload.role !== 'host') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== 'lobby') {
    return res.status(400).json({ error: 'Room already active' });
  }

  room.status = 'active';
  broadcastRoom(roomCode, {
    type: 'room_update',
    room: roomPublicState(room)
  });

  setTimeout(() => startQuestion(roomCode), 1000);

  return res.json({ ok: true });
});

app.get('/api/rooms/:code', apiRateLimit(50, 60_000), (req, res) => {
  const roomCode = cleanText(req.params.code, 6).toUpperCase();
  const room = rooms.get(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  return res.json({ room: roomPublicState(room) });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || 'unknown').toString();

  if (isRateLimited(wsIpBuckets, ip, 100, 60_000)) {
    ws.close(1008, 'Rate limited');
    return;
  }

  if (APP_ORIGIN) {
    const origin = req.headers.origin;
    if (origin !== APP_ORIGIN) {
      ws.close(1008, 'Invalid origin');
      return;
    }
  }

  let authedPlayerId = null;
  let authedRoomCode = null;

  const authTimeout = setTimeout(() => {
    if (!authedPlayerId) ws.close(1008, 'Auth timeout');
  }, 5000);

  ws.on('message', (raw) => {
    if (raw.length > 2048) {
      ws.close(1009, 'Payload too large');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close(1003, 'Invalid JSON');
      return;
    }

    if (!authedPlayerId) {
      if (msg.type !== 'auth' || typeof msg.token !== 'string') {
        ws.close(1008, 'Auth required');
        return;
      }

      const payload = verifyToken(msg.token);
      if (!payload || typeof payload.roomCode !== 'string' || typeof payload.playerId !== 'string') {
        ws.close(1008, 'Invalid token');
        return;
      }

      const room = rooms.get(payload.roomCode);
      if (!room || !room.players.has(payload.playerId)) {
        ws.close(1008, 'Room/player not found');
        return;
      }

      authedPlayerId = payload.playerId;
      authedRoomCode = payload.roomCode;
      wsClients.set(authedPlayerId, ws);
      clearTimeout(authTimeout);

      sendToPlayer(authedPlayerId, { type: 'room_update', room: roomPublicState(room) });
      return;
    }

    const room = rooms.get(authedRoomCode);
    const player = room?.players.get(authedPlayerId);
    if (!room || !player) {
      ws.close(1008, 'Session invalid');
      return;
    }

    const roomPlayerMessageKey = `${authedRoomCode}:${authedPlayerId}`;
    if (isRateLimited(wsIpBuckets, roomPlayerMessageKey, 40, 10_000)) {
      player.strikes += 1;
      if (player.strikes >= 5) {
        ws.close(1008, 'Too many suspicious requests');
      }
      return;
    }

    if (msg.type === 'activate_powerup') {
      if (msg.powerup !== 'double') return;
      if (player.usedPowerup) return;
      player.usedPowerup = 'double';
      sendToPlayer(authedPlayerId, { type: 'powerup_status', active: 'double' });
      return;
    }

    if (msg.type === 'answer') {
      if (room.status !== 'active') return;
      if (room.answers.has(authedPlayerId)) {
        player.strikes += 1;
        return;
      }

      const currentView = room.currentQuestionViews.get(authedPlayerId);
      const q = room.questions[room.questionIndex];
      if (!currentView || !q) return;

      const answerIndex = Number(msg.answerIndex);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= currentView.options.length) {
        player.strikes += 1;
        return;
      }

      const elapsedMs = Date.now() - room.roundStartedAt;
      if (elapsedMs < 250) {
        player.strikes += 1;
        return;
      }

      const chosenOriginalIndex = currentView.map[answerIndex];
      const correct = chosenOriginalIndex === q.answerIndex;

      if (correct) {
        player.streak += 1;
      } else {
        player.streak = 0;
      }

      const points = computePoints({
        correct,
        elapsedMs,
        difficulty: q.difficulty,
        streak: player.streak,
        usedPowerup: player.usedPowerup
      });

      player.score += points;

      room.answers.set(authedPlayerId, {
        answerIndex,
        originalIndex: chosenOriginalIndex,
        correct,
        elapsedMs,
        points
      });

      player.usedPowerup = null;

      sendToPlayer(authedPlayerId, {
        type: 'answer_result',
        correct,
        points,
        elapsedMs,
        streak: player.streak
      });

      if (room.answers.size >= room.players.size) {
        finalizeQuestion(authedRoomCode);
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!authedPlayerId || !authedRoomCode) return;
    wsClients.delete(authedPlayerId);
    const room = rooms.get(authedRoomCode);
    if (!room) return;

    const wasHost = authedPlayerId === room.hostId;
    removePlayer(room, authedPlayerId);

    if (wasHost && rooms.has(authedRoomCode)) {
      const fallbackHost = [...room.players.values()][0];
      room.hostId = fallbackHost.id;
      sendToPlayer(fallbackHost.id, { type: 'host_promoted' });
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > 1000 * 60 * 60 * 2) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      rooms.delete(room.code);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`QuizFortress running on port ${PORT}`);
});
