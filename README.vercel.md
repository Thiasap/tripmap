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

## 安全措施

- 所有写接口经 `requireAdmin` 校验 JWT Cookie（httpOnly + sameSite=lax，
  生产环境自动 `Secure`）
- 鉴权配置集中在 `server/auth.js`，被 `api/index.js` 与 `server/app.js` 共用，
  避免两端密钥不一致导致「登录成功但写接口 401」
- 密码比较：SHA-256 后 `timingSafeEqual`，防时序侧信道
- 登录限速：同 IP 15 分钟窗口内失败 10 次后锁定（Serverless 多实例下为尽力而为）
- Helmet CSP：`script-src 'self'`，`img-src` 放行 Vercel Blob 域名，
  允许 inline 样式以兼容 Quill/GLightbox
- 富文本经 `sanitize-html` 净化，禁用协议相对 URL（`//evil.com/x.png`）
- 上传：扩展名白名单 + MIME 校验，单文件 200MB、字段 100KB
- 错误响应：客户端错误返回原因，服务端错误一律返回通用文案，
  不泄露路径或连接串
- `.vercelignore` 阻止 `config.json` 等本地敏感文件随部署上传

## 数据安全约定

- **删除即回收**：删除旅行或单个媒体时，先把对象复制到 `recycle/<时间戳>/<原路径>`
  再删除原对象；复制失败的对象保留不删。对应接口返回
  `{ recycle_path, moved_count, failed_count }`
- **清理规则**（`POST /api/cleanup-media`）：
  - 保留：仍存在旅行的相册/附件、正文引用到的富文本图、旅行封面
  - 回收：孤儿旅行目录、超过 24 小时宽限期的 `richtext_images/draft/` 草稿图、
    正文未引用的富文本图、原图已丢失的 `thumb_` 缩略图
- **草稿图迁移**：新建时上传的富文本插图先落在 `richtext_images/draft/`，
  保存旅行时自动迁移到 `richtext_images/<tripId>/` 并改写正文 URL；
  单张迁移失败时保留原 URL，宁可留下冗余也不丢图

## 与 `master`（本地版）的差异

两版功能与安全策略保持一致，差异仅来自存储介质：

| 方面 | master | vercel |
| --- | --- | --- |
| 回收目录 | 本地 `media_recycle/<时间戳>/` | Blob 前缀 `recycle/<时间戳>/` |
| 回收实现 | `fs.renameSync`（原子移动） | 读取 → 写入 recycle 前缀 → 删除原对象 |
| 会话 | `express-session` + 内存存储 | 无状态 JWT Cookie |
| 图片处理 | 写盘后读取尺寸 | 内存处理，从处理后 buffer 读取尺寸 |

前端文案已按上表调整（提示「移入回收目录」而非「移到 media_recycle 目录」）。

## 备份与恢复

备份/恢复工具在 `tools/` 下，全部只读访问线上、不依赖数据库连接串：

```bash
pnpm backup                              # 一键：导出数据库 → 下载 Blob → 校验
node tools/backup/verify-backup.mjs --dir=backups/xxx
node tools/restore/to-local.mjs --dir=backups/xxx --out=<目标目录>
```

## 测试

```bash
pnpm test              # 全部 64 项
pnpm run test:backup   # 备份工具自检（20 项）
pnpm run test:server   # 服务端与集成测试（11 + 33 项）
```

集成测试通过桩模块替换 Neon 与 Vercel Blob，端到端验证 CSP、登录限速、
富文本净化、坐标钳制、回收流程、清理规则、草稿图迁移、图片处理与上传校验，
不连接任何真实数据库或 Blob。

