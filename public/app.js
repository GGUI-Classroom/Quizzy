const state = {
  roomCode: null,
  playerId: null,
  token: null,
  isHost: false,
  room: null,
  ws: null,
  timerInterval: null,
  questionLocked: false,
  powerupActive: false
};

const views = {
  auth: document.getElementById('authView'),
  lobby: document.getElementById('lobbyView'),
  game: document.getElementById('gameView'),
  result: document.getElementById('resultView')
};

const hostForm = document.getElementById('hostForm');
const joinForm = document.getElementById('joinForm');
const startBtn = document.getElementById('startBtn');
const leaveBtn = document.getElementById('leaveBtn');
const backBtn = document.getElementById('backBtn');
const roomCodeText = document.getElementById('roomCodeText');
const playerList = document.getElementById('playerList');
const hostStatus = document.getElementById('hostStatus');
const qTitle = document.getElementById('qTitle');
const qPrompt = document.getElementById('qPrompt');
const optionsWrap = document.getElementById('options');
const timerEl = document.getElementById('timer');
const feedback = document.getElementById('roundFeedback');
const doubleBtn = document.getElementById('doubleBtn');
const leaderboardEl = document.getElementById('leaderboard');
const winnerText = document.getElementById('winnerText');
const toast = document.getElementById('toast');

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
  playerList.innerHTML = '';

  room.players.forEach((p) => {
    const li = document.createElement('li');
    const me = p.id === state.playerId ? ' (You)' : '';
    li.textContent = `${p.name}${me}`;
    playerList.appendChild(li);
  });

  hostStatus.textContent = room.status === 'lobby' ? 'Waiting for players...' : 'Match in progress';
  startBtn.classList.toggle('hidden', !(state.isHost && room.status === 'lobby'));
}

function renderQuestion(payload) {
  state.questionLocked = false;
  feedback.textContent = '';
  qTitle.textContent = `Question ${payload.questionIndex + 1} of ${payload.totalQuestions}`;
  qPrompt.textContent = payload.question.prompt;
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
    li.textContent = `${entry.name} - ${entry.score} pts`;
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

hostForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const hostName = document.getElementById('hostName').value;

  try {
    const data = await api('/api/rooms', 'POST', { hostName });
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
    const data = await api(`/api/rooms/${code}/join`, 'POST', { name });
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

function resetState() {
  if (state.ws) {
    state.ws.close();
  }
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
  }

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
  doubleBtn.textContent = 'Activate 2x Powerup';
}

leaveBtn.addEventListener('click', () => {
  resetState();
  showView('auth');
});

backBtn.addEventListener('click', () => {
  resetState();
  showView('auth');
});
