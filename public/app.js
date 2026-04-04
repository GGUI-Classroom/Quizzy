const state = {
  accountToken: localStorage.getItem('quizzyAccountToken') || null,
  accountName: localStorage.getItem('quizzyAccountName') || null,
  modes: [],
  sets: [],
  draftQuestions: [],
  hostRoom: null,
  hostPollTimer: null,
  activeTab: 'my_sets'
};

const TAB_LABELS = {
  my_sets: 'My Sets',
  discover: 'Discover',
  favorites: 'Favorites',
  history: 'History'
};

const views = {
  home: document.getElementById('homeView'),
  auth: document.getElementById('authView'),
  dashboard: document.getElementById('dashboardView')
};

const registerForm = document.getElementById('registerForm');
const loginForm = document.getElementById('loginForm');

const openAuthBtn = document.getElementById('openAuthBtn');
const openDashboardBtn = document.getElementById('openDashboardBtn');
const brandHomeBtn = document.getElementById('brandHomeBtn');
const heroSignupBtn = document.getElementById('heroSignupBtn');
const logoutBtn = document.getElementById('logoutBtn');

const tabMySetsBtn = document.getElementById('tabMySetsBtn');
const tabDiscoverBtn = document.getElementById('tabDiscoverBtn');
const tabFavoritesBtn = document.getElementById('tabFavoritesBtn');
const tabHistoryBtn = document.getElementById('tabHistoryBtn');
const tabTitle = document.getElementById('tabTitle');

const dashboardGreeting = document.getElementById('dashboardGreeting');
const modeSelect = document.getElementById('modeSelect');
const setSelect = document.getElementById('setSelect');
const setSearchInput = document.getElementById('setSearchInput');
const setGrid = document.getElementById('setGrid');

const setTitleInput = document.getElementById('setTitleInput');
const setDescriptionInput = document.getElementById('setDescriptionInput');
const qPromptInput = document.getElementById('qPromptInput');
const qOptAInput = document.getElementById('qOptAInput');
const qOptBInput = document.getElementById('qOptBInput');
const qOptCInput = document.getElementById('qOptCInput');
const qOptDInput = document.getElementById('qOptDInput');
const qCorrectSelect = document.getElementById('qCorrectSelect');
const addQuestionBtn = document.getElementById('addQuestionBtn');
const saveSetBtn = document.getElementById('saveSetBtn');
const draftQuestionList = document.getElementById('draftQuestionList');

const hostAlias = document.getElementById('hostAlias');
const createRoomBtn = document.getElementById('createRoomBtn');
const hostRoomPanel = document.getElementById('hostRoomPanel');
const roomCodeText = document.getElementById('roomCodeText');
const startBtn = document.getElementById('startBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const hostLeaderboard = document.getElementById('hostLeaderboard');

const projectorPanel = document.getElementById('projectorPanel');
const projectorTitle = document.getElementById('projectorTitle');
const projectorLeaderboard = document.getElementById('projectorLeaderboard');

const toast = document.getElementById('toast');

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
    el.classList.toggle('visible', key === name);
  });
}

function showToast(msg, ms = 2400) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), ms);
}

async function api(url, method = 'GET', body, accountToken) {
  const queryJoin = url.includes('?') ? '&' : '?';
  const tokenUrl = accountToken && method === 'GET' ? `${url}${queryJoin}accountToken=${encodeURIComponent(accountToken)}` : url;

  const res = await fetch(tokenUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accountToken && method !== 'GET' ? { 'x-account-token': accountToken } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function syncAuthButtons() {
  const signedIn = Boolean(state.accountToken && state.accountName);
  openAuthBtn.classList.toggle('hidden', signedIn);
  openDashboardBtn.classList.toggle('hidden', !signedIn);
}

function renderGreeting() {
  dashboardGreeting.textContent = state.accountName ? `Signed in as ${state.accountName}` : 'Signed out';
}

function applyAuth(accountToken, username) {
  state.accountToken = accountToken;
  state.accountName = username;
  localStorage.setItem('quizzyAccountToken', accountToken);
  localStorage.setItem('quizzyAccountName', username);
  syncAuthButtons();
  renderGreeting();
  showView('dashboard');
}

function clearAuth() {
  state.accountToken = null;
  state.accountName = null;
  localStorage.removeItem('quizzyAccountToken');
  localStorage.removeItem('quizzyAccountName');

  if (state.hostPollTimer) {
    clearInterval(state.hostPollTimer);
    state.hostPollTimer = null;
  }

  syncAuthButtons();
  renderGreeting();
}

function updateTabUI() {
  tabTitle.textContent = TAB_LABELS[state.activeTab] || 'My Sets';

  const map = [
    [tabMySetsBtn, 'my_sets'],
    [tabDiscoverBtn, 'discover'],
    [tabFavoritesBtn, 'favorites'],
    [tabHistoryBtn, 'history']
  ];

  map.forEach(([btn, key]) => btn.classList.toggle('active', state.activeTab === key));
}

function renderModes() {
  modeSelect.innerHTML = '';
  state.modes.forEach((mode) => {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.name;
    modeSelect.appendChild(option);
  });
}

function renderSetSelect() {
  setSelect.innerHTML = '';
  const mine = state.sets.filter((s) => s.owner_name ? s.owner_name === state.accountName : true);
  mine.forEach((set) => {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = `${set.title} (${set.question_count}Q)`;
    setSelect.appendChild(option);
  });
}

function renderDraftQuestions() {
  if (!state.draftQuestions.length) {
    draftQuestionList.innerHTML = '<p class="muted">No questions added yet.</p>';
    return;
  }

  draftQuestionList.innerHTML = state.draftQuestions
    .map((q, idx) => `<div class="draft-item">${idx + 1}. ${q.prompt}</div>`)
    .join('');
}

function renderHistoryCards(rows) {
  if (!rows.length) {
    setGrid.innerHTML = '<article class="card"><h4>No history yet</h4><p class="muted">Host a game to populate history.</p></article>';
    return;
  }

  setGrid.innerHTML = rows
    .map(
      (h) => `
      <article class="set-card">
        <div class="set-card-top">${h.mode_id}</div>
        <div class="set-card-body">
          <h4>${h.set_title}</h4>
          <p class="muted">Winner: ${h.winner_name}</p>
          <p class="muted">Players: ${h.players_count}</p>
          <p class="muted">${new Date(h.created_at).toLocaleString()}</p>
        </div>
      </article>`
    )
    .join('');
}

function renderSetCards(filter = '') {
  const keyword = String(filter).trim().toLowerCase();
  const rows = state.sets.filter((set) => {
    if (!keyword) return true;
    const owner = String(set.owner_name || '').toLowerCase();
    return set.title.toLowerCase().includes(keyword) || set.description.toLowerCase().includes(keyword) || owner.includes(keyword);
  });

  if (!rows.length) {
    setGrid.innerHTML = '<article class="card"><h4>No sets found</h4><p class="muted">Try changing search or tab.</p></article>';
    return;
  }

  setGrid.innerHTML = rows
    .map((set) => {
      const ownerText = set.owner_name ? `by ${set.owner_name}` : 'your set';
      const favLabel = set.is_favorite ? 'Unfavorite' : 'Favorite';
      const cloneButton = state.activeTab === 'discover' ? `<button class="btn ghost" data-action="clone" data-id="${set.id}">Clone</button>` : '';
      const hostButton = state.activeTab !== 'history' ? `<button class="btn secondary" data-action="host" data-id="${set.id}">Host</button>` : '';

      return `
        <article class="set-card">
          <div class="set-card-top">Quizzy</div>
          <div class="set-card-body">
            <h4>${set.title}</h4>
            <p class="muted">${set.question_count} questions • ${ownerText}</p>
            <p class="muted">${set.plays_count || 0} plays • ${set.favorite_count || 0} favorites</p>
            <div class="set-actions">
              <button class="btn ghost" data-action="favorite" data-id="${set.id}">${favLabel}</button>
              ${hostButton || '<span></span>'}
            </div>
            ${cloneButton ? `<div class="set-actions">${cloneButton}<button class="btn ghost" data-action="select" data-id="${set.id}">Select</button></div>` : ''}
          </div>
        </article>
      `;
    })
    .join('');
}

function collectQuestionDraft() {
  const prompt = qPromptInput.value.trim();
  const options = [qOptAInput.value.trim(), qOptBInput.value.trim(), qOptCInput.value.trim(), qOptDInput.value.trim()];
  const answerIndex = Number(qCorrectSelect.value);

  if (!prompt || options.some((o) => !o)) {
    throw new Error('Please complete prompt and all 4 options');
  }

  return {
    prompt,
    options,
    answerIndex,
    difficulty: 1
  };
}

function clearQuestionInputs() {
  qPromptInput.value = '';
  qOptAInput.value = '';
  qOptBInput.value = '';
  qOptCInput.value = '';
  qOptDInput.value = '';
  qCorrectSelect.value = '0';
}

function renderHostLeaderboard(room) {
  hostLeaderboard.innerHTML = '';
  projectorLeaderboard.innerHTML = '';

  (room.leaderboard || []).forEach((row) => {
    const text = `${row.name} - ${row.value}`;
    const li = document.createElement('li');
    li.textContent = text;
    hostLeaderboard.appendChild(li);

    const pli = document.createElement('li');
    pli.textContent = text;
    projectorLeaderboard.appendChild(pli);
  });

  projectorTitle.textContent = `Room ${room.code} • ${room.mode.name} • ${room.setTitle}`;
}

async function loadMeta() {
  const data = await api('/api/meta/options');
  state.modes = data.modes || [];
  renderModes();
}

async function loadSetsForCurrentTab() {
  if (!state.accountToken) return;

  if (state.activeTab === 'discover') {
    const data = await api('/api/sets/discover', 'GET', null, state.accountToken);
    state.sets = data.sets || [];
    renderSetCards(setSearchInput.value);
    return;
  }

  if (state.activeTab === 'favorites') {
    const data = await api('/api/sets/favorites', 'GET', null, state.accountToken);
    state.sets = data.sets || [];
    renderSetCards(setSearchInput.value);
    return;
  }

  if (state.activeTab === 'history') {
    const data = await api('/api/history', 'GET', null, state.accountToken);
    renderHistoryCards(data.history || []);
    return;
  }

  const data = await api('/api/sets', 'GET', null, state.accountToken);
  state.sets = data.sets || [];
  renderSetCards(setSearchInput.value);
  renderSetSelect();
}

async function pollHostRoom() {
  if (!state.hostRoom) return;

  try {
    const roomInfo = await api(`/api/rooms/${state.hostRoom.code}?hostToken=${encodeURIComponent(state.hostRoom.hostToken)}`, 'GET');

    renderHostLeaderboard(roomInfo.room);

    if (roomInfo.room.status !== 'lobby') {
      startBtn.disabled = true;
      startBtn.textContent = 'Game In Progress';
    }
  } catch {
    showToast('Host room poll failed');
  }
}

async function switchTab(tabKey) {
  state.activeTab = tabKey;
  updateTabUI();
  await loadSetsForCurrentTab();
}

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/register', 'POST', {
      username: document.getElementById('registerUsername').value,
      password: document.getElementById('registerPassword').value
    });

    applyAuth(data.accountToken, data.user.username);
    await switchTab('my_sets');
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
    await switchTab('my_sets');
    showToast('Logged in');
  } catch (err) {
    showToast(err.message);
  }
});

addQuestionBtn.addEventListener('click', () => {
  try {
    const draft = collectQuestionDraft();
    state.draftQuestions.push(draft);
    clearQuestionInputs();
    renderDraftQuestions();
    showToast('Question added');
  } catch (err) {
    showToast(err.message);
  }
});

saveSetBtn.addEventListener('click', async () => {
  if (!state.accountToken) {
    showToast('Login required');
    showView('auth');
    return;
  }

  try {
    const title = setTitleInput.value.trim();
    const description = setDescriptionInput.value.trim();

    if (!title) throw new Error('Set title required');
    if (state.draftQuestions.length < 1) throw new Error('Add at least 1 question');

    await api(
      '/api/sets',
      'POST',
      {
        accountToken: state.accountToken,
        title,
        description,
        questions: state.draftQuestions
      },
      state.accountToken
    );

    state.draftQuestions = [];
    setTitleInput.value = '';
    setDescriptionInput.value = '';
    renderDraftQuestions();

    await switchTab('my_sets');
    showToast('Set saved');
  } catch (err) {
    showToast(err.message);
  }
});

createRoomBtn.addEventListener('click', async () => {
  if (!state.accountToken) {
    showToast('Login required');
    showView('auth');
    return;
  }

  const setId = setSelect.value;
  if (!setId) {
    showToast('Select a set first');
    return;
  }

  try {
    const data = await api(
      '/api/rooms',
      'POST',
      {
        accountToken: state.accountToken,
        setId,
        mode: modeSelect.value,
        hostAlias: hostAlias.value.trim() || state.accountName
      },
      state.accountToken
    );

    state.hostRoom = {
      code: data.roomCode,
      hostToken: data.hostToken
    };

    roomCodeText.textContent = data.roomCode;
    hostRoomPanel.classList.remove('hidden');
    projectorPanel.classList.remove('hidden');
    startBtn.disabled = false;
    startBtn.textContent = 'Start Game';
    renderHostLeaderboard(data.room);

    if (state.hostPollTimer) clearInterval(state.hostPollTimer);
    state.hostPollTimer = setInterval(pollHostRoom, 2200);

    showToast('Room created');
  } catch (err) {
    showToast(err.message);
  }
});

startBtn.addEventListener('click', async () => {
  if (!state.hostRoom) return;

  try {
    await api(`/api/rooms/${state.hostRoom.code}/start`, 'POST', { hostToken: state.hostRoom.hostToken });
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
    showToast('Game started');
  } catch (err) {
    showToast(err.message);
  }
});

fullscreenBtn.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await projectorPanel.requestFullscreen();
      fullscreenBtn.textContent = 'Exit Fullscreen';
    } else {
      await document.exitFullscreen();
      fullscreenBtn.textContent = 'Fullscreen Board';
    }
  } catch {
    showToast('Fullscreen is blocked by your browser');
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    fullscreenBtn.textContent = 'Fullscreen Board';
  }
});

setGrid.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  const action = target.dataset.action;
  const id = target.dataset.id;
  if (!action || !id) return;

  if (action === 'host' || action === 'select') {
    setSelect.value = id;
    hostAlias.focus();
    showToast('Set selected');
    return;
  }

  if (action === 'favorite') {
    try {
      await api(`/api/sets/${id}/favorite`, 'POST', { accountToken: state.accountToken }, state.accountToken);
      await loadSetsForCurrentTab();
      showToast('Favorite updated');
    } catch (err) {
      showToast(err.message);
    }
    return;
  }

  if (action === 'clone') {
    try {
      await api(`/api/sets/${id}/clone`, 'POST', { accountToken: state.accountToken }, state.accountToken);
      await switchTab('my_sets');
      showToast('Set cloned to My Sets');
    } catch (err) {
      showToast(err.message);
    }
  }
});

setSearchInput.addEventListener('input', () => {
  if (state.activeTab === 'history') return;
  renderSetCards(setSearchInput.value);
});

logoutBtn.addEventListener('click', () => {
  clearAuth();
  showView('home');
  showToast('Logged out');
});

openAuthBtn.addEventListener('click', () => showView('auth'));
openDashboardBtn.addEventListener('click', async () => {
  showView('dashboard');
  await switchTab(state.activeTab);
});
heroSignupBtn.addEventListener('click', () => showView('auth'));

brandHomeBtn.addEventListener('click', (e) => {
  e.preventDefault();
  showView('home');
});

tabMySetsBtn.addEventListener('click', () => switchTab('my_sets'));
tabDiscoverBtn.addEventListener('click', () => switchTab('discover'));
tabFavoritesBtn.addEventListener('click', () => switchTab('favorites'));
tabHistoryBtn.addEventListener('click', () => switchTab('history'));

(async function init() {
  syncAuthButtons();
  renderGreeting();
  renderDraftQuestions();
  updateTabUI();

  try {
    await loadMeta();
  } catch {
    showToast('Failed to load game modes');
  }

  if (state.accountToken) {
    showView('dashboard');
    await switchTab('my_sets');
  } else {
    showView('home');
  }
})();
