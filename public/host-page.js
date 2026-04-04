const host = window.QuizzyHost;

const hostAlias = document.getElementById('hostAlias');
const setSelect = document.getElementById('setSelect');
const modeSelect = document.getElementById('modeSelect');
const createRoomBtn = document.getElementById('createRoomBtn');
const startBtn = document.getElementById('startBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const roomCodeText = document.getElementById('roomCodeText');
const hostLeaderboard = document.getElementById('hostLeaderboard');
const projectorPanel = document.getElementById('projectorPanel');
const projectorTitle = document.getElementById('projectorTitle');
const projectorLeaderboard = document.getElementById('projectorLeaderboard');

let hostRoom = null;
let pollTimer = null;

function renderModes(modes) {
  modeSelect.innerHTML = '';
  modes.forEach((mode) => {
    const opt = document.createElement('option');
    opt.value = mode.id;
    opt.textContent = mode.name;
    modeSelect.appendChild(opt);
  });
}

function renderSets(sets) {
  setSelect.innerHTML = '';
  sets.forEach((set) => {
    const opt = document.createElement('option');
    opt.value = set.id;
    opt.textContent = `${set.title} (${set.question_count}Q)`;
    setSelect.appendChild(opt);
  });

  const selected = host.getSelectedSetId();
  if (selected && sets.some((s) => s.id === selected)) {
    setSelect.value = selected;
  }
}

function renderLeaderboard(room) {
  const lines = room.leaderboard || [];
  hostLeaderboard.innerHTML = '';
  projectorLeaderboard.innerHTML = '';

  lines.forEach((row) => {
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

async function loadInitData() {
  const [meta, setsData] = await Promise.all([
    host.api('/api/meta/options'),
    host.api('/api/sets')
  ]);

  renderModes(meta.modes || []);
  renderSets(setsData.sets || []);
}

async function pollRoom() {
  if (!hostRoom) return;

  try {
    const res = await host.api(`/api/rooms/${hostRoom.code}?hostToken=${encodeURIComponent(hostRoom.hostToken)}`);
    renderLeaderboard(res.room);

    if (res.room.status !== 'lobby') {
      startBtn.disabled = true;
      startBtn.textContent = 'Game In Progress';
    }
  } catch {
    host.showToast('Room update failed');
  }
}

createRoomBtn.addEventListener('click', async () => {
  try {
    const setId = setSelect.value;
    if (!setId) throw new Error('Select a set first');

    const created = await host.api('/api/rooms', 'POST', {
      setId,
      mode: modeSelect.value,
      hostAlias: hostAlias.value.trim() || host.state.accountName
    });

    hostRoom = {
      code: created.roomCode,
      hostToken: created.hostToken
    };

    host.setSelectedSetId(setId);
    roomCodeText.textContent = created.roomCode;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Game';
    projectorPanel.classList.remove('hidden');
    renderLeaderboard(created.room);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollRoom, 2200);

    host.showToast('Room created');
  } catch (error) {
    host.showToast(error.message);
  }
});

startBtn.addEventListener('click', async () => {
  if (!hostRoom) return;
  try {
    await host.api(`/api/rooms/${hostRoom.code}/start`, 'POST', { hostToken: hostRoom.hostToken });
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
    host.showToast('Game started');
  } catch (error) {
    host.showToast(error.message);
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
    host.showToast('Fullscreen blocked by browser');
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    fullscreenBtn.textContent = 'Fullscreen Board';
  }
});

(function init() {
  if (!host.requireAuth()) return;
  host.mountHeader();
  hostAlias.value = host.state.accountName || '';

  loadInitData().catch((error) => {
    host.showToast(error.message || 'Failed to load host data');
  });
})();
