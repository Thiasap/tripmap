/**
 * 从线上 API 导出全部业务数据到版本化 JSON。
 *
 * 特点：
 * - 只读：仅使用 GET 接口（/api/trips、/api/settings、/api/participants、/api/trips/:id/files）
 * - 不需要数据库连接串或 Token
 * - 输出 export-v1.json + 校验信息，供离线保存与本地恢复使用
 *
 * 用法：
 *   node tools/backup/export-database.mjs [--out=backups/xxx] [--base-url=https://...]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BASE_URL,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  nowStamp,
  sha256Hex,
  writeFileAtomic,
  formatBytes,
  parseArgs,
  log,
  logError
} from '../lib/common.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveOutputDir(args) {
  const requested = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(projectRoot, 'backups', `tripmap-${nowStamp()}`);
  return requested;
}

async function fetchJson(url, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${url} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${url} -> 响应不是合法 JSON（前 120 字符: ${text.slice(0, 120)}）`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs();
  const baseUrl = String(args['base-url'] || process.env.TRIPMAP_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const outDir = resolveOutputDir(args);
  const dbDir = path.join(outDir, 'database');

  log(`导出源: ${baseUrl}`);
  log(`输出目录: ${outDir}`);

  // 1. 主体数据
  const trips = await fetchJson(`${baseUrl}/api/trips`);
  if (!Array.isArray(trips)) throw new Error('/api/trips 未返回数组');
  log(`旅行记录: ${trips.length} 条`);

  const settingsRaw = await fetchJson(`${baseUrl}/api/settings`);
  log(`设置项: ${Object.keys(settingsRaw || {}).length} 项`);

  const participants = await fetchJson(`${baseUrl}/api/participants`);
  if (!Array.isArray(participants)) throw new Error('/api/participants 未返回数组');
  log(`参与人员: ${participants.length} 人`);

  // 2. 逐条拉取媒体清单（album / attachments / richtextImages 的 Blob URL）
  const mediaIndex = [];
  let mediaFileCount = 0;
  for (const trip of trips) {
    const id = String(trip.id || '');
    if (!id) continue;
    let files;
    try {
      files = await fetchJson(`${baseUrl}/api/trips/${encodeURIComponent(id)}/files`);
    } catch (error) {
      log(`  ! ${id} 媒体清单获取失败: ${error.message}`);
      mediaIndex.push({ tripId: id, error: String(error.message) });
      continue;
    }
    const entry = {
      tripId: id,
      album: Array.isArray(files.album) ? files.album : [],
      attachments: Array.isArray(files.attachments) ? files.attachments : [],
      richtextImages: Array.isArray(files.richtextImages) ? files.richtextImages : []
    };
    mediaFileCount += entry.album.length + entry.attachments.length + entry.richtextImages.length;
    mediaIndex.push(entry);
  }
  log(`媒体引用: ${mediaFileCount} 个（不含封面与缩略图，封面从 trips.cover_path 读取）`);

  // 3. 汇总媒体引用（含封面），用于双向完整性校验
  const referenced = new Set();
  for (const trip of trips) {
    const cover = String(trip.cover_path || '');
    if (cover.startsWith('http')) referenced.add(cover);
  }
  for (const entry of mediaIndex) {
    for (const key of ['album', 'attachments', 'richtextImages']) {
      for (const file of entry[key] || []) {
        if (file && typeof file.url === 'string' && file.url.startsWith('http')) referenced.add(file.url);
      }
    }
  }

  const exportDoc = {
    format: 'tripmap-export',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: { baseUrl },
    counts: {
      trips: trips.length,
      settings: Object.keys(settingsRaw || {}).length,
      participants: participants.length,
      mediaReferences: referenced.size
    },
    trips,
    settings: settingsRaw || {},
    participants,
    mediaIndex,
    mediaReferences: [...referenced].sort()
  };

  const json = JSON.stringify(exportDoc, null, 2);
  const target = path.join(dbDir, 'export-v1.json');
  await writeFileAtomic(target, json);
  const digest = sha256Hex(Buffer.from(json, 'utf8'));

  await writeFileAtomic(
    path.join(dbDir, 'export-v1.json.sha256'),
    `${digest}  export-v1.json\n`
  );

  // 4. 生成备份目录的总 manifest（Blob 阶段会再补充）
  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); } catch { manifest = {}; }
  }
  const manifestDoc = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    backupId: path.basename(outDir),
    createdAt: manifest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: {
      baseUrl,
      vercelProjectId: 'prj_6V2LGJdQUNIxheeSUnVwrkObD54m',
      blobStoreId: 'store_VLeeVkWEQv2avQkx',
      neonResourceId: 'store_LVXR8tKqjfJ9qh5G',
      ...(manifest.source || {})
    },
    database: {
      exportPath: path.relative(outDir, target).replace(/\\/g, '/'),
      sha256: digest,
      bytes: Buffer.byteLength(json, 'utf8'),
      counts: {
        trips: trips.length,
        settings: Object.keys(settingsRaw || {}).length,
        participants: participants.length,
        mediaReferences: referenced.size
      }
    },
    blobs: manifest.blobs || null
  };
  await writeFileAtomic(manifestPath, JSON.stringify(manifestDoc, null, 2));

  log('');
  log('导出完成');
  log(`  文件: ${path.relative(projectRoot, target).replace(/\\/g, '/')}`);
  log(`  大小: ${formatBytes(Buffer.byteLength(json, 'utf8'))}`);
  log(`  SHA-256: ${digest}`);
}

main().catch((error) => {
  logError(`导出失败: ${error.message}`);
  process.exit(1);
});
