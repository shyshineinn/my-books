const fs = require('node:fs');
const crypto = require('node:crypto');
const cache = new Map();

async function fileDigest(filePath) {
  const before = await fs.promises.stat(filePath);
  const key = `${filePath}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    const after = await fs.promises.stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw Object.assign(new Error('文件已变化，请重新下载'), { status: 409 });
    }
    return { sha256: hash.digest('hex'), size: after.size };
  })();
  cache.set(key, pending);
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  try { return await pending; } catch (error) { cache.delete(key); throw error; }
}
module.exports = { fileDigest };
