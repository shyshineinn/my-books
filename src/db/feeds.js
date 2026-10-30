/* ============================================================
 * 首页 / 榜单的专用取数(只读)
 *
 * 首页原来拉全量书目再在前端分组成"大屏/书格/画廊",书一多就是一次
 * 无谓的全量 JSON 传输。这里把选取规则下推到 SQL,只返回真正会渲染的
 * 少量书(至多 gridMax + 1 + entLimit 本组)。
 *
 * 选取顺序必须与 public/js/page-home.js 的历史逻辑一致:
 *   · 有"读过 >=2 次"的已读书 → 大屏按 read_count/finish_date 排;
 *   · 没有 → 全部已读书按 created_at 排;
 *   · 画廊 = 大屏第 5 本起 + 其余已读 + 未读完,截 entLimit。
 * ============================================================ */

function clampInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

function homeFeed(handleDb, { gridMax = 4, entLimit = 16 } = {}) {
  const grid = clampInt(gridMax, 4, 50);
  const ent = clampInt(entLimit, 16, 50);
  const bigLimit = grid + 1 + ent;

  const hasCounted = !!handleDb.prepare(`
    SELECT 1 FROM books
    WHERE deleted_at IS NULL AND status = 'done' AND COALESCE(read_count, 0) >= 2
    LIMIT 1
  `).get();

  const bigScreen = hasCounted
    ? handleDb.prepare(`
        SELECT * FROM books
        WHERE deleted_at IS NULL AND status = 'done' AND COALESCE(read_count, 0) >= 2
        ORDER BY COALESCE(read_count, 0) DESC,
                 CASE WHEN finish_date = '' THEN 1 ELSE 0 END,
                 finish_date DESC, created_at DESC, id DESC
        LIMIT ?
      `).all(bigLimit)
    : handleDb.prepare(`
        SELECT * FROM books
        WHERE deleted_at IS NULL AND status = 'done'
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(bigLimit);

  const restDone = hasCounted
    ? handleDb.prepare(`
        SELECT * FROM books
        WHERE deleted_at IS NULL AND status = 'done' AND COALESCE(read_count, 0) < 2
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(ent)
    : [];

  const others = handleDb.prepare(`
    SELECT * FROM books
    WHERE deleted_at IS NULL AND status <> 'done'
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(ent);

  return {
    featured: bigScreen[0] || null,
    grid: bigScreen.slice(1, 1 + grid),
    gallery: [...bigScreen.slice(1 + grid), ...restDone, ...others].slice(0, ent),
  };
}

// 榜单只需要总数、已读数与重读榜,不必把整库发给浏览器。
function rankFeed(handleDb, { size = 8 } = {}) {
  const limit = clampInt(size, 8, 50);
  const total = handleDb.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').get().n;
  const done = handleDb.prepare(
    "SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND status = 'done'"
  ).get().n;
  const reread = handleDb.prepare(`
    SELECT * FROM books
    WHERE deleted_at IS NULL AND COALESCE(read_count, 0) >= 2
    ORDER BY COALESCE(read_count, 0) DESC,
             CASE WHEN finish_date = '' THEN 1 ELSE 0 END,
             finish_date DESC, created_at DESC, id DESC
    LIMIT ?
  `).all(limit);
  return { total, done, reread };
}

module.exports = { homeFeed, rankFeed, clampInt };