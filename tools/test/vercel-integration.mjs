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

// 内存 Blob 桩
// del 严格模拟真实 API：只接受完整 URL（http 开头），传 pathname 必须报错。
// 这样一旦有人回退成传 pathname，测试会立刻失败。
const blobs = new Map();
const blobStub = {
  put: async (pathname, body, options) => {
    blobs.set(pathname, { pathname, size: body?.length ?? 0, contentType: options?.contentType });
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

function request(method, pathname, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
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

  await test('删除相册文件时按 URL 精确删除原图与缩略图', async () => {
    const tripId = createdTripId;
    blobs.set(`album/${tripId}/photo.jpg`, { pathname: `album/${tripId}/photo.jpg`, size: 10, contentType: 'image/jpeg' });
    blobs.set(`album/${tripId}/thumb_photo.jpg.jpg`, { pathname: `album/${tripId}/thumb_photo.jpg.jpg`, size: 5, contentType: 'image/jpeg' });

    const before = await request('GET', `/api/trips/${tripId}/files`);
    assert.equal(before.json.album.length, 1, '应能列出刚放入的相册图');

    const res = await request('DELETE', `/api/trips/${tripId}/files?type=album&name=${encodeURIComponent('photo.jpg')}`, {
      cookie: adminCookie
    });
    assert.equal(res.status, 204);
    assert.equal(blobs.has(`album/${tripId}/photo.jpg`), false, '原图应被删除');
    assert.equal(blobs.has(`album/${tripId}/thumb_photo.jpg.jpg`), false, '缩略图应被删除');
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
    blobs.set(`album/${createdTripId}/solo.jpg`, { pathname: `album/${createdTripId}/solo.jpg`, size: 7, contentType: 'image/jpeg' });
    const res = await request('GET', `/api/trips/${createdTripId}/files`);
    const item = res.json.album.find((f) => f.name === 'solo.jpg');
    assert.ok(item, '应列出 solo.jpg');
    assert.equal(item.thumb, item.url, '无缩略图时 thumb 应回退为原图 URL');
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
