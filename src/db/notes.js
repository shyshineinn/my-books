/* ============================================================
 * 读书心得存储:每本书一个 notes-files/{id}.md 文件
 *
 * 只负责磁盘 I/O 与校验边界,不碰书籍表;书籍 updated_at 的 touch
 * 由 HTTP 层在保存/删除成功后调用。
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');

const { NOTES_DIR } = require('../core/paths');
const { atomicWrite, removeUnderBase } = require('../core/fs-utils');

const MAX_NOTE_BYTES = 5 * 1024 * 1024;

function notePath(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return path.join(NOTES_DIR, `${n}.md`);
}

function statNote(id) {
  const file = notePath(id);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { size: stat.size, updated_at: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function readNote(id) {
  const file = notePath(id);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(file, 'utf8');
    return {
      content,
      size: Buffer.byteLength(content, 'utf8'),
      updated_at: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function writeNote(id, content) {
  const file = notePath(id);
  if (!file) {
    const err = new Error('书籍 id 不合法');
    err.code = 'VALIDATION';
    throw err;
  }
  const text = String(content == null ? '' : content);
  if (text.includes('\u0000')) {
    const err = new Error('心得内容不能包含二进制字符');
    err.code = 'VALIDATION';
    throw err;
  }
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_NOTE_BYTES) {
    const err = new Error('心得文件不能超过 5MB');
    err.code = 'VALIDATION';
    throw err;
  }
  atomicWrite(file, text);
  const stat = fs.statSync(file);
  return { size, updated_at: stat.mtime.toISOString() };
}

function removeNote(id) {
  const file = notePath(id);
  if (!file) return false;
  return removeUnderBase(NOTES_DIR, `${Number(id)}.md`);
}

// 批量:哪些书有心得文件。
// 一次 readdir 拿到全部 id,避免书架列表逐本 stat(N+1 次系统调用)。
function listNoteIds() {
  try {
    const ids = [];
    for (const name of fs.readdirSync(NOTES_DIR)) {
      if (!name.endsWith('.md')) continue;
      const n = Number(name.slice(0, -3));
      if (Number.isSafeInteger(n) && n > 0) ids.push(n);
    }
    return ids;
  } catch {
    return [];   // 目录还不存在(还没建过心得)时没有心得
  }
}

module.exports = {
  MAX_NOTE_BYTES,
  statNote,
  readNote,
  writeNote,
  removeNote,
  listNoteIds,
};
