/* ============================================================
 * 文件系统工具:原子写文件 / 受边界约束的删除
 *
 * atomic_write 借鉴 calibre db/utils.py:
 * 先写同目录临时文件,再用 rename 原子替换 —— 目标路径要么是完整
 * 旧内容,要么是完整新内容,绝不会出现写一半的文件。
 * 适用:封面上传、令牌文件等任何"不能写一半"的场景。
 *
 * removeUnderBase 与 atomicWrite 是同一套纪律的另一半:写要原子,
 * 删要收口 —— 删除是不可逆操作,一律限定在指定目录内。
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 同目录保证 rename 在同一文件系统上(跨盘 rename 会退化为拷贝,失去原子性)
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // 失败清理临时文件,不留垃圾
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能尚未创建 */ }
    throw err;
  }
}

// 静默删除:文件不存在视为成功(force),权限/占用等真实错误返回 false 交调用方记日志。
// 用途:删书时清理磁盘资产 —— 文件本来就可能已被人工移走,不该因此让删除失败。
function removeQuiet(targetPath) {
  try {
    fs.rmSync(targetPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// 按 base 目录 + 相对路径删除,并拒绝越出 base 的路径。
// 库里的 path 字段由本程序生成(见 core/ebook.js 的 ebookFileName),但"删文件"
// 是不可逆操作,一律以 base 目录为边界收口:../../etc/passwd、绝对路径
// 这类越界输入直接返回 false,不碰磁盘。
function removeUnderBase(baseDir, relPath) {
  const rel = String(relPath || '').trim();
  if (!rel) return true;                       // 无路径可删:视为成功
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, rel);
  // base 目录本身也拒删(如 rel 为 "."),只允许删 base 内部的路径
  if (abs === base || !abs.startsWith(base + path.sep)) return false; // 越界:拒删
  return removeQuiet(abs);
}

module.exports = { atomicWrite, removeQuiet, removeUnderBase };
