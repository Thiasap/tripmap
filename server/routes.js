const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const sanitizeHtml = require('sanitize-html');
const storageModule = require('./adapters/storage');
const { put, del, list, read } = storageModule.storage();
// mediaUrl / coverRef 是模块级工具（内部按当前适配器分派），不在适配器实例上
const { mediaUrl, coverRef } = storageModule;
const { contentTypeOf } = require('./adapters/mime');
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
  if (!SAFE_EXT.has(ext)) {
    // 标记为客户端错误：否则会被全局处理器当成 500「服务器内部错误」，
    // 用户看不到真实原因
    const error = new Error(`不支持的文件类型: ${ext || '（无扩展名）'}`);
    error.status = 400;
    return cb(error);
  }
  if (file.fieldname !== 'attachments' && !IMAGE_MIMES.has(file.mimetype)) {
    const error = new Error(`仅支持图片格式: ${file.mimetype}`);
    error.status = 400;
    return cb(error);
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

/** 400 客户端错误：全局错误处理器会把 message 原样返回给用户 */
function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * 图片类型嗅探：只看文件头魔数，不看扩展名，也不看客户端声明的 file.mimetype。
 *
 * 为什么必须在「写 R2 之前」做：multer 用 memoryStorage，此刻整个文件已在内存里，
 * 所以任何一次 put 之前都能把非图片内容拦下来。此前只信 file.mimetype（客户端可伪造），
 * 且先 put 原图、再让 sharp 解码（失败还被 catch 吞掉），等于允许把任意字节以
 * image/* 写进公开桶——公开域上就有了可托管任意内容的位置。
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', ext: '.jpg', match: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: '.png', match: (b) => b.length > 8 && b.subarray(0, 8).equals(PNG_MAGIC) },
  {
    mime: 'image/gif',
    ext: '.gif',
    match: (b) => {
      if (b.length <= 6) return false;
      const head = b.subarray(0, 6).toString('latin1');
      return head === 'GIF87a' || head === 'GIF89a';
    }
  },
  {
    mime: 'image/webp',
    ext: '.webp',
    match: (b) => b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP'
  }
];

/** @returns {{mime: string, ext: string} | null} 未命中任何图片魔数时返回 null */
function detectImageType(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return IMAGE_SIGNATURES.find((signature) => signature.match(bytes)) || null;
}

/** 校验为真实图片，否则抛 400（调用方保证在写存储之前执行） */
function requireImage(file, label) {
  const detected = detectImageType(file.buffer);
  if (!detected) {
    throw badRequest(`${label}不是有效的图片文件: ${safeName(file.originalname)}`);
  }
  return detected;
}

function normalizeTrip(row) {
  if (!row) return null;
  let coverMeta = null;
  try {
    coverMeta = row.cover_meta ? JSON.parse(row.cover_meta) : null;
  } catch {
    // 历史脏数据不应导致整条记录读取失败
    coverMeta = null;
  }
  // DB 存相对 key（与存储解耦），返回给浏览器时才解析为完整 URL
  return { ...row, cover_path: mediaUrl(row.cover_path), cover_meta: coverMeta };
}

/** 参与次数：只接受 >= 0 的整数，非法值返回 null 由调用方拒绝 */
function parseCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function processImageBuffer(buffer, options = {}) {
  const image = sharp(buffer)
    // 按 EXIF 自动旋转，避免竖拍照片方向错误
    .rotate()
    // 透明 PNG/GIF 转 JPEG 时铺白底，否则透明区域会变成黑底
    .flatten({ background: '#ffffff' });
  if (options.resize) image.resize(options.resize);
  return image.jpeg({ quality: options.quality || 82, mozjpeg: true }).toBuffer();
}

/** 随机对象名：扩展名由服务端嗅探结果决定，不采用客户端文件名里的后缀 */
function randomKey(ext) {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
}

async function saveUploads(id, files = {}) {
  const cover = files.cover?.[0] || null;
  const album = files.album || [];
  const attachments = files.attachments || [];
  const richTextImages = files.richtextImages || [];

  // ── 第一段：先把全部上传内容校验完，此时一个对象都还没写进存储 ──────────────
  // 顺序很重要：校验通过才进入第二段的上传，避免「先写进公开桶、再发现不是图片」。
  if (cover) requireImage(cover, '封面');
  const albumTypes = album.map((file) => requireImage(file, '相册照片'));
  const richTextTypes = richTextImages.map((file) => requireImage(file, '富文本插图'));

  // ── 第二段：校验通过，开始写存储 ──────────────────────────────────────────
  let coverPath = null;
  let coverMeta = null;

  if (cover) {
    const processed = await processImageBuffer(cover.buffer, {
      resize: { width: 1400, withoutEnlargement: true },
      quality: 78
    });
    // 从处理后的图读取尺寸：原图 metadata 不含 EXIF 旋转，竖拍照片宽高会颠倒
    const outputMeta = await sharp(processed).metadata();
    const blob = await put(`album/${id}/cover_${id}.jpg`, processed, {
      access: 'public',
      contentType: 'image/jpeg'
    });
    // 存相对 key（s3/fs）或绝对 URL（Blob 无法由 key 重建），由 coverRef 按适配器能力决定
    coverPath = coverRef(blob);
    coverMeta = { width: outputMeta.width || 4, height: outputMeta.height || 3 };
  }

  // 每张图的「原图 + 缩略图」互不依赖，并行上传：云端存储逐次往返延迟高，串行会把上传拖成 N×RTT
  await Promise.all(album.map(async (file, index) => {
    const key = randomKey(albumTypes[index].ext);
    await put(`album/${id}/${key}`, file.buffer, {
      access: 'public',
      contentType: albumTypes[index].mime
    });
    try {
      const thumb = await processImageBuffer(file.buffer, {
        resize: { width: 320, height: 220, fit: 'inside', withoutEnlargement: true },
        quality: 72
      });
      await put(`album/${id}/thumb_${key}.jpg`, thumb, {
        access: 'public',
        contentType: 'image/jpeg'
      });
    } catch { /* thumbnail generation best-effort */ }
  }));

  // 附件：扩展名白名单已由 fileFilter 把关，Content-Type 一律由服务端按扩展名映射，
  // 不采用客户端声明的 file.mimetype（否则可上传 .txt 却声明 text/html，在公开域托管网页）
  await Promise.all(attachments.map((file) => put(
    `attachments/${id}/${randomKey(path.extname(file.originalname).toLowerCase())}`,
    file.buffer,
    { access: 'public', contentType: contentTypeOf(file.originalname) }
  )));

  await Promise.all(richTextImages.map((file, index) => put(
    `richtext_images/${id}/${randomKey(richTextTypes[index].ext)}`,
    file.buffer,
    { access: 'public', contentType: richTextTypes[index].mime }
  )));

  return { cover_path: coverPath, cover_meta: coverMeta };
}

async function fileList(prefix) {
  try {
    const { blobs } = await list({ prefix, limit: 1000 });
    // 单次 list 已返回全部对象（含 thumb_），缩略图在内存中匹配。
    // 禁止回到逐图再 list 的写法：云端每次往返 ~1s，N+1 会把接口拖到 10s+。
    const thumbOf = new Map();
    for (const blob of blobs) {
      const name = blob.pathname.split('/').pop();
      if (name.startsWith('thumb_')) thumbOf.set(name.slice(6).replace(/\.jpg$/, ''), blob.url);
    }
    const result = [];
    for (const blob of blobs) {
      const name = blob.pathname.split('/').pop();
      if (name.startsWith('thumb_') || name.startsWith('cover_')) continue;
      result.push({ name, url: blob.url, thumb: thumbOf.get(name) || blob.url });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 回收：把待删除对象复制到 recycle/<时间戳>/<原路径> 后再删除原对象。
 *
 * 与本地版「移动而不是删除」的语义对齐——Blob 没有 rename，只能复制后删除。
 * 单个对象复制失败时保留其原对象不删，宁可留下冗余也不丢数据。
 *
 * @returns {{ recyclePath: string, moved: Array<{from: string, to: string}>, failed: number }}
 */
/** 回收并发度：云端每对象一次 copy，串行会把「删旅行」拖成 N×RTT */
const RECYCLE_CONCURRENCY = Math.max(1, Number(process.env.RECYCLE_CONCURRENCY) || 6);

async function recycleBlobs(blobs, { concurrency = RECYCLE_CONCURRENCY } = {}) {
  const targets = (blobs || []).filter((b) => b && b.url && b.pathname);
  const stamp = timestampName();
  if (!targets.length) return { recyclePath: '', moved: [], failed: 0 };

  const moved = [];
  let failed = 0;

  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= targets.length) return;
      const blob = targets[current];
      const target = `recycle/${stamp}/${blob.pathname}`;
      try {
        const { body, contentType } = await read(blob);
        await put(target, body, { contentType });
        moved.push({ from: blob.pathname, to: target });
      } catch {
        // 复制失败：保留原对象，不执行删除
        failed += 1;
      }
    }
  });
  await Promise.all(workers);

  const urlsToDelete = moved
    .map((item) => targets.find((b) => b.pathname === item.from)?.url)
    .filter(Boolean);
  if (urlsToDelete.length) {
    try { await del(urlsToDelete); } catch { /* 原对象残留不影响使用，下次清理会重试 */ }
  }

  return { recyclePath: `recycle/${stamp}`, moved, failed };
}

/** 与本地版 timestampName 保持一致的目录命名 */
function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** 列出某个旅行在各前缀下的全部对象 */
async function blobsForTrip(tripId) {
  const out = [];
  for (const prefix of [`album/${tripId}/`, `attachments/${tripId}/`, `richtext_images/${tripId}/`]) {
    try {
      out.push(...await listAllByPrefix(prefix));
    } catch { /* 忽略单个前缀失败 */ }
  }
  return out;
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

/** 未保存的富文本草稿图保留时长：避免清理掉用户正在编辑的内容 */
const DRAFT_GRACE_MS = 24 * 60 * 60 * 1000;

/** 孤儿目录宽限期：新建旅行是「先传图后插行」，窗口期内目录尚无 DB 行，不可回收 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * 清空回收站：彻底删除 recycle/ 下的全部对象。
 *
 * 与「删除」不同——删除只是把对象搬进回收站（可人工找回），清理是显式的彻底操作。
 * 对象已在回收站中，无需再复制，直接 del；批次失败时逐个重试并如实统计失败数。
 */
async function purgeRecycle() {
  const blobs = await listAllByPrefix('recycle/');
  const urls = blobs.map((b) => b.url).filter(Boolean);
  let purged = 0;
  let failed = 0;

  // S3 DeleteObjects 单次上限 1000 键；适配层已按批实现，这里按上限切块即可
  const CHUNK = 1000;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK);
    try {
      await del(chunk);
      purged += chunk.length;
    } catch {
      // 批次失败时逐个重试，尽量清空并准确统计失败数
      for (const url of chunk) {
        try { await del(url); purged += 1; } catch { failed += 1; }
      }
    }
  }
  return { purged, failed };
}

/**
 * 清理媒体。判定规则：
 * 1. 所属旅行已不存在的目录（draft 除外）→ 回收；最近上传的孤儿在宽限期内跳过
 *    （新建旅行「先传图后插行」存在无行窗口，删除旅行也改为只删行、媒体延迟回收）
 * 2. richtext_images/draft 中超过 24 小时宽限期的对象 → 回收
 * 3. 富文本正文未引用的 richtext_images 对象 → 回收
 * 4. 原图已不存在的缩略图（thumb_ 前缀）→ 回收
 * 5. 最后清空回收站（recycle/ 下全部对象彻底删除）——「清理」是显式的彻底操作，
 *    回收站只作为「删除」的缓冲，不长期堆积。
 * 其余（存在旅行的相册、附件、被引用的富文本图）一律保留。
 */
async function cleanupMediaFiles() {
  const trips = await sql`SELECT id, cover_path, rich_text_path FROM trips`;
  const tripIds = new Set(trips.map(t => t.id));

  // 收集所有媒体对象
  const all = [];
  for (const prefix of ['album/', 'richtext_images/', 'attachments/']) {
    try {
      all.push(...await listAllByPrefix(prefix));
    } catch { /* 单个前缀失败不影响其他前缀 */ }
  }

  // 被引用的 URL：封面 + 富文本正文中出现的媒体地址
  // 封面同时收两种形态（相对 key 与完整 URL），兼容迁移过渡期的混合数据
  const keep = new Set();
  for (const trip of trips) {
    if (trip.cover_path) {
      keep.add(String(trip.cover_path));
      keep.add(mediaUrl(trip.cover_path));
    }
    const html = String(trip.rich_text_path || '');
    if (!html) continue;
    // 同时收集绝对 URL 与本地模式相对路径（/media/...），否则本地清理会误删使用中的富文本图
    for (const match of html.matchAll(/(https?:\/\/|\/media\/)[^"'\s<>)]+/g)) keep.add(match[0]);
  }

  const pathnames = new Set(all.map((b) => b.pathname));
  const now = Date.now();
  const targets = [];

  for (const blob of all) {
    const parts = String(blob.pathname).split('/');
    const root = parts[0];
    const tripId = parts[1];
    const name = parts[parts.length - 1];
    if (!tripId || !name) continue;

    const isDraft = root === 'richtext_images' && tripId === 'draft';
    const uploadedAt = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : 0;
    // 宽限期内（最近上传）的孤儿跳过：旅行可能在「已传图、未插行」的创建窗口中
    const orphanTripDir = !tripIds.has(tripId) && !isDraft &&
      !(uploadedAt > 0 && now - uploadedAt < ORPHAN_GRACE_MS);
    const draftExpired = isDraft && uploadedAt > 0 && now - uploadedAt > DRAFT_GRACE_MS;
    const unusedRichText = root === 'richtext_images' && !isDraft && !keep.has(blob.url);
    // 缩略图命名规则为 thumb_<原文件名>.jpg
    const orphanThumb = name.startsWith('thumb_') &&
      !pathnames.has(`${blob.pathname.slice(0, blob.pathname.length - name.length)}${name.slice(6, -4)}`);

    if (orphanTripDir || draftExpired || unusedRichText || orphanThumb) {
      targets.push(blob);
    }
  }

  const result = await recycleBlobs(targets);
  // 回收站是「删除」的缓冲，不长期堆积：清理时把其中内容（含本次识别出的孤立资源）一并彻底删除
  const purge = await purgeRecycle();
  return {
    recycle_path: result.recyclePath,
    moved_count: result.moved.length,
    moved: result.moved,
    failed_count: result.failed,
    purged_count: purge.purged,
    purge_failed_count: purge.failed
  };
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

/**
 * 新建旅行时富文本插图先上传到 richtext_images/draft/，保存时迁移到旅行自己的目录，
 * 并把 HTML 中的 URL 一并改写。
 *
 * 为什么必须迁移：
 * 1. 图片若永远留在 draft 伪目录，删除旅行时不会随旅行一起清理，成为永久孤儿；
 * 2. 清理任务把 draft 当作「旅行已不存在」的目录，可能删除刚上传、尚未保存的图片。
 *
 * Blob 不支持 rename，因此走「读取 → 写入新路径 → 删除旧对象 → 改写 URL」。
 * 单张迁移失败时保留原 URL，宁可留下孤儿也不丢图。
 */
async function migrateDraftImages(tripId, html) {
  const draftPrefix = 'richtext_images/draft/';
  let result = String(html || '');
  if (!result.includes(draftPrefix) || !tripId || tripId === 'draft') return result;

  let draftBlobs = [];
  try {
    draftBlobs = await listAllByPrefix(draftPrefix);
  } catch {
    return result;
  }
  if (!draftBlobs.length) return result;

  // 逐张串行会让「插图多的卡片」被 N×RTT 拖慢（云端每次往返约 1s），
  // 因此先并行完成 copy，再在内存里改写 URL（改写是纯字符串操作，必须串行保证顺序无歧义）。
  const pending = draftBlobs
    .filter((blob) => blob.url && result.includes(blob.url) && blob.pathname.slice(draftPrefix.length))
    .map((blob) => ({ blob, name: blob.pathname.slice(draftPrefix.length) }));

  const moved = await Promise.all(pending.map(async ({ blob, name }) => {
    try {
      const { body, contentType } = await read(blob);
      const uploaded = await put(`richtext_images/${tripId}/${name}`, body, { contentType });
      return { from: blob.url, to: uploaded.url };
    } catch {
      // 单张失败保留原 URL，宁可留下孤儿也不让图片链接失效
      return null;
    }
  }));

  const urlsToDelete = [];
  for (const item of moved) {
    if (!item) continue;
    result = result.split(item.from).join(item.to);
    urlsToDelete.push(item.from);
  }

  if (urlsToDelete.length) {
    try { await del(urlsToDelete); } catch { /* 旧对象残留不影响使用，清理任务会回收 */ }
  }
  return result;
}

router.post('/trips', requireAdmin, tripFields, async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    const id = await makeTripId(req.body.province, req.body.city);
    const saved = await saveUploads(id, req.files);
    const richText = await migrateDraftImages(id, sanitizeRichText(req.body.rich_text));
    await sql`
      INSERT INTO trips (id, name, province, city, address_detail, latitude, longitude, start_date, end_date, participants, rich_text_path, album_path, attachments_path, cover_path, cover_meta, card_position_x, card_position_y, created_at, updated_at)
      VALUES (${id}, ${req.body.name || ''}, ${req.body.province || ''}, ${req.body.city || ''}, ${req.body.address_detail || ''}, ${roundCoordinate(req.body.latitude)}, ${roundCoordinate(req.body.longitude)}, ${req.body.start_date || ''}, ${req.body.end_date || ''}, ${req.body.participants || ''}, ${richText}, ${''}, ${''}, ${saved.cover_path || ''}, ${saved.cover_meta ? JSON.stringify(saved.cover_meta) : ''}, ${clampNumber(req.body.card_position_x, -180, 180, 104)}, ${clampNumber(req.body.card_position_y, -90, 90, 35)}, ${now}, ${now})
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
        rich_text_path = ${req.body.rich_text === undefined ? cur.rich_text_path : await migrateDraftImages(req.params.id, sanitizeRichText(req.body.rich_text))},
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
    const key = `${type}/${req.params.id}/${safeName(name)}`;
    const thumbKey = `album/${req.params.id}/thumb_${safeName(name)}.jpg`;
    // s3/fs 的 del 按 key 幂等删除（404 视为成功），1 次往返即可，无需 list 定位。
    // 注意：直删没有回收缓冲，误删不可找回——换取的是删除请求毫秒级返回。
    if (typeof storageModule.storage().publicUrl === 'function') {
      const refs = type === 'album' ? [key, thumbKey] : [key];
      await del(refs);
      return res.json({ deleted: true, count: refs.length, mode: 'direct' });
    }
    // Blob：公开 URL 带随机后缀无法由 key 重建，del 只收完整 URL，
    // 只能先按 prefix 列出对象、精确匹配 pathname，再回收。
    const targets = [];
    const collect = async (pathname) => {
      try {
        const blobs = await listAllByPrefix(pathname);
        for (const blob of blobs) {
          if (blob.pathname === pathname) targets.push(blob);
        }
      } catch { /* 对象可能已不存在 */ }
    };
    await collect(key);
    if (type === 'album') {
      await collect(thumbKey);
    }
    const result = await recycleBlobs(targets);
    res.json({ deleted: true, count: result.moved.length, mode: 'recycle', recycle_path: result.recyclePath, failed_count: result.failed });
  } catch (e) { next(e); }
});

router.delete('/trips/:id', requireAdmin, async (req, res, next) => {
  try {
    // 只删 DB 行，媒体留在原地成为孤儿目录，由清理任务的 orphanTripDir 分支统一回收。
    // 避免删除请求被逐对象 R2 往返（copy+delete）拖到 10s+；孤儿有宽限期保护。
    const rows = await sql`SELECT id FROM trips WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    await sql`DELETE FROM trips WHERE id = ${req.params.id}`;
    res.json({ deleted: true, id: req.params.id });
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
    // 与 saveUploads 同一道闸：先按魔数确认是真实图片，再写存储
    const detected = requireImage(req.file, '富文本插图');
    const blob = await put(`richtext_images/${safeName(id)}/${randomKey(detected.ext)}`, req.file.buffer, {
      access: 'public',
      contentType: detected.mime
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
    // 单事务提交，保证批量写入的原子性；任一失败则整体回滚
    await sql.transaction(
      names.map((name) => sql`
        INSERT INTO participants (name, last_participated_at, count)
        VALUES (${name}, ${now}, 1)
        ON CONFLICT (name) DO UPDATE SET
          last_participated_at = EXCLUDED.last_participated_at,
          count = participants.count + 1
      `)
    );
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
    const count = req.body.count === undefined || req.body.count === '' ? 0 : parseCount(req.body.count);
    if (count === null) return res.status(400).json({ error: 'Invalid count' });
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
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const lastParticipatedAt = req.body.last_participated_at || cur.last_participated_at;
    const count = req.body.count === undefined || req.body.count === '' ? cur.count : parseCount(req.body.count);
    if (count === null) return res.status(400).json({ error: 'Invalid count' });
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
