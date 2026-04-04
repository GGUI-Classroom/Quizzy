const host = window.QuizzyHost;

const setGrid = document.getElementById('setGrid');

function render(sets) {
  if (!sets.length) {
    setGrid.innerHTML = '<article class="card"><h4>No favorites yet</h4><p class="muted">Favorite sets from Discover.</p></article>';
    return;
  }

  setGrid.innerHTML = sets
    .map((set) => `
      <article class="set-card">
        <div class="set-card-top">${Number(set.question_count || 0)}Q</div>
        <div class="set-card-body">
          <h4>${set.title}</h4>
          <p class="muted">by ${set.owner_name || 'unknown'}</p>
          <p class="muted">${Number(set.plays_count || 0)} plays • ${Number(set.favorite_count || 0)} favorites</p>
          <div class="set-actions">
            <button class="btn secondary" data-action="host" data-id="${set.id}">Host</button>
            <button class="btn ghost" data-action="favorite" data-id="${set.id}">Unfavorite</button>
          </div>
        </div>
      </article>
    `)
    .join('');
}

async function load() {
  const data = await host.api('/api/sets/favorites');
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

  if (action === 'favorite') {
    try {
      await host.api(`/api/sets/${id}/favorite`, 'POST', {});
      host.showToast('Removed from favorites');
      await load();
    } catch (error) {
      host.showToast(error.message);
    }
  }
});

(function init() {
  if (!host.requireAuth()) return;
  host.mountHeader();
  load().catch((error) => host.showToast(error.message || 'Failed to load favorites'));
})();
