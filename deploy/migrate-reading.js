#!/usr/bin/env node
/* ============================================================
 * 迁移工具:把旧 books 表里的「阅读记录」搬到 reading.db
 *
 * 背景:双数据库架构下,calibre 管"书是什么",reading.db 管"我读得怎么样"。
 * 本脚本负责把旧库里已有的阅读记录(status/read_logs/read_count/
 * start_date/finish_date/notes_url)迁到新库,并用 **calibre uuid** 作主键。
 *
 * 匹配策略(按可靠性递减,依次回退):
 *   1) ISBN 精确匹配(最可靠)
 *   2) 书名 + 作者 精确匹配(规范化后:去空白、大小写、全半角)
 *   3) 书名 精确匹配
 * 匹配不上的会列出来,不会静默丢弃 —— 迁数据最怕"以为成功了其实丢了一半"。
 *
 * 用法:
 *   node deploy/migrate-reading.js --dry-run        # 只看匹配结果,不写库
 *   node deploy/migrate-reading.js                  # 执行迁移
 *   node deploy/migrate-reading.js --force          # 覆盖已存在的 reading 行
 *
 * 前置:calibre-server 必须已启动且可访问(CALIBRE_URL,默认
 *       http://127.0.0.1:3003/calibre)
 * ============================================================ */

const path = require('node:path');

const calibre = require('../src/db/calibre');
const readingDb = require('../src/db/reading');
const { deriveFromLogs, readingToJson } = require('../src/core/reading');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

/* 规范化书名/作者用于匹配:去空白、统一小写、全角转半角、
   去掉常见标点差异(《》"" 等),提高命中率。 */
function norm(s) {
  return String(s || '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角→半角
    .replace(/[《》「」""''·—\-_:：,，.。!！?？\s]/g, '')
    .toLowerCase();
}

function openLegacyDb() {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const p = path.join(__dirname, '..', 'data', 'books.db');
  if (!fs.existsSync(p)) {
    console.error(`找不到旧库:${p}`);
    console.error('若已不需要旧数据,可跳过本脚本。');
    process.exit(1);
  }
  // 旧库是 WAL,只读打开即可(读会正确合并 -wal 内容)
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

async function main() {
  console.log(`[迁移] calibre 后端: ${calibre.BASE}`);
  console.log(`[迁移] 模式: ${DRY_RUN ? 'dry-run(不写库)' : FORCE ? '执行(覆盖已存在)' : '执行(跳过已存在)'}`);

  // 1) 拉 calibre 全部书(建索引)
  let dict;
  try {
    dict = await calibre.booksByIds('all', {});
  } catch (err) {
    console.error(`[迁移] 无法读取 calibre:${err.message}`);
    console.error('[迁移] 请确认 calibre-server 已启动,且 CALIBRE_URL 正确。');
    process.exit(1);
  }
  const cbooks = calibre.normalizeBooks(dict, 'all');
  console.log(`[迁移] calibre 中共 ${cbooks.length} 本书`);

  // 建索引:key → calibre 书**数组**(不是单本!)
  //
  // 为什么必须是数组:实测真实数据里《三体》有 4 条记录、《活着》有 2 条,
  // 而 calibre 里同一个书名也可能有多本。若索引只存"最后一本",多条旧记录
  // 会全部撞到同一个 uuid —— 后写覆盖先写,静默丢数据。
  // 这里保留全部候选,匹配阶段再按"一对一、不重复占用"分配。
  const byIsbn = new Map();
  const byTitleAuthor = new Map();
  const byTitle = new Map();
  const push = (map, key, b) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(b);
  };
  for (const b of cbooks) {
    if (!b.uuid) continue;
    push(byIsbn, norm(b.isbn), b);
    push(byTitleAuthor, norm(b.title) + '|' + norm(b.author), b);
    push(byTitle, norm(b.title), b);
  }

  // 2) 读旧库
  const legacy = openLegacyDb();
  const rows = legacy.prepare(`
    SELECT id, title, author, status, read_count, read_logs,
           start_date, finish_date, notes_url, isbn
    FROM books
  `).all();
  console.log(`[迁移] 旧库中共 ${rows.length} 本书`);

  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  const conflicts = [];
  // 已被占用的 calibre uuid:保证一对一,避免多条旧记录覆盖同一本
  const claimed = new Set();

  /* 从候选里挑一本:优先未被占用;若全部被占用,视为冲突(需人工决定)。
     返回 { book, how } 或 null。 */
  function pick(candidates, how) {
    if (!candidates || !candidates.length) return null;
    const free = candidates.find((b) => !claimed.has(b.uuid));
    if (free) return { book: free, how };
    return { book: null, how, allTaken: true };
  }

  for (const r of rows) {
    const isbn = norm(r.isbn);
    const ta = norm(r.title) + '|' + norm(r.author);
    const t = norm(r.title);

    // 按可靠性递减:ISBN → 书名+作者 → 书名
    let hit = pick(byIsbn.get(isbn), 'isbn');
    if (!hit) hit = pick(byTitleAuthor.get(ta), 'title+author');
    if (!hit) hit = pick(byTitle.get(t), 'title');

    if (hit && hit.book) {
      claimed.add(hit.book.uuid);
      // 同名多候选时标注歧义,提示人工核对
      const cands = (byTitleAuthor.get(ta) || byTitle.get(t) || []);
      if (cands.length > 1) ambiguous.push({ legacy: r, candidates: cands.length, picked: hit.book });
      matched.push({ legacy: r, calibre: hit.book, how: hit.how });
    } else if (hit && hit.allTaken) {
      // 候选都被别的旧记录占了 —— 典型场景:calibre 里只有 1 本《三体》,
      // 但旧库有 4 条《三体》记录。不能覆盖,必须报出来让人决定。
      conflicts.push({ legacy: r, how: hit.how });
    } else {
      unmatched.push(r);
    }
  }

  // 3) 报告
  const byHow = matched.reduce((m, x) => (m[x.how] = (m[x.how] || 0) + 1, m), {});
  console.log(`[迁移] 匹配成功 ${matched.length} 本 (${Object.entries(byHow).map(([k, v]) => `${k}:${v}`).join(', ') || '无'})`);
  console.log(`[迁移] 未匹配   ${unmatched.length} 本`);
  if (ambiguous.length) {
    console.log(`[迁移] ⚠️  歧义 ${ambiguous.length} 本(calibre 里同名多本,已按顺序各分配一本,请核对):`);
    for (const a of ambiguous.slice(0, 20)) {
      console.log(`         id=${a.legacy.id} 《${a.legacy.title}》有 ${a.candidates} 个候选 → 取 uuid=${a.picked.uuid}`);
    }
  }
  if (conflicts.length) {
    console.log('');
    console.log(`[迁移] ❌ 冲突 ${conflicts.length} 本:calibre 里的候选已被别的记录占用,`);
    console.log('         这些记录的阅读数据**不会**被写入(避免覆盖)。请手工处理:');
    for (const c of conflicts.slice(0, 30)) {
      console.log(`         id=${c.legacy.id} 《${c.legacy.title}》 / ${c.legacy.author || '佚名'}  (命中方式:${c.how})`);
    }
    if (conflicts.length > 30) console.log(`         ... 其余 ${conflicts.length - 30} 本省略`);
    console.log('         处理办法:① 在 calibre 里补上对应的书;② 或删掉旧库里的重复记录;');
    console.log('                   ③ 或迁移后手工在网页上补录。');
    console.log('');
  }
  if (unmatched.length) {
    console.log('[迁移] 未匹配清单(这些书的阅读记录不会被迁移,需手工处理):');
    for (const u of unmatched.slice(0, 50)) {
      console.log(`         id=${u.id} 《${u.title}》 / ${u.author || '佚名'}`);
    }
    if (unmatched.length > 50) console.log(`         ... 其余 ${unmatched.length - 50} 本省略`);
  }

  if (DRY_RUN) {
    console.log('[迁移] dry-run 结束,未写入任何数据。');
    return;
  }

  // 4) 写入
  let written = 0, skipped = 0;
  for (const { legacy: r, calibre: c } of matched) {
    const existing = readingDb.getReading(c.uuid);
    if (existing && !FORCE) { skipped++; continue; }

    let logs = [];
    try { logs = JSON.parse(r.read_logs || '[]'); } catch { logs = []; }
    if (!Array.isArray(logs)) logs = [];

    // 沿用核心规则:有记录时日期与次数由记录推导
    const derived = deriveFromLogs(logs, {
      start: r.start_date, finish: r.finish_date, readCount: r.read_count,
    });

    readingDb.upsertReading(c.uuid, {
      status: ['wish', 'reading', 'done'].includes(r.status) ? r.status : 'wish',
      read_count: derived.read_count,
      read_logs: JSON.stringify(logs),
      start_date: derived.start_date,
      finish_date: derived.finish_date,
      notes_url: String(r.notes_url || '').slice(0, 1000),
    });
    written++;
  }

  console.log(`[迁移] 写入 ${written} 行,跳过 ${skipped} 行(已存在;用 --force 覆盖)`);

  // 5) 校验
  const verify = readingDb.db.prepare('SELECT COUNT(*) AS n FROM reading').get().n;
  console.log(`[迁移] reading 表现有 ${verify} 行`);
  const sample = readingDb.db.prepare('SELECT * FROM reading LIMIT 3').all().map(readingToJson);
  if (sample.length) console.log('[迁移] 抽样:', JSON.stringify(sample, null, 2));
}

main().catch((err) => {
  console.error('[迁移] 失败:', err);
  process.exit(1);
});
