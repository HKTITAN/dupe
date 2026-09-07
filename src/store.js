// Per-user record of built profiles, so `list`, `remove` and `rebuild` know
// what exists without scanning the filesystem. Lives at ~/.dupe/profiles.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const DUPE_HOME = process.env.DUPE_HOME || path.join(HOME, '.dupe');
const FILE = path.join(DUPE_HOME, 'profiles.json');

export function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { version: 1, profiles: [] };
  }
}

export function saveStore(store) {
  fs.mkdirSync(DUPE_HOME, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n');
}

export function upsertProfile(store, record) {
  const i = store.profiles.findIndex((p) => p.app === record.app && p.profile === record.profile);
  if (i >= 0) store.profiles[i] = record; else store.profiles.push(record);
}

export function removeProfile(store, app, profile) {
  store.profiles = store.profiles.filter((p) => !(p.app === app && p.profile === profile));
}

/** Where a profile's app data lives. Outside the app bundle or launcher, so
 *  rebuilding never touches logins or history. */
export function profileDataDir(appId, profile) {
  switch (process.platform) {
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support', 'dupe', appId, profile);
    case 'win32':
      // Deliberately outside AppData: a process running with MSIX package
      // identity (a terminal opened from a Store app, say) has its AppData
      // writes silently redirected into the package's private cache, where
      // Explorer and the taskbar never see them. %USERPROFILE% itself is
      // never virtualized.
      return path.join(DUPE_HOME, 'data', appId, profile);
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'dupe', appId, profile);
  }
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function titleCase(s) {
  return String(s).split(/[\s_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Where the background updater writes what it did. */
export const LOG_FILE = path.join(DUPE_HOME, 'logs', 'autoupdate.log');
