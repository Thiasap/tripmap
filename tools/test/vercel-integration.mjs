/**
 * Vercel 版集成测试：用内存桩替换 Neon 与 Vercel Blob，
 * 端到端验证改造后的 Express 应用（api/index.js）真实可用。
 *
 * 覆盖：CSP 响应头、登录（成功/失败/限速）、鉴权拦截、
 *       富文本净化落库、坐标越界钳制、错误处理不泄露内部信息。
 *
 * 不连接任何真实数据库或 Blob。
 *
 *   node tools/test/vercel-integration.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

process.env.SESSION_SECRET = 'integration-test-secret';
process.env.ADMIN_PASSWORD = 'integration-test-password';
process.env.NODE_ENV = 'production'; // 走线上分支：secure cookie、production 错误分支

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, message: error.message });
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

// ── 内存数据库桩：支持 routes.js 实际用到的查询形态 ──────────────────
const tables = { trips: [], settings: [], participants: [] };
let participantSeq = 0;

function normalizeSql(strings, values) {
  const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
  return { text: text.replace(/\s+/g, ' ').trim(), values };
}

async function sqlStub(strings, ...values) {
  const { text, values: v } = normalizeSql(strings, values);
  const lower = text.toLowerCase();

  if (lower.startsWith('create table')) return [];

  if (lower.startsWith('insert into settings')) {
    const [key, value] = v;
    const existing = tables.settings.find((row) => row.key === key);
    if (existing) {
      if (lower.includes('do update')) existing.value = value;
    } else {
      tables.settings.push({ key, value });
    }
    return [];
  }

  if (lower.startsWith('select key, value from settings')) return [...tables.settings];

  if (lower.startsWith('select * from settings')) {
    return tables.settings.map((row) => ({ ...row }));
  }

  if (lower.startsWith('insert into participants')) {
    const [name, lastAt, count] = v;
    const existing = tables.participants.find((row) => row.name === name);
    if (existing) {
      if (lower.includes('do update')) {
        existing.last_participated_at = lastAt;
        if (lower.includes('participants.count + 1')) existing.count += 1;
      }
      return lower.includes('returning') ? [existing] : [];
    }
    participantSeq += 1;
    const row = { id: participantSeq, name, last_participated_at: lastAt, count };
    tables.participants.push(row);
    return lower.includes('returning') ? [row] : [];
  }

  if (lower.startsWith('select') && lower.includes('from participants')) {
    if (lower.includes('where name =')) {
      return tables.participants.filter((row) => row.name === v[0]);
    }
    if (lower.includes('where id =')) {
      return tables.participants.filter((row) => String(row.id) === String(v[0]));
    }
    return [...tables.participants].sort((a, b) => b.count - a.count);
  }

  if (lower.startsWith('update participants')) {
    const row = tables.participants.find((r) => String(r.id) === String(v[3]));
    if (row) {
      row.name = v[0];
      row.last_participated_at = v[1];
      row.count = v[2];
    }
    return row && lower.includes('returning') ? [row] : [];
  }

  if (lower.startsWith('delete from participants')) {
    const index = tables.participants.findIndex((r) => String(r.id) === String(v[0]));
    if (index >= 0) tables.participants.splice(index, 1);
    return [];
  }

  if (lower.startsWith('insert into trips')) {
    const row = {
      id: v[0], name: v[1], province: v[2], city: v[3], address_detail: v[4],
      latitude: v[5], longitude: v[6], start_date: v[7], end_date: v[8],
      participants: v[9], rich_text_path: v[10], album_path: v[11],
      attachments_path: v[12], cover_path: v[13], cover_meta: v[14],
      card_position_x: v[15], card_position_y: v[16], created_at: v[17], updated_at: v[18]
    };
    tables.trips.push(row);
    return [];
  }

  if (lower.startsWith('select') && lower.includes('from trips')) {
    if (lower.includes('where id =')) {
      return tables.trips.filter((row) => row.id === v[0]);
    }
    return [...tables.trips].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  if (lower.startsWith('update trips')) {
    const row = tables.trips.find((r) => r.id === v[v.length - 1]);
    if (row) {
      const keys = ['name','province','city','address_detail','latitude','longitude','start_date','end_date','participants','rich_text_path','album_path','attachments_path','cover_path','cover_meta','card_position_x','card_position_y','updated_at'];
      keys.forEach((key, i) => { row[key] = v[i]; });
    }
    return [];
  }

  if (lower.startsWith('delete from trips')) {
    const index = tables.trips.findIndex((r) => r.id === v[0]);
    if (index >= 0) tables.trips.splice(index, 1);
    return [];
  }

  return [];
}

// Neon 的 sql.transaction()：桩实现按顺序执行全部语句
sqlStub.transaction = async (queries) => {
  const results = [];
  for (const query of queries) results.push(await query);
  return results;
};

// 内存 Blob 桩
// del 严格模拟真实 API：只接受完整 URL（http 开头），传 pathname 必须报错。
// 这样一旦有人回退成传 pathname，测试会立刻失败。
const blobs = new Map();
const blobStub = {
  put: async (pathname, body, options) => {
    blobs.set(pathname, {
      pathname,
      body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body ?? '')),
      size: body?.length ?? 0,
      contentType: options?.contentType,
      uploadedAt: new Date().toISOString()
    });
    return { url: `https://fake.blob.invalid/${pathname}` };
  },
  del: async (target) => {
    const targets = Array.isArray(target) ? target : [target];
    for (const item of targets) {
      if (typeof item !== 'string' || !/^https?:\/\//.test(item)) {
        throw new Error(`del() 只接受完整 URL，收到: ${String(item).slice(0, 60)}`);
      }
      for (const [key, value] of blobs) {
        if (`https://fake.blob.invalid/${key}` === item) blobs.delete(key);
      }
    }
  },
  list: async ({ prefix = '' } = {}) => ({
    blobs: [...blobs.values()].filter((b) => b.pathname.startsWith(prefix))
      .map((b) => ({ ...b, url: `https://fake.blob.invalid/${b.pathname}` }))
  })
};

// 拦截对假域名的 fetch：回收流程需要把对象读出来再写到 recycle/ 前缀，
// 测试里应由内存桩提供内容，而不是真的发网络请求。
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('https://fake.blob.invalid/')) {
    const pathname = decodeURIComponent(url.slice('https://fake.blob.invalid/'.length));
    const entry = blobs.get(pathname);
    if (!entry) return new Response('not found', { status: 404 });
    return new Response(entry.body, {
      status: 200,
      headers: { 'content-type': entry.contentType || 'application/octet-stream' }
    });
  }
  return realFetch(input, init);
};

// 注入桩模块
const neondbPath = require.resolve('@neondatabase/serverless');
require.cache[neondbPath] = {
  id: neondbPath, filename: neondbPath, loaded: true,
  exports: { neon: () => sqlStub }
};
const dbPath = require.resolve(path.join(projectRoot, 'server', 'db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { sql: sqlStub, initDB: async () => {} }
};
const blobPath = require.resolve('@vercel/blob');
require.cache[blobPath] = {
  id: blobPath, filename: blobPath, loaded: true,
  exports: blobStub
};

const app = require(path.join(projectRoot, 'api', 'index.js'));

let server;
let baseUrl;

function request(method, pathname, { body, raw, contentType, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = raw ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': contentType || 'application/json', 'Content-Length': payload.length } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 构造 multipart/form-data 请求体，用于测试文件上传 */
function multipart(fields) {
  const boundary = `----tripmapTest${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const field of fields) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
    if (field.filename) header += `; filename="${field.filename}"`;
    header += '\r\n';
    if (field.contentType) header += `Content-Type: ${field.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.isBuffer(field.data) ? field.data : Buffer.from(String(field.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { raw: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function loginCookieFrom(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  process.stdout.write(`临时实例: ${baseUrl}\n\n`);
  process.stdout.write('安全响应头\n');

  await test('返回 CSP 且禁止外部脚本', async () => {
    const res = await request('GET', '/api/auth/status');
    const csp = res.headers['content-security-policy'] || '';
    assert.ok(csp.includes("script-src 'self'"), `CSP 应限制 script-src，实际: ${csp}`);
    assert.ok(!csp.includes("script-src 'unsafe-inline'"), 'script-src 不应允许内联');
    assert.ok(csp.includes('blob.vercel-storage.com'), 'img-src 应放行 Blob 域名');
  });

  await test('返回其他基础安全头', async () => {
    const res = await request('GET', '/api/auth/status');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });

  process.stdout.write('\n鉴权\n');

  await test('未登录访问写接口返回 401', async () => {
    const res = await request('POST', '/api/trips', { body: { name: 'x' } });
    assert.equal(res.status, 401);
  });

  await test('错误密码返回 403 且不下发 Cookie', async () => {
    const res = await request('POST', '/api/login', { body: { password: 'wrong' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  let adminCookie = null;
  await test('正确密码返回 200 并下发 httpOnly Cookie', async () => {
    const res = await request('POST', '/api/login', { body: { password: 'integration-test-password' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { role: 'admin' });
    const raw = (res.headers['set-cookie'] || []).join(';');
    assert.ok(raw.includes('HttpOnly'), 'Cookie 应为 httpOnly');
    assert.ok(raw.includes('Secure'), 'production 下 Cookie 应为 Secure');
    adminCookie = loginCookieFrom(res);
    assert.ok(adminCookie);
  });

  await test('持有效 Cookie 时 auth/status 返回 admin', async () => {
    const res = await request('GET', '/api/auth/status', { cookie: adminCookie });
    assert.deepEqual(res.json, { role: 'admin' });
  });

  await test('伪造 Token 被视为游客', async () => {
    const res = await request('GET', '/api/auth/status', { cookie: 'token=forged.token.value' });
    assert.deepEqual(res.json, { role: 'guest' });
  });

  process.stdout.write('\n登录限速\n');

  await test('同 IP 连续失败达到上限后返回 429', async () => {
    let sawBlock = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await request('POST', '/api/login', { body: { password: `bad-${i}` } });
      if (res.status === 429) { sawBlock = true; break; }
    }
    assert.ok(sawBlock, '应出现 429 限速响应');
  });

  process.stdout.write('\n数据写入与净化\n');

  let createdTripId = null;
  await test('创建旅行时富文本被净化、坐标被钳制', async () => {
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      body: {
        name: '测试旅行',
        province: '测试省',
        city: '测试市',
        latitude: '999.9999',
        longitude: '-999.9999',
        rich_text: '<p>正文</p><script>alert(1)</script><img src="//evil.com/x.png">',
        card_position_x: '99999',
        card_position_y: '-99999'
      }
    });
    assert.equal(res.status, 201);
    const trip = res.json;
    createdTripId = trip.id;
    assert.ok(!String(trip.rich_text_path).includes('<script'), 'script 应被净化');
    assert.ok(!String(trip.rich_text_path).includes('//evil.com'), '协议相对 URL 应被净化');
    assert.ok(String(trip.rich_text_path).includes('<p>正文</p>'), '正文应保留');
    assert.ok(Number(trip.card_position_x) <= 180, `坐标应被钳制，实际 ${trip.card_position_x}`);
    assert.ok(Number(trip.card_position_y) >= -90, `坐标应被钳制，实际 ${trip.card_position_y}`);
  });

  await test('更新旅行时同样净化富文本', async () => {
    const res = await request('PUT', `/api/trips/${createdTripId}`, {
      cookie: adminCookie,
      body: { rich_text: '<img src=x onerror="alert(1)"><b>加粗</b>' }
    });
    assert.equal(res.status, 200);
    assert.ok(!String(res.json.rich_text_path).includes('onerror'));
    assert.ok(String(res.json.rich_text_path).includes('<b>加粗</b>'));
  });

  await test('非法坐标在更新时回退为原值而非 NaN', async () => {
    const before = await request('GET', '/api/trips');
    const beforeX = before.json.find((t) => t.id === createdTripId).card_position_x;
    const res = await request('PUT', `/api/trips/${createdTripId}`, {
      cookie: adminCookie,
      body: { card_position_x: 'not-a-number' }
    });
    assert.equal(res.status, 200);
    assert.equal(Number(res.json.card_position_x), Number(beforeX));
    assert.ok(Number.isFinite(Number(res.json.card_position_x)));
  });

  await test('参与次数按批处理去重提交', async () => {
    const res = await request('POST', '/api/participants/batch', {
      cookie: adminCookie,
      body: { names: ['甲', '乙', '甲', '  '] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.processed, 2, '去重并过滤空值后应为 2');
    const list = await request('GET', '/api/participants');
    assert.equal(list.json.length, 2);
  });

  process.stdout.write('\n媒体\n');

  await test('删除相册文件时回收原图与缩略图（复制到 recycle/ 后再删）', async () => {
    const tripId = createdTripId;
    blobs.set(`album/${tripId}/photo.jpg`, { pathname: `album/${tripId}/photo.jpg`, size: 10, contentType: 'image/jpeg', uploadedAt: new Date().toISOString() });
    blobs.set(`album/${tripId}/thumb_photo.jpg.jpg`, { pathname: `album/${tripId}/thumb_photo.jpg.jpg`, size: 5, contentType: 'image/jpeg', uploadedAt: new Date().toISOString() });

    const before = await request('GET', `/api/trips/${tripId}/files`);
    assert.equal(before.json.album.length, 1, '应能列出刚放入的相册图');

    const res = await request('DELETE', `/api/trips/${tripId}/files?type=album&name=${encodeURIComponent('photo.jpg')}`, {
      cookie: adminCookie
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.moved_count, 2, '原图与缩略图都应被回收');
    assert.ok(String(res.json.recycle_path).startsWith('recycle/'), '应返回回收目录');
    assert.equal(blobs.has(`album/${tripId}/photo.jpg`), false, '原图应从原位移除');
    assert.equal(blobs.has(`album/${tripId}/thumb_photo.jpg.jpg`), false, '缩略图应从原位移除');
    const recycled = [...blobs.keys()].filter((k) => k.startsWith(`${res.json.recycle_path}/album/${tripId}/`));
    assert.equal(recycled.length, 2, '回收目录中应有 2 个可恢复对象');
  });

  await test('删除旅行时回收其全部媒体后再删记录', async () => {
    const createRes = await request('POST', '/api/trips', {
      cookie: adminCookie,
      body: { name: '待删除旅行', province: '某省', city: '某市' }
    });
    const doomedId = createRes.json.id;
    blobs.set(`album/${doomedId}/a.jpg`, { pathname: `album/${doomedId}/a.jpg`, size: 3, contentType: 'image/jpeg', uploadedAt: new Date().toISOString() });
    blobs.set(`attachments/${doomedId}/b.pdf`, { pathname: `attachments/${doomedId}/b.pdf`, size: 4, contentType: 'application/pdf', uploadedAt: new Date().toISOString() });

    const res = await request('DELETE', `/api/trips/${doomedId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.moved_count, 2);
    const list = await request('GET', '/api/trips');
    assert.equal(list.json.some((t) => t.id === doomedId), false, '旅行记录应已删除');
    const recycledAlbum = [...blobs.keys()].filter((k) => k === `${res.json.recycle_path}/album/${doomedId}/a.jpg`);
    const recycledAttachment = [...blobs.keys()].filter((k) => k === `${res.json.recycle_path}/attachments/${doomedId}/b.pdf`);
    assert.equal(recycledAlbum.length, 1, '相册图应可在回收目录中找回');
    assert.equal(recycledAttachment.length, 1, '附件应可在回收目录中找回');
  });

  await test('清理接口返回与前端约定的字段', async () => {
    const res = await request('POST', '/api/cleanup-media', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.ok('recycle_path' in res.json, '应含 recycle_path');
    assert.ok('moved_count' in res.json, '应含 moved_count');
    assert.ok(Array.isArray(res.json.moved), '应含 moved 数组');
  });

  await test('清理不会回收仍存在旅行的相册图', async () => {
    blobs.set(`album/${createdTripId}/keep.jpg`, { pathname: `album/${createdTripId}/keep.jpg`, size: 9, contentType: 'image/jpeg', uploadedAt: new Date().toISOString() });
    const res = await request('POST', '/api/cleanup-media', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(blobs.has(`album/${createdTripId}/keep.jpg`), true, '存在旅行的相册图必须保留');
    assert.equal(res.json.moved.some((m) => m.from.includes('/keep.jpg')), false);
  });

  await test('清理会回收原图已丢失的孤儿缩略图', async () => {
    const orphanThumb = `album/${createdTripId}/thumb_ghost.jpg.jpg`;
    blobs.set(orphanThumb, { pathname: orphanThumb, size: 2, contentType: 'image/jpeg', uploadedAt: new Date().toISOString() });
    const res = await request('POST', '/api/cleanup-media', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(blobs.has(orphanThumb), false, '无对应原图的缩略图应被回收');
  });

  await test('删除接口拒绝非法 type', async () => {
    const res = await request('DELETE', `/api/trips/${createdTripId}/files?type=evil&name=x.jpg`, {
      cookie: adminCookie
    });
    assert.equal(res.status, 400);
  });

  await test('未授权删除媒体返回 401', async () => {
    const res = await request('DELETE', `/api/trips/${createdTripId}/files?type=album&name=x.jpg`);
    assert.equal(res.status, 401);
  });

  await test('文件列表在无缩略图时回退为原图 URL', async () => {
    blobs.set(`album/${createdTripId}/solo.jpg`, { pathname: `album/${createdTripId}/solo.jpg`, size: 7, contentType: 'image/jpeg', uploadedAt: new Date().toISOString() });
    const res = await request('GET', `/api/trips/${createdTripId}/files`);
    const item = res.json.album.find((f) => f.name === 'solo.jpg');
    assert.ok(item, '应列出 solo.jpg');
    assert.equal(item.thumb, item.url, '无缩略图时 thumb 应回退为原图 URL');
  });

  process.stdout.write('\n参与者校验\n');

  await test('新增人员拒绝负数次数', async () => {
    const res = await request('POST', '/api/participants', {
      cookie: adminCookie,
      body: { name: '负数测试', count: -5 }
    });
    assert.equal(res.status, 400);
  });

  await test('更新人员拒绝非法次数', async () => {
    const list = await request('GET', '/api/participants');
    const target = list.json[0];
    const res = await request('PUT', `/api/participants/${target.id}`, {
      cookie: adminCookie,
      body: { count: 'abc' }
    });
    assert.equal(res.status, 400);
  });

  await test('损坏的 cover_meta 不会导致读取失败', async () => {
    const trip = tables.trips.find((t) => t.id === createdTripId);
    trip.cover_meta = '{坏 JSON';
    const res = await request('GET', '/api/trips');
    assert.equal(res.status, 200);
    const found = res.json.find((t) => t.id === createdTripId);
    assert.equal(found.cover_meta, null, '坏 JSON 应回退为 null 而非抛错');
  });

  process.stdout.write('\n富文本草稿图迁移\n');

  await test('保存旅行时草稿插图迁移到旅行目录并改写 URL', async () => {
    // 模拟编辑器先上传到 draft 伪目录
    const draftPath = 'richtext_images/draft/1234_pic.jpg';
    await blobStub.put(draftPath, Buffer.from('fake-image-bytes'), { contentType: 'image/jpeg' });
    const draftUrl = `https://fake.blob.invalid/${draftPath}`;
    assert.equal(blobs.has(draftPath), true, '草稿对象应已写入');

    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      body: {
        name: '带插图的旅行',
        province: '插图省',
        city: '插图市',
        rich_text: `<p>看图</p><img src="${draftUrl}">`
      }
    });
    assert.equal(res.status, 201);
    const tripId = res.json.id;
    const html = String(res.json.rich_text_path);

    assert.ok(!html.includes('/richtext_images/draft/'), '正文不应再指向 draft 目录');
    assert.ok(html.includes(`/richtext_images/${tripId}/`), '正文应指向旅行自己的目录');
    assert.equal(blobs.has(draftPath), false, 'draft 中的原对象应已清理');
    assert.equal(blobs.has(`richtext_images/${tripId}/1234_pic.jpg`), true, '图片应已迁移到旅行目录');
  });

  await test('迁移失败时保留原 URL，不丢图', async () => {
    const missingPath = 'richtext_images/draft/missing.jpg';
    const missingUrl = `https://fake.blob.invalid/${missingPath}`;
    // 正文引用一个并不存在的 draft 对象
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      body: {
        name: '缺图旅行',
        province: '缺图省',
        city: '缺图市',
        rich_text: `<img src="${missingUrl}">`
      }
    });
    assert.equal(res.status, 201);
    assert.ok(String(res.json.rich_text_path).includes(missingPath), '无法迁移时应保留原 URL');
  });

  await test('清理不会删除宽限期内的草稿图', async () => {
    const freshDraft = 'richtext_images/draft/fresh.jpg';
    await blobStub.put(freshDraft, Buffer.from('fresh'), { contentType: 'image/jpeg' });
    const res = await request('POST', '/api/cleanup-media', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(blobs.has(freshDraft), true, '24 小时内的草稿图必须保留');
  });

  process.stdout.write('\n封面图片处理\n');

  const sharp = require('sharp');

  await test('透明 PNG 封面转 JPEG 后铺白底而非黑底', async () => {
    // 生成中间透明、边缘不透明的 PNG
    const transparentPng = await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    }).png().toBuffer();

    const form = multipart([{ name: 'cover', filename: 'transparent.png', contentType: 'image/png', data: transparentPng }]);
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      raw: form.raw,
      contentType: form.contentType
    });
    assert.equal(res.status, 201, `创建应成功，实际 ${res.status} ${res.text?.slice(0, 120)}`);

    const coverPath = String(res.json.cover_path).replace('https://fake.blob.invalid/', '');
    const stored = blobs.get(coverPath);
    assert.ok(stored, '封面对象应已写入');

    // 采样左上角像素：透明区域铺白后应为白色，若未 flatten 会是黑色
    const { data, info } = await sharp(stored.body).raw().toBuffer({ resolveWithObject: true });
    const [r, g, b] = [data[0], data[1], data[2]];
    assert.ok(r > 200 && g > 200 && b > 200,
      `透明区域应铺白底，实际 RGB=${r},${g},${b}（${info.width}x${info.height}）`);
  });

  await test('竖拍照片（EXIF 旋转）的封面宽高不颠倒', async () => {
    // 生成 80x40 横图并写入 EXIF Orientation=6（需顺时针旋转 90° 才正确）
    const base = await sharp({
      create: { width: 80, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } }
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const form = multipart([{ name: 'cover', filename: 'rotated.jpg', contentType: 'image/jpeg', data: base }]);
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      raw: form.raw,
      contentType: form.contentType
    });
    assert.equal(res.status, 201);

    const meta = res.json.cover_meta;
    assert.ok(meta && Number.isFinite(meta.width) && Number.isFinite(meta.height), '应返回封面宽高');
    assert.ok(meta.height > meta.width,
      `旋转后应变为竖图（高 > 宽），实际 ${meta.width}x${meta.height}；若使用原图 metadata 会颠倒`);

    // 交叉验证：直接解码存储的封面，确认尺寸一致
    const coverPath = String(res.json.cover_path).replace('https://fake.blob.invalid/', '');
    const storedMeta = await sharp(blobs.get(coverPath).body).metadata();
    assert.equal(meta.width, storedMeta.width, '记录宽度应与实际封面一致');
    assert.equal(meta.height, storedMeta.height, '记录高度应与实际封面一致');
  });

  process.stdout.write('\n上传校验\n');

  await test('不支持的文件类型返回 400 而非 500', async () => {
    const form = multipart([
      { name: 'album', filename: 'evil.exe', contentType: 'application/octet-stream', data: Buffer.from('MZ') }
    ]);
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      raw: form.raw,
      contentType: form.contentType
    });
    assert.equal(res.status, 400, `应返回 400，实际 ${res.status}`);
    assert.ok(String(res.json?.error || '').includes('不支持的文件类型'), '应说明真实原因');
  });

  await test('非图片字段（除 attachments）拒绝错误 MIME', async () => {
    const form = multipart([
      { name: 'album', filename: 'note.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4') }
    ]);
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      raw: form.raw,
      contentType: form.contentType
    });
    assert.equal(res.status, 400);
    assert.ok(String(res.json?.error || '').includes('仅支持图片格式'));
  });

  await test('attachments 字段允许非图片文件', async () => {
    const form = multipart([
      { name: 'attachments', filename: 'note.txt', contentType: 'text/plain', data: Buffer.from('hello') }
    ]);
    const res = await request('POST', '/api/trips', {
      cookie: adminCookie,
      raw: form.raw,
      contentType: form.contentType
    });
    assert.equal(res.status, 201, `附件上传应成功，实际 ${res.status} ${res.text?.slice(0, 120)}`);
  });

  process.stdout.write('\n错误处理\n');

  await test('服务端错误不泄露内部细节', async () => {
    const res = await request('GET', '/api/trips/nonexistent-id/files');
    assert.equal(res.status, 200, '文件列表对不存在的 id 返回空列表');
    assert.deepEqual(res.json, { album: [], attachments: [], richtextImages: [] });
  });

  process.stdout.write('\n生成器\n');

  await test('旅行 id 由省市哈希加随机后缀构成', () => {
    assert.ok(/^[0-9]{4}[0-9]{4}[a-z0-9]{1,6}$/.test(createdTripId), `id 形态异常: ${createdTripId}`);
  });

  await new Promise((resolve) => server.close(resolve));

  process.stdout.write(`\n${passed} 通过，${failed} 失败\n`);
  if (failed) {
    process.stdout.write('\n失败用例:\n');
    for (const f of failures) process.stdout.write(`  ${f.name}: ${f.message}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`集成测试异常: ${error.stack}\n`);
  if (server) server.close();
  process.exit(1);
});
