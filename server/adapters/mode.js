/**
 * 后端模式选择与护栏（数据库/存储两个适配层共用）。
 *
 * MODE 在模块加载时读取一次；校验失败即抛错——**宁可起不来，也不写错库/写错盘**。
 */
const MODE = String(process.env.TRIPMAP_BACKEND || 'cloud').toLowerCase();
const SUPPORTED_MODES = ['cloud', 'local'];

function assertModeAllowed(scope = 'backend') {
  if (!SUPPORTED_MODES.includes(MODE)) {
    throw new Error(`[${scope}] 未知的 TRIPMAP_BACKEND: ${MODE}（可选 ${SUPPORTED_MODES.join(' / ')}）`);
  }
  if (MODE === 'local' && process.env.VERCEL_ENV === 'production') {
    throw new Error(`[${scope}] 生产环境（VERCEL_ENV=production）禁止使用 local 后端`);
  }
}

module.exports = { MODE, SUPPORTED_MODES, assertModeAllowed };
