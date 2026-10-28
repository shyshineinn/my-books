const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/check-public.mjs');

function repository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-check-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), value);
  const check = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    run({ git, write, check });
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('public check accepts example configurations and CSS skeleton names', () => repository(({write, check}) => {
  write('.env.example', 'PORT=3000\n');
  write('local.properties.example', '# sdk.dir=/your/sdk\n');
  write('style.css', '.sk-shelf-card-placeholder-with-a-very-long-class-name { color: red; }');
  const result = check();
  assert.equal(result.status, 0, result.stderr);
}));

test('public check rejects ignored but tracked private files without printing values', () => repository(({git, write, check}) => {
  write('.gitignore', '.env\n');
  write('.env', 'PRIVATE_VALUE=do-not-print-this-value\n');
  git('add', '--force', '.env');
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env: private configuration/);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-this-value/);
}));

test('public check reports token locations but never token text', () => repository(({write, check}) => {
  const fake = 'gh' + 'p_' + 'A'.repeat(36);
  write('example.js', `const value = '${fake}';\n`);
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /example.js:1: github-token/);
  assert.ok(!(result.stdout + result.stderr).includes(fake));
}));

test('history check detects a removed token in prior commits', () => repository(({git, write, check}) => {
  const fake = 'gh' + 'p_' + 'B'.repeat(36);
  write('old.js', fake);
  git('add', 'old.js');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  git('rm', '--quiet', 'old.js');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'remove fixture');
  assert.equal(check().status, 0);
  const history = check('--history');
  assert.equal(history.status, 1);
  assert.match(history.stderr, /old.js:1: github-token/);
  assert.ok(!(history.stdout + history.stderr).includes(fake));
}));

test('public check detects a literal legacy administrator token without revealing it', () => repository(({write, check}) => {
  const fake = 'f1'.repeat(32);
  write('config.js', `const ADMIN_TOKEN = '${fake}';\n`);
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config.js:1: embedded-admin-token/);
  assert.ok(!(result.stdout + result.stderr).includes(fake));
}));
