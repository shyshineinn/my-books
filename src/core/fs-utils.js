/* ============================================================
 * 文件系统工具:原子写文件
 * 借鉴 calibre db/utils.py 的 atomic_write():
 * 先写同目录临时文件,再用 rename 原子替换 —— 目标路径要么是完整
 * 旧内容,要么是完整新内容,绝不会出现写一半的文件。
 * 适用:封面上传、令牌文件等任何"不能写一半"的场景。
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

module.exports = { atomicWrite };
