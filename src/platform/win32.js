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

// Newest first, comparing version numbers as numbers. A plain string sort
// puts app-1.0.9 ahead of app-1.0.10, which would pin a profile to an old
// build the moment a version part gains a digit — and Squirrel apps like
// Discord number in the thousands, so that happens.
function byVersionDesc(a, b) {
  const na = a.match(/\d+/g) || [], nb = b.match(/\d+/g) || [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (Number(nb[i]) || 0) - (Number(na[i]) || 0);
    if (d) return d;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

// Resolve a path with a single `*` directory segment (Squirrel's app-<ver>).
function globOne(p) {
  if (!p.includes('*')) return fs.existsSync(p) ? p : null;
  const parts = p.split(path.sep);
  const i = parts.findIndex((s) => s.includes('*'));
  const base = parts.slice(0, i).join(path.sep);
  if (!fs.existsSync(base)) return null;
  const rx = new RegExp('^' + parts[i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  const matches = fs.readdirSync(base).filter((n) => rx.test(n)).sort(byVersionDesc);
  for (const m of matches) {
    const candidate = [base, m, ...parts.slice(i + 1)].join(path.sep);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The current build of an app that installs into <root>pp-<version>\.
 *
 * Squirrel adds a new folder on every update and leaves the old one behind
 * for a while, so a path recorded once is where the app WAS, not where it
 * is. A preset copes because it carries a glob; an app found by discovery
 * is recorded at the exact path it was seen at, and without this the first
 * update leaves its profile reading as "not installed here any more" —
 * unrebuildable, for an app sitting right there.
 *
 * The newest sibling wins even when the recorded one still exists, which is
 * what a preset's glob already does and what "the app behind a profile is
 * never out of date" has to mean. Null for any layout that is not this one.
 */
function newestBuild(exe) {
  const dir = path.dirname(exe);
  if (!/^app-\d/i.test(path.basename(dir))) return null;
  const root = path.dirname(dir);
  const name = path.basename(exe);
  let siblings = [];
  try { siblings = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^app-\d/i.test(e.name)).map((e) => e.name); } catch { return null; }
  for (const s of siblings.sort(byVersionDesc)) {
    const candidate = path.join(root, s, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Two `reg query` processes per package, and the interface asks where every
// app lives once per palette colour while it warms its icon strips — 180-odd
// spawns for a dozen apps. The registry does not change between them, so the
// answer is held briefly. Short enough that an app installed or updated while
// dupe is running is still noticed.
const msixCache = new Map();
const MSIX_TTL = 10_000;

function msixPackages(pattern) {
  const hit = msixCache.get(pattern);
  if (hit && Date.now() - hit.at < MSIX_TTL) return hit.value;
  const value = readMsixPackages(pattern);
  msixCache.set(pattern, { at: Date.now(), value });
  return value;
}

function readMsixPackages(pattern) {
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
    const newest = newestBuild(p);
    if (newest) return { exe: newest, kind: 'path' };
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

/**
 * Whether an executable is Chromium underneath, which is what decides
 * whether --user-data-dir means anything to it.
 *
 * Two layouts, because two families: an Electron app keeps its code in
 * resources/app.asar beside the binary, while Chrome and Edge keep theirs in
 * a version-numbered folder next to chrome.exe. The Chromium data files —
 * icudtl.dat, the .pak resources — are common to both and are the signal
 * that survives either layout.
 */
export function usesChromium(exe) {
  const dir = path.dirname(exe);
  const marks = ['resources\\app.asar', 'resources\\app', 'icudtl.dat', 'resources.pak', 'chrome.dll'];
  for (const m of marks) if (fs.existsSync(path.join(dir, m))) return true;
  // Chrome's Application\<version>\ layout, and Squirrel's app-<version>\.
  let subdirs = [];
  try { subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 40); } catch { return false; }
  for (const d of subdirs) {
    if (!/^(\d|app-\d)/.test(d.name)) continue;
    for (const m of ['icudtl.dat', 'chrome.dll', 'resources.pak']) {
      if (fs.existsSync(path.join(dir, d.name, m))) return true;
    }
  }
  return false;
}

/** Electron specifically: what discovery looks for, since an asar is the
 *  sign of an app rather than of a browser that ships its own installer. */
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
  // Every value below is substituted with a function, never a string: with a
  // string replacement, `$&`, '$\'' and a dollar-backtick in the VALUE are
  // expanded by String.replace, and a label containing one spliced this
  // file's own text into the C# literal and closed it — csc then compiled
  // whatever followed, and build() runs the result. A function replacement
  // is taken literally.
  // What the launcher runs on quit when the stock app has moved.
  const dupe = selfCommand(['update', app.id, opts.profile, '--quiet']);
  const src = template
    .replace('@DUPE_COMMAND@', () => dupe.command.replace(/"/g, '""'))
    .replace('@DUPE_ARGUMENTS@', () => dupe.args.map(quoteArg).join(' ').replace(/"/g, '""'))
    .replace('@LABEL@', () => opts.label.replace(/"/g, '""'))
    .replace('@AUMID@', () => aumid)
    .replace('@EXE_PATH@', () => found.exe.replace(/"/g, '""'))
    .replace('@MSIX_PATTERN@', () => found.kind === 'msix' ? found.msix.pattern : '')
    .replace('@MSIX_EXE@', () => found.kind === 'msix' ? found.msix.exe : '')
    .replace('@MSIX_ALIAS@', () => found.alias || '')
    .replace('@PROFILE_DIR@', () => opts.dataDir.replace(/"/g, '""'))
    .replace('@ARGUMENTS@', () => args.map(quoteArg).join(' ').replace(/"/g, '""'))
    .replace('@ENV_KEYS@', () => csArray(Object.keys(env)))
    .replace('@ENV_VALUES@', () => csArray(Object.values(env)))
    .replace('@ENV_MKDIRS@', () => csArray(mkdirs));
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

// ---- finding apps there is no preset for.
//
// A preset is a promise about where an app lives and what else it pins, and
// the list of them is short on purpose. But dupe works on anything that
// honours --user-data-dir, and an Electron install announces itself: an
// app.asar sitting next to the executable. So rather than guess at paths for
// a hundred more apps, look for that.

const SKIP = /^(update|squirrel|elevate|unins\w*|.*(helper|crashpad|setup|installer))\.exe$/i;

function readdirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// The executable a user would double-click: the one named after its folder,
// or failing that the biggest one that isn't obviously a helper.
function mainExe(dir) {
  const exes = readdirSafe(dir).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe') && !SKIP.test(e.name));
  if (!exes.length) return null;
  const folder = path.basename(dir).toLowerCase();
  const named = exes.find((e) => e.name.toLowerCase() === `${folder}.exe`);
  if (named) return path.join(dir, named.name);
  let best = null, bestSize = -1;
  for (const e of exes) {
    let size = 0;
    try { size = fs.statSync(path.join(dir, e.name)).size; } catch { continue; }
    if (size > bestSize) { best = e.name; bestSize = size; }
  }
  return best ? path.join(dir, best) : null;
}

/** Electron apps installed here, whatever they are. */
export function discover() {
  const dirs = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const e of readdirSafe(path.join(local, 'Programs'))) {
      if (e.isDirectory()) dirs.push(path.join(local, 'Programs', e.name));
    }
    // Squirrel keeps the app under a versioned folder and updates by adding
    // a new one, so only the newest is interesting.
    for (const e of readdirSafe(local)) {
      if (!e.isDirectory()) continue;
      const versions = readdirSafe(path.join(local, e.name))
        .filter((v) => v.isDirectory() && /^app-\d/.test(v.name))
        .map((v) => v.name).sort().reverse();
      if (versions.length) dirs.push(path.join(local, e.name, versions[0]));
    }
  }
  for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
    if (!root) continue;
    for (const e of readdirSafe(root)) if (e.isDirectory()) dirs.push(path.join(root, e.name));
  }

  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const exe = mainExe(dir);
    if (!exe || !isElectron(exe) || seen.has(exe.toLowerCase())) continue;
    seen.add(exe.toLowerCase());
    out.push({ name: path.basename(exe, '.exe'), path: exe });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
