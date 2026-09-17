/**
 * CSP 媒体来源（img-src）统一构建入口。
 *
 * 为什么独立成文件：此前的 CSP 在 `server/app.js`（本地/自托管入口）与
 * `api/index.js`（Vercel 入口）里各写了一份，两处一旦漂移就会出现
 * 「本地能看图、线上白图」这类只在生产暴露的问题。
 *
 * 为什么需要放行外部域名：媒体对象不经应用转发，而是由外部存储直接提供给浏览器
 * （Vercel Blob 或 S3 兼容的 Cloudflare R2），CSP 的 `img-src` 必须包含其域名。
 * **Blob 域名始终保留**——迁移期间与回滚路径都还需要它，且这是一个厂商专属域名，
 * 放行成本可忽略；R2 域名按 `R2_PUBLIC_BASE_URL` 动态追加。
 */

/** Vercel Blob 的公开读域名（Blob 为每账号分配独立子域） */
const BLOB_ORIGIN = 'https://*.public.blob.vercel-storage.com';

/**
 * 媒体存储的公开域名列表（去重，非法配置忽略而不是让整个策略失效）。
 * @returns {string[]}
 */
function mediaOrigins() {
  const origins = [BLOB_ORIGIN];
  const base = String(process.env.R2_PUBLIC_BASE_URL || '').trim();
  if (!base) return origins;
  try {
    const origin = new URL(base).origin;
    if (!origins.includes(origin)) origins.push(origin);
  } catch {
    // 配置写错时只忽略该来源，不影响其余策略
  }
  return origins;
}

/** img-src 指令的可信来源 */
function mediaImgSrc() {
  return ["'self'", 'data:', 'blob:', ...mediaOrigins()];
}

module.exports = { mediaImgSrc, mediaOrigins, BLOB_ORIGIN };
