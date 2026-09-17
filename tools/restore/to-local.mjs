/**
 * 将备份恢复为本地可运行的 SQLite + media/ 目录。
 *
 * 输入：manifest.json + database/export-v1.json + blobs/index.jsonl + blobs/objects/**
 * 输出：<目标目录>/tripmap.sqlite、<目标目录>/media/**
 *
 * 安全约定：
 * - 默认拒绝写入非空目录（需 --overwrite 显式允许，且只清理本工具自己的产物）
 * - 所有路径来自备份内容，逐条经过 safeRelativePath 校验，拒绝穿越
 * - 数据库写入在单个事务内完成，失败整体回滚
 * - 恢复报告写入 <目标目录>/restore-report.json
 *
 * 用法：
 *   node tools/restore/to-local.mjs --dir=backups/xxx --out=/path/to/target [--overwrite]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  safeRelativePath,
  resolveInside,
  formatBytes,
  writeFileAtomic,
  parseArgs,
  log,
  logError
} from '../lib/common.mjs';

const MEDIA_SQLITE_TABLES = `
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    name TEXT,
    province TEXT,
    city TEXT,
    address_detail TEXT,
    latitude REAL,
    longitude REAL,
    start_date TEXT,
    end_date TEXT,
    participants TEXT,
    rich_text_path TEXT,
    album_path TEXT,
    attachments_path TEXT,
    cover_path TEXT,
    cover_meta TEXT,
    card_position_x REAL,
    card_position_y REAL,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    last_participated_at TEXT,
    count INTEGER DEFAULT 0
  );
`;

function loadJsonl(text) {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Blob pathname → 本地 media 下的相对路径；同时校验安全性 */
function blobPathnameToLocal(pathname) {
  const safe = safeRelativePath(pathname);
  const first = safe.split('/')[0];
  if (!['album', 'attachments', 'richtext_images'].includes(first)) {
    throw new Error(`未知的媒体类别: ${pathname}`);
  }
  return path.posix.join('media', safe);
}

/** 把 Blob URL 改写为本地 /media/... 路径 */
function buildUrlRewriter(urlMap) {
  const entries = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = String(text ?? '');
    for (const [url, localPath] of entries) {
      if (out.includes(url)) out = out.split(url).join(localPath);
    }
    return out;
  };
}

async function main() {
  const args = parseArgs();
  if (!args.dir) throw new Error('缺少 --dir=<备份目录>');
  if (!args.out) throw new Error('缺少 --out=<目标目录>');

  const backupDir = path.resolve(process.cwd(), args.dir);
  const outDir = path.resolve(process.cwd(), args.out);
  const overwrite = Boolean(args.overwrite);

  // 1. 读取并校验备份
  const manifest = JSON.parse(await fsp.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'tripmap-backup') {
    throw new Error(`不是受支持的备份格式: ${manifest.format}`);
  }
  const exportDoc = JSON.parse(
    await fsp.readFile(path.join(backupDir, manifest.database?.exportPath || 'database/export-v1.json'), 'utf8')
  );
  const indexPath = path.join(backupDir, manifest.blobs?.indexPath || 'blobs/index.jsonl');
  const blobEntries = fs.existsSync(indexPath) ? loadJsonl(await fsp.readFile(indexPath, 'utf8')) : [];

  if (manifest.blobs && manifest.blobs.completed === false) {
    throw new Error('备份未完成（manifest.blobs.completed=false），拒绝用于恢复');
  }

  // 2. 目标目录检查
  const dbOut = path.join(outDir, 'tripmap.sqlite');
  const mediaOut = path.join(outDir, 'media');
  if (fs.existsSync(outDir) && !overwrite) {
    const existing = await fsp.readdir(outDir);
    if (existing.length) {
      throw new Error(`目标目录非空: ${outDir}（如确认覆盖请加 --overwrite）`);
    }
  }
  if (overwrite) {
    // 只清理本工具的产物，绝不递归删除整个目录
    await fsp.rm(dbOut, { force: true });
    for (const suffix of ['-wal', '-shm']) await fsp.rm(`${dbOut}${suffix}`, { force: true });
    await fsp.rm(mediaOut, { recursive: true, force: true });
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(mediaOut, { recursive: true });

  log(`备份 ID: ${manifest.backupId}`);
  log(`目标目录: ${outDir}`);

  // 3. 建立 Blob URL → 本地路径映射，并物化媒体文件
  const urlMap = new Map();
  const bySha = new Map();
  for (const entry of blobEntries) {
    if (entry.status === 'ok' && entry.objectPath && entry.sha256) {
      bySha.set(entry.sha256, entry);
    }
  }

  const blobUrlEntries = [...new Set(blobEntries.map((entry) => entry.pathname))];
  const usedObjects = new Map();
  let mediaWritten = 0;

  for (const pathname of blobUrlEntries) {
    // 每个 pathname 可能有多个历史 URL（同内容不同后缀），全部建立映射
    const candidates = blobEntries.filter((e) => e.pathname === pathname && e.status === 'ok');
    if (!candidates.length) continue;
    const localRel = blobPathnameToLocal(pathname);
    for (const candidate of candidates) {
      urlMap.set(candidate.url, `/${localRel.replace(/\\/g, '/')}`);
    }
    const chosen = candidates[0];
    const objectFile = resolveInside(path.join(backupDir, 'blobs'), path.posix.join('objects', chosen.sha256.slice(0, 2), chosen.sha256));
    if (!fs.existsSync(objectFile)) {
      throw new Error(`对象文件缺失: ${chosen.objectPath}`);
    }
    const target = resolveInside(outDir, localRel);
    if (usedObjects.has(chosen.sha256)) {
      // 同内容多名字：复制而非重复解码
      await fsp.copyFile(usedObjects.get(chosen.sha256), target);
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(objectFile, target);
      usedObjects.set(chosen.sha256, target);
    }
    mediaWritten += 1;
  }
  log(`媒体文件物化: ${mediaWritten} 个`);

  const rewrite = buildUrlRewriter(urlMap);

  // 4. 写入 SQLite（单事务）
  const sqlite = new DatabaseSync(dbOut);
  const report = {
    backupId: manifest.backupId,
    restoredAt: new Date().toISOString(),
    target: outDir,
    counts: {},
    warnings: [],
    pathRewrites: { coverPath: 0, albumPath: 0, attachmentsPath: 0, richText: 0 },
    missingMedia: []
  };

  try {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec(MEDIA_SQLITE_TABLES);
    sqlite.exec('BEGIN');

    const insertSetting = sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(exportDoc.settings || {})) {
      insertSetting.run(String(key), String(value));
    }

    const insertTrip = sqlite.prepare(`
      INSERT INTO trips (id, name, province, city, address_detail, latitude, longitude, start_date, end_date,
        participants, rich_text_path, album_path, attachments_path, cover_path, cover_meta,
        card_position_x, card_position_y, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const trip of exportDoc.trips || []) {
      const id = String(trip.id);
      const coverBlobUrl = String(trip.cover_path || '');
      const coverLocal = urlMap.get(coverBlobUrl);
      if (coverBlobUrl && !coverLocal) {
        report.missingMedia.push({ tripId: id, kind: 'cover', url: coverBlobUrl });
      } else if (coverLocal) {
        report.pathRewrites.coverPath += 1;
      }

      const albumPath = `/media/album/${id}`;
      const attachmentsPath = `/media/attachments/${id}`;
      if (trip.album_path !== albumPath) report.pathRewrites.albumPath += 1;
      if (trip.attachments_path !== attachmentsPath) report.pathRewrites.attachmentsPath += 1;

      const richText = String(trip.rich_text_path || '');
      const rewrittenRichText = rewrite(richText);
      if (rewrittenRichText !== richText) report.pathRewrites.richText += 1;

      insertTrip.run(
        id,
        trip.name ?? '',
        trip.province ?? '',
        trip.city ?? '',
        trip.address_detail ?? '',
        Number.isFinite(Number(trip.latitude)) ? Number(trip.latitude) : null,
        Number.isFinite(Number(trip.longitude)) ? Number(trip.longitude) : null,
        trip.start_date ?? '',
        trip.end_date ?? '',
        trip.participants ?? '',
        rewrittenRichText,
        albumPath,
        attachmentsPath,
        coverLocal || '',
        trip.cover_meta ? JSON.stringify(trip.cover_meta) : '',
        Number.isFinite(Number(trip.card_position_x)) ? Number(trip.card_position_x) : null,
        Number.isFinite(Number(trip.card_position_y)) ? Number(trip.card_position_y) : null,
        trip.created_at ?? '',
        trip.updated_at ?? ''
      );
    }

    const insertParticipant = sqlite.prepare(
      'INSERT INTO participants (id, name, last_participated_at, count) VALUES (?,?,?,?)'
    );
    let participantSeq = 0;
    for (const person of exportDoc.participants || []) {
      const numericId = Number(person.id);
      const id = Number.isInteger(numericId) && numericId > 0 ? numericId : (participantSeq += 1);
      insertParticipant.run(id, String(person.name ?? ''), person.last_participated_at ?? '', Number(person.count) || 0);
      if (id > participantSeq) participantSeq = id;
    }

    // 逐条校验媒体引用是否已物化
    const tripRows = sqlite.prepare('SELECT id, cover_path, rich_text_path FROM trips').all();
    for (const row of tripRows) {
      if (row.cover_path && !fs.existsSync(path.join(outDir, String(row.cover_path).replace(/^\//, '')))) {
        report.missingMedia.push({ tripId: row.id, kind: 'cover_path', path: row.cover_path });
      }
      const html = String(row.rich_text_path || '');
      for (const m of html.matchAll(/src="(\/media\/[^"]+)"/g)) {
        const rel = m[1].replace(/^\//, '');
        if (!fs.existsSync(path.join(outDir, rel))) {
          report.missingMedia.push({ tripId: row.id, kind: 'richTextImg', path: m[1] });
        }
      }
    }

    sqlite.exec('COMMIT');
    const integrity = sqlite.prepare('PRAGMA integrity_check').get();

    report.counts = {
      trips: sqlite.prepare('SELECT COUNT(*) AS c FROM trips').get().c,
      settings: sqlite.prepare('SELECT COUNT(*) AS c FROM settings').get().c,
      participants: sqlite.prepare('SELECT COUNT(*) AS c FROM participants').get().c,
      mediaFiles: mediaWritten,
      uniqueObjects: usedObjects.size
    };
    report.integrity = integrity?.integrity_check ?? 'unknown';
    if (report.integrity !== 'ok') report.warnings.push(`SQLite integrity_check: ${report.integrity}`);
    if (report.missingMedia.length) {
      report.warnings.push(`${report.missingMedia.length} 个媒体引用未能对应到本地文件`);
    }
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* 事务可能未开始 */ }
    sqlite.close();
    await fsp.rm(dbOut, { force: true });
    throw error;
  }
  sqlite.close();

  await writeFileAtomic(path.join(outDir, 'restore-report.json'), JSON.stringify(report, null, 2));

  log('');
  log('恢复完成');
  log(`  旅行 ${report.counts.trips} | 设置 ${report.counts.settings} | 人员 ${report.counts.participants}`);
  log(`  媒体文件 ${report.counts.mediaFiles}（去重对象 ${report.counts.uniqueObjects}，${formatBytes(usedObjects.size ? 0 : 0) || ''}）`);
  log(`  SQLite integrity_check: ${report.integrity}`);
  log(`  路径改写: 封面 ${report.pathRewrites.coverPath} | 相册 ${report.pathRewrites.albumPath} | 附件 ${report.pathRewrites.attachmentsPath} | 富文本 ${report.pathRewrites.richText}`);
  if (report.warnings.length) {
    log('  提示:');
    for (const w of report.warnings) log(`    - ${w}`);
  }
  log(`  报告: ${path.relative(process.cwd(), path.join(outDir, 'restore-report.json')).replace(/\\/g, '/')}`);
}

main().catch((error) => {
  logError(`恢复失败: ${error.message}`);
  process.exit(1);
});
