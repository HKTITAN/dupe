// Builds standalone executables for every platform with Bun's cross-compiler:
//   node scripts/build-embed.js && node scripts/build-bin.js
// Output lands in dist/. Requires Bun 1.1+ on the build machine only; the
// binaries themselves need nothing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const targets = [
  ['bun-windows-x64', 'dupe-windows-x64.exe'],
  ['bun-darwin-arm64', 'dupe-macos-arm64'],
  ['bun-darwin-x64', 'dupe-macos-x64'],
  ['bun-linux-x64', 'dupe-linux-x64'],
  ['bun-linux-arm64', 'dupe-linux-arm64'],
];
const only = process.argv.slice(2);
for (const [target, name] of targets) {
  if (only.length && !only.some((o) => target.includes(o))) continue;
  const out = path.join(dist, name);
  const r = spawnSync('bun', ['build', '--compile', `--target=${target}`, '--minify', '--outfile', out, path.join(root, 'bin', 'dupe.js')], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`build failed for ${target}`); process.exit(1); }
  console.log(`${name}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
}
// Checksums for the release page.
const { createHash } = await import('node:crypto');
const lines = fs.readdirSync(dist).filter((f) => f.startsWith('dupe-')).map((f) => `${createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`dupe ${version}: ${lines.length} binaries, checksums in dist/SHA256SUMS.txt`);
