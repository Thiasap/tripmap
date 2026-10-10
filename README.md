# 旅行地图（Tripmap）

本地单用户旅行记录 Web 应用：基于中国地图，以浮动卡片展示旅行记录，支持富文本编辑、相册管理、人员标签、地图导出、游客/管理员鉴权。本项目由 AI 生成（GPT-5.5 + DeepseekV4Pro），并由 AI Agent 持续迭代维护。

## 当前版本（2026-10）

**单代码库 · 双后端**：一份代码同时支撑云上生产与本地开发。

| 组件 | 生产（默认） | 本地 |
| --- | --- | --- |
| 运行 | Vercel 函数（`api/index.js`，`vercel.json` 全量重写） | `node server/app.js` |
| 数据库 | Neon PostgreSQL（`@neondatabase/serverless`） | SQLite（`node:sqlite`，WAL） |
| 媒体存储 | Cloudflare R2（S3 兼容，自定义域名直读） | 本地 `media/` 目录 |
| 鉴权 | JWT Cookie（`jsonwebtoken`，无状态） | 同实现 |

- 线上地址：`https://tripmap.thiasap.cn`（手动别名——部署后必须 `vercel alias set` 切换）
- 模式开关：`TRIPMAP_BACKEND=cloud|local` × `TRIPMAP_STORAGE=blob|s3|fs`，默认 `cloud+s3`
- DB 只存媒体**相对 key**（如 `album/<id>/cover_x.jpg`），URL 由服务端 `mediaUrl()` 按存储后端现场解析——换域名/换存储只改环境变量，无需改库
- 删除语义：删卡片 = 仅删 DB 行（毫秒级返回），媒体成为孤儿由「清理缓存」任务延迟回收（1 小时宽限防误收）；卡片内删单张照片 = 按 key 直删（无回收缓冲）
- 测试：`pnpm test` 共 102 项（契约 22 + 工具 20 + 服务端 11 + 集成 36 + 本地 e2e 13），全部本地运行，不接触云端

## 快速开始（本地开发）

```bash
pnpm install
TRIPMAP_BACKEND=local TRIPMAP_LOCAL_ROOT=<仓库根> node server/app.js
```

访问 `http://localhost:3002`。本地实例直接读写仓库根的 `tripmap.sqlite` 与 `media/`，可随便写、零生产影响；登录密码见 `config.json`（已 gitignore）。

> ⚠️ 不设 `TRIPMAP_BACKEND` 时默认 cloud = **直连生产 Neon + R2**，只允许只读操作。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `CHANGE.md` | 版本更新记录与踩坑沉淀 |
| `AGENT.md` | 开发思路、硬约束与后续方向（供 Agent 后续开发参考） |
| `.agent/`（本机目录，不进 Git） | 交接总纲、凭据状态、回滚映射 |

## 沿革（一句话）

初代为本地 SQLite 单机版（`master` 分支，已冻结留档）；2026-09 经适配层改造合并为单代码库（`vercel` 分支，唯一开发分支），媒体存储由 Vercel Blob 迁至 Cloudflare R2，2026-09-23 完成性能与删除语义重构。详见 `CHANGE.md`。
