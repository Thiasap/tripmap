const express = require('express');
const path = require('path');
const helmet = require('helmet');
const { initDB } = require('./db');
const routes = require('./routes');
const {
  passwordMatches,
  registerFailedLogin,
  isBlocked,
  clearLoginAttempts,
  issueToken,
  verifyToken
} = require('./auth');

const app = express();
const port = process.env.PORT || 3002;
const rootDir = path.join(__dirname, '..');

// 本地 dev 全链路走 HTTP，Secure Cookie 会被浏览器丢弃，因此固定 false；
// 线上 api/index.js 按 NODE_ENV=production 自动开启 secure。
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'upgrade-insecure-requests': null,
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.public.blob.vercel-storage.com'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie || '';
  req.cookies = {};
  cookieHeader.split(';').forEach(c => {
    const [name, ...rest] = c.split('=');
    const key = name.trim();
    if (key) req.cookies[key] = rest.join('=').trim();
  });
  next();
});

app.use(express.json({ limit: '20mb' }));

// Vendor static files
app.use('/vendor/d3', express.static(path.join(rootDir, 'node_modules', 'd3', 'dist')));
app.use('/vendor/quill', express.static(path.join(rootDir, 'node_modules', 'quill', 'dist')));
app.use('/vendor/glightbox', express.static(path.join(rootDir, 'node_modules', 'glightbox', 'dist')));
app.use('/vendor/html2canvas', express.static(path.join(rootDir, 'node_modules', 'html2canvas', 'dist')));

// Login（带登录限速与常数时间比较）
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (isBlocked(ip)) {
    return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  }
  if (!passwordMatches(req.body.password)) {
    registerFailedLogin(ip);
    return res.status(403).json({ error: '密码错误' });
  }
  clearLoginAttempts(ip);
  res.cookie('token', issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  });
  res.json({ role: 'admin' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: false });
  res.json({ role: 'guest' });
});

app.get('/api/auth/status', (req, res) => {
  const token = req.cookies?.token;
  if (!token || !verifyToken(token)) return res.json({ role: 'guest' });
  res.json({ role: 'admin' });
});

app.use('/api', routes);

// 本地后端（TRIPMAP_BACKEND=local）：媒体由本地文件系统托管，url 形如 /media/...
// 云端后端媒体是 Blob 绝对 URL，不需要此路由
const storageAdapter = require('./adapters/storage').storage();
if (storageAdapter.mode === 'local' && storageAdapter.mediaRoot) {
  app.use('/media', express.static(storageAdapter.mediaRoot));
}

app.use(express.static(path.join(rootDir, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  // Multer 错误映射为明确的客户端错误，避免用户只看到 500
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件大小超出限制（最大 200MB）' });
  if (err.code === 'LIMIT_FIELD_SIZE') return res.status(413).json({ error: '字段内容过长（最大 100KB）' });
  if (err.name === 'MulterError') return res.status(400).json({ error: `上传失败: ${err.message}` });
  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? '服务器内部错误' : (err.message || 'Server error');
  res.status(status).json({ error: message });
});

initDB().then(() => {
  app.listen(port, () => {
    console.log(`旅行地图已启动：http://localhost:${port}`);
  });
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});
