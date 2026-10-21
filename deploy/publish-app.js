#!/usr/bin/env node
/* ============================================================
 * 发布 Android 更新包
 *
 * 用法:
 *   node deploy/publish-app.js <apk> <versionCode> <versionName> \
 *     [--force] [--min-version-code N] [--out DIR] ["更新内容 1" "更新内容 2" ...]
 *
 * 例:
 *   node deploy/publish-app.js \
 *     ../android-app/app/build/outputs/apk/release/app-release.apk \
 *     2 0.2.0 "新增在线升级" "优化书架排序"
 *
 * 产物:
 *   data/app-releases/my-books.apk   (固定文件名,URL /app/my-books.apk)
 *   data/app-releases/latest.json    (App 检查更新读取 /app/latest.json)
 *
 * 部署:
 *   本脚本在本地生成 data/app-releases/ 后,把整个目录上传到服务器同路径
 *   (例如 scp -r data/app-releases root@host:/root/my-books/data/),
 *   或把 APK 传到服务器后在服务器上执行本脚本。
 *   server.js 的 /app 路由需要已部署并重启进程。
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length < 3) {
  console.error('用法: node deploy/publish-app.js <apk> <versionCode> <versionName> [--force] [--min-version-code N] [--out DIR] [更新内容...]');
  process.exit(1);
}

const apkPath = path.resolve(argv[0]);
const versionCode = Number(argv[1]);
const versionName = String(argv[2]).trim();
const rest = argv.slice(3);

if (!fs.existsSync(apkPath) || !fs.statSync(apkPath).isFile()) fail(`APK 不存在: ${apkPath}`);
if (!Number.isSafeInteger(versionCode) || versionCode < 1) fail('versionCode 必须是正整数');
if (!versionName) fail('versionName 不能为空');

let force = false;
let minSupportedVersionCode = 1;
let outDir = path.join(__dirname, '..', 'data', 'app-releases');
const changelog = [];

for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === '--force') {
    force = true;
  } else if (arg === '--min-version-code') {
    minSupportedVersionCode = Number(rest[++i]);
    if (!Number.isSafeInteger(minSupportedVersionCode) || minSupportedVersionCode < 1) {
      fail('--min-version-code 必须是正整数');
    }
  } else if (arg === '--out') {
    outDir = path.resolve(rest[++i] || fail('--out 缺少目录参数'));
  } else {
    changelog.push(String(arg).trim());
  }
}

if (minSupportedVersionCode > versionCode) {
  fail('minSupportedVersionCode 不能大于 versionCode');
}

fs.mkdirSync(outDir, { recursive: true });
const apkDest = path.join(outDir, 'my-books.apk');
const tempDest = `${apkDest}.tmp`;
fs.copyFileSync(apkPath, tempDest);
fs.renameSync(tempDest, apkDest);

const bytes = fs.readFileSync(apkDest);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

const manifest = {
  versionCode,
  versionName,
  apkUrl: '/app/my-books.apk',
  sha256,
  size: bytes.length,
  changelog: changelog.filter(Boolean),
  force,
  minSupportedVersionCode,
};
const manifestPath = path.join(outDir, 'latest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`已发布 ${versionName} (versionCode=${versionCode})`);
console.log(`  APK:      ${apkDest} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  SHA-256:  ${sha256}`);
console.log(`  清单:     ${manifestPath}`);
console.log(`  下载地址: /app/my-books.apk`);
console.log(`  强制更新: ${force ? '是' : '否'}，最低支持版本: ${minSupportedVersionCode}`);
