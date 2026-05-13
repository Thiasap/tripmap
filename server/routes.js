const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const db = require('./db');

const router = express.Router();
const rootDir = path.join(__dirname, '..');
const mediaDir = path.join(rootDir, 'media');
const tempDir = path.join(mediaDir, '.tmp');

fs.mkdirSync(tempDir, { recursive: true });

const upload = multer({ dest: tempDir });
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

router.post('/trips', tripFields, async (req, res, next) => {
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
      latitude: Number(req.body.latitude) || null,
      longitude: Number(req.body.longitude) || null,
      start_date: req.body.start_date || '',
      end_date: req.body.end_date || '',
      participants: req.body.participants || '',
      rich_text_path: req.body.rich_text || '',
      album_path: saved.album_path,
      attachments_path: saved.attachments_path,
      cover_path: saved.cover_path || '',
      cover_meta: saved.cover_meta ? JSON.stringify(saved.cover_meta) : '',
      card_position_x: Number(req.body.card_position_x) || 40,
      card_position_y: Number(req.body.card_position_y) || 90,
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

router.put('/trips/:id', tripFields, async (req, res, next) => {
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
      latitude: req.body.latitude === undefined ? existing.latitude : Number(req.body.latitude),
      longitude: req.body.longitude === undefined ? existing.longitude : Number(req.body.longitude),
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

router.delete('/trips/:id', (req, res, next) => {
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

router.post('/uploads/richtext', upload.single('image'), (req, res, next) => {
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

module.exports = router;
