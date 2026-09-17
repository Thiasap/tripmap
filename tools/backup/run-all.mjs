/**
 * 一键备份：导出数据库 → 下载 Blob → 校验，三步共用一个备份目录。
 *
 * 用法：
 *   node tools/backup/run-all.mjs                 # 新建时间戳目录并完整执行
 *   node tools/backup/run-all.mjs --out=backups/x # 指定目录（可续跑）
 *   node tools/backup/run-all.mjs --skip-blobs    # 只导数据库（快速快照）
 *
 * 退出码：0 全部成功；1 任一步失败（备份不可信，勿当作有效备份使用）。
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nowStamp, parseArgs, log, logError } from '../lib/common.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runStep(label, script, args) {
  return new Promise((resolve) => {
    log(`\n=== ${label} ===`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const args = parseArgs();
  const outDir = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(projectRoot, 'backups', `tripmap-${nowStamp()}`);
  const outArg = `--out=${outDir}`;

  log(`备份目录: ${outDir}`);

  const databaseCode = await runStep(
    '1/3 导出数据库与媒体引用',
    path.join(projectRoot, 'tools', 'backup', 'export-database.mjs'),
    [outArg]
  );
  if (databaseCode !== 0) {
    logError('数据库导出失败，中止本次备份');
    process.exit(1);
  }

  if (args['skip-blobs']) {
    log('\n已跳过 Blob 下载（--skip-blobs），本次仅生成数据库快照');
    return;
  }

  const blobsCode = await runStep(
    '2/3 下载并校验 Blob 对象',
    path.join(projectRoot, 'tools', 'backup', 'export-blobs.mjs'),
    [outArg]
  );
  if (blobsCode !== 0) {
    logError('Blob 备份未全部成功，本次备份标记为不完整');
    process.exit(1);
  }

  const verifyCode = await runStep(
    '3/3 校验备份完整性',
    path.join(projectRoot, 'tools', 'backup', 'verify-backup.mjs'),
    [`--dir=${outDir}`]
  );
  if (verifyCode !== 0) {
    logError('校验未通过，请查看 reports/verify.json');
    process.exit(1);
  }

  log('\n备份完成并通过校验');
  log(`  目录: ${outDir}`);
  log('  建议：将整个目录复制到与 Vercel/Neon 无关的存储（NAS、移动硬盘或对象存储）');
}

main().catch((error) => {
  logError(`备份失败: ${error.message}`);
  process.exit(1);
});
