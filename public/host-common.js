window.QuizzyHost = (() => {
  const state = {
    accountToken: localStorage.getItem('quizzyAccountToken') || null,
    accountName: localStorage.getItem('quizzyAccountName') || null
  };

  function showToast(msg, ms = 2200) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), ms);
  }

  async function api(url, method = 'GET', body, accountToken) {
    const token = accountToken || state.accountToken;
    const queryJoin = url.includes('?') ? '&' : '?';
    const tokenUrl = token && method === 'GET' ? `${url}${queryJoin}accountToken=${encodeURIComponent(token)}` : url;

    const res = await fetch(tokenUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && method !== 'GET' ? { 'x-account-token': token } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function requireAuth() {
    if (!state.accountToken || !state.accountName) {
      location.href = '/';
      return false;
    }
    return true;
  }

  function logout() {
    localStorage.removeItem('quizzyAccountToken');
    localStorage.removeItem('quizzyAccountName');
    state.accountToken = null;
    state.accountName = null;
    location.href = '/';
  }

  function setSelectedSetId(id) {
    localStorage.setItem('quizzySelectedSetId', id);
  }

  function getSelectedSetId() {
    return localStorage.getItem('quizzySelectedSetId') || '';
  }

  function mountHeader() {
    const greet = document.getElementById('headerUserName');
    if (greet) greet.textContent = state.accountName || '-';

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', logout);
    }
  }

  return {
    state,
    api,
    showToast,
    requireAuth,
    logout,
    setSelectedSetId,
    getSelectedSetId,
    mountHeader
  };
})();
