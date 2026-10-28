/* ============================================================
 * 目录常量(纯函数层:只用 node:path 拼字符串,不碰文件系统)
 *
 * 为什么单独一个文件:电子书目录与封面目录此前分别写死在
 * routes.files.js(FILES_DIR)与 routes.misc.js(UPLOAD_DIR)里。
 * 删书要清理这两类磁盘资产,若从路由文件互相 require 会形成
 * "HTTP 层依赖 HTTP 层"的横向耦合 —— 抽成常量模块后,
 * 两个路由与 routes.books 都只依赖这一处定义。
 * ============================================================ */

const path = require('node:path');

// 项目根(本文件在 src/core/ 下,上溯两级)
const ROOT = path.join(__dirname, '..', '..');
const STORAGE_ROOT = process.env.MYBOOKS_STORAGE_DIR
  ? path.resolve(process.env.MYBOOKS_STORAGE_DIR) : ROOT;

module.exports = {
  ROOT,
  STORAGE_ROOT,
  DATA_DIR: path.join(STORAGE_ROOT, 'data'),
  UPLOAD_DIR: path.join(STORAGE_ROOT, 'uploads'),
  FILES_DIR: path.join(STORAGE_ROOT, 'books-files'),
  NOTES_DIR: path.join(STORAGE_ROOT, 'notes-files'),
};
