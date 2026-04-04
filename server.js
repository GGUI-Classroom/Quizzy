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

app.use(express.json({ limit: '128kb' }));
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

app.use('/api', apiRateLimit(120, 60_000));

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

async function dbQuery(text, params) {
  if (!pool) {
    throw new Error('DATABASE_URL is required for persistent accounts and sets');
  }
  return pool.query(text, params);
}

async function initDatabase() {
  if (!pool) return;

  await dbQuery(
    `CREATE TABLE IF NOT EXISTS quizzy_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      default_profile JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`
  );

  await dbQuery(
    `CREATE TABLE IF NOT EXISTS quizzy_sets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES quizzy_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      plays_count INT NOT NULL DEFAULT 0,
      favorite_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`
  );

  await dbQuery('ALTER TABLE quizzy_sets ADD COLUMN IF NOT EXISTS plays_count INT NOT NULL DEFAULT 0;');
  await dbQuery('ALTER TABLE quizzy_sets ADD COLUMN IF NOT EXISTS favorite_count INT NOT NULL DEFAULT 0;');

  await dbQuery(
    `CREATE TABLE IF NOT EXISTS quizzy_questions (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES quizzy_sets(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      options JSONB NOT NULL,
      answer_index INT NOT NULL,
      difficulty INT NOT NULL DEFAULT 1,
      position INT NOT NULL DEFAULT 0
    );`
  );

  await dbQuery(
    `CREATE TABLE IF NOT EXISTS quizzy_set_favorites (
      user_id TEXT NOT NULL REFERENCES quizzy_users(id) ON DELETE CASCADE,
      set_id TEXT NOT NULL REFERENCES quizzy_sets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, set_id)
    );`
  );

  await dbQuery(
    `CREATE TABLE IF NOT EXISTS quizzy_game_history (
      id TEXT PRIMARY KEY,
      host_user_id TEXT NOT NULL REFERENCES quizzy_users(id) ON DELETE CASCADE,
      room_code TEXT NOT NULL,
      set_id TEXT NOT NULL,
      set_title TEXT NOT NULL,
      mode_id TEXT NOT NULL,
      winner_name TEXT NOT NULL,
      players_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`
  );

  await dbQuery('CREATE INDEX IF NOT EXISTS idx_quizzy_sets_user ON quizzy_sets(user_id);');
  await dbQuery('CREATE INDEX IF NOT EXISTS idx_quizzy_questions_set ON quizzy_questions(set_id, position);');
  await dbQuery('CREATE INDEX IF NOT EXISTS idx_quizzy_favorites_user ON quizzy_set_favorites(user_id);');
  await dbQuery('CREATE INDEX IF NOT EXISTS idx_quizzy_history_host ON quizzy_game_history(host_user_id, created_at DESC);');
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

  console.error('Database is not ready after retries; API features that require DB will fail until DB is available.');
}

async function getUserByUsername(username) {
  const result = await dbQuery('SELECT * FROM quizzy_users WHERE username = $1 LIMIT 1', [username]);
  return result.rows[0] || null;
}

async function getUserById(userId) {
  const result = await dbQuery('SELECT * FROM quizzy_users WHERE id = $1 LIMIT 1', [userId]);
  return result.rows[0] || null;
}

function readAccountToken(req) {
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const headerToken = String(req.headers['x-account-token'] || '');
  const bodyToken = typeof req.body?.accountToken === 'string' ? req.body.accountToken : '';
  const queryToken = typeof req.query?.accountToken === 'string' ? req.query.accountToken : '';
  return bodyToken || headerToken || bearer || queryToken;
}

async function requireAccount(req) {
  if (!pool) return null;
  const token = readAccountToken(req);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'account' || typeof payload.userId !== 'string') return null;
  return getUserById(payload.userId);
}

const PROFILE_OPTIONS = {
  avatars: ['fox', 'owl', 'panda', 'rocket', 'wizard', 'cat'],
  frames: ['neon', 'frost', 'ember', 'pixel'],
  titles: ['Rookie', 'Tactician', 'Speedster', 'Brainiac', 'MemeLord'],
  colors: ['cyan', 'gold', 'mint', 'coral', 'violet']
};

const GAME_MODES = {
  classic: {
    id: 'classic',
    name: 'Classic Quiz',
    questionCount: 10,
    roundDurationMs: 11_000,
    leaderboardMetric: 'score'
  },
  gold_rush: {
    id: 'gold_rush',
    name: 'Gold Rush',
    questionCount: 10,
    roundDurationMs: 10_000,
    leaderboardMetric: 'gold'
  },
  crypto_hack: {
    id: 'crypto_hack',
    name: 'Crypto Hack',
    questionCount: 10,
    roundDurationMs: 10_000,
    leaderboardMetric: 'crypto'
  },
  factory_frenzy: {
    id: 'factory_frenzy',
    name: 'Factory Frenzy',
    questionCount: 10,
    roundDurationMs: 10_500,
    leaderboardMetric: 'factoryPower'
  }
};

function getModeOrDefault(modeId) {
  const clean = cleanText(modeId || '', 18).toLowerCase();
  return GAME_MODES[clean] || GAME_MODES.classic;
}

function validateProfile(raw) {
  const avatar = cleanText(raw?.avatar || '', 16);
  const frame = cleanText(raw?.frame || '', 16);
  const title = cleanText(raw?.title || '', 20);
  const color = cleanText(raw?.color || '', 16);

  return {
    avatar: PROFILE_OPTIONS.avatars.includes(avatar) ? avatar : 'fox',
    frame: PROFILE_OPTIONS.frames.includes(frame) ? frame : 'neon',
    title: PROFILE_OPTIONS.titles.includes(title) ? title : 'Rookie',
    color: PROFILE_OPTIONS.colors.includes(color) ? color : 'cyan'
  };
}

const makeRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const makeId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const rooms = new Map();
const wsClients = new Map();

function makePlayer({ id, name, profile }) {
  return {
    id,
    name,
    profile: validateProfile(profile),
    score: 0,
    streak: 0,
    strikes: 0,
    usedPowerup: null,
    gold: 0,
    crypto: 0,
    factoryPower: 0,
    factoryLevel: 0
  };
}

function leaderboardValue(player, metric) {
  if (metric === 'gold') return player.gold;
  if (metric === 'crypto') return player.crypto;
  if (metric === 'factoryPower') return player.factoryPower;
  return player.score;
}

function sortLeaderboard(room) {
  const metric = room.mode.leaderboardMetric;
  return [...room.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      profile: p.profile,
      score: p.score,
      gold: p.gold,
      crypto: p.crypto,
      factoryPower: p.factoryPower,
      streak: p.streak,
      value: leaderboardValue(p, metric)
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 30);
}

function roomPublicState(room) {
  return {
    code: room.code,
    setTitle: room.setTitle,
    hostAlias: room.hostAlias,
    status: room.status,
    mode: { id: room.mode.id, name: room.mode.name, metric: room.mode.leaderboardMetric },
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length,
    leaderboard: sortLeaderboard(room),
    playerCount: room.players.size,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, profile: p.profile }))
  };
}

async function persistGameHistory(room, winnerName) {
  if (!pool || !room?.hostUserId) return;

  try {
    await dbQuery(
      `INSERT INTO quizzy_game_history (id, host_user_id, room_code, set_id, set_title, mode_id, winner_name, players_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        makeId(),
        room.hostUserId,
        room.code,
        room.setId,
        room.setTitle,
        room.mode.id,
        winnerName || 'No winner',
        room.players.size
      ]
    );
  } catch {
    // Ignore history write failures to avoid impacting active gameplay.
  }
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

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

function baseAward(room, question, elapsedMs, streak) {
  const speedFactor = Math.max(0.35, 1 - elapsedMs / room.roundDurationMs);
  return Math.floor((420 + question.difficulty * 150) * speedFactor + Math.min(220, streak * 25));
}

function applyModeAward(room, player, amount) {
  if (room.mode.id === 'gold_rush') {
    player.gold += Math.floor(amount * 0.9);
    if (Math.random() < 0.15) {
      player.gold += 120;
    }
    return { stat: 'gold', value: player.gold };
  }

  if (room.mode.id === 'crypto_hack') {
    const mult = room.marketMultiplier || 1;
    player.crypto += Math.floor(amount * mult);
    return { stat: 'crypto', value: player.crypto, mult };
  }

  if (room.mode.id === 'factory_frenzy') {
    player.factoryLevel = Math.min(10, player.factoryLevel + 1);
    player.factoryPower += amount + player.factoryLevel * 35;
    return { stat: 'factoryPower', value: player.factoryPower, factoryLevel: player.factoryLevel };
  }

  player.score += amount;
  return { stat: 'score', value: player.score };
}

function applyRoundPassive(room) {
  if (room.mode.id !== 'factory_frenzy') return;
  for (const player of room.players.values()) {
    player.factoryPower += player.factoryLevel * 25;
  }
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
    const winner = sortLeaderboard(room)[0] || null;

    broadcastRoom(roomCode, {
      type: 'game_over',
      room: roomPublicState(room),
      winner
    });

    persistGameHistory(room, winner?.name).catch(() => {});
    return;
  }

  room.answers.clear();
  room.roundStartedAt = Date.now();
  room.marketMultiplier = room.mode.id === 'crypto_hack' ? Number((0.7 + Math.random() * 1.4).toFixed(2)) : 1;

  const question = room.questions[room.questionIndex];

  for (const player of room.players.values()) {
    const qView = generateQuestionForPlayer(question);
    room.currentQuestionViews.set(player.id, qView);

    sendToPlayer(player.id, {
      type: 'question',
      questionIndex: room.questionIndex,
      totalQuestions: room.questions.length,
      modeName: room.mode.name,
      marketMultiplier: room.marketMultiplier,
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

  applyRoundPassive(room);

  broadcastRoom(roomCode, {
    type: 'answer_reveal',
    correctAnswer: question.options[question.answerIndex],
    leaderboard: sortLeaderboard(room)
  });

  room.questionIndex += 1;
  room.currentQuestionViews.clear();

  setTimeout(() => startQuestion(roomCode), 2200);
}

function removePlayer(room, playerId) {
  room.players.delete(playerId);
  room.answers.delete(playerId);
  room.currentQuestionViews.delete(playerId);

  if (room.players.size === 0 && room.status !== 'lobby') {
    room.status = 'finished';
  }

  if (room.players.size === 0 && Date.now() - room.createdAt > 10_000) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    rooms.delete(room.code);
    return;
  }

  broadcastRoom(room.code, { type: 'room_update', room: roomPublicState(room) });
}

async function getSetWithQuestions(setId, userId) {
  const setRes = await dbQuery('SELECT * FROM quizzy_sets WHERE id = $1 AND user_id = $2 LIMIT 1', [setId, userId]);
  const quizSet = setRes.rows[0];
  if (!quizSet) return null;

  const questionsRes = await dbQuery('SELECT * FROM quizzy_questions WHERE set_id = $1 ORDER BY position ASC', [setId]);

  const questions = questionsRes.rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    options: Array.isArray(row.options) ? row.options : [],
    answerIndex: Number(row.answer_index),
    difficulty: Number(row.difficulty || 1)
  }));

  return {
    id: quizSet.id,
    title: quizSet.title,
    description: quizSet.description,
    questions
  };
}

app.get('/api/meta/options', apiRateLimit(80, 60_000), (req, res) => {
  return res.json({
    profileOptions: PROFILE_OPTIONS,
    modes: Object.values(GAME_MODES).map((m) => ({ id: m.id, name: m.name }))
  });
});

app.post('/api/auth/register', apiRateLimit(20, 60_000), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });

    const username = cleanUsername(req.body?.username);
    const password = cleanPassword(req.body?.password);
    if (username.length < 3 || password.length < 8) {
      return res.status(400).json({ error: 'Username must be 3+ chars and password 8+ chars' });
    }

    const existing = await getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const id = makeId();
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const defaultProfile = validateProfile(req.body?.defaultProfile);

    await dbQuery(
      'INSERT INTO quizzy_users (id, username, salt, password_hash, default_profile) VALUES ($1, $2, $3, $4, $5)',
      [id, username, salt, passwordHash, JSON.stringify(defaultProfile)]
    );

    const accountToken = createToken({ role: 'account', userId: id, username });

    return res.status(201).json({
      accountToken,
      user: { username, defaultProfile }
    });
  } catch {
    return res.status(500).json({ error: 'Unable to create account' });
  }
});

app.post('/api/auth/login', apiRateLimit(25, 60_000), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });

    const username = cleanUsername(req.body?.username);
    const password = cleanPassword(req.body?.password);

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const attempted = hashPassword(password, user.salt);
    const expected = user.password_hash;

    if (attempted.length !== expected.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!crypto.timingSafeEqual(Buffer.from(attempted), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accountToken = createToken({ role: 'account', userId: user.id, username: user.username });

    return res.json({
      accountToken,
      user: { username: user.username, defaultProfile: user.default_profile }
    });
  } catch {
    return res.status(500).json({ error: 'Unable to sign in' });
  }
});

app.get('/api/sets', apiRateLimit(80, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const result = await dbQuery(
      `SELECT s.id, s.title, s.description, s.created_at, s.updated_at,
              s.plays_count, s.favorite_count,
              COUNT(q.id) AS question_count,
              EXISTS(
                SELECT 1 FROM quizzy_set_favorites f
                WHERE f.user_id = $1 AND f.set_id = s.id
              ) AS is_favorite
       FROM quizzy_sets s
       LEFT JOIN quizzy_questions q ON q.set_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id
       ORDER BY s.updated_at DESC`,
      [user.id]
    );

    return res.json({ sets: result.rows });
  } catch {
    return res.status(500).json({ error: 'Unable to load sets' });
  }
});

app.get('/api/sets/discover', apiRateLimit(90, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const result = await dbQuery(
      `SELECT s.id, s.title, s.description, s.created_at, s.updated_at,
              s.plays_count, s.favorite_count,
              u.username AS owner_name,
              COUNT(q.id) AS question_count,
              EXISTS(
                SELECT 1 FROM quizzy_set_favorites f
                WHERE f.user_id = $1 AND f.set_id = s.id
              ) AS is_favorite
       FROM quizzy_sets s
       JOIN quizzy_users u ON u.id = s.user_id
       LEFT JOIN quizzy_questions q ON q.set_id = s.id
       GROUP BY s.id, u.username
       ORDER BY s.plays_count DESC, s.favorite_count DESC, s.updated_at DESC
       LIMIT 36`,
      [user.id]
    );

    return res.json({ sets: result.rows });
  } catch {
    return res.status(500).json({ error: 'Unable to load discover sets' });
  }
});

app.get('/api/sets/favorites', apiRateLimit(90, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const result = await dbQuery(
      `SELECT s.id, s.title, s.description, s.created_at, s.updated_at,
              s.plays_count, s.favorite_count,
              u.username AS owner_name,
              COUNT(q.id) AS question_count,
              TRUE AS is_favorite
       FROM quizzy_set_favorites f
       JOIN quizzy_sets s ON s.id = f.set_id
       JOIN quizzy_users u ON u.id = s.user_id
       LEFT JOIN quizzy_questions q ON q.set_id = s.id
       WHERE f.user_id = $1
       GROUP BY s.id, u.username, f.created_at
       ORDER BY f.created_at DESC
       LIMIT 36`,
      [user.id]
    );

    return res.json({ sets: result.rows });
  } catch {
    return res.status(500).json({ error: 'Unable to load favorite sets' });
  }
});

app.post('/api/sets/:id/favorite', apiRateLimit(90, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const setId = cleanText(req.params.id, 16);
    const setExists = await dbQuery('SELECT id FROM quizzy_sets WHERE id = $1 LIMIT 1', [setId]);
    if (!setExists.rows[0]) return res.status(404).json({ error: 'Set not found' });

    const favRes = await dbQuery('SELECT 1 FROM quizzy_set_favorites WHERE user_id = $1 AND set_id = $2 LIMIT 1', [
      user.id,
      setId
    ]);

    if (favRes.rows[0]) {
      await dbQuery('DELETE FROM quizzy_set_favorites WHERE user_id = $1 AND set_id = $2', [user.id, setId]);
      await dbQuery('UPDATE quizzy_sets SET favorite_count = GREATEST(0, favorite_count - 1) WHERE id = $1', [setId]);
      return res.json({ isFavorite: false });
    }

    await dbQuery('INSERT INTO quizzy_set_favorites (user_id, set_id) VALUES ($1, $2)', [user.id, setId]);
    await dbQuery('UPDATE quizzy_sets SET favorite_count = favorite_count + 1 WHERE id = $1', [setId]);
    return res.json({ isFavorite: true });
  } catch {
    return res.status(500).json({ error: 'Unable to update favorite' });
  }
});

app.post('/api/sets/:id/clone', apiRateLimit(60, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const sourceId = cleanText(req.params.id, 16);
    const sourceSetRes = await dbQuery('SELECT * FROM quizzy_sets WHERE id = $1 LIMIT 1', [sourceId]);
    const sourceSet = sourceSetRes.rows[0];
    if (!sourceSet) return res.status(404).json({ error: 'Source set not found' });

    const sourceQuestionsRes = await dbQuery('SELECT * FROM quizzy_questions WHERE set_id = $1 ORDER BY position ASC', [sourceId]);
    if (!sourceQuestionsRes.rows.length) {
      return res.status(400).json({ error: 'Cannot clone empty set' });
    }

    const clonedSetId = makeId();
    const clonedTitle = `${sourceSet.title} Copy`;

    await dbQuery('INSERT INTO quizzy_sets (id, user_id, title, description) VALUES ($1, $2, $3, $4)', [
      clonedSetId,
      user.id,
      clonedTitle,
      sourceSet.description
    ]);

    for (const row of sourceQuestionsRes.rows) {
      await dbQuery(
        'INSERT INTO quizzy_questions (id, set_id, prompt, options, answer_index, difficulty, position) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [makeId(), clonedSetId, row.prompt, JSON.stringify(row.options), row.answer_index, row.difficulty, row.position]
      );
    }

    return res.status(201).json({ clonedSetId });
  } catch {
    return res.status(500).json({ error: 'Unable to clone set' });
  }
});

app.get('/api/history', apiRateLimit(100, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const result = await dbQuery(
      `SELECT id, room_code, set_id, set_title, mode_id, winner_name, players_count, created_at
       FROM quizzy_game_history
       WHERE host_user_id = $1
       ORDER BY created_at DESC
       LIMIT 80`,
      [user.id]
    );

    return res.json({ history: result.rows });
  } catch {
    return res.status(500).json({ error: 'Unable to load history' });
  }
});

app.post('/api/sets', apiRateLimit(40, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Account required' });

    const title = cleanText(req.body?.title, 80);
    const description = cleanText(req.body?.description || '', 180);
    const incomingQuestions = Array.isArray(req.body?.questions) ? req.body.questions : [];

    if (!title) {
      return res.status(400).json({ error: 'Set title is required' });
    }

    if (incomingQuestions.length < 1 || incomingQuestions.length > 120) {
      return res.status(400).json({ error: 'Set must contain 1-120 questions' });
    }

    const preparedQuestions = [];
    for (let i = 0; i < incomingQuestions.length; i += 1) {
      const q = incomingQuestions[i];
      const prompt = cleanText(q?.prompt, 180);
      const rawOptions = Array.isArray(q?.options) ? q.options : [];
      const options = rawOptions.map((o) => cleanText(o, 80)).filter(Boolean).slice(0, 4);
      const answerIndex = Number(q?.answerIndex);
      const difficulty = Math.max(1, Math.min(3, Number(q?.difficulty || 1)));

      if (!prompt || options.length !== 4 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
        return res.status(400).json({ error: `Invalid question format at index ${i + 1}` });
      }

      preparedQuestions.push({
        id: makeId(),
        prompt,
        options,
        answerIndex,
        difficulty,
        position: i
      });
    }

    const setId = makeId();
    await dbQuery(
      'INSERT INTO quizzy_sets (id, user_id, title, description) VALUES ($1, $2, $3, $4)',
      [setId, user.id, title, description]
    );

    for (const q of preparedQuestions) {
      await dbQuery(
        'INSERT INTO quizzy_questions (id, set_id, prompt, options, answer_index, difficulty, position) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [q.id, setId, q.prompt, JSON.stringify(q.options), q.answerIndex, q.difficulty, q.position]
      );
    }

    return res.status(201).json({
      set: {
        id: setId,
        title,
        description,
        question_count: preparedQuestions.length
      }
    });
  } catch {
    return res.status(500).json({ error: 'Unable to create set' });
  }
});

app.post('/api/rooms', apiRateLimit(35, 60_000), async (req, res) => {
  try {
    const user = await requireAccount(req);
    if (!user) return res.status(401).json({ error: 'Host account required' });

    const setId = cleanText(req.body?.setId, 16);
    if (!setId) {
      return res.status(400).json({ error: 'setId is required' });
    }

    const mode = getModeOrDefault(req.body?.mode);
    const hostAlias = cleanText(req.body?.hostAlias, 20) || user.username;

    const quizSet = await getSetWithQuestions(setId, user.id);
    if (!quizSet) {
      return res.status(404).json({ error: 'Set not found' });
    }

    if (quizSet.questions.length < 1) {
      return res.status(400).json({ error: 'Set has no questions' });
    }

    const roomCode = makeRoomCode();
    const room = {
      code: roomCode,
      hostUserId: user.id,
      hostAlias,
      hostToken: createToken({ role: 'host-control', roomCode, userId: user.id }),
      status: 'lobby',
      mode,
      setId: quizSet.id,
      setTitle: quizSet.title,
      players: new Map(),
      questions: shuffleArray(quizSet.questions).slice(0, mode.questionCount),
      questionIndex: 0,
      roundDurationMs: mode.roundDurationMs,
      roundStartedAt: null,
      roundTimer: null,
      marketMultiplier: 1,
      answers: new Map(),
      currentQuestionViews: new Map(),
      createdAt: Date.now()
    };

    rooms.set(roomCode, room);

    await dbQuery('UPDATE quizzy_sets SET plays_count = plays_count + 1, updated_at = NOW() WHERE id = $1', [quizSet.id]);

    return res.status(201).json({
      roomCode,
      hostToken: room.hostToken,
      room: roomPublicState(room)
    });
  } catch {
    return res.status(500).json({ error: 'Unable to create room' });
  }
});

app.post('/api/rooms/:code/start', apiRateLimit(30, 60_000), (req, res) => {
  const roomCode = cleanText(req.params.code, 6).toUpperCase();
  const hostToken = typeof req.body?.hostToken === 'string' ? req.body.hostToken : '';

  const payload = verifyToken(hostToken);
  if (!payload || payload.role !== 'host-control' || payload.roomCode !== roomCode) {
    return res.status(403).json({ error: 'Invalid host token' });
  }

  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.hostUserId !== payload.userId) {
    return res.status(403).json({ error: 'Host mismatch' });
  }

  if (room.status !== 'lobby') {
    return res.status(400).json({ error: 'Game already active' });
  }

  if (room.players.size < 1) {
    return res.status(400).json({ error: 'At least one player must join first' });
  }

  room.status = 'active';
  broadcastRoom(roomCode, { type: 'room_update', room: roomPublicState(room) });
  setTimeout(() => startQuestion(roomCode), 1000);

  return res.json({ ok: true });
});

app.get('/api/rooms/:code', apiRateLimit(80, 60_000), (req, res) => {
  const roomCode = cleanText(req.params.code, 6).toUpperCase();
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const hostToken = typeof req.query?.hostToken === 'string' ? req.query.hostToken : '';
  const hostPayload = verifyToken(hostToken);

  const response = { room: roomPublicState(room) };
  if (hostPayload && hostPayload.role === 'host-control' && hostPayload.roomCode === roomCode) {
    response.host = true;
  }

  return res.json(response);
});

app.post('/api/rooms/:code/join', apiRateLimit(50, 60_000), (req, res) => {
  const roomCode = cleanText(req.params.code, 6).toUpperCase();
  const name = cleanText(req.body?.name, 20);

  if (!name) {
    return res.status(400).json({ error: 'Player name is required' });
  }

  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== 'lobby') {
    return res.status(400).json({ error: 'Game already started' });
  }

  if (room.players.size >= 100) {
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

  const token = createToken({ role: 'player', roomCode, playerId });

  broadcastRoom(roomCode, { type: 'room_update', room: roomPublicState(room) });

  return res.json({
    playerId,
    token,
    room: roomPublicState(room)
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/sets/new', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sets-new.html'));
});
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});
app.get('/discover', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'discover.html'));
});
app.get('/favorites', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favorites.html'));
});
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});
app.get('/play/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || 'unknown').toString();

  if (isRateLimited(wsBuckets, ip, 120, 60_000)) {
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
    if (raw.length > 4096) {
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
      if (!payload || payload.role !== 'player') {
        ws.close(1008, 'Invalid player token');
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
    if (isRateLimited(wsBuckets, roomPlayerKey, 50, 10_000)) {
      player.strikes += 1;
      if (player.strikes >= 5) ws.close(1008, 'Too many suspicious requests');
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
      const question = room.questions[room.questionIndex];
      if (!qView || !question) return;

      const answerIndex = Number(msg.answerIndex);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= qView.options.length) {
        player.strikes += 1;
        return;
      }

      const elapsedMs = Date.now() - room.roundStartedAt;
      if (elapsedMs < 240) {
        player.strikes += 1;
        return;
      }

      const chosenOriginalIndex = qView.map[answerIndex];
      const correct = chosenOriginalIndex === question.answerIndex;

      if (correct) {
        player.streak += 1;
      } else {
        player.streak = 0;
      }

      let gain = 0;
      let modeData = null;

      if (correct) {
        gain = baseAward(room, question, elapsedMs, player.streak);
        if (player.usedPowerup === 'double') {
          gain = Math.floor(gain * 1.8);
        }
        modeData = applyModeAward(room, player, gain);
      }

      if (!correct && room.mode.id === 'crypto_hack') {
        player.crypto = Math.max(0, player.crypto - 35);
      }

      if (!correct && room.mode.id === 'gold_rush') {
        player.gold = Math.max(0, player.gold - 25);
      }

      room.answers.set(authedPlayerId, {
        answerIndex,
        originalIndex: chosenOriginalIndex,
        correct,
        elapsedMs,
        gain
      });

      player.usedPowerup = null;

      sendToPlayer(authedPlayerId, {
        type: 'answer_result',
        correct,
        gain,
        elapsedMs,
        streak: player.streak,
        modeData
      });

      if (room.answers.size >= room.players.size) {
        finalizeQuestion(room.code);
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!authedPlayerId || !authedRoomCode) return;
    wsClients.delete(authedPlayerId);

    const room = rooms.get(authedRoomCode);
    if (!room) return;

    removePlayer(room, authedPlayerId);
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
      console.log('Warning: DATABASE_URL is not set, so account and set features are disabled until Postgres is configured.');
      return;
    }

    initDatabaseWithRetry().catch((error) => {
      console.error('Unexpected database init error:', error);
    });
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start Quizzy:', error);
  process.exit(1);
});
