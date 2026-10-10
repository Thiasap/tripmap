# AGENT.md — 协作须知

> 面向后续接手本项目的 Agent（或人类协作者）。目标：10 分钟建立正确的心智模型，不踩已知的坑。
> **本文件保持干练**；架构理由、完整踩坑、安全模型在 `.agent/`（本机目录，不进 Git）。

## 1. 项目现状

单用户旅行记录应用（中国地图 + 浮动卡片），由 AI Agent 全程迭代，用户是唯一所有者与验收人。

- 单代码库双后端（`vercel` 分支 = 唯一开发分支；`master` 冻结留档，**不更新不删除**）
- 生产链路：Vercel 函数（iad1）→ Neon PostgreSQL + Cloudflare R2
- 109 项测试全过，生产写路径经用户真实环境验收

## 2. 硬约束（红线，违反 = 事故）

1. **生产默认只读**。任何写入/删除/轮换/切生产，都要用户针对当次操作明确批准；
   测试（含登录尝试）一律先在本地做。
2. **本地不设 `TRIPMAP_BACKEND` = 直连生产**（同 Neon + 同 R2），视为操作生产，只读。
3. Secret 只由进程从 `.agent/SECRETS.env` 读取；不回显、不进 Git、不进日志。
   `.agent/`、`backups/`、`config.json`、`media/`、`tripmap.sqlite*`、`.claude/` 均已忽略，
   禁止 `git add -f`。
4. **每次 push 前跑两道门**：`node tools/check-git-leaks.cjs`、`node tools/check-headers.mjs`。
5. **切生产必须两步**：`vercel deploy --prod` + `vercel alias set <url> tripmap.thiasap.cn`
   （自定义域名是手动别名，`--prod` 不会迁移）。
6. **换媒体域名必须同步 `vercel.json` 的 CSP `img-src`**（静态页由 CDN 直出、不经过函数）；
   漏改会被 `check-headers` 拦下。
7. 网络路径（实测，方向相反）：Vercel CLI **直连**；git push GitHub **走代理** `127.0.0.1:7890`。
8. **Vercel 函数运行时不支持 `require(esm)`**：依赖必须能 `require()` 加载
   （sanitize-html 锁 2.17.1、engines node 22.x）。升级依赖前先验证函数能启动。
9. 备份必须经过恢复验证才算完成；恢复只在临时目录/测试库执行。
10. 前端布局铁律：**卡片/地图的位置与相对比例永远不变**，不做单独移动端布局；
    `relayout()` 原地重排，**绝不能调 `renderTrips()`**（会重建卡片 DOM 丢编辑态）。
11. 不删除 Blob 对象（回滚路径保留）、不清生产库、不卸载 Neon/Vercel 集成。

## 3. 开发工作流

1. **规划先行**：涉及行为变更的改动，先给方案与评估，用户批准后进入编码；
   偏好保守收敛的最小变更、单次迭代控制变更半径。
2. **本地验证 → 生产**：`pnpm test` 全过 → 两道门 → commit（精简提交信息）→
   `vercel deploy --prod`（直连）→ `alias set` → 生产只读复测。
3. 生产只读探测（GET + 计时）验证效果，不做写测试。
4. 汇报风格：简洁、决定式；用户常在执行中途下达范围调整指令，收到即调整继续。
5. 一次性方案文档（`*_PLAN.md`）用完即删，只在根 README 留一句话沿革。

```bash
# 测试（本机 pnpm shim 损坏时用 node 直跑五套脚本，等效 pnpm test）
node tools/test/adapter-contract.mjs && node tools/test/run-tests.mjs && node tools/test/vercel-server-tests.mjs && node tools/test/vercel-integration.mjs && node tools/test/local-e2e.mjs
# = 契约 24 + 工具 20 + 服务端 13 + 集成 39 + 本地 e2e 13 = 109 项，全部不接触云端

# 本地实例（可随便写）
TRIPMAP_BACKEND=local TRIPMAP_LOCAL_ROOT=<仓库根> node server/app.js   # 端口 3400 起（3101-3300 是 Windows 保留段）
```

> Windows 的 PowerShell 5.1 不支持 `&&`：串联命令用 `cmd /c "a && b"`。

## 4. 已知边界（不是 bug，别误修）

| 项 | 说明 |
| --- | --- |
| 读接口公开 | **有意设计**：`/api/trips` 等对游客开放，GPS/人员/日期可见 |
| `recycle/` 清理前仍公网可读 | 删除 ≠ 立即不可访问；「清理缓存」才永久删除 |
| 登录限速尽力而为 | Serverless 多实例内存不共享，依赖强密码 + 平台侧限制 |
| R2 对象无 `nosniff` | 公开域响应头不由我们控制；靠服务端 Content-Type 正确性 |
| 冷启动偶发 `DB init error` | Neon 连接抖动、非致命，应用继续服务；旧部署同样存在 |
| 函数区 iad1（美东） | Hobby 锁定不可改；瓶颈在存储往返而非区域，无需升 Pro |
| 本地 sqlite（40 旅行）与云端库（39 旅行）是两套独立数据 | 不互相同步，本地数据更全属预期 |
| 回滚到 Blob 的边界 | 2026-09-18 后新建的对象只在 R2，回滚前需先复制回 Blob |

## 5. 后续方向（按优先级）

1. **备份自动化**（唯一实质待办）：定运行位置（本机计划任务 / CI）与凭据存放方式；
   备份 → 自动校验 → 异地副本。
2. **可选加固**：登录限流持久化、上传总量上限、`recycle/` 公网可读语义、
   公开接口字段白名单、`sanitize-html` 版本债、`check-git-leaks` 容错。
   完整清单与理由见 `.agent/SECURITY.md`。
3. **不建议做的**：移动端单独布局（铁律）、搬函数区域（已证非瓶颈）、换数据库、
   删除 Blob 对象（回滚路径）。

## 6. 需要更深的上下文时

| 想知道 | 去哪里 |
| --- | --- |
| 交接总纲、命令速查、凭据要点 | `.agent/SESSION_SUMMARY.md` |
| 为什么架构是这样、踩过哪些坑 | `.agent/ARCHITECTURE.md` |
| 安全模型、审查处置、未处置清单 | `.agent/SECURITY.md` |
| 完整更新记录 | `.agent/CHANGELOG.md` |
| 凭据可用性与补齐步骤 | `.agent/CREDENTIALS_STATUS.md` |
