// Linux backend. Nothing is cloned: a .desktop entry runs the stock binary
// with --user-data-dir and --class=<WMClass>, and declares the same
// StartupWMClass, so GNOME/KDE docks match the profile's windows to its own
// launcher and icon. Works for native installs, AppImages and Flatpaks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodePng } from '../image/png.js';
import { loadIcon, makeIcon, writePngSet } from '../icon.js';

const HOME = os.homedir();
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const APP_DIRS = [
  path.join(DATA_HOME, 'applications'),
  '/usr/local/share/applications',
  '/usr/share/applications',
  '/var/lib/flatpak/exports/share/applications',
  path.join(DATA_HOME, 'flatpak', 'exports', 'share', 'applications'),
  '/var/lib/snapd/desktop/applications',
];
const ICON_DIRS = [
  path.join(DATA_HOME, 'icons'), '/usr/local/share/icons', '/usr/share/icons',
  '/var/lib/flatpak/exports/share/icons', path.join(DATA_HOME, 'flatpak', 'exports', 'share', 'icons'),
  '/usr/share/pixmaps',
];

function binaryDir(exec) {
  const first = String(exec || '').trim().replace(/^"(.*)"$/, '$1').split(/\s+/)[0];
  if (!first || !path.isAbsolute(first)) return null;
  try { return path.dirname(fs.realpathSync(first)); } catch { return null; }
}

/** Whether a binary is an Electron app: the asar archive sits beside it. */
export function isElectron(exec) {
  const dir = binaryDir(exec);
  return !!dir && (fs.existsSync(path.join(dir, 'resources', 'app.asar')) || fs.existsSync(path.join(dir, 'resources', 'app')));
}

/** Chromium underneath, by either route — an Electron app, or a browser
 *  shipping its own Chromium. Either way --user-data-dir is understood. */
export function usesChromium(exec) {
  if (isElectron(exec)) return true;
  const dir = binaryDir(exec);
  if (!dir) return false;
  return ['icudtl.dat', 'resources.pak', 'chrome-sandbox', 'chrome_100_percent.pak']
    .some((m) => fs.existsSync(path.join(dir, m)));
}

export function parseDesktop(file) {
  const out = {};
  let inEntry = false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inEntry = line === '[Desktop Entry]'; continue; }
    if (!inEntry || !line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The application id in `flatpak run [options] <id>`, or null. Read from
 *  the Exec line rather than from the preset: whether an install is a Flatpak
 *  is a property of this machine, and the presets that most need the answer
 *  (the ones with extra environment to pin) are the ones least likely to
 *  have declared it. */
export function flatpakId(exec) {
  const m = /\bflatpak\s+run\b(.*)/.exec(String(exec || ''));
  if (!m) return null;
  const rest = m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
  return rest.length ? rest[0].replace(/^["']|["']$/g, '') : null;
}

// An AppImage carries its own .desktop and icon inside it. Ask the runtime
// for just those two, into a directory of ours, rather than unpacking a
// whole application to read two files.
function fromAppImage(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-appimage-'));
  const run = (pattern) => spawnSync(file, ['--appimage-extract', pattern], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
  try {
    run('*.desktop');
    run('.DirIcon');
    run('usr/share/icons/**');
    const root = path.join(dir, 'squashfs-root');
    if (!fs.existsSync(root)) return { exec: quote(file), icon: null, temp: dir };
    const desktop = fs.readdirSync(root).find((n) => n.endsWith('.desktop'));
    const entry = desktop ? parseDesktop(path.join(root, desktop)) : {};
    // .DirIcon is the icon the launcher shows; it is a PNG, or a link to one.
    let icon = null;
    for (const candidate of ['.DirIcon', `${entry.Icon}.png`, `usr/share/icons/hicolor/256x256/apps/${entry.Icon}.png`]) {
      const full = path.join(root, candidate);
      if (candidate && fs.existsSync(full) && fs.statSync(full).isFile()) { icon = full; break; }
    }
    return { exec: quote(file), entry, icon, temp: dir };
  } catch {
    return { exec: quote(file), icon: null, temp: dir };
  }
}

export function locate(app) {
  if (app.custom) {
    const p = path.resolve(app.source);
    if (!fs.existsSync(p)) return null;
    if (p.endsWith('.desktop')) {
      const d = parseDesktop(p);
      return { desktop: p, entry: d, exec: d.Exec, icon: d.Icon, flatpak: flatpakId(d.Exec) };
    }
    if (/\.appimage$/i.test(p)) return fromAppImage(p);
    return { exec: quote(p), icon: null };
  }
  const l = app.linux || {};
  for (const dir of APP_DIRS) {
    for (const id of l.desktop || []) {
      const file = path.join(dir, `${id}.desktop`);
      if (fs.existsSync(file)) {
        const d = parseDesktop(file);
        return { desktop: file, entry: d, exec: d.Exec, icon: d.Icon, flatpak: flatpakId(d.Exec) || (/flatpak run/.test(d.Exec || '') ? l.flatpak : null) };
      }
    }
  }
  for (const bin of l.bins || []) {
    const p = which(bin);
    if (p) return { exec: quote(p), icon: (l.desktop || [])[0] || null };
  }
  return null;
}

// Finding an icon by name means walking every installed theme, which is
// thousands of directories. Rebuilding several profiles of the same app would
// otherwise walk them once per profile.
const iconPaths = new Map();

function findIconFile(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) return fs.existsSync(nameOrPath) ? nameOrPath : null;
  if (iconPaths.has(nameOrPath)) return iconPaths.get(nameOrPath);
  const found = searchIconDirs(nameOrPath);
  iconPaths.set(nameOrPath, found);
  return found;
}

function searchIconDirs(nameOrPath) {
  let best = null, bestSize = 0;
  for (const root of ICON_DIRS) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (stack.length < 4000) stack.push(full); continue; }
        if (e.name !== `${nameOrPath}.png` && e.name !== `${nameOrPath}.svg`) continue;
        const m = /(\d+)x\d+/.exec(full);
        const size = e.name.endsWith('.svg') ? 1 : m ? parseInt(m[1], 10) : 48;
        if (size > bestSize) { best = full; bestSize = size; }
      }
    }
  }
  return best;
}

function rasterizeSvg(svg, outPng) {
  const attempts = [
    ['rsvg-convert', ['-w', '512', '-h', '512', '-o', outPng, svg]],
    ['inkscape', [svg, '-w', '512', '-h', '512', '-o', outPng]],
    ['convert', ['-background', 'none', '-resize', '512x512', svg, outPng]],
  ];
  for (const [bin, args] of attempts) {
    if (!which(bin)) continue;
    if (spawnSync(bin, args, { stdio: 'ignore' }).status === 0 && fs.existsSync(outPng)) return decodePng(fs.readFileSync(outPng));
  }
  throw new Error(`Icon ${svg} is SVG and no rasteriser (rsvg-convert, inkscape, convert) is installed. Pass --icon <png> instead.`);
}

export function build(app, opts, log = () => {}) {
  const found = locate(app);
  if (!found) throw new Error(`${app.name} isn't installed here (no .desktop entry or binary found for the ${app.id} preset).`);
  const iconsDir = path.join(DATA_HOME, 'dupe', 'icons');
  const iconName = `dupe-${app.id}-${opts.profile}`;

  let source;
  if (opts.iconFile) source = loadIcon(opts.iconFile);
  else {
    const iconPath = findIconFile(found.icon);
    if (!iconPath) throw new Error(`Couldn't find an icon for ${app.name}${found.icon ? ` (Icon=${found.icon})` : ''}. Pass --icon <file.png> and dupe will recolour that instead.`);
    source = iconPath.endsWith('.svg') ? rasterizeSvg(iconPath, path.join(os.tmpdir(), `${iconName}.png`)) : loadIcon(iconPath);
  }
  if (found.temp) fs.rmSync(found.temp, { recursive: true, force: true });
  const { master, treatment } = makeIcon(source, opts.color, opts.treatment);
  const pngs = writePngSet(master, iconsDir, iconName);
  // Also install into the hicolor theme so Icon=<name> resolves everywhere.
  for (const { size, file } of pngs) {
    const dir = path.join(DATA_HOME, 'icons', 'hicolor', `${size}x${size}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${iconName}.png`));
  }
  log(`  icon        ${source.width}px → ${opts.color} (${treatment})`);

  const wmClass = `${app.name.replace(/\s+/g, '')}-${opts.profile}`;
  const env = { ...(app.env ? app.env(opts.dataDir) : {}), ...(opts.extraEnv || {}) };
  const args = [`--user-data-dir=${opts.dataDir}`, `--class=${wmClass}`, ...(app.args ? app.args(opts.dataDir) : []), ...(opts.extraArgs || [])];
  fs.mkdirSync(opts.dataDir, { recursive: true });
  for (const v of Object.values(env)) if (v.startsWith(opts.dataDir)) fs.mkdirSync(v, { recursive: true });

  // Strip field codes from the stock Exec and append ours; Flatpak takes env
  // via --env, and needs the profile directory bound into its sandbox or the
  // app cannot write the one thing that makes it a separate profile.
  let exec = String(found.exec || '').replace(/\s%[a-zA-Z]/g, '').trim();
  if (found.flatpak) {
    const flags = [`--filesystem=${quote(opts.dataDir)}`, ...Object.entries(env).map(([k, v]) => `--env=${k}=${quote(v)}`)];
    exec = exec.replace(/flatpak run/, `flatpak run ${flags.join(' ')}`).trim();
  } else if (Object.keys(env).length) {
    exec = `env ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')} ${exec}`;
  }
  exec = `${exec} ${args.map(quote).join(' ')} %U`;

  const base = found.entry || {};
  const desktop = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${opts.label}`,
    `Comment=${app.name} · ${opts.profile} profile (dupe)`,
    `Exec=${exec}`,
    `Icon=${iconName}`,
    `StartupWMClass=${wmClass}`,
    'Terminal=false',
    base.Categories ? `Categories=${base.Categories}` : 'Categories=Utility;',
    base.MimeType ? `MimeType=${base.MimeType}` : null,
    'StartupNotify=true',
    `X-Dupe-App=${app.id}`,
    `X-Dupe-Profile=${opts.profile}`,
    '',
  ].filter((l) => l !== null).join('\n');
  const appsDir = path.join(DATA_HOME, 'applications');
  fs.mkdirSync(appsDir, { recursive: true });
  const desktopFile = path.join(appsDir, `${iconName}.desktop`);
  fs.writeFileSync(desktopFile, desktop, { mode: 0o755 });
  spawnSync('update-desktop-database', [appsDir], { stdio: 'ignore' });
  spawnSync('gtk-update-icon-cache', ['-q', '-t', '-f', path.join(DATA_HOME, 'icons', 'hicolor')], { stdio: 'ignore' });
  log(`  desktop     ${desktopFile}`);
  log(`  wm class    ${wmClass}`);

  return {
    app: app.id, appName: app.name, profile: opts.profile, label: opts.label, color: opts.color, treatment, custom: !!app.custom,
    platform: 'linux', dataDir: opts.dataDir, desktop: desktopFile, wmClass, iconName, source: found.desktop || found.exec,
    iconPng: (pngs.find((p) => p.size === 256) || pngs[pngs.length - 1]).file, iconFile: opts.iconFile || null,
    extraArgs: opts.extraArgs || [], extraEnv: opts.extraEnv || {}, builtAt: new Date().toISOString(),
  };
}

function quote(s) {
  return /[\s"'\\$`]/.test(s) ? `"${String(s).replace(/(["\\$`])/g, '\\$1')}"` : s;
}

export function remove(record, { purge = false } = {}, log = () => {}) {
  if (record.desktop && fs.existsSync(record.desktop)) { fs.rmSync(record.desktop); log(`  removed     ${record.desktop}`); }
  if (record.iconName) {
    const mine = new RegExp(`^${record.iconName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.png$`);
    for (const root of [path.join(DATA_HOME, 'icons', 'hicolor'), path.join(DATA_HOME, 'dupe', 'icons')]) {
      if (!fs.existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          // Exactly this profile's files: <name>.png in the theme and
          // <name>-<size>.png beside it. A prefix match would take
          // dupe-claude-work2's icons along with dupe-claude-work's.
          else if (mine.test(e.name)) fs.rmSync(full);
        }
      }
    }
  }
  if (purge && record.dataDir && fs.existsSync(record.dataDir)) { fs.rmSync(record.dataDir, { recursive: true, force: true }); log(`  removed     ${record.dataDir} (profile data)`); }
}

export function launch(record) {
  spawnSync('gio', ['launch', record.desktop], { stdio: 'ignore' });
}

/** A fingerprint of the stock app as it is right now: the .desktop entry it
 *  came from, the command that entry runs, and the size and mtime of both.
 *  A Linux profile runs the stock binary in place, so what a change means
 *  here is that the icon and the Exec line are worth refreshing. */
export function stamp(app) {
  const found = locate(app);
  if (!found) return null;
  const exec = String(found.exec || '').trim();
  const first = exec.startsWith('"') ? exec.slice(1, exec.indexOf('"', 1)) : exec.split(/\s+/)[0];
  const bits = [exec];
  let mtimeMs = 0;
  for (const file of [found.desktop, path.isAbsolute(first || '') ? first : null]) {
    if (!file) continue;
    try {
      const st = fs.statSync(file);
      bits.push(`${path.basename(file)}:${Math.floor(st.mtimeMs / 1000)}:${st.size}`);
      mtimeMs = Math.max(mtimeMs, st.mtimeMs);
    } catch { /* unreadable is as good as unchanged */ }
  }
  return { path: found.desktop || first || exec, version: null, id: bits.join('|'), mtimeMs };
}

/** Never busy: a Linux profile is a .desktop entry pointing at the stock
 *  binary, so rewriting it and its icons leaves running windows alone. */
export function running() {
  return false;
}

/** Electron apps with a .desktop entry that no preset covers. The entry
 *  points at a binary, and an Electron install keeps an app.asar beside it. */
export function discover() {
  const out = [];
  const seen = new Set();
  for (const dir of APP_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.desktop')) continue;
      if (name.startsWith('dupe-')) continue; // our own
      let d;
      try { d = parseDesktop(path.join(dir, name)); } catch { continue; }
      const exec = String(d.Exec || '').trim();
      const first = exec.startsWith('"') ? exec.slice(1, exec.indexOf('"', 1)) : exec.split(/\s+/)[0];
      if (!first || !path.isAbsolute(first)) continue;
      const real = fs.existsSync(first) ? fs.realpathSync(first) : null;
      if (!real || seen.has(real)) continue;
      seen.add(real);
      if (!fs.existsSync(path.join(path.dirname(real), 'resources', 'app.asar'))) continue;
      out.push({ name: d.Name || name.replace(/\.desktop$/, ''), path: path.join(dir, name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
