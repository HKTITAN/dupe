// macOS backend. A straight generalisation of Stephen Wu's
// Rebuild-Work-Apps.command: APFS-clone the stock bundle, swap the binary
// for a launcher script that pins the profile, recolour the .icns, patch
// Info.plist so macOS sees a distinct app, ad-hoc re-sign, drop quarantine.
//
// Clones are frozen snapshots — auto-update is disabled, so run
// `dupe rebuild` after the stock app updates itself. Profile data lives
// outside the bundle and survives rebuilds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { decodePng } from '../image/png.js';
import { largestFromIcns } from '../image/icns.js';
import { makeIcon, writeIcnsFile, writePng } from '../icon.js';

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
  const dup = path.join(path.dirname(src), `${opts.label}.app`);
  const info = path.join(src, 'Contents', 'Info.plist');
  const exeName = plist(info, 'Print :CFBundleExecutable');
  let iconFile = plistTry(info, 'Print :CFBundleIconFile') || 'electron.icns';
  if (!iconFile.endsWith('.icns')) iconFile += '.icns';
  const oldId = plist(info, 'Print :CFBundleIdentifier');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-'));

  try {
    // Icon first, so a bad icon never leaves a half-built bundle behind.
    const source = loadBundleIcon(src, iconFile, tmp);
    const { master, treatment } = makeIcon(source, opts.color, opts.treatment);
    log(`  icon        ${iconFile} ${source.width}px → ${opts.color} (${treatment})`);

    log(`  clone       ${dup}`);
    spawnSync('pkill', ['-f', `${dup}/Contents/MacOS`], { stdio: 'ignore' });
    if (fs.existsSync(dup)) fs.rmSync(dup, { recursive: true, force: true });
    // APFS copy-on-write clone; falls back to a plain copy on other filesystems.
    // Root-owned unreadable files are skipped — the app can't read them either.
    let r = spawnSync('cp', ['-Rc', src, dup], { stdio: 'ignore' });
    if (r.status !== 0 && !fs.existsSync(path.join(dup, 'Contents'))) {
      fs.rmSync(dup, { recursive: true, force: true });
      spawnSync('cp', ['-R', src, dup], { stdio: 'ignore' });
    }

    // Launcher in place of the real binary.
    const macos = path.join(dup, 'Contents', 'MacOS');
    fs.renameSync(path.join(macos, exeName), path.join(macos, `${exeName}Main`));
    const env = { ...(app.env ? app.env(opts.dataDir) : {}), ...(opts.extraEnv || {}) };
    const args = [`--user-data-dir=${opts.dataDir}`, ...(app.args ? app.args(opts.dataDir) : []), ...(opts.extraArgs || [])];
    const sh = [
      '#!/bin/bash',
      `# Generated by dupe — ${app.name} profile "${opts.profile}"`,
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      `PROFILE=${shq(opts.dataDir)}`,
      'mkdir -p "$PROFILE"',
      ...Object.entries(env).map(([k, v]) => `mkdir -p ${shq(v)}\nexport ${k}=${shq(v)}`),
      `exec "$DIR/${exeName}Main" ${args.map(shq).join(' ')} "$@"`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(macos, exeName), sh, { mode: 0o755 });

    // Icon file, named whatever the bundle loads, plus a PNG for the UI.
    writeIcnsFile(master, path.join(dup, 'Contents', 'Resources', iconFile));
    const iconsDir = path.join(os.homedir(), 'Library', 'Application Support', 'dupe', 'icons');
    fs.mkdirSync(iconsDir, { recursive: true });
    const iconPng = path.join(iconsDir, `${app.id}-${opts.profile}.png`);
    writePng(master, iconPng);

    // Distinct identity, frozen updates.
    const dupInfo = path.join(dup, 'Contents', 'Info.plist');
    for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
      if (!plistTry(dupInfo, `Set :${key} ${opts.label}`)) plistTry(dupInfo, `Add :${key} string ${opts.label}`);
    }
    plistTry(dupInfo, 'Delete :CFBundleIconName'); // force the .icns over Assets.car
    const newId = `${oldId}.${opts.profile}`;
    plist(dupInfo, `Set :CFBundleIdentifier ${newId}`);
    if (!plistTry(dupInfo, 'Set :SUEnableAutomaticChecks false')) plistTry(dupInfo, 'Add :SUEnableAutomaticChecks bool false');
    fs.rmSync(path.join(dup, 'Contents', 'Resources', 'app-update.yml'), { force: true });

    // Re-sign (contents changed) and clear the quarantine flag cp carried over,
    // which combined with an ad-hoc signature is what makes Gatekeeper refuse.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', dup], { stdio: 'ignore' });
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', dup], { stdio: 'ignore' });
    log(`  bundle id   ${newId}`);

    return {
      app: app.id, appName: app.name, profile: opts.profile, label: opts.label, color: opts.color, treatment, custom: !!app.custom,
      platform: 'darwin', dataDir: opts.dataDir, bundle: dup, bundleId: newId, source: src, iconPng,
      extraArgs: opts.extraArgs || [], extraEnv: opts.extraEnv || {}, builtAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function remove(record, { purge = false } = {}, log = () => {}) {
  if (record.bundle && fs.existsSync(record.bundle)) {
    spawnSync('pkill', ['-f', `${record.bundle}/Contents/MacOS`], { stdio: 'ignore' });
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
