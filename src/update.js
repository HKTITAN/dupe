// Keeping profiles current with the app they were built from.
//
// Every profile record carries a fingerprint of the stock app as it was at
// build time (`sourceStamp`, from the platform backend's stamp()). Comparing
// it with the app as it is now says whether the profile is behind — on macOS
// that matters most, because the clone is a copy, but a Windows or Linux
// profile still wants its icon re-derived when the app changes its own.
//
// This is the middle of three things that keep a profile current. The clone's
// own launcher catches up at the moment you open it (platform/darwin.js), the
// scheduled job here catches up while you aren't looking (schedule.js), and
// `dupe update` is the same work on demand.
//
// What this deliberately does not do is rebuild while you are using the
// thing: a rebuild replaces the clone (macOS) or the launcher (Windows), so a
// profile that is open is left for the next round instead.
import fs from 'node:fs';
import path from 'node:path';
import { findApp, customApp } from './apps.js';
import * as core from './core.js';
import { LOG_FILE, commitProfile, loadStore, slug } from './store.js';
import { VERSION } from './embedded.js';
import { writeState } from './schedule.js';

// A stock app that changed a moment ago may still be mid-write — an app
// updating itself replaces a bundle file by file. Scheduled runs wait for it
// to settle rather than cloning something half-written.
const SETTLE_AFTER = 90_000;
const SETTLE_LIMIT = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

/** The preset (or custom app) a stored profile was built from. A record
 *  that says it is custom is never resolved to a preset, so an app called
 *  Chrome.exe in a folder of your own is not rebuilt from Google Chrome. */
export function appOf(record) {
  if (record.custom) return customApp(record.source || record.app, record.appName);
  return findApp(record.app) || customApp(record.source || record.app, record.appName);
}

/**
 * Where a profile stands against the app it was built from.
 *  - `missing`  the stock app is gone (uninstalled, or moved out of reach)
 *  - `stale`    the app has changed since this profile was built
 *  - `current`  nothing to do
 * Profiles built before fingerprints existed have none to compare, so they
 * fall back to the honest question: is the app newer than the profile?
 */
export function classify(record, stamp, version = null) {
  if (!stamp) return 'missing';
  // A profile is also behind when dupe itself has moved on: the launcher it
  // was built with is part of the profile, so improvements to it only reach
  // a machine by rebuilding. This is how an upgrade of dupe gets applied.
  if (version && record.builtBy !== version) return 'stale';
  if (!record.sourceStamp) {
    const built = Date.parse(record.builtAt || '') || 0;
    return built && stamp.mtimeMs && stamp.mtimeMs > built + 1000 ? 'stale' : 'current';
  }
  return record.sourceStamp === stamp.id ? 'current' : 'stale';
}

/** Why a profile is behind, in words, for `dupe status`. The app moving is
 *  the more interesting answer when both are true. */
export function whyStale(record, stamp, version = null) {
  if (!stamp) return null;
  if (record.sourceStamp ? record.sourceStamp !== stamp.id : false) {
    return stamp.version ? `the app is now ${stamp.version}` : 'the app has changed';
  }
  if (version && record.builtBy !== version) {
    return `built by dupe ${record.builtBy || 'before it kept track'}`;
  }
  if (!record.sourceStamp) return 'the app has changed';
  return null;
}

/** Which profiles are behind the app they wrap, without changing anything. */
export async function check({ app, profile } = {}) {
  const be = await core.backend();
  const store = loadStore();
  const only = app ? core.resolveApp(app).id : null;
  const onlyProfile = profile ? slug(profile) : null;
  const stamps = new Map();
  const profiles = [];
  const adopted = [];

  for (const record of store.profiles) {
    if (only && record.app !== only) continue;
    if (onlyProfile && record.profile !== onlyProfile) continue;
    if (!stamps.has(record.app)) stamps.set(record.app, safe(() => be.stamp(appOf(record))));
    const stamp = stamps.get(record.app);
    const state = classify(record, stamp, VERSION);
    // First look at a profile built by an older dupe: adopt today's
    // fingerprint so every later check is an exact comparison.
    if (stamp && state === 'current' && record.sourceStamp !== stamp.id) { record.sourceStamp = stamp.id; adopted.push({ ...record }); }
    profiles.push({
      app: record.app, appName: record.appName, profile: record.profile, label: record.label, color: record.color,
      state, why: state === 'stale' ? whyStale(record, stamp, VERSION) : null,
      version: stamp ? stamp.version : null, source: stamp ? stamp.path : record.source,
      builtAt: record.builtAt || null, builtBy: record.builtBy || null,
      running: state === 'stale' ? !!safe(() => be.running(record), false) : false,
    });
  }
  for (const record of adopted) commitProfile(record, { ifPresent: true });

  const count = (s) => profiles.filter((p) => p.state === s).length;
  return { platform: process.platform, profiles, stale: count('stale'), missing: count('missing'), current: count('current') };
}

// Wait until the stock app has stopped changing, so a clone is taken of a
// finished update rather than a half-written one.
async function settle(be, app, stamp) {
  let last = stamp;
  const until = Date.now() + SETTLE_LIMIT;
  while (Date.now() < until) {
    const age = last.mtimeMs ? Date.now() - last.mtimeMs : Infinity;
    if (age >= SETTLE_AFTER) return last;
    await sleep(Math.min(15_000, SETTLE_AFTER - age + 1000));
    const now = safe(() => be.stamp(app));
    if (!now) return null;
    last = now;
  }
  return null; // still churning; the next run will pick it up
}

/**
 * Rebuild the profiles whose stock app has changed.
 * @param {{app?:string, all?:boolean, force?:boolean, scheduled?:boolean}} opts
 *   all       rebuild every profile, changed or not
 *   force     rebuild even a profile that is open right now
 *   scheduled quiet, logged to file, and patient with apps mid-update
 */
export async function update({ app, profile, all = false, force = false, scheduled = false } = {}, log = () => {}) {
  const be = await core.backend();
  const store = loadStore();
  const only = app ? core.resolveApp(app).id : null;
  const onlyProfile = profile ? slug(profile) : null;
  const stamps = new Map();
  const result = { updated: [], deferred: [], failed: [], missing: [], current: 0, checked: 0 };

  for (const record of store.profiles) {
    if (only && record.app !== only) continue;
    if (onlyProfile && record.profile !== onlyProfile) continue;
    result.checked++;
    const preset = appOf(record);
    if (!stamps.has(record.app)) stamps.set(record.app, safe(() => be.stamp(preset)));
    let stamp = stamps.get(record.app);
    const state = classify(record, stamp, VERSION);
    const where = `${record.appName} · ${record.profile}`;

    if (state === 'missing') {
      result.missing.push({ app: record.app, profile: record.profile, label: record.label });
      log(`${where}  skipped — ${record.appName} isn't installed here any more`);
      continue;
    }
    if (state === 'current' && !all) {
      result.current++;
      if (stamp && record.sourceStamp !== stamp.id) commitProfile({ ...record, sourceStamp: stamp.id }, { ifPresent: true });
      continue;
    }
    if (!force && safe(() => be.running(record), false)) {
      result.deferred.push({ app: record.app, profile: record.profile, label: record.label });
      log(`${where}  open right now — leaving it until it's closed`);
      continue;
    }
    if (scheduled && state === 'stale') {
      stamp = await settle(be, preset, stamp);
      if (!stamp) {
        result.deferred.push({ app: record.app, profile: record.profile, label: record.label, reason: 'updating' });
        log(`${where}  ${record.appName} is still being written — waiting for the next round`);
        continue;
      }
      stamps.set(record.app, stamp);
    }

    log(`${where}  "${record.label}"  ${record.color}`);
    if (stamp && stamp.version) log(`  stock app   ${path.basename(stamp.path)} ${stamp.version}`);
    try {
      const opts = core.prepare(preset, record.profile, {}, store, record);
      const built = be.build(preset, opts, log);
      // darwin records its own while cloning; the rest are stamped here.
      built.sourceStamp = built.sourceStamp || (stamp || {}).id || null;
      built.builtBy = VERSION;
      // Into the store as it is now, not the copy read before the rebuild —
      // and not at all if the profile was removed while we were building.
      commitProfile(built, { ifPresent: true });
      result.updated.push({ app: built.app, profile: built.profile, label: built.label, version: stamp ? stamp.version : null });
    } catch (e) {
      result.failed.push({ app: record.app, profile: record.profile, label: record.label, error: e.message });
      log(`  failed      ${e.message}`);
    }
  }
  return result;
}

/** One line summarising what a run did, for the CLI and the log. */
export function summarize(r) {
  if (!r.checked) return 'No profiles yet.';
  const parts = [];
  if (r.updated.length) parts.push(`${r.updated.length} updated`);
  if (r.deferred.length) parts.push(`${r.deferred.length} left open`);
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  if (r.missing.length) parts.push(`${r.missing.length} missing`);
  if (r.current) parts.push(`${r.current} already current`);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing to do.';
}

/** Append to ~/.dupe/logs/autoupdate.log, keeping it small. */
export function appendLog(lines) {
  if (!lines.length) return;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, lines.map((l) => `${at}  ${l}`).join('\n') + '\n');
    if (fs.statSync(LOG_FILE).size > 128 * 1024) {
      fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-400).join('\n'));
    }
  } catch { /* the log is a convenience, never a reason to fail a run */ }
}

/** What the scheduled job runs. Silent unless it did something. */
export async function scheduledRun({ app, profile } = {}) {
  const lines = [];
  const r = await update({ app, profile, scheduled: true }, (l) => lines.push(l));
  const did = r.updated.length || r.deferred.length || r.failed.length;
  if (did) appendLog([...lines, summarize(r)]);
  writeState({
    lastRun: {
      at: new Date().toISOString(),
      checked: r.checked, updated: r.updated.length, deferred: r.deferred.length,
      failed: r.failed.length, missing: r.missing.length,
    },
  });
  return r;
}
