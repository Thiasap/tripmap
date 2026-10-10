# 更新记录与踩坑沉淀

> 供追溯"为什么是现在这样"。按时间倒序；踩坑经验按类别沉淀在文末，多数已固化为 `AGENT.md` 的硬约束。

---

## 2026-09-23 · 性能与删除语义重构（R2 迁移后遗症修复）

**背景**：用户反馈切换 R2 后点击/添加/删除卡片极慢。生产实测 `GET /api/trips/:id/files`（9 张图）冷 16.7s、热 8–12s，对照纯 DB 接口仅 1.1–1.4s。

**根因**：`fileList()` 对每张原图**串行**发一次 list 找缩略图（N+1）。同一代码在 Vercel Blob 时代每次往返仅几十 ms（Vercel 内网），换 R2 后函数（iad1）到 R2 每次往返约 1s，问题被放大 20 倍——**区域从没变过，变的是存储网络的往返成本**。

**改动**（commits `152cc79` / `28bc1aa` / `977bd95`）：

- `fileList()` 单次 list + 内存 Map 匹配缩略图（首查本就返回全部 `thumb_` 对象）：10 次往返 → 1 次，接口 **16.7s → 2.2s**
- `saveUploads()` 并行化：每张图的「原图 + 缩略图」put 互不依赖，`Promise.all` 并发（添加卡片从串行 N×RTT 降为 ≈1×RTT）
- **删除旅行改为仅删 DB 行**（毫秒级返回），媒体留原地成孤儿，由清理任务 `orphanTripDir` 分支统一回收；新增 `ORPHAN_GRACE_MS=1h` 宽限，防「新建旅行先传图后插行」窗口期被误回收
- **单文件删除按 key 直删**（s3/fs 分支）：按命名规则直接 `del` 原图 + `thumb_<name>.jpg`，1 次往返幂等，代价是无回收缓冲（用户拍板接受）；Blob 模式保留 list 定位 + 回收旧路径（其 URL 带随机后缀无法由 key 重建）
- 顺带修复本地模式真 bug：cleanup 的 keep 集合正则只收 `https?://`，本地相对路径 `/media/...` 永不匹配 → 本地跑清理会**误回收使用中的富文本插图**；正则扩为 `(https?:\/\/|\/media\/)`

**验证**：102 项测试全过；生产部署 `26skbfwc4` 上线后只读复测 trips 1.2s / files 2.4s。

**遗留**：`migrateDraftImages` 仍逐张串行（富文本插图多时新建卡片仍慢，另案）。

---

## 2026-09-18 · R2 迁移切生产 + 响应式定局 + 历史泄露清除

**R2 迁移（S1–S5，零停机）**：

- 存储模式拆两轴：`TRIPMAP_BACKEND`（DB）× `TRIPMAP_STORAGE`（媒体），默认维持 cloud+blob；S3 适配器用 `aws4fetch`（~20KB，CJS 可用）
- 迁移脚本 `tools/migrate/blob-to-r2.mjs`：dry-run / apply 幂等续跑 / verify 哈希校验 / rewrite-db URL 改写；645 对象 244.52MB 复制校验一致
- **S3 本地验证抓到上线级阻断**：CSP `img-src` 硬编码只放行 Blob 域名，切 R2 后全部图片被浏览器拦截——根因是 CSP 在 `server/app.js` 与 `api/index.js` **各写一份**（双份漂移）；修法：抽 `server/csp.js` 单一来源，R2 域名由 `R2_PUBLIC_BASE_URL` 动态追加
- **存储 key 化**：决定性事实是 Blob 公开 URL 带不属于 key 的随机后缀、无法由 key 重建 → blob 模式只能存绝对 URL；s3/fs 模式 DB 存相对 key，`mediaUrl()`/`coverRef()` 按 `publicUrl` 能力分派
- 切生产顺序（实测）：写 Production 环境变量 → `--prod` 部署 → `alias set` 切域名 → `--rewrite-db` key 化 39 行 → 全量抓取 39/39 → 回滚演练通过
- 备份工具适配 R2：`TRIPMAP_STORAGE=s3` 自动切换源，645 对象 **153s**（Blob 源 46 分钟，快 18 倍），双校验通过

**响应式改造（方向修正后定局）**：

- 初版做了常规响应式（窄屏文档流列表）→ **用户纠偏**：卡片/地图的位置与相对比例永远不变。最终方案：`index.html` viewport 改 `width=1280`，移动端 = PC 版式整体等比缩放，渲染管线零改动——「位置不变」由此成为结构性保证
- 保留 resize 不刷新：`relayout()` 原地重排（绝不能调 `renderTrips()`，它会重建卡片 DOM 丢编辑态），150ms 防抖 + 手势守卫，仅宽度变化触发

**安全收尾**：

- 用户线上真实环境验收生产写路径通过
- 发现 `tripmap.sqlite` 自 2026-05 起在公开仓库历史暴露 4 个月（个人旅行数据，不含密码）→ `filter-branch` 从全部提交移除 + force push + 复检四道防线全绿；新增 `tools/check-git-leaks.cjs`（跟踪文件 / 历史路径 / 全量 git 对象内容扫描 / ignore 验证），**此后每次 push 前必跑**

---

## 2026-09-17 · 分支定局 + 适配层合并 + 生产恢复

- 源码恢复核实（Vercel 部署产物 112 文件零失败）→ 分支策略定案：`vercel` = 唯一开发分支（GitHub 默认），`master` = 冻结留档（SQLite + media/ + express-session，作为适配层参考实现保留）
- 修复 vercel 分支与本地版缺口 11 处（4 处涉及数据安全：存储型 XSS、CSP 关闭、删除无效、草稿图误删）
- Preview 冒烟 16/16 → 切生产；补全「清理缓存 = 回收孤儿 + 彻底清空 recycle/」闭环
- **Route A 拍板并落地**：单代码库 + 适配层（P0–P6）：数据库适配层契约刻意与 Neon tagged template 同形（26 处调用点零改动）、存储适配层、本地 SQLite/fs 实现、本地 e2e 测试套件（93 项）
- Vercel Blob advanced ops 月额度（2,000）耗尽分析：`/api/trips/:id/files` 每张照片各发一次 list（30 张 ≈ 31 次）是主要消耗点 → 用户选定迁 Cloudflare R2（免费层 10GB + 1000 万读/月，egress 永久免费）

## 2026-08-21 · 全项目代码审查（只读）

- 发现并确认：登录无防爆破、resize 整页 reload、cleanup 误回收未保存富文本图、cover_meta EXIF 颠倒、lightbox 索引错位等；多数在 09-17 的缺口修复中闭环

## 2026-05 ~ 08 · 初代（master，已冻结）

- 本地单用户 SQLite 版：express-session 鉴权、本地 `media/` 存储、`media_recycle/` 删除缓冲。AI 生成（GPT-5.5 + DeepseekV4Pro）。功能文档见 `git show master:README.md`

---

# 踩坑与经验

## 网络与环境（本机实测，方向各不相同）

| # | 坑 | 结论 |
| --- | --- | --- |
| 1 | Vercel CLI 走代理部署反复断连（`fetch failed` → `missing_files`） | **Vercel CLI（deploy/alias/logs）必须直连** |
| 2 | git 直连 push GitHub 报 `Empty reply from server` | **git push 必须走代理 `127.0.0.1:7890`** |
| 3 | `*.vercel.app` 页面直连超时 | 访问预览域名需代理；`tripmap.thiasap.cn` 与 R2 域名可直连 |
| 4 | `tripmap.thiasap.cn` 指向旧部署 | 自定义域名是**手动别名**，`--prod` 不迁移，切生产必须补 `vercel alias set` |
| 5 | Windows bind 3101–3300 报 EACCES | 系统保留端口段；本地实例统一 3400 起 |
| 6 | pnpm 命令 shim 损坏 | 用托管 Node 自带 corepack 直调：`node <node路径>/node_modules/corepack/dist/pnpm.js <cmd>` |
| 7 | Windows git 凭据 GUI 选择器非交互挂死 9 分钟 | `gh auth setup-git` 配 gh token，勿用选择器 |

## 运行时与依赖

| # | 坑 | 结论 |
| --- | --- | --- |
| 8 | sanitize-html 2.17.2+ 依赖纯 ESM 的 htmlparser2，函数启动即崩 | **Vercel 函数运行时不支持 `require(esm)`**：锁 2.17.1 + engines node 22.x；升级依赖前必须验证函数能启动 |
| 9 | 本地测试全过 ≠ Vercel 能跑 | 本地跑五套测试之外，部署前还需 Preview 冒烟（只读） |
| 10 | Vercel Blob advanced ops（put/copy/list）Hobby 月限 2,000，超限停 30 天 | 代码侧避免每对象一次 list 的模式；照片站不适合 Blob，已迁 R2 |

## 架构与代码

| # | 坑 | 结论 |
| --- | --- | --- |
| 11 | N+1 list 在 Blob 时代无感、R2 时代 10s+ | **跨公网存储每对象往返 ~1s**，任何「每对象一次请求」的模式都会被放大；单次前缀 list 已含全部所需对象时，一律内存匹配 |
| 12 | Blob URL 带不属于 key 的随机后缀 | blob 模式无法由 key 重建 URL，只能存绝对 URL；key 化依赖适配器 `publicUrl` 能力（s3/fs 有、blob 无） |
| 13 | CSP 策略在两个入口各写一份，改一处漏一处 | 单一来源（`server/csp.js`）；静态页经 CDN 直出无 CSP 头是已知边界，加固走 `vercel.json headers()` |
| 14 | cleanup keep 集合只收绝对 URL | 本地模式富文本是 `/media/` 相对路径，漏收导致**误回收使用中的图**；匹配要同时覆盖两种形态 |
| 15 | `relayout()` 误调 `renderTrips()` | 会 `innerHTML=''` 重建卡片 DOM、丢编辑态；重排只更新 style/path/pin |
| 16 | 同一文件并行发多个 Edit，一个报 EBUSY、另一个"成功"的写入被静默覆盖 | **同一文件必须串行编辑**，改完回读或对比服务端实际产物验证落盘 |
| 17 | `mediaUrl`/`coverRef` 从适配器实例解构拿到 undefined | 它们是模块级导出（内部按当前适配器分派），不在实例上 |

## 安全与流程

| # | 坑 | 结论 |
| --- | --- | --- |
| 18 | `tripmap.sqlite` 在公开仓库历史暴露 4 个月 | 历史已 filter-branch 重写 + force push；**每次 push 前跑 `node tools/check-git-leaks.cjs`**（四道防线）；GitHub 缓存的不可达对象如需彻底清除要联系 support |
| 19 | `vercel env pull` 拿不到生产密码 | 对 Sensitive 变量只写 13 字符占位符（安全特性）；生产 ADMIN_PASSWORD 不可程序化回读，只能用户本人知晓 |
| 20 | Preview 环境变量指向生产 Neon/R2 | Preview 冒烟**只做只读**；写测试一律在本地实例（`TRIPMAP_BACKEND=local`） |
| 21 | filter-branch 残留 `.git-rewrite/` 未跟踪目录 | 需手动删；历史重写后旧 clone 全部失效 |
| 22 | 函数冷启动偶发 `DB init error ... ConnectTimeoutError` | 平台网络抖动、非致命（应用继续服务），旧部署同样存在，勿当 bug 排查 |

## 测试与验证方法

| # | 坑 | 结论 |
| --- | --- | --- |
| 23 | curl（schannel）对 R2 公开域 TLS 握手失败 | 是 schannel TLS 指纹问题，非站点故障；连通性验证用 Node fetch（OpenSSL） |
| 24 | agent-browser `set viewport` 不触发 viewport meta | 测 meta 相关行为必须用 `set device "iPhone 16"` 设备仿真；换回桌面要 close 重开，否则仿真残留让基线失真 |
| 25 | 冒烟抽样遇到空相册旅行误报 | 抽样要扫描多个 id 取非空样本 |
