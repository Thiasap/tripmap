const express = require('express');
const path = require('path');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { initDB } = require('../server/db');
const routes = require('../server/routes');

const app = express();
const rootDir = path.join(__dirname, '..');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const JWT_SECRET = process.env.SESSION_SECRET || `tripmap_${Math.random().toString(36).slice(2)}`;

app.use(helmet({
  contentSecurityPolicy: false,
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

// Login (JWT-based, replaces express-session)
app.post('/api/login', (req, res) => {
  if (String(req.body.password || '') !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: '密码错误' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  });
  res.json({ role: 'admin' });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  res.json({ role: 'guest' });
});

// Auth status check
app.get('/api/auth/status', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.json({ role: 'guest' });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ role: 'admin' });
  } catch {
    res.json({ role: 'guest' });
  }
});

app.use('/api', routes);

// Static files: vendor libraries
app.use('/vendor', express.static(path.join(rootDir, 'public', 'vendor'), { maxAge: '7d' }));

// Static files: public assets (must be after /api and /vendor)
app.use(express.static(path.join(rootDir, 'public'), { maxAge: '1h' }));

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? '服务器内部错误' : (err.message || 'Server error');
  res.status(status).json({ error: message });
});

// Initialize DB on cold start
initDB().catch(err => console.error('DB init error:', err));

module.exports = app;
