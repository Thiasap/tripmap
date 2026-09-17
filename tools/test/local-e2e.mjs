/**
 * 本地模式端到端测试（真实 SQLite + 真实文件系统，独立临时目录）。
 *
 * 做法：以子进程启动 server/app.js（TRIPMAP_BACKEND=local），走真实 HTTP 完成
 * 「登录 → 草稿图上传统 → 建旅行（封面+相册+草稿插图迁移）→ 追加照片 → 删除进回收站
 *   → 清理清空回收站 → 删除旅行回收全部媒体」全链路。
 *
 * 该套件是 local 实现的主要回归网；cloud 侧由部署前 Preview 冒烟覆盖（见 MERGE_PLAN §6.2）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64'
);

let pass = 0;
let fail = 0;
function rec(ok, name, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? ' —— ' + detail : ''));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tripmap-e2e-'));
let child = null;
let base = null;

async function startServer() {
  for (const port of [3400, 3401, 3402, 3403]) {
    const proc = spawn(process.execPath, [path.join(projectRoot, 'server', 'app.js')], {
      cwd: projectRoot,
      env: { ...process.env, TRIPMAP_BACKEND: 'local', TRIPMAP_LOCAL_ROOT: tmpRoot, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let exited = false;
    let output = '';
    proc.stdout.on('data', (chunk) => { output += String(chunk); });
    proc.stderr.on('data', (chunk) => { output += String(chunk); });
    proc.on('exit', () => { exited = true; });

    const candidate = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 40 && !exited; i += 1) {
      try {
        const res = await fetch(candidate + '/api/trips');
        if (res.status === 200) { child = proc; base = candidate; return; }
      } catch { /* 尚未就绪 */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    try { proc.kill(); } catch { /* 已退出 */ }
    if (!exited) throw new Error('本地服务起来了但不可达：' + output.slice(0, 300));
  }
  throw new Error('本地服务启动失败（端口 3400-3403 均不可用）');
}

function cleanup() {
  try { if (child) child.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

let cookie = '';
async function req(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  return fetch(base + pathname, { ...options, headers, redirect: 'manual' });
}
const arr = (data) => (Array.isArray(data) ? data : (data && (data.trips || data.data)) || []);

/** 递归统计目录下的文件数（用于断言回收目录确实被清空） */
function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? countFiles(full) : 1;
  }
  return total;
}
const form = (parts) => {
  const body = new FormData();
  for (const [name, value] of parts) {
    if (value && value.file) body.append(name, new Blob([IMAGE_PNG], { type: 'image/png' }), value.file);
    else body.append(name, String(value));
  }
  return body;
};

(async () => {
  await startServer();
  console.log('\nlocal end-to-end（临时实例 ' + base + '）');

  let res = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }) });
  await res.text();
  cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
  rec(res.status === 200 && cookie.length > 0, '登录（本地 config.json 凭据）', 'status=' + res.status);

  res = await req('/api/uploads/richtext', { method: 'POST', body: form([['image', { file: 'draft.png' }]]) });
  const draft = await res.json();
  const draftUrl = String(draft.url || '');
  rec(res.status === 200 && draftUrl.startsWith('/media/richtext_images/draft/'), '草稿插图写入本地存储', draftUrl.slice(0, 60));

  res = await req('/api/trips', {
    method: 'POST',
    body: form([
      ['cover', { file: 'cover.png' }],
      ['album', { file: 'photo.png' }],
      ['name', '[e2e] 本地模式'],
      ['province', '测试省'],
      ['city', '测试市'],
      ['rich_text', '<p>e2e</p><img src="' + draftUrl + '">']
    ])
  });
  const trip = await res.json();
  const id = trip.id;
  rec(res.status === 201 && !!id, '创建旅行（封面 + 相册）', 'status=' + res.status);
  rec(String(trip.cover_path || '').startsWith('/media/album/'), '封面写入本地存储', String(trip.cover_path || '').slice(0, 56));
  rec(String(trip.rich_text_path || '').includes('/media/richtext_images/' + id + '/'), '草稿插图迁移到旅行目录并改写 URL');

  res = await req('/api/trips/' + id + '/files');
  let files = await res.json();
  rec(Array.isArray(files.album) && files.album.length === 1, '相册文件列表', 'album=' + (files.album || []).length);

  res = await req('/api/trips/' + id + '/files', { method: 'POST', body: form([['album', { file: 'extra.png' }]]) });
  await res.text();
  rec(res.status === 200 || res.status === 201, '追加相册照片', 'status=' + res.status);

  res = await req('/api/trips/' + id + '/files');
  files = await res.json();
  const victim = (files.album || [])[0] || {};
  res = await req('/api/trips/' + id + '/files?type=album&name=' + encodeURIComponent(victim.name || ''), { method: 'DELETE' });
  const removed = await res.json();
  rec(res.status === 200 && String(removed.recycle_path || '').startsWith('recycle/') && removed.moved_count >= 1, '删除照片 → 进入回收站', 'moved=' + removed.moved_count);

  res = await req('/api/cleanup-media', { method: 'POST' });
  const cleaned = await res.json();
  const recycleLeft = countFiles(path.join(tmpRoot, 'media', 'recycle'));
  rec(res.status === 200 && cleaned.purged_count >= 1 && recycleLeft === 0, '清理缓存 → 清空回收站（回收目录已空）', 'purged=' + cleaned.purged_count + ', 残留文件=' + recycleLeft);

  res = await req('/api/trips/' + id, { method: 'DELETE' });
  const tripRemoved = await res.json();
  rec(res.status === 200 && tripRemoved.moved_count >= 1, '删除旅行 → 回收全部媒体', 'moved=' + tripRemoved.moved_count);

  res = await req('/api/trips');
  const remaining = await res.json();
  rec(!arr(remaining).some((t) => t.id === id), '数据库中该旅行已删除', '剩余 trips=' + arr(remaining).length);
  void recycleLeft;

  cleanup();
  console.log('\n' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  cleanup();
  console.log('  FAIL 套件异常 —— ' + (error && error.message ? error.message : error));
  console.log('\n' + pass + ' 通过，' + (fail + 1) + ' 失败');
  process.exit(1);
});
