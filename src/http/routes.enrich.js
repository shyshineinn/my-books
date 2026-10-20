/* ============================================================
 * 批量补全元数据与封面(HTTP 适配层)
 *
 *   POST /api/books/enrich
 *   body: { ids: number[], overwrite?: boolean, fields?: string[] }
 *   → { results: [{id,title,status,source,updatedFields,error}], summary }
 *
 * 对标 calibre 的 Edit metadata → Download metadata and covers。
 * 编排在 core/enrich.js(deps 注入,可脱离网络单测),本文件只做适配:
 *   · 把 db 层与 network 层注入进去
 *   · 把外链封面下载进 uploads/(复用 core/remote-image.js 的 SSRF 守卫)
 *
 * 错误语义(与 routes.isbn.js 同构):参数/批量约束 → 400 VALIDATION;
 * 逐条失败(查不到/被拒/网络错)体现在 results[].status,整批仍 200。
 * ============================================================ */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { enrichBooks, ENRICH_FIELDS } = require('../core/enrich');
const { fetchRemoteImage, extForMime, checkRemoteUrl } = require('../core/remote-image');
const { atomicWrite } = require('../core/fs-utils');
const { UPLOAD_DIR } = require('../core/paths');
const { lookupIsbn, searchDouban } = require('./metadata-sources');
const books = require('../db/books');
const identifiersRepo = require('../db/identifiers');
const { db } = require('../db/index');

const router = express.Router();

// 按书名搜豆瓣(没有 ISBN 的书走这条路)。
//
// 匹配强度对齐 calibre 的做法:calibre 的 identify 会拿候选逐个算相似度,
// 只接受够像的那个(ebooks/metadata/sources/identify.py)。
// 这里用三个条件收口,任一不满足就 not_found:
//   1. 标题归一化后**完全相等**(忽略全角/半角、大小写、标点、空白)
//   2. 有作者信息时,作者也要对得上(避免同名书张冠李戴)
//   3. 候选里优先取 ISBN 对得上的那本(如果请求方其实有 ISBN,就不会走到这里)
// 宁可 not_found 也不写错元数据 —— 张冠李戴比缺数据糟糕得多,
// 与 core/isbn_import.js 的取舍一致。
async function searchByName(title, author) {
  const q = String(title || '').trim();
  if (!q) return { status: 'not_found' };
  try {
    const list = await searchDouban(q);
    if (!list.length) return { status: 'not_found' };
    const want = normalizeTitle(q);
    const wantAuthor = normalizeTitle(author);
    const hit = list.find((b) => {
      if (normalizeTitle(b.title) !== want) return false;
      // 有作者信息时要求作者也对得上
      if (wantAuthor && b.author) {
        const got = normalizeTitle(b.author);
        return got.includes(wantAuthor) || wantAuthor.includes(got);
      }
      return true;
    });
    if (!hit) return { status: 'not_found' };
    return { status: 'found', book: hit, source: 'douban' };
  } catch (err) {
    if (err && err.code === 'BLOCKED') return { status: 'blocked' };
    return { status: 'error' };
  }
}

// 标题归一化:去空白/标点、全角半角统一、小写 —— 只用于"是不是同一本"的判断,
// 不用于写库(写库用数据源原值)
function normalizeTitle(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');
}

// 把外链封面落盘到 uploads/,返回 /uploads/<文件名>(与 routes.misc.js 的封面上传
// 同一套命名与目录)。失败返回 null —— 调用方退回用外链 URL,不让整条补全失败。
async function saveCoverFromUrl(bookId, url) {
  const check = checkRemoteUrl(url);
  if (!check.ok) return null;                 // 非 http(s) 或内网:不下载,保留原值
  // 已经是本站 uploads/ 的相对路径:无需下载
  if (String(url).startsWith('/uploads/')) return String(url);

  const got = await fetchRemoteImage(url);
  if (!got.ok) return null;

  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extForMime(got.contentType)}`;
  // 原子写:先临时文件再 rename(与封面上传同一纪律,断电不留半张图)
  atomicWrite(path.join(UPLOAD_DIR, filename), got.buffer);
  return `/uploads/${filename}`;
}

async function handleEnrich(req, res) {
  const body = req.body || {};
  try {
    // fields 白名单收口:只允许 ENRICH_FIELDS 里的项;传空/不传 = 全部
    let fields = null;
    if (Array.isArray(body.fields) && body.fields.length) {
      const clean = body.fields.map((f) => String(f).trim()).filter((f) => ENRICH_FIELDS.includes(f));
      if (!clean.length) {
        return res.status(400).json({
          error: `fields 里没有可用项,可选:${ENRICH_FIELDS.join(' / ')}`,
          code: 'VALIDATION',
        });
      }
      fields = clean;
    }

    const out = await enrichBooks({
      getBook: (id) => books.getBook(id),
      // ISBN 以标识符表为准(表更新),行上的列作兜底 —— 与 db/identifiers.js 的读纪律一致
      getIsbn: (id) => {
        const map = identifiersRepo.getIdentifiers(db, id);
        return map.isbn || '';
      },
      // 标识符并集要用:calibre apply_mi 里是 `idents.update(mi.identifiers)`,
      // 得先拿到现有全部标识符才能判断"这个类型是否已占"
      getIdentifiers: (id) => identifiersRepo.getIdentifiers(db, id),
      lookupIsbn,
      searchByName,
      updateBook: (id, patch) => books.enrichBook(db, id, patch),
      saveCover: saveCoverFromUrl,
    }, {
      ids: body.ids,
      overwrite: body.overwrite === true,
      fields,
    });
    res.json(out);
  } catch (err) {
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    console.error('[enrich] batch failed:', (err && (err.stack || err.message)) || err);
    res.status(500).json({ error: '批量补全失败,请稍后重试', code: 'INTERNAL' });
  }
}

router.post('/api/books/enrich', handleEnrich);

module.exports = router;
module.exports.handleEnrich = handleEnrich;
module.exports.searchByName = searchByName;
module.exports.normalizeTitle = normalizeTitle;
module.exports.saveCoverFromUrl = saveCoverFromUrl;
