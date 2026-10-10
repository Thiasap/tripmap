# 版本沿革

> 只记「做了什么」。**为什么这么做、踩了哪些坑**见 `.agent/CHANGELOG.md` 与 `.agent/ARCHITECTURE.md`。
> 按时间倒序。

## 2026-10 · 安全加固与性能优化

- **安全**：登录改为 fail-closed（缺 `ADMIN_PASSWORD`/`SESSION_SECRET` 时禁止登录，不再回退默认口令）；
  上传改为**后端魔数校验通过后才写存储**，图片类型与 Content-Type 全部由服务端决定；
  `vercel.json` 为 CDN 直出的静态页补齐 CSP 等安全响应头，并新增 `tools/check-headers.mjs` 守卫域名漂移；
  `.claude/settings*.json` 移出 Git 跟踪；部署产物按隐私最小化收敛（删除 `session.txt` 与过时的 `README.vercel.md`）。
- **性能**：`migrateDraftImages` 并行化；S3 适配层删除改为 `DeleteObjects` 批量（单次 1000 键），
  「清理缓存」不再因逐对象串行往返而超时。
- **文档**：细节统一进 `.agent/`，根目录三份 md 精简为人类可读版本。

## 2026-09-23 · 性能与删除语义重构

- `fileList()` 消除缩略图 N+1 list：接口 16.7s → 2.2s；`saveUploads()` 并行化。
- **删除旅行改为仅删 DB 行**（毫秒级返回），媒体留原地由清理任务回收（1 小时宽限期防误收）。
- 单文件删除按 key 直删（s3/fs），换取毫秒级响应。
- 修复本地模式清理任务误回收使用中的富文本插图。

## 2026-09-18 · R2 迁移切生产 + 响应式定局 + 历史泄露清除

- Blob → Cloudflare R2 零停机迁移（645 对象校验、DB key 化、回滚演练通过）。
- 响应式定局：移动端 = PC 版式整体等比缩放（viewport `width=1280`），卡片/地图位置与比例永不变。
- 发现 `tripmap.sqlite` 曾在公开仓库历史暴露 4 个月 → 历史重写 + 新增 `tools/check-git-leaks.cjs`，
  此后每次 push 前必跑。

## 2026-09-17 · 分支定局 + 适配层合并 + 生产恢复

- `vercel` = 唯一开发分支；`master` = 冻结留档。
- 单代码库 + 适配层（P0–P6）：DB 与存储两轴可切换，一份代码同时支撑生产与本地。
- 修复 vercel 分支与本地版缺口 11 处（4 处涉及数据安全）。

## 2026-08-21 · 全项目代码审查（只读）

- 发现登录无防爆破、resize 整页 reload、cleanup 误回收未保存富文本图、cover_meta EXIF 颠倒等；
  多数已在 09-17 的缺口修复中闭环。

## 2026-05 ~ 08 · 初代（master，已冻结）

- 本地单用户 SQLite 版：express-session 鉴权、本地 `media/` 存储、`media_recycle/` 删除缓冲。
