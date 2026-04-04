const state = {
  roomCode: null,
  playerId: null,
  token: null,
  ws: null,
  timerInterval: null,
  questionLocked: false,
  powerupActive: false
};

const joinView = document.getElementById('joinView');
const playView = document.getElementById('playView');
const waitingCard = document.getElementById('waitingCard');
const questionCard = document.getElementById('questionCard');
const resultCard = document.getElementById('resultCard');

const codeInput = document.getElementById('codeInput');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const roomInfo = document.getElementById('roomInfo');
const playerList = document.getElementById('playerList');

const qTitle = document.getElementById('qTitle');
const qPrompt = document.getElementById('qPrompt');
const modeCard = document.getElementById('modeCard');
const modeTitle = document.getElementById('modeTitle');
const modeBody = document.getElementById('modeBody');
const optionsWrap = document.getElementById('options');
const timerEl = document.getElementById('timer');
const feedback = document.getElementById('feedback');
const powerBtn = document.getElementById('powerBtn');

const leaderboard = document.getElementById('leaderboard');
const winner = document.getElementById('winner');
const toast = document.getElementById('toast');

function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), ms);
}

function showCard(cardId) {
  waitingCard.classList.toggle('hidden', cardId !== 'waiting');
  questionCard.classList.toggle('hidden', cardId !== 'question');
  resultCard.classList.toggle('hidden', cardId !== 'result');
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

function updateWaiting(room) {
  roomInfo.textContent = `Room ${room.code} • ${room.mode.name} • Players: ${room.playerCount}`;
  playerList.innerHTML = '';

  room.players.forEach((p) => {
    const li = document.createElement('li');
    const you = p.id === state.playerId ? ' (You)' : '';
    li.textContent = `${p.name}${you}`;
    playerList.appendChild(li);
  });

  if (room.status === 'lobby') {
    showCard('waiting');
  }
}

function renderQuestion(msg) {
  state.questionLocked = false;
  feedback.textContent = '';
  qTitle.textContent = `Question ${msg.questionIndex + 1} / ${msg.totalQuestions}`;
  qPrompt.textContent = msg.question.prompt;
  if (msg.modeSpotlight) {
    modeTitle.textContent = msg.modeSpotlight.title;
    modeBody.textContent = msg.modeSpotlight.body;
    modeCard.classList.remove('hidden');
  }

  optionsWrap.innerHTML = '';
  msg.question.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.textContent = opt;
    btn.onclick = () => submitAnswer(idx);
    optionsWrap.appendChild(btn);
  });

  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    const ms = Math.max(0, msg.endsAt - Date.now());
    timerEl.textContent = `${(ms / 1000).toFixed(1)}s`;
    if (ms <= 0) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }, 100);

  showCard('question');
}

function submitAnswer(answerIndex) {
  if (state.questionLocked || !state.ws) return;

  state.questionLocked = true;
  document.querySelectorAll('.opt').forEach((el) => {
    el.disabled = true;
  });

  state.ws.send(JSON.stringify({ type: 'answer', answerIndex }));
}

function renderLeaderboard(entries) {
  leaderboard.innerHTML = '';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = `${entry.name} - ${entry.value}`;
    leaderboard.appendChild(li);
  });
}

function handleMessage(msg) {
  if (msg.type === 'room_update') {
    updateWaiting(msg.room);
  }

  if (msg.type === 'question') {
    renderQuestion(msg);
  }

  if (msg.type === 'answer_result') {
    const modeText = msg.modeSpotlight ? ` ${msg.modeSpotlight.body}` : '';
    feedback.textContent = msg.correct ? `Correct! +${msg.gain}.${modeText}` : `Wrong answer.${modeText}`;
  }

  if (msg.type === 'answer_reveal') {
    showToast(`Correct answer: ${msg.correctAnswer}`);
  }

  if (msg.type === 'powerup_status') {
    state.powerupActive = true;
    powerBtn.textContent = '2x Armed';
    powerBtn.disabled = true;
  }

  if (msg.type === 'game_over') {
    renderLeaderboard(msg.room.leaderboard || []);
    winner.textContent = msg.winner ? `Winner: ${msg.winner.name}` : 'No winner';
    showCard('result');
  }
}

joinBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();

  if (!code || !name) {
    showToast('Enter game code and name');
    return;
  }

  try {
    const data = await api(`/api/rooms/${code}/join`, 'POST', {
      name,
      profile: { avatar: 'fox', frame: 'neon', title: 'Rookie', color: 'cyan' }
    });

    state.roomCode = code;
    state.playerId = data.playerId;
    state.token = data.token;

    joinView.classList.add('hidden');
    playView.classList.remove('hidden');
    updateWaiting(data.room);
    connectWs();
  } catch (err) {
    showToast(err.message);
  }
});

powerBtn.addEventListener('click', () => {
  if (!state.ws || state.powerupActive) return;
  state.ws.send(JSON.stringify({ type: 'activate_powerup', powerup: 'double' }));
});
