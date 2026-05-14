const form = document.querySelector('#settingsForm');
const backBtn = document.querySelector('#backBtn');
const saveStatus = document.querySelector('#saveStatus');
const cleanupBtn = document.querySelector('#cleanupBtn');
const cleanupResult = document.querySelector('#cleanupResult');

async function loadSettings() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  Object.entries(settings).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  saveStatus.textContent = '已保存';
  setTimeout(() => { saveStatus.textContent = ''; }, 1800);
}

async function cleanupMedia() {
  cleanupBtn.disabled = true;
  cleanupResult.classList.remove('hidden');
  cleanupResult.textContent = '正在清理...';
  try {
    const res = await fetch('/api/cleanup-media', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    cleanupResult.textContent = data.moved_count
      ? `已移动 ${data.moved_count} 个文件到 ${data.recycle_path}\n\n${data.moved.map((item) => `${item.from} -> ${item.to}`).join('\n')}`
      : '没有发现需要清理的文件。';
  } catch (error) {
    cleanupResult.textContent = error.message;
  } finally {
    cleanupBtn.disabled = false;
  }
}

backBtn.addEventListener('click', () => { window.location.href = '/'; });
form.addEventListener('submit', (event) => saveSettings(event).catch((error) => alert(error.message)));
cleanupBtn.addEventListener('click', cleanupMedia);
loadSettings().catch((error) => alert(error.message));
