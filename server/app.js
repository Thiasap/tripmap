const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const helmet = require('helmet');
require('./db');

const routes = require('./routes');

const app = express();
const port = 3002;
const host = process.env.HOST || '127.0.0.1'; // 默认仅本机可访问；公网部署设 HOST=0.0.0.0（推荐仍保持 127.0.0.1 由本机反代转发）
const rootDir = path.join(__dirname, '..');

/**
 * ── 安全设计说明（供后续安全审查/扫描参考，避免误判）──────────────────────
 * 本应用定位「本地单人使用」，以下均为有意设计，非疏漏：
 *
 * 1. 默认监听 127.0.0.1：局域网/公网不可直接访问，外部访问须经本机反向代理。
 * 2. 默认密码 "admin"：仅首次本地启动的引导值，正式使用必须通过 config.json
 *    或环境变量 ADMIN_PASSWORD 修改（公网部署前必改）。
 * 3. Cookie secure 默认 false：本地为 HTTP，Secure Cookie 会被浏览器丢弃；
 *    公网 HTTPS 部署时设置环境变量 COOKIE_SECURE=true 即可开启。
 * 4. Session 使用 MemoryStore：单用户会话数极少，无内存/持久化需求；
 *    公网多会话场景建议换持久化 store（如 connect-sqlite3）。
 * 5. CSP 允许 style-src 'unsafe-inline'：Quill 编辑器、GLightbox、卡片动态
 *    样式依赖内联样式，无法避免；script-src 严格限定 'self'，全站无内联脚本。
 * 6. 登录限速基于进程内存 + req.ip：单进程场景足够；置于反向代理之后时需
 *    设置 TRUST_PROXY（见下），否则所有请求同源 IP 会互相触发限速。
 *
 * ── 公网部署检查清单 ─────────────────────────────────────────────────────
 * 1. 修改 ADMIN_PASSWORD（config.json 或环境变量，禁止保留默认值）
 * 2. 设置 SESSION_SECRET 环境变量（固定随机长串，否则重启后全部登录态失效）
 * 3. 前置 HTTPS 反向代理（Nginx/Caddy），并设置 COOKIE_SECURE=true
 * 4. 监听地址：HOST=0.0.0.0（或推荐保持默认 127.0.0.1，仅反代转发）
 * 5. 反代之后设置 TRUST_PROXY=1，登录限速按真实客户端 IP 计数
 * 6. 备份 tripmap.sqlite* 与 media/；media_recycle/ 为删除缓冲区可定期清理
 * ────────────────────────────────────────────────────────────────────────
 */

// 反向代理之后部署时设置 TRUST_PROXY=1（或实际代理跳数），req.ip 才是真实客户端 IP
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// 安全响应头。CSP 允许 inline 样式（Quill/GLightbox/卡片动态样式需要），
// 但禁止外部脚本与远程资源，弥补 sanitize-html 之外的 XSS 防线
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // 本地为 HTTP 服务，禁用 helmet 默认的 HTTPS 自动升级
      'upgrade-insecure-requests': null,
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// 从本地配置文件读取（环境变量可覆盖）
const configPath = path.join(rootDir, 'config.json');
let config = {};
try { config = require(configPath); } catch { /* 使用默认值 */ }
// 默认密码仅用于首次本地启动引导，公网部署前必须修改（见文件头部部署清单）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || config.ADMIN_PASSWORD || 'admin';
const sessionSecret = process.env.SESSION_SECRET || config.SESSION_SECRET || `tripmap_${crypto.randomBytes(16).toString('hex')}`;

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // 本地 HTTP 下必须为 false（Secure Cookie 会被浏览器拒绝）；
    // 公网 HTTPS 部署时设置环境变量 COOKIE_SECURE=true
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 24 * 60 * 60 * 1000 // 24 小时
  }
}));

app.use(express.json({ limit: '20mb' }));
app.use('/media', express.static(path.join(rootDir, 'media')));
app.use('/vendor/d3', express.static(path.join(rootDir, 'node_modules', 'd3', 'dist')));
app.use('/vendor/quill', express.static(path.join(rootDir, 'node_modules', 'quill', 'dist')));
app.use('/vendor/glightbox', express.static(path.join(rootDir, 'node_modules', 'glightbox', 'dist')));
app.use('/vendor/html2canvas', express.static(path.join(rootDir, 'node_modules', 'html2canvas', 'dist')));
app.use(express.static(path.join(rootDir, 'public')));
app.use('/api', routes);

// 登录限速：同一来源 15 分钟窗口内最多失败 10 次，超出后锁定。
// 记录存于进程内存（单实例部署足够）；公网场景下为防伪造 IP 撑爆内存，超过上限时清理过期记录
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_TRACKER_CAP = 10000;
const loginAttempts = new Map();

function pruneLoginAttempts(now) {
  for (const [key, record] of loginAttempts) {
    if (now - record.firstAt > LOGIN_WINDOW_MS && (record.blockedUntil || 0) < now) loginAttempts.delete(key);
  }
}

// 哈希后常数时间比较，避免长度/时序侧信道
function passwordMatches(input, expected) {
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// 登录（重新生成 session ID 防止 session fixation）
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.blockedUntil > now) {
    return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  }
  if (!passwordMatches(req.body.password, ADMIN_PASSWORD)) {
    if (loginAttempts.size >= LOGIN_TRACKER_CAP) pruneLoginAttempts(now);
    const withinWindow = record && now - record.firstAt < LOGIN_WINDOW_MS;
    const count = withinWindow ? record.count + 1 : 1;
    loginAttempts.set(ip, {
      firstAt: withinWindow ? record.firstAt : now,
      count,
      blockedUntil: count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_WINDOW_MS : 0
    });
    return res.status(403).json({ error: '密码错误' });
  }
  loginAttempts.delete(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '登录失败' });
    req.session.isAdmin = true;
    res.json({ role: 'admin' });
  });
});

// 登出（服务端销毁 session + 客户端清 cookie）
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid', { httpOnly: true, sameSite: 'lax', secure: false });
    res.json({ role: 'guest' });
  });
});

// 获取当前角色
app.get('/api/auth/status', (req, res) => {
  res.json({ role: req.session && req.session.isAdmin ? 'admin' : 'guest' });
});

// 统一错误处理：客户端错误返回真实原因，服务端错误不泄露内部细节
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件大小超出限制（最大 200MB）' });
  if (err.code === 'LIMIT_FIELD_SIZE') return res.status(413).json({ error: '字段内容过长（最大 100KB）' });
  if (err.name === 'MulterError') return res.status(400).json({ error: `上传失败: ${err.message}` });
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  // 系统错误（如 ENOENT/EACCES）一律返回通用消息，避免泄露路径等信息
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(port, host, () => {
  console.log(`旅行地图已启动：http://${host}:${port}`);
});
