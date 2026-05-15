async function checkSettingsAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.role !== 'admin') {
      window.location.href = '/login.html?redirect=/settings.html';
    }
  } catch {
    window.location.href = '/login.html?redirect=/settings.html';
  }
}

const form = document.querySelector('#settingsForm');
const backBtn = document.querySelector('#backBtn');
const logoutBtn = document.querySelector('#logoutBtn');
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
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});
form.addEventListener('submit', (event) => saveSettings(event).catch((error) => alert(error.message)));
cleanupBtn.addEventListener('click', cleanupMedia);
loadSettings().catch((error) => alert(error.message));

const participantTableBody = document.querySelector('#participantTableBody');
const participantPagination = document.querySelector('#participantPagination');
const addParticipantBtn = document.querySelector('#addParticipantBtn');
const toggleAddBtn = document.querySelector('#toggleAddBtn');
const addFields = document.querySelector('#addFields');
const newParticipantName = document.querySelector('#newParticipantName');
const newParticipantDate = document.querySelector('#newParticipantDate');
const newParticipantCount = document.querySelector('#newParticipantCount');
const pageSizeSelect = document.querySelector('#pageSizeSelect');
const participantSearch = document.querySelector('#participantSearch');
const searchBtn = document.querySelector('#searchBtn');
let participantPage = 1;
let participantPageSize = 10;
let allParticipants = [];
let searchFilter = '';
let addFormExpanded = false;

async function loadParticipants() {
  const res = await fetch('/api/participants');
  allParticipants = res.ok ? await res.json() : [];
  renderParticipantTable();
}

function formatLocalDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function renderParticipantTable() {
  const filtered = searchFilter
    ? allParticipants.filter((p) => p.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : allParticipants;
  const start = (participantPage - 1) * participantPageSize;
  const page = filtered.slice(start, start + participantPageSize);
  participantTableBody.innerHTML = page.length
    ? page.map((p) => {
        return `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td class="col-date">${escapeHtml(formatLocalDate(p.last_participated_at))}</td>
          <td class="col-count">${p.count}</td>
          <td class="col-actions"><button class="delete-btn" data-id="${p.id}">删除</button></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:20px;">暂无人员数据</td></tr>';

  const totalPages = Math.max(1, Math.ceil(filtered.length / participantPageSize));
  let paginationHTML = '';
  paginationHTML += `<button ${participantPage === 1 ? 'disabled' : ''} data-page="${participantPage - 1}">&laquo;</button>`;
  for (let i = 1; i <= totalPages; i += 1) {
    paginationHTML += `<button class="${i === participantPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  paginationHTML += `<button ${participantPage === totalPages ? 'disabled' : ''} data-page="${participantPage + 1}">&raquo;</button>`;
  paginationHTML += `<span>${filtered.length} 人</span>`;
  participantPagination.innerHTML = paginationHTML;

  participantPagination.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = Number(btn.dataset.page);
      if (page && page !== participantPage && page >= 1 && page <= totalPages) {
        participantPage = page;
        renderParticipantTable();
      }
    });
  });

  participantTableBody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteParticipant(Number(btn.dataset.id)));
  });
}

async function addParticipant() {
  const name = newParticipantName.value.trim();
  if (!name) return alert('请输入姓名');
  const body = { name };
  if (newParticipantDate.value) body.last_participated_at = new Date(newParticipantDate.value).toISOString();
  if (newParticipantCount.value !== '') body.count = parseInt(newParticipantCount.value);
  const res = await fetch('/api/participants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json();
    return alert(err.error || '添加失败');
  }
  newParticipantName.value = '';
  newParticipantDate.value = '';
  newParticipantCount.value = '0';
  collapseAddForm();
  await loadParticipants();
}

async function deleteParticipant(id) {
  if (!confirm('确定删除此人员？')) return;
  const res = await fetch(`/api/participants/${id}`, { method: 'DELETE' });
  if (!res.ok) return alert('删除失败');
  const remaining = allParticipants.length - 1;
  participantPage = Math.min(participantPage, Math.max(1, Math.ceil(remaining / participantPageSize)));
  await loadParticipants();
}

pageSizeSelect.addEventListener('change', () => {
  participantPageSize = Number(pageSizeSelect.value);
  participantPage = 1;
  renderParticipantTable();
});

function expandAddForm() {
  addFormExpanded = true;
  toggleAddBtn.classList.add('expanded');
  addFields.classList.remove('hidden');
  newParticipantName.focus();
}

function collapseAddForm() {
  addFormExpanded = false;
  toggleAddBtn.classList.remove('expanded');
  addFields.classList.add('hidden');
  newParticipantName.value = '';
  newParticipantDate.value = '';
  newParticipantCount.value = '0';
}

toggleAddBtn.addEventListener('click', () => {
  if (addFormExpanded) {
    collapseAddForm();
  } else {
    expandAddForm();
  }
});

addParticipantBtn.addEventListener('click', addParticipant);

searchBtn.addEventListener('click', () => {
  searchFilter = participantSearch.value.trim();
  participantPage = 1;
  renderParticipantTable();
});

participantSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    searchFilter = participantSearch.value.trim();
    participantPage = 1;
    renderParticipantTable();
  }
});

checkSettingsAuth().then(() => {
  loadParticipants();
  loadSettings().catch((error) => alert(error.message));
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
