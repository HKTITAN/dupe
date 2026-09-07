// Windows backend. Nothing is cloned: a per-profile launcher .exe (compiled
// on the spot with the csc.exe every Windows 10/11 ships in the .NET
// Framework folder) starts the stock binary with --user-data-dir and stamps
// its windows with a distinct AppUserModelID, so the taskbar treats the
// profile as its own app with its own icon.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadIcon, makeIcon, writeIcoFile, writePng } from '../icon.js';
import { selfCommand } from '../schedule.js';
import { EMBEDDED } from '../embedded.js';

const here = path.dirname(fileURLToPath(import.meta.url));
import { DUPE_HOME } from '../store.js';

// Launchers live under ~/.dupe, not AppData, on purpose: see profileDataDir
// in store.js for why AppData is unsafe when dupe runs from inside a
// Store-packaged app's process tree.
const LAUNCHERS = path.join(DUPE_HOME, 'launchers');
const REPO_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? process.env[k.toUpperCase()] ?? m);
}

// Resolve a path with a single `*` directory segment (Squirrel's app-<ver>).
function globOne(p) {
  if (!p.includes('*')) return fs.existsSync(p) ? p : null;
  const parts = p.split(path.sep);
  const i = parts.findIndex((s) => s.includes('*'));
  const base = parts.slice(0, i).join(path.sep);
  if (!fs.existsSync(base)) return null;
  const rx = new RegExp('^' + parts[i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  const matches = fs.readdirSync(base).filter((n) => rx.test(n)).sort().reverse();
  for (const m of matches) {
    const candidate = [base, m, ...parts.slice(i + 1)].join(path.sep);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function msixPackages(pattern) {
  const r = spawnSync('reg', ['query', REPO_KEY, '/k', '/f', pattern.replace(/\*/g, '*')], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /Packages\\([^\\\s]+)\s*$/.exec(line.trim());
    if (!m || !rx.test(m[1])) continue;
    const q = spawnSync('reg', ['query', `${REPO_KEY}\\${m[1]}`, '/v', 'PackageRootFolder'], { encoding: 'utf8' });
    const root = /PackageRootFolder\s+REG_SZ\s+(.+)$/m.exec(q.stdout || '');
    if (root) out.push({ fullName: m[1], root: root[1].trim() });
  }
  return out.sort((a, b) => a.fullName < b.fullName ? 1 : -1);
}

// The app execution alias a package declares, if any: some packages deny
// direct execution of their exe but launch fine through the alias.
function executionAlias(root) {
  try {
    const manifest = fs.readFileSync(path.join(root, 'AppxManifest.xml'), 'utf8');
    const m = /ExecutionAlias\s+Alias="([^"]+)"/.exec(manifest);
    if (!m) return '';
    // Execution aliases are reparse points that deny stat() but allow
    // execute, so probe with access(X_OK) rather than existsSync.
    const local = process.env.LOCALAPPDATA || '';
    try { fs.accessSync(path.join(local, 'Microsoft', 'WindowsApps', m[1]), fs.constants.X_OK); return m[1]; } catch { return ''; }
  } catch {
    return '';
  }
}

/** Find the stock executable for a preset (or a custom path). */
export function locate(app) {
  if (app.custom) {
    const p = path.resolve(app.source);
    return fs.existsSync(p) ? { exe: p, kind: 'path' } : null;
  }
  const w = app.win32 || {};
  if (w.msix) {
    for (const pkg of msixPackages(w.msix.pattern)) {
      const exe = path.join(pkg.root, w.msix.exe);
      if (fs.existsSync(exe)) return { exe, kind: 'msix', msix: w.msix, packageFullName: pkg.fullName, alias: executionAlias(pkg.root) };
    }
  }
  for (const raw of w.paths || []) {
    const exe = globOne(path.normalize(expandEnv(raw)));
    if (exe) return { exe, kind: 'path' };
  }
  return null;
}

export function isElectron(exe) {
  return fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar')) ||
    fs.existsSync(path.join(path.dirname(exe), 'resources', 'app'));
}

export function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  for (const arch of ['Framework64', 'Framework']) {
    const base = path.join(win, 'Microsoft.NET', arch);
    if (!fs.existsSync(base)) continue;
    const vers = fs.readdirSync(base).filter((v) => /^v4\./.test(v)).sort().reverse();
    for (const v of vers) {
      const csc = path.join(base, v, 'csc.exe');
      if (fs.existsSync(csc)) return csc;
    }
  }
  return null;
}

const csString = (s) => `@"${String(s).replace(/"/g, '""')}"`;
const csArray = (arr) => arr.map(csString).join(', ');
const quoteArg = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * Build one profile. Returns a record for the store.
 * @param {object} app preset from apps.js
 * @param {{profile:string,label:string,color:string,treatment:string,dataDir:string,extraArgs:string[],extraEnv:object}} opts
 */
export function build(app, opts, log = () => {}) {
  const found = locate(app);
  if (!found) throw new Error(`${app.name} isn't installed here (nothing found for the ${app.id} preset).`);
  const csc = findCsc();
  if (!csc) throw new Error('csc.exe from .NET Framework 4 was not found under %WINDIR%\\Microsoft.NET. It ships with Windows 10 and 11.');

  const dir = path.join(LAUNCHERS, app.id, opts.profile);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(opts.dataDir, { recursive: true });

  // Icon: the app's own embedded icon, or the one the user supplied.
  const iconSrc = opts.iconFile || found.exe;
  const source = loadIcon(iconSrc);
  const { master, treatment } = makeIcon(source, opts.color, opts.treatment);
  const ico = path.join(dir, 'icon.ico');
  writeIcoFile(master, ico);
  writePng(master, path.join(dir, 'icon.png'));
  log(`  icon        ${path.basename(iconSrc)} ${source.width}px → ${opts.color} (${treatment})`);

  // Environment and arguments.
  const env = { ...(app.env ? app.env(opts.dataDir) : {}), ...(opts.extraEnv || {}) };
  const mkdirs = Object.values(env).filter((v) => v.startsWith(opts.dataDir));
  const args = [`--user-data-dir=${opts.dataDir}`, ...(app.args ? app.args(opts.dataDir) : []), ...(opts.extraArgs || [])];
  const aumid = `dupe.${app.id}.${opts.profile}`;

  // Compile the launcher. The template comes from the source tree when
  // running from a checkout, or from the embedded copy in a compiled binary.
  const tplPath = path.join(here, 'win32-launcher.cs');
  const template = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, 'utf8') : EMBEDDED['win32-launcher.cs'];
  // What the launcher runs on quit when the stock app has moved.
  const dupe = selfCommand(['update', app.id, opts.profile, '--quiet']);
  const src = template
    .replace('@DUPE_COMMAND@', dupe.command.replace(/"/g, '""'))
    .replace('@DUPE_ARGUMENTS@', dupe.args.map(quoteArg).join(' ').replace(/"/g, '""'))
    .replace('@LABEL@', opts.label.replace(/"/g, '""'))
    .replace('@AUMID@', aumid)
    .replace('@EXE_PATH@', found.exe.replace(/"/g, '""'))
    .replace('@MSIX_PATTERN@', found.kind === 'msix' ? found.msix.pattern : '')
    .replace('@MSIX_EXE@', found.kind === 'msix' ? found.msix.exe : '')
    .replace('@MSIX_ALIAS@', found.alias || '')
    .replace('@PROFILE_DIR@', opts.dataDir.replace(/"/g, '""'))
    .replace('@ARGUMENTS@', args.map(quoteArg).join(' ').replace(/"/g, '""'))
    .replace('@ENV_KEYS@', csArray(Object.keys(env)))
    .replace('@ENV_VALUES@', csArray(Object.values(env)))
    .replace('@ENV_MKDIRS@', csArray(mkdirs));
  const csFile = path.join(dir, 'launcher.cs');
  fs.writeFileSync(csFile, src);
  const exe = path.join(dir, `${opts.label}.exe`);
  killLauncher(exe);
  const r = spawnSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/win32icon:${ico}`, `/out:${exe}`, csFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`csc failed:\n${r.stdout}${r.stderr}`);
  log(`  launcher    ${exe}`);

  // Start Menu shortcut, written by the launcher so it carries the AUMID.
  const lnk = execFileSync(exe, ['--install-shortcut'], { encoding: 'utf8' }).trim();
  log(`  start menu  ${lnk}`);

  return {
    app: app.id, appName: app.name, profile: opts.profile, label: opts.label, color: opts.color, treatment, custom: !!app.custom,
    platform: 'win32', dataDir: opts.dataDir, launcher: exe, shortcut: lnk, icon: ico, aumid,
    source: found.exe, sourceKind: found.kind, extraArgs: opts.extraArgs || [], extraEnv: opts.extraEnv || {}, iconFile: opts.iconFile || null,
    builtAt: new Date().toISOString(),
  };
}

function killLauncher(exe) {
  // A running launcher holds its exe open; stop it before overwriting.
  spawnSync('taskkill', ['/F', '/IM', path.basename(exe)], { stdio: 'ignore' });
}

export function remove(record, { purge = false } = {}, log = () => {}) {
  if (record.launcher) killLauncher(record.launcher);
  if (record.shortcut && fs.existsSync(record.shortcut)) { fs.rmSync(record.shortcut); log(`  removed     ${record.shortcut}`); }
  const dir = record.launcher ? path.dirname(record.launcher) : null;
  if (dir && fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); log(`  removed     ${dir}`); }
  if (purge && record.dataDir && fs.existsSync(record.dataDir)) { fs.rmSync(record.dataDir, { recursive: true, force: true }); log(`  removed     ${record.dataDir} (profile data)`); }
}

export function launch(record) {
  spawn(record.launcher, [], { detached: true, stdio: 'ignore' }).unref();
}

/** A fingerprint of the stock app as it is right now. An MSIX package's full
 *  name carries its version, which is exactly the signal we want; classic
 *  installs get the resolved path plus the executable's size and mtime. */
export function stamp(app) {
  const found = locate(app);
  if (!found) return null;
  let mtimeMs = 0, size = 0;
  try { const st = fs.statSync(found.exe); mtimeMs = st.mtimeMs; size = st.size; } catch { /* aliases deny stat */ }
  const version = found.kind === 'msix' ? (/_(\d+(?:\.\d+)*)_/.exec(found.packageFullName) || [])[1] || null : null;
  const id = found.kind === 'msix' ? `msix:${found.packageFullName}` : `${found.exe}|${Math.floor(mtimeMs / 1000)}:${size}`;
  return { path: found.exe, version, id, mtimeMs };
}

/** True while the profile's launcher is running. Rebuilding has to replace
 *  the .exe, which means stopping it and leaving the app it was tagging
 *  without its taskbar identity, so the background updater waits instead. */
export function running(record) {
  if (!record.launcher) return false;
  const name = path.basename(record.launcher);
  // CSV, not the default table: that pads and truncates the image name at 25
  // characters, so "Visual Studio Code Work.exe" would never match itself and
  // an open profile would be rebuilt underneath whoever was using it.
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return (r.stdout || '').split(/\r?\n/).some((line) => {
    const first = /^"([^"]*)"/.exec(line.trim());
    return !!first && first[1].toLowerCase() === name.toLowerCase();
  });
}
