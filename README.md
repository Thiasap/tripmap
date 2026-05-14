# 旅行地图

本地单用户旅行记录 Web 应用。基于中国地图，以浮动卡片形式展示旅行记录，支持富文本编辑、相册管理、人员标签等功能。

## 技术栈

- **后端**：Node.js + Express
- **数据库**：SQLite（node:sqlite）
- **地图**：D3.js + GeoJSON
- **富文本**：Quill
- **图片处理**：Sharp
- **图片预览**：GLightbox

## 目录结构

```
media/                    # 上传文件（gitignore）
  album/<tripId>/         # 封面与相册
  attachments/<tripId>/   # 附件
  richtext_images/<tripId>/ # 富文本图片
public/
  index.html              # 主页面
  main.js                 # 主页面逻辑
  settings.html           # 设置页面
  settings.js             # 设置页面逻辑
  style.css               # 样式
  china_provinces.geojson # 中国地图数据
server/
  app.js                  # Express 入口
  db.js                   # 数据库初始化
  routes.js               # API 路由
regions_L1_L2.json        # 省市数据
package.json
```

## 安装与启动

```bash
npm install
npm start
```

访问 `http://localhost:3002`，设置页 `http://localhost:3002/settings.html`。

## 功能

### 地图与卡片
- 中国地图展示，省份按编码稳定着色
- 滚轮缩放、拖动平移地图
- 旅行卡片浮动于地图上方，图钉通过连线连接卡片
- 卡片可独立拖动，位置自动保存
- 卡片封面支持横竖版自适应宽高比

### 旅行编辑
- 添加 / 编辑 / 删除旅行记录
- 省份从 `regions_L1_L2.json` 下拉选择，城市根据省份自动筛选
- 经纬度支持手动输入或从地图点选
- Quill 富文本编辑器，支持插图
- 封面上传与预览
- 相册批量上传（自动生成缩略图）、附件上传
- 编辑模式下可删除已有相册照片和附件
- 新建时支持预上传文件，带删除按钮

### 人员标签
- Bilibili 风格标签选择器：输入框 + 下拉列表 + 已选标签
- 下拉按参与次数降序，实时模糊搜索
- 回车匹配库中人员或新增，点击标签移除
- Mock 数据：首次使用自动生成 10 个随机中文姓名
- 设置页人员管理：搜索、分页（5/10/15）、添加、删除

### 设置页
- 卡片最大宽度、标题字体、小字体、缩放比例可调
- 媒体缓存清理（移动至 `media_recycle/` 时间戳目录）

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/trips` | 获取所有旅行 |
| POST | `/api/trips` | 创建旅行 |
| PUT | `/api/trips/:id` | 更新旅行 |
| DELETE | `/api/trips/:id` | 删除旅行及媒体文件 |
| GET | `/api/trips/:id/files` | 获取旅行的相册/附件列表 |
| POST | `/api/trips/:id/files` | 追加相册/附件 |
| DELETE | `/api/trips/:id/files?type=&name=` | 删除单个相册/附件 |
| GET | `/api/regions` | 获取省市数据 |
| GET | `/api/settings` | 获取设置 |
| PUT | `/api/settings` | 更新设置 |
| POST | `/api/cleanup-media` | 清理孤立媒体文件 |
| GET | `/api/participants` | 获取人员列表 |
| POST | `/api/participants` | 添加人员 |
| PUT | `/api/participants/:id` | 更新人员 |
| DELETE | `/api/participants/:id` | 删除人员 |
| POST | `/api/participants/batch` | 批量记录参与（已存在+1次，新人员插入） |
| POST | `/api/uploads/richtext` | 上传富文本图片 |

## 数据库

三张表：

- **trips** — 旅行记录，含名称、地址、经纬度、日期、媒体路径、卡片位置等
- **settings** — 键值对配置（`card_max_width`、`card_title_font_size`、`card_meta_font_size`、`card_scale`）
- **participants** — 人员，含姓名、最近参与时间、参与次数

## 说明

- 服务端口固定 3002
- 本地单用户使用，无登录和权限控制
- 媒体文件可通过设置页清理，移动至 `media_recycle/` 而非直接删除
- 省市数据来源 [regions-data](https://github.com/slightlee/regions-data)
