const host = window.QuizzyHost;

const statsGrid = document.getElementById('statsGrid');
const setGrid = document.getElementById('setGrid');

function cardHtml(set) {
  const favLabel = set.is_favorite ? 'Unfavorite' : 'Favorite';
  return `
    <article class="set-card">
      <div class="set-card-top">${String(set.question_count || 0)}Q</div>
      <div class="set-card-body">
        <h4>${set.title}</h4>
        <p class="muted">${set.description || 'No description'}</p>
        <p class="muted">${Number(set.plays_count || 0)} plays • ${Number(set.favorite_count || 0)} favorites</p>
        <div class="set-actions">
          <button class="btn secondary" data-action="host" data-id="${set.id}">Host</button>
          <button class="btn ghost" data-action="favorite" data-id="${set.id}">${favLabel}</button>
        </div>
      </div>
    </article>
  `;
}

function renderStats(setCount, questionCount, gameCount) {
  statsGrid.innerHTML = `
    <article class="card stat-card">
      <h3>${setCount}</h3>
      <p class="muted">Sets</p>
    </article>
    <article class="card stat-card">
      <h3>${questionCount}</h3>
      <p class="muted">Questions</p>
    </article>
    <article class="card stat-card">
      <h3>${gameCount}</h3>
      <p class="muted">Hosted Games</p>
    </article>
  `;
}

async function loadDashboard() {
  const [setsRes, historyRes] = await Promise.all([
    host.api('/api/sets'),
    host.api('/api/history')
  ]);

  const sets = setsRes.sets || [];
  const totalQuestions = sets.reduce((sum, s) => sum + Number(s.question_count || 0), 0);
  const history = historyRes.history || [];

  renderStats(sets.length, totalQuestions, history.length);

  if (!sets.length) {
    setGrid.innerHTML = '<article class="card"><h4>No sets yet</h4><p class="muted">Create one in Create Set.</p></article>';
    return;
  }

  setGrid.innerHTML = sets.map(cardHtml).join('');
}

setGrid.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const action = target.dataset.action;
  const id = target.dataset.id;
  if (!action || !id) return;

  if (action === 'host') {
    host.setSelectedSetId(id);
    location.href = '/host';
    return;
  }

  if (action === 'favorite') {
    try {
      await host.api(`/api/sets/${id}/favorite`, 'POST', {});
      await loadDashboard();
      host.showToast('Favorites updated');
    } catch (error) {
      host.showToast(error.message);
    }
  }
});

(async function init() {
  if (!host.requireAuth()) return;
  host.mountHeader();

  try {
    await loadDashboard();
  } catch (error) {
    host.showToast(error.message || 'Failed to load dashboard');
  }
})();
