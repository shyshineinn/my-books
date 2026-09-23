#!/usr/bin/env node
/* ============================================================
 * 安全备份 SQLite 数据库(正确处理 WAL)
 *
 * 为什么不能直接 cp 主库文件:
 *   src/db/index.js 设了 PRAGMA journal_mode = WAL。WAL 模式下,已提交的
 *   事务可能只存在于 -wal 文件里,主库文件只在检查点时才更新。
 *   单独拷贝主库文件 → 得到一个"看着能打开、实际缺数据"的备份,而且
 *   PRAGMA integrity_check 仍会通过 —— 校验抓不出这种残缺。
 *
 * VACUUM INTO 会读取包含 WAL 的完整内容,产出自包含的单文件快照
 * (无需 -wal/-shm 伴随文件即可独立打开)。
 *
 * 用法:
 *   node deploy/backup-db.js <源库路径> <目标文件路径>
 * 退出码:
 *   0 = 备份成功,且与源库的关键表行数一致
 *   1 = 失败(源库不存在 / 备份打不开 / 行数不一致),stderr 给出原因
 * ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node deploy/backup-db.js <源库路径> <目标文件路径>');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error(`    源库不存在: ${src}`);
  process.exit(1);
}

// VACUUM INTO 要求目标文件不存在;顺带清掉上次失败留下的伴随文件
for (const p of [dst, `${dst}-wal`, `${dst}-shm`]) {
  try { fs.rmSync(p, { force: true }); } catch { /* 不存在即可 */ }
}
fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });

// SQL 字符串字面量转义(路径里可能有单引号,虽然 Windows/Linux 路径一般没有)
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// 用 book 表行数作为一致性基准:它是这个库的核心数据
function booksCount(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  } catch {
    return null; // 表不存在(全新空库)—— 返回 null 表示"无从比较"
  }
}

let srcDb = null;
let dstDb = null;
try {
  // 用可写连接打开:WAL 库在缺少 -shm 时无法以只读方式打开(例如应用已停止时),
  // 可写连接能自行创建 -shm。VACUUM INTO 本身只读取,不会改动源库数据。
  srcDb = new DatabaseSync(src);
  srcDb.exec(`VACUUM INTO ${quote(dst)}`);

  const srcCount = booksCount(srcDb);
  srcDb.close();
  srcDb = null;

  // 验证:备份必须能独立打开,且行数与源库一致
  dstDb = new DatabaseSync(dst, { readOnly: true });
  const integrity = dstDb.prepare('PRAGMA integrity_check').get().integrity_check;
  const dstCount = booksCount(dstDb);
  dstDb.close();
  dstDb = null;

  if (integrity !== 'ok') {
    console.error(`    备份完整性异常: ${integrity}`);
    process.exit(1);
  }

  // 行数比对 —— 这才是能抓住"WAL 内容没进备份"的检查,
  // 单靠 integrity_check 抓不出来(残缺的备份依然是完整可读的库)
  if (srcCount !== null && dstCount !== null && srcCount !== dstCount) {
    console.error(`    行数不一致:源库 ${srcCount} 行,备份 ${dstCount} 行 —— 备份不完整,已丢弃`);
    try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    process.exit(1);
  }

  const sizeKb = (fs.statSync(dst).size / 1024).toFixed(1);
  const rows = dstCount === null ? '无 books 表' : `${dstCount} 行`;
  console.log(`    已备份到 ${dst}(${rows},${sizeKb} KB,含 WAL 内容)`);
  process.exit(0);
} catch (err) {
  try { srcDb?.close(); } catch { /* ignore */ }
  try { dstDb?.close(); } catch { /* ignore */ }
  console.error(`    备份失败:${err.message}`);
  process.exit(1);
}
