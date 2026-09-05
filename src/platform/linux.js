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

export function locate(app) {
  if (app.custom) {
    const p = path.resolve(app.source);
    if (!fs.existsSync(p)) return null;
    if (p.endsWith('.desktop')) {
      const d = parseDesktop(p);
      return { desktop: p, entry: d, exec: d.Exec, icon: d.Icon };
    }
    return { exec: quote(p), icon: null };
  }
  const l = app.linux || {};
  for (const dir of APP_DIRS) {
    for (const id of l.desktop || []) {
      const file = path.join(dir, `${id}.desktop`);
      if (fs.existsSync(file)) {
        const d = parseDesktop(file);
        return { desktop: file, entry: d, exec: d.Exec, icon: d.Icon, flatpak: /flatpak run/.test(d.Exec || '') ? l.flatpak : null };
      }
    }
  }
  for (const bin of l.bins || []) {
    const p = which(bin);
    if (p) return { exec: quote(p), icon: (l.desktop || [])[0] || null };
  }
  return null;
}

function findIconFile(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) return fs.existsSync(nameOrPath) ? nameOrPath : null;
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
    if (!iconPath) throw new Error(`Couldn't find an icon for ${app.name} (Icon=${found.icon}). Pass --icon <png>.`);
    source = iconPath.endsWith('.svg') ? rasterizeSvg(iconPath, path.join(os.tmpdir(), `${iconName}.png`)) : loadIcon(iconPath);
  }
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

  // Strip field codes from the stock Exec and append ours; Flatpak takes env via --env.
  let exec = String(found.exec || '').replace(/\s%[a-zA-Z]/g, '').trim();
  if (found.flatpak) {
    const envFlags = Object.entries(env).map(([k, v]) => `--env=${k}=${quote(v)}`).join(' ');
    exec = exec.replace(/flatpak run/, `flatpak run ${envFlags}`).trim();
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
    app: app.id, appName: app.name, profile: opts.profile, label: opts.label, color: opts.color, treatment,
    platform: 'linux', dataDir: opts.dataDir, desktop: desktopFile, wmClass, iconName, source: found.desktop || found.exec,
    extraArgs: opts.extraArgs || [], extraEnv: opts.extraEnv || {}, builtAt: new Date().toISOString(),
  };
}

function quote(s) {
  return /[\s"'\\$`]/.test(s) ? `"${String(s).replace(/(["\\$`])/g, '\\$1')}"` : s;
}

export function remove(record, { purge = false } = {}, log = () => {}) {
  if (record.desktop && fs.existsSync(record.desktop)) { fs.rmSync(record.desktop); log(`  removed     ${record.desktop}`); }
  if (record.iconName) {
    for (const root of [path.join(DATA_HOME, 'icons', 'hicolor'), path.join(DATA_HOME, 'dupe', 'icons')]) {
      if (!fs.existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name.startsWith(record.iconName)) fs.rmSync(full);
        }
      }
    }
  }
  if (purge && record.dataDir && fs.existsSync(record.dataDir)) { fs.rmSync(record.dataDir, { recursive: true, force: true }); log(`  removed     ${record.dataDir} (profile data)`); }
}

export function launch(record) {
  spawnSync('gio', ['launch', record.desktop], { stdio: 'ignore' });
}
