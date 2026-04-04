const AVATAR_EMOJI = {
  fox: '🦊',
  owl: '🦉',
  panda: '🐼',
  rocket: '🚀',
  wizard: '🧙',
  cat: '🐱'
};

const state = {
  roomCode: null,
  playerId: null,
  token: null,
  isHost: false,
  room: null,
  ws: null,
  timerInterval: null,
  questionLocked: false,
  powerupActive: false,
  accountToken: localStorage.getItem('quizzyAccountToken') || null,
  accountName: localStorage.getItem('quizzyAccountName') || null,
  options: {
    profileOptions: {
      avatars: ['fox'],
      frames: ['neon'],
      titles: ['Rookie'],
      colors: ['cyan']
    },
    modes: [{ id: 'classic', name: 'Classic Clash' }]
  }
};

const views = {
  home: document.getElementById('homeView'),
  auth: document.getElementById('authView'),
  dashboard: document.getElementById('dashboardView'),
  lobby: document.getElementById('lobbyView'),
  game: document.getElementById('gameView'),
  result: document.getElementById('resultView')
};

const registerForm = document.getElementById('registerForm');
const loginForm = document.getElementById('loginForm');
const hostForm = document.getElementById('hostForm');
const joinForm = document.getElementById('joinForm');

const openJoinBtn = document.getElementById('openJoinBtn');
const openAuthBtn = document.getElementById('openAuthBtn');
const openDashboardBtn = document.getElementById('openDashboardBtn');
const brandHomeBtn = document.getElementById('brandHomeBtn');
const heroSignupBtn = document.getElementById('heroSignupBtn');
const heroJoinBtn = document.getElementById('heroJoinBtn');
const closeAuthBtn = document.getElementById('closeAuthBtn');

const startBtn = document.getElementById('startBtn');
const leaveBtn = document.getElementById('leaveBtn');
const backBtn = document.getElementById('backBtn');
const logoutBtn = document.getElementById('logoutBtn');

const roomCodeText = document.getElementById('roomCodeText');
const modeText = document.getElementById('modeText');
const modeBadge = document.getElementById('modeBadge');
const hostStatus = document.getElementById('hostStatus');
const playerList = document.getElementById('playerList');

const qTitle = document.getElementById('qTitle');
const qPrompt = document.getElementById('qPrompt');
const optionsWrap = document.getElementById('options');
const timerEl = document.getElementById('timer');
const chaosHint = document.getElementById('chaosHint');
const feedback = document.getElementById('roundFeedback');
const doubleBtn = document.getElementById('doubleBtn');

const leaderboardEl = document.getElementById('leaderboard');
const winnerText = document.getElementById('winnerText');
const toast = document.getElementById('toast');

const accountNameText = document.getElementById('accountNameText');
const dashboardGreeting = document.getElementById('dashboardGreeting');
const modeCount = document.getElementById('modeCount');

const avatarSelect = document.getElementById('avatarSelect');
const frameSelect = document.getElementById('frameSelect');
const titleSelect = document.getElementById('titleSelect');
const colorSelect = document.getElementById('colorSelect');
const modeSelect = document.getElementById('modeSelect');

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
    el.classList.toggle('visible', key === name);
  });
}

function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), ms);
}

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function fillSelect(select, values, labelFn) {
  select.innerHTML = '';
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = typeof value === 'string' ? value : value.id;
    option.textContent = labelFn ? labelFn(value) : value;
    select.appendChild(option);
  });
}

async function loadOptions() {
  const meta = await api('/api/meta/options');
  state.options = meta;

  fillSelect(avatarSelect, meta.profileOptions.avatars, (v) => `${AVATAR_EMOJI[v] || ''} ${v}`);
  fillSelect(frameSelect, meta.profileOptions.frames);
  fillSelect(titleSelect, meta.profileOptions.titles);
  fillSelect(colorSelect, meta.profileOptions.colors);
  fillSelect(modeSelect, meta.modes, (m) => m.name);

  modeSelect.value = 'classic';
  modeCount.textContent = String(meta.modes.length);
}

function updateTopbarAuth() {
  const signedIn = Boolean(state.accountToken && state.accountName);
  openAuthBtn.classList.toggle('hidden', signedIn);
  openDashboardBtn.classList.toggle('hidden', !signedIn);

  if (signedIn) {
    openDashboardBtn.textContent = 'Dashboard';
  }
}

function updateDashboardHeader() {
  const name = state.accountName || 'Guest';
  accountNameText.textContent = name;
  dashboardGreeting.textContent = `Signed in as ${name}`;
}

function applyAuth(accountToken, username) {
  state.accountToken = accountToken;
  state.accountName = username;
  localStorage.setItem('quizzyAccountToken', accountToken);
  localStorage.setItem('quizzyAccountName', username);

  updateTopbarAuth();
  updateDashboardHeader();
  showView('dashboard');
}

function clearAuth() {
  state.accountToken = null;
  state.accountName = null;
  localStorage.removeItem('quizzyAccountToken');
  localStorage.removeItem('quizzyAccountName');

  updateTopbarAuth();
  updateDashboardHeader();
}

function formatPlayer(p) {
  const avatar = AVATAR_EMOJI[p.profile?.avatar] || '🎯';
  const title = p.profile?.title || 'Rookie';
  const frame = p.profile?.frame || 'neon';
  const me = p.id === state.playerId ? ' (You)' : '';
  return `${avatar} ${p.name}${me} - ${title} / ${frame}`;
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${protocol}://${location.host}/ws`);

  state.ws.addEventListener('open', () => {
    state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
  });

  state.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  });

  state.ws.addEventListener('close', () => {
    if (state.roomCode) {
      showToast('Disconnected from server');
    }
  });
}

function updateLobby(room) {
  state.room = room;
  roomCodeText.textContent = room.code;
  modeText.textContent = room.mode?.name || 'Classic Clash';
  playerList.innerHTML = '';

  room.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = formatPlayer(p);
    playerList.appendChild(li);
  });

  hostStatus.textContent = room.status === 'lobby' ? 'Waiting for players...' : 'Match in progress';
  startBtn.classList.toggle('hidden', !(state.isHost && room.status === 'lobby'));
}

function renderQuestion(payload) {
  state.questionLocked = false;
  feedback.textContent = '';
  modeBadge.textContent = payload.modeName;
  qTitle.textContent = `Question ${payload.questionIndex + 1} of ${payload.totalQuestions}`;
  qPrompt.textContent = payload.question.prompt;

  chaosHint.textContent = payload.chaosMultiplier > 1
    ? `Chaos jackpot active: ${payload.chaosMultiplier.toFixed(1)}x points this round`
    : '';

  optionsWrap.innerHTML = '';

  payload.question.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.onclick = () => submitAnswer(idx);
    optionsWrap.appendChild(btn);
  });

  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    const ms = Math.max(0, payload.endsAt - Date.now());
    timerEl.textContent = `${(ms / 1000).toFixed(1)}s`;

    if (ms <= 0) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }, 100);

  showView('game');
}

function submitAnswer(answerIndex) {
  if (state.questionLocked || !state.ws) return;

  state.questionLocked = true;
  document.querySelectorAll('.option-btn').forEach((btn) => {
    btn.disabled = true;
  });

  state.ws.send(JSON.stringify({ type: 'answer', answerIndex }));
}

function renderLeaderboard(list) {
  leaderboardEl.innerHTML = '';
  list.forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = `${formatPlayer(entry)} - ${entry.score} pts`;
    leaderboardEl.appendChild(li);
  });
}

function handleMessage(msg) {
  if (msg.type === 'room_update') {
    updateLobby(msg.room);
    if (msg.room.status === 'lobby') {
      showView('lobby');
    }
  }

  if (msg.type === 'question') {
    renderQuestion(msg);
  }

  if (msg.type === 'answer_result') {
    feedback.textContent = `${msg.correct ? 'Correct' : 'Wrong'} | +${msg.points} pts | ${msg.elapsedMs}ms`;
  }

  if (msg.type === 'answer_reveal') {
    renderLeaderboard(msg.leaderboard);
    showToast(`Correct answer: ${msg.correctAnswer}`);
  }

  if (msg.type === 'powerup_status') {
    state.powerupActive = true;
    doubleBtn.disabled = true;
    doubleBtn.textContent = '2x Armed';
  }

  if (msg.type === 'host_promoted') {
    state.isHost = true;
    showToast('You are now host');
    startBtn.classList.remove('hidden');
  }

  if (msg.type === 'game_over') {
    renderLeaderboard(msg.room.leaderboard);
    winnerText.textContent = msg.winner
      ? `Winner: ${msg.winner.name} with ${msg.winner.score} points`
      : 'No winner this round';
    showView('result');
  }
}

function resetGameState() {
  if (state.ws) state.ws.close();
  if (state.timerInterval) clearInterval(state.timerInterval);

  state.roomCode = null;
  state.playerId = null;
  state.token = null;
  state.isHost = false;
  state.room = null;
  state.ws = null;
  state.timerInterval = null;
  state.questionLocked = false;
  state.powerupActive = false;

  doubleBtn.disabled = false;
  doubleBtn.textContent = 'Activate 2x powerup';
}

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  try {
    const data = await api('/api/auth/register', 'POST', {
      username: document.getElementById('registerUsername').value,
      password: document.getElementById('registerPassword').value
    });

    applyAuth(data.accountToken, data.user.username);
    showToast('Account created');
  } catch (err) {
    showToast(err.message);
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  try {
    const data = await api('/api/auth/login', 'POST', {
      username: document.getElementById('loginUsername').value,
      password: document.getElementById('loginPassword').value
    });

    applyAuth(data.accountToken, data.user.username);
    showToast('Logged in');
  } catch (err) {
    showToast(err.message);
  }
});

hostForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!state.accountToken) {
    showToast('You must login first');
    showView('auth');
    return;
  }

  try {
    const data = await api('/api/rooms', 'POST', {
      accountToken: state.accountToken,
      hostAlias: document.getElementById('hostAlias').value,
      mode: modeSelect.value
    });

    state.roomCode = data.roomCode;
    state.playerId = data.playerId;
    state.token = data.token;
    state.isHost = true;

    updateLobby(data.room);
    showView('lobby');
    connectWs();
  } catch (err) {
    showToast(err.message);
  }
});

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const name = document.getElementById('playerName').value;

  try {
    const data = await api(`/api/rooms/${code}/join`, 'POST', {
      name,
      profile: {
        avatar: avatarSelect.value,
        frame: frameSelect.value,
        title: titleSelect.value,
        color: colorSelect.value
      }
    });

    state.roomCode = code;
    state.playerId = data.playerId;
    state.token = data.token;
    state.isHost = false;

    updateLobby(data.room);
    showView('lobby');
    connectWs();
  } catch (err) {
    showToast(err.message);
  }
});

startBtn.addEventListener('click', async () => {
  try {
    await api(`/api/rooms/${state.roomCode}/start`, 'POST', { token: state.token });
  } catch (err) {
    showToast(err.message);
  }
});

doubleBtn.addEventListener('click', () => {
  if (!state.ws || state.powerupActive) return;
  state.ws.send(JSON.stringify({ type: 'activate_powerup', powerup: 'double' }));
});

leaveBtn.addEventListener('click', () => {
  resetGameState();
  showView(state.accountToken ? 'dashboard' : 'home');
});

backBtn.addEventListener('click', () => {
  resetGameState();
  showView(state.accountToken ? 'dashboard' : 'home');
});

logoutBtn.addEventListener('click', () => {
  clearAuth();
  showToast('Logged out');
  showView('home');
});

openAuthBtn.addEventListener('click', () => {
  showView('auth');
});

openDashboardBtn.addEventListener('click', () => {
  showView('dashboard');
});

openJoinBtn.addEventListener('click', () => {
  showView('dashboard');
  document.getElementById('joinCode').focus();
});

heroSignupBtn.addEventListener('click', () => {
  showView('auth');
  document.getElementById('registerUsername').focus();
});

heroJoinBtn.addEventListener('click', () => {
  showView('dashboard');
  document.getElementById('joinCode').focus();
});

closeAuthBtn.addEventListener('click', () => {
  showView(state.accountToken ? 'dashboard' : 'home');
});

brandHomeBtn.addEventListener('click', (e) => {
  e.preventDefault();
  showView('home');
});

(async function init() {
  updateTopbarAuth();
  updateDashboardHeader();

  try {
    await loadOptions();
  } catch {
    showToast('Failed to load profile and mode options');
  }

  if (state.accountToken) {
    showView('dashboard');
  } else {
    showView('home');
  }
})();
