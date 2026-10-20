/* ============================================================
 * 批量补全元数据与封面(core/enrich.js + db/books.enrichBook)
 *
 * 分两层测:
 *   A. buildPatch —— 纯规则,字段合并/不覆盖/tags 并集/字段白名单
 *   B. enrichBook —— 数据层,只改传入的列 + tags 并集 + FTS 同步
 *   C. enrichBooks —— 编排,deps 全部注入(绝不碰真实网络)
 *
 * 隔离:openDb(临时目录),不碰真实 data/books.db。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildPatch, toIncoming, isEmpty, ENRICH_FIELDS, enrichBooks, MAX_BATCH } = require('../src/core/enrich.js');
const { openDb } = require('../src/db/index.js');
const books = require('../src/db/books.js');
const search = require('../src/db/search.js');
const categories = require('../src/db/categories.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-enrich-'));
}

/* ============================================================
 * A. buildPatch —— 纯规则
 * ============================================================ */

test('A1 isEmpty:空串/空白/null/undefined 都算空;rating 的 0 也算空', () => {
  assert.equal(isEmpty('summary', ''), true);
  assert.equal(isEmpty('summary', '   '), true);
  assert.equal(isEmpty('summary', null), true);
  assert.equal(isEmpty('summary', undefined), true);
  assert.equal(isEmpty('summary', '有内容'), false);
  assert.equal(isEmpty('rating', 0), true);        // 0 = 未评分
  assert.equal(isEmpty('rating', 8.5), false);
});

test('A2 默认只补空:已有值不覆盖', () => {
  const current = { summary: '我自己写的简介', cover: '', publisher: '旧社', pub_year: '', rating: 0, series: '', tags: '[]' };
  const incoming = { summary: '数据源的简介', cover: 'https://x/a.jpg', publisher: '新社', pub_year: '2008', rating: 9.0 };
  const { patch, filled, skippedExisting } = buildPatch(current, incoming);
  // 只有空字段被补
  assert.deepEqual(Object.keys(patch).sort(), ['cover', 'pub_year', 'rating']);
  assert.equal(patch.summary, undefined);           // 有值 → 不覆盖
  assert.equal(patch.publisher, undefined);
  assert.deepEqual(skippedExisting.sort(), ['publisher', 'summary']);
  assert.ok(filled.includes('cover') && filled.includes('rating'));
});

test('A3 overwrite:true 时覆盖已有值', () => {
  const current = { summary: '旧简介', cover: '', publisher: '旧社', pub_year: '', rating: 5, series: '', tags: '[]' };
  const incoming = { summary: '新简介', cover: '', publisher: '新社', pub_year: '2008', rating: 9.0, series: '' };
  const { patch } = buildPatch(current, incoming, { overwrite: true });
  assert.equal(patch.summary, '新简介');
  assert.equal(patch.publisher, '新社');
  assert.equal(patch.rating, 9.0);
});

test('A4 tags 只追加不删除:已有标签保留,重复不加', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '["小说","科幻"]' };
  const incoming = { tags: ['科幻', '硬科幻'] };      // 科幻重复
  const { patch } = buildPatch(current, incoming);
  assert.deepEqual(patch.tags_add, ['硬科幻']);       // 只加新的
});

test('A5 tags 全部重复时不产生 tags_add(不写空数组)', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '["科幻"]' };
  const { patch, filled } = buildPatch(current, { tags: ['科幻'] });
  assert.equal(patch.tags_add, undefined);
  assert.ok(!filled.includes('tags'));
});

test('A6 fields 白名单:只补指定的字段', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '[]' };
  const incoming = { summary: 'x', cover: 'https://x/a.jpg', publisher: 'y', pub_year: '2008', rating: 9, series: 'z' };
  const { patch } = buildPatch(current, incoming, { fields: ['summary', 'publisher'] });
  assert.deepEqual(Object.keys(patch).sort(), ['publisher', 'summary']);
});

test('A7 fields 里的非法项被忽略(title/author 永远不可补)', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '[]', title: '原名' };
  const incoming = { summary: 'x', title: '新名', author: '新作者' };
  const { patch } = buildPatch(current, incoming, { fields: ['summary', 'title', 'author'] });
  assert.deepEqual(Object.keys(patch), ['summary']);
  assert.equal(patch.title, undefined);              // 身份字段,白名单外
});

test('A8 数据源没给的字段不写(undefined / 空串都跳过)', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '[]' };
  const { patch, filled } = buildPatch(current, { summary: '   ', publisher: undefined, pub_year: null });
  assert.deepEqual(patch, {});
  assert.deepEqual(filled, []);
});

test('A9 一切都已有值且无新标签 → 空 patch(调用方据此记 unchanged)', () => {
  const current = { summary: 'a', cover: '/uploads/a.jpg', publisher: 'b', pub_year: '2008', rating: 9, series: 'c', tags: '["科幻"]' };
  const incoming = { summary: 'x', cover: 'https://y/b.jpg', publisher: 'y', pub_year: '2010', rating: 8, series: 'z', tags: ['科幻'] };
  const { patch, filled } = buildPatch(current, incoming);
  assert.deepEqual(patch, {});
  assert.deepEqual(filled, []);
});

test('A10 toIncoming:数据源 mapToBook 形状 → 补全字段形状(含 identifiers)', () => {
  const inc = toIncoming({
    title: 'X', summary: 'S', cover: 'C', publisher: 'P', pubYear: '2008', rating: 9,
    tags: ['a'], doubanId: '1', isbn: '9787536692930',
  });
  assert.deepEqual(inc, {
    summary: 'S', cover: 'C', publisher: 'P', pub_year: '2008', rating: 9,
    tags: ['a'],
    // 标识符也要带上(calibre apply_mi 的 idents.update 同款)
    identifiers: { isbn: '9787536692930', douban: '1' },
  });
  // 空输入不炸
  assert.deepEqual(toIncoming(null), {});
});

test('A11 identifiers 并集:已有类型不覆盖,缺的才补', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '[]' };
  const incoming = { identifiers: { isbn: '9787536692930', douban: '123' } };
  // 库里已有 isbn → 不覆盖;douban 没有 → 补
  const { patch } = buildPatch(current, incoming, {
    currentIdentifiers: { isbn: '9780000000000' },
  });
  assert.deepEqual(patch.identifiers, { douban: '123' });
});

test('A12 identifiers 全都有时不产生 identifiers 键', () => {
  const current = { summary: '', cover: '', publisher: '', pub_year: '', rating: 0, series: '', tags: '[]' };
  const { patch } = buildPatch(current, { identifiers: { isbn: '9787536692930' } }, {
    currentIdentifiers: { isbn: '9787536692930' },
  });
  assert.equal(patch.identifiers, undefined);
});

/* ============================================================
 * B. db/books.enrichBook —— 数据层
 * ============================================================ */

function seedBook(db, extra = {}) {
  const row = { id: 1, title: '三体', author: '刘慈欣', status: 'done',
    summary: '', tags: '[]', publisher: '', pub_year: '', rating: 0, series: '', series_index: 0,
    cover: '', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
    ...extra };
  db.prepare(`INSERT INTO books (id,title,author,author_sort,status,summary,tags,publisher,pub_year,rating,series,series_index,cover,created_at,updated_at)
    VALUES (@id,@title,@author,@author,@status,@summary,@tags,@publisher,@pub_year,@rating,@series,@series_index,@cover,@created_at,@updated_at)`).run(row);
  const r = db.prepare('SELECT * FROM books WHERE id = ?').get(row.id);
  search.indexBook(db, r);
  categories.syncBookTags(db, row.id, JSON.parse(row.tags));
  return r;
}

test('B1 enrichBook 只改传入的列,其余保持原值', () => {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books'); db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  seedBook(db, { summary: '原简介', publisher: '原社' });

  const out = books.enrichBook(db, 1, { summary: '新简介', rating: 9.2 });
  assert.equal(out.summary, '新简介');
  assert.equal(out.rating, 9.2);
  assert.equal(out.publisher, '原社');          // 未传入 → 不动
  assert.equal(out.title, '三体');              // 身份字段永远不动
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('B2 enrichBook 的 tags_add 是并集,并同步 FTS', () => {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books; DELETE FROM book_tags; DELETE FROM tags;');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  seedBook(db, { tags: '["科幻"]' });

  const out = books.enrichBook(db, 1, { tags_add: ['硬科幻', '科幻'] });   // 科幻重复
  assert.deepEqual(JSON.parse(out.tags), ['科幻', '硬科幻']);

  // 链接表也要有(只查这本书的链接,不看全库标签表 —— 种子数据会干扰)
  const linked = db.prepare(
    'SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag WHERE bt.book = 1 ORDER BY t.name'
  ).all().map((r) => r.name);
  assert.deepEqual(linked, ['硬科幻', '科幻']);

  // FTS 能搜到新标签(证明 updateBookIndex 生效)
  const hit = search.searchBooks(db, { q: 'tag:硬科幻' });
  assert.equal(hit.length, 1);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('B3 enrichBook 白名单外键被忽略(防 SQL 注入面)', () => {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books'); db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  seedBook(db);

  const out = books.enrichBook(db, 1, { summary: 's', title: '被篡改', id: 999, deleted_at: 'x' });
  assert.equal(out.title, '三体');              // 非白名单列无效
  assert.equal(out.id, 1);
  assert.equal(out.deleted_at, null);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('B4 enrichBook 对不存在的书返回 null', () => {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books');
  assert.equal(books.enrichBook(db, 999, { summary: 'x' }), null);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('B5 enrichBook 空 patch 不报错、不改 updated_at', () => {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books'); db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  seedBook(db);
  const out = books.enrichBook(db, 1, {});
  assert.equal(out.updated_at, '2024-01-01T00:00:00.000Z');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ============================================================
 * C. enrichBooks —— 编排(deps 全注入)
 * ============================================================ */

// 假 deps:内存里的"库",记录调用次数,方便断言"该查的查了、不该查的没查"
function fakeDeps({ rows, byIsbn = {}, byName = {}, saveCoverResult = null } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = { lookupIsbn: [], searchByName: [], saveCover: [], update: [] };
  return {
    store, calls,
    deps: {
      getBook: (id) => store.get(id) || null,
      getIsbn: (id) => (store.get(id) || {}).isbn || '',
      lookupIsbn: async (isbn) => { calls.lookupIsbn.push(isbn); return byIsbn[isbn] || { status: 'not_found' }; },
      searchByName: async (t, a) => { calls.searchByName.push(t); return byName[t] || { status: 'not_found' }; },
      updateBook: (id, patch) => {
        calls.update.push({ id, patch });
        const cur = store.get(id);
        if (!cur) return null;
        const next = { ...cur, ...patch };
        if (Array.isArray(patch.tags_add)) {
          const tags = new Set(JSON.parse(cur.tags || '[]'));
          for (const t of patch.tags_add) tags.add(t);
          next.tags = JSON.stringify([...tags]);
        }
        store.set(id, next);
        return next;
      },
      saveCover: saveCoverResult
        ? async (id, url) => { calls.saveCover.push({ id, url }); return saveCoverResult; }
        : null,
    },
  };
}

const baseRow = (over = {}) => ({
  id: 1, title: '三体', author: '刘慈欣', summary: '', cover: '', publisher: '',
  pub_year: '', rating: 0, series: '', tags: '[]', ...over,
});

test('C1 有 ISBN 走 lookupIsbn,补空字段,记 updated', async () => {
  const { deps, calls, store } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { summary: '简介', publisher: '重庆社', pubYear: '2008' } } },
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.summary.updated, 1);
  assert.equal(out.results[0].status, 'updated');
  assert.equal(out.results[0].source, 'douban');
  assert.deepEqual(calls.lookupIsbn, ['9787536692930']);
  assert.equal(calls.searchByName.length, 0);            // 有 ISBN 就不该按书名搜
  assert.equal(store.get(1).summary, '简介');
  assert.equal(store.get(1).publisher, '重庆社');
});

test('C2 无 ISBN 有书名 → 走 searchByName', async () => {
  const { deps, calls } = fakeDeps({
    rows: [baseRow()],
    byName: { 三体: { status: 'found', source: 'douban', book: { summary: '简介' } } },
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.summary.updated, 1);
  assert.deepEqual(calls.searchByName, ['三体']);
  assert.equal(calls.lookupIsbn.length, 0);
});

test('C3 既无 ISBN 也无书名 → skipped,不发任何网络请求', async () => {
  const { deps, calls } = fakeDeps({ rows: [baseRow({ title: '   ' })] });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].status, 'skipped');
  assert.equal(calls.lookupIsbn.length + calls.searchByName.length, 0);
});

test('C4 数据源没查到 → not_found,不改库', async () => {
  const { deps, calls } = fakeDeps({ rows: [baseRow({ isbn: '9787536692930' })] });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].status, 'not_found');
  assert.equal(calls.update.length, 0);
});

test('C5 豆瓣被拒 → blocked(与 not_found 区分,提示配 Cookie)', async () => {
  const { deps } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'blocked' } },
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].status, 'blocked');
  assert.ok(out.results[0].error.includes('Cookie'));
});

test('C6 字段都已有值 → unchanged,不写库', async () => {
  const { deps, calls } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930', summary: '已有', publisher: '已有', pub_year: '2008', rating: 9 })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { summary: '新', publisher: '新', pubYear: '2010', rating: 8 } } },
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].status, 'unchanged');
  assert.equal(calls.update.length, 0);
});

test('C7 overwrite:true 时覆盖已有值', async () => {
  const { deps, store } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930', summary: '旧' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { summary: '新' } } },
  });
  const out = await enrichBooks(deps, { ids: [1], overwrite: true });
  assert.equal(out.results[0].status, 'updated');
  assert.equal(store.get(1).summary, '新');
});

test('C8 封面落盘:saveCover 返回 /uploads/ 路径时用它,而不是外链', async () => {
  const { deps, calls, store } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { cover: 'https://img1.doubanio.com/a.jpg' } } },
    saveCoverResult: '/uploads/123-abc.jpg',
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].status, 'updated');
  assert.equal(store.get(1).cover, '/uploads/123-abc.jpg');
  assert.deepEqual(calls.saveCover, [{ id: 1, url: 'https://img1.doubanio.com/a.jpg' }]);
});

test('C9 已有封面时不下载(避免无谓网络请求)', async () => {
  const { deps, calls } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930', cover: '/uploads/mine.jpg' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { cover: 'https://x/a.jpg' } } },
    saveCoverResult: '/uploads/new.jpg',
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].status, 'unchanged');
  assert.equal(calls.saveCover.length, 0);
});

test('C10 fields 只要元数据时不下载封面', async () => {
  const { deps, calls } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { cover: 'https://x/a.jpg', summary: 's' } } },
    saveCoverResult: '/uploads/new.jpg',
  });
  const out = await enrichBooks(deps, { ids: [1], fields: ['summary'] });
  assert.equal(out.results[0].status, 'updated');
  assert.deepEqual(out.results[0].updatedFields, ['summary']);
  assert.equal(calls.saveCover.length, 0);
});

test('C11 单条异常不拖垮整批', async () => {
  const { deps } = fakeDeps({ rows: [baseRow({ id: 1, isbn: '9787536692930' }), baseRow({ id: 2, isbn: '9787536692930' })] });
  deps.lookupIsbn = async (isbn) => {
    if (deps.lookupIsbn.calls = (deps.lookupIsbn.calls || 0) + 1, deps.lookupIsbn.calls === 1) throw new Error('网络炸了');
    return { status: 'found', source: 'douban', book: { summary: 's' } };
  };
  const out = await enrichBooks(deps, { ids: [1, 2] });
  assert.equal(out.summary.error, 1);
  assert.equal(out.summary.updated, 1);
  assert.ok(out.results.find((r) => r.status === 'error').error.includes('网络炸了'));
});

test('C12 不存在的书 → error(不存在或已在回收站)', async () => {
  const { deps } = fakeDeps({ rows: [] });
  const out = await enrichBooks(deps, { ids: [42] });
  assert.equal(out.results[0].status, 'error');
  assert.ok(out.results[0].error.includes('回收站'));
});

test('C13 参数校验:空 ids / 超上限 / 非法 id', async () => {
  const { deps } = fakeDeps({ rows: [] });
  await assert.rejects(() => enrichBooks(deps, { ids: [] }), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => enrichBooks(deps, { ids: [-1, 0, 'x'] }), (e) => e.code === 'VALIDATION');
  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => i + 1);
  await assert.rejects(() => enrichBooks(deps, { ids: many }), (e) => e.code === 'VALIDATION');
});

test('C14 ids 去重:同一本书传两次只处理一次', async () => {
  const { deps } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { summary: 's' } } },
  });
  const out = await enrichBooks(deps, { ids: [1, 1, 1] });
  assert.equal(out.summary.total, 1);
});

test('C15 ENRICH_FIELDS 不含 title/author/series', () => {
  assert.ok(!ENRICH_FIELDS.includes('title'));
  assert.ok(!ENRICH_FIELDS.includes('author'));
  // series 不在白名单:数据源(豆瓣/OL)根本不产出它,
  // 列进来只会让 updatedFields 出现一个永远补不到的字段
  assert.ok(!ENRICH_FIELDS.includes('series'));
  assert.deepEqual([...ENRICH_FIELDS].sort(), ['cover', 'pub_year', 'publisher', 'rating', 'summary']);
});

test('C16 封面失败单独记账,不影响元数据结论(calibre 的 failed_covers 同思路)', async () => {
  const { deps } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { cover: 'https://x/a.jpg', summary: 's' } } },
  });
  deps.saveCover = async () => { throw new Error('图床 418'); };
  const out = await enrichBooks(deps, { ids: [1] });
  // 元数据仍算成功
  assert.equal(out.results[0].status, 'updated');
  assert.ok(out.results[0].updatedFields.includes('summary'));
  // 封面单独标记失败
  assert.equal(out.results[0].coverStatus, 'failed');
  assert.equal(out.summary.cover_failed, 1);
  // 封面字段仍写入了外链 URL(退回策略)
  assert.ok(out.results[0].updatedFields.includes('cover'));
});

test('C17 封面成功时 cover_saved 计数正确', async () => {
  const { deps } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { cover: 'https://x/a.jpg' } } },
    saveCoverResult: '/uploads/ok.jpg',
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].coverStatus, 'saved');
  assert.equal(out.summary.cover_saved, 1);
  assert.equal(out.summary.cover_failed, 0);
});

test('C18 数据源没给封面 → coverStatus = none', async () => {
  const { deps } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { summary: 's' } } },
    saveCoverResult: '/uploads/ok.jpg',
  });
  const out = await enrichBooks(deps, { ids: [1] });
  assert.equal(out.results[0].coverStatus, 'none');
});

test('C19 标识符并集:库里已有 isbn 时不覆盖,缺的 douban 补上', async () => {
  const { deps, store } = fakeDeps({
    rows: [baseRow({ isbn: '9787536692930' })],
    byIsbn: { 9787536692930: { status: 'found', source: 'douban', book: { summary: 's', isbn: '9787536692930', doubanId: '123' } } },
  });
  deps.getIdentifiers = () => ({ isbn: '9780000000000' });   // 库里已有一个不同的 isbn
  let captured = null;
  deps.updateBook = (id, patch) => {
    captured = patch;
    const next = { ...store.get(id), ...patch };
    store.set(id, next);
    return next;
  };
  await enrichBooks(deps, { ids: [1] });
  assert.deepEqual(captured.identifiers, { douban: '123' });  // isbn 不被覆盖
});
