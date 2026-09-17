const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('POSTGRES_URL or DATABASE_URL environment variable is required');
}
const sql = neon(DATABASE_URL || '');

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

  const defaultSettings = {
    card_max_width: '360',
    card_title_font_size: '16',
    card_meta_font_size: '13',
    card_scale: '1',
    map_stretch: '1',
    pin_size: '7',
    default_zoom: '1'
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    await sql`INSERT INTO settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`;
  }
}

module.exports = { sql, initDB };
