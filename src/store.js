// Per-user record of built profiles, so `list`, `remove` and `rebuild` know
// what exists without scanning the filesystem. Lives at ~/.dupe/profiles.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const DUPE_HOME = process.env.DUPE_HOME || path.join(HOME, '.dupe');
const FILE = path.join(DUPE_HOME, 'profiles.json');

export function loadStore() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, profiles: [] };
    throw new Error(`Couldn't read ${FILE}: ${e.message}`);
  }
  try {
    const store = JSON.parse(text);
    if (!store || !Array.isArray(store.profiles)) throw new Error('no profiles array');
    return store;
  } catch (e) {
    // Never answer "no profiles" for a file that is merely unreadable: the
    // next `add` would write a fresh store over it and every other profile
    // would be gone. Keep the evidence and say where it went.
    const kept = `${FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(FILE, kept); } catch { /* best effort */ }
    throw new Error(`${FILE} isn't readable JSON (${e.message}). Moved it to ${kept}; run the same command again to start a fresh one.`);
  }
}

export function saveStore(store) {
  fs.mkdirSync(DUPE_HOME, { recursive: true });
  // Write then rename, so a reader — or a crash — never sees half a file.
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

export function upsertProfile(store, record) {
  const i = store.profiles.findIndex((p) => p.app === record.app && p.profile === record.profile);
  if (i >= 0) store.profiles[i] = record; else store.profiles.push(record);
}

export function removeProfile(store, app, profile) {
  store.profiles = store.profiles.filter((p) => !(p.app === app && p.profile === profile));
}

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * A short exclusive lock around one read-modify-write of profiles.json.
 *
 * Five things write this file now — the CLI, the interface, the MCP server,
 * the scheduled job, and a macOS clone healing itself at launch — and a
 * rebuild can take minutes, so "load at the start, save at the end" would
 * put back a store the others have moved on from. The lock is therefore
 * never held across a build or a settle wait, only across the few file
 * operations that follow one. If it can't be taken, we write anyway: losing
 * the lock is not a reason to lose the work.
 */
function withLock(fn) {
  fs.mkdirSync(DUPE_HOME, { recursive: true });
  const lock = path.join(DUPE_HOME, 'profiles.lock');
  let fd = null;
  for (let i = 0; i < 100 && fd === null; i++) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') break;
      // Break one left behind by a process that died holding it.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); } catch { /* raced */ }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
    }
  }
}

/** Write one profile into whatever the store says right now, rather than
 *  into a copy of it read minutes ago. `ifPresent` declines to resurrect a
 *  profile that was removed while its rebuild was running. */
export function commitProfile(record, { ifPresent = false } = {}) {
  return withLock(() => {
    const store = loadStore();
    const here = store.profiles.some((p) => p.app === record.app && p.profile === record.profile);
    if (ifPresent && !here) return null;
    upsertProfile(store, record);
    saveStore(store);
    return record;
  });
}

/** Drop one profile from whatever the store says right now. */
export function commitRemoval(app, profile) {
  return withLock(() => {
    const store = loadStore();
    removeProfile(store, app, profile);
    saveStore(store);
    return store;
  });
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
