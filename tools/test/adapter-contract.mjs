/**
 * 数据库适配层契约测试（内存桩，不接触真实数据库）。
 *
 * 任何适配实现（cloud 的 PostgreSQL、local 的 SQLite）都必须满足本文件断言的契约。
 * 新增实现后，把它接到同一套断言上跑一遍即可。
 */
import { createRequire } from 'node:module';
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

// ---- 内存桩：模拟 @neondatabase/serverless 的 neon() tagged-template 契约 ----
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

const adapterPath = require.resolve(path.join(projectRoot, 'server', 'adapters', 'database.js'));
/** 以指定环境变量重新加载适配层（MODE 在模块加载时读取） */
function freshAdapter(env = {}) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  delete require.cache[adapterPath];
  return require(adapterPath);
}

process.stdout.write('\ndatabase adapter contract\n');
process.env.TRIPMAP_BACKEND = 'cloud';
delete process.env.VERCEL_ENV;
const db = freshAdapter().createDatabase();

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

await test('护栏：未知后端模式必须抛错（不静默回退）', () => {
  const mod = freshAdapter({ TRIPMAP_BACKEND: 'sqlite-maybe' });
  let threw = false;
  try { mod.createDatabase(); } catch { threw = true; }
  assert(threw, '未知模式应抛错');
});

await test('护栏：生产环境禁止 local 后端', () => {
  const mod = freshAdapter({ TRIPMAP_BACKEND: 'local', VERCEL_ENV: 'production' });
  let threw = false;
  try { mod.createDatabase(); } catch { threw = true; }
  assert(threw, '生产 + local 应抛错');
});

process.env.TRIPMAP_BACKEND = 'cloud';
delete process.env.VERCEL_ENV;

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
