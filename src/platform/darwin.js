// macOS backend. A straight generalisation of Stephen Wu's
// Rebuild-Work-Apps.command: APFS-clone the stock bundle, swap the binary
// for a launcher script that pins the profile, recolour the .icns, patch
// Info.plist so macOS sees a distinct app, ad-hoc re-sign, drop quarantine.
//
// A clone is a copy, so it does not inherit the stock app's own updater —
// that is switched off deliberately, or two copies would fight over the same
// install. Instead the clone keeps itself level with the app it came from:
// the launcher script compares the two at every launch and re-clones first if
// they differ (see selfHealScript), and the background agent does the same
// while you aren't looking (see ../schedule.js). Profile data lives outside
// the bundle, so none of that touches a login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { decodePng } from '../image/png.js';
import { largestFromIcns } from '../image/icns.js';
import { loadIcon, makeIcon, writeIcnsFile, writePng } from '../icon.js';
import { selfCommand } from '../schedule.js';
import { LOG_FILE } from '../store.js';

const PB = '/usr/libexec/PlistBuddy';
const APPS_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')];

function plist(file, cmd) {
  return execFileSync(PB, ['-c', cmd, file], { encoding: 'utf8' }).trim();
}
function plistTry(file, cmd) {
  try { return plist(file, cmd); } catch { return null; }
}

export function locate(app) {
  if (app.custom) {
    const p = path.resolve(app.source);
    return fs.existsSync(path.join(p, 'Contents', 'Info.plist')) ? { bundle: p } : null;
  }
  for (const dir of APPS_DIRS) {
    for (const name of (app.darwin && app.darwin.bundles) || []) {
      const bundle = path.join(dir, name);
      if (fs.existsSync(path.join(bundle, 'Contents', 'Info.plist'))) return { bundle };
    }
  }
  return null;
}

export function isElectron(bundle) {
  return fs.existsSync(path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework')) ||
    fs.existsSync(path.join(bundle, 'Contents', 'Resources', 'app.asar'));
}

/** Chromium underneath, by either route: an Electron app, or a browser that
 *  ships its own Chromium framework (Chrome, Edge, Brave, Vivaldi, Arc). */
export function usesChromium(bundle) {
  if (isElectron(bundle)) return true;
  let frameworks = [];
  try { frameworks = fs.readdirSync(path.join(bundle, 'Contents', 'Frameworks')); } catch { return false; }
  return frameworks.some((f) => /(Chromium|Chrome|Electron|CEF)\b.*\.framework$/i.test(f));
}

// Render the icon macOS actually shows (Assets.car or icns) to a 1024px PNG,
// the way the original script did, for bundles whose .icns has no PNG sizes.
function renderIconViaAppKit(bundle, outPng) {
  const jxa = `ObjC.import("AppKit");
function run(argv) {
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(1024, 1024));
  img.lockFocus;
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 1024, 1024), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
  img.unlockFocus;
  const bm = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  bm.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary).writeToFileAtomically(argv[1], true);
  return "ok";
}`;
  const tmp = path.join(os.tmpdir(), `dupe-geticon-${process.pid}.js`);
  fs.writeFileSync(tmp, jxa);
  try { execFileSync('osascript', ['-l', 'JavaScript', tmp, bundle, outPng]); } finally { fs.rmSync(tmp, { force: true }); }
  return decodePng(fs.readFileSync(outPng));
}

function loadBundleIcon(bundle, iconFile, tmpDir) {
  const icns = iconFile ? path.join(bundle, 'Contents', 'Resources', iconFile) : null;
  if (icns && fs.existsSync(icns)) {
    const img = largestFromIcns(fs.readFileSync(icns));
    if (img) return img;
  }
  return renderIconViaAppKit(bundle, path.join(tmpDir, 'source.png'));
}

export function build(app, opts, log = () => {}) {
  const found = locate(app);
  if (!found) throw new Error(`${app.name} isn't installed here (looked in ${APPS_DIRS.join(' and ')}).`);
  const src = found.bundle;
  const srcStamp = stampBundle(src);
  const dup = path.join(path.dirname(src), `${opts.label}.app`);
  // "dupe add claude claude" would otherwise name the clone /Applications/
  // Claude.app — the app it is about to be copied from — and delete it.
  if (path.resolve(dup) === path.resolve(src)) {
    throw new Error(`A profile called "${opts.label}" would land on ${src}, the app it is copied from. Pass --label to give it a different name.`);
  }
  // Everything is built here and moved into place at the end, so a failure
  // half way leaves the profile you already had, not a broken bundle.
  const staging = `${dup}.dupe-building`;
  const info = path.join(src, 'Contents', 'Info.plist');
  const exeName = plist(info, 'Print :CFBundleExecutable');
  let iconFile = plistTry(info, 'Print :CFBundleIconFile') || 'electron.icns';
  if (!iconFile.endsWith('.icns')) iconFile += '.icns';
  const oldId = plist(info, 'Print :CFBundleIdentifier');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-'));

  try {
    // Icon first, so a bad icon never leaves a half-built bundle behind.
    const source = opts.iconFile ? loadIcon(opts.iconFile) : loadBundleIcon(src, iconFile, tmp);
    const { master, treatment } = makeIcon(source, opts.color, opts.treatment);
    log(`  icon        ${opts.iconFile ? path.basename(opts.iconFile) : iconFile} ${source.width}px → ${opts.color} (${treatment})`);

    log(`  clone       ${dup}`);
    fs.rmSync(staging, { recursive: true, force: true });
    // APFS copy-on-write clone; falls back to a plain copy on other filesystems.
    // Root-owned unreadable files are skipped — the app can't read them either,
    // so cp reporting failure doesn't mean the copy is unusable. What matters
    // is whether the parts we are about to edit arrived.
    let r = spawnSync('cp', ['-Rc', src, staging], { encoding: 'utf8' });
    if (!cloned(staging, exeName)) {
      fs.rmSync(staging, { recursive: true, force: true });
      r = spawnSync('cp', ['-R', src, staging], { encoding: 'utf8' });
      if (!cloned(staging, exeName)) {
        throw new Error(`Couldn't copy ${src}: ${(r.stderr || '').trim() || `cp exited ${r.status}`}`);
      }
    }

    // Launcher in place of the real binary.
    const macos = path.join(staging, 'Contents', 'MacOS');
    fs.renameSync(path.join(macos, exeName), path.join(macos, `${exeName}Main`));
    const env = { ...(app.env ? app.env(opts.dataDir) : {}), ...(opts.extraEnv || {}) };
    const args = [`--user-data-dir=${opts.dataDir}`, ...(app.args ? app.args(opts.dataDir) : []), ...(opts.extraArgs || [])];
    const sh = [
      '#!/bin/bash',
      `# Generated by dupe — ${app.name} profile "${opts.profile}"`,
      '#',
      '# Wrapped in { } so bash parses the whole file before running any of it:',
      '# the catch-up below replaces this very script.',
      '{',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      `PROFILE=${shq(opts.dataDir)}`,
      'mkdir -p "$PROFILE"',
      ...Object.entries(env).map(([k, v]) => `mkdir -p ${shq(v)}\nexport ${k}=${shq(v)}`),
      '',
      selfHealScript(app, opts, srcStamp),
      `exec "$DIR/${exeName}Main" ${args.map(shq).join(' ')} "$@"`,
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(macos, exeName), sh, { mode: 0o755 });

    // Icon file, named whatever the bundle loads, plus a PNG for the UI.
    writeIcnsFile(master, path.join(staging, 'Contents', 'Resources', iconFile));
    const iconsDir = path.join(os.homedir(), 'Library', 'Application Support', 'dupe', 'icons');
    fs.mkdirSync(iconsDir, { recursive: true });
    const iconPng = path.join(iconsDir, `${app.id}-${opts.profile}.png`);
    writePng(master, iconPng);

    // Distinct identity, frozen updates.
    const dupInfo = path.join(staging, 'Contents', 'Info.plist');
    for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
      if (!plistTry(dupInfo, `Set :${key} ${opts.label}`)) plistTry(dupInfo, `Add :${key} string ${opts.label}`);
    }
    // Point the bundle at the .icns we just wrote. Apps that ship their icon
    // in an asset catalog have CFBundleIconName and no CFBundleIconFile, so
    // deleting the one without adding the other would leave no icon at all.
    plistTry(dupInfo, 'Delete :CFBundleIconName');
    if (!plistTry(dupInfo, `Set :CFBundleIconFile ${iconFile}`)) plistTry(dupInfo, `Add :CFBundleIconFile string ${iconFile}`);
    const newId = `${oldId}.${opts.profile}`;
    plist(dupInfo, `Set :CFBundleIdentifier ${newId}`);
    if (!plistTry(dupInfo, 'Set :SUEnableAutomaticChecks false')) plistTry(dupInfo, 'Add :SUEnableAutomaticChecks bool false');
    fs.rmSync(path.join(staging, 'Contents', 'Resources', 'app-update.yml'), { force: true });

    // Re-sign (contents changed) and clear the quarantine flag cp carried over,
    // which combined with an ad-hoc signature is what makes Gatekeeper refuse.
    // An unsigned modified bundle won't launch at all, so a failure here is
    // the end of the build rather than something to note and carry on past.
    // The slowest step by a distance on a big Electron bundle, and the one
    // that would otherwise look like a hang.
    log('  signing     ad-hoc, over the whole bundle — this is the slow part');
    const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', staging], { encoding: 'utf8' });
    if (signed.status !== 0) {
      throw new Error(`codesign wouldn't sign the clone: ${(signed.stderr || '').trim() || `exit ${signed.status}`}`);
    }
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', staging], { stdio: 'ignore' });

    // Into place. The old clone goes only once the new one is ready.
    killClone(dup);
    fs.rmSync(dup, { recursive: true, force: true });
    fs.renameSync(staging, dup);
    log(`  bundle id   ${newId}`);

    return {
      app: app.id, appName: app.name, profile: opts.profile, label: opts.label, color: opts.color, treatment, custom: !!app.custom,
      platform: 'darwin', dataDir: opts.dataDir, bundle: dup, bundleId: newId, source: src, iconPng, iconFile: opts.iconFile || null,
      sourceStamp: srcStamp ? srcStamp.id : null,
      extraArgs: opts.extraArgs || [], extraEnv: opts.extraEnv || {}, builtAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true }); // a no-op once it has been renamed into place
  }
}

// cp reports failure for files it couldn't read even when everything that
// matters came across, so the copy is judged by what has to be there.
function cloned(dir, exeName) {
  return fs.existsSync(path.join(dir, 'Contents', 'Info.plist')) &&
    fs.existsSync(path.join(dir, 'Contents', 'MacOS', exeName));
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The part of the launcher that makes a clone behave like the app it copies.
 *
 * A macOS clone is a frozen snapshot: when the stock app updates itself, the
 * profile is left on the old version until something rebuilds it. The
 * background agent normally does that within a minute of the change, but the
 * guarantee people actually want is "the profile I open is the current app",
 * and only the launcher can promise that. So it compares the stock bundle
 * against the fingerprint this clone was taken from and, if they differ,
 * hands over to dupe before starting anything. The rebuild replaces this
 * bundle underneath us, then we exec the new binary in place — from the
 * outside it looks like the app taking a moment to apply an update.
 *
 * Everything here degrades to launching: no dupe on disk, no stock app, a
 * failed rebuild — all fall through to the clone as it stands.
 */
export function selfHealScript(app, opts, srcStamp) {
  if (!srcStamp) return '# No fingerprint for the stock app; nothing to catch up with.';
  const dupe = selfCommand([]);
  const notice = `display notification "Catching up with the latest ${app.name}…" with title ${JSON.stringify(opts.label)}`;
  return [
    '# Keep up with the stock app: compare it against the fingerprint this',
    '# clone was taken from. Usually unchanged, and this costs three plist',
    '# reads and two stats.',
    `SOURCE=${shq(srcStamp.path)}`,
    `BUILT_FROM=${shq(srcStamp.id)}`,
    `DUPE=(${[dupe.command, ...dupe.args].map(shq).join(' ')})`,
    stampScript,
    'if [ -d "$SOURCE" ] && [ -x "${DUPE[0]}" ] && [ "$(_dupe_stamp "$SOURCE")" != "$BUILT_FROM" ]; then',
    `  osascript -e ${shq(notice)} >/dev/null 2>&1 &`,
    `  mkdir -p ${shq(path.dirname(LOG_FILE))}`,
    `  "\${DUPE[@]}" update ${shq(app.id)} ${shq(opts.profile)} --quiet >>${shq(LOG_FILE)} 2>&1`,
    'fi',
  ].join('\n');
}

export function remove(record, { purge = false } = {}, log = () => {}) {
  if (record.bundle && fs.existsSync(record.bundle)) {
    killClone(record.bundle);
    fs.rmSync(record.bundle, { recursive: true, force: true });
    log(`  removed     ${record.bundle}`);
  }
  if (purge && record.dataDir && fs.existsSync(record.dataDir)) {
    fs.rmSync(record.dataDir, { recursive: true, force: true });
    log(`  removed     ${record.dataDir} (profile data)`);
  }
}

export function launch(record) {
  spawnSync('open', ['-a', record.bundle], { stdio: 'ignore' });
}

/**
 * A fingerprint of the stock app as it is right now, so a profile built from
 * it can tell later whether the app has been updated underneath it. Version
 * strings alone aren't enough — some apps ship a new build without touching
 * them — so the main executable's size and mtime go in too.
 *
 * The clone's own launcher recomputes this at every launch with nothing but
 * PlistBuddy and stat(1), so the format is deliberately coarse: whole-second
 * mtimes, because stat(1) has no milliseconds, and a literal "-" wherever a
 * file can't be read. `stampScript` below is the shell half; the two must
 * agree character for character.
 */
export function stamp(app) {
  const found = locate(app);
  return found ? stampBundle(found.bundle) : null;
}

function stampBundle(bundle) {
  const info = path.join(bundle, 'Contents', 'Info.plist');
  const short = plistTry(info, 'Print :CFBundleShortVersionString') || '';
  const build = plistTry(info, 'Print :CFBundleVersion') || '';
  let mtimeMs = 0;
  const marks = [info, execPath(bundle, info)].map((file) => {
    if (!file) return '-';
    try {
      const st = fs.statSync(file);
      mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      return `${Math.floor(st.mtimeMs / 1000)}:${st.size}`;
    } catch {
      return '-';
    }
  });
  return { path: bundle, version: short || build || null, id: [short, build, ...marks].join('|'), mtimeMs };
}

function execPath(bundle, info) {
  const name = plistTry(info, 'Print :CFBundleExecutable');
  return name ? path.join(bundle, 'Contents', 'MacOS', name) : null;
}

// The shell half of stamp(). Kept next to it so the two are read together.
const stampScript = [
  '_dupe_stamp() {',
  '  local info="$1/Contents/Info.plist" exe short build m1 m2',
  `  short="$(${shq(PB)} -c 'Print :CFBundleShortVersionString' "$info" 2>/dev/null)" || short=''`,
  `  build="$(${shq(PB)} -c 'Print :CFBundleVersion' "$info" 2>/dev/null)" || build=''`,
  `  exe="$(${shq(PB)} -c 'Print :CFBundleExecutable' "$info" 2>/dev/null)" || exe=''`,
  `  m1="$(stat -f '%m:%z' "$info" 2>/dev/null)" || m1='-'`,
  `  if [ -n "$exe" ]; then m2="$(stat -f '%m:%z' "$1/Contents/MacOS/$exe" 2>/dev/null)" || m2='-'; else m2='-'; fi`,
  `  printf '%s|%s|%s|%s' "$short" "$build" "$m1" "$m2"`,
  '}',
].join('\n');

/** Every process running out of this clone, except the ones we are inside.
 *  A profile that heals itself at launch runs `dupe` from the clone's own
 *  launcher script, and that script matches the same pattern — killing it, or
 *  counting it as "someone is using this", would deadlock the update. */
function clonePids(bundle) {
  const r = spawnSync('pgrep', ['-f', `${bundle}/Contents/MacOS`], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const mine = ancestors();
  return (r.stdout || '').split(/\s+/).map(Number).filter((pid) => pid && !mine.has(pid));
}

function ancestors() {
  const out = new Set();
  let pid = process.pid;
  for (let i = 0; i < 16 && pid > 1; i++) {
    out.add(pid);
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = parseInt((r.stdout || '').trim(), 10);
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return out;
}

function killClone(bundle) {
  for (const pid of clonePids(bundle)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** True while someone else has this clone open. Rebuilding replaces the
 *  bundle under it, so the background updater waits for a quieter moment. */
export function running(record) {
  return !!record.bundle && clonePids(record.bundle).length > 0;
}

/** Electron apps installed here that no preset covers. A bundle says so
 *  itself — the framework, or an app.asar in Resources — so this is a
 *  directory listing and a couple of stats per app, not a guess. */
export function discover() {
  const out = [];
  for (const dir of APPS_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const bundle = path.join(dir, name);
      if (!fs.existsSync(path.join(bundle, 'Contents', 'Info.plist'))) continue;
      if (!isElectron(bundle)) continue;
      out.push({ name: name.replace(/\.app$/, ''), path: bundle });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
