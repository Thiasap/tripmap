/**
 * 安全响应头配置守卫（推送前门之一）。用法：node tools/check-headers.mjs
 *
 * 为什么需要它：静态页由 Vercel CDN 直出、不经函数，所以 vercel.json 里必须再写一份
 * CSP（helmet 只管 API 响应）。而 img-src 必须放行当前媒体域名——一旦换了 R2 域名却
 * 忘了同步 vercel.json，表现就是「线上图片全白」，且只在生产暴露。
 * 这个脚本把这种静默漂移变成显式失败。
 *
 * 只读取 R2_PUBLIC_BASE_URL 的 origin（公开标识符），不打印任何 Secret。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadLocalSecrets } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (name) => console.log('  ok   ' + name);
const bad = (name, detail) => { failed += 1; console.log('  FAIL ' + name + (detail ? ' —— ' + detail : '')); };

const vercelJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vercel.json'), 'utf8'));
const headerList = (vercelJson.headers || []).flatMap((entry) => entry.headers || []);
const find = (key) => headerList.find((h) => String(h.key).toLowerCase() === key.toLowerCase())?.value || '';
const csp = find('content-security-policy');

console.log('① 必备加固头（静态页与 API 响应都覆盖）');
const REQUIRED = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Strict-Transport-Security', 'max-age='],
  ['Referrer-Policy', ''],
  ['X-Frame-Options', ''],
  ['Permissions-Policy', ''],
  ['Content-Security-Policy', "script-src 'self'"]
];
for (const [key, mustContain] of REQUIRED) {
  const value = find(key);
  if (!value) bad(key + ' 缺失');
  else if (mustContain && !value.includes(mustContain)) bad(key + ' 内容不符', '应包含 ' + mustContain);
  else ok(key);
}

console.log('② CSP img-src 必须覆盖当前媒体域名（与 server/csp.js 同源）');
const secrets = loadLocalSecrets(projectRoot);
const base = String(process.env.R2_PUBLIC_BASE_URL || secrets.R2_PUBLIC_BASE_URL || '').trim();
if (!base) {
  console.log('  跳过 —— 未找到 R2_PUBLIC_BASE_URL（无 .agent/SECRETS.env 且未设环境变量）');
} else {
  process.env.R2_PUBLIC_BASE_URL = base;
  const cspPath = path.join(projectRoot, 'server', 'csp.js');
  delete require.cache[cspPath];
  const { mediaImgSrc } = require(cspPath);
  const declared = (/(?:^|;)\s*img-src([^;]*)/.exec(csp)?.[1] || '').trim().split(/\s+/).filter(Boolean);
  const expected = mediaImgSrc();
  const missing = expected.filter((source) => !declared.includes(source));
  if (missing.length) {
    bad('vercel.json 的 img-src 缺少来源', missing.join(' '));
    console.log('       → 媒体域名变了但 vercel.json 没同步，线上会表现为图片全部被 CSP 拦截');
  } else {
    ok('img-src 覆盖 ' + expected.length + ' 个来源（含 ' + new URL(base).origin + '）');
  }
}

console.log('\n' + (failed ? '结论：安全响应头配置有问题 ❌（' + failed + ' 项）' : '结论：安全响应头配置完整 ✅'));
process.exit(failed ? 1 : 0);
