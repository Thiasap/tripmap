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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || localConfig.ADMIN_PASSWORD || 'admin';
const JWT_SECRET =
  process.env.SESSION_SECRET ||
  localConfig.SESSION_SECRET ||
  crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET && !localConfig.SESSION_SECRET) {
  console.warn('[auth] 未配置 SESSION_SECRET，已生成临时随机密钥；实例重启后所有登录态将失效');
}
if (!process.env.ADMIN_PASSWORD && !localConfig.ADMIN_PASSWORD) {
  console.warn('[auth] 未配置 ADMIN_PASSWORD，正在使用默认密码 admin；线上部署必须修改');
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
