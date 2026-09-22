#!/usr/bin/env bash
# ============================================================
# My books · 一键更新线上代码
# 用法(在服务器上):
#   bash /root/my-books/deploy/update.sh
# 首次执行前:chmod +x deploy/update.sh
#
# 流程:备份数据库 → 拉最新代码 → 装依赖 → 重启进程 → 自检
# data/ 与 uploads/ 已在 .gitignore 中,git pull 不会动线上数据。
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/my-books}"
APP_NAME="${APP_NAME:-my-books}"

cd "$APP_DIR"

echo "==> 1/5 备份数据库"
if [ -f data/books.db ]; then
  mkdir -p data/backup
  BACKUP_FILE="data/backup/books-$(date +%Y%m%d-%H%M%S).db"
  cp data/books.db "$BACKUP_FILE"
  ls -1t data/backup/books-*.db | tail -n +11 | xargs -r rm --
  echo "    已备份到 $BACKUP_FILE(保留最近 10 份)"

  # —— 备份对账(借鉴 calibre 的备份可校验思想):确认备份文件真的可读、完整 ——
  # 用 Node 内置 node:sqlite 做 integrity_check(服务器上无需额外装 sqlite3 CLI);
  # 校验失败立即中止更新:宁可不上新代码,也不能带着坏备份往前走。
  if node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = db.prepare('PRAGMA integrity_check').get();
    if (r.integrity_check !== 'ok') { console.error('    integrity_check: ' + r.integrity_check); process.exit(1); }
    db.close();
  " "$BACKUP_FILE"; then
    echo "    备份完整性校验通过(integrity_check: ok)"
  else
    echo "    !! 备份校验失败,中止更新(数据安全优先)。请检查磁盘/备份后重试。" >&2
    exit 1
  fi
else
  echo "    未发现 data/books.db,跳过"
fi

echo "==> 2/5 拉取最新代码"
git pull --ff-only

echo "==> 3/5 安装依赖"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "==> 4/5 重启进程"
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
  pm2 save >/dev/null 2>&1 || true
  echo "    已通过 PM2 重启 $APP_NAME"
elif systemctl list-unit-files 2>/dev/null | grep -q "^${APP_NAME}.service"; then
  sudo systemctl restart "$APP_NAME"
  echo "    已通过 systemd 重启 $APP_NAME"
else
  echo "    !! 没找到名为 $APP_NAME 的 PM2 进程或 systemd 服务,请手动启动" >&2
  exit 1
fi

echo "==> 5/5 自检"
sleep 2
curl -s -o /dev/null -w "    本机 3002 端口返回: %{http_code}\n" http://127.0.0.1:3002/ || true
pm2 status 2>/dev/null | grep -E "name|$APP_NAME" || true

echo
echo "完成。外网验证:https://helloac.top"
echo "可选:数据自检 node data-check.js(检查 JSON 字段/日期格式/孤儿记录)"
