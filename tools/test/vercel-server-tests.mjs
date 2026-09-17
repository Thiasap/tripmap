/**
 * Vercel 版服务端自检：鉴权模块、富文本净化、路由装载。
 *
 * 这些用例不连接数据库、不访问 Blob、不触碰生产环境：
 * 通过对 require 缓存注入桩模块，隔离验证纯逻辑。
 *
 *   node tools/test/vercel-server-tests.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** 用桩模块替换相对路径依赖，避免加载真实数据库与 Blob 客户端 */
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

// ── 环境准备：桩掉 Neon 与 Blob，避免任何网络与凭据需求 ──────────────
process.env.SESSION_SECRET = 'test-secret-for-unit-tests';
process.env.ADMIN_PASSWORD = 'test-password';

stub(path.join(projectRoot, 'server', 'db.js'), {
  sql: async () => [],
  initDB: async () => {},
  neon: () => async () => []
});

stub('@vercel/blob', {
  put: async () => ({ url: 'https://example.invalid/blob' }),
  del: async () => {},
  list: async () => ({ blobs: [] })
});

process.stdout.write('server/auth.js\n');

const auth = require(path.join(projectRoot, 'server', 'auth.js'));

await test('正确密码通过常数时间比较', () => {
  assert.equal(auth.passwordMatches('test-password'), true);
});

await test('错误密码被拒绝', () => {
  assert.equal(auth.passwordMatches('wrong'), false);
  assert.equal(auth.passwordMatches(''), false);
  assert.equal(auth.passwordMatches(undefined), false);
});

await test('签发并校验 Token', () => {
  const token = auth.issueToken();
  assert.equal(typeof token, 'string');
  assert.ok(token.split('.').length === 3, 'JWT 应有三段');
  assert.equal(auth.verifyToken(token), true);
});

await test('被篡改的 Token 校验失败', () => {
  const token = auth.issueToken();
  const tampered = token.slice(0, -3) + 'aaa';
  assert.equal(auth.verifyToken(tampered), false);
  assert.equal(auth.verifyToken('not-a-token'), false);
});

await test('连续失败触发锁定', () => {
  const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;
  assert.equal(auth.isBlocked(ip), false);
  for (let i = 0; i < auth.LOGIN_MAX_ATTEMPTS; i += 1) {
    auth.registerFailedLogin(ip);
  }
  assert.equal(auth.isBlocked(ip), true, '达到上限后应锁定');
});

await test('登录成功后解除锁定', () => {
  const ip = `10.1.0.${Math.floor(Math.random() * 200) + 1}`;
  for (let i = 0; i < 3; i += 1) auth.registerFailedLogin(ip);
  auth.clearLoginAttempts(ip);
  assert.equal(auth.isBlocked(ip), false);
});

await test('JWT 密钥不来自硬编码默认值', () => {
  assert.notEqual(auth.JWT_SECRET, 'tripmap_default_secret');
  assert.equal(auth.JWT_SECRET, 'test-secret-for-unit-tests');
});

process.stdout.write('server/routes.js（富文本净化与路由装载）\n');

const router = require(path.join(projectRoot, 'server', 'routes.js'));

await test('路由模块可正常装载并导出 Router', () => {
  assert.equal(typeof router, 'function');
  assert.equal(typeof router.use, 'function');
});

await test('注册了关键写接口', () => {
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  for (const expected of [
    'POST /trips',
    'PUT /trips/:id',
    'DELETE /trips/:id',
    'POST /participants/batch',
    'POST /uploads/richtext',
    'POST /cleanup-media'
  ]) {
    assert.ok(paths.includes(expected), `缺少路由 ${expected}`);
  }
});

await test('写接口均挂载 requireAdmin 中间件', () => {
  const writeRoutes = router.stack.filter(
    (layer) => layer.route && ['post', 'put', 'delete'].includes(Object.keys(layer.route.methods)[0])
  );
  assert.ok(writeRoutes.length > 0);
  for (const layer of writeRoutes) {
    const handlers = layer.route.stack.map((s) => s.name);
    assert.ok(
      handlers.includes('requireAdmin'),
      `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path} 缺少 requireAdmin`
    );
  }
});

process.stdout.write('sanitize-html 策略\n');

await test('净化策略移除 script 与事件属性、禁用协议相对 URL', () => {
  const sanitizeHtml = require('sanitize-html');
  const allowed = {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'u', 's']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false
  };
  const out = sanitizeHtml(
    '<p>正常</p><script>alert(1)</script><img src="//evil.com/x.png"><img src="https://ok.com/a.png" onerror="alert(2)">',
    allowed
  );
  assert.ok(!out.includes('<script'), 'script 应被移除');
  assert.ok(!out.includes('onerror'), '事件属性应被移除');
  assert.ok(!out.includes('//evil.com'), '协议相对 URL 应被移除');
  assert.ok(out.includes('https://ok.com/a.png'), '合法图片应保留');
  assert.ok(out.includes('<p>正常</p>'), '合法段落应保留');
});

process.stdout.write(`\n${passed} 通过，${failed} 失败\n`);
if (failed) {
  process.stdout.write('\n失败用例:\n');
  for (const f of failures) process.stdout.write(`  ${f.name}: ${f.message}\n`);
  process.exit(1);
}
