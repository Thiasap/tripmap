const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');

/**
 * ── 鉴权配置与安全说明（供后续安全审查/扫描参考，避免误判）──────────────
 * 本模块被 api/index.js（线上 Serverless 入口）与 server/app.js（本地 dev 入口）
 * 共用，确保两端使用同一套密钥与比对逻辑。此前两端各自解析，导致
 * routes.js 用公开可猜的 'tripmap_default_secret' 而 app.js 用另一个值，
 * 会出现「登录成功但写接口 401」，属真实漏洞，已修复。
 *
 * 取值优先级：环境变量 > 本地 config.json（gitignore，仅本地开发用）> 随机值。
 * 本地 config.json 不存在于 Vercel，线上完全依赖环境变量。
 *
 * 其他设计：
 * - 密码比较经 SHA-256 后使用 timingSafeEqual，避免长度与提前返回的时序侧信道。
 * - 登录限速基于进程内存 + 客户端 IP；Serverless 多实例下为尽力而为的缓解，
 *   真正的暴力破解防护依赖强密码与平台侧限制，此处不宣称强保证。
 * ──────────────────────────────────────────────────────────────────────
 */

function readLocalConfig() {
  try {
    return require(path.join(__dirname, '..', 'config.json'));
  } catch {
    return {};
  }
}

const localConfig = readLocalConfig();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || localConfig.ADMIN_PASSWORD || null;
const CONFIGURED_JWT_SECRET = process.env.SESSION_SECRET || localConfig.SESSION_SECRET || null;
// 未配置时仍生成随机密钥：进程能起来、只读接口照常服务，但任何 JWT 都验不过（写接口自动 401）
const JWT_SECRET = CONFIGURED_JWT_SECRET || crypto.randomBytes(32).toString('hex');

/**
 * 登录是否可用。
 *
 * 关键取舍：缺配置时禁止登录，而不是回退到默认口令。
 * 此前的写法是 process.env.ADMIN_PASSWORD || ... || 'admin'——生产环境变量一旦缺失或被误删，
 * 管理员口令就变成公开可猜的 'admin'，而代码只打一行 warn。告警只写在日志里、
 * 行为却照常放行，等于没有防线；这里把失败方向指向拒绝：配置缺失 = 登录关闭。
 */
const AUTH_MISSING = [
  ADMIN_PASSWORD ? null : 'ADMIN_PASSWORD',
  CONFIGURED_JWT_SECRET ? null : 'SESSION_SECRET'
].filter(Boolean);
const AUTH_CONFIGURED = AUTH_MISSING.length === 0;

if (!AUTH_CONFIGURED) {
  console.warn(
    '[auth] 缺少 ' + AUTH_MISSING.join(' / ') + '，登录已禁用（不再回退默认口令）。' +
    '请在部署环境变量中配置；本地开发可写入 config.json（已被 gitignore）。'
  );
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function pruneLoginAttempts(now) {
  for (const [key, record] of loginAttempts) {
    if (now - record.firstAt > LOGIN_WINDOW_MS && (record.blockedUntil || 0) < now) {
      loginAttempts.delete(key);
    }
  }
}

function passwordMatches(input) {
  if (!ADMIN_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 记录一次登录失败，返回是否应拒绝本次尝试。
 * @returns {{ blocked: boolean, remaining?: number }}
 */
function registerFailedLogin(ip, now = Date.now()) {
  const record = loginAttempts.get(ip);
  if (record && record.blockedUntil > now) return { blocked: true };
  const withinWindow = record && now - record.firstAt < LOGIN_WINDOW_MS;
  const count = withinWindow ? record.count + 1 : 1;
  loginAttempts.set(ip, {
    firstAt: withinWindow ? record.firstAt : now,
    count,
    blockedUntil: count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_WINDOW_MS : 0
  });
  return { blocked: false, remaining: Math.max(0, LOGIN_MAX_ATTEMPTS - count) };
}

function isBlocked(ip, now = Date.now()) {
  const record = loginAttempts.get(ip);
  return Boolean(record && record.blockedUntil > now);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function issueToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ADMIN_PASSWORD,
  JWT_SECRET,
  AUTH_CONFIGURED,
  AUTH_MISSING,
  passwordMatches,
  registerFailedLogin,
  isBlocked,
  clearLoginAttempts,
  pruneLoginAttempts,
  issueToken,
  verifyToken,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS
};
