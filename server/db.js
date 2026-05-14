const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, '..', 'tripmap.sqlite');
const sqlite = new DatabaseSync(dbPath);

sqlite.exec('PRAGMA journal_mode = WAL');

sqlite.exec(`
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
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    last_participated_at TEXT,
    count INTEGER DEFAULT 0
  )
`);

const defaultSettings = {
  card_max_width: '360',
  card_title_font_size: '16',
  card_meta_font_size: '13',
  card_scale: '1'
};

Object.entries(defaultSettings).forEach(([key, value]) => {
  sqlite.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
});

const columns = sqlite.prepare('PRAGMA table_info(trips)').all().map((column) => column.name);
if (!columns.includes('cover_meta')) {
  sqlite.exec('ALTER TABLE trips ADD COLUMN cover_meta TEXT');
}

function convertParams(params) {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params;
  if (!params || typeof params !== 'object') return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [`$${key}`, value]));
}

const db = {
  exec(sql) {
    return sqlite.exec(sql);
  },
  prepare(sql) {
    const statement = sqlite.prepare(sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, '$$$1'));
    return {
      get(...params) {
        const values = params.length === 1 ? convertParams(params[0]) : undefined;
        if (params.length > 1) return statement.get(...params);
        return values === undefined ? statement.get() : statement.get(values);
      },
      all(...params) {
        const values = params.length === 1 ? convertParams(params[0]) : undefined;
        if (params.length > 1) return statement.all(...params);
        return values === undefined ? statement.all() : statement.all(values);
      },
      run(...params) {
        const values = params.length === 1 ? convertParams(params[0]) : undefined;
        if (params.length > 1) return statement.run(...params);
        return values === undefined ? statement.run() : statement.run(values);
      }
    };
  }
};

module.exports = db;
