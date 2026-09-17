/**
 * 将本地 media/ 文件上传到 Vercel Blob，并更新数据库中的路径
 *
 * 使用方式:
 *   node scripts/migrate-to-blob.js
 *
 * 环境变量:
 *   BLOB_READ_WRITE_TOKEN - Vercel Blob token
 *   POSTGRES_URL          - Vercel Postgres 连接字符串
 */

const fs = require('fs');
const path = require('path');
const { put, list } = require('@vercel/blob');
const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('请设置 POSTGRES_URL 或 DATABASE_URL 环境变量');
  process.exit(1);
}
const sql = neon(DATABASE_URL);

const rootDir = path.join(__dirname, '..');
const mediaDir = path.join(rootDir, 'media');

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(current);
    return [current];
  });
}

async function migrate() {
  console.log('开始迁移媒体文件...\n');

  // 按类型分组上传
  const types = ['album', 'attachments', 'richtext_images'];
  let totalCount = 0;
  const coverUpdates = [];

  for (const type of types) {
    const typeDir = path.join(mediaDir, type);
    const files = walkFiles(typeDir);
    console.log(`上传 ${type} (${files.length} 个文件)...`);

    for (const filePath of files) {
      const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');
      const buffer = fs.readFileSync(filePath);

      // Blob path: album/tripId/filename.jpg
      const parts = relativePath.split('/');
      // parts = ['media', 'album', 'tripId', 'filename.jpg'] or ['media', 'album', 'tripId', 'thumb_filename.jpg']
      const blobPath = parts.slice(1).join('/'); // 'album/tripId/filename.jpg'

      try {
        const mimeType = filePath.match(/\.(jpg|jpeg)$/i) ? 'image/jpeg'
          : filePath.match(/\.png$/i) ? 'image/png'
          : filePath.match(/\.webp$/i) ? 'image/webp'
          : filePath.match(/\.gif$/i) ? 'image/gif'
          : 'application/octet-stream';

        const blob = await put(blobPath, buffer, {
          access: 'public',
          contentType: mimeType
        });

        // 如果是封面图片，记录需要更新的数据库条目
        const fileName = path.basename(filePath);
        if (type === 'album' && fileName.startsWith('cover_')) {
          const tripId = parts[2];
          coverUpdates.push({ tripId, url: blob.url });
        }

        totalCount++;
        if (totalCount % 10 === 0) process.stdout.write(`  已上传 ${totalCount} 个文件...\r`);
      } catch (err) {
        console.error(`\n  上传失败: ${blobPath}`, err.message);
      }
    }
    console.log(`  ${type} 完成`);
  }

  // 更新封面路径
  console.log(`\n更新封面路径 (${coverUpdates.length} 个)...`);
  for (const { tripId, url } of coverUpdates) {
    await sql`UPDATE trips SET cover_path = ${url} WHERE id = ${tripId}`;
    console.log(`  ${tripId} -> ${url}`);
  }

  // 更新 richtext_images 中的引用
  console.log('\n更新富文本图片引用...');
  const trips = await sql`SELECT id, rich_text_path FROM trips WHERE rich_text_path LIKE '%/media/%'`;
  for (const trip of trips) {
    const { blobs } = await list({ prefix: `richtext_images/${trip.id}/`, limit: 1000 });
    const urlMap = {};
    for (const blob of blobs) {
      const name = blob.pathname.split('/').pop();
      const oldPath = `/media/richtext_images/${trip.id}/${name}`;
      urlMap[oldPath] = blob.url;
    }
    let updated = trip.rich_text_path;
    for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
      const encodedOld = oldUrl.replace(/\//g, '\\/');
      updated = updated.replace(new RegExp(encodedOld, 'g'), newUrl);
    }
    if (updated !== trip.rich_text_path) {
      await sql`UPDATE trips SET rich_text_path = ${updated} WHERE id = ${trip.id}`;
      console.log(`  ${trip.id} 富文本引用已更新`);
    }
  }

  console.log(`\n媒体文件迁移完成！共上传 ${totalCount} 个文件`);
  process.exit(0);
}

migrate().catch(err => {
  console.error('迁移失败:', err);
  process.exit(1);
});
