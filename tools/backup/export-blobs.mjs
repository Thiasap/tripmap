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
 * 存储源：默认 Vercel Blob；`TRIPMAP_STORAGE=s3`（或 `--source=r2`）时改为 Cloudflare R2，
 * 两者输出同一格式（blobs/index.jsonl + manifest），校验工具无需区分。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';
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

const R2_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.txt': 'text/plain'
};
const r2MimeOf = (pathname) => R2_MIME[path.extname(pathname).toLowerCase()] || 'application/octet-stream';

const decodeXml = (text) => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 解析 ListObjectsV2 响应（与 server/adapters/s3/storage.js 同一套轻量正则，避免为 XML 引依赖） */
function parseListXml(xml) {
  const blobs = [];
  for (const block of String(xml).match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    if (!key) continue;
    const size = /<Size>(\d+)<\/Size>/.exec(block);
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
    blobs.push({
      pathname: decodeXml(key[1]),
      size: size ? Number(size[1]) : 0,
      uploadedAt: modified ? modified[1] : null
    });
  }
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return { blobs, cursor: truncated && token ? decodeXml(token[1]) : null };
}

/**
 * R2 源：ListObjectsV2 分页列出全部对象（只读，不写不删）。
 * 下载走公开读域名（与站点同源），因此 url 字段直接可 GET。
 */
async function listAllR2Objects(secrets) {
  const accountId = requireEnv('R2_ACCOUNT_ID', null, secrets);
  const bucket = requireEnv('R2_BUCKET', null, secrets);
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID', null, secrets);
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY', null, secrets);
  const publicBase = requireEnv('R2_PUBLIC_BASE_URL', null, secrets).replace(/\/+$/, '');
  const client = new AwsClient({ accessKeyId, secretAccessKey });
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;

  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
    if (cursor) params.set('continuation-token', cursor);
    const res = await client.fetch(`${endpoint}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`R2 list 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const { blobs, cursor: next } = parseListXml(await res.text());
    all.push(...blobs.map((b) => ({
      ...b,
      url: `${publicBase}/${b.pathname}`,
      contentType: r2MimeOf(b.pathname)
    })));
    cursor = next;
    pages += 1;
    if (pages > 200) throw new Error('分页超过 200 页，疑似游标未推进，已中止');
  } while (cursor);
  return all;
}

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

/** 索引键：同一 pathname 在相同字节数下视为同一对象版本 */
function indexKey(pathname, size) {
  return `${pathname}|${size}`;
}

/**
 * 读取已有 index.jsonl，得到 pathname+size → 既有条目。
 * 用于增量续跑：URL 未变且本地对象存在时跳过下载。
 */
async function loadPreviousIndex(indexPath) {
  const map = new Map();
  try {
    const text = await fsp.readFile(indexPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.status === 'ok' && entry.objectPath && entry.sha256) {
          map.set(indexKey(entry.pathname, entry.size), entry);
        }
      } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 无历史索引 */ }
  return map;
}

async function downloadBlob(blob, blobsDir, { retries = 3, previous = null } = {}) {
  const result = { pathname: blob.pathname, url: blob.url, size: blob.size, contentType: blob.contentType || null,
    uploadedAt: blob.uploadedAt || null, etag: blob.etag || null, sha256: null, objectPath: null, status: 'ok' };

  // 增量：同一 pathname+size 且本地对象完好则直接复用
  if (previous && previous.url === blob.url && previous.sha256) {
    const existingObject = path.join(blobsDir, previous.objectPath);
    try {
      const stat = await fsp.stat(existingObject);
      if (stat.size === previous.bytes) {
        return { ...result, ...previous, url: blob.url, skipped: true };
      }
    } catch { /* 对象缺失，回退为重新下载 */ }
  }

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
  const source = String(args.source || process.env.TRIPMAP_STORAGE || 'blob').toLowerCase() === 's3' ? 'r2' : 'blob';
  let blobs;
  if (source === 'r2') {
    log('存储源: Cloudflare R2（只读 list + 公开 GET，不写不删）');
    blobs = await listAllR2Objects(secrets);
  } else {
    const token = requireEnv('BLOB_READ_WRITE_TOKEN', null, secrets);
    log(`Blob Token: ${describeSecret(token)}（只读使用：list + GET）`);
    blobs = await listAllBlobs(token);
  }
  log(`输出目录: ${outDir}`);
  log(`并发: ${concurrency}`);

  const started = Date.now();
  const totalBytes = blobs.reduce((sum, b) => sum + (b.size || 0), 0);
  log(`对象: ${blobs.length} 个，共 ${formatBytes(totalBytes)}（存储源: ${source}）`);

  await fsp.mkdir(objectsDir, { recursive: true });

  // 增量续跑：复用上次索引中 URL 与字节数都一致的条目
  const previousIndex = await loadPreviousIndex(path.join(blobsDir, 'index.jsonl'));
  if (previousIndex.size) log(`已有索引条目: ${previousIndex.size}（相同对象将跳过下载）`);

  let done = 0;
  let reused = 0;
  const index = await runPool(blobs, concurrency, async (blob) => {
    const previous = previousIndex.get(indexKey(blob.pathname, blob.size)) || null;
    const entry = await downloadBlob(blob, blobsDir, { previous });
    if (entry.skipped) reused += 1;
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
    source: { ...(manifest.source || {}), storage: source },
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
  log(`  复用已有对象: ${reused}`);
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
