/* ============================================================
 * 导入脚本的参数契约测试
 *
 * 为什么值得测:开发机上没装 calibre,`calibredb` 的参数拼错
 * (比如把 --library-path 写成 --libraries,或给 add 加不存在的
 * --pubdate)只会在**部署到服务器那一刻**才炸。
 *
 * 做法:跑 --dry-run。它会把最终要执行的命令原样打印出来,
 * 因此不需要真的装 calibre、不需要网络、跨平台一致 ——
 * 而参数构造正是唯一会出错的地方。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'deploy', 'import-to-calibre.js');

function dryRun(extraEnv = {}) {
  return execFileSync(process.execPath, [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: { ...process.env, ...extraEnv },
  });
}

// 从 dry-run 输出里提取所有 calibredb 命令行。
// 注意不能假设可执行文件就叫 calibredb —— 它取自 CALIBREDB 环境变量,
// 所以只按"包含 add --empty"来识别。
function commands(out) {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\badd\b/.test(l) && l.includes('--empty'));
}

test('dry-run:为每条记录生成一条 calibredb add 命令', () => {
  const out = dryRun();
  const cmds = commands(out);
  // 实测旧库有 31 条记录
  assert.ok(cmds.length >= 20, `应生成 20+ 条命令,实际 ${cmds.length}\n${out}`);
  // 每条命令对应一个书名注释
  assert.match(out, /# \[\d+\] .+/, '应有 "# [id] 书名" 形式的注释');
});

test('dry-run:参数都是 calibre 的真实选项(回归防护)', () => {
  const cmds = commands(dryRun());
  assert.ok(cmds.length > 0, '应有命令');

  for (const line of cmds) {
    assert.match(line, /--empty/, `应带 --empty(空书目): ${line}`);
    assert.match(line, /--title\s+\S/, `应带 --title: ${line}`);
    // 关键契约:calibredb 的全局选项叫 --library-path(见 cmd GLOBAL OPTIONS)
    assert.match(line, /--library-path\s+\S/, `应带 --library-path: ${line}`);

    // 这两个都不是 calibre 的真实选项,一旦出现就是 bug:
    //   --libraries  是我一度写错的猜测名
    //   --pubdate    calibredb add 根本没有(出版日期要用 set_metadata 设)
    assert.ok(!line.includes('--libraries'), `--libraries 不是 calibre 选项: ${line}`);
    assert.ok(!line.includes('--pubdate'), `calibredb add 没有 --pubdate 选项: ${line}`);
  }
});

test('dry-run:中文书名、作者、标签(含阅读状态)正确传入', () => {
  const out = dryRun();
  const cmds = commands(out);
  assert.ok(cmds.some((l) => l.includes('三体')), '应包含《三体》');
  assert.ok(cmds.some((l) => l.includes('刘慈欣')), '应包含作者刘慈欣');
  // 阅读状态被转成标签,便于在 calibre 里按状态筛选
  assert.ok(cmds.some((l) => l.includes('已读')), '阅读状态应作为标签带上');
  assert.ok(cmds.some((l) => l.includes('想读')), '应包含「想读」标签');
});

test('dry-run:缺失的列被跳过而不是报错', () => {
  // 实测旧库没有 series 列;脚本应提示跳过而非崩溃
  const out = dryRun();
  assert.match(out, /旧库没有这些列/, '应提示跳过了不存在的列');
  assert.ok(!/no such column/i.test(out), '不应出现 SQL 列不存在错误');
});

test('dry-run:重名书各生成一条命令(4 本《三体》不去重)', () => {
  const cmds = commands(dryRun());
  const sanTi = cmds.filter((l) => /--title\s+三体\s/.test(l));
  // 旧库有 4 条《三体》;calibre 的 add_books 默认允许重复,
  // 所以必须如实建 4 条 —— 若这里变成 1 条,说明被错误地去重了
  assert.equal(sanTi.length, 4, `《三体》应有 4 条命令,实际 ${sanTi.length}`);
});

test('dry-run:--dry-run 不写库、不需要 calibre 可执行文件', () => {
  // 把 CALIBREDB 指向一个不存在的路径,证明 dry-run 根本不会调用它
  const out = dryRun({ CALIBREDB: path.join(ROOT, 'definitely-not-a-real-binary') });
  assert.ok(commands(out).length > 0, 'dry-run 应仍然生成命令');
  assert.match(out, /dry-run 结束/, '应明确说明未执行');
});
