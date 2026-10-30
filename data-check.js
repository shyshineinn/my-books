#!/usr/bin/env node
/* ============================================================
 * 数据自检脚本(借鉴 calibre library/check_library.py 的完整性对照思想)
 *
 * 用途:检查 books.db 的数据健康度——
 *   1. SQLite 库完整性(integrity_check)
 *   2. JSON 字段可解析(tags / read_logs)
 *   3. 日期字段格式合法(YYYY-MM-DD,允许空)
 *   4. 逻辑一致性(读完日期 ≥ 开始日期;read_logs 与 read_count 关系)
 *   5. v12 起新增:uuid / title_sort 是否回填、series_index 合法性、
 *      标识符孤儿行与"同类型同值"冲突、自定义字段孤儿值
 *
 * 用法(服务器或本地):
 *   node data-check.js            # 检查默认 data/books.db
 *   node data-check.js 某备份.db  # 检查指定库文件(如 data/backup/ 里的备份)
 *   node data-check.js --sha      # 额外重算电子书 SHA(慢)
 *
 * 退出码:0 = 全部通过;1 = 发现问题(每个问题一行 [问题] 前缀输出)
 * ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, 'data', 'books.db');
const checkSha = args.includes('--sha');
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
// deleted_at 是 v13 新增列;检查脚本要能吃旧备份,旧库用空串占位
const hasDeletedAt = db.prepare('PRAGMA table_info(books)').all().some((c) => c.name === 'deleted_at');
const rows = db.prepare(`
  SELECT id, title, status, tags, read_logs, read_count, start_date, finish_date,
         ${hasDeletedAt ? 'deleted_at' : "'' AS deleted_at"}
  FROM books
`).all();
for (const r of rows) {
  const tag = `《${r.title}》(id=${r.id}${r.deleted_at ? ',回收站' : ''})`;

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

  // 回收站墓碑:空 = 在架;否则必须是可解析的时间串
  if (r.deleted_at && !Number.isFinite(Date.parse(r.deleted_at))) {
    problem(`${tag} deleted_at 格式非法: "${r.deleted_at}"`);
  }
}

/* ---------- 5. v12 数据模型检查(表不存在则整段跳过,兼容旧备份) ---------- */

// 某张表是否存在(旧备份里没有 v11/v12 的表,检查脚本要能吃旧库)
function hasTable(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function hasColumn(table, col) {
  if (!hasTable(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// 5.1 uuid 与 title_sort 回填情况(v12 迁移应逐行补齐)
if (hasColumn('books', 'uuid')) {
  const emptyUuid = db.prepare("SELECT COUNT(*) n FROM books WHERE uuid = ''").get().n;
  if (emptyUuid) problem(`${emptyUuid} 本书缺少 uuid(v12 迁移应已回填;删掉该列或重跑迁移可修)`);
  else console.log('✓ uuid 已全部回填');

  const dupUuid = db.prepare("SELECT uuid, COUNT(*) n FROM books WHERE uuid <> '' GROUP BY uuid HAVING n > 1").all();
  if (dupUuid.length) problem(`uuid 重复:${JSON.stringify(dupUuid)}`);

  // 格式抽查:非标准 UUID 说明是手工写入的
  const badFmt = db.prepare("SELECT id, uuid FROM books WHERE uuid <> ''").all()
    .filter((r) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.uuid));
  if (badFmt.length) problem(`uuid 格式异常 ${badFmt.length} 行,例:${JSON.stringify(badFmt[0])}`);
}

if (hasColumn('books', 'title_sort')) {
  const emptyTs = db.prepare("SELECT COUNT(*) n FROM books WHERE title_sort = '' AND title <> ''").get().n;
  if (emptyTs) problem(`${emptyTs} 本书 title_sort 为空(排序会退化到 title)`);
  else console.log('✓ title_sort 已全部回填');
}

// 5.2 series_index 合法性:0 表示未指定;负数是脏数据
if (hasColumn('books', 'series_index')) {
  const badIdx = db.prepare('SELECT id, title, series, series_index FROM books WHERE series_index < 0').all();
  for (const r of badIdx) problem(`《${r.title}》series_index 为负:${r.series_index}`);
  const orphanIdx = db.prepare("SELECT COUNT(*) n FROM books WHERE series = '' AND series_index <> 0").get().n;
  if (orphanIdx) problem(`${orphanIdx} 本书没有系列却有序号(序号应归 0)`);
}

// 5.3 标识符:孤儿行 + 同类型同值冲突
if (hasTable('book_identifiers')) {
  const orphans = db.prepare('SELECT COUNT(*) n FROM book_identifiers WHERE book NOT IN (SELECT id FROM books)').get().n;
  if (orphans) problem(`book_identifiers 有 ${orphans} 行孤儿(指向不存在的书)`);

  const emptyVal = db.prepare("SELECT COUNT(*) n FROM book_identifiers WHERE value = ''").get().n;
  if (emptyVal) problem(`book_identifiers 有 ${emptyVal} 行空值(应删行而不是留空)`);

  // 同类型同值被多本占用:不一定是错(如合订本共用 ISBN),但值得人看一眼
  const conflicts = db.prepare(`
    SELECT type, value, COUNT(*) n FROM book_identifiers WHERE value <> ''
    GROUP BY type, value COLLATE NOCASE HAVING n > 1
  `).all();
  if (conflicts.length) {
    // 用"提示"而非"问题":不改变退出码,避免正常数据被判失败
    console.log(`  [提示] ${conflicts.length} 组标识符被多本书共用(可能是合订本/再版):`);
    for (const c of conflicts.slice(0, 5)) console.log(`         ${c.type}:${c.value} × ${c.n}`);
  } else {
    console.log('✓ 标识符无孤儿、无空值、无重复');
  }
}

// 5.4 自定义字段:孤儿值 + 枚举选项完整性
if (hasTable('book_custom_values')) {
  const orphanCv = db.prepare('SELECT COUNT(*) n FROM book_custom_values WHERE column_id NOT IN (SELECT id FROM custom_columns)').get().n;
  if (orphanCv) problem(`book_custom_values 有 ${orphanCv} 行孤儿(指向已删字段)`);
  const emptyCv = db.prepare("SELECT COUNT(*) n FROM book_custom_values WHERE value = ''").get().n;
  if (emptyCv) problem(`book_custom_values 有 ${emptyCv} 行空值(约定应为不留行)`);
}

if (hasTable('custom_columns')) {
  const DATATYPES = ['text', 'comments', 'int', 'float', 'bool', 'date', 'rating', 'enumeration', 'series'];
  for (const c of db.prepare('SELECT * FROM custom_columns').all()) {
    if (!DATATYPES.includes(c.datatype)) problem(`自定义字段 ${c.label} 类型非法:${c.datatype}`);
    if (c.datatype === 'enumeration') {
      let opts = [];
      try { opts = JSON.parse(c.options || '[]'); } catch { opts = null; }
      if (!Array.isArray(opts)) problem(`自定义字段 ${c.label} 的 options 不是合法 JSON 数组`);
      else if (!opts.length) problem(`自定义字段 ${c.label} 是枚举类型但没有可选值`);
    }
    if (c.is_multiple && c.datatype !== 'text') {
      problem(`自定义字段 ${c.label} 声明了多值但类型是 ${c.datatype}(只有 text 允许多值)`);
    }
  }
  // 多值字段的存储值应是 JSON 数组
  const multiCols = db.prepare("SELECT id, label FROM custom_columns WHERE is_multiple = 1").all();
  for (const col of multiCols) {
    const vals = db.prepare('SELECT book, value FROM book_custom_values WHERE column_id = ? AND value <> ?').all(col.id, '');
    for (const v of vals) {
      try {
        if (!Array.isArray(JSON.parse(v.value))) problem(`字段 ${col.label} 的书 ${v.book} 多值存储不是数组`);
      } catch { problem(`字段 ${col.label} 的书 ${v.book} 多值存储不是合法 JSON`); }
    }
  }
  console.log('✓ 自定义字段定义与取值检查完成');
}

// 5.5 电子书文件与 book_files 登记是否一致(仅在能推断存储根时执行)
if (hasTable('book_files')) {
  const before = problems.length;
  const resolvedTarget = path.resolve(target);
  const storageRoot = process.env.MYBOOKS_STORAGE_DIR
    ? path.resolve(process.env.MYBOOKS_STORAGE_DIR)
    : (path.basename(path.dirname(resolvedTarget)) === 'data'
      ? path.dirname(path.dirname(resolvedTarget))
      : null);
  const filesDir = storageRoot ? path.join(storageRoot, 'books-files') : null;
  const fileRows = db.prepare('SELECT book, path, size, sha256 FROM book_files').all();

  if (!filesDir) {
    console.log('· 未识别存储根,跳过电子书文件检查(可用 MYBOOKS_STORAGE_DIR 指定)');
  } else if (!fs.existsSync(filesDir)) {
    if (fileRows.length) problem(`电子书目录不存在:${filesDir}(${fileRows.length} 条登记找不到文件)`);
  } else {
    const registered = new Set();
    const rootWithSep = filesDir.endsWith(path.sep) ? filesDir : filesDir + path.sep;
    for (const row of fileRows) {
      const rel = String(row.path || '').trim();
      const full = path.resolve(filesDir, rel);
      if (!rel || path.isAbsolute(rel) || !(full === filesDir || full.startsWith(rootWithSep))) {
        problem(`book_files 路径非法:书 ${row.book} → ${rel || '(空)'}`);
        continue;
      }
      let stat;
      try { stat = fs.statSync(full); } catch { stat = null; }
      if (!stat || !stat.isFile()) {
        problem(`登记了但磁盘不存在:书 ${row.book} → ${rel}`);
        continue;
      }
      if (Number(row.size) !== stat.size) {
        problem(`文件大小与登记不一致:书 ${row.book} → ${rel}(登记 ${row.size},实际 ${stat.size})`);
      }
      if (checkSha && row.sha256) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        if (digest !== row.sha256) problem(`文件 SHA 与登记不一致:书 ${row.book} → ${rel}`);
      }
      registered.add(path.relative(filesDir, full).split(path.sep).join('/'));
    }

    const stray = [];
    const temps = [];
    for (const entry of fs.readdirSync(filesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('uploading-')) { temps.push(entry.name); continue; }
      if (!registered.has(entry.name)) stray.push(entry.name);
    }
    if (temps.length) problem(`电子书目录有 ${temps.length} 个残留临时上传文件:${temps.slice(0, 5).join(', ')}`);
    if (stray.length) problem(`电子书目录有 ${stray.length} 个未登记文件:${stray.slice(0, 5).join(', ')}`);
    if (problems.length === before) {
      const shaText = checkSha ? '(含 SHA)' : '(未校验 SHA,可加 --sha)';
      console.log(`✓ 电子书文件登记与磁盘一致(${fileRows.length} 个)${shaText}`);
    }
  }
}

db.close();

const trashCount = rows.filter((r) => r.deleted_at).length;
console.log(`检查完成: ${rows.length} 本书(其中回收站 ${trashCount} 本),发现 ${problems.length} 个问题`);
for (const p of problems) console.log(`  [问题] ${p}`);
process.exit(problems.length ? 1 : 0);
