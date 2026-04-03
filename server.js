const crypto = require('crypto');
const path = require('path');
const http = require('http');

const express = require('express');
const helmet = require('helmet');
const { customAlphabet } = require('nanoid');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = process.env.DATABASE_SSL === 'true';

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined
    })
  : null;

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
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

const ipBuckets = new Map();
const wsBuckets = new Map();

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
    const key = `${getClientIp(req)}:${req.path}`;
    if (isRateLimited(ipBuckets, key, limit, windowMs)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

app.use('/api', apiRateLimit(80, 60_000));

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, maxLen);
}

function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18);
}

function cleanPassword(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 128);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('hex');
}

async function dbQuery(text, params) {
  if (!pool) {
    throw new Error('DATABASE_URL is required for persistent accounts');
  }

  return pool.query(text, params);
}

async function initDatabase() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quizzy_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      default_profile JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function initDatabaseWithRetry(maxAttempts = 20, delayMs = 5000) {
  if (!pool) return;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await initDatabase();
      console.log('Database is ready.');
      return;
    } catch (error) {
      console.error(`Database init attempt ${attempt}/${maxAttempts} failed:`, error.message || error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error('Database not ready after retries; service will continue, but account features may fail until DB is available.');
}

async function getUserByUsername(username) {
  if (!pool) return null;
  const result = await dbQuery('SELECT * FROM quizzy_users WHERE username = $1 LIMIT 1', [username]);
  return result.rows[0] || null;
}

async function getUserById(userId) {
  if (!pool) return null;
  const result = await dbQuery('SELECT * FROM quizzy_users WHERE id = $1 LIMIT 1', [userId]);
  return result.rows[0] || null;
}

async function createUser({ id, username, salt, passwordHash, defaultProfile }) {
  const result = await dbQuery(
    `INSERT INTO quizzy_users (id, username, salt, password_hash, default_profile)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, username, salt, passwordHash, JSON.stringify(defaultProfile)]
  );

  return result.rows[0];
}

function signPayload(payload) {
  const h = crypto.createHmac('sha256', SESSION_SECRET);
  h.update(JSON.stringify(payload));
  return h.digest('hex');
}

function createToken(payload) {
  const signedPayload = { ...payload, iat: Date.now() };
  const signature = signPayload(signedPayload);
  return Buffer.from(JSON.stringify({ p: signedPayload, s: signature })).toString('base64url');
}

function verifyToken(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed?.p || typeof parsed?.s !== 'string') return null;
    const expected = signPayload(parsed.p);
    if (expected.length !== parsed.s.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.s))) return null;
    return parsed.p;
  } catch {
    return null;
  }
}

const makeRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const makeId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const usersByName = new Map();
const usersById = new Map();
const rooms = new Map();
const wsClients = new Map();

const PROFILE_OPTIONS = {
  avatars: ['fox', 'owl', 'panda', 'rocket', 'wizard', 'cat'],
  frames: ['neon', 'frost', 'ember', 'pixel'],
  titles: ['Rookie', 'Tactician', 'Speedster', 'Brainiac', 'MemeLord'],
  colors: ['cyan', 'gold', 'mint', 'coral', 'violet']
};

const GAME_MODES = {
  classic: {
    id: 'classic',
    name: 'Classic Clash',
    questionCount: 5,
    roundDurationMs: 12_000,
    scoreMultiplier: 1,
    streakMultiplier: 1,
    chaosChance: 0
  },
  lightning: {
    id: 'lightning',
    name: 'Lightning Rush',
    questionCount: 7,
    roundDurationMs: 8_500,
    scoreMultiplier: 1.2,
    streakMultiplier: 1,
    chaosChance: 0
  },
  chaos: {
    id: 'chaos',
    name: 'Chaos Jackpot',
    questionCount: 6,
    roundDurationMs: 11_000,
    scoreMultiplier: 1,
    streakMultiplier: 1.35,
    chaosChance: 0.4
  }
};

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
  },
  {
    id: 'q7',
    prompt: 'What year did the first iPhone release?',
    options: ['2003', '2007', '2010', '2012'],
    answerIndex: 1,
    difficulty: 2
  },
  {
    id: 'q8',
    prompt: 'What is the capital of Japan?',
    options: ['Seoul', 'Osaka', 'Kyoto', 'Tokyo'],
    answerIndex: 3,
    difficulty: 1
  }
];

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function validateProfile(rawProfile) {
  const avatar = cleanText(rawProfile?.avatar || '', 16);
  const frame = cleanText(rawProfile?.frame || '', 16);
  const title = cleanText(rawProfile?.title || '', 20);
  const color = cleanText(rawProfile?.color || '', 16);

  return {
    avatar: PROFILE_OPTIONS.avatars.includes(avatar) ? avatar : 'fox',
    frame: PROFILE_OPTIONS.frames.includes(frame) ? frame : 'neon',
    title: PROFILE_OPTIONS.titles.includes(title) ? title : 'Rookie',
    color: PROFILE_OPTIONS.colors.includes(color) ? color : 'cyan'
  };
}

function getModeOrDefault(modeId) {
  const id = cleanText(modeId || '', 12).toLowerCase();
  return GAME_MODES[id] || GAME_MODES.classic;
}

function makePlayer({ id, name, profile }) {
  return {
    id,
    name,
    profile: validateProfile(profile),
    score: 0,
    streak: 0,
    ready: true,
    strikes: 0,
    usedPowerup: null
  };
}

function verifyAccountToken(accountToken) {
  if (typeof accountToken !== 'string') return null;
  const payload = verifyToken(accountToken);
  if (!payload || payload.role !== 'account' || typeof payload.userId !== 'string') return null;
  return payload;
}

function sortLeaderboard(room) {
  return [...room.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      profile: p.profile,
      score: p.score,
      streak: p.streak,
      strikes: p.strikes
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function roomPublicState(room) {
  return {
    code: room.code,
    status: room.status,
    mode: { id: room.mode.id, name: room.mode.name },
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length,
    leaderboard: sortLeaderboard(room),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      profile: p.profile,
      ready: p.ready
    }))
  };
}

function sendToPlayer(playerId, payload) {
  const ws = wsClients.get(playerId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastRoom(roomCode, payload) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const player of room.players.values()) {
    sendToPlayer(player.id, payload);
  }
}

function generateQuestionForPlayer(question) {
  const order = shuffleArray(question.options.map((_, idx) => idx));
  return {
    id: question.id,
    prompt: question.prompt,
    difficulty: question.difficulty,
    options: order.map((idx) => question.options[idx]),
    map: order
  };
}

function computePoints({ room, correct, elapsedMs, difficulty, streak, usedPowerup }) {
  if (!correct) return 0;

  const maxWindow = room.roundDurationMs;
  const speedFactor = Math.max(0.35, 1 - elapsedMs / maxWindow);
  const base = 420 + difficulty * 160;
  const streakBonus = Math.min(260, streak * 28 * room.mode.streakMultiplier);
  const powerupBonus = usedPowerup === 'double' ? 1.8 : 1;
  const chaosBonus = room.currentChaosMultiplier || 1;

  return Math.floor((base * speedFactor + streakBonus) * room.mode.scoreMultiplier * powerupBonus * chaosBonus);
}

function scheduleQuestionTimeout(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => finalizeQuestion(room.code), room.roundDurationMs + 120);
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
  room.currentChaosMultiplier = 1;

  if (Math.random() < room.mode.chaosChance) {
    room.currentChaosMultiplier = 1.8;
  }

  const question = room.questions[room.questionIndex];

  for (const player of room.players.values()) {
    const qView = generateQuestionForPlayer(question);
    room.currentQuestionViews.set(player.id, qView);
    sendToPlayer(player.id, {
      type: 'question',
      questionIndex: room.questionIndex,
      totalQuestions: room.questions.length,
      modeName: room.mode.name,
      chaosMultiplier: room.currentChaosMultiplier,
      endsAt: room.roundStartedAt + room.roundDurationMs,
      question: {
        id: qView.id,
        prompt: qView.prompt,
        options: qView.options,
        difficulty: qView.difficulty
      }
    });
  }

  broadcastRoom(roomCode, { type: 'room_update', room: roomPublicState(room) });
  scheduleQuestionTimeout(room);
}

function finalizeQuestion(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'active') return;

  const question = room.questions[room.questionIndex];
  if (!question) return;

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

  broadcastRoom(room.code, { type: 'room_update', room: roomPublicState(room) });
}

app.get('/api/meta/options', apiRateLimit(40, 60_000), (req, res) => {
  return res.json({
    profileOptions: PROFILE_OPTIONS,
    modes: Object.values(GAME_MODES).map((m) => ({ id: m.id, name: m.name }))
  });
});

app.post('/api/auth/register', apiRateLimit(15, 60_000), async (req, res) => {
  try {
    const username = cleanUsername(req.body?.username);
    const password = cleanPassword(req.body?.password);

    if (username.length < 3 || password.length < 8) {
      return res.status(400).json({ error: 'Username must be 3+ chars and password 8+ chars' });
    }

    if (!pool) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const existing = await getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const salt = crypto.randomBytes(16).toString('hex');

    const user = await createUser({
      id: makeId(),
      username,
      salt,
      passwordHash: hashPassword(password, salt),
      defaultProfile: validateProfile(req.body?.defaultProfile)
    });

    const accountToken = createToken({ role: 'account', userId: user.id, username: user.username });

    return res.status(201).json({
      accountToken,
      user: { username: user.username, defaultProfile: user.default_profile || user.defaultProfile }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to create account' });
  }
});

app.post('/api/auth/login', apiRateLimit(20, 60_000), async (req, res) => {
  try {
    const username = cleanUsername(req.body?.username);
    const password = cleanPassword(req.body?.password);

    if (!pool) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const attempted = hashPassword(password, user.salt);
    const expected = user.password_hash || user.passwordHash;

    if (attempted.length !== expected.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!crypto.timingSafeEqual(Buffer.from(attempted), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accountToken = createToken({ role: 'account', userId: user.id, username: user.username });

    return res.json({
      accountToken,
      user: { username: user.username, defaultProfile: user.default_profile || user.defaultProfile }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to sign in' });
  }
});

app.post('/api/rooms', apiRateLimit(25, 60_000), async (req, res) => {
  try {
    const account = verifyAccountToken(req.body?.accountToken);
    if (!account || !pool) {
      return res.status(401).json({ error: 'Host account required' });
    }

    const user = await getUserById(account.userId);
    if (!user) {
      return res.status(401).json({ error: 'Account not found' });
    }

    const mode = getModeOrDefault(req.body?.mode);
    const hostAlias = cleanText(req.body?.hostAlias, 20) || user.username;
    const code = makeRoomCode();
    const hostId = makeId();
    const profile = user.default_profile || user.defaultProfile || validateProfile();

    const room = {
      code,
      hostId,
      status: 'lobby',
      mode,
      players: new Map(),
      questions: shuffleArray(QUESTION_SET).slice(0, mode.questionCount),
      questionIndex: 0,
      roundDurationMs: mode.roundDurationMs,
      roundStartedAt: null,
      roundTimer: null,
      currentChaosMultiplier: 1,
      answers: new Map(),
      currentQuestionViews: new Map(),
      createdAt: Date.now()
    };

    room.players.set(
      hostId,
      makePlayer({
        id: hostId,
        name: hostAlias,
        profile
      })
    );

    rooms.set(code, room);

    const gameToken = createToken({ roomCode: code, playerId: hostId, role: 'host' });

    return res.status(201).json({
      roomCode: code,
      playerId: hostId,
      token: gameToken,
      room: roomPublicState(room)
    });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to create room' });
  }
});

app.post('/api/rooms/:code/join', apiRateLimit(30, 60_000), (req, res) => {
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
  room.players.set(
    playerId,
    makePlayer({
      id: playerId,
      name,
      profile: validateProfile(req.body?.profile)
    })
  );

  const token = createToken({ roomCode, playerId, role: 'player' });

  broadcastRoom(roomCode, { type: 'room_update', room: roomPublicState(room) });
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
  broadcastRoom(roomCode, { type: 'room_update', room: roomPublicState(room) });
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

  if (isRateLimited(wsBuckets, ip, 100, 60_000)) {
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

    const roomPlayerKey = `${authedRoomCode}:${authedPlayerId}`;
    if (isRateLimited(wsBuckets, roomPlayerKey, 42, 10_000)) {
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

      const qView = room.currentQuestionViews.get(authedPlayerId);
      const q = room.questions[room.questionIndex];
      if (!qView || !q) return;

      const answerIndex = Number(msg.answerIndex);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= qView.options.length) {
        player.strikes += 1;
        return;
      }

      const elapsedMs = Date.now() - room.roundStartedAt;
      if (elapsedMs < 250) {
        player.strikes += 1;
        return;
      }

      const chosenOriginalIndex = qView.map[answerIndex];
      const correct = chosenOriginalIndex === q.answerIndex;

      if (correct) {
        player.streak += 1;
      } else {
        player.streak = 0;
      }

      const points = computePoints({
        room,
        correct,
        elapsedMs,
        difficulty: q.difficulty,
        streak: player.streak,
        usedPowerup: player.usedPowerup
      });

      player.score += points;
      player.usedPowerup = null;

      room.answers.set(authedPlayerId, {
        answerIndex,
        originalIndex: chosenOriginalIndex,
        correct,
        elapsedMs,
        points
      });

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

async function bootstrap() {
  server.listen(PORT, () => {
    console.log(`Quizzy running on port ${PORT}`);
    if (!pool) {
      console.log('Warning: DATABASE_URL is not set, so accounts are disabled until Postgres is configured.');
      return;
    }

    initDatabaseWithRetry().catch((error) => {
      console.error('Unexpected database retry error:', error);
    });
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start Quizzy:', error);
  process.exit(1);
});
