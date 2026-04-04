const toast = document.getElementById('toast');
const registerForm = document.getElementById('registerForm');
const loginForm = document.getElementById('loginForm');

function showToast(msg, ms = 2400) {
  if (!toast) return;
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
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/auth/register', 'POST', {
      username: document.getElementById('registerUsername').value,
      password: document.getElementById('registerPassword').value
    });

    localStorage.setItem('quizzyAccountToken', data.accountToken);
    localStorage.setItem('quizzyAccountName', data.user.username);
    location.href = '/dashboard';
  } catch (error) {
    showToast(error.message);
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/auth/login', 'POST', {
      username: document.getElementById('loginUsername').value,
      password: document.getElementById('loginPassword').value
    });

    localStorage.setItem('quizzyAccountToken', data.accountToken);
    localStorage.setItem('quizzyAccountName', data.user.username);
    location.href = '/dashboard';
  } catch (error) {
    showToast(error.message);
  }
});

if (localStorage.getItem('quizzyAccountToken')) {
  location.href = '/dashboard';
}
