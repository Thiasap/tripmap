/**
 * 适配层契约测试（内存桩，不接触真实数据库 / 存储）。
 *
 * 任何实现（cloud 的 PostgreSQL + Vercel Blob、local 的 SQLite + 本地 fs）都必须满足本文件断言；
 * 新增实现后接到同一套断言上跑一遍即可。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass += 1;
  } catch (e) {
    console.log('  FAIL ' + name + ' —— ' + (e && e.message ? e.message : e));
    fail += 1;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function equal(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg || '不相等') + `：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ---------- 桩 1：@neondatabase/serverless ----------
const recorded = [];
function fakeNeon() {
  const makeQuery = (text, params) => ({
    text,
    params,
    then(resolve) { return Promise.resolve([{ sql: text, params }]).then(resolve); }
  });
  const sql = (strings, ...params) => {
    const text = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
    recorded.push({ kind: 'query', text, params });
    return makeQuery(text, params);
  };
  sql.transaction = async (queries) => {
    recorded.push({ kind: 'transaction', count: queries.length });
    return queries.map((q) => ({ sql: q.text }));
  };
  return sql;
}
const neonPath = require.resolve('@neondatabase/serverless');
require.cache[neonPath] = { id: neonPath, filename: neonPath, loaded: true, exports: { neon: fakeNeon } };

// ---------- 桩 2：@vercel/blob + fetch 拦截 ----------
const FAKE_ORIGIN = 'https://fake.blob.invalid/';
const fakeObjects = new Map();
const blobStub = {
  put: async (pathname, body, options = {}) => {
    const buffer = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body ?? ''));
    fakeObjects.set(pathname, {
      pathname,
      body: buffer,
      size: buffer.length,
      contentType: options.contentType || null,
      uploadedAt: new Date().toISOString()
    });
    return { url: FAKE_ORIGIN + pathname, pathname };
  },
  del: async (target) => {
    for (const item of Array.isArray(target) ? target : [target]) {
      if (typeof item !== 'string' || !/^https?:\/\//.test(item)) {
        throw new Error(`del() 只接受完整 URL，收到: ${String(item).slice(0, 60)}`);
      }
      for (const [key] of fakeObjects) if (FAKE_ORIGIN + key === item) fakeObjects.delete(key);
    }
  },
  list: async ({ prefix = '' } = {}) => ({
    blobs: [...fakeObjects.values()]
      .filter((b) => b.pathname.startsWith(prefix))
      .map((b) => ({ ...b, url: FAKE_ORIGIN + b.pathname }))
  })
};
const blobPath = require.resolve('@vercel/blob');
require.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: blobStub };

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (url.startsWith(FAKE_ORIGIN)) {
    const entry = fakeObjects.get(decodeURIComponent(url.slice(FAKE_ORIGIN.length)));
    if (!entry) return new Response('not found', { status: 404 });
    return new Response(entry.body, { status: 200, headers: { 'content-type': entry.contentType || 'application/octet-stream' } });
  }
  return realFetch(input, init);
};

// ---------- 适配层加载（MODE 在 mode.js 加载时读取，故需清其缓存） ----------
const modePath = require.resolve(path.join(projectRoot, 'server', 'adapters', 'mode.js'));
const dbAdapterPath = require.resolve(path.join(projectRoot, 'server', 'adapters', 'database.js'));
const storageAdapterPath = require.resolve(path.join(projectRoot, 'server', 'adapters', 'storage.js'));

/** 以指定环境变量重新加载某个适配模块 */
function fresh(adapterPath, env = {}) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  delete require.cache[modePath];
  delete require.cache[adapterPath];
  return require(adapterPath);
}

process.stdout.write('\ndatabase adapter contract\n');
process.env.TRIPMAP_BACKEND = 'cloud';
delete process.env.VERCEL_ENV;
const db = fresh(dbAdapterPath).createDatabase();

await test('sql 契约：tagged template 透传 SQL 文本并按位置绑定参数', async () => {
  recorded.length = 0;
  const rows = await db.sql`SELECT * FROM trips WHERE id = ${'trip-1'}`;
  assert(Array.isArray(rows), 'await 后应得到行数组');
  const query = recorded.find((item) => item.kind === 'query');
  assert(query, '应记录到一次查询');
  assert(query.text.includes('SELECT * FROM trips'), 'SQL 文本应原样透传');
  equal(query.params, ['trip-1'], '参数应按位置绑定');
});

await test('transaction 契约：批量查询走同一事务并返回各结果', async () => {
  recorded.length = 0;
  const results = await db.sql.transaction([
    db.sql`INSERT INTO participants (name) VALUES (${'a'})`,
    db.sql`INSERT INTO participants (name) VALUES (${'b'})`
  ]);
  const tx = recorded.find((item) => item.kind === 'transaction');
  assert(tx, '应走事务路径');
  equal(tx.count, 2, '事务内应含 2 条查询');
  equal(results.length, 2, '应返回每条查询的结果');
});

await test('initDB 契约：幂等建 3 张表 + 写入 7 项默认设置', async () => {
  recorded.length = 0;
  await db.initDB();
  const creates = recorded.filter((item) => item.kind === 'query' && /CREATE TABLE IF NOT EXISTS/.test(item.text));
  const tables = new Set(creates.map((item) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(item.text)[1]));
  equal(tables.size, 3, '应创建 3 张表');
  const seeds = recorded.filter((item) => item.kind === 'query' && /INSERT INTO settings/.test(item.text));
  equal(seeds.length, 7, '应写入 7 项默认设置');
  assert(seeds.every((item) => /ON CONFLICT \(key\) DO NOTHING/.test(item.text)), '默认设置写入必须幂等');
});

process.stdout.write('\nstorage adapter contract\n');
const storage = fresh(storageAdapterPath).createStorage();

await test('put 契约：写入后可由 list 按前缀列出（含 size 与 contentType）', async () => {
  fakeObjects.clear();
  const uploaded = await storage.put('album/t1/a.jpg', Buffer.from('hello'), { contentType: 'image/jpeg' });
  assert(uploaded && uploaded.url, 'put 应返回对象 url');
  assert(uploaded.url.includes('album/t1/a.jpg'), 'url 应指向写入的 pathname');
  const { blobs } = await storage.list({ prefix: 'album/t1/' });
  equal(blobs.length, 1, '应列出 1 个对象');
  equal(blobs[0].pathname, 'album/t1/a.jpg', 'pathname 应一致');
  equal(blobs[0].size, 5, 'size 应为实际字节数');
  assert(blobs[0].uploadedAt, '应带 uploadedAt');
  equal((await storage.list({ prefix: 'album/other/' })).blobs.length, 0, '其他前缀不应命中');
});

await test('read 契约：按对象读取内容，返回 Buffer 与 contentType', async () => {
  const { body, contentType } = await storage.read({ url: FAKE_ORIGIN + 'album/t1/a.jpg' });
  assert(Buffer.isBuffer(body), 'body 应为 Buffer');
  equal(body.toString(), 'hello', '内容应逐字节一致');
  equal(contentType, 'image/jpeg', 'contentType 应透传');
});

await test('read 契约：对象不存在时必须抛错', async () => {
  let threw = false;
  try { await storage.read({ url: FAKE_ORIGIN + 'album/t1/missing.jpg' }); } catch { threw = true; }
  assert(threw, '读取不存在的对象应抛错');
});

await test('del 契约：按 url 删除对象', async () => {
  await storage.del([FAKE_ORIGIN + 'album/t1/a.jpg']);
  equal((await storage.list({ prefix: 'album/t1/' })).blobs.length, 0, '删除后不应再列出');
});

// ---------- local 实现契约（真实 SQLite + 真实文件系统，临时目录） ----------
process.stdout.write('\nlocal adapter contract（临时目录：真实 SQLite + 文件系统）\n');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tripmap-local-'));
const localDb = fresh(dbAdapterPath, { TRIPMAP_BACKEND: 'local', TRIPMAP_LOCAL_ROOT: tmpRoot }).createDatabase();

await test('local·sql 契约：参数按位置绑定并返回行数组', async () => {
  const rows = await localDb.sql`SELECT ${7} AS n, ${'a'} AS s`;
  equal(rows.length, 1, '应返回 1 行');
  equal(rows[0].n, 7, '数值参数应绑定');
  equal(rows[0].s, 'a', '字符串参数应绑定');
});

await test('local·initDB 契约：建 3 张表 + 7 项默认设置，重复执行幂等', async () => {
  await localDb.initDB();
  const tables = await localDb.sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trips','settings','participants')`;
  equal(tables.length, 3, '应有 trips/settings/participants 三张表');
  const before = (await localDb.sql`SELECT COUNT(*) AS n FROM settings`)[0].n;
  equal(before, 7, '默认设置应为 7 项');
  await localDb.initDB();
  const after = (await localDb.sql`SELECT COUNT(*) AS n FROM settings`)[0].n;
  equal(after, before, '重复 initDB 不应重复写入');
});

await test('local·transaction 契约：全部成功则提交', async () => {
  await localDb.sql.transaction([
    localDb.sql`INSERT INTO settings (key, value) VALUES (${'tx_a'}, ${'1'})`,
    localDb.sql`INSERT INTO settings (key, value) VALUES (${'tx_b'}, ${'2'})`
  ]);
  const rows = await localDb.sql`SELECT key FROM settings WHERE key IN ('tx_a','tx_b')`;
  equal(rows.length, 2, '两条写入都应生效');
});

await test('local·transaction 契约：任一失败则整体回滚', async () => {
  let threw = false;
  try {
    await localDb.sql.transaction([
      localDb.sql`INSERT INTO settings (key, value) VALUES (${'tx_c'}, ${'3'})`,
      localDb.sql`INSERT INTO settings (key, value) VALUES (${'tx_a'}, ${'dup'})`
    ]);
  } catch { threw = true; }
  assert(threw, '主键冲突应抛错');
  const rows = await localDb.sql`SELECT key FROM settings WHERE key = ${'tx_c'}`;
  equal(rows.length, 0, '失败事务应整体回滚');
});

await test('local·业务方言：ON CONFLICT DO UPDATE 累加参与次数可用', async () => {
  for (const day of ['2026-01-01', '2026-01-02']) {
    await localDb.sql`INSERT INTO participants (name, last_participated_at, count)
      VALUES (${'甲'}, ${day}, 1)
      ON CONFLICT (name) DO UPDATE SET
        last_participated_at = EXCLUDED.last_participated_at,
        count = participants.count + 1`;
  }
  const rows = await localDb.sql`SELECT count FROM participants WHERE name = ${'甲'}`;
  equal(rows[0].count, 2, '参与次数应累加到 2');
});

const localStorage = fresh(storageAdapterPath, { TRIPMAP_BACKEND: 'local', TRIPMAP_LOCAL_ROOT: tmpRoot }).createStorage();

await test('local·storage：put/list/read/del 全链路', async () => {
  const uploaded = await localStorage.put('album/t9/a.jpg', Buffer.from('abc'), { contentType: 'image/jpeg' });
  equal(uploaded.url, '/media/album/t9/a.jpg', 'url 应为 /media/...');
  const listed = await localStorage.list({ prefix: 'album/t9/' });
  equal(listed.blobs.length, 1, '应列出 1 个对象');
  equal(listed.blobs[0].size, 3, 'size 应为实际字节数');
  const read = await localStorage.read({ url: '/media/album/t9/a.jpg' });
  equal(read.body.toString(), 'abc', '内容应逐字节一致');
  equal(read.contentType, 'image/jpeg', 'contentType 应由扩展名推断');
  await localStorage.del(['/media/album/t9/a.jpg']);
  equal((await localStorage.list({ prefix: 'album/t9/' })).blobs.length, 0, '删除后不应再列出');
});

await test('local·storage：路径穿越与非法路径必须拒绝', async () => {
  let rejected = 0;
  for (const bad of ['../evil.txt', '/abs/evil.txt', 'C:/evil.txt', 'a\\b.txt', 'a\0b.txt']) {
    try { await localStorage.put(bad, Buffer.from('x')); } catch { rejected += 1; }
  }
  equal(rejected, 5, '5 种非法路径都应被拒绝');
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }

await test('护栏：未知后端模式必须抛错（不静默回退）', () => {
  const mod = fresh(dbAdapterPath, { TRIPMAP_BACKEND: 'sqlite-maybe' });
  let threw = false;
  try { mod.createDatabase(); } catch { threw = true; }
  assert(threw, '未知模式应抛错');
});

await test('护栏：生产环境禁止 local 后端（数据库与存储都要拦）', () => {
  let dbThrew = false;
  let storageThrew = false;
  try { fresh(dbAdapterPath, { TRIPMAP_BACKEND: 'local', VERCEL_ENV: 'production' }).createDatabase(); } catch { dbThrew = true; }
  try { fresh(storageAdapterPath, { TRIPMAP_BACKEND: 'local', VERCEL_ENV: 'production' }).createStorage(); } catch { storageThrew = true; }
  assert(dbThrew, '数据库适配层应拒绝');
  assert(storageThrew, '存储适配层应拒绝');
});

process.env.TRIPMAP_BACKEND = 'cloud';
delete process.env.VERCEL_ENV;

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
