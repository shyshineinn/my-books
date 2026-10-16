/* ============================================================
 * 批量「按 ISBN 添加」测试:core/isbn_import.js(假 deps,不联网不碰库)
 * 与 db/identifiers.js listIsbnIndex(临时库,句柄注入)
 *
 * 隔离纪律(见 a-group-v12.test.js 的教训):
 * db 层模块只传 openDb(临时目录) 的**句柄**,不碰真实 data/books.db。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const crypto = require('node:crypto');
const { parseIsbnInput, importIsbns, MAX_BATCH } = require('../src/core/isbn_import.js');
const { openDb } = require('../src/db/index.js');
const idsRepo = require('../src/db/identifiers.js');
const { isbnKey } = require('../src/core/isbn.js');

const ISBN13 = '9787536692930';
const ISBN10 = '7536692935'; // 同一本书的 ISBN-10
const ISBN13_B = '9787115428028';
const ISBN10_B = '7115428026'; // 另一本书的 ISBN-10

function fakeDeps({ index = new Map(), lookup = async () => ({ status: 'not_found', book: null }) } = {}) {
  const calls = { lookup: [], created: [], index: 0 };
  return {
    calls,
    deps: {
      lookupIsbn: async (isbn) => { calls.lookup.push(isbn); return lookup(isbn); },
      isbnIndex: () => { calls.index += 1; return index; },
      createBook: (body) => {
        calls.created.push(body);
        return { id: 100 + calls.created.length, title: body.title };
      },
    },
  };
}

const FOUND = (book = {}) => async () => ({
  status: 'found',
  book: { title: '三体', author: '刘慈欣', doubanId: '2567698', isbn: ISBN13, ...book },
});

test('parseIsbnInput:多行 / 逗号 / 分号都能拆,空行去掉', () => {
  assert.deepEqual(parseIsbnInput('9787536692930\n\n7536692935'), [ISBN13, ISBN10]);
  assert.deepEqual(parseIsbnInput('9787536692930, 7536692935;x'), [ISBN13, ISBN10, 'x']);
  assert.deepEqual(parseIsbnInput(['  a ', '', 'b']), ['a', 'b']);
  assert.deepEqual(parseIsbnInput(''), []);
});

test('importIsbns:无效 ISBN 逐条报 invalid,不静默丢弃', async () => {
  const { deps, calls } = fakeDeps();
  const { results, summary } = await importIsbns(deps, { entries: ['abc', '1111111111', '9787536692931'] });
  assert.deepEqual(results.map((r) => r.status), ['invalid', 'invalid', 'invalid']);
  assert.equal(summary.invalid, 3);
  assert.equal(calls.lookup.length, 0, '无效 ISBN 不该发起任何查询');
});

test('importIsbns:命中元数据 → 建档,isbn/douban 标识符双写进请求体', async () => {
  const { deps, calls } = fakeDeps({ lookup: FOUND() });
  const { results, summary } = await importIsbns(deps, { entries: [ISBN13], tags: '科幻,小说' });
  assert.equal(results[0].status, 'created');
  assert.equal(results[0].bookId, 101);
  assert.equal(results[0].title, '三体');
  assert.equal(summary.created, 1);

  const body = calls.created[0];
  assert.equal(body.title, '三体');
  assert.equal(body.author, '刘慈欣');
  assert.equal(body.isbn, ISBN13);
  assert.equal(body.douban_id, '2567698');
  assert.equal(body.tags, '科幻,小说', '标签原样透传,由 parseBook 归一化');
  assert.deepEqual(body.identifiers, { isbn: ISBN13, douban: '2567698' });
});

test('importIsbns:库中已有同 ISBN(10 位存量 vs 13 位输入)→ duplicate,不查元数据不建档', async () => {
  const index = new Map([[require('../src/core/isbn.js').isbnKey(ISBN10), { id: 7, title: '三体(旧藏)' }]]);
  const { deps, calls } = fakeDeps({ index });
  const { results, summary } = await importIsbns(deps, { entries: [ISBN13], checkExisting: true });
  assert.equal(results[0].status, 'duplicate');
  assert.deepEqual(results[0].existing, { id: 7, title: '三体(旧藏)' });
  assert.equal(summary.duplicate, 1);
  assert.equal(calls.lookup.length, 0);
  assert.equal(calls.created.length, 0);
});

test('importIsbns:checkExisting 关掉时不建索引(零查重成本)', async () => {
  const { deps, calls } = fakeDeps({ lookup: FOUND() });
  await importIsbns(deps, { entries: [ISBN13], checkExisting: false });
  assert.equal(calls.index, 0);
});

test('importIsbns:本次输入重复 → 第二条 duplicate(existing=null),只查一次', async () => {
  const { deps, calls } = fakeDeps({ lookup: FOUND() });
  const { results, summary } = await importIsbns(deps, { entries: [ISBN13, '978-7536-69293-0'] });
  assert.equal(results[0].status, 'created');
  assert.equal(results[1].status, 'duplicate');
  assert.equal(results[1].existing, null, 'existing=null 表示批内重复(库中重复会带 id)');
  assert.equal(summary.duplicate, 1);
  assert.equal(calls.lookup.length, 1);
});

test('importIsbns:not_found / blocked / error 逐条记账,互不影响', async () => {
  const { deps } = fakeDeps({
    lookup: async (isbn) => {
      if (isbn === ISBN13) return { status: 'not_found' };
      if (isbn === '9787115428028') return { status: 'blocked' };
      throw new Error('boom');
    },
  });
  const { results, summary } = await importIsbns(deps, { entries: [ISBN13, '9787115428028', '9791090636071'] });
  assert.deepEqual(results.map((r) => r.status), ['not_found', 'blocked', 'error']);
  assert.ok(results[1].error.includes('Cookie'), 'blocked 要给出配 Cookie 的提示');
  assert.deepEqual(
    { nf: summary.not_found, bl: summary.blocked, er: summary.error },
    { nf: 1, bl: 1, er: 1 }
  );
});

test('importIsbns:convertTo13 决定查询与存储用哪种形态', async () => {
  const a = fakeDeps({ lookup: FOUND() });
  await importIsbns(a.deps, { entries: [ISBN10], convertTo13: false });
  assert.deepEqual(a.calls.lookup, [ISBN10], '不转换:按输入原样查询');

  const b = fakeDeps({ lookup: FOUND() });
  await importIsbns(b.deps, { entries: [ISBN10], convertTo13: true });
  assert.deepEqual(b.calls.lookup, [ISBN13], '转换:10 位归一到 13 位');
  assert.equal(b.calls.created[0].isbn, ISBN13);
});

test('importIsbns:超过上限直接拒绝(校验错误)', async () => {
  const { deps } = fakeDeps();
  const entries = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `978753669293${i % 10}`);
  await assert.rejects(() => importIsbns(deps, { entries }), (err) => err.code === 'VALIDATION');
});

/* ---------- listIsbnIndex(临时库) ---------- */

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-isbn-idx-'));
  const db = openDb(dir);
  db.exec(`
    DELETE FROM book_identifiers; DELETE FROM book_custom_values; DELETE FROM custom_columns;
    DELETE FROM book_tags; DELETE FROM book_authors; DELETE FROM tags; DELETE FROM authors; DELETE FROM books;
  `);
  return { db, dir };
}

function insertBook(db, { title, isbn = '', douban = '' }) {
  const ts = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO books (title, title_sort, author, author_sort, status, tags, read_logs,
                       isbn, douban_id, uuid, created_at, updated_at)
    VALUES (?, ?, '', '', 'wish', '[]', '[]', ?, ?, ?, ?, ?)
  `).run(title, title, isbn, douban, crypto.randomUUID(), ts, ts);
  return Number(r.lastInsertRowid);
}

test('listIsbnIndex:isbn 列与标识符表都覆盖,连字符/10 位混存能归一命中', () => {
  const { db, dir } = freshDb();
  try {
    const a = insertBook(db, { title: '带连字符', isbn: '978-7-5366-9293-0' });
    const b = insertBook(db, { title: '只有标识符行' });
    idsRepo.setIdentifiers(db, b, { isbn: ISBN10_B });
    insertBook(db, { title: '没有 ISBN' });
    insertBook(db, { title: '同键后到的', isbn: ISBN13 }); // 与 a 同一个键,应被忽略

    const idx = idsRepo.listIsbnIndex(db);
    assert.equal(idx.size, 2, '无效/重复键都不入库');
    assert.deepEqual(idx.get(ISBN13), { id: a, title: '带连字符' }, '连字符归一命中;同键保留先遇到的一行');
    assert.deepEqual(idx.get(ISBN13_B), { id: b, title: '只有标识符行' }, '10 位标识符归一成 13 位后命中');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
