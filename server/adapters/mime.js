/**
 * 媒体类型推断（各存储适配实现共用）。
 * 仅覆盖本站允许上传的类型；未知扩展名回退为 application/octet-stream。
 */
const path = require('path');

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
};

const contentTypeOf = (name) => CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';

module.exports = { CONTENT_TYPES, contentTypeOf };
