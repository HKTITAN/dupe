// Platform-neutral operations shared by the CLI and the local UI server.
import fs from 'node:fs';
import path from 'node:path';
import { APPS, findApp, customApp } from './apps.js';
import { NAMED, ORDER, resolveColor, nextColor } from './palette.js';
import { DUPE_HOME, loadStore, saveStore, upsertProfile, removeProfile, profileDataDir, slug, titleCase } from './store.js';

export async function backend() {
  switch (process.platform) {
    case 'win32': return import('./platform/win32.js');
    case 'darwin': return import('./platform/darwin.js');
    case 'linux': return import('./platform/linux.js');
    default: throw new Error(`No backend for ${process.platform}. See docs/ for Android and iOS.`);
  }
}

export function resolveApp(spec) {
  const preset = findApp(spec);
  if (preset) return preset;
  if (spec && fs.existsSync(spec)) return customApp(spec);
  throw new Error(`"${spec}" is neither a preset (see dupe list) nor a path that exists.`);
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

export function prepare(app, profileName, values, store, existing) {
  const profile = slug(profileName);
  if (!profile) throw new Error('Profile name must contain a letter or digit.');
  const used = store.profiles.filter((p) => p.app === app.id && p.profile !== profile).map((p) => p.color);
  const color = resolveColor(values.color) || (existing && existing.color) || nextColor(used);
  const label = values.label || (existing && existing.label) || `${app.name} ${titleCase(profile)}`;
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
  return {
    platform: process.platform,
    apps,
    profiles: store.profiles,
    colors: ORDER.map((name) => ({ name, hex: NAMED[name] })),
  };
}

export async function add(appSpec, profileName, values = {}, log = () => {}) {
  const be = await backend();
  const app = resolveApp(appSpec);
  const store = loadStore();
  const existing = store.profiles.find((p) => p.app === app.id && p.profile === slug(profileName));
  const opts = prepare(app, profileName, values, store, existing);
  log(`${app.name} · ${opts.profile}  "${opts.label}"  ${opts.color}`);
  const record = be.build(app, opts, log);
  upsertProfile(store, record);
  saveStore(store);
  return record;
}

export async function remove(appSpec, profileName, { purge = false } = {}, log = () => {}) {
  const be = await backend();
  const store = loadStore();
  const app = resolveApp(appSpec);
  const profile = slug(profileName);
  const record = store.profiles.find((p) => p.app === app.id && p.profile === profile);
  if (!record) throw new Error(`No profile ${app.id}/${profile}. Run dupe list.`);
  log(`${record.appName} · ${record.profile}`);
  be.remove(record, { purge }, log);
  removeProfile(store, app.id, profile);
  saveStore(store);
  return record;
}

export async function rebuild(appSpec, values = {}, log = () => {}) {
  const be = await backend();
  const store = loadStore();
  const only = appSpec ? resolveApp(appSpec).id : null;
  const targets = store.profiles.filter((p) => !only || p.app === only);
  const results = [];
  for (const old of targets) {
    const app = findApp(old.app) || customApp(old.source, old.appName);
    const opts = prepare(app, old.profile, values, store, old);
    log(`${app.name} · ${opts.profile}  "${opts.label}"  ${opts.color}`);
    try {
      const record = be.build(app, opts, log);
      upsertProfile(store, record);
      saveStore(store);
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
  const store = loadStore();
  const app = resolveApp(appSpec);
  const record = store.profiles.find((p) => p.app === app.id && p.profile === slug(profileName));
  if (!record) throw new Error(`No profile ${app.id}/${slug(profileName)}. Run dupe list.`);
  be.launch(record);
  return record;
}
