# 旅行地图 — Vercel 部署版

线上生产环境 `https://tripmap.thiasap.cn` 实际运行的版本。此分支与 `master` 的本地 SQLite 版并行维护：

| | `master`（本地版） | `vercel`（本分支） |
| --- | --- | --- |
| 数据库 | `node:sqlite`（本地文件） | Neon PostgreSQL（`@neondatabase/serverless`） |
| 文件存储 | 本地 `media/` 目录 | Vercel Blob（`@vercel/blob`） |
| 鉴权 | `express-session` + 内存 Session | JWT Cookie（`jsonwebtoken`） |
| 入口 | `server/app.js` 直接监听 | `api/index.js` Serverless 函数 |
| 部署 | 本机 `node server/app.js` | Vercel（`vercel.json` 重写到 `/api/index`） |

> 本分支源码由 Vercel 部署产物恢复而来（deployment `dpl_GcEsXzmbmqYYLxpus7yj4AUpb3iP`），
> 恢复过程与校验见 `.agent/`（本地目录，不提交）。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `POSTGRES_URL` / `DATABASE_URL` | 是 | Neon PostgreSQL 连接串（由 Neon 集成自动注入） |
| `BLOB_READ_WRITE_TOKEN` | 是 | Vercel Blob 读写 Token（由 Blob 集成自动注入） |
| `ADMIN_PASSWORD` | 是 | 管理员密码，缺省回退 `config.json` 或 `admin` |
| `SESSION_SECRET` | 是 | JWT 签名密钥，缺省回退 `config.json` |

## 数据表

三张表，与本地版字段一致，`participants.id` 在 PostgreSQL 下为 `SERIAL`：

- `trips` — 旅行记录（`rich_text_path` 存富文本 HTML 原文）
- `settings` — 键值配置
- `participants` — 人员及参与次数

媒体文件在 Blob 中的路径约定：

```
album/<tripId>/cover_<tripId>.jpg      # 封面
album/<tripId>/<时间戳>_<随机>.jpg      # 相册原图
album/<tripId>/thumb_<同上>.jpg        # 相册缩略图
attachments/<tripId>/<文件名>           # 附件
richtext_images/<tripId>/<文件名>       # 富文本插图
```

## 本地开发

```bash
pnpm install
pnpm dev          # vercel dev，注入线上环境变量
```

## 迁移脚本

```bash
node scripts/migrate-to-postgres.js   # 本地 SQLite → Neon PostgreSQL
node scripts/migrate-to-blob.js       # 本地 media/ → Vercel Blob
```

两个脚本都需要先设置 `POSTGRES_URL`，`migrate-to-blob.js` 另需 `BLOB_READ_WRITE_TOKEN`。

## 备份与恢复

备份/恢复工具在 `tools/` 下，用于把线上数据导出为可离线保存、可恢复到本地 SQLite 的格式：

```bash
node tools/backup/export-database.mjs    # 通过公开 API 导出全部业务数据
node tools/backup/export-blobs.mjs       # 下载全部 Blob 并生成 SHA-256 清单
node tools/backup/verify-backup.mjs      # 校验备份完整性
node tools/restore/to-local.mjs          # 备份 → 本地 SQLite + media/
```

详见 `../.agent/VERCEL_DATA_PORTABILITY_PLAN.md`（本地文件）。
