#!/usr/bin/env bash
# ============================================================
# calibre 后端安装与初始化(在服务器上以 root 运行)
#
#   bash deploy/setup-calibre.sh
#
# 做四件事:
#   1) 装 calibre 官方二进制(**不要用发行版包**,官方手册明确说
#      发行版包 often terminally broken)
#   2) 建库目录,并把本地已有的书导进去(可选)
#   3) 建 calibre 的「阅读记录用不到」的库,但确保 --trusted-ips 生效
#   4) 装 systemd 服务并启动
#
# ⚠️ 注意:本仓库里的 calibre-master/ 是**纯源码,跑不起来** ——
#    它的 C 扩展没有编译产物(stubs/calibre_extensions/ 下只有 .pyi 类型存根),
#    所以必须装官方二进制,不能直接运行那份源码。
# ============================================================

set -euo pipefail

LIBRARY_DIR="${CALIBRE_LIBRARY:-/root/calibre-library}"
PORT="${CALIBRE_PORT:-3003}"

echo "=== 1/5 检查是否已安装 calibre ==="
if command -v calibre-server >/dev/null 2>&1; then
    echo "已安装:$(calibre-server --version 2>&1 | head -1)"
else
    echo "未安装,开始安装官方二进制..."
    # 官方一键安装脚本。它会装到 /opt/calibre 并软链到 /usr/bin
    sudo -v
    wget -nv -O- https://download.calibre-ebook.com/linux-installer.sh | sudo sh /dev/stdin
    echo "安装完成:$(calibre-server --version 2>&1 | head -1)"
fi

echo "=== 2/5 准备库目录 ==="
mkdir -p "$LIBRARY_DIR"
echo "库目录:$LIBRARY_DIR"

# 若目录里没有 metadata.db,calibre 会当作新库初始化
if [ ! -f "$LIBRARY_DIR/metadata.db" ]; then
    echo "未发现现有库,将创建新库"
    echo "(把你的 epub/pdf 等放进库目录后,用 calibredb add 添加)"
else
    echo "发现现有库:$LIBRARY_DIR/metadata.db"
fi

echo "=== 3/5 安装 systemd 服务 ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 644 "$SCRIPT_DIR/calibre-server.service" /etc/systemd/system/calibre-server.service

# 如果库目录不是默认值,替换进 unit 文件
if [ "$LIBRARY_DIR" != "/root/calibre-library" ]; then
    sed -i "s|/root/calibre-library|$LIBRARY_DIR|g" /etc/systemd/system/calibre-server.service
fi
if [ "$PORT" != "3003" ]; then
    sed -i "s|--port 3003|--port $PORT|g" /etc/systemd/system/calibre-server.service
fi

systemctl daemon-reload
systemctl enable --now calibre-server
sleep 2
systemctl --no-pager status calibre-server | head -20

echo "=== 4/5 自检 ==="
echo "-- 本机直连(--url-prefix 生效与否)--"
curl -s -o /dev/null -w "  /calibre/      → %{http_code}\n" "http://127.0.0.1:$PORT/calibre/" || true
curl -s -o /dev/null -w "  /calibre       → %{http_code} (应为 301)\n" "http://127.0.0.1:$PORT/calibre" || true
curl -s -o /dev/null -w "  /ajax/books    → %{http_code}\n" "http://127.0.0.1:$PORT/calibre/ajax/books?ids=all" || true

echo "-- 确认 CORS 头确实不存在(这正说明必须反代)--"
curl -s -D- -o /dev/null "http://127.0.0.1:$PORT/calibre/ajax/library-info" \
    | grep -i "access-control-allow-origin" \
    && echo "  ⚠️ 意外发现 CORS 头" \
    || echo "  未返回 CORS 头(符合预期:前端必须同源反代)"

echo
echo "=== 5/5 完成 ==="
cat <<'EOF'
后续步骤:
  1. 确认 3003 端口**没有**对公网放行(云安全组)
  2. 把书放进去:
       calibredb add /path/to/books/*.epub --library-path <库目录>
     或在本地 calibre GUI 里管理,再把库目录同步上来
  3. 配置 Nginx:cp deploy/nginx-helloac.top.conf /etc/nginx/conf.d/
       sudo nginx -t && sudo systemctl reload nginx
  4. 重启 Node 让它读到新的 CALIBRE_URL:
       pm2 restart my-books --update-env
  5. 迁移旧阅读记录:
       cd /root/my-books && node deploy/migrate-reading.js --dry-run
EOF
