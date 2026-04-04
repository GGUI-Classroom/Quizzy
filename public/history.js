const host = window.QuizzyHost;

const historyGrid = document.getElementById('historyGrid');

function modeLabel(modeId) {
  return String(modeId || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function render(history) {
  if (!history.length) {
    historyGrid.innerHTML = '<article class="card"><h4>No history yet</h4><p class="muted">Host a game to populate history.</p></article>';
    return;
  }

  historyGrid.innerHTML = history
    .map((row) => `
      <article class="set-card">
        <div class="set-card-top">${modeLabel(row.mode_id)}</div>
        <div class="set-card-body">
          <h4>${row.set_title}</h4>
          <p class="muted">Room: ${row.room_code}</p>
          <p class="muted">Winner: ${row.winner_name}</p>
          <p class="muted">Players: ${Number(row.players_count || 0)}</p>
          <p class="muted">${new Date(row.created_at).toLocaleString()}</p>
        </div>
      </article>
    `)
    .join('');
}

async function load() {
  const data = await host.api('/api/history');
  render(data.history || []);
}

(function init() {
  if (!host.requireAuth()) return;
  host.mountHeader();
  load().catch((error) => host.showToast(error.message || 'Failed to load history'));
})();
