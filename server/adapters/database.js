/**
 * 数据库适配层：按 `TRIPMAP_BACKEND` 选择后端，向上暴露统一契约。
 *
 * 契约（所有实现必须满足，调用点只依赖这一层）：
 *   sql`SELECT ... ${param}`        → thenable；await 后得到**行数组**（SELECT / RETURNING）
 *   sql.transaction([q1, q2, ...])  → 同一事务内执行全部查询，返回结果数组；任一失败整体回滚
 *   initDB()                        → 幂等建表 + 写入默认设置
 *
 * 接口刻意与 @neondatabase/serverless 的 tagged template **同形**，
 * 因此现有调用点（server/routes.js、api/index.js）无需改写；换后端只换实现。
 *
 * 实现：
 *   cloud（默认）→ Neon PostgreSQL（HTTP 驱动，异步）
 *   local        → SQLite（node:sqlite，同步）—— P3 落地
 */

const { MODE, assertModeAllowed } = require('./mode');

/** 默认设置项（两种后端共用） */
const DEFAULT_SETTINGS = {
  card_max_width: '360',
  card_title_font_size: '16',
  card_meta_font_size: '13',
  card_scale: '1',
  map_stretch: '1',
  pin_size: '7',
  default_zoom: '1'
};

/**
 * 模式校验：宁可起不来，也不写错库（实现见 ./mode.js）。
 */

/** Neon PostgreSQL 实现（生产默认） */
function createPostgresDatabase() {
  const { neon } = require('@neondatabase/serverless');

  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('POSTGRES_URL or DATABASE_URL environment variable is required');
  }
  const sql = neon(url || '');

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
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        last_participated_at TEXT,
        count INTEGER DEFAULT 0
      )
    `;

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await sql`INSERT INTO settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`;
    }
  }

  return { sql, initDB, mode: 'cloud' };
}

/** SQLite 实现（本地开发）：见 ./local/database.js */
function createLocalDatabase() {
  return require('./local/database').createLocalDatabase();
}

function createDatabase() {
  assertModeAllowed();
  const db = MODE === 'local' ? createLocalDatabase() : createPostgresDatabase();
  console.log(`[backend] mode=${db.mode} db=${db.mode === 'local' ? 'sqlite' : 'postgres'}`);
  return db;
}

module.exports = { createDatabase, assertModeAllowed, DEFAULT_SETTINGS, MODE };
