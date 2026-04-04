const host = window.QuizzyHost;

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

const draftQuestions = [];

function renderDrafts() {
  if (!draftQuestions.length) {
    draftQuestionList.innerHTML = '<p class="muted">No questions added yet.</p>';
    return;
  }

  draftQuestionList.innerHTML = draftQuestions
    .map((q, i) => `<div class="draft-item">${i + 1}. ${q.prompt}</div>`)
    .join('');
}

function clearQuestionInputs() {
  qPromptInput.value = '';
  qOptAInput.value = '';
  qOptBInput.value = '';
  qOptCInput.value = '';
  qOptDInput.value = '';
  qCorrectSelect.value = '0';
}

function readDraft() {
  const prompt = qPromptInput.value.trim();
  const options = [qOptAInput.value.trim(), qOptBInput.value.trim(), qOptCInput.value.trim(), qOptDInput.value.trim()];
  const answerIndex = Number(qCorrectSelect.value);

  if (!prompt || options.some((o) => !o)) {
    throw new Error('Fill prompt and all options');
  }

  return { prompt, options, answerIndex, difficulty: 1 };
}

addQuestionBtn.addEventListener('click', () => {
  try {
    draftQuestions.push(readDraft());
    clearQuestionInputs();
    renderDrafts();
    host.showToast('Question added');
  } catch (error) {
    host.showToast(error.message);
  }
});

saveSetBtn.addEventListener('click', async () => {
  try {
    const title = setTitleInput.value.trim();
    const description = setDescriptionInput.value.trim();

    if (!title) throw new Error('Set title is required');
    if (draftQuestions.length < 1) throw new Error('Add at least 1 question');

    const data = await host.api('/api/sets', 'POST', {
      title,
      description,
      questions: draftQuestions
    });

    host.setSelectedSetId(data?.set?.id || '');
    setTitleInput.value = '';
    setDescriptionInput.value = '';
    draftQuestions.length = 0;
    renderDrafts();
    host.showToast('Set saved');
  } catch (error) {
    host.showToast(error.message || 'Failed to save set');
  }
});

(function init() {
  if (!host.requireAuth()) return;
  host.mountHeader();
  renderDrafts();
})();
