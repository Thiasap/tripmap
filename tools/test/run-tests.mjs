/**
 * 备份/恢复工具的自检用例，零依赖，直接 node 运行。
 *
 *   node tools/test/run-tests.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  safeRelativePath,
  resolveInside,
  redact,
  nowStamp,
  parseArgs
} from '../lib/common.mjs';
import { validate } from '../lib/json-schema.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, message: error.message });
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

process.stdout.write('safeRelativePath\n');

test('接受正常的 Blob 路径', () => {
  assert.equal(safeRelativePath('album/abc/photo.jpg'), 'album/abc/photo.jpg');
});

test('拒绝上跳路径', () => {
  assert.throws(() => safeRelativePath('../../etc/passwd'));
  assert.throws(() => safeRelativePath('album/../../etc/passwd'));
});

test('拒绝 URL 编码的上跳', () => {
  assert.throws(() => safeRelativePath('..%2f..%2fetc%2fpasswd'));
  assert.throws(() => safeRelativePath('%2e%2e%2fetc'));
});

test('拒绝绝对路径与盘符', () => {
  assert.throws(() => safeRelativePath('/etc/passwd'));
  assert.throws(() => safeRelativePath('C:/Windows/system32'));
});

test('拒绝反斜杠与空字节', () => {
  assert.throws(() => safeRelativePath('album\\..\\..\\evil'));
  assert.throws(() => safeRelativePath('album/photo.jpg\0.png'));
});

test('保留中文与空格', () => {
  assert.equal(safeRelativePath('album/旅行 照片.jpg'), 'album/旅行 照片.jpg');
});

process.stdout.write('resolveInside\n');

test('目录内的路径正常解析', () => {
  const resolved = resolveInside(projectRoot, 'album/a.jpg');
  assert.ok(resolved.startsWith(path.resolve(projectRoot)));
});

test('越界路径抛出异常', () => {
  assert.throws(() => resolveInside(projectRoot, '../../outside.txt'));
});

process.stdout.write('redact\n');

test('隐藏 PostgreSQL 连接串密码', () => {
  const out = redact('连接 postgresql://user:s3cret@host/db 失败');
  assert.ok(!out.includes('s3cret'), '密码不应出现');
  assert.ok(out.includes('***'));
});

test('隐藏 Bearer Token', () => {
  const out = redact('Authorization: Bearer abcdef123456');
  assert.ok(!out.includes('abcdef123456'));
});

test('隐藏 Blob Token 赋值', () => {
  const out = redact('BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx');
  assert.ok(!out.includes('vercel_blob_rw_xxx'));
});

test('隐藏 password 字段', () => {
  const out = redact('{"password":"hunter2"}');
  assert.ok(!out.includes('hunter2'));
});

process.stdout.write('nowStamp\n');

test('生成的文件名不含冒号等非法字符', () => {
  const stamp = nowStamp(new Date('2026-09-17T04:55:59.123Z'));
  assert.equal(stamp, '2026-09-17T045559Z');
  assert.ok(!/[:.]/.test(stamp));
});

process.stdout.write('parseArgs\n');

test('解析 --key=value 与 --flag', () => {
  const args = parseArgs(['--out=backups/x', '--skip-blobs', 'positional']);
  assert.equal(args.out, 'backups/x');
  assert.equal(args['skip-blobs'], true);
  assert.deepEqual(args._, ['positional']);
});

process.stdout.write('json-schema validate\n');

const demoSchema = {
  type: 'object',
  required: ['format', 'trips'],
  additionalProperties: false,
  properties: {
    format: { type: 'string', const: 'tripmap-export' },
    trips: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } }
      }
    },
    version: { type: 'integer', minimum: 1 }
  }
};

test('合法文档通过', () => {
  assert.deepEqual(validate({ format: 'tripmap-export', trips: [{ id: 'a' }], version: 1 }, demoSchema), []);
});

test('缺少必需字段被报告', () => {
  const errors = validate({ format: 'tripmap-export' }, demoSchema);
  assert.ok(errors.some((e) => e.includes('缺少必需字段 trips')));
});

test('常量不匹配被报告', () => {
  const errors = validate({ format: 'wrong', trips: [] }, demoSchema);
  assert.ok(errors.some((e) => e.includes('期望常量')));
});

test('数组元素错误定位到索引', () => {
  const errors = validate({ format: 'tripmap-export', trips: [{ id: '' }] }, demoSchema);
  assert.ok(errors.some((e) => e.includes('trips[0].id')));
});

test('未声明字段被报告', () => {
  const errors = validate({ format: 'tripmap-export', trips: [], extra: 1 }, demoSchema);
  assert.ok(errors.some((e) => e.includes('未声明的字段 extra')));
});

test('number 接受整数', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  assert.deepEqual(validate({ x: 3 }, schema), []);
});

process.stdout.write(`\n${passed} 通过，${failed} 失败\n`);
if (failed) {
  process.stdout.write('\n失败用例:\n');
  for (const f of failures) process.stdout.write(`  ${f.name}: ${f.message}\n`);
  process.exit(1);
}
