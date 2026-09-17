/**
 * 对象存储适配层 · S3 兼容实现（Cloudflare R2）。
 *
 * 契约见 server/adapters/storage.js：`put` / `list` / `del` / `read`。
 * 签名用 `aws4fetch`（~20 KB，CJS 入口可用，不会踩 Vercel 运行时不支持 require(esm) 的坑）。
 *
 * 需要的环境变量：`R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_PUBLIC_BASE_URL`
 * （可选 `R2_ENDPOINT`，默认 `https://<account-id>.r2.cloudflarestorage.com`）
 */
const { AwsClient } = require('aws4fetch');
const { contentTypeOf } = require('../mime');

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`[storage] s3 模式缺少环境变量 ${name}`);
  return value;
}

/** 对象键的 URI 编码：逐段编码，保留 '/' */
const encodeKey = (pathname) => String(pathname).split('/').map(encodeURIComponent).join('/');

/** 拒绝绝对路径、反斜杠与空字节（与本地文件实现保持一致的边界） */
function assertKey(pathname) {
  const raw = String(pathname ?? '');
  if (!raw || raw.includes('\0') || raw.includes('\\')) {
    throw new Error(`[storage] 非法路径: ${raw.slice(0, 60)}`);
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`[storage] 不允许绝对路径: ${raw.slice(0, 60)}`);
  }
  return raw;
}

/** 还原 XML 文本实体（对象键里可能出现 & < > 等） */
const decodeXml = (text) => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * 解析 ListObjectsV2 响应（S3 返回结构稳定，用轻量正则，避免为一个 XML 再引依赖）。
 * 需要 XML 命名空间无关的字段：Key / Size / LastModified / IsTruncated / NextContinuationToken。
 */
function parseListXml(xml) {
  const blobs = [];
  for (const block of String(xml).match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    if (!key) continue;
    const size = /<Size>(\d+)<\/Size>/.exec(block);
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
    blobs.push({
      pathname: decodeXml(key[1]),
      size: size ? Number(size[1]) : 0,
      uploadedAt: modified ? modified[1] : null
    });
  }
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return { blobs, cursor: truncated && token ? decodeXml(token[1]) : null };
}

function createS3Storage() {
  const accountId = requireEnv('R2_ACCOUNT_ID');
  const bucket = requireEnv('R2_BUCKET');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const publicBase = requireEnv('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
  const endpoint = (process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');

  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const objectUrl = (key) => `${endpoint}/${bucket}/${encodeKey(key)}`;

  /** 归一化引用：接受 pathname、本实现签发的公开 url、或 S3 端点 url */
  const toKey = (ref) => {
    const value = typeof ref === 'string' ? ref : (ref && (ref.pathname || ref.url));
    if (!value) throw new Error('[storage] 需要一个对象、pathname 或 url');
    let raw = String(value);
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      let pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      if (pathname.startsWith(`${bucket}/`)) pathname = pathname.slice(bucket.length + 1);
      raw = pathname;
    }
    return assertKey(raw);
  };

  const fail = async (action, response) => {
    const detail = await response.text().catch(() => '');
    throw new Error(`[storage] ${action} 失败：HTTP ${response.status} ${detail.slice(0, 120)}`);
  };

  return {
    mode: 'cloud',
    impl: 'r2-s3',
    bucket,
    publicBase,

    async put(pathname, body, options = {}) {
      const key = assertKey(pathname);
      const headers = options.contentType ? { 'content-type': options.contentType } : {};
      const response = await client.fetch(objectUrl(key), { method: 'PUT', body, headers });
      if (!response.ok) await fail('put', response);
      return { url: `${publicBase}/${key}`, pathname: key };
    },

    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const params = new URLSearchParams({
        'list-type': '2',
        prefix: String(prefix),
        'max-keys': String(Math.max(1, Number(limit) || 1000))
      });
      if (cursor) params.set('continuation-token', cursor);
      const response = await client.fetch(`${endpoint}/${bucket}?${params.toString()}`);
      if (!response.ok) await fail('list', response);
      const { blobs, cursor: next } = parseListXml(await response.text());
      return {
        blobs: blobs.map((blob) => ({
          ...blob,
          url: `${publicBase}/${blob.pathname}`,
          contentType: contentTypeOf(blob.pathname)
        })),
        cursor: next
      };
    },

    async del(refs) {
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        if (!ref) continue;
        const response = await client.fetch(objectUrl(toKey(ref)), { method: 'DELETE' });
        // 404 视为已删除（幂等）
        if (!response.ok && response.status !== 404) await fail('del', response);
      }
    },

    async read(ref) {
      const key = toKey(ref);
      const response = await client.fetch(objectUrl(key));
      if (!response.ok) await fail('read', response);
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || contentTypeOf(key)
      };
    }
  };
}

module.exports = { createS3Storage, parseListXml, encodeKey, assertKey };
