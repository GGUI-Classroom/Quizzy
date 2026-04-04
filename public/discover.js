const host = window.QuizzyHost;

const setGrid = document.getElementById('setGrid');

function render(sets) {
  if (!sets.length) {
    setGrid.innerHTML = '<article class="card"><h4>No discover sets found</h4></article>';
    return;
  }

  setGrid.innerHTML = sets
    .map((set) => {
      const favLabel = set.is_favorite ? 'Unfavorite' : 'Favorite';
      return `
        <article class="set-card">
          <div class="set-card-top">Quizzy</div>
          <div class="set-card-body">
            <h4>${set.title}</h4>
            <p class="muted">by ${set.owner_name || 'unknown'} • ${Number(set.question_count || 0)} questions</p>
            <p class="muted">${Number(set.plays_count || 0)} plays • ${Number(set.favorite_count || 0)} favorites</p>
            <div class="set-actions">
              <button class="btn ghost" data-action="favorite" data-id="${set.id}">${favLabel}</button>
              <button class="btn ghost" data-action="clone" data-id="${set.id}">Clone</button>
            </div>
            <div class="set-actions">
              <button class="btn secondary" data-action="host" data-id="${set.id}">Host This</button>
              <span></span>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

async function load() {
  const data = await host.api('/api/sets/discover');
  render(data.sets || []);
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

  try {
    if (action === 'favorite') {
      await host.api(`/api/sets/${id}/favorite`, 'POST', {});
      host.showToast('Favorites updated');
      await load();
      return;
    }

    if (action === 'clone') {
      await host.api(`/api/sets/${id}/clone`, 'POST', {});
      host.showToast('Set cloned to your account');
      return;
    }
  } catch (error) {
    host.showToast(error.message);
  }
});

(function init() {
  if (!host.requireAuth()) return;
  host.mountHeader();
  load().catch((error) => host.showToast(error.message || 'Failed to load discover'));
})();
