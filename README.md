# 旅行地图（Tripmap）

本地单用户旅行记录 Web 应用：基于中国地图，以浮动卡片展示旅行记录，支持富文本编辑、相册管理、
人员标签、地图导出、游客/管理员鉴权。由 AI Agent 全程迭代维护。

## 当前版本

**单代码库 · 双后端**：一份代码同时支撑云上生产与本地开发。

| 组件 | 生产（默认） | 本地 |
| --- | --- | --- |
| 运行 | Vercel 函数（`api/index.js`，`vercel.json` 全量重写） | `node server/app.js` |
| 数据库 | Neon PostgreSQL | SQLite（`node:sqlite`，WAL） |
| 媒体 | Cloudflare R2（S3 兼容，自定义域名直读） | 本地 `media/` 目录 |
| 鉴权 | JWT Cookie（无状态） | 同实现 |

- 线上地址：`https://tripmap.thiasap.cn`（**手动别名**——部署后必须 `vercel alias set`）
- 模式开关：`TRIPMAP_BACKEND=cloud|local` × `TRIPMAP_STORAGE=blob|s3|fs`，默认 `cloud+s3`
- DB 只存媒体**相对 key**（如 `album/<id>/cover_x.jpg`），URL 由服务端 `mediaUrl()` 现场解析
- 删除语义：删卡片 = 仅删 DB 行（毫秒级返回），媒体成孤儿由「清理缓存」延迟回收；
  卡片内删单张照片 = 按 key 直删
- 安全：登录凭据缺失即**禁止登录**；上传经后端**魔数校验**后才写入存储，Content-Type 由服务端决定；
  静态页由 `vercel.json` 提供 CSP 等安全响应头
- 测试：`pnpm test` 共 **109 项**，全部本地运行，不接触云端

## 快速开始（本地开发）

```bash
pnpm install
TRIPMAP_BACKEND=local TRIPMAP_LOCAL_ROOT=<仓库根> node server/app.js
```

访问 `http://localhost:3002`。本地实例直接读写仓库根的 `tripmap.sqlite` 与 `media/`，
可随便写、零生产影响；登录密码见 `config.json`（已 gitignore）。

> ⚠️ 不设 `TRIPMAP_BACKEND` 时默认 cloud = **直连生产 Neon + R2**，只允许只读操作。

## 文档

| 文档 | 内容 |
| --- | --- |
| `AGENT.md` | 硬约束红线、开发工作流、已知边界、后续方向 |
| `CHANGE.md` | 版本沿革 |
| `.agent/`（本机目录，不进 Git） | 交接总纲、架构理由、完整更新记录、踩坑、安全模型、凭据状态 |

> 分工：仓库里的三份 md 面向人类读者，保持干练；**细节与推理统一放在 `.agent/`**。

## 沿革（一句话）

初代为本地 SQLite 单机版（`master` 分支，已冻结留档）；2026-09 经适配层改造合并为单代码库
（`vercel` 分支，唯一开发分支），媒体存储由 Vercel Blob 迁至 Cloudflare R2。
