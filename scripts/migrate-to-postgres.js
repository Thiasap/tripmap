/**
 * 将本地 SQLite 数据迁移到 Vercel Postgres
 *
 * 使用方式:
 *   设置环境变量 POSTGRES_URL 后运行:
 *   node scripts/migrate-to-postgres.js
 *
 * 环境变量:
 *   POSTGRES_URL - Vercel Postgres 连接字符串 (或使用本地 .env / vercel env pull)
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('请设置 POSTGRES_URL 或 DATABASE_URL 环境变量');
  process.exit(1);
}
const sql = neon(DATABASE_URL);

const dbPath = path.join(__dirname, '..', 'tripmap.sqlite');
const sqlite = new DatabaseSync(dbPath);

async function migrate() {
  console.log('开始迁移数据...\n');

  // 1. 创建表结构
  console.log('创建表结构...');
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
  console.log('表结构创建完成\n');

  // 2. 迁移 trips
  console.log('迁移 trips...');
  const trips = sqlite.prepare('SELECT * FROM trips').all();
  let tripCount = 0;
  for (const trip of trips) {
    await sql`
      INSERT INTO trips (id, name, province, city, address_detail, latitude, longitude, start_date, end_date, participants, rich_text_path, album_path, attachments_path, cover_path, cover_meta, card_position_x, card_position_y, created_at, updated_at)
      VALUES (${trip.id}, ${trip.name}, ${trip.province}, ${trip.city}, ${trip.address_detail}, ${trip.latitude}, ${trip.longitude}, ${trip.start_date}, ${trip.end_date}, ${trip.participants}, ${trip.rich_text_path}, ${trip.album_path}, ${trip.attachments_path}, ${trip.cover_path}, ${trip.cover_meta}, ${trip.card_position_x}, ${trip.card_position_y}, ${trip.created_at}, ${trip.updated_at})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, province = EXCLUDED.province, city = EXCLUDED.city,
        address_detail = EXCLUDED.address_detail, latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude, start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date, participants = EXCLUDED.participants,
        rich_text_path = EXCLUDED.rich_text_path, album_path = EXCLUDED.album_path,
        attachments_path = EXCLUDED.attachments_path, cover_path = EXCLUDED.cover_path,
        cover_meta = EXCLUDED.cover_meta, card_position_x = EXCLUDED.card_position_x,
        card_position_y = EXCLUDED.card_position_y, updated_at = EXCLUDED.updated_at
    `;
    tripCount++;
  }
  console.log(`  已迁移 ${tripCount} 条行程\n`);

  // 3. 迁移 settings
  console.log('迁移 settings...');
  const settings = sqlite.prepare('SELECT * FROM settings').all();
  let settingCount = 0;
  for (const setting of settings) {
    await sql`
      INSERT INTO settings (key, value) VALUES (${setting.key}, ${setting.value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    settingCount++;
  }
  console.log(`  已迁移 ${settingCount} 条设置\n`);

  // 4. 迁移 participants
  console.log('迁移 participants...');
  const participants = sqlite.prepare('SELECT * FROM participants').all();
  let participantCount = 0;
  for (const p of participants) {
    await sql`
      INSERT INTO participants (name, last_participated_at, count)
      VALUES (${p.name}, ${p.last_participated_at}, ${p.count})
      ON CONFLICT (name) DO UPDATE SET
        last_participated_at = EXCLUDED.last_participated_at,
        count = EXCLUDED.count
    `;
    participantCount++;
  }
  console.log(`  已迁移 ${participantCount} 名人员\n`);

  console.log('数据库迁移完成！');
  process.exit(0);
}

migrate().catch(err => {
  console.error('迁移失败:', err);
  process.exit(1);
});
