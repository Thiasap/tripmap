const state = {
  trips: [],
  selected: null,
  editing: true,
  projection: null,
  path: null,
  transform: d3.zoomIdentity
};

const mapSvg = d3.select('#mapSvg');
const linkSvg = d3.select('#linkSvg');
const cardsLayer = document.querySelector('#cardsLayer');
const dialog = document.querySelector('#tripDialog');
const form = document.querySelector('#tripForm');
const richEditor = document.querySelector('#richEditor');
const filesPanel = document.querySelector('#filesPanel');
const editBtn = document.querySelector('#editBtn');
const deleteBtn = document.querySelector('#deleteBtn');
const saveBtn = document.querySelector('#saveBtn');
const closeBtn = document.querySelector('#closeBtn');
const coverInput = form.elements.cover;
const coverPreview = document.querySelector('#coverPreview');
const coverPreviewText = document.querySelector('#coverPreviewText');
const albumInput = form.elements.album;
const albumPreview = document.querySelector('#albumPreview');

let quill;
let lightbox;

let mapGroup;
let pinsGroup;
let provinceLabelsGroup;

function stableColor(key) {
  let hash = 0;
  String(key).split('').forEach((char) => { hash = (hash * 31 + char.charCodeAt(0)) % 360; });
  return `hsl(${hash}, 62%, 72%)`;
}

function dateText(trip) {
  return [trip.start_date, trip.end_date].filter(Boolean).join(' 至 ') || '未填写日期';
}

function setFormEnabled(enabled) {
  state.editing = enabled;
  form.querySelectorAll('input').forEach((input) => {
    if (input.type !== 'hidden') input.disabled = !enabled;
  });
  quill.enable(enabled);
  saveBtn.classList.toggle('hidden', !enabled);
  editBtn.classList.toggle('hidden', enabled || !state.selected);
}

async function loadTrips() {
  const res = await fetch('/api/trips');
  state.trips = await res.json();
  renderTrips();
}

async function initMap() {
  const geojson = await fetch('china_provinces.geojson').then((res) => res.json());
  const width = document.querySelector('#mapWrap').clientWidth;
  const height = document.querySelector('#mapWrap').clientHeight;
  mapSvg.attr('viewBox', `0 0 ${width} ${height}`);
  linkSvg.attr('viewBox', `0 0 ${width} ${height}`);

  state.projection = d3.geoIdentity().reflectY(true).fitExtent([[120, 12], [width - 120, height - 12]], geojson);
  state.path = d3.geoPath(state.projection);
  mapGroup = mapSvg.append('g').attr('transform', 'scale(1 1.18)');

  mapGroup.selectAll('path')
    .data(geojson.features)
    .join('path')
    .attr('class', 'province')
    .attr('d', state.path)
    .attr('fill', (d) => stableColor(d.properties.code || d.properties.name));

  provinceLabelsGroup = mapGroup.append('g').attr('class', 'province-labels');
  provinceLabelsGroup.selectAll('text')
    .data(geojson.features)
    .join('text')
    .attr('class', 'province-label')
    .attr('x', (d) => state.path.centroid(d)[0])
    .attr('y', (d) => state.path.centroid(d)[1])
    .text((d) => d.properties.name || d.properties.fullname || '');

  pinsGroup = mapSvg.append('g').attr('class', 'pins-layer');

  mapSvg.call(d3.zoom().scaleExtent([0.7, 8]).on('zoom', (event) => {
    state.transform = event.transform;
    mapGroup.attr('transform', `translate(${event.transform.x},${event.transform.y}) scale(${event.transform.k},${event.transform.k * 1.18})`);
    updatePins();
    updateProvinceLabels();
    updateCards();
    renderLinks();
  }));

  await loadTrips();
}

function mapPoint(point) {
  return {
    x: state.transform.x + point[0] * state.transform.k,
    y: state.transform.y + point[1] * state.transform.k * 1.18
  };
}

function projectedPoint(trip) {
  const point = state.projection([Number(trip.longitude), Number(trip.latitude)]);
  return point ? mapPoint(point) : null;
}

function updateProvinceLabels() {
  provinceLabelsGroup.selectAll('text')
    .attr('transform', (d) => {
      const [x, y] = state.path.centroid(d);
      return `translate(${x}, ${y}) scale(${1 / state.transform.k}, ${1 / (state.transform.k * 1.18)}) translate(${-x}, ${-y})`;
    });
}

function updatePins() {
  pinsGroup.selectAll('.pin-wrap')
    .attr('transform', (d) => {
      const point = projectedPoint(d) || { x: 0, y: 0 };
      return `translate(${point.x}, ${point.y})`;
    });
}

function updateCards() {
  state.trips.forEach((trip) => {
    const card = cardsLayer.querySelector(`[data-id="${trip.id}"]`);
    if (!card) return;
    const coverRatio = coverAspectRatio(trip);
    const baseWidth = cardWidthForRatio(coverRatio);
    const x = state.transform.x + (trip.card_position_x || 40) * state.transform.k;
    const y = state.transform.y + (trip.card_position_y || 90) * state.transform.k * 1.18;
    card.style.width = `${baseWidth}px`;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.transform = `scale(${state.transform.k})`;
  });
}

function renderTrips() {
  pinsGroup.selectAll('.pin-wrap')
    .data(state.trips, (d) => d.id)
    .join((enter) => {
      const group = enter.append('g').attr('class', 'pin-wrap');
      group.append('circle').attr('class', 'pin').attr('r', 7);
      return group;
    });
  updatePins();

  cardsLayer.innerHTML = '';
  state.trips.forEach((trip) => {
    const card = document.createElement('article');
    card.className = 'trip-card';
    card.dataset.id = trip.id;
    const coverRatio = coverAspectRatio(trip);
    card.classList.toggle('portrait-card', coverRatio < 1);
    card.innerHTML = `
      ${trip.cover_path ? `<img class="card-cover" style="aspect-ratio:${coverRatio}" src="${trip.cover_path}" alt="${escapeHtml(trip.name)}" draggable="false">` : '<div class="card-cover no-cover">无封面</div>'}
      <div class="body"><strong>${escapeHtml(trip.name || '未命名旅行')}</strong><span>${escapeHtml(dateText(trip))}</span></div>
    `;
    card.addEventListener('click', (event) => {
      if (card.dataset.dragging === 'true') return;
      openDetail(trip.id);
    });
    makeCardDraggable(card, trip);
    cardsLayer.appendChild(card);
  });
  updateCards();
  renderLinks();
}

function renderLinks() {
  const lines = state.trips.map((trip) => {
    const point = projectedPoint(trip);
    const card = cardsLayer.querySelector(`[data-id="${trip.id}"]`);
    if (!point || !card) return null;
    const rect = card.getBoundingClientRect();
    const wrapRect = document.querySelector('#mapWrap').getBoundingClientRect();
    return { id: trip.id, x1: point.x, y1: point.y, x2: rect.left - wrapRect.left + rect.width / 2, y2: rect.top - wrapRect.top + rect.height / 2 };
  }).filter(Boolean);

  linkSvg.selectAll('line')
    .data(lines, (d) => d.id)
    .join('line')
    .attr('x1', (d) => d.x1)
    .attr('y1', (d) => d.y1)
    .attr('x2', (d) => d.x2)
    .attr('y2', (d) => d.y2)
    .attr('stroke', '#475569')
    .attr('stroke-width', 1.4);
}

function cardWidthForRatio(ratio) {
  return Math.round(Math.max(150, Math.min(360, 220 * ratio)));
}

function coverAspectRatio(trip) {
  const meta = trip.cover_meta;
  if (!meta?.width || !meta?.height) return 4 / 3;
  return Math.max(0.55, Math.min(2.6, meta.width / meta.height));
}

function makeCardDraggable(card, trip) {
  let startX = 0;
  let startY = 0;
  let left = 0;
  let top = 0;
  let moved = false;

  card.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startX = event.clientX;
    startY = event.clientY;
    left = ((parseFloat(card.style.left) || 0) - state.transform.x) / state.transform.k;
    top = ((parseFloat(card.style.top) || 0) - state.transform.y) / (state.transform.k * 1.18);
    moved = false;
    card.setPointerCapture(event.pointerId);
  });

  card.addEventListener('pointermove', (event) => {
    event.preventDefault();
    if (!card.hasPointerCapture(event.pointerId)) return;
    const dx = (event.clientX - startX) / state.transform.k;
    const dy = (event.clientY - startY) / (state.transform.k * 1.18);
    if (Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) > 3) moved = true;
    trip.card_position_x = left + dx;
    trip.card_position_y = top + dy;
    updateCards();
    renderLinks();
  });

  card.addEventListener('pointerup', async (event) => {
    if (!card.hasPointerCapture(event.pointerId)) return;
    card.releasePointerCapture(event.pointerId);
    card.dataset.dragging = String(moved);
    setTimeout(() => { card.dataset.dragging = 'false'; }, 0);
    if (moved) {
      const fd = new FormData();
      fd.append('card_position_x', trip.card_position_x);
      fd.append('card_position_y', trip.card_position_y);
      await fetch(`/api/trips/${trip.id}`, { method: 'PUT', body: fd });
    }
  });
}

function openAdd() {
  state.selected = null;
  form.reset();
  quill.setContents([]);
  resetMediaPreviews();
  document.querySelector('#dialogTitle').textContent = '添加旅行';
  editBtn.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  setFormEnabled(true);
  dialog.showModal();
}

async function openDetail(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  state.selected = trip;
  form.reset();
  document.querySelector('#dialogTitle').textContent = trip.name || '旅行详情';
  form.elements.id.value = trip.id;
  ['name', 'province', 'city', 'address_detail', 'latitude', 'longitude', 'start_date', 'end_date', 'participants'].forEach((name) => {
    form.elements[name].value = trip[name] || '';
  });
  quill.root.innerHTML = trip.rich_text_path || '';
  renderCoverPreview(trip.cover_path, trip.cover_meta);
  deleteBtn.classList.remove('hidden');
  await renderFiles(id);
  setFormEnabled(false);
  dialog.showModal();
}

async function renderFiles(id) {
  const files = await fetch(`/api/trips/${id}/files`).then((res) => res.json());
  filesPanel.classList.remove('hidden');
  filesPanel.innerHTML = `
    <div><h3>已上传相册</h3><div class="album-grid">${files.album.map((file) => `<a class="album-tile glightbox" href="${file.url}" data-gallery="trip-album"><img src="${file.thumb}" alt="${escapeHtml(file.name)}"></a>`).join('') || '<span class="empty-text">暂无图片</span>'}</div></div>
    <div><h3>附件</h3><ul class="file-list">${files.attachments.map((file) => `<li><a href="${file.url}" target="_blank">${escapeHtml(file.name)}</a></li>`).join('') || '<li>暂无附件</li>'}</ul></div>
  `;
  if (lightbox) lightbox.destroy();
  lightbox = GLightbox({ selector: '.glightbox' });
}

async function submitForm(event) {
  event.preventDefault();
  const fd = new FormData(form);
  fd.append('rich_text', quill.root.innerHTML);
  const id = form.elements.id.value;
  const url = id ? `/api/trips/${id}` : '/api/trips';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: fd });
  if (!res.ok) throw new Error(await res.text());
  dialog.close();
  await loadTrips();
}

async function deleteSelected() {
  if (!state.selected) return;
  if (!confirm(`删除“${state.selected.name}”？此操作会删除对应媒体文件。`)) return;
  await fetch(`/api/trips/${state.selected.id}`, { method: 'DELETE' });
  dialog.close();
  await loadTrips();
}

async function insertEditorImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  fd.append('id', form.elements.id.value || 'draft');
  const res = await fetch('/api/uploads/richtext', { method: 'POST', body: fd });
  const data = await res.json();
  const range = quill.getSelection(true);
  quill.insertEmbed(range.index, 'image', data.url);
  quill.setSelection(range.index + 1);
}

function initEditor() {
  quill = new Quill('#richEditor', {
    theme: 'snow',
    modules: {
      toolbar: [['bold', 'italic', 'underline'], [{ header: [1, 2, 3, false] }], [{ list: 'ordered' }, { list: 'bullet' }], ['link', 'image'], ['clean']]
    }
  });
  quill.getModule('toolbar').addHandler('image', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      if (input.files[0]) insertEditorImage(input.files[0]);
    };
    input.click();
  });
}

function renderCoverPreview(url, meta) {
  if (!url) {
    coverPreview.removeAttribute('src');
    coverPreview.style.display = 'none';
    coverPreview.style.aspectRatio = '4 / 3';
    coverPreviewText.textContent = '点击图片上传更换图片';
    return;
  }
  coverPreview.src = url;
  coverPreview.style.display = 'block';
  coverPreview.style.aspectRatio = `${meta?.width || 4} / ${meta?.height || 3}`;
  coverPreviewText.textContent = pathFileName(url);
}

function resetMediaPreviews() {
  filesPanel.classList.add('hidden');
  albumPreview.innerHTML = '';
  renderCoverPreview('', null);
}

function previewCoverFile() {
  const file = coverInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    renderCoverPreview(url, { width: image.naturalWidth, height: image.naturalHeight });
    coverPreviewText.textContent = file.name;
  };
  image.src = url;
}

function previewAlbumFiles() {
  albumPreview.innerHTML = Array.from(albumInput.files || []).map((file) => {
    const url = URL.createObjectURL(file);
    return `<a class="album-tile" href="${url}" target="_blank"><img src="${url}" alt="${escapeHtml(file.name)}"></a>`;
  }).join('');
}

function pathFileName(url) {
  return decodeURIComponent(String(url).split('/').pop() || '封面.jpg');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

document.querySelector('#addTripBtn').addEventListener('click', openAdd);
form.addEventListener('submit', submitForm);
closeBtn.addEventListener('click', () => dialog.close());
editBtn.addEventListener('click', () => setFormEnabled(true));
deleteBtn.addEventListener('click', deleteSelected);
coverInput.addEventListener('change', previewCoverFile);
albumInput.addEventListener('change', previewAlbumFiles);
window.addEventListener('resize', () => location.reload());

initEditor();
initMap().catch((error) => {
  console.error(error);
  alert('地图加载失败，请检查 china_provinces.geojson。');
});
