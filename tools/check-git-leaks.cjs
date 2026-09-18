/**
 * Git 泄露检查（推送前安全门）。用法：node tools/check-git-leaks.cjs
 *
 * 四道防线：
 *   ① 当前跟踪文件中的敏感路径
 *   ② 历史提交中出现过的敏感文件名
 *   ③ 全部 git 对象内容扫描（把 SECRETS.env / config.json 的真实值当 needle，含 unreachable 对象）
 *   ④ ignore 规则验证
 *
 * 只输出命中/未命中，绝不输出任何密钥内容。发现任何一类问题都以非零码退出。
 * 注：bucket 名 / 项目 ID / 公开域名等「公开标识符」不算泄露，已在 PUBLIC_KEYS 中排除。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: projectRoot, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });

const SENSITIVE_PATH_RE = /(^|\/)(\.agent|backups|media|media_recycle)(\/|$)|^config\.json$|\.env$|\.env\.|vercel-prod\.env|\.sqlite(-wal|-shm)?$|\.vercel\/|SECRETS/i;

// 公开标识符：出现在 URL/文档里也无所谓，不作为泄露 needle
const PUBLIC_KEYS = new Set([
  'TRIPMAP_STORAGE', 'VERCEL_SCOPE', 'VERCEL_PROJECT', 'VERCEL_PROJECT_ID', 'VERCEL_PRODUCTION_URL',
  'NEON_RESOURCE_NAME', 'NEON_RESOURCE_ID', 'BLOB_STORE_NAME', 'BLOB_STORE_ID',
  'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL',
  'PGHOST', 'PGHOST_UNPOOLED', 'PGDATABASE', 'POSTGRES_DATABASE', 'POSTGRES_HOST'
]);
const isSensitiveKey = (name) => {
  if (/PASSWORD|SECRET|TOKEN|KEY/i.test(name)) return true;
  if (/DATABASE_URL|POSTGRES_URL/i.test(name)) return true;
  return !PUBLIC_KEYS.has(name);
};

let leaked = 0;

console.log('① 当前跟踪文件中的敏感路径');
const tracked = git(['ls-files']).toString().split('\n').filter(Boolean);
const trackedHits = tracked.filter((f) => SENSITIVE_PATH_RE.test(f));
if (trackedHits.length) { leaked++; trackedHits.forEach((f) => console.log('  !! 泄露:', f)); }
else console.log(`  无 ✅（共跟踪 ${tracked.length} 个文件）`);

console.log('② 历史提交中出现过的敏感文件名');
const nameSet = new Set(git(['log', '--all', '--name-only', '--pretty=format:']).toString().split('\n').map((s) => s.trim()).filter(Boolean));
const historyHits = [...nameSet].filter((f) => SENSITIVE_PATH_RE.test(f));
if (historyHits.length) { leaked++; historyHits.forEach((f) => console.log('  !! 历史中出现过:', f)); }
else console.log(`  无 ✅（历史共 ${nameSet.size} 个不同路径）`);

console.log('③ 全部 git 对象内容扫描（以 SECRETS.env / config.json 的真实值为 needle）');
const needles = [];
const pushSecret = (name, value) => {
  const v = String(value || '').trim().replace(/^["']|["']$/g, '').trim();
  if (v && v.length >= 8 && !v.includes('__MISSING') && isSensitiveKey(name)) needles.push({ name, value: v });
};
for (const line of fs.readFileSync(path.join(projectRoot, '.agent', 'SECRETS.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) pushSecret(m[1], m[2]);
}
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'));
  for (const [k, v] of Object.entries(cfg)) pushSecret('config.' + k, v);
} catch { /* 本地 config 不存在则跳过 */ }
console.log(`  参与扫描的 needle 数: ${needles.length}（真实敏感值；公开标识符已排除）`);

const batch = git(['cat-file', '--batch-all-objects', '--batch']);
const needleBufs = needles.map((n) => ({ ...n, buf: Buffer.from(n.value) }));
const hitNames = new Set();
const WINDOW = 1024 * 1024;
for (let i = 0; i < batch.length; i += WINDOW) {
  const chunk = batch.subarray(i, Math.min(batch.length, i + WINDOW + 65536));
  for (const n of needleBufs) if (chunk.includes(n.buf)) hitNames.add(n.name);
}
if (hitNames.size) {
  leaked++;
  for (const name of hitNames) console.log(`  !! 泄露: ${name} 出现在 git 对象中（含历史）`);
} else console.log(`  无 ✅（扫描 ${(batch.length / 1024 / 1024).toFixed(1)} MB git 对象，所有真实敏感值均未出现）`);

console.log('④ ignore 规则验证');
for (const t of ['.agent/SECRETS.env', 'config.json', 'media/', 'backups/', 'tripmap.sqlite', '.env']) {
  try { git(['check-ignore', '-q', t]); console.log('  已忽略 ✅ ' + t); }
  catch { leaked++; console.log('  !! 未被忽略: ' + t); }
}

console.log('');
console.log(leaked === 0 ? '结论：未发现任何泄露，可以安全推送 ✅' : `结论：发现 ${leaked} 类问题，禁止推送，先处理上方 !! 项`);
process.exit(leaked === 0 ? 0 : 1);
