const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
require('./db');

const routes = require('./routes');

const app = express();
const port = 3002;
const rootDir = path.join(__dirname, '..');

// 安全响应头
app.use(helmet({
  contentSecurityPolicy: false, // 地图/富文本用 inline 资源较多，暂不启用 CSP
  crossOriginEmbedderPolicy: false
}));

// 从本地配置文件读取（环境变量可覆盖）
const configPath = path.join(rootDir, 'config.json');
let config = {};
try { config = require(configPath); } catch { /* 使用默认值 */ }
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || config.ADMIN_PASSWORD || 'admin';
const sessionSecret = process.env.SESSION_SECRET || config.SESSION_SECRET || `tripmap_${Math.random().toString(36).slice(2)}`;

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 小时
  }
}));

app.use(express.json({ limit: '20mb' }));
app.use('/media', express.static(path.join(rootDir, 'media')));
app.use('/vendor/d3', express.static(path.join(rootDir, 'node_modules', 'd3', 'dist')));
app.use('/vendor/quill', express.static(path.join(rootDir, 'node_modules', 'quill', 'dist')));
app.use('/vendor/glightbox', express.static(path.join(rootDir, 'node_modules', 'glightbox', 'dist')));
app.use(express.static(path.join(rootDir, 'public')));
app.use('/api', routes);

// 鉴权中间件
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: '需要管理员登录' });
}

// 登录
app.post('/api/login', (req, res) => {
  if (String(req.body.password || '') === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ role: 'admin' });
  }
  return res.status(403).json({ error: '密码错误' });
});

// 登出
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ role: 'guest' });
  });
});

// 获取当前角色
app.get('/api/auth/status', (req, res) => {
  res.json({ role: req.session && req.session.isAdmin ? 'admin' : 'guest' });
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? '服务器内部错误' : (err.message || 'Server error');
  res.status(status).json({ error: message });
});

// 导出 requireAdmin 给 routes 使用
app.locals.requireAdmin = requireAdmin;

app.listen(port, () => {
  console.log(`旅行地图已启动：http://localhost:${port}`);
});
