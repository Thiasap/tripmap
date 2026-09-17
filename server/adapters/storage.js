/**
 * 对象存储适配层：按 `TRIPMAP_BACKEND` 选择后端，向上暴露统一契约。
 *
 * 契约（所有实现必须满足；接口刻意与 `@vercel/blob` 同形，调用点改动最小）：
 *   put(pathname, body, { contentType })      → { url, pathname }
 *   list({ prefix, limit, cursor })           → { blobs: [{ pathname, url, size, uploadedAt, contentType }], cursor }
 *   del(refs)                                 → refs 为 url 或 url[]，删除对象
 *   read(ref)                                 → { body: Buffer, contentType }；ref 为对象 { url } 或 url 字符串
 *
 * 实现：
 *   cloud（默认）→ Vercel Blob
 *   local        → 本地文件系统（<TRIPMAP_LOCAL_ROOT>/media，url 形如 /media/...）—— P3 落地
 *
 * 边界：`recycle/` 回收语义（先复制后删）留在上层业务，适配层只做对象读写。
 */
const { MODE, assertModeAllowed } = require('./mode');

/** Vercel Blob 实现（生产默认） */
function createBlobStorage() {
  const { put, del, list } = require('@vercel/blob');

  return {
    mode: 'cloud',
    impl: 'vercel-blob',

    async put(pathname, body, options = {}) {
      return put(pathname, body, { access: 'public', ...options });
    },

    async list(options = {}) {
      return list(options);
    },

    async del(refs) {
      const targets = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
      if (!targets.length) return;
      await del(targets);
    },

    async read(ref) {
      const url = typeof ref === 'string' ? ref : (ref && ref.url);
      if (!url) throw new Error('[storage] read 需要一个对象或 url');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`[storage] read 失败：HTTP ${response.status}`);
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'application/octet-stream'
      };
    }
  };
}

/** 本地文件系统实现：见 ./local/storage.js */
function createLocalStorage() {
  return require('./local/storage').createLocalStorage();
}

function createStorage() {
  assertModeAllowed('storage');
  const storage = MODE === 'local' ? createLocalStorage() : createBlobStorage();
  console.log(`[backend] storage=${storage.impl}`);
  return storage;
}

/** 懒加载单例：routes 与 app 共享同一实例（避免重复初始化与重复日志） */
let shared = null;
function storage() {
  if (!shared) shared = createStorage();
  return shared;
}

module.exports = { createStorage, storage };
