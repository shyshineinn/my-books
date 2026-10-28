// Source-tree disclosure checks. Values are never printed; this is not a complete secret audit.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const history = process.argv.includes('--history');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const findings = new Set();
let checked = 0;
let skipped = 0;
const forbidden = /(^|\/)(?:local\.properties|auth\.json(?:\..*)?|admin-token|douban-cookie|\.env(?:\.(?!example$|sample$|template$)[^/]+)?|[^/]+\.(?:jks|keystore|p12|pfx|pem|key|db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?)$/i;
const binary = /\.(?:apk|aab|jar|aar|zip|gz|7z|png|jpe?g|gif|webp|ico|pdf|epub|mobi|azw3|cbz|ttf|otf|woff2?|mp[34]|wav|so|dll|exe|db|sqlite3?)$/i;
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['openai-token', /\bsk-(?:(?:proj-|svcacct-)[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{40,})\b/],
  ['embedded-admin-token', /\b(?:MYBOOKS_ADMIN_TOKEN|ADMIN_TOKEN|adminToken)\b.{0,80}?\b[A-Za-z0-9]{48,}\b/],
];
function inspect(name, bytes) {
  // An old release manifest is public build metadata, not a private library file.
  const publicReleaseMetadata = history && name === 'data/app-releases/latest.json';
  if (forbidden.test(name) || !publicReleaseMetadata && /^(?:data|uploads|books-files|notes-files)\//.test(name) && !/(?:^|\/)(?:\.gitkeep|README\.md)$/.test(name)) {
    findings.add(`${name}: private configuration or library data`);
  }
  if (binary.test(name) || bytes.length > 5 * 1024 * 1024 || bytes.includes(0)) { skipped++; return; }
  checked++;
  const lines = bytes.toString('utf8').split('\n');
  for (let line = 0; line < lines.length; line++) for (const [label, pattern] of patterns) {
    if (pattern.test(lines[line])) findings.add(`${name}:${line + 1}: ${label}`);
  }
}
if (history) {
  const objects = new Map();
  for (const row of git('rev-list', '--objects', '--all').toString('utf8').trim().split('\n')) {
    const space = row.indexOf(' ');
    if (space < 0) continue;
    const name = row.slice(space + 1);
    if (forbidden.test(name)) findings.add(`${name}: private filename in Git history`);
    if (!binary.test(name)) objects.set(row.slice(0, space), name);
  }
  const entries = [...objects];
  for (let start = 0; start < entries.length; start += 64) {
    const chunk = entries.slice(start, start + 64);
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root, input: chunk.map(([id]) => id).join('\n') + '\n', maxBuffer: 64 * 1024 * 1024,
    });
    let offset = 0;
    for (const [, name] of chunk) {
      const newline = output.indexOf(10, offset);
      const header = output.subarray(offset, newline).toString('ascii').split(' ');
      const size = Number(header[2]);
      if (newline < 0 || !Number.isSafeInteger(size)) throw Error('Invalid Git object response');
      offset = newline + 1;
      if (header[1] === 'blob') inspect(name, output.subarray(offset, offset + size));
      offset += size + 1;
    }
  }
} else {
  const files = new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean));
  for (const name of files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    inspect(name, fs.readFileSync(file));
  }
}
console.log(`${history ? 'Git history' : 'Current source'}: ${checked} text files checked; ${skipped} binary/large files skipped.`);
for (const finding of findings) console.error(finding);
console.log('Scope: private filenames and selected token/private-key patterns; no guarantee that all secrets are detected.');
process.exitCode = findings.size ? 1 : 0;
