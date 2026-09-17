/**
 * 共享工具：配置、脱敏、文件与哈希
 *
 * 所有备份/恢复脚本共用。设计原则：
 * - 不打印任何 Secret：日志只输出状态与计数
 * - 写入原子化：先写 .partial，校验通过后再 rename
 * - 路径安全：拒绝绝对路径、`..`、反斜杠与空字节
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://tripmap.thiasap.cn';
export const BACKUP_FORMAT = 'tripmap-backup';
export const BACKUP_VERSION = 1;

/**
 * 读取 .agent/SECRETS.env 中的键值（不覆盖已存在的进程环境变量）。
 * 仅在项目根目录下查找；找不到就静默跳过。
 */
export function loadLocalSecrets(projectRoot) {
  const file = path.join(projectRoot, '.agent', 'SECRETS.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || value.includes('__MISSING_')) continue;
    out[m[1]] = value;
  }
  return out;
}

/** 解析必需的环境变量；缺失时抛错，且不回显值 */
export function requireEnv(name, fallback, source) {
  const value = process.env[name] || source?.[name] || fallback;
  if (!value) throw new Error(`缺少环境变量或本地配置: ${name}`);
  return value;
}

/** 只显示变量是否可用，绝不输出内容 */
export function describeSecret(value) {
  return value ? 'available' : 'missing';
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 校验备份内部相对路径是否安全，返回规范化后的路径。
 * 拒绝：绝对路径、盘符、`..` 上跳、反斜杠、空字节、URL 编码穿越。
 */
export function safeRelativePath(input) {
  const raw = String(input ?? '');
  if (!raw) throw new Error('空路径');
  if (raw.includes('\0')) throw new Error(`路径含空字节: ${raw}`);
  if (raw.includes('\\')) throw new Error(`路径含反斜杠: ${raw}`);

  let decoded = raw;
  for (let i = 0; i < 3; i += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new Error(`路径解码后含非法字符: ${raw}`);
  }
  if (path.isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded)) {
    throw new Error(`路径为绝对路径: ${raw}`);
  }

  const normalized = path.posix.normalize(decoded);
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
    throw new Error(`路径越界: ${raw}`);
  }
  return normalized.replace(/^\.\//, '');
}

/** 把相对路径拼到根目录下，并再次确认未逃逸 */
export function resolveInside(rootDir, relative) {
  const safe = safeRelativePath(relative);
  const resolved = path.resolve(rootDir, safe);
  const rootResolved = path.resolve(rootDir) + path.sep;
  if (!resolved.startsWith(rootResolved)) {
    throw new Error(`目标路径逃逸备份根目录: ${relative}`);
  }
  return resolved;
}

/** 原子写入：先写临时文件再 rename，避免留下看似完整的半成品 */
export async function writeFileAtomic(targetPath, data, { mode } = {}) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.partial`;
  await fsp.writeFile(tmp, data, mode === undefined ? undefined : { mode });
  await fsp.rename(tmp, targetPath);
}

/** 以流式方式写入，回调中拿到写入流（用于大文件下载） */
export async function writeStreamAtomic(targetPath, writer) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.partial`;
  const stream = fs.createWriteStream(tmp);
  try {
    await writer(stream);
    await new Promise((resolve, reject) => {
      stream.end(() => resolve());
      stream.on('error', reject);
    });
    await fsp.rename(tmp, targetPath);
  } catch (error) {
    stream.destroy();
    await fsp.rm(tmp, { force: true });
    throw error;
  }
}

export function nowStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * 统一的脱敏日志：过滤连接串、Token、Cookie 与密码字段，
 * 保证脚本失败时不会把凭据写进日志或 CI 输出。
 */
export function redact(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/[^:@\s]+):[^@\s]+@/gi, '$1:***@')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1***')
    .replace(/(BLOB_READ_WRITE_TOKEN=)\S+/gi, '$1***')
    .replace(/(password["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1***')
    .replace(/(Cookie:\s*)[^\s]+/gi, '$1***');
}

export function log(message) {
  process.stdout.write(`${redact(message)}\n`);
}

export function logError(message) {
  process.stderr.write(`${redact(message)}\n`);
}

/** 简易 CLI 参数解析：--key=value 或 --flag */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      out[m[1]] = m[2] === undefined ? true : m[2];
    } else {
      out._.push(arg);
    }
  }
  return out;
}
