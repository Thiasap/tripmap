/**
 * 后端模式选择与护栏（数据库 / 存储两个独立轴）。
 *
 * - `TRIPMAP_BACKEND`: `cloud` | `local`          —— 数据库（Neon / SQLite）
 * - `TRIPMAP_STORAGE`: `blob` | `s3` | `fs`       —— 媒体存储（Vercel Blob / S3 兼容（R2）/ 本地文件系统）
 *   默认：`backend=local` → `fs`，否则 `blob`（保持现状，不会因漏配而误切）
 *
 * 校验失败即抛错 —— **宁可起不来，也不写错库 / 写错盘**。
 */
const MODE = String(process.env.TRIPMAP_BACKEND || 'cloud').toLowerCase();
const STORAGE_MODE = String(
  process.env.TRIPMAP_STORAGE || (MODE === 'local' ? 'fs' : 'blob')
).toLowerCase();

const SUPPORTED_MODES = ['cloud', 'local'];
const SUPPORTED_STORAGE = ['blob', 's3', 'fs'];

function assertModeAllowed(scope = 'backend') {
  if (!SUPPORTED_MODES.includes(MODE)) {
    throw new Error(`[${scope}] 未知的 TRIPMAP_BACKEND: ${MODE}（可选 ${SUPPORTED_MODES.join(' / ')}）`);
  }
  if (MODE === 'local' && process.env.VERCEL_ENV === 'production') {
    throw new Error(`[${scope}] 生产环境（VERCEL_ENV=production）禁止使用 local 后端`);
  }
}

function assertStorageAllowed(scope = 'storage') {
  if (!SUPPORTED_STORAGE.includes(STORAGE_MODE)) {
    throw new Error(`[${scope}] 未知的 TRIPMAP_STORAGE: ${STORAGE_MODE}（可选 ${SUPPORTED_STORAGE.join(' / ')}）`);
  }
  if (STORAGE_MODE === 'fs' && process.env.VERCEL_ENV === 'production') {
    throw new Error(`[${scope}] 生产环境（VERCEL_ENV=production）禁止使用本地文件系统存储`);
  }
}

module.exports = { MODE, STORAGE_MODE, SUPPORTED_MODES, SUPPORTED_STORAGE, assertModeAllowed, assertStorageAllowed };
