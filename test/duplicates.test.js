/* ============================================================
 * 疑似重复检测:归一化 / 相似度 / 分组
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeTitle, normalizeAuthor, dice, findDuplicateGroups,
} = require('../src/core/duplicates');

test('归一化:大小写、标点、空白、英文冠词不影响书名匹配', () => {
  assert.equal(normalizeTitle('The Hobbit!'), 'hobbit');
  assert.equal(normalizeTitle('the   hobbit'), 'hobbit');
  assert.equal(normalizeTitle('三体（典藏版）'), '三体典藏版');
  assert.equal(normalizeTitle('A Game of Thrones'), 'gameofthrones');
});

test('作者归一化:分隔符、顺序、大小写不敏感', () => {
  assert.equal(normalizeAuthor('J.R.R. Tolkien'), normalizeAuthor('Tolkien, J.R.R.'));
  assert.equal(normalizeAuthor('刘慈欣、大刘'), normalizeAuthor('大刘 / 刘慈欣'));
  assert.equal(normalizeAuthor(''), '');
});

test('dice:完全一致为 1,完全不同为 0', () => {
  assert.equal(dice('三体', '三体'), 1);
  assert.equal(dice('三体', 'abc'), 0);
  assert.ok(dice('dunemessiah', 'dunemesiah') > 0.8);
});

test('分组:同名同作者、大小写/标点差异合并为一组', () => {
  const groups = findDuplicateGroups([
    { id: 1, title: 'The Hobbit', author: 'J.R.R. Tolkien', isbn: '' },
    { id: 2, title: 'the hobbit', author: 'Tolkien, J.R.R.', isbn: '' },
    { id: 3, title: 'The Hobbit', author: 'Some Other', isbn: '' },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].books.map((b) => b.id), [1, 2]);
  assert.equal(groups[0].reason, 'title');
});

test('分组:ISBN 相同优先,即使书名不同;保留原始 ISBN 展示值', () => {
  const groups = findDuplicateGroups([
    { id: 4, title: '三体', author: '刘慈欣', isbn: '9787536692930' },
    { id: 5, title: '三体（新版）', author: '刘慈欣', isbn: '978-7-5366-9293-0' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'isbn');
  assert.equal(groups[0].books.find((b) => b.id === 5).isbn, '978-7-5366-9293-0');
});

test('分组:书名高度相似且作者相似 → 疑似重复;同作者不同书不误报', () => {
  const groups = findDuplicateGroups([
    { id: 6, title: 'Dune Messiah', author: 'Frank Herbert', isbn: '' },
    { id: 7, title: 'Dune Mesiah', author: 'Frank Herbert', isbn: '' },
    { id: 8, title: 'Children of Dune', author: 'Frank Herbert', isbn: '' },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].books.map((b) => b.id), [6, 7]);
  assert.equal(groups[0].reason, 'title_fuzzy');
});

test('分组:传递关系合并成一组;无重复返回空数组', () => {
  const groups = findDuplicateGroups([
    { id: 1, title: 'Dune', author: 'Frank Herbert', isbn: '' },
    { id: 2, title: 'Dune', author: 'Frank Herbert', isbn: '' },
    { id: 3, title: 'Dune', author: 'Frank Herbert', isbn: '' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].books.length, 3);

  assert.deepEqual(findDuplicateGroups([
    { id: 1, title: '三体', author: '刘慈欣', isbn: '' },
    { id: 2, title: '活着', author: '余华', isbn: '' },
  ]), []);
});
