#!/usr/bin/env bash
# ============================================================
# calibre 后端安装与初始化(在服务器上以 root 运行)
#
#   bash deploy/setup-calibre.sh
#
# 这个脚本踩过的坑(2026-10-09 实测,不要再重演):
#   1) 缺 libGLX.so.0 → PyQt6.QtGui 加载失败 → calibre/ebooks/covers.py:13
#      的 QBrush 导入崩 → 服务 exit 1 崩溃重启。官方安装脚本自己**不检查**
#      libGLX(它只查 libEGL/libOpenGL/libxcb-cursor/freetype),
#      所以必须我们主动装。
#   2) 库目录不存在就 `systemctl enable --now` → calibre-server 启动时硬检查
#      metadata.db(srv/standalone.py:215-217 的 LibraryDatabase.exists_at),
#      不存在就 SystemExit → 无休止的崩溃重启。必须先有库再起服务。
#   3) calibredb 与 calibre-server 抢**同一把全局 db 锁**
#      (standalone.py:177-186 / db/cli/main.py),不能同时跑 ——
#      所以导入数据前要先 stop 服务。
#
# ⚠️ 不要用发行版包(官方手册明确说 often terminally broken)。
# ⚠️ 不要开 --enable-auth(会让封面图也要登录,公开站直接废)。
# ============================================================

set -euo pipefail

LIBRARY_DIR="${CALIBRE_LIBRARY:-/root/calibre-library}"
PORT="${CALIBRE_PORT:-3003}"

# ------------------------------------------------------------
# 1/6 系统依赖
# ------------------------------------------------------------
echo "=== 1/6 检查系统依赖库 ==="

# 这些是 calibre 二进制实际链接的库。官方安装脚本只检查其中一部分,
# libGLX 是被漏掉的那个 —— 缺它时的报错是 QBrush 导入失败,
# 很难从字面联想到"缺 GL 库",所以在这里显式安装。
NEEDED_PKGS=(libegl1 libopengl0 libglx0 libgl1 libglvnd0 libxcb-cursor0)
MISSING=()
for pkg in "${NEEDED_PKGS[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        MISSING+=("$pkg")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "缺少系统库,安装: ${MISSING[*]}"
    apt-get update -qq
    apt-get install -y "${MISSING[@]}"
else
    echo "系统依赖已齐备"
fi

# 逐库确认真的能加载(包在但 .so 找不到的情况也见过)
echo "验证关键动态库可加载:"
python3 - <<'PY'
import ctypes, sys
libs = ['libEGL.so.1', 'libOpenGL.so.0', 'libGLX.so.0', 'libGL.so.1', 'libxcb-cursor.so.0']
bad = []
for name in libs:
    try:
        ctypes.CDLL(name)
        print(f'  {name}  OK')
    except Exception as e:
        print(f'  {name}  失败: {e}')
        bad.append(name)
if bad:
    sys.exit(f'仍有库无法加载: {bad}')
PY

# ------------------------------------------------------------
# 2/6 安装 calibre
# ------------------------------------------------------------
echo
echo "=== 2/6 检查 calibre ==="
if command -v calibre-server >/dev/null 2>&1; then
    echo "已安装:$(calibre-server --version 2>&1 | head -1)"
else
    echo "未安装,开始安装官方二进制..."
    wget -nv -O- https://download.calibre-ebook.com/linux-installer.sh | sh /dev/stdin
    echo "安装完成:$(calibre-server --version 2>&1 | head -1)"
fi

# ------------------------------------------------------------
# 3/6 准备库目录
# ------------------------------------------------------------
echo
echo "=== 3/6 准备库目录 ==="
mkdir -p "$LIBRARY_DIR"
if [ -f "$LIBRARY_DIR/metadata.db" ]; then
    echo "发现现有库:$LIBRARY_DIR/metadata.db"
    HAVE_LIBRARY=1
else
    echo "库为空(没有 metadata.db)。"
    echo "注意:calibre-server **无法**在空库上启动,所以稍后不会立即启动服务。"
    HAVE_LIBRARY=0
fi

# ------------------------------------------------------------
# 4/6 安装 systemd 服务(先只安装,不启动)
# ------------------------------------------------------------
echo
echo "=== 4/6 安装 systemd 服务 ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 644 "$SCRIPT_DIR/calibre-server.service" /etc/systemd/system/calibre-server.service

# 按环境变量替换默认值
if [ "$LIBRARY_DIR" != "/root/calibre-library" ]; then
    sed -i "s|/root/calibre-library|$LIBRARY_DIR|g" /etc/systemd/system/calibre-server.service
fi
if [ "$PORT" != "3003" ]; then
    sed -i "s|--port 3003|--port $PORT|g" /etc/systemd/system/calibre-server.service
fi

systemctl daemon-reload
# 只 enable(开机自启),不 now —— 库不存在时启动必失败,会陷入崩溃重启循环
systemctl enable calibre-server >/dev/null 2>&1 || true
echo "已安装并设为开机自启(尚未启动)"

# ------------------------------------------------------------
# 5/6 启动(仅在库已存在时)
# ------------------------------------------------------------
echo
echo "=== 5/6 启动服务 ==="
if [ "$HAVE_LIBRARY" = "1" ]; then
    systemctl restart calibre-server
    sleep 3
    if systemctl is-active --quiet calibre-server; then
        echo "calibre-server 已启动"
    else
        echo "⚠️ calibre-server 启动失败,最近日志:" >&2
        journalctl -u calibre-server -n 20 --no-pager >&2 || true
        exit 1
    fi
else
    echo "跳过启动(库为空)。请先执行下面的导入步骤。"
fi

# ------------------------------------------------------------
# 6/6 自检
# ------------------------------------------------------------
echo
echo "=== 6/6 自检 ==="

if systemctl is-active --quiet calibre-server; then
    curl -s -o /dev/null -w "  /calibre/ajax/library-info  → %{http_code}\n" "http://127.0.0.1:$PORT/calibre/ajax/library-info" || true
    curl -s -o /dev/null -w "  /calibre(应 301)            → %{http_code}\n" "http://127.0.0.1:$PORT/calibre" || true
    curl -s -o /dev/null -w "  /calibre/(应 200)           → %{http_code}\n" "http://127.0.0.1:$PORT/calibre/" || true

    echo -n "  CORS 头(应无):"
    if curl -s -D- -o /dev/null "http://127.0.0.1:$PORT/calibre/ajax/library-info" | grep -qi "access-control-allow-origin"; then
        echo "⚠️ 意外存在"
    else
        echo "无(符合预期:前端必须同源反代)"
    fi
else
    echo "  服务未运行,跳过 HTTP 自检"
fi

echo
echo "=== 完成 ==="
cat <<EOF
后续步骤:

  1) 导入旧书目(库为空时必须先做这步,否则服务起不来):
       cd /root/my-books
       node deploy/import-to-calibre.js --dry-run
       node deploy/import-to-calibre.js --exec --no-covers
     ⚠️ 导入前先停服务(calibredb 与 calibre-server 抢同一把 db 锁):
       systemctl stop calibre-server
     导入后:
       systemctl start calibre-server

  2) 迁移阅读记录到 reading.db:
       node deploy/migrate-reading.js --dry-run
       node deploy/migrate-reading.js

  3) 配置 Nginx(已内置 /calibre/cdb/ 403 拦截,防止公网删书):
       sudo cp deploy/nginx-helloac.top.conf /etc/nginx/conf.d/helloac.top.conf
       sudo nginx -t && sudo systemctl reload nginx

  4) 重启 Node 读取 CALIBRE_URL:
       pm2 restart my-books --update-env

  5) 确认 3003 端口未对公网放行(云安全组)

日常注意:以后用 calibredb 时,要么先 systemctl stop calibre-server,
要么通过 HTTP 连运行中的服务:
  calibredb --with-library 'http://127.0.0.1:$PORT/calibre/#calibre-library' list
EOF
