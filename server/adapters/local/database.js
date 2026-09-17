/**
 * 数据库适配层 · 本地实现：SQLite（node:sqlite）。
 *
 * 满足 server/adapters/database.js 的契约：
 *   sql`SELECT ... ${param}`        → thenable；await 后得到行数组
 *   sql.transaction([q1, q2, ...])  → 单事务执行，任一失败整体回滚
 *   initDB()                        → 幂等建表 + 默认设置
 *
 * 数据目录由 `TRIPMAP_LOCAL_ROOT` 指定（默认仓库根）：
 *   <root>/tripmap.sqlite  +  <root>/media/
 *
 * 说明：上层 SQL 与云端共用（都是 tagged template 写法），SQLite 差异集中在本文件的
 * `normalizeSql()` 里显式处理，不散落到业务代码。
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * SQLite 方言归一化：把业务层的通用写法适配到 SQLite。
 * 只处理已知差异，且每条都对应契约测试/走查覆盖的场景。
 */
function normalizeSql(text) {
  return String(text)
    // SQLite 的 ON CONFLICT DO UPDATE 里不允许用表名限定列（PG 允许）
    .replace(/(\bDO UPDATE SET\b[\s\S]*)$/i, (clause) => clause.replace(/\bparticipants\.count\b/g, 'count'));
}

function createLocalDatabase() {
  const root = process.env.TRIPMAP_LOCAL_ROOT;
  if (!root) {
    throw new Error('[db] local 模式必须设置 TRIPMAP_LOCAL_ROOT（指向含 tripmap.sqlite 与 media/ 的目录）');
  }

  const db = new DatabaseSync(path.join(root, 'tripmap.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');

  /** 执行一条语句：有结果集（SELECT / RETURNING）时返回行数组，否则返回空数组 */
  function run(text, params) {
    const statement = db.prepare(normalizeSql(text));
    if (/^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text)) {
      return statement.all(...params);
    }
    statement.run(...params);
    return [];
  }

  /** 与 Neon tagged template 同形的契约实现：返回 thenable 的查询对象 */
  const sql = (strings, ...params) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    return {
      text,
      params,
      then(resolve, reject) {
        try { resolve(run(text, params)); } catch (error) { reject(error); }
      }
    };
  };

  sql.transaction = (queries) => {
    const list = Array.isArray(queries) ? queries : [queries];
    db.exec('BEGIN IMMEDIATE');
    try {
      const results = list.map((query) => run(query.text, query.params));
      db.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败时以原始错误为准 */ }
      throw error;
    }
  };

  async function initDB() {
    await sql`
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
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        last_participated_at TEXT,
        count INTEGER DEFAULT 0
      )
    `;

    for (const [key, value] of Object.entries(require('../database').DEFAULT_SETTINGS)) {
      await sql`INSERT INTO settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`;
    }
  }

  return { sql, initDB, mode: 'local', impl: 'sqlite', path: path.join(root, 'tripmap.sqlite') };
}

module.exports = { createLocalDatabase, normalizeSql };
