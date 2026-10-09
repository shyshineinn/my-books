// ============================================================
// My books · PM2 进程配置(与 ecook 一致的托管方式)
// 用法(在服务器上,用跑 PM2 的那个账号 —— 本机实测为 root):
//   cd /root/my-books
//   pm2 start deploy/ecosystem.config.js
//   pm2 save
// 之后:pm2 restart my-books / pm2 logs my-books / pm2 status
// ============================================================

module.exports = {
  apps: [
    {
      name: 'my-books',
      cwd: '/root/my-books',
      script: 'server.js',

      // 单进程 fork 即可:SQLite 文件锁 + 会话无需多实例
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        PORT: 3002,          // 3001 已被 ecook 占用
        HOST: '127.0.0.1',   // 只监听本机,由 Nginx 反代;不要把端口暴露到公网
        TZ: 'Asia/Shanghai',

        // —— 双数据库架构:Node 是前端唯一出口,由它转发给 calibre ——
        // calibre-server 的地址(须与 calibre-server.service 的 --port / --url-prefix 一致)
        CALIBRE_URL: 'http://127.0.0.1:3003/calibre',
        CALIBRE_TIMEOUT_MS: '10000',      // 普通请求
        CALIBRE_SLOW_TIMEOUT_MS: '60000', // 封面生成/正文下载/慢查询

        // 读写全公开(用户明确要求)。
        // 不设或设 0:走应用层 Bearer token(默认 fail-closed);
        // 设 1:关闭应用层鉴权,读写全部公开。
        OPEN_ACCESS: '1',
      },

      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: '300M',
      kill_timeout: 5000,

      // 日志默认落在 ~/.pm2/logs/my-books-*.log,带时间戳便于排查
      merge_logs: true,
      time: true,
    },
  ],
};
