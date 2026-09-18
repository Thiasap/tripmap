/**
 * 媒体迁移：Vercel Blob → S3 兼容存储（Cloudflare R2）
 *
 * 用法（在本机运行；凭据从 .agent/SECRETS.env 读取，不经过 Vercel）：
 *   node tools/migrate/blob-to-r2.mjs --dry-run        # 只列源对象 + 生成映射，不写任何东西
 *   node tools/migrate/blob-to-r2.mjs --apply          # 复制（幂等：目标已存在且大小一致则跳过）
 *   node tools/migrate/blob-to-r2.mjs --verify         # 校验：对象数 / 大小 / 抽样 SHA-256
 *   node tools/migrate/blob-to-r2.mjs --rewrite-db     # 打印将 key 化的 DB 行（dry-run）
 *   node tools/migrate/blob-to-r2.mjs --rewrite-db --confirm   # 封面改写为相对 key、富文本改写为 R2 URL，并落回滚映射
 *   node tools/migrate/blob-to-r2.mjs --rollback-db [--confirm]  # 按回滚映射还原为 Blob 绝对 URL（配合 TRIPMAP_STORAGE=blob）
 *
 * 产物（都落在 .agent/，已被 Git 忽略）：
 *   r2-migration-map.json     旧 URL → 新 URL 的完整映射（回滚用）
 *   r2-migration-report.json  每次运行的结果快照
 *
 * 说明：源对象来自 Vercel Blob（生产 DB 引用的是它们）；**不删除任何 Blob 对象**。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_DIR = path.join(projectRoot, '.agent');
const MAP_PATH = path.join(AGENT_DIR, 'r2-migration-map.json');
const REPORT_PATH = path.join(AGENT_DIR, 'r2-migration-report.json');
const BACKMAP_PATH = path.join(AGENT_DIR, 'r2-keyify-backmap.json');

// ---------- 环境与适配层 ----------
function loadSecrets() {
  const file = path.join(AGENT_DIR, 'SECRETS.env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadSecrets();
process.env.TRIPMAP_STORAGE = 's3'; // 目标存储固定为 S3（源存储单独用 Blob SDK）

const { list: blobList } = require('@vercel/blob');
const { createS3Storage } = require(path.join(projectRoot, 'server', 'adapters', 's3', 'storage.js'));
const target = createS3Storage();

const args = new Set(process.argv.slice(2));
const has = (flag) => args.has(flag);

// ---------- 源：列出 Vercel Blob 的全部对象 ----------
async function listSource() {
  const out = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await blobList({ limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...(page.blobs || []));
    cursor = page.cursor || null;
    pages += 1;
    if (pages > 200) break;
  } while (cursor);
  return out;
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function writeReport(report) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2));
}

// ---------- 各动作 ----------
async function dryRun() {
  const source = await listSource();
  const totalBytes = source.reduce((sum, blob) => sum + (blob.size || 0), 0);
  const prefixes = new Map();
  for (const blob of source) {
    const root = String(blob.pathname).split('/')[0];
    prefixes.set(root, (prefixes.get(root) || 0) + 1);
  }
  console.log('源对象数 = ' + source.length + '，总字节 = ' + totalBytes + '（' + (totalBytes / 1048576).toFixed(2) + ' MB）');
  for (const [root, count] of [...prefixes].sort()) console.log('  前缀 ' + root + '/ → ' + count + ' 个');

  const map = source.map((blob) => ({
    oldUrl: blob.url,
    newUrl: target.publicBase + '/' + blob.pathname,
    pathname: blob.pathname,
    size: blob.size || 0,
    uploadedAt: blob.uploadedAt || null
  }));
  fs.writeFileSync(MAP_PATH, JSON.stringify({ base: target.publicBase, bucket: target.bucket, objects: map }, null, 2));
  console.log('映射已写入 ' + path.relative(projectRoot, MAP_PATH) + '（' + map.length + ' 条）');
  writeReport({ action: 'dry-run', sourceCount: map.length, totalBytes, base: target.publicBase, bucket: target.bucket });
}

async function apply() {
  if (!fs.existsSync(MAP_PATH)) throw new Error('缺少映射文件，请先跑 --dry-run');
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).objects;

  // 目标侧现有对象（幂等续跑的依据）
  const existing = new Map();
  let cursor = null;
  do {
    const page = await target.list({ prefix: '', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const blob of page.blobs) existing.set(blob.pathname, blob.size);
    cursor = page.cursor || null;
  } while (cursor);
  console.log('目标已有对象 = ' + existing.size + '，待处理源对象 = ' + map.length);

  let copied = 0;
  let skipped = 0;
  const failures = [];
  const copiedHashes = {};

  for (const [index, item] of map.entries()) {
    const label = '[' + (index + 1) + '/' + map.length + '] ' + item.pathname;
    if (existing.get(item.pathname) === item.size) {
      skipped += 1;
      continue;
    }
    try {
      const response = await fetch(item.oldUrl);
      if (!response.ok) throw new Error('源下载失败 HTTP ' + response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length !== item.size) throw new Error('源大小不符：期望 ' + item.size + '，实际 ' + buffer.length);
      const hash = sha256(buffer);
      await target.put(item.pathname, buffer, {});
      copiedHashes[item.pathname] = hash;
      copied += 1;
      if (copied % 25 === 0 || copied === 1) console.log('  ' + label + ' → 已复制（累计 ' + copied + '）');
    } catch (error) {
      failures.push({ pathname: item.pathname, error: String(error && error.message).slice(0, 160) });
      console.log('  ' + label + ' → 失败：' + String(error && error.message).slice(0, 120));
    }
  }

  console.log('复制完成：新复制 ' + copied + '，跳过（已存在且大小一致）' + skipped + '，失败 ' + failures.length);
  if (failures.length) console.log('失败清单：' + failures.map((f) => f.pathname).slice(0, 10).join(', '));
  writeReport({ action: 'apply', sourceCount: map.length, copied, skipped, failed: failures.length, failures, hashes: copiedHashes });
}

async function verify() {
  if (!fs.existsSync(MAP_PATH)) throw new Error('缺少映射文件，请先跑 --dry-run');
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).objects;

  const targetObjects = new Map();
  let cursor = null;
  do {
    const page = await target.list({ prefix: '', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const blob of page.blobs) targetObjects.set(blob.pathname, blob.size);
    cursor = page.cursor || null;
  } while (cursor);

  const missing = [];
  const sizeMismatch = [];
  for (const item of map) {
    const size = targetObjects.get(item.pathname);
    if (size === undefined) missing.push(item.pathname);
    else if (size !== item.size) sizeMismatch.push(item.pathname + '（期望 ' + item.size + '，实际 ' + size + '）');
  }
  const totalBytes = [...targetObjects.values()].reduce((sum, n) => sum + n, 0);
  console.log('源对象 ' + map.length + ' 个；目标对象 ' + targetObjects.size + ' 个，总字节 ' + totalBytes);
  console.log('缺失 ' + missing.length + ' 个；大小不符 ' + sizeMismatch.length + ' 个');
  if (missing.length) console.log('  缺失示例：' + missing.slice(0, 5).join(', '));
  if (sizeMismatch.length) console.log('  不符示例：' + sizeMismatch.slice(0, 5).join(' | '));

  // 抽样 SHA-256（默认 10 个，可用 --samples=N 调整）
  const samplesArg = [...args].find((a) => a.startsWith('--samples='));
  const sampleCount = samplesArg ? Number(samplesArg.split('=')[1]) : 10;
  const step = Math.max(1, Math.floor(map.length / sampleCount));
  let hashOk = 0;
  for (let i = 0; i < map.length; i += step) {
    const item = map[i];
    const fromSource = Buffer.from(await (await fetch(item.oldUrl)).arrayBuffer());
    const fromTarget = (await target.read({ pathname: item.pathname })).body;
    if (sha256(fromSource) === sha256(fromTarget)) hashOk += 1;
    else console.log('  哈希不一致：' + item.pathname);
  }
  console.log('抽样哈希校验通过 ' + hashOk + ' / ' + Math.ceil(map.length / step));
  writeReport({ action: 'verify', sourceCount: map.length, targetCount: targetObjects.size, totalBytes, missing, sizeMismatch, hashOk });
}

async function rewriteDb(confirm) {
  const { neon } = require('@neondatabase/serverless');
  const mapData = fs.existsSync(MAP_PATH) ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).objects : [];
  // 封面 key 化：DB 存相对 key，URL 由服务端按当前 TRIPMAP_STORAGE 现场解析（换域名只需改环境变量）
  // 富文本保持绝对 URL：HTML 内嵌地址无法由 key 还原，改写为 R2 绝对 URL
  const oldToKey = new Map(mapData.map((item) => [item.oldUrl, item.pathname]));
  const oldToNew = new Map(mapData.map((item) => [item.oldUrl, item.newUrl]));

  const sql = neon(process.env.DATABASE_URL);
  const trips = await sql`SELECT id, cover_path, rich_text_path FROM trips`;

  let coverHits = 0;
  let richTextHits = 0;
  const updates = [];
  const backmap = [];
  for (const trip of trips) {
    const cover = String(trip.cover_path || '');
    const html = String(trip.rich_text_path || '');
    let nextCover = cover;
    if (oldToKey.has(cover)) { nextCover = oldToKey.get(cover); coverHits += 1; }

    let nextHtml = html;
    if (html) {
      for (const [oldUrl, newUrl] of oldToNew) {
        if (nextHtml.includes(oldUrl)) { nextHtml = nextHtml.split(oldUrl).join(newUrl); richTextHits += 1; }
      }
    }
    if (nextCover !== cover || nextHtml !== html) {
      updates.push({ id: trip.id, cover: nextCover, html: nextHtml });
      backmap.push({ id: trip.id, key: nextCover, blobUrl: cover });
    }
  }

  console.log('将改写：封面 key 化 ' + coverHits + ' 条、富文本 URL 改写 ' + richTextHits + ' 处；涉及行数 ' + updates.length);
  if (!confirm) {
    console.log('（dry-run：未写入数据库。加 --confirm 才会执行）');
    writeReport({ action: 'keyify-db-dry-run', coverHits, richTextHits, rows: updates.length });
    return;
  }

  // 先落回滚映射再改库：任何时刻都能按映射还原
  fs.writeFileSync(BACKMAP_PATH, JSON.stringify({ createdAt: new Date().toISOString(), rows: backmap }, null, 2));
  let done = 0;
  for (const row of updates) {
    await sql`UPDATE trips SET cover_path = ${row.cover}, rich_text_path = ${row.html} WHERE id = ${row.id}`;
    done += 1;
  }
  console.log('已改写 ' + done + ' 行（DB 现存相对 key；回滚映射：' + BACKMAP_PATH + '）');
  writeReport({ action: 'keyify-db-apply', coverHits, richTextHits, rows: done });
}

/** 回滚：把 key 化的封面还原为 Blob 绝对 URL，富文本改回旧 URL（配合 TRIPMAP_STORAGE=blob 即回到切换前） */
async function rollbackDb(confirm) {
  const { neon } = require('@neondatabase/serverless');
  if (!fs.existsSync(BACKMAP_PATH)) throw new Error('缺少回滚映射 ' + BACKMAP_PATH + '（由 --rewrite-db --confirm 生成）');
  const backmap = JSON.parse(fs.readFileSync(BACKMAP_PATH, 'utf8')).rows;
  const mapData = fs.existsSync(MAP_PATH) ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).objects : [];
  const newToOld = new Map(mapData.map((item) => [item.newUrl, item.oldUrl]));

  const sql = neon(process.env.DATABASE_URL);
  const trips = await sql`SELECT id, cover_path, rich_text_path FROM trips`;
  const byId = new Map(backmap.map((row) => [row.id, row]));

  let coverHits = 0;
  let richTextHits = 0;
  const updates = [];
  for (const trip of trips) {
    const cover = String(trip.cover_path || '');
    const html = String(trip.rich_text_path || '');
    let nextCover = cover;
    const entry = byId.get(trip.id);
    if (entry && entry.blobUrl && cover === entry.key) { nextCover = entry.blobUrl; coverHits += 1; }

    let nextHtml = html;
    if (html) {
      for (const [newUrl, oldUrl] of newToOld) {
        if (nextHtml.includes(newUrl)) { nextHtml = nextHtml.split(newUrl).join(oldUrl); richTextHits += 1; }
      }
    }
    if (nextCover !== cover || nextHtml !== html) updates.push({ id: trip.id, cover: nextCover, html: nextHtml });
  }

  console.log('回滚将改写：封面 ' + coverHits + ' 条、富文本 ' + richTextHits + ' 处；涉及行数 ' + updates.length);
  if (!confirm) {
    console.log('（dry-run：未写入数据库。加 --confirm 才会执行）');
    writeReport({ action: 'rollback-db-dry-run', coverHits, richTextHits, rows: updates.length });
    return;
  }
  let done = 0;
  for (const row of updates) {
    await sql`UPDATE trips SET cover_path = ${row.cover}, rich_text_path = ${row.html} WHERE id = ${row.id}`;
    done += 1;
  }
  console.log('已回滚 ' + done + ' 行（DB 恢复 Blob 绝对 URL；配合 TRIPMAP_STORAGE=blob 即回到切换前状态）');
  writeReport({ action: 'rollback-db-apply', coverHits, richTextHits, rows: done });
}

// ---------- 入口 ----------
(async () => {
  console.log('目标存储：' + target.impl + '（bucket=' + target.bucket + '，publicBase=' + target.publicBase + '）');
  if (has('--dry-run')) return dryRun();
  if (has('--apply')) return apply();
  if (has('--verify')) return verify();
  if (has('--rewrite-db')) return rewriteDb(has('--confirm'));
  if (has('--rollback-db')) return rollbackDb(has('--confirm'));
  console.log('请指定动作：--dry-run | --apply | --verify | --rewrite-db [--confirm] | --rollback-db [--confirm]');
})().catch((error) => {
  console.log('失败：' + String(error && error.message).slice(0, 300));
  process.exit(1);
});
