const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const sanitizeHtml = require('sanitize-html');
const { put, del, list } = require('@vercel/blob');
const jwt = require('jsonwebtoken');
const { sql } = require('./db');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

let cachedRegions = null;

function requireAdmin(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: '需要管理员登录' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

// 富文本净化：与本地版保持同一策略，禁止 script/onerror 与协议相对 URL
const richTextAllowed = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'u', 's']),
  allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt'] },
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false
};
function sanitizeRichText(html) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeHtml(html, richTextAllowed);
}

const settingDefaults = {
  card_max_width: 360,
  card_title_font_size: 16,
  card_meta_font_size: 13,
  card_scale: 1,
  map_stretch: 1,
  pin_size: 7,
  default_zoom: 1
};

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
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 200 * MB }
});
const tripFields = upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'album', maxCount: 100 },
  { name: 'attachments', maxCount: 100 },
  { name: 'richtextImages', maxCount: 100 }
]);

function textHash(value) {
  let hash = 0;
  const text = String(value || '00');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 10000;
  return String(hash).padStart(4, '0');
}

async function makeTripId(province, city) {
  const provincePart = textHash(province).slice(0, 4);
  const cityPart = textHash(city).slice(0, 4);
  let id;
  do {
    id = `${provincePart}${cityPart}${Math.random().toString(36).slice(2, 8)}`;
    const rows = await sql`SELECT 1 FROM trips WHERE id = ${id}`;
    if (rows.length === 0) break;
  } while (true);
  return id;
}

function safeName(name) {
  return path.basename(name || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function normalizeTrip(row) {
  if (!row) return null;
  return {
    ...row,
    cover_meta: row.cover_meta ? JSON.parse(row.cover_meta) : null
  };
}

async function processImageBuffer(buffer, options = {}) {
  const image = sharp(buffer).rotate();
  if (options.resize) image.resize(options.resize);
  return image.jpeg({ quality: options.quality || 82, mozjpeg: true }).toBuffer();
}

async function saveUploads(id, files = {}) {
  let coverPath = null;
  let coverMeta = null;

  if (files.cover?.[0]) {
    const metadata = await sharp(files.cover[0].buffer).metadata();
    const processed = await processImageBuffer(files.cover[0].buffer, {
      resize: { width: 1400, withoutEnlargement: true },
      quality: 78
    });
    const blob = await put(`album/${id}/cover_${id}.jpg`, processed, {
      access: 'public',
      contentType: 'image/jpeg'
    });
    coverPath = blob.url;
    coverMeta = { width: metadata.width || 4, height: metadata.height || 3 };
  }

  for (const file of files.album || []) {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const blob = await put(`album/${id}/${safeName(name)}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype
    });
    try {
      const thumb = await processImageBuffer(file.buffer, {
        resize: { width: 320, height: 220, fit: 'inside', withoutEnlargement: true },
        quality: 72
      });
      await put(`album/${id}/thumb_${safeName(name)}.jpg`, thumb, {
        access: 'public',
        contentType: 'image/jpeg'
      });
    } catch { /* thumbnail generation best-effort */ }
  }

  for (const file of files.attachments || []) {
    const blob = await put(`attachments/${id}/${Date.now()}_${safeName(file.originalname)}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype
    });
  }

  for (const file of files.richtextImages || []) {
    const blob = await put(`richtext_images/${id}/${Date.now()}_${safeName(file.originalname)}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype
    });
  }

  return { cover_path: coverPath, cover_meta: coverMeta };
}

async function fileList(prefix) {
  try {
    const { blobs } = await list({ prefix, limit: 1000 });
    const result = [];
    for (const blob of blobs) {
      const name = blob.pathname.split('/').pop();
      if (name.startsWith('thumb_') || name.startsWith('cover_')) continue;
      const entry = { name, url: blob.url, thumb: blob.url };
      const thumbPath = blob.pathname.replace(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), `thumb_${name}.jpg`);
      try {
        const { blobs: thumbs } = await list({ prefix: thumbPath, limit: 1 });
        if (thumbs.length) entry.thumb = thumbs[0].url;
      } catch { /* 无缩略图时回退到原图，前端直接使用 thumb 字段 */ }
      result.push(entry);
    }
    return result;
  } catch {
    return [];
  }
}

async function deleteBlobsByPrefix(prefix) {
  try {
    const blobs = await listAllByPrefix(prefix);
    const urls = blobs.map((b) => b.url).filter(Boolean);
    if (urls.length) await del(urls);
  } catch { /* 对象可能已被删除 */ }
}

/** 分页列出某个 prefix 下的全部对象（单次 list 上限 1000，必须翻页） */
async function listAllByPrefix(prefix) {
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    all.push(...(page.blobs || []));
    cursor = page.cursor || null;
    pages += 1;
    if (pages > 200) break; // 防御游标未推进导致的死循环
  } while (cursor);
  return all;
}

async function cleanupMediaFiles() {
  const trips = await sql`SELECT id FROM trips`;
  const tripIds = new Set(trips.map(t => t.id));

  // 收集所有媒体对象，按 tripId 归组
  const byTrip = new Map();
  for (const prefix of ['album/', 'richtext_images/', 'attachments/']) {
    let blobs = [];
    try {
      blobs = await listAllByPrefix(prefix);
    } catch { /* 单个前缀失败不影响其他前缀 */ }
    for (const blob of blobs) {
      const parts = blob.pathname.split('/');
      const tripId = parts[1];
      if (!tripId) continue;
      if (!byTrip.has(tripId)) byTrip.set(tripId, []);
      byTrip.get(tripId).push(blob);
    }
  }

  // 删除所属旅行已不存在的全部对象（原图、缩略图、封面）
  const removed = [];
  for (const [tripId, blobs] of byTrip) {
    if (tripIds.has(tripId)) continue;
    const urls = blobs.map((b) => b.url).filter(Boolean);
    if (!urls.length) continue;
    await del(urls);
    for (const blob of blobs) removed.push({ pathname: blob.pathname, deleted: true });
  }

  return { moved_count: removed.length, moved: removed };
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function roundCoordinate(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : null;
}

// Routes

router.get('/settings', async (req, res, next) => {
  try {
    const rows = await sql`SELECT key, value FROM settings`;
    const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: Number(row.value) }), { ...settingDefaults });
    res.json(settings);
  } catch (e) { next(e); }
});

router.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const rows = await sql`SELECT key, value FROM settings`;
    const current = rows.reduce((acc, row) => ({ ...acc, [row.key]: Number(row.value) }), { ...settingDefaults });
    const settings = {
      card_max_width: clampNumber(req.body.card_max_width, 0, 800, current.card_max_width),
      card_title_font_size: clampNumber(req.body.card_title_font_size, 0, 40, current.card_title_font_size),
      card_meta_font_size: clampNumber(req.body.card_meta_font_size, 0, 32, current.card_meta_font_size),
      card_scale: clampNumber(req.body.card_scale, 0.1, 1, current.card_scale),
      map_stretch: clampNumber(req.body.map_stretch, 0.5, 2, current.map_stretch),
      pin_size: clampNumber(req.body.pin_size, 2, 30, current.pin_size),
      default_zoom: clampNumber(req.body.default_zoom, 0.3, 5, current.default_zoom)
    };
    for (const [key, value] of Object.entries(settings)) {
      await sql`INSERT INTO settings (key, value) VALUES (${key}, ${String(value)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
    res.json(settings);
  } catch (e) { next(e); }
});

router.post('/cleanup-media', requireAdmin, async (req, res, next) => {
  try {
    const result = await cleanupMediaFiles();
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/regions', async (req, res, next) => {
  try {
    if (!cachedRegions) {
      const fs = require('fs');
      cachedRegions = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'regions_L1_L2.json'), 'utf8'));
    }
    res.json(cachedRegions);
  } catch (e) { next(e); }
});

router.get('/trips', async (req, res, next) => {
  try {
    const rows = await sql`SELECT * FROM trips ORDER BY created_at DESC`;
    res.json(rows.map(normalizeTrip));
  } catch (e) { next(e); }
});

router.get('/trips/:id/files', async (req, res, next) => {
  try {
    const prefix = req.params.id;
    const [album, attachments, richtextImages] = await Promise.all([
      fileList(`album/${prefix}/`),
      fileList(`attachments/${prefix}/`),
      fileList(`richtext_images/${prefix}/`)
    ]);
    res.json({ album, attachments, richtextImages });
  } catch (e) { next(e); }
});

router.post('/trips', requireAdmin, tripFields, async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    const id = await makeTripId(req.body.province, req.body.city);
    const saved = await saveUploads(id, req.files);
    await sql`
      INSERT INTO trips (id, name, province, city, address_detail, latitude, longitude, start_date, end_date, participants, rich_text_path, album_path, attachments_path, cover_path, cover_meta, card_position_x, card_position_y, created_at, updated_at)
      VALUES (${id}, ${req.body.name || ''}, ${req.body.province || ''}, ${req.body.city || ''}, ${req.body.address_detail || ''}, ${roundCoordinate(req.body.latitude)}, ${roundCoordinate(req.body.longitude)}, ${req.body.start_date || ''}, ${req.body.end_date || ''}, ${req.body.participants || ''}, ${sanitizeRichText(req.body.rich_text)}, ${''}, ${''}, ${saved.cover_path || ''}, ${saved.cover_meta ? JSON.stringify(saved.cover_meta) : ''}, ${clampNumber(req.body.card_position_x, -180, 180, 104)}, ${clampNumber(req.body.card_position_y, -90, 90, 35)}, ${now}, ${now})
    `;
    const rows = await sql`SELECT * FROM trips WHERE id = ${id}`;
    res.status(201).json(normalizeTrip(rows[0]));
  } catch (e) { next(e); }
});

router.put('/trips/:id', requireAdmin, tripFields, async (req, res, next) => {
  try {
    const existing = await sql`SELECT * FROM trips WHERE id = ${req.params.id}`;
    if (!existing.length) return res.status(404).json({ error: 'Trip not found' });
    const cur = existing[0];
    const saved = await saveUploads(req.params.id, req.files);
    await sql`
      UPDATE trips SET
        name = ${req.body.name ?? cur.name},
        province = ${req.body.province ?? cur.province},
        city = ${req.body.city ?? cur.city},
        address_detail = ${req.body.address_detail ?? cur.address_detail},
        latitude = ${req.body.latitude === undefined ? cur.latitude : roundCoordinate(req.body.latitude)},
        longitude = ${req.body.longitude === undefined ? cur.longitude : roundCoordinate(req.body.longitude)},
        start_date = ${req.body.start_date ?? cur.start_date},
        end_date = ${req.body.end_date ?? cur.end_date},
        participants = ${req.body.participants ?? cur.participants},
        rich_text_path = ${req.body.rich_text === undefined ? cur.rich_text_path : sanitizeRichText(req.body.rich_text)},
        album_path = ${cur.album_path},
        attachments_path = ${cur.attachments_path},
        cover_path = ${saved.cover_path || cur.cover_path},
        cover_meta = ${saved.cover_meta ? JSON.stringify(saved.cover_meta) : cur.cover_meta},
        card_position_x = ${req.body.card_position_x === undefined ? cur.card_position_x : clampNumber(req.body.card_position_x, -180, 180, cur.card_position_x)},
        card_position_y = ${req.body.card_position_y === undefined ? cur.card_position_y : clampNumber(req.body.card_position_y, -90, 90, cur.card_position_y)},
        updated_at = ${new Date().toISOString()}
      WHERE id = ${req.params.id}
    `;
    const rows = await sql`SELECT * FROM trips WHERE id = ${req.params.id}`;
    res.json(normalizeTrip(rows[0]));
  } catch (e) { next(e); }
});

router.delete('/trips/:id/files', requireAdmin, async (req, res, next) => {
  try {
    const type = req.query.type;
    const name = req.query.name;
    if (!type || !name || !['album', 'attachments'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type or name' });
    }
    // 注意：@vercel/blob 的 del() 只接受完整 URL，传 pathname 会静默失败。
    // 因此先按 prefix 列出对象、精确匹配 pathname，再删除其 URL。
    const targets = [];
    const collect = async (pathname) => {
      try {
        const { blobs } = await list({ prefix: pathname, limit: 20 });
        for (const blob of blobs) {
          if (blob.pathname === pathname) targets.push(blob.url);
        }
      } catch { /* 对象可能已不存在 */ }
    };
    await collect(`${type}/${req.params.id}/${safeName(name)}`);
    if (type === 'album') {
      await collect(`${type}/${req.params.id}/thumb_${safeName(name)}.jpg`);
    }
    if (targets.length) await del(targets);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.delete('/trips/:id', requireAdmin, async (req, res, next) => {
  try {
    const rows = await sql`SELECT id FROM trips WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    await sql`DELETE FROM trips WHERE id = ${req.params.id}`;
    await Promise.all([
      deleteBlobsByPrefix(`album/${req.params.id}/`),
      deleteBlobsByPrefix(`attachments/${req.params.id}/`),
      deleteBlobsByPrefix(`richtext_images/${req.params.id}/`)
    ]);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/trips/:id/files', requireAdmin, upload.fields([
  { name: 'album', maxCount: 100 },
  { name: 'attachments', maxCount: 100 }
]), async (req, res, next) => {
  try {
    const rows = await sql`SELECT id FROM trips WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    if (!req.files || (!req.files.album?.length && !req.files.attachments?.length)) {
      return res.status(400).json({ error: 'No files provided' });
    }
    const saved = await saveUploads(req.params.id, req.files);
    res.json({ ...saved, id: req.params.id });
  } catch (e) { next(e); }
});

router.post('/uploads/richtext', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const id = req.body.id || 'draft';
    const blob = await put(`richtext_images/${safeName(id)}/${Date.now()}_${safeName(req.file.originalname)}`, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype
    });
    res.json({ url: blob.url });
  } catch (e) { next(e); }
});

router.get('/participants', async (req, res, next) => {
  try {
    const rows = await sql`SELECT * FROM participants ORDER BY count DESC`;
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/participants/batch', requireAdmin, async (req, res, next) => {
  try {
    const names = [...new Set((req.body.names || []).map(n => String(n).trim()).filter(Boolean))];
    if (!names.length) return res.json({ processed: 0 });
    const now = new Date().toISOString();
    for (const name of names) {
      await sql`
        INSERT INTO participants (name, last_participated_at, count)
        VALUES (${name}, ${now}, 1)
        ON CONFLICT (name) DO UPDATE SET
          last_participated_at = EXCLUDED.last_participated_at,
          count = participants.count + 1
      `;
    }
    res.json({ processed: names.length });
  } catch (e) { next(e); }
});

router.post('/participants', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const existing = await sql`SELECT id FROM participants WHERE name = ${name}`;
    if (existing.length) return res.status(409).json({ error: 'Participant already exists' });
    const lastParticipatedAt = req.body.last_participated_at || new Date().toISOString();
    const count = req.body.count === undefined || req.body.count === '' ? 0 : parseInt(req.body.count);
    const rows = await sql`
      INSERT INTO participants (name, last_participated_at, count)
      VALUES (${name}, ${lastParticipatedAt}, ${count})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.put('/participants/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await sql`SELECT * FROM participants WHERE id = ${req.params.id}`;
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const cur = existing[0];
    const name = String(req.body.name ?? cur.name).trim();
    const lastParticipatedAt = req.body.last_participated_at || cur.last_participated_at;
    const count = req.body.count === undefined || req.body.count === '' ? cur.count : parseInt(req.body.count);
    const rows = await sql`
      UPDATE participants SET name = ${name}, last_participated_at = ${lastParticipatedAt}, count = ${count}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.delete('/participants/:id', requireAdmin, async (req, res, next) => {
  try {
    const rows = await sql`SELECT id FROM participants WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await sql`DELETE FROM participants WHERE id = ${req.params.id}`;
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
