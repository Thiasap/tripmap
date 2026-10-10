/**
 * 媒体域 CORS 检查（导出 PNG 封面空白问题的验证门）。
 * 用法：node tools/check-media-cors.mjs [--url <图片URL>] [--origin <站点Origin>]
 *
 * 为什么需要它：导出功能用 html2canvas + useCORS:true，对跨域封面会设置
 * img.crossOrigin='anonymous'。浏览器此时**要求媒体域返回 Access-Control-Allow-Origin**，
 * 缺失则该图 onerror → html2canvas 跳过 → 导出图里封面空白。
 *
 * Vercel Blob 的公开域默认返回 ACAO: *（所以迁移前正常）；Cloudflare R2 的自定义域
 * 默认不发 CORS 头（所以迁移后空白）。本脚本把这件事变成一条可复跑的命令。
 *
 * 网络：*.vercel.app 与 R2 域需要代理；本机可用
 *   HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalSecrets } from './lib/common.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const secrets = loadLocalSecrets(projectRoot);
const siteBase = String(argOf('--site', process.env.TRIPMAP_BASE_URL || secrets.VERCEL_PRODUCTION_URL || 'https://tripmap.thiasap.cn')).replace(/\/+$/, '');
const origin = String(argOf('--origin', siteBase)).replace(/\/+$/, '');
let imageUrl = argOf('--url', '');

if (!imageUrl) {
  const res = await fetch(siteBase + '/api/trips', { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('无法读取 ' + siteBase + '/api/trips（HTTP ' + res.status + '）');
  const trips = await res.json();
  imageUrl = (trips.find((t) => t && t.cover_path) || {}).cover_path || '';
  if (!imageUrl) throw new Error('没有找到带封面的旅行，请用 --url 指定一个图片地址');
}

console.log('站点 Origin : ' + origin);
console.log('取样图片    : ' + imageUrl);
console.log('媒体域      : ' + new URL(imageUrl).host);
console.log('');

let failed = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m, d) => { failed += 1; console.log('  FAIL ' + m + (d ? ' —— ' + d : '')); };

const res = await fetch(imageUrl, { headers: { Origin: origin }, signal: AbortSignal.timeout(30000) });
const acao = res.headers.get('access-control-allow-origin');
const acac = res.headers.get('access-control-allow-credentials');
const vary = res.headers.get('vary');

console.log('HTTP ' + res.status + '  content-type=' + (res.headers.get('content-type') || '-'));
if (!res.ok) bad('图片不可达', 'HTTP ' + res.status);
else if (!acao) {
  bad('媒体域未返回 Access-Control-Allow-Origin');
  console.log('       → 导出 PNG 时 html2canvas 无法把跨域封面画进 canvas，封面会空白');
  console.log('       → 修复：在媒体域上为该 Origin 补 CORS 响应头（见 .agent/ARCHITECTURE.md 踩坑 #30）');
} else {
  const allowed = acao === '*' || acao.split(',').map((s) => s.trim()).includes(origin);
  if (allowed) ok('Access-Control-Allow-Origin = ' + acao);
  else {
    bad('Access-Control-Allow-Origin 不包含本站 Origin', acao);
    // 最常见的手配错误：值末尾多写了一个 "/"。浏览器发送的 Origin 永远不带路径与斜杠，
    // 而 CORS 是精确字符串比较，多一个字符即判定不匹配（页面看起来"配了但没生效"）。
    if (acao.replace(/\/+$/, '') === origin) {
      console.log('       → 值末尾多了一个 "/"：CORS 是精确字符串比较，浏览器发送的 Origin 从不带斜杠');
      console.log('       → 修复：把该响应头的值改成 ' + origin + '（去掉结尾的 /）');
    }
  }
  if (acao === '*' && acac === 'true') bad('ACAO 为通配符却带 allow-credentials=true（浏览器会拒绝）');
}
if (vary) console.log('  info Vary: ' + vary);

console.log('');
console.log(failed ? '结论：媒体域 CORS 不满足导出需求 ❌' : '结论：媒体域 CORS 满足导出需求 ✅');
process.exit(failed ? 1 : 0);
