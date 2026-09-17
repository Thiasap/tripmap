/**
 * 对象存储适配层 · 本地实现：文件系统（`<TRIPMAP_LOCAL_ROOT>/media`）。
 *
 * 契约见 server/adapters/storage.js：
 *   put / list / del / read，url 统一为 `/media/<pathname>`（由 server/app.js 静态托管）。
 *
 * 安全：所有 pathname 都必须落在 media 根内——拒绝绝对路径、盘符、上跳、反斜杠、空字节。
 */
const fs = require('fs');
const fsp = require('fs/promises');
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

const CONTENT_TYPE_BY_EXT = (name) => CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';

/** pathname → media 根内的绝对路径；越界或非法即抛错 */
function safeResolve(mediaRoot, pathname) {
  const raw = String(pathname ?? '');
  if (!raw || raw.includes('\0') || raw.includes('\\')) {
    throw new Error(`[storage] 非法路径: ${raw.slice(0, 60)}`);
  }
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`[storage] 不允许绝对路径: ${raw.slice(0, 60)}`);
  }
  const resolved = path.resolve(mediaRoot, raw);
  const rootWithSep = mediaRoot.endsWith(path.sep) ? mediaRoot : mediaRoot + path.sep;
  if (resolved !== mediaRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`[storage] 路径越界: ${raw.slice(0, 60)}`);
  }
  return resolved;
}

/** 递归列出 media 下的全部文件（返回 `pathname` 用正斜杠） */
function walk(dir, mediaRoot, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, mediaRoot, out);
    else if (entry.isFile()) out.push(path.relative(mediaRoot, full).split(path.sep).join('/'));
  }
  return out;
}

function createLocalStorage() {
  const root = process.env.TRIPMAP_LOCAL_ROOT;
  if (!root) {
    throw new Error('[storage] local 模式必须设置 TRIPMAP_LOCAL_ROOT（指向含 media/ 的目录）');
  }
  const mediaRoot = path.resolve(root, 'media');
  fs.mkdirSync(mediaRoot, { recursive: true });

  /** 归一化引用：接受 `/media/<pathname>`、<pathname> 或本实现签发的 url */
  const toPathname = (ref) => {
    const value = typeof ref === 'string' ? ref : (ref && ref.url);
    if (!value) throw new Error('[storage] 需要一个对象或 url');
    const raw = String(value);
    if (/^https?:\/\//i.test(raw)) {
      if (!raw.startsWith('/media/')) throw new Error('[storage] 本地后端不支持远程 URL');
      return raw.slice('/media/'.length);
    }
    return raw.replace(/^\/media\//, '');
  };

  return {
    mode: 'local',
    impl: 'local-fs',
    mediaRoot,

    async put(pathname, body, options = {}) {
      const target = safeResolve(mediaRoot, pathname);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, Buffer.isBuffer(body) ? body : Buffer.from(body));
      return { url: `/media/${pathname}`, pathname };
    },

    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const all = walk(mediaRoot, mediaRoot).filter((name) => name.startsWith(prefix)).sort();
      const offset = Math.max(0, Number(cursor) || 0);
      const page = all.slice(offset, offset + Math.max(1, limit));
      const blobs = page.map((pathname) => {
        const stat = fs.statSync(safeResolve(mediaRoot, pathname));
        return {
          pathname,
          url: `/media/${pathname}`,
          size: stat.size,
          uploadedAt: stat.mtime.toISOString(),
          contentType: CONTENT_TYPE_BY_EXT(pathname)
        };
      });
      const next = offset + page.length;
      return { blobs, cursor: next < all.length ? String(next) : null };
    },

    async del(refs) {
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        if (!ref) continue;
        const target = safeResolve(mediaRoot, toPathname(ref));
        try { await fsp.unlink(target); } catch (error) {
          if (error && error.code === 'ENOENT') continue; // 已不存在视为删除成功（幂等）
          throw error;
        }
      }
    },

    async read(ref) {
      const target = safeResolve(mediaRoot, toPathname(ref));
      const body = await fsp.readFile(target);
      return { body, contentType: CONTENT_TYPE_BY_EXT(target) };
    }
  };
}

module.exports = { createLocalStorage, safeResolve, CONTENT_TYPE_BY_EXT };
