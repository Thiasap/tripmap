const express = require('express');
const path = require('path');
require('./db');

const routes = require('./routes');

const app = express();
const port = 3002;
const rootDir = path.join(__dirname, '..');

app.use(express.json({ limit: '20mb' }));
app.use('/media', express.static(path.join(rootDir, 'media')));
app.use('/vendor/d3', express.static(path.join(rootDir, 'node_modules', 'd3', 'dist')));
app.use('/vendor/quill', express.static(path.join(rootDir, 'node_modules', 'quill', 'dist')));
app.use('/vendor/glightbox', express.static(path.join(rootDir, 'node_modules', 'glightbox', 'dist')));
app.use(express.static(path.join(rootDir, 'public')));
app.use('/api', routes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(port, () => {
  console.log(`旅行地图已启动：http://localhost:${port}`);
});
