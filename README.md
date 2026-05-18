# 旅行地图

本地单用户旅行记录 Web 应用。基于中国地图，以浮动卡片形式展示旅行记录，支持富文本编辑、相册管理、人员标签、地图导出、游客/管理员鉴权等功能。

本项目由AI生成（GPT-5.5 +DeepseekV4Pro）

## 技术栈

| 层级     | 技术                                       |
| -------- | ------------------------------------------ |
| 后端     | Node.js + Express                          |
| 数据库   | SQLite（node:sqlite，WAL 模式）            |
| 地图     | D3.js + GeoJSON（`d3.geoIdentity` 投影） |
| 富文本   | Quill 2.x                                  |
| 图片处理 | Sharp（旋转校正、缩略图、压缩）            |
| 图片预览 | GLightbox                                  |
| 导出     | html2canvas                                |
| 安全     | express-session + helmet + sanitize-html   |

## 目录结构

```
media/                       # 上传文件（gitignore）
  album/<tripId>/             # 封面与相册
  attachments/<tripId>/       # 附件
  richtext_images/<tripId>/   # 富文本图片
public/
  index.html                  # 主页面
  login.html                  # 管理员登录页
  settings.html               # 设置页面
  main.js                     # 主页面逻辑
  settings.js                 # 设置页面逻辑
  style.css                   # 样式
  china_provinces.geojson     # 中国地图 GeoJSON 数据
server/
  app.js                      # Express 入口（中间件、鉴权、错误处理）
  db.js                       # 数据库初始化（含参数化查询封装）
  routes.js                   # API 路由（CRUD、文件上传、安全校验）
config.json                   # 本地配置文件（gitignore，含密码和 Session 密钥）
regions_L1_L2.json            # 省市数据
package.json
```

## 安装与启动

```bash
pnpm install
node server/app.js
```

访问 `http://localhost:3002`，设置页 `http://localhost:3002/settings.html`。

## 配置

项目根目录下 `config.json`（首次运行自动创建默认值）：

```json
{
  "ADMIN_PASSWORD": "admin",
  "SESSION_SECRET": "<随机字符串>"
}
```

修改密码后重启服务生效。环境变量 `ADMIN_PASSWORD` / `SESSION_SECRET` 优先级更高。

## 鉴权

| 角色                      | 权限                                                    |
| ------------------------- | ------------------------------------------------------- |
| **guest**（游客）   | 浏览地图、查看卡片、缩放/拖拽卡片（仅本地缓存，不写库） |
| **admin**（管理员） | 全部权限：增删改旅行、上传文件、修改设置、管理人员      |

- 游客访问设置页自动重定向到登录页
- 游客模式下首页隐藏"添加"按钮、详情页隐藏"编辑"/"删除"按钮
- 后端所有写 API 默认要求 `requireAdmin`，未登录返回 401
- Session 基于 `express-session` + httpOnly Cookie + `sameSite: lax`
- 登录时重新生成 Session ID（防 Session Fixation），登出时服务端销毁 Session

## 功能

### 地图与卡片

- 中国地图展示，省份按行政区划编码稳定着色
- 滚轮缩放、拖动平移地图
- 卡片浮动于地图上方，图钉与卡片间连线
- 卡片可独立拖拽，位置以地理坐标（经纬度）持久化，跨分辨率/跨窗口大小一致
- 卡片大小随视口等比缩放（`transform: scale`），图片、文字、圆角同步缩放
- 卡片封面支持横竖版自适应宽高比
- 首页顶部"卡片缩放"滑块实时调节卡片整体大小

### 旅行编辑

- 添加 / 编辑 / 删除旅行记录
- 省份、城市使用 `<datalist>` 下拉建议（来自 `regions_L1_L2.json`），同时支持手动输入
- 经纬度支持手动输入、地图点选（点击地图反算地理坐标）、以及逗号分隔字符串自动识别经纬
- Quill 富文本编辑器，支持插图、标题、列表、链接
- 后端对富文本内容进行 `sanitize-html` 净化，移除 `<script>` 等危险标签
- 封面上传与预览（自动生成缩略图）
- 相册批量上传（自动生成缩略图）、附件上传
- 编辑模式下删除照片/附件：标记待删除，保存时执行，关闭则撤销
- 新建时支持预上传文件，带删除按钮

### 人员标签

- Bilibili 风格标签选择器：输入框 + 下拉列表 + 已选标签
- 下拉按参与次数降序，实时模糊搜索
- 回车匹配库中人员或新增，点击标签移除
- 首次使用自动生成 10 个随机中文姓名（Mock 数据）
- 保存旅行时自动调用 `POST /api/participants/batch` 批量记录参与（已存在 +1 次，新人员插入）
- 设置页人员管理：搜索、分页（5/10/15）、添加、删除

### 设置页

| 设置项       | 范围                  | 默认值 | 说明                                             |
| ------------ | --------------------- | ------ | ------------------------------------------------ |
| 卡片最大宽度 | 0–800 px             | 360    | 卡片像素宽度上限                                 |
| 卡片标题字体 | 0–40 px              | 16     | 卡片标题字号                                     |
| 卡片小字体   | 0–32 px              | 13     | 日期等元信息字号                                 |
| 地图拉伸     | 0.5–2                | 1      | 地图 Y 轴拉伸系数，值越大地图越高                |
| 图钉大小     | 2–30 px              | 7      | 地图上图钉的半径                                 |
| 默认缩放     | 0.3–5                | 1      | 打开页面时的初始地图缩放级别                     |
| 卡片缩放     | 10%–100%（首页滑块） | 100%   | 卡片等比缩放，游客模式本地缓存                   |
| 清理缓存     | —                    | —     | 移动孤立媒体文件至 `media_recycle/` 时间戳目录 |
| 人员管理     | —                    | —     | 搜索、分页、增删参与人员                         |

### 导出

- 首页顶栏"导出"按钮，支持 PNG / JPEG 格式
- 像素密度可选 1x–4x，2x 推荐（文字清晰）
- 基于 html2canvas 截取整个地图区域（含地图、图钉、连线、卡片）

### 游客本地缓存

游客模式下卡片拖拽位置和缩放比例自动缓存到 `localStorage`，刷新页面后恢复。首页"重置"按钮（仅游客可见）可清空本地缓存。

## API

| 方法   | 路径                                 | 鉴权  | 说明                            |
| ------ | ------------------------------------ | ----- | ------------------------------- |
| GET    | `/api/trips`                       | —    | 获取所有旅行                    |
| POST   | `/api/trips`                       | admin | 创建旅行（含文件上传）          |
| PUT    | `/api/trips/:id`                   | admin | 更新旅行（部分字段可选）        |
| DELETE | `/api/trips/:id`                   | admin | 删除旅行及关联媒体文件          |
| GET    | `/api/trips/:id/files`             | —    | 获取旅行的相册/附件列表         |
| POST   | `/api/trips/:id/files`             | admin | 追加相册/附件                   |
| DELETE | `/api/trips/:id/files?type=&name=` | admin | 删除单个相册/附件               |
| GET    | `/api/regions`                     | —    | 获取省市数据                    |
| GET    | `/api/settings`                    | —    | 获取所有设置项                  |
| PUT    | `/api/settings`                    | admin | 更新设置（参数校验 + 范围钳制） |
| POST   | `/api/cleanup-media`               | admin | 清理孤立媒体文件                |
| GET    | `/api/participants`                | —    | 获取人员列表                    |
| POST   | `/api/participants`                | admin | 添加人员                        |
| PUT    | `/api/participants/:id`            | admin | 更新人员                        |
| DELETE | `/api/participants/:id`            | admin | 删除人员                        |
| POST   | `/api/participants/batch`          | admin | 批量记录参与（UPSERT）          |
| POST   | `/api/uploads/richtext`            | admin | 上传富文本图片                  |
| POST   | `/api/login`                       | —    | 管理员登录                      |
| POST   | `/api/logout`                      | —    | 登出（销毁 Session）            |
| GET    | `/api/auth/status`                 | —    | 获取当前鉴权角色                |

## 数据库

三张表，使用 WAL 模式：

**trips** — 旅行记录

| 字段             | 类型    | 说明                                 |
| ---------------- | ------- | ------------------------------------ |
| id               | TEXT PK | 基于省市哈希 + 随机字符生成          |
| name             | TEXT    | 旅行名称                             |
| province         | TEXT    | 省份                                 |
| city             | TEXT    | 城市                                 |
| address_detail   | TEXT    | 详细地址                             |
| latitude         | REAL    | 纬度（4 位小数）                     |
| longitude        | REAL    | 经度（4 位小数）                     |
| start_date       | TEXT    | 开始日期                             |
| end_date         | TEXT    | 结束日期                             |
| participants     | TEXT    | 参与人员（逗号分隔）                 |
| rich_text_path   | TEXT    | 富文本 HTML（经 sanitize-html 净化） |
| album_path       | TEXT    | 相册目录路径                         |
| attachments_path | TEXT    | 附件目录路径                         |
| cover_path       | TEXT    | 封面图片路径                         |
| cover_meta       | TEXT    | 封面宽高 JSON                        |
| card_position_x  | REAL    | 卡片地理经度（跨分辨率一致）         |
| card_position_y  | REAL    | 卡片地理纬度                         |
| created_at       | TEXT    | 创建时间 ISO                         |
| updated_at       | TEXT    | 更新时间 ISO                         |

**settings** — 键值对配置

| 字段  | 类型    | 说明   |
| ----- | ------- | ------ |
| key   | TEXT PK | 配置键 |
| value | TEXT    | 配置值 |

**participants** — 人员

| 字段                 | 类型        | 说明                  |
| -------------------- | ----------- | --------------------- |
| id                   | INTEGER PK  | 自增                  |
| name                 | TEXT UNIQUE | 姓名                  |
| last_participated_at | TEXT        | 最近参与时间 ISO      |
| count                | INTEGER     | 参与次数（default 0） |

## 安全措施

- 所有 SQL 使用参数化查询（`@name` → `$name` 转换），无字符串拼接
- 所有写 API 需 admin 登录（`requireAdmin` 中间件）
- 用户输入（卡片名称、人员姓名等）前端 `escapeHtml()` 转义
- 富文本后端 `sanitize-html` 净化，移除 script/onerror 等
- 文件上传：扩展名白名单（`.jpg/.png/.webp/.gif/.pdf/.mp4/.mov/.txt`）+ MIME 校验
- 文件名 `safeName()` 过滤路径穿越字符
- Multer 限制：`fileSize: 200MB`，`fieldSize: 100KB`
- Helmet 安全响应头（X-Frame-Options / X-Content-Type-Options / HSTS 等）
- Session：httpOnly + sameSite: lax + 登录重新生成 ID + 登出服务端销毁
- 错误响应统一返回 JSON，不泄露内部细节
- 配置文件 `config.json` 位于 `public/` 外，不可通过 HTTP 访问

## 说明

- 服务端口固定 3002
- 本地单用户使用
- 媒体文件清理移至 `media_recycle/` 时间戳目录，不直接删除
- 省市数据来源 [regions-data](https://github.com/slightlee/regions-data)
- 使用 pnpm 管理依赖，`pnpm install` 安装
