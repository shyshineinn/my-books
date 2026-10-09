#!/usr/bin/env bash
# ============================================================
# My books · 一键更新线上代码
# 用法(在服务器上):
#   bash /root/my-books/deploy/update.sh
# 首次执行前:chmod +x deploy/update.sh
#
# 流程:备份数据库与电子书 → 拉最新代码 → 装依赖 → 重启进程 → 自检
# data/、uploads/ 与 books-files/ 已在 .gitignore 中,git pull 不会动线上数据。
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/my-books}"
APP_NAME="${APP_NAME:-my-books}"

cd "$APP_DIR"

echo "==> 1/5 备份数据(数据库 + 电子书文件)"
if [ -f data/books.db ]; then
  mkdir -p data/backup
  BACKUP_FILE="data/backup/books-$(date +%Y%m%d-%H%M%S).db"

  # —— 用 VACUUM INTO 而非 cp(关键:数据正确性)——
  # 库跑在 WAL 模式下(src/db/index.js 的 PRAGMA journal_mode = WAL):
  # 已提交事务可能只存在于 -wal 文件里,主库文件要等检查点才更新。
  # `cp data/books.db` 会拷到一个"能打开、但缺数据"的备份 —— 实测丢失可达 80%,
  # 而且 PRAGMA integrity_check 依然通过,校验抓不出来。
  # VACUUM INTO 读取含 WAL 的完整内容,产出自包含单文件;backup-db.js 内还
  # 比对了 books 表行数,行数不符即判失败并丢弃该备份。
  if node deploy/backup-db.js data/books.db "$BACKUP_FILE"; then
    echo "    备份通过行数与完整性校验"
  else
    echo "    !! 备份失败,中止更新(数据安全优先)。请检查磁盘/数据库后重试。" >&2
    exit 1
  fi
  # 保留最近 10 份(含伴随文件一并清理)
  ls -1t data/backup/books-*.db 2>/dev/null | tail -n +11 | while read -r old; do
    rm -f "$old" "$old-wal" "$old-shm"
  done
else
  echo "    未发现 data/books.db,跳过"
fi

# —— 电子书与封面:与数据库同级的重要数据,此前完全不在备份范围内 ——
# uploads/ 是封面,books-files/ 是电子书正文(单本可达 80MB)。
# 用硬链接快照(-al)代替复制:同一文件系统上几乎瞬时完成、不占额外空间;
# 由于应用写文件一律"先写临时名再原子 rename"(routes.files.js / fs-utils.js),
# 被替换的旧文件在备份目录里仍是完整旧版本,不会被写坏。
# 注意:硬链接要求备份目录与源目录位于同一文件系统(同盘),否则自动回退为复制。
BACKUP_FILES="data/backup/files-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_FILES"
for d in uploads books-files; do
  if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then
    if cp -al "$d" "$BACKUP_FILES/$d" 2>/dev/null; then
      mode="硬链接"
    elif cp -a "$d" "$BACKUP_FILES/$d"; then
      mode="复制"
    else
      echo "    !! $d 备份失败,中止更新(数据安全优先)" >&2
      exit 1
    fi
    n=$(find "$BACKUP_FILES/$d" -type f | wc -l)
    echo "    已备份 $d/($n 个文件,$mode)"
  else
    echo "    $d/ 为空或不存在,跳过"
  fi
done
# 保留最近 10 份文件快照(与数据库备份的保留策略一致)
ls -1dt data/backup/files-* 2>/dev/null | tail -n +11 | xargs -r rm -rf --
echo "    文件快照保留最近 10 份:$BACKUP_FILES"

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
echo "备份内容:数据库 data/backup/books-*.db + 文件快照 data/backup/files-*(uploads/ 与 books-files/)"
echo "可选:数据自检 node data-check.js(检查 JSON 字段/日期格式/孤儿记录)"
