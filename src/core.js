// Platform-neutral operations shared by the CLI and the local UI server.
import fs from 'node:fs';
import path from 'node:path';
import { APPS, findApp, customApp } from './apps.js';
import { NAMED, ORDER, resolveColor, nextColor } from './palette.js';
import * as schedule from './schedule.js';
import { DUPE_HOME, commitProfile, commitRemoval, loadStore, profileDataDir, slug, titleCase } from './store.js';
import { VERSION } from './embedded.js';

export async function backend() {
  switch (process.platform) {
    case 'win32': return import('./platform/win32.js');
    case 'darwin': return import('./platform/darwin.js');
    case 'linux': return import('./platform/linux.js');
    default: throw new Error(`No backend for ${process.platform}. See docs/ for Android and iOS.`);
  }
}

/**
 * The app a command is about: a preset id, a path, or — given a backend to
 * ask — the name of any Electron app installed here. The last one is what
 * makes `dupe add canva work` work without Canva ever having been added to
 * the preset list: dupe profiles anything that honours --user-data-dir, and
 * an Electron install is recognisable on sight.
 */
export function resolveApp(spec, be = null) {
  const preset = findApp(spec);
  if (preset) return preset;
  if (spec && fs.existsSync(spec)) return customApp(spec);
  if (be && be.discover) {
    const want = slug(spec);
    let hit = null;
    try { hit = be.discover().find((o) => slug(o.name) === want); } catch { /* fall through to the error */ }
    if (hit) return customApp(hit.path, hit.name);
  }
  throw new Error(`"${spec}" is not a preset, an app on this machine, or a path that exists. dupe list shows what's here.`);
}

export function parseEnv(list) {
  const out = {};
  for (const kv of list || []) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new Error(`--env expects KEY=VALUE, got "${kv}"`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

const TREATMENTS = new Set(['auto', 'hue', 'ramp-light', 'ramp-dark', 'none']);

// A label becomes a filename, a .desktop Name, a Start Menu shortcut and a
// macOS bundle name, so what it may contain is the intersection of what all
// of those accept.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function checkLabel(label) {
  const bad = ILLEGAL.exec(label);
  if (bad) throw new Error(`A label can't contain ${JSON.stringify(bad[0])} — it becomes a filename. Try --label "${label.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim()}".`);
  if (!label.trim()) throw new Error('A label needs some text in it.');
  if (label !== label.trim() || label.endsWith('.')) throw new Error("A label can't start or end with a space or a dot.");
  if (RESERVED.test(label)) throw new Error(`"${label}" is a reserved device name on Windows; pick another label.`);
  if (label.length > 64) throw new Error(`That label is ${label.length} characters; keep it under 64.`);
  return label;
}

export function prepare(app, profileName, values, store, existing) {
  const profile = slug(profileName);
  if (!profile) throw new Error('Profile name must contain a letter or digit.');
  const used = store.profiles.filter((p) => p.app === app.id && p.profile !== profile).map((p) => p.color);
  const color = resolveColor(values.color) || (existing && existing.color) || nextColor(used);
  const label = checkLabel(values.label || (existing && existing.label) || `${app.name} ${titleCase(profile)}`);
  const treatment = values.treatment || (existing && existing.treatment) || 'auto';
  if (!TREATMENTS.has(treatment)) throw new Error(`Treatment must be one of ${[...TREATMENTS].join(', ')}.`);
  // A custom icon may arrive as a path (--icon) or as base64 PNG data from
  // the interface; the data is saved once so rebuilds keep using it.
  let iconFile = values.icon ? path.resolve(values.icon) : null;
  if (values.iconData) {
    const dir = path.join(DUPE_HOME, 'icons');
    fs.mkdirSync(dir, { recursive: true });
    iconFile = path.join(dir, `${app.id}-${profile}-source.png`);
    fs.writeFileSync(iconFile, Buffer.from(String(values.iconData).replace(/^data:[^,]*,/, ''), 'base64'));
  }
  if (!iconFile && existing && existing.iconFile && fs.existsSync(existing.iconFile) && values.icon !== '') iconFile = existing.iconFile;
  return {
    profile, label, color, treatment,
    dataDir: (existing && existing.dataDir) || profileDataDir(app.id, profile),
    extraArgs: values.arg && values.arg.length ? values.arg : (existing && existing.extraArgs) || [],
    extraEnv: values.env && values.env.length ? parseEnv(values.env) : (existing && existing.extraEnv) || {},
    iconFile,
  };
}

/** A fingerprint of the stock app as it is right now, recorded on the profile
 *  so `dupe update` can tell later whether the app moved on without it. */
export function stampId(be, app) {
  try {
    const s = be.stamp ? be.stamp(app) : null;
    return s ? s.id : null;
  } catch {
    return null;
  }
}

/**
 * How confident dupe is that this app will actually honour the flag that
 * makes a profile a profile.
 *
 * The presets are curated: someone checked. Anything else is read off the
 * disk — is there Chromium under this, by either route, an Electron app's
 * asar or a browser's own Chromium framework and data files. If there is,
 * --user-data-dir is understood and the profile is real.
 *
 * Absence of that sign is not proof the app ignores the flag, so this warns
 * and never refuses. Getting it wrong the other way is what matters: a user
 * who believes two copies are separate when they share one login is worse
 * off than one who was told the tool could not tell.
 */
export function isolation(app, be) {
  if (!app.custom) return { confident: true, why: 'a preset dupe has checked' };
  try {
    const where = be.locate(app);
    const target = where && (where.bundle || where.exe || where.exec);
    if (target && be.usesChromium && be.usesChromium(target)) return { confident: true, why: 'Chromium underneath, so the flag is understood' };
  } catch { /* fall through to the honest answer */ }
  return { confident: false, why: "dupe can't tell whether this app reads --user-data-dir" };
}

export function hint(record) {
  switch (record.platform) {
    case 'win32': return "It's in the Start Menu; pin it to the taskbar from there.";
    case 'darwin': return 'Open it from Launchpad or Spotlight and keep it in the Dock.';
    default: return "It's in your app launcher; pin it to the dock from there.";
  }
}

/** Presets with their on-disk location, plus every built profile. */
export async function state() {
  const be = await backend();
  const store = loadStore();
  const apps = APPS.map((app) => {
    let where = null;
    try { where = be.locate(app); } catch { where = null; }
    const found = where ? (where.exe || where.bundle || where.desktop || where.exec) : null;
    return { id: app.id, name: app.name, kind: app.kind, verified: !!app.verified, found, path: found };
  });
  // Anything Electron that no preset covers. dupe works on these too — they
  // just have to be named by path — so listing them is the difference
  // between "dupe supports twelve apps" and "dupe supports what you have".
  let others = [];
  try {
    const known = new Set(apps.map((a) => a.found && path.resolve(a.found).toLowerCase()).filter(Boolean));
    others = (be.discover ? be.discover() : []).filter((o) => !known.has(path.resolve(o.path).toLowerCase()));
  } catch { /* discovery is a convenience */ }

  return {
    platform: process.platform,
    apps,
    others,
    profiles: store.profiles,
    colors: ORDER.map((name) => ({ name, hex: NAMED[name] })),
    autoupdate: schedule.status(),
  };
}

export async function add(appSpec, profileName, values = {}, log = () => {}) {
  const be = await backend();
  const app = resolveApp(appSpec, be);
  const store = loadStore();
  const existing = store.profiles.find((p) => p.app === app.id && p.profile === slug(profileName));
  const opts = prepare(app, profileName, values, store, existing);
  log(`${app.name} · ${opts.profile}  "${opts.label}"  ${opts.color}`);
  const sure = isolation(app, be);
  const record = be.build(app, opts, log);
  if (!record.sourceStamp) record.sourceStamp = stampId(be, app);
  record.builtBy = VERSION;
  record.isolationChecked = sure.confident;
  commitProfile(record);
  schedule.refresh(); // macOS watches the bundles it was built from
  return record;
}

/** The stored profile for an app spec: a preset id, a path, or the id
 *  `dupe list` prints. Looked up in the store rather than on disk, so a
 *  profile of an app that has since been uninstalled or moved can still be
 *  removed and opened. */
export function findProfile(store, appSpec, profileName) {
  const profile = slug(profileName);
  const preset = findApp(appSpec);
  const spec = String(appSpec || '');
  const resolved = path.isAbsolute(spec) ? path.resolve(spec) : null;
  return store.profiles.find((p) => p.profile === profile && (
    (preset && p.app === preset.id) ||
    p.app === slug(spec) ||
    (resolved && p.source && path.resolve(p.source) === resolved)
  )) || null;
}

export async function remove(appSpec, profileName, { purge = false } = {}, log = () => {}) {
  const be = await backend();
  const store = loadStore();
  const record = findProfile(store, appSpec, profileName);
  if (!record) throw new Error(`No profile ${slug(String(appSpec))}/${slug(profileName)}. Run dupe list.`);
  const app = { id: record.app };
  const profile = record.profile;
  log(`${record.appName} · ${record.profile}`);
  be.remove(record, { purge }, log);
  commitRemoval(app.id, profile);
  schedule.refresh();
  return record;
}

export async function rebuild(appSpec, values = {}, log = () => {}) {
  const be = await backend();
  const store = loadStore();
  const only = appSpec ? resolveApp(appSpec, be).id : null;
  const targets = store.profiles.filter((p) => !only || p.app === only);
  const results = [];
  for (const old of targets) {
    const app = old.custom ? customApp(old.source, old.appName) : (findApp(old.app) || customApp(old.source, old.appName));
    const opts = prepare(app, old.profile, values, store, old);
    log(`${app.name} · ${opts.profile}  "${opts.label}"  ${opts.color}`);
    try {
      const record = be.build(app, opts, log);
      if (!record.sourceStamp) record.sourceStamp = stampId(be, app);
      record.builtBy = VERSION;
      commitProfile(record, { ifPresent: true });
      results.push({ ok: true, record });
    } catch (e) {
      log(`  skipped     ${e.message}`);
      results.push({ ok: false, app: old.app, profile: old.profile, error: e.message });
    }
  }
  return results;
}

export async function open(appSpec, profileName) {
  const be = await backend();
  const record = findProfile(loadStore(), appSpec, profileName);
  if (!record) throw new Error(`No profile ${slug(String(appSpec))}/${slug(profileName)}. Run dupe list.`);
  be.launch(record);
  return record;
}
