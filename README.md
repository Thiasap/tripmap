# 旅行地图

本项目是本地单用户使用的 Node.js Web 旅行地图，用 SQLite 保存旅行卡片数据，上传文件统一存储在 `media/` 目录。

## 目录结构

```text
media/
  richtext_images/
  album/
  attachments/
public/
  index.html
  main.js
  style.css
  china_provinces.geojson
server/
  app.js
  db.js
  routes.js
package.json
README.md
```

## 安装与启动

```bash
npm install
npm start
```

启动后访问：

```text
http://localhost:3002
```

## 数据与文件

- SQLite 数据库文件：`tripmap.sqlite`
- 富文本图片：`media/richtext_images/<cardID>/`
- 相册与封面：`media/album/<cardID>/`
- 附件：`media/attachments/<cardID>/`
- 封面文件命名：`cover_<cardID>.jpg`
- 相册缩略图命名：`thumb_<原文件名>.jpg`

## 功能

- 中国地图展示、缩放和拖动。
- 省份颜色按省份信息稳定生成。
- 添加旅行卡片，保存名称、地址、经纬度、日期、人员、富文本、相册、附件和封面。
- 地图图钉通过连线连接浮动卡片；图钉点击不显示信息。
- 卡片可拖动，位置保存到数据库。
- 卡片详情支持编辑、保存和删除。

## 说明

- 服务端口固定为 3002。
- 面向本地单用户使用，未实现登录和权限控制。
- 图片上传不支持拖拽。
- 暂不做响应式设计。
