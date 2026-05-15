const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const db = require('./db');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: '需要管理员登录' });
}
const rootDir = path.join(__dirname, '..');
const mediaDir = path.join(rootDir, 'media');
const recycleDir = path.join(rootDir, 'media_recycle');
const tempDir = path.join(mediaDir, '.tmp');

const settingDefaults = {
  card_max_width: 360,
  card_title_font_size: 16,
  card_meta_font_size: 13,
  card_scale: 1,
  map_stretch: 1
};

fs.mkdirSync(tempDir, { recursive: true });

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SAFE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.mp4', '.mov', '.txt']);
const MB = 1024 * 1024;

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!SAFE_EXT.has(ext)) return cb(new Error(`不支持的文件类型: ${ext}`));
  if (file.fieldname !== 'attachments' && !IMAGE_MIMES.has(file.mimetype)) {
    return cb(new Error(`仅支持图片格式: ${file.mimetype}`));
  }
  cb(null, true);
}

const upload = multer({
  dest: tempDir,
  fileFilter,
  limits: { fileSize: 200 * MB }
});
const tripFields = upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'album', maxCount: 100 },
  { name: 'attachments', maxCount: 100 },
  { name: 'richtextImages', maxCount: 100 }
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toPublicPath(filePath) {
  return `/${path.relative(rootDir, filePath).replace(/\\/g, '/')}`;
}

function safeName(name) {
  return path.basename(name || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function textHash(value) {
  let hash = 0;
  const text = String(value || '00');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 10000;
  return String(hash).padStart(4, '0');
}

function makeTripId(province, city) {
  const provincePart = textHash(province).slice(0, 4);
  const cityPart = textHash(city).slice(0, 4);
  let id;
  do {
    id = `${provincePart}${cityPart}${Math.random().toString(36).slice(2, 8)}`;
  } while (db.prepare('SELECT 1 FROM trips WHERE id = ?').get(id));
  return id;
}

function pathsFor(id) {
  return {
    rich: path.join(mediaDir, 'richtext_images', id),
    album: path.join(mediaDir, 'album', id),
    attachments: path.join(mediaDir, 'attachments', id)
  };
}

function normalizeTrip(row) {
  if (!row) return null;
  return {
    ...row,
    cover_meta: row.cover_meta ? JSON.parse(row.cover_meta) : null
  };
}

function fileList(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => !name.startsWith('thumb_')).map((name) => ({
    name,
    url: toPublicPath(path.join(dir, name))
  }));
}

async function processImage(input, output, options = {}) {
  const image = sharp(input).rotate();
  if (options.resize) image.resize(options.resize);
  await image.jpeg({ quality: options.quality || 82, mozjpeg: true }).toFile(output);
}

async function saveUploads(id, files = {}) {
  const dirs = pathsFor(id);
  Object.values(dirs).forEach(ensureDir);
  let coverPath = null;
  let coverMeta = null;

  if (files.cover?.[0]) {
    const output = path.join(dirs.album, `cover_${id}.jpg`);
    const metadata = await sharp(files.cover[0].path).metadata();
    await processImage(files.cover[0].path, output, { resize: { width: 1400, withoutEnlargement: true }, quality: 78 });
    fs.unlinkSync(files.cover[0].path);
    coverPath = toPublicPath(output);
    coverMeta = { width: metadata.width || 4, height: metadata.height || 3 };
  }

  for (const file of files.album || []) {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const target = path.join(dirs.album, safeName(name));
    const thumb = path.join(dirs.album, `thumb_${safeName(name)}.jpg`);
    fs.renameSync(file.path, target);
    try {
      await processImage(target, thumb, { resize: { width: 320, height: 220, fit: 'inside', withoutEnlargement: true }, quality: 72 });
    } catch {
      if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
    }
  }

  for (const file of files.attachments || []) {
    const target = path.join(dirs.attachments, `${Date.now()}_${safeName(file.originalname)}`);
    fs.renameSync(file.path, target);
  }

  for (const file of files.richtextImages || []) {
    const target = path.join(dirs.rich, `${Date.now()}_${safeName(file.originalname)}`);
    fs.renameSync(file.path, target);
  }

  return {
    rich_text_path: toPublicPath(dirs.rich),
    album_path: toPublicPath(dirs.album),
    attachments_path: toPublicPath(dirs.attachments),
    cover_path: coverPath,
    cover_meta: coverMeta
  };
}

function cleanupTemp(files = {}) {
  Object.values(files).flat().forEach((file) => {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function roundCoordinate(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : null;
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return rows.reduce((settings, row) => ({
    ...settings,
    [row.key]: Number(row.value)
  }), { ...settingDefaults });
}

function saveSettings(settings) {
  Object.entries(settings).forEach(([key, value]) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  });
}

function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function publicPathToFilePath(url) {
  if (!url || !String(url).startsWith('/media/')) return null;
  return path.join(rootDir, String(url).slice(1));
}

function extractMediaPaths(html) {
  return Array.from(String(html || '').matchAll(/["'](\/media\/[^"']+)["']/g), (match) => publicPathToFilePath(decodeURIComponent(match[1]))).filter(Boolean);
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(current) : [current];
  });
}

function moveToRecycle(filePath, stamp) {
  const relative = path.relative(rootDir, filePath);
  const target = path.join(recycleDir, stamp, relative);
  ensureDir(path.dirname(target));
  fs.renameSync(filePath, target);
  return target;
}

function cleanupMediaFiles() {
  const stamp = timestampName();
  const trips = db.prepare('SELECT id, cover_path, rich_text_path FROM trips').all();
  const tripIds = new Set(trips.map((trip) => trip.id));
  const keep = new Set();

  trips.forEach((trip) => {
    const cover = publicPathToFilePath(trip.cover_path);
    if (cover) keep.add(path.resolve(cover));
    extractMediaPaths(trip.rich_text_path).forEach((filePath) => keep.add(path.resolve(filePath)));
  });

  const moved = [];
  const roots = [path.join(mediaDir, 'album'), path.join(mediaDir, 'richtext_images')];
  roots.forEach((root) => {
    walkFiles(root).forEach((filePath) => {
      const relative = path.relative(root, filePath).split(path.sep);
      const tripId = relative[0];
      const name = path.basename(filePath);
      const resolved = path.resolve(filePath);
      const originalForThumb = name.startsWith('thumb_') ? path.join(path.dirname(filePath), name.slice(6, -4)) : null;
      const orphanTripDir = !tripIds.has(tripId);
      const draftRichText = root.endsWith(`richtext_images`) && tripId === 'draft';
      const unusedRichText = root.endsWith(`richtext_images`) && !keep.has(resolved);
      const orphanThumb = originalForThumb && !fs.existsSync(originalForThumb);
      if (orphanTripDir || draftRichText || unusedRichText || orphanThumb) {
        moved.push({ from: toPublicPath(filePath), to: path.relative(rootDir, moveToRecycle(filePath, stamp)).replace(/\\/g, '/') });
      }
    });
  });

  return { recycle_path: moved.length ? path.join('media_recycle', stamp).replace(/\\/g, '/') : '', moved_count: moved.length, moved };
}

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.put('/settings', requireAdmin, (req, res) => {
  const current = getSettings();
  const settings = {
    card_max_width: clampNumber(req.body.card_max_width, 0, 800, current.card_max_width),
    card_title_font_size: clampNumber(req.body.card_title_font_size, 0, 40, current.card_title_font_size),
    card_meta_font_size: clampNumber(req.body.card_meta_font_size, 0, 32, current.card_meta_font_size),
    card_scale: clampNumber(req.body.card_scale, 0.1, 1, current.card_scale),
    map_stretch: clampNumber(req.body.map_stretch, 0.5, 2, current.map_stretch)
  };
  saveSettings(settings);
  res.json(settings);
});

router.post('/cleanup-media', requireAdmin, (req, res, next) => {
  try {
    res.json(cleanupMediaFiles());
  } catch (error) {
    next(error);
  }
});

router.get('/regions', (req, res, next) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(rootDir, 'regions_L1_L2.json'), 'utf8')));
  } catch (error) {
    next(error);
  }
});

router.get('/trips', (req, res) => {
  const rows = db.prepare('SELECT * FROM trips ORDER BY created_at DESC').all().map(normalizeTrip);
  res.json(rows);
});

router.get('/trips/:id/files', (req, res) => {
  const dirs = pathsFor(req.params.id);
  const album = fileList(dirs.album).map((file) => ({
    ...file,
    thumb: fs.existsSync(path.join(dirs.album, `thumb_${file.name}.jpg`)) ? toPublicPath(path.join(dirs.album, `thumb_${file.name}.jpg`)) : file.url
  }));
  res.json({
    album,
    attachments: fileList(dirs.attachments),
    richtextImages: fileList(dirs.rich)
  });
});

router.post('/trips', requireAdmin, tripFields, async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    const id = makeTripId(req.body.province, req.body.city);
    const saved = await saveUploads(id, req.files);
    const trip = {
      id,
      name: req.body.name || '',
      province: req.body.province || '',
      city: req.body.city || '',
      address_detail: req.body.address_detail || '',
      latitude: roundCoordinate(req.body.latitude),
      longitude: roundCoordinate(req.body.longitude),
      start_date: req.body.start_date || '',
      end_date: req.body.end_date || '',
      participants: req.body.participants || '',
      rich_text_path: req.body.rich_text || '',
      album_path: saved.album_path,
      attachments_path: saved.attachments_path,
      cover_path: saved.cover_path || '',
      cover_meta: saved.cover_meta ? JSON.stringify(saved.cover_meta) : '',
      card_position_x: Number(req.body.card_position_x) || 104,
      card_position_y: Number(req.body.card_position_y) || 35,
      created_at: now,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO trips (id, name, province, city, address_detail, latitude, longitude, start_date, end_date, participants, rich_text_path, album_path, attachments_path, cover_path, cover_meta, card_position_x, card_position_y, created_at, updated_at)
      VALUES (@id, @name, @province, @city, @address_detail, @latitude, @longitude, @start_date, @end_date, @participants, @rich_text_path, @album_path, @attachments_path, @cover_path, @cover_meta, @card_position_x, @card_position_y, @created_at, @updated_at)
    `).run(trip);
    res.status(201).json(trip);
  } catch (error) {
    cleanupTemp(req.files);
    next(error);
  }
});

router.put('/trips/:id', requireAdmin, tripFields, async (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Trip not found' });
    const saved = await saveUploads(existing.id, req.files);
    const nextTrip = {
      id: existing.id,
      name: req.body.name ?? existing.name,
      province: req.body.province ?? existing.province,
      city: req.body.city ?? existing.city,
      address_detail: req.body.address_detail ?? existing.address_detail,
      latitude: req.body.latitude === undefined ? existing.latitude : roundCoordinate(req.body.latitude),
      longitude: req.body.longitude === undefined ? existing.longitude : roundCoordinate(req.body.longitude),
      start_date: req.body.start_date ?? existing.start_date,
      end_date: req.body.end_date ?? existing.end_date,
      participants: req.body.participants ?? existing.participants,
      rich_text_path: req.body.rich_text ?? existing.rich_text_path,
      album_path: saved.album_path || existing.album_path,
      attachments_path: saved.attachments_path || existing.attachments_path,
      cover_path: saved.cover_path || existing.cover_path,
      cover_meta: saved.cover_meta ? JSON.stringify(saved.cover_meta) : existing.cover_meta,
      card_position_x: req.body.card_position_x === undefined ? existing.card_position_x : Number(req.body.card_position_x),
      card_position_y: req.body.card_position_y === undefined ? existing.card_position_y : Number(req.body.card_position_y),
      updated_at: new Date().toISOString()
    };
    db.prepare(`
      UPDATE trips SET name=@name, province=@province, city=@city, address_detail=@address_detail, latitude=@latitude, longitude=@longitude, start_date=@start_date, end_date=@end_date, participants=@participants, rich_text_path=@rich_text_path, album_path=@album_path, attachments_path=@attachments_path, cover_path=@cover_path, cover_meta=@cover_meta, card_position_x=@card_position_x, card_position_y=@card_position_y, updated_at=@updated_at
      WHERE id=@id
    `).run(nextTrip);
    res.json(nextTrip);
  } catch (error) {
    cleanupTemp(req.files);
    next(error);
  }
});

router.delete('/trips/:id/files', requireAdmin, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT id FROM trips WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Trip not found' });
    const type = req.query.type;
    const name = req.query.name;
    if (!type || !name || !['album', 'attachments'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type or name' });
    }
    const dirs = pathsFor(existing.id);
    const filePath = path.join(dirs[type], safeName(name));
    const thumbPath = type === 'album' ? path.join(dirs.album, `thumb_${safeName(name)}.jpg`) : null;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.delete('/trips/:id', requireAdmin, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Trip not found' });
    db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
    const dirs = pathsFor(req.params.id);
    Object.values(dirs).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/trips/:id/files', requireAdmin, upload.fields([{ name: 'album', maxCount: 100 }, { name: 'attachments', maxCount: 100 }]), async (req, res, next) => {
  try {
    const existing = db.prepare('SELECT id, album_path, attachments_path FROM trips WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Trip not found' });
    if (!req.files || (!req.files.album?.length && !req.files.attachments?.length)) {
      return res.status(400).json({ error: 'No files provided' });
    }
    const saved = await saveUploads(existing.id, req.files);
    const updates = {};
    if (req.files.album?.length) updates.album_path = saved.album_path;
    if (req.files.attachments?.length) updates.attachments_path = saved.attachments_path;
    if (Object.keys(updates).length) {
      const pairs = Object.entries(updates);
      const sql = `UPDATE trips SET ${pairs.map(([key]) => `${key}=?`).join(', ')} WHERE id=?`;
      db.prepare(sql).run(...pairs.map(([, value]) => value), existing.id);
    }
    res.json({ ...saved, id: existing.id });
  } catch (error) {
    cleanupTemp(req.files);
    next(error);
  }
});

router.post('/uploads/richtext', requireAdmin, upload.single('image'), (req, res, next) => {
  try {
    const id = req.body.id || 'draft';
    const dir = path.join(mediaDir, 'richtext_images', safeName(id));
    ensureDir(dir);
    const target = path.join(dir, `${Date.now()}_${safeName(req.file.originalname)}`);
    fs.renameSync(req.file.path, target);
    res.json({ url: toPublicPath(target) });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    next(error);
  }
});

router.get('/participants', (req, res) => {
  const rows = db.prepare('SELECT * FROM participants ORDER BY count DESC').all();
  res.json(rows);
});

router.post('/participants/batch', requireAdmin, (req, res, next) => {
  try {
    const names = [...new Set((req.body.names || []).map((n) => String(n).trim()).filter(Boolean))];
    if (!names.length) return res.json({ processed: 0 });
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO participants (name, last_participated_at, count)
      VALUES (?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET
        last_participated_at = excluded.last_participated_at,
        count = count + 1
    `);
    for (const name of names) {
      upsert.run(name, now);
    }
    res.json({ processed: names.length });
  } catch (error) {
    next(error);
  }
});

router.post('/participants', requireAdmin, (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const existing = db.prepare('SELECT id FROM participants WHERE name = ?').get(name);
    if (existing) return res.status(409).json({ error: 'Participant already exists' });
    const lastParticipatedAt = req.body.last_participated_at || new Date().toISOString();
    const count = req.body.count === undefined || req.body.count === '' ? 0 : parseInt(req.body.count);
    db.prepare('INSERT INTO participants (name, last_participated_at, count) VALUES (?, ?, ?)').run(name, lastParticipatedAt, count);
    const row = db.prepare('SELECT * FROM participants WHERE rowid = last_insert_rowid()').get();
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.put('/participants/:id', requireAdmin, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const name = String(req.body.name ?? existing.name).trim();
    const lastParticipatedAt = req.body.last_participated_at || existing.last_participated_at;
    const count = req.body.count === undefined || req.body.count === '' ? existing.count : parseInt(req.body.count);
    db.prepare('UPDATE participants SET name=?, last_participated_at=?, count=? WHERE id=?').run(name, lastParticipatedAt, count, req.params.id);
    const row = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/participants/:id', requireAdmin, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM participants WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
