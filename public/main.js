const state = {
  trips: [],
  selected: null,
  editing: true,
  projection: null,
  path: null,
  transform: d3.zoomIdentity,
  settings: {
    card_max_width: 360,
    card_title_font_size: 16,
    card_meta_font_size: 13,
    card_scale: 1
  },
  regions: {
    provinces: [],
    citiesByProvince: new Map()
  },
  pickingCoordinate: false,
  role: 'guest'
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
const hiddenAlbumInput = document.querySelector('#hiddenAlbumInput');
const hiddenAttachmentInput = document.querySelector('#hiddenAttachmentInput');
const participantState = {
  all: [],
  selected: [],
  dropdownVisible: false
};
const tagSelector = document.querySelector('#participantTagSelector');
const tagContainer = tagSelector.querySelector('.tag-selector-container');
const tagList = tagSelector.querySelector('.tag-list');
const tagInput = tagSelector.querySelector('.tag-input');
const tagDropdown = tagSelector.querySelector('.tag-dropdown');
const participantsHidden = form.elements.participants;
let pendingAlbumFiles = [];
let pendingAttachmentFiles = [];
const settingsBtn = document.querySelector('#settingsBtn');
const cardScaleRange = document.querySelector('#cardScaleRange');
const cardScaleValue = document.querySelector('#cardScaleValue');
const pickCoordinateBtn = document.querySelector('#pickCoordinateBtn');
const provinceOptions = document.querySelector('#provinceOptions');
const cityOptions = document.querySelector('#cityOptions');
const mapWrap = document.querySelector('#mapWrap');
const mapHint = document.querySelector('.map-hint');
const defaultMapHint = mapHint.textContent;

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
  form.querySelectorAll('input, button').forEach((element) => {
    if (element.type !== 'hidden' && !['editBtn', 'deleteBtn', 'closeBtn'].includes(element.id)) element.disabled = !enabled;
  });
  quill.enable(enabled);
  saveBtn.classList.toggle('hidden', !enabled);
  editBtn.classList.toggle('hidden', enabled || !state.selected);
  tagInput.disabled = !enabled;
  tagList.querySelectorAll('.tag-remove').forEach((btn) => { btn.style.display = enabled ? '' : 'none'; });
  if (!enabled) hideTagDropdown();
}

function showTripDialog() {
  dialog.classList.remove('hidden');
}

function hideTripDialog() {
  dialog.classList.add('hidden');
}

async function loadRegions() {
  const res = await fetch('/api/regions');
  if (!res.ok) throw new Error(await res.text());
  const payload = await res.json();
  const regions = payload.data || [];
  state.regions.provinces = regions.filter((region) => region.level === 1);
  state.regions.citiesByProvince = regions.filter((region) => region.level === 2).reduce((map, city) => {
    const cities = map.get(city.parent_code) || [];
    cities.push(city);
    map.set(city.parent_code, cities);
    return map;
  }, new Map());
  provinceOptions.replaceChildren(...state.regions.provinces.map((province) => {
    const opt = document.createElement('option');
    opt.value = province.name;
    return opt;
  }));
  updateCityOptions();
}

function updateCityOptions() {
  const province = state.regions.provinces.find((item) => item.name === form.elements.province.value);
  const cities = province ? state.regions.citiesByProvince.get(province.code) || [] : [];
  cityOptions.replaceChildren(...cities.map((city) => {
    const opt = document.createElement('option');
    opt.value = city.name;
    return opt;
  }));
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    state.role = (await res.json()).role;
    applyRole();
  } catch { state.role = 'guest'; }
}

function applyRole() {
  const isGuest = state.role === 'guest';
  document.querySelector('#addTripBtn').classList.toggle('hidden', isGuest);
  settingsBtn.onclick = isGuest ? () => { window.location.href = '/login.html?redirect=/settings.html'; } : () => { window.location.href = '/settings.html'; };
}

async function loadSettings() {
  const res = await fetch('/api/settings');
  state.settings = { ...state.settings, ...await res.json() };
  applySettings();
}

function applySettings() {
  document.documentElement.style.setProperty('--card-title-font-size', `${state.settings.card_title_font_size}px`);
  document.documentElement.style.setProperty('--card-meta-font-size', `${state.settings.card_meta_font_size}px`);
  if (cardScaleRange) cardScaleRange.value = Math.round(state.settings.card_scale * 100);
  if (cardScaleValue) cardScaleValue.textContent = `${Math.round(state.settings.card_scale * 100)}%`;
}

async function saveSettings(partial = {}) {
  state.settings = { ...state.settings, ...partial };
  applySettings();
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.settings)
  });
  if (!res.ok) throw new Error(await res.text());
  state.settings = await res.json();
  applySettings();
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
  geojson.features.forEach((feature) => {
    feature._labelPoint = labelPoint(feature);
  });
  provinceLabelsGroup.selectAll('text')
    .data(geojson.features)
    .join('text')
    .attr('class', 'province-label')
    .attr('x', (d) => d._labelPoint.x)
    .attr('y', (d) => d._labelPoint.y)
    .text((d) => d.properties.name || d.properties.fullname || '');
  updateProvinceLabels();

  pinsGroup = mapSvg.append('g').attr('class', 'pins-layer');

  mapSvg.call(d3.zoom().scaleExtent([0.1, 8]).on('zoom', (event) => {
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

function labelPoint(feature) {
  return interiorLabelPoint(feature) || centroidPoint(feature);
}

function centroidPoint(feature) {
  const base = state.path.centroid(feature);
  return { x: base[0], y: base[1] };
}

function interiorLabelPoint(feature) {
  const polygons = projectedPolygons(feature).filter((polygon) => polygon[0]?.length >= 3);
  let best = null;
  polygons.forEach((polygon) => {
    const candidate = bestPointInPolygon(polygon);
    if (candidate && (!best || candidate.distance > best.distance)) best = candidate;
  });
  return best ? { x: best.x, y: best.y } : null;
}

function projectedPolygons(feature) {
  const geometry = feature.geometry || {};
  const coordinates = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates || [];
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return [];
  return coordinates.map((polygon) => polygon.map((ring) => ring.map((coord) => state.projection(coord)).filter(Boolean)));
}

function bestPointInPolygon(polygon) {
  const outer = polygon[0];
  const bounds = outer.reduce((box, point) => ({
    minX: Math.min(box.minX, point[0]),
    minY: Math.min(box.minY, point[1]),
    maxX: Math.max(box.maxX, point[0]),
    maxY: Math.max(box.maxY, point[1])
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  let step = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 18;
  let best = null;

  for (let pass = 0; pass < 5 && step > 0.1; pass += 1) {
    const startX = best ? best.x - step : bounds.minX;
    const endX = best ? best.x + step : bounds.maxX;
    const startY = best ? best.y - step : bounds.minY;
    const endY = best ? best.y + step : bounds.maxY;
    for (let x = startX; x <= endX; x += step) {
      for (let y = startY; y <= endY; y += step) {
        if (!isPointInPolygonRings([x, y], polygon)) continue;
        const distance = distanceToPolygonRings([x, y], polygon);
        if (!best || distance > best.distance) best = { x, y, distance };
      }
    }
    step /= 3;
  }

  return best;
}

function isPointInPolygonRings(point, polygon) {
  return d3.polygonContains(polygon[0], point) && polygon.slice(1).every((ring) => !d3.polygonContains(ring, point));
}

function distanceToPolygonRings(point, polygon) {
  return Math.min(...polygon.flatMap((ring) => ring.map((current, index) => {
    const next = ring[(index + 1) % ring.length];
    return distanceToSegment(point, current, next);
  })));
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared)) : 0;
  const x = start[0] + t * dx;
  const y = start[1] + t * dy;
  return Math.hypot(point[0] - x, point[1] - y);
}

function updateProvinceLabels() {
  provinceLabelsGroup.selectAll('text')
    .attr('transform', (d) => {
      const { x, y } = d._labelPoint;
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

function beginCoordinatePick() {
  if (!state.editing) return;
  state.pickingCoordinate = true;
  hideTripDialog();
  mapWrap.classList.add('picking-coordinate');
  mapHint.textContent = '点击地图选择经纬度，按 Esc 取消。';
}

function finishCoordinatePick(event) {
  if (!state.pickingCoordinate || event.target.closest('.trip-card')) return;
  const rect = mapWrap.getBoundingClientRect();
  const point = [
    (event.clientX - rect.left - state.transform.x) / state.transform.k,
    (event.clientY - rect.top - state.transform.y) / (state.transform.k * 1.18)
  ];
  const coord = state.projection.invert(point);
  if (coord) {
    form.elements.longitude.value = coord[0].toFixed(4);
    form.elements.latitude.value = coord[1].toFixed(4);
  }
  cancelCoordinatePick(true);
}

function cancelCoordinatePick(restoreDialog = false) {
  if (!state.pickingCoordinate) return;
  state.pickingCoordinate = false;
  mapWrap.classList.remove('picking-coordinate');
  mapHint.textContent = defaultMapHint;
  if (restoreDialog) showTripDialog();
}

function updateCards() {
  state.trips.forEach((trip) => {
    const card = cardsLayer.querySelector(`[data-id="${trip.id}"]`);
    if (!card) return;
    const baseWidth = cardWidthForTrip(trip);
    const x = state.transform.x + (trip.card_position_x || 40) * state.transform.k;
    const y = state.transform.y + (trip.card_position_y || 90) * state.transform.k * 1.18;
    card.style.width = `${baseWidth}px`;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.transform = `scale(${state.transform.k * state.settings.card_scale})`;
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
      ${trip.cover_path ? `<img class="card-cover" src="${trip.cover_path}" alt="${escapeHtml(trip.name)}" draggable="false">` : '<div class="card-cover no-cover">无封面</div>'}
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

function cardWidthForTrip(trip) {
  const meta = trip.cover_meta;
  const maxWidth = state.settings.card_max_width;
  const minWidth = Math.min(120, maxWidth);
  if (!meta?.width || !meta?.height) return Math.round(Math.min(180, maxWidth));
  return Math.round(Math.max(minWidth, Math.min(maxWidth, meta.width)));
}

function coverAspectRatio(trip) {
  const meta = trip.cover_meta;
  if (!meta?.width || !meta?.height) return 1400 / 2097;
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
    if (moved && state.role === 'admin') {
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
  participantState.selected = [];
  renderTags();
  renderDropdown();
  tagInput.disabled = false;
  document.querySelector('#dialogTitle').textContent = '添加旅行';
  editBtn.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  setFormEnabled(true);
  showTripDialog();
}

async function openDetail(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  state.selected = trip;
  form.reset();
  document.querySelector('#dialogTitle').textContent = trip.name || '旅行详情';
  form.elements.id.value = trip.id;
  ['name', 'province', 'city', 'address_detail', 'latitude', 'longitude', 'start_date', 'end_date'].forEach((name) => {
    form.elements[name].value = trip[name] || '';
  });
  const names = trip.participants ? trip.participants.split(',').map((s) => s.trim()).filter(Boolean) : [];
  participantState.selected = [...names];
  names.forEach((name) => {
    if (!participantState.all.some((p) => p.name === name)) {
      participantState.all.push({ id: null, name, count: 0, last_participated_at: '' });
    }
  });
  participantState.all.sort((a, b) => b.count - a.count);
  renderTags();
  renderDropdown();
  tagInput.disabled = true;
  updateCityOptions();
  quill.root.innerHTML = trip.rich_text_path || '';
  renderCoverPreview(trip.cover_path, trip.cover_meta);
  deleteBtn.classList.remove('hidden');
  setFormEnabled(false);
  await renderFiles(id);
  showTripDialog();
}

async function renderFiles(id) {
  const files = await fetch(`/api/trips/${id}/files`).then((res) => res.json());
  filesPanel.classList.remove('hidden');
  filesPanel.innerHTML = `
    <div>
      <div class="files-section-head">
        <h3>已上传相册</h3>
        ${state.editing ? '<button type="button" class="upload-inline" id="addAlbumBtn">添加照片</button>' : ''}
      </div>
      <div class="album-grid">${files.album.map((file, index) => state.editing
        ? `<div class="album-tile"><a class="glightbox" href="${file.url}" data-index="${index}" data-gallery="trip-album"><img src="${file.thumb}" alt="${escapeHtml(file.name)}"></a><button class="delete-btn" data-type="album" data-name="${escapeHtml(file.name)}">&times;</button></div>`
        : `<a class="album-tile glightbox" href="${file.url}" data-index="${index}" data-gallery="trip-album"><img src="${file.thumb}" alt="${escapeHtml(file.name)}"></a>`
      ).join('') || '<span class="empty-text">暂无图片</span>'}</div>
    </div>
    <div>
      <div class="files-section-head">
        <h3>附件</h3>
        ${state.editing ? '<button type="button" class="upload-inline" id="addAttachmentBtn">添加附件</button>' : ''}
      </div>
      <ul class="file-list">${files.attachments.map((file) => state.editing
        ? `<li><a href="${file.url}" target="_blank">${escapeHtml(file.name)}</a><button class="delete-btn" data-type="attachments" data-name="${escapeHtml(file.name)}">&times;</button></li>`
        : `<li><a href="${file.url}" target="_blank">${escapeHtml(file.name)}</a></li>`
      ).join('') || '<li>暂无附件</li>'}</ul>
    </div>
  `;
  setupLightbox(files);
  if (state.editing) {
    const addAlbumBtn = filesPanel.querySelector('#addAlbumBtn');
    const addAttachmentBtn = filesPanel.querySelector('#addAttachmentBtn');
    if (addAlbumBtn) addAlbumBtn.addEventListener('click', () => hiddenAlbumInput.click());
    if (addAttachmentBtn) addAttachmentBtn.addEventListener('click', () => hiddenAttachmentInput.click());
    hiddenAlbumInput.onchange = () => handleAlbumUpload(id);
    hiddenAttachmentInput.onchange = () => handleAttachmentUpload(id);
  }
}

function setupLightbox(files) {
  if (lightbox) lightbox.destroy();
  const elements = files.album.map((file) => ({ href: file.url, type: 'image' }));
  lightbox = GLightbox({ elements });
  filesPanel.querySelectorAll('.glightbox').forEach((link) => {
     link.addEventListener('click', (event) => {
       event.preventDefault();
       lightbox.openAt(Number(link.dataset.index) || 0);
     });
   });
}

async function handleAlbumUpload(id) {
  const files = hiddenAlbumInput.files;
  if (!files.length) return;
  if (id) {
    await uploadFiles(id, 'album', files);
    hiddenAlbumInput.value = '';
    await renderFiles(id);
  } else {
    pendingAlbumFiles.push(...files);
    previewPendingAlbum();
    hiddenAlbumInput.value = '';
  }
}

async function handleAttachmentUpload(id) {
  const files = hiddenAttachmentInput.files;
  if (!files.length) return;
  if (id) {
    await uploadFiles(id, 'attachments', files);
    hiddenAttachmentInput.value = '';
    await renderFiles(id);
  } else {
    pendingAttachmentFiles.push(...files);
    previewPendingAttachments();
    hiddenAttachmentInput.value = '';
  }
}

function removePendingAlbum(index) {
  pendingAlbumFiles.splice(index, 1);
  previewPendingAlbum();
}

function removePendingAttachment(index) {
  pendingAttachmentFiles.splice(index, 1);
  previewPendingAttachments();
}

function previewPendingAlbum() {
  const grid = filesPanel.querySelector('.album-grid');
  if (grid) {
    grid.innerHTML = pendingAlbumFiles.map((file, i) => {
      const url = URL.createObjectURL(file);
      return `<div class="album-tile"><img src="${url}" alt="${escapeHtml(file.name)}" style="width:100%;height:100%;object-fit:contain;"><button class="delete-btn" data-pending="album" data-index="${i}">&times;</button></div>`;
    }).join('') || '<span class="empty-text">暂无图片</span>';
  }
}

function previewPendingAttachments() {
  const list = filesPanel.querySelector('.file-list');
  if (list) {
    list.innerHTML = pendingAttachmentFiles.map((file, i) => `<li><span>${escapeHtml(file.name)}</span><button class="delete-btn" data-pending="attachments" data-index="${i}">&times;</button></li>`).join('') || '<li>暂无附件</li>';
  }
}

async function uploadFiles(id, field, fileList) {
  const fd = new FormData();
  for (const file of fileList) fd.append(field, file);
  const res = await fetch(`/api/trips/${id}/files`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());
}

async function deleteFile(id, type, name) {
  const res = await fetch(`/api/trips/${id}/files?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

async function submitForm(event) {
  event.preventDefault();
  const fd = new FormData(form);
  fd.append('rich_text', quill.root.innerHTML);
  pendingAlbumFiles.forEach((file) => fd.append('album', file));
  pendingAttachmentFiles.forEach((file) => fd.append('attachments', file));
  const id = form.elements.id.value;
  const url = id ? `/api/trips/${id}` : '/api/trips';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: fd });
  if (!res.ok) throw new Error(await res.text());
  if (participantState.selected.length) {
    await fetch('/api/participants/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: participantState.selected })
    });
  }
  hideTripDialog();
  await loadTrips();
}

async function deleteSelected() {
  if (!state.selected) return;
  if (!confirm(`删除“${state.selected.name}”？此操作会删除对应媒体文件。`)) return;
  await fetch(`/api/trips/${state.selected.id}`, { method: 'DELETE' });
  hideTripDialog();
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
  coverPreviewText.textContent = '点击上传或更换图片';
  if (!url) {
    coverPreview.removeAttribute('src');
    coverPreview.style.display = 'none';
    coverPreview.style.aspectRatio = '4 / 3';
    return;
  }
  coverPreview.src = url;
  coverPreview.style.display = 'block';
  coverPreview.style.aspectRatio = `${meta?.width || 4} / ${meta?.height || 3}`;
}

function resetMediaPreviews() {
  pendingAlbumFiles = [];
  pendingAttachmentFiles = [];
  renderCoverPreview('', null);
  filesPanel.classList.remove('hidden');
  filesPanel.innerHTML = `
    <div>
      <div class="files-section-head">
        <h3>已上传相册</h3>
        <button type="button" class="upload-inline" id="addAlbumBtn">添加照片</button>
      </div>
      <div class="album-grid"><span class="empty-text">暂无图片</span></div>
    </div>
    <div>
      <div class="files-section-head">
        <h3>附件</h3>
        <button type="button" class="upload-inline" id="addAttachmentBtn">添加附件</button>
      </div>
      <ul class="file-list"><li>暂无附件</li></ul>
    </div>
  `;
  filesPanel.querySelector('#addAlbumBtn').addEventListener('click', () => hiddenAlbumInput.click());
  filesPanel.querySelector('#addAttachmentBtn').addEventListener('click', () => hiddenAttachmentInput.click());
  hiddenAlbumInput.onchange = () => handleAlbumUpload(null);
  hiddenAttachmentInput.onchange = () => handleAttachmentUpload(null);
  if (lightbox) { lightbox.destroy(); lightbox = null; }
}

function previewCoverFile() {
  const file = coverInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    renderCoverPreview(url, { width: image.naturalWidth, height: image.naturalHeight });
  };
  image.src = url;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function syncParticipantHidden() {
  participantsHidden.value = participantState.selected.join(',');
}

async function loadParticipants() {
  try {
    const res = await fetch('/api/participants');
    if (res.ok) {
      const data = await res.json();
      if (data.length) {
        participantState.all = data;
        return;
      }
    }
  } catch { /* use mock */ }
  const names = ['张三', '李四', '王五', '赵六', '孙七', '周八', '吴九', '郑十', '钱十一', '陈十二'];
  participantState.all = names.map((name) => ({
    id: null,
    name,
    count: Math.floor(Math.random() * 10) + 1,
    last_participated_at: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString()
  })).sort((a, b) => b.count - a.count);
}

function renderTags() {
  tagList.innerHTML = participantState.selected.map((name) =>
    `<span class="tag-item">${escapeHtml(name)}<span class="tag-remove" data-name="${escapeHtml(name)}">&times;</span></span>`
  ).join('');
  if (!state.editing) {
    tagList.querySelectorAll('.tag-remove').forEach((btn) => { btn.style.display = 'none'; });
  }
  syncParticipantHidden();
}

function renderDropdown(query = '') {
  const filter = String(query || '').trim().toLowerCase();
  const selectedSet = new Set(participantState.selected);
  const items = participantState.all.filter((p) => {
    if (selectedSet.has(p.name)) return true;
    if (!filter) return true;
    return p.name.toLowerCase().includes(filter);
  });
  items.sort((a, b) => {
    const aSel = selectedSet.has(a.name) ? 1 : 0;
    const bSel = selectedSet.has(b.name) ? 1 : 0;
    if (aSel !== bSel) return aSel - bSel;
    return b.count - a.count;
  });
  tagDropdown.innerHTML = items.length
    ? items.map((p) => {
        const sel = selectedSet.has(p.name);
        return `<li class="tag-dropdown-item ${sel ? 'selected' : 'available'}" data-name="${escapeHtml(p.name)}">
          <span>${escapeHtml(p.name)}</span>
          <span class="count">参与${p.count}次</span>
        </li>`;
      }).join('')
    : (filter ? '<li class="tag-dropdown-empty">按回车添加「' + escapeHtml(filter) + '」</li>' : '<li class="tag-dropdown-empty">暂无人员数据</li>');
}

function showTagDropdown() {
  participantState.dropdownVisible = true;
  tagDropdown.classList.remove('hidden');
  renderDropdown(tagInput.value);
}

function hideTagDropdown() {
  participantState.dropdownVisible = false;
  tagDropdown.classList.add('hidden');
}

function addTag(name) {
  name = String(name).trim();
  if (!name || participantState.selected.includes(name)) return;
  participantState.selected.push(name);
  if (!participantState.all.some((p) => p.name === name)) {
    participantState.all.push({ id: null, name, count: 0, last_participated_at: new Date().toISOString() });
  }
  renderTags();
  renderDropdown(tagInput.value);
  tagInput.value = '';
}

function removeTag(name) {
  participantState.selected = participantState.selected.filter((n) => n !== name);
  renderTags();
  renderDropdown(tagInput.value);
}

tagContainer.addEventListener('click', (event) => {
  if (!state.editing) return;
  if (event.target.closest('.tag-remove')) {
    const name = event.target.closest('.tag-remove').dataset.name;
    if (name) removeTag(name);
    return;
  }
  tagInput.focus();
  showTagDropdown();
});

tagInput.addEventListener('input', () => {
  showTagDropdown();
});

tagInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = tagInput.value.trim();
    if (!value) return;
    const match = participantState.all.find((p) => p.name === value);
    if (match) {
      addTag(match.name);
    } else {
      addTag(value);
    }
  }
  if (event.key === 'Escape') {
    hideTagDropdown();
  }
});

tagDropdown.addEventListener('mousedown', (event) => {
  event.preventDefault();
  const item = event.target.closest('.tag-dropdown-item');
  if (!item) return;
  const name = item.dataset.name;
  if (!name) return;
  if (participantState.selected.includes(name)) return;
  addTag(name);
  hideTagDropdown();
  tagInput.focus();
});

document.addEventListener('click', (event) => {
  if (!tagSelector.contains(event.target)) {
    hideTagDropdown();
  }
});

document.querySelector('#addTripBtn').addEventListener('click', openAdd);
settingsBtn.addEventListener('click', () => { window.location.href = '/settings.html'; });
pickCoordinateBtn.addEventListener('click', beginCoordinatePick);
form.elements.province.addEventListener('input', updateCityOptions);
mapWrap.addEventListener('click', finishCoordinatePick);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancelCoordinatePick(true);
});
cardScaleRange.addEventListener('input', () => {
  state.settings.card_scale = Number(cardScaleRange.value) / 100;
  applySettings();
  updateCards();
  renderLinks();
});
cardScaleRange.addEventListener('change', () => {
  if (state.role === 'guest') return;
  saveSettings({ card_scale: Number(cardScaleRange.value) / 100 }).catch((error) => alert(error.message));
});
form.addEventListener('submit', submitForm);
closeBtn.addEventListener('click', hideTripDialog);
editBtn.addEventListener('click', () => {
  setFormEnabled(true);
  if (state.selected) renderFiles(state.selected.id);
});
deleteBtn.addEventListener('click', deleteSelected);
coverInput.addEventListener('change', previewCoverFile);
filesPanel.addEventListener('click', async (event) => {
  const btn = event.target.closest('.delete-btn');
  if (!btn) return;
  event.stopPropagation();
  event.preventDefault();
  const pending = btn.dataset.pending;
  if (pending) {
    const index = Number(btn.dataset.index);
    if (pending === 'album') removePendingAlbum(index);
    else if (pending === 'attachments') removePendingAttachment(index);
    return;
  }
  const type = btn.dataset.type;
  const name = btn.dataset.name;
  if (type && name && state.selected) {
    if (!confirm(`确定删除 ${type === 'album' ? '照片' : '附件'} "${name}"？`)) return;
    try {
      await deleteFile(state.selected.id, type, name);
      await renderFiles(state.selected.id);
    } catch (error) {
      alert(`删除失败: ${error.message}`);
    }
  }
});
window.addEventListener('resize', () => location.reload());

initEditor();
Promise.all([checkAuth(), loadSettings(), loadRegions(), loadParticipants()]).then(initMap).catch((error) => {
  console.error(error);
  alert('地图加载失败，请检查 china_provinces.geojson。');
});
