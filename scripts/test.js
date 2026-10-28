// 所有默认数据库/文件单例也指向临时库，测试不接触个人书库。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-suite-'));
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...(
    process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(path.join(__dirname, '..', 'test'))
      .filter((file) => file.endsWith('.test.js')).map((file) => 'test/' + file))], {
    stdio: 'inherit', env: { ...process.env, MYBOOKS_STORAGE_DIR: storage, MYBOOKS_SEED_DEMO: 'false' },
  });
  process.exitCode = result.status ?? 1;
} finally {
  if (path.dirname(storage) !== path.resolve(os.tmpdir())) throw new Error('拒绝清理非临时目录');
  fs.rmSync(storage, { recursive: true, force: true });
}
