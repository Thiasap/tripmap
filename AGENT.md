# AGENT.md — 开发思路与后续方向

> 面向后续接手本项目的 Agent（或人类协作者）。目标：10 分钟建立正确的心智模型，不踩已知的坑。
> 本文件进 Git 公开维护；本机深度交接（凭据状态、回滚映射、命令速查）在 `.agent/SESSION_SUMMARY.md`（不进 Git）。

## 1. 项目定位与现状

单用户旅行记录应用（中国地图 + 浮动卡片），**由 AI Agent 全程迭代**，用户是唯一所有者与验收人。当前生产 `https://tripmap.thiasap.cn`：

- 单代码库双后端（`vercel` 分支 = 唯一开发分支；`master` 冻结留档，**不更新不删除**，其实现是本地适配层的参考）
- 生产链路：Vercel 函数（iad1）→ Neon PostgreSQL + Cloudflare R2
- 状态（2026-09-23）：102 项测试全过，性能与删除语义重构已上线，生产写路径经用户真实环境验收

## 2. 架构设计决策（为什么是现在这样）

| 决策 | 理由 |
| --- | --- |
| **适配层两轴**：`TRIPMAP_BACKEND=cloud\|local`（DB）× `TRIPMAP_STORAGE=blob\|s3\|fs`（媒体） | 用户不想维护两个项目。一份代码本地验证后上生产，本地实例（真实 SQLite + media/，40 旅行）可随便写、零生产影响 |
| **DB 适配层契约与 Neon tagged template 同形**（`sql\`...\`` / `sql.transaction`） | 26 处调用点零改动；换库只动适配器 |
| **存储契约与 `@vercel/blob` 同形**（put/list/del/read + 可选 publicUrl） | 调用点改动最小；blob/s3/fs 三个实现可替换 |
| **DB 只存媒体相对 key，URL 由 `mediaUrl()` 读取时解析** | 换域名/换存储 = 改环境变量，无需改库。注意 blob 例外：其 URL 带随机后缀无法由 key 重建，blob 模式必须存绝对 URL（`coverRef` 按 `publicUrl` 能力分派） |
| **删卡片 = 仅删 DB 行，媒体延迟回收** | R2 每对象往返 ~1s，同步回收把删除拖到 10s+。孤儿由清理任务 `orphanTripDir` 分支统一收走，`ORPHAN_GRACE_MS=1h` 宽限防「先传图后插行」窗口误收 |
| **单文件删除按 key 直删（s3/fs），Blob 走 list+回收** | 直删无回收缓冲（用户拍板接受），换毫秒级响应；Blob 无 key 寻址能力只能旧路径 |
| **移动端 = PC 版式整体等比缩放**（viewport `width=1280`，渲染管线零改动） | 用户铁律：卡片/地图位置与相对比例永远不变，不做单独移动端布局。曾做的窄屏紧凑布局已被要求完整移除 |
| **resize 不刷新**：`relayout()` 原地重排，仅宽度变化触发 | `renderTrips()` 会重建卡片 DOM 丢编辑态，重排路径绝不能调它 |
| **删除/回收语义**：回收 = copy 到 `recycle/<时间戳>/` 再删原件（宁冗余不丢数据）；「清理缓存」= 回收孤儿 + **彻底清空 recycle/**（永久，前端有二次确认） | 数据安全优先；回收站不长期堆积 |

## 3. 硬约束（红线，违反 = 事故）

1. **生产默认只读**。任何写入/删除/轮换/切生产，都要用户针对当次操作明确批准；测试（含登录尝试）一律先在本地做。
2. **本地不设 `TRIPMAP_BACKEND` = 直连生产**（同 Neon + 同 R2），视为操作生产，只读。
3. Secret 只由进程从 `.agent/SECRETS.env` 读取；不回显、不进 Git、不进日志。`.agent/`、`backups/`、`config.json`、`media/`、`tripmap.sqlite*` 均被 gitignore，禁止 `git add -f`。
4. **每次 push 前跑 `node tools/check-git-leaks.cjs`**（历史曾泄露 sqlite，已重写清除）。
5. **切生产必须两步**：`vercel deploy --prod` + `vercel alias set <url> tripmap.thiasap.cn`（自定义域名是手动别名，`--prod` 不会迁移）。
6. 网络路径（实测，方向相反）：Vercel CLI **直连**；git push GitHub **走代理** `127.0.0.1:7890`；`*.vercel.app` 页面需代理。
7. **Vercel 函数运行时不支持 `require(esm)`**：依赖必须能 `require()` 加载（sanitize-html 锁 2.17.1、engines node 22.x），升级依赖前先验证函数能启动。
8. 备份必须经过恢复验证才算完成；恢复只在临时目录/测试库执行。
9. 前端布局铁律见上表（等比缩放 + relayout 禁调 renderTrips）。
10. 不删除 Blob 对象（回滚路径保留）、不清生产库、不卸载 Neon/Vercel 集成。

## 4. 开发工作流（用户习惯，务必遵守）

1. **规划先行**：涉及行为变更的改动，先给方案与评估，用户批准后进入编码；用户偏好保守收敛的最小变更、单次迭代控制变更半径。
2. **本地验证 → 生产**：`pnpm test`（102 项，见下）全过 → 泄漏检查 → commit（精简提交信息）→ `vercel deploy --prod`（直连）→ `alias set` → 生产只读复测。
3. **生产只读探测**验证效果（GET 请求 + 计时），不做写测试。
4. 汇报风格：简洁、决定式；用户常在执行中途下达范围调整指令，收到即调整继续。
5. 一次性方案文档（`*_PLAN.md`）用完即删，只在根 README 留一句话沿革。

```bash
# 测试（本机 pnpm shim 损坏时用 corepack 直调，等效）
node tools/test/adapter-contract.mjs && node tools/test/run-tests.mjs && node tools/test/vercel-server-tests.mjs && node tools/test/vercel-integration.mjs && node tools/test/local-e2e.mjs
# = 契约 22 + 工具 20 + 服务端 11 + 集成 36 + 本地 e2e 13 = 102 项，全部不接触云端

# 本地实例（可随便写）
TRIPMAP_BACKEND=local TRIPMAP_LOCAL_ROOT=<仓库根> node server/app.js   # 端口 3400 起（3101-3300 是 Windows 保留段）

# 备份（需代理 + Node 24；R2 源 645 对象 153s）
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 TRIPMAP_STORAGE=s3 "D:/Programs/nodejs/node.exe" tools/backup/run-all.mjs
node tools/backup/verify-backup.mjs --dir=backups/<id>
```

## 5. 已知边界（不是 bug，别误修）

| 项 | 说明 |
| --- | --- |
| 静态页无 CSP 头 | Vercel CDN 直发 `public/` 不经函数；加固走 `vercel.json headers()`（待办） |
| 冷启动偶发 `DB init error` | Neon 连接抖动、非致命，应用继续服务；旧部署同样存在 |
| `recycle/` 依赖手动「清理缓存」 | 不点清理则累积；清理 = 永久删除（有二次确认） |
| 函数区 iad1（美东） | Hobby 锁定不可改；已验证瓶颈在存储往返而非区域（09-23 实测），无需升 Pro 搬区域 |
| 本地 sqlite（40 旅行）与云端库（39 旅行）是两套独立数据 | 不互相同步，本地实例数据更全属预期 |
| 回滚到 Blob 的边界 | 2026-09-18 后新建的对象只在 R2，回滚前需先复制回 Blob（映射见 `.agent/r2-keyify-backmap.json`） |

## 6. 后续方向与目标（按优先级）

1. **备份自动化**（唯一实质待办）：定运行位置（本机计划任务 / CI）与凭据存放方式；备份 → 自动校验 → 异地副本。
2. **可选加固**：`vercel.json headers()` 给静态页加 CSP；Neon 只读备份角色；部署保护绕过 token 去留。
3. **性能余量**：`migrateDraftImages` 仍逐张串行（富文本插图多时新建卡片慢）——可并行化或并入清理任务；如删除卡片后清理速度仍不满意，可提升 `recycleBlobs` 并发或改批量删除。
4. **不建议做的**：移动端单独布局（铁律）、搬函数区域（已证非瓶颈）、换数据库（3MB 数据 + 备份链已建，收益低风险高）、删除 Blob 对象（回滚路径）。

## 7. 快速上下文

- 数据规模（2026-09-18）：39 旅行 / 8 设置 / 22 人员；R2 645 对象 244.52 MB（39 封面 + 303 原图 + 303 缩略图）
- `trips.rich_text_path` 字段名有误导性，实际存**内联 HTML 原文**；线上富文本内嵌图片数为 0
- 媒体 key 约定：`album/<id>/cover_<id>.jpg`（封面）、`album/<id>/<时间戳>_<随机>.<ext>`（原图）、`album/<id>/thumb_<原key>.jpg`（缩略图）、`attachments/<id>/…`、`richtext_images/<id>/…`（新建时先入 `draft/`，保存时迁移并改写 URL）
- 详细历史与踩坑：`CHANGE.md`
