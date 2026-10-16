/* ============================================================
 * Open Library 映射测试(src/core/openlibrary.js 纯函数,不联网)
 * fixture 按 Open Library 真实接口形状精简构造
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parsePubYear,
  coverUrlFromEdition,
  authorKeysFromEdition,
  editionId,
  mapOpenLibraryBook,
} = require('../src/core/openlibrary.js');

const EDITION = {
  key: '/books/OL7353617M',
  title: 'The Pragmatic Programmer',
  subtitle: 'From Journeyman to Master',
  authors: [{ key: '/authors/OL23919A' }, { key: '/authors/OL23919A' }, { key: '/authors/OL99999A' }],
  publishers: ['Addison-Wesley'],
  publish_date: 'August 1, 2005',
  covers: [12345],
  works: [{ key: '/works/OL45883W' }],
};

const WORK = { description: { type: 'text', value: '<p>A classic.</p><p>Second para.</p>' } };

test('parsePubYear:各种日期形态取 4 位年份', () => {
  assert.equal(parsePubYear('2005'), '2005');
  assert.equal(parsePubYear('August 1, 2005'), '2005');
  assert.equal(parsePubYear('2005-03-01'), '2005');
  assert.equal(parsePubYear(''), '');
  assert.equal(parsePubYear(undefined), '');
});

test('coverUrlFromEdition:取第一个有效封面 id,-1/空数组视为无封面', () => {
  assert.equal(coverUrlFromEdition(EDITION), 'https://covers.openlibrary.org/b/id/12345-L.jpg');
  assert.equal(coverUrlFromEdition({ covers: [-1] }), '');
  assert.equal(coverUrlFromEdition({ covers: [] }), '');
  assert.equal(coverUrlFromEdition({}), '');
});

test('authorKeysFromEdition:去重且上限 3 个', () => {
  assert.deepEqual(authorKeysFromEdition(EDITION), ['/authors/OL23919A', '/authors/OL99999A']);
  assert.deepEqual(authorKeysFromEdition({ authors: [] }), []);
});

test('editionId:从 key 提取 OL id,异常形态返回空串', () => {
  assert.equal(editionId(EDITION), 'OL7353617M');
  assert.equal(editionId({ key: '/books/OL7353617M.json' }), 'OL7353617M', '带 .json 后缀也认');
  assert.equal(editionId({ key: '' }), '');
  assert.equal(editionId({}), '');
});

test('mapOpenLibraryBook:字段映射 + 简介取 work 描述并清洗标签', () => {
  const b = mapOpenLibraryBook({
    isbn: '9780201616224',
    edition: EDITION,
    authorNames: ['Andrew Hunt', 'David Thomas'],
    work: WORK,
  });
  assert.equal(b.title, 'The Pragmatic Programmer');
  assert.equal(b.author, 'Andrew Hunt / David Thomas');
  assert.equal(b.publisher, 'Addison-Wesley');
  assert.equal(b.pubYear, '2005');
  assert.equal(b.isbn, '9780201616224');
  assert.equal(b.cover, 'https://covers.openlibrary.org/b/id/12345-L.jpg');
  assert.equal(b.openlibraryId, 'OL7353617M');
  assert.ok(b.summary.startsWith('A classic.'));
  assert.ok(!b.summary.includes('<'), '简介不应残留 HTML 标签');
  assert.equal(b.rating, 0);
});

test('mapOpenLibraryBook:缺字段(无作者/无出版日期/无封面)不抛异常', () => {
  const b = mapOpenLibraryBook({ isbn: '9780000000000', edition: { title: 'X' } });
  assert.equal(b.title, 'X');
  assert.equal(b.author, '');
  assert.equal(b.pubYear, '');
  assert.equal(b.cover, '');
  assert.equal(b.openlibraryId, '');
  assert.equal(b.summary, '');
});
