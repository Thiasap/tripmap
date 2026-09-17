/**
 * 下载 Vercel Blob 中的全部对象并生成 SHA-256 清单。
 *
 * 特点：
 * - 只读：仅调用 list 与对象 GET，绝不 put/delete/copy
 * - 内容寻址存储：对象按 SHA-256 存放，天然去重且避免不安全路径
 * - 可断点续跑：已存在且哈希一致的对象直接跳过
 * - 逐对象校验：下载后比对字节数与 SHA-256
 *
 * 用法：
 *   node tools/backup/export-blobs.mjs [--out=backups/xxx] [--concurrency=4]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadLocalSecrets,
  requireEnv,
  describeSecret,
  nowStamp,
  formatBytes,
  writeFileAtomic,
  parseArgs,
  log,
  logError
} from '../lib/common.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_ENDPOINT = 'https://blob.vercel-storage.com/';

function resolveOutputDir(args) {
  if (args.out) return path.resolve(process.cwd(), args.out);
  return path.join(projectRoot, 'backups', `tripmap-${nowStamp()}`);
}

async function listAllBlobs(token) {
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const url = new URL(LIST_ENDPOINT);
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(`Blob list 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const page = await res.json();
    all.push(...(page.blobs || []));
    cursor = page.cursor || null;
    pages += 1;
    if (pages > 200) throw new Error('分页超过 200 页，疑似游标未推进，已中止');
  } while (cursor);
  return all;
}

async function downloadBlob(blob, blobsDir, { retries = 3 } = {}) {
  const result = { pathname: blob.pathname, url: blob.url, size: blob.size, contentType: blob.contentType || null,
    uploadedAt: blob.uploadedAt || null, etag: blob.etag || null, sha256: null, objectPath: null, status: 'ok' };

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(blob.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      if (Number.isFinite(blob.size) && buffer.length !== blob.size) {
        throw new Error(`字节数不符: 期望 ${blob.size}，实际 ${buffer.length}`);
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const objectPath = path.join('objects', sha256.slice(0, 2), sha256);
      const target = path.join(blobsDir, objectPath);

      let needWrite = true;
      try {
        const stat = await fsp.stat(target);
        if (stat.size === buffer.length) needWrite = false;
      } catch { /* 目标不存在，需要写入 */ }

      if (needWrite) {
        await writeFileAtomic(target, buffer);
      }

      result.sha256 = sha256;
      result.objectPath = objectPath.replace(/\\/g, '/');
      result.bytes = buffer.length;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  result.status = 'failed';
  result.error = String(lastError?.message || lastError);
  return result;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs();
  const outDir = resolveOutputDir(args);
  const concurrency = Math.max(1, Math.min(16, Number(args.concurrency) || 4));
  const blobsDir = path.join(outDir, 'blobs');
  const objectsDir = path.join(blobsDir, 'objects');

  const secrets = loadLocalSecrets(projectRoot);
  const token = requireEnv('BLOB_READ_WRITE_TOKEN', null, secrets);
  log(`Blob Token: ${describeSecret(token)}（只读使用：list + GET）`);
  log(`输出目录: ${outDir}`);
  log(`并发: ${concurrency}`);

  const started = Date.now();
  const blobs = await listAllBlobs(token);
  const totalBytes = blobs.reduce((sum, b) => sum + (b.size || 0), 0);
  log(`Blob 对象: ${blobs.length} 个，共 ${formatBytes(totalBytes)}`);

  await fsp.mkdir(objectsDir, { recursive: true });

  let done = 0;
  const index = await runPool(blobs, concurrency, async (blob) => {
    const entry = await downloadBlob(blob, blobsDir);
    done += 1;
    if (done % 25 === 0 || done === blobs.length) {
      log(`  进度 ${done}/${blobs.length}`);
    }
    return entry;
  });

  const failures = index.filter((e) => e.status !== 'ok');
  const indexJsonl = index.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFileAtomic(path.join(blobsDir, 'index.jsonl'), indexJsonl);

  const downloadedBytes = index
    .filter((e) => e.status === 'ok')
    .reduce((sum, e) => sum + (e.bytes || 0), 0);
  const uniqueObjects = new Set(index.filter((e) => e.objectPath).map((e) => e.objectPath)).size;

  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); } catch { manifest = {}; }
  }
  const manifestDoc = {
    format: manifest.format || 'tripmap-backup',
    version: manifest.version || 1,
    backupId: manifest.backupId || path.basename(outDir),
    createdAt: manifest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: manifest.source || {},
    database: manifest.database || null,
    blobs: {
      indexPath: 'blobs/index.jsonl',
      count: blobs.length,
      okCount: index.length - failures.length,
      failedCount: failures.length,
      totalBytes,
      downloadedBytes,
      uniqueObjects,
      completed: failures.length === 0,
      failed: failures.slice(0, 50).map((f) => ({ pathname: f.pathname, error: f.error }))
    }
  };
  await writeFileAtomic(manifestPath, JSON.stringify(manifestDoc, null, 2));

  log('');
  log(`下载完成：${index.length - failures.length}/${blobs.length} 成功，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log(`  唯一对象（按内容去重）: ${uniqueObjects}`);
  log(`  字节数: ${formatBytes(downloadedBytes)}`);
  if (failures.length) {
    log(`  失败 ${failures.length} 个，示例：`);
    for (const f of failures.slice(0, 5)) {
      log(`    ${f.pathname}: ${f.error}`);
    }
    process.exitCode = 2;
  }
}

main().catch((error) => {
  logError(`Blob 备份失败: ${error.message}`);
  process.exit(1);
});
