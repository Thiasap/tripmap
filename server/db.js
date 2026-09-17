/**
 * 数据库入口：转调适配层，按 `TRIPMAP_BACKEND` 选择后端实现。
 *
 * 调用点（server/routes.js、api/index.js）继续只依赖 `{ sql, initDB }`，无需改动；
 * 换后端只改环境变量，见 server/adapters/database.js 的契约说明。
 */
const { createDatabase } = require('./adapters/database');

module.exports = createDatabase();
