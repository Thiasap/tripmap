/**
 * 校验备份完整性，并检查数据库引用与 Blob 对象的一致性。
 *
 * 检查项：
 * 1. export-v1.json 存在、SHA-256 与 manifest 一致、可解析
 * 2. 每个应用级记录的关键字段完整（id/name）
 * 3. Blob 索引行数与 manifest 一致，每个对象文件存在、字节数一致、SHA-256 一致
 * 4. 双向引用比对：
 *    - 数据库引用但 Blob 缺失（会导致恢复后图片 404）
 *    - Blob 存在但数据库未引用（孤儿文件，可人工确认）
 * 5. 报告输出到 reports/verify.json，失败时非 0 退出
 *
 * 用法：
 *   node tools/backup/verify-backup.mjs --dir=backups/xxx [--skip-hash]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  sha256File,
  parseArgs,
  formatBytes,
  writeFileAtomic,
  log,
  logError
} from '../lib/common.mjs';

function loadJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function main() {
  const args = parseArgs();
  if (!args.dir) throw new Error('缺少 --dir=<备份目录>');
  const backupDir = path.resolve(process.cwd(), args.dir);
  const skipHash = Boolean(args['skip-hash']);

  const report = {
    backupDir,
    checkedAt: new Date().toISOString(),
    checks: {},
    errors: [],
    warnings: []
  };

  // 1. manifest
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到 manifest.json: ${manifestPath}`);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  report.checks.manifest = {
    format: manifest.format,
    version: manifest.version,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt
  };

  // 2. 应用级导出
  const exportRel = manifest.database?.exportPath || 'database/export-v1.json';
  const exportPath = path.join(backupDir, exportRel);
  if (!fs.existsSync(exportPath)) throw new Error(`找不到导出文件: ${exportPath}`);
  const exportText = await fsp.readFile(exportPath, 'utf8');
  const exportDoc = JSON.parse(exportText);
  const exportSha = (await sha256File(exportPath));
  report.checks.database = {
    path: exportRel,
    bytes: Buffer.byteLength(exportText, 'utf8'),
    sha256: exportSha,
    sha256MatchesManifest: exportSha === manifest.database?.sha256,
    counts: {
      trips: Array.isArray(exportDoc.trips) ? exportDoc.trips.length : 0,
      settings: exportDoc.settings ? Object.keys(exportDoc.settings).length : 0,
      participants: Array.isArray(exportDoc.participants) ? exportDoc.participants.length : 0,
      mediaReferences: Array.isArray(exportDoc.mediaReferences) ? exportDoc.mediaReferences.length : 0
    }
  };
  if (!report.checks.database.sha256MatchesManifest) {
    report.errors.push('export-v1.json 的 SHA-256 与 manifest 不一致');
  }

  const badTrips = (exportDoc.trips || []).filter((t) => !t || !t.id);
  if (badTrips.length) report.errors.push(`${badTrips.length} 条旅行记录缺少 id`);

  // 3. Blob 索引
  const indexPath = path.join(backupDir, manifest.blobs?.indexPath || 'blobs/index.jsonl');
  let blobEntries = [];
  if (fs.existsSync(indexPath)) {
    blobEntries = loadJsonl(await fsp.readFile(indexPath, 'utf8'));
  }
  report.checks.blobs = {
    indexPath: path.relative(backupDir, indexPath).replace(/\\/g, '/'),
    indexCount: blobEntries.length,
    manifestCount: manifest.blobs?.count ?? null,
    indexMatchesManifest: blobEntries.length === (manifest.blobs?.count ?? -1)
  };
  if (manifest.blobs && blobEntries.length !== manifest.blobs.count) {
    report.errors.push(`Blob 索引行数 ${blobEntries.length} 与 manifest ${manifest.blobs.count} 不一致`);
  }

  // 4. 逐对象校验（文件存在 / 字节数 / 哈希）
  let missingObjects = 0;
  let sizeMismatch = 0;
  let hashMismatch = 0;
  let verified = 0;
  const failedList = [];
  for (const entry of blobEntries) {
    if (entry.status !== 'ok' || !entry.objectPath) {
      failedList.push({ pathname: entry.pathname, reason: entry.error || 'status != ok' });
      continue;
    }
    const objPath = path.join(backupDir, 'blobs', entry.objectPath);
    let stat;
    try {
      stat = await fsp.stat(objPath);
    } catch {
      missingObjects += 1;
      failedList.push({ pathname: entry.pathname, reason: '对象文件缺失' });
      continue;
    }
    if (stat.size !== entry.bytes) {
      sizeMismatch += 1;
      failedList.push({ pathname: entry.pathname, reason: `字节数 ${stat.size} != ${entry.bytes}` });
      continue;
    }
    if (!skipHash) {
      const actual = await sha256File(objPath);
      if (actual !== entry.sha256) {
        hashMismatch += 1;
        failedList.push({ pathname: entry.pathname, reason: 'SHA-256 不符' });
        continue;
      }
    }
    verified += 1;
  }
  report.checks.objects = {
    verified,
    missingObjects,
    sizeMismatch,
    hashMismatch,
    hashChecked: !skipHash,
    failed: failedList.slice(0, 50),
    failedTotal: failedList.length
  };
  if (failedList.length) {
    report.errors.push(`${failedList.length} 个 Blob 对象校验失败`);
  }

  // 5. 双向引用比对
  const pathnameByUrl = new Map();
  for (const entry of blobEntries) {
    if (entry.url) pathnameByUrl.set(entry.url, entry.pathname);
  }
  const referenced = new Set(exportDoc.mediaReferences || []);
  const referencedMissing = [];
  for (const url of referenced) {
    if (!pathnameByUrl.has(url)) referencedMissing.push(url);
  }
  const usedPathnames = new Set();
  for (const url of referenced) {
    const p = pathnameByUrl.get(url);
    if (p) usedPathnames.add(p);
  }
  const orphans = blobEntries
    .filter((e) => !usedPathnames.has(e.pathname))
    .map((e) => ({ pathname: e.pathname, size: e.bytes, status: e.status }));

  // 缩略图由原图派生，数据库不会直接引用，属于预期孤儿
  const isDerivedThumb = (p) => /(^|\/)thumb_[^/]+$/.test(p);
  const derivedThumbs = orphans.filter((o) => isDerivedThumb(o.pathname));
  const unexpectedOrphans = orphans.filter((o) => !isDerivedThumb(o.pathname));

  const referencedBytes = blobEntries
    .filter((e) => usedPathnames.has(e.pathname))
    .reduce((sum, e) => sum + (e.bytes || 0), 0);

  report.checks.references = {
    referencedTotal: referenced.size,
    referencedMissingCount: referencedMissing.length,
    referencedMissing: referencedMissing.slice(0, 30),
    referencedBytes,
    orphanCount: orphans.length,
    orphanBytes: orphans.reduce((s, o) => s + (o.size || 0), 0),
    derivedThumbCount: derivedThumbs.length,
    unexpectedOrphanCount: unexpectedOrphans.length,
    unexpectedOrphans: unexpectedOrphans.slice(0, 30),
    orphans: orphans.slice(0, 30)
  };
  if (referencedMissing.length) {
    report.errors.push(`${referencedMissing.length} 个数据库引用的媒体在 Blob 中缺失`);
  }
  if (unexpectedOrphans.length) {
    report.warnings.push(`${unexpectedOrphans.length} 个 Blob 对象未被数据库引用且非缩略图（可能为历史遗留，建议人工确认）`);
  }

  // 6. 写报告
  const reportsDir = path.join(backupDir, 'reports');
  const reportPath = path.join(reportsDir, 'verify.json');
  report.ok = report.errors.length === 0;
  await writeFileAtomic(reportPath, JSON.stringify(report, null, 2));

  log('');
  log(`校验${report.ok ? '通过' : '失败'}`);
  log(`  旅行 ${report.checks.database.counts.trips} | 设置 ${report.checks.database.counts.settings} | 人员 ${report.checks.database.counts.participants}`);
  log(`  Blob 索引 ${report.checks.blobs.indexCount} 条；对象校验 ${verified} 通过`);
  log(`  引用媒体 ${referenced.size} 个（${formatBytes(referencedBytes)}），缺失 ${referencedMissing.length}`);
  log(`  缩略图 ${derivedThumbs.length} 个（派生，符合预期）；其他未引用对象 ${unexpectedOrphans.length} 个`);
  log(`  报告: ${path.relative(process.cwd(), reportPath).replace(/\\/g, '/')}`);

  if (report.errors.length) {
    log('');
    log('错误:');
    for (const e of report.errors) log(`  ! ${e}`);
    process.exitCode = 1;
  }
  if (report.warnings.length) {
    log('');
    log('提示:');
    for (const w of report.warnings) log(`  - ${w}`);
  }
}

main().catch((error) => {
  logError(`校验失败: ${error.message}`);
  process.exit(1);
});
