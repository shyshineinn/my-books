/* 首页 / 榜单专用只读 feed:避免浏览器为几十张卡片拉全库书目 */
const express = require('express');

const { db } = require('../db/index');
const { homeFeed, rankFeed } = require('../db/feeds');

const router = express.Router();

router.get('/api/home/feed', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(homeFeed(db, { gridMax: req.query.grid, entLimit: req.query.ent }));
});

router.get('/api/rank/feed', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(rankFeed(db, { size: req.query.size }));
});

module.exports = router;