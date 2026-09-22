#!/usr/bin/env node
/* ============================================================
 * 数据自检脚本(借鉴 calibre library/check_library.py 的完整性对照思想)
 *
 * 用途:检查 books.db 的数据健康度——
 *   1. SQLite 库完整性(integrity_check)
 *   2. JSON 字段可解析(tags / read_logs)
 *   3. 日期字段格式合法(YYYY-MM-DD,允许空)
 *   4. 逻辑一致性(读完日期 ≥ 开始日期;read_logs 与 read_count 关系)
 *
 * 用法(服务器或本地):
 *   node data-check.js            # 检查默认 data/books.db
 *   node data-check.js 某备份.db  # 检查指定库文件(如 data/backup/ 里的备份)
 *
 * 退出码:0 = 全部通过;1 = 发现问题(每个问题一行 [问题] 前缀输出)
 * ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2] || path.join(__dirname, 'data', 'books.db');
if (!fs.existsSync(target)) {
  console.error(`[错误] 数据库文件不存在: ${target}`);
  process.exit(1);
}

const db = new DatabaseSync(target, { readOnly: true });
const problems = [];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function problem(msg) { problems.push(msg); }

// 1. 库完整性
const integrity = db.prepare('PRAGMA integrity_check').get();
if (integrity.integrity_check !== 'ok') {
  problem(`SQLite 完整性异常: ${integrity.integrity_check}`);
} else {
  console.log('✓ SQLite 完整性检查通过');
}

// 2/3/4. 行级检查
const rows = db.prepare('SELECT id, title, status, tags, read_logs, read_count, start_date, finish_date FROM books').all();
for (const r of rows) {
  const tag = `《${r.title}》(id=${r.id})`;

  // JSON 字段
  let tags = null;
  try { tags = JSON.parse(r.tags ?? '[]'); } catch { problem(`${tag} tags 不是合法 JSON: ${JSON.stringify(r.tags)}`); }
  if (tags !== null && !Array.isArray(tags)) problem(`${tag} tags 应为数组`);

  let logs = null;
  try { logs = JSON.parse(r.read_logs ?? '[]'); } catch { problem(`${tag} read_logs 不是合法 JSON`); }
  if (logs !== null && !Array.isArray(logs)) problem(`${tag} read_logs 应为数组`);

  // 日期格式(允许空)
  for (const [f, v] of [['start_date', r.start_date], ['finish_date', r.finish_date]]) {
    if (v && !DATE_RE.test(v)) problem(`${tag} ${f} 格式非法: "${v}"`);
  }

  // 逻辑一致性(基于 read_logs 的记录才算数)
  if (Array.isArray(logs)) {
    for (const [i, l] of logs.entries()) {
      if (l.start && !DATE_RE.test(l.start)) problem(`${tag} 第${i + 1}条记录 start 非法: "${l.start}"`);
      if (l.finish && !DATE_RE.test(l.finish)) problem(`${tag} 第${i + 1}条记录 finish 非法: "${l.finish}"`);
      if (l.start && l.finish && l.finish < l.start) problem(`${tag} 第${i + 1}条记录 finish 早于 start`);
    }
    const finished = logs.filter((l) => l.finish).length;
    if (finished > 0 && finished !== r.read_count) {
      problem(`${tag} read_count=${r.read_count} 与记录中已读完条数 ${finished} 不一致`);
    }
    const maxFinish = logs.reduce((m, l) => (l.finish && l.finish > m ? l.finish : m), '');
    if (maxFinish && r.finish_date && r.finish_date !== maxFinish) {
      problem(`${tag} finish_date=${r.finish_date} 与记录最晚读完日 ${maxFinish} 不一致`);
    }
  }

  // 状态枚举
  if (!['wish', 'reading', 'done'].includes(r.status)) problem(`${tag} status 非法: "${r.status}"`);
}

db.close();

console.log(`检查完成: ${rows.length} 本书,发现 ${problems.length} 个问题`);
for (const p of problems) console.log(`  [问题] ${p}`);
process.exit(problems.length ? 1 : 0);
