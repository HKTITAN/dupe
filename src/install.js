// Getting the stock app onto the machine in the first place.
//
// dupe profiles an app that is already installed, so the first thing a new
// user hits is "Claude isn't installed here". This closes that gap, in three
// tiers, best first:
//
//   1. The OS package manager, when the app has a manifest the vendor owns:
//      winget on Windows, a Homebrew cask on macOS, Flathub on Linux. The
//      manager verifies the download and knows how to upgrade it later, so
//      this is both the safest and the least surprising.
//   2. The vendor's own "latest" endpoint, for apps that publish one
//      (Claude's /api/desktop/<platform>/<arch>/<kind>/latest/redirect).
//      Downloaded to a temp file and run, never silently.
//   3. The vendor's download page, opened in a browser. Always available,
//      and the honest answer when the other two aren't.
//
// Two rules hold everywhere: nothing is ever installed without an explicit
// yes, and every hop of a download must be https on a host the preset
// declares. The plan is printed in full before anything runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { findApp } from './apps.js';
import * as core from './core.js';

const MAX_REDIRECTS = 8;
const arch = () => (process.arch === 'arm64' ? 'arm64' : 'x64');

// Probing a package manager costs a process, and `dupe list` asks about the
// same three for every preset, so the answer is remembered for the run.
const managers = new Map();

/**
 * Where a manager actually is, or null.
 *
 * The only reason this file ever passed `shell: true` was to get PATH lookup
 * for `winget`. A shell that looks things up also parses what it is given,
 * which is what made the download path dangerous — so the lookup is done
 * once, explicitly, and everything afterwards runs by full path with no
 * shell anywhere in this file. (Node deprecated the combination for exactly
 * this reason.)
 */
function resolveBin(bin) {
  if (!managers.has(bin)) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(finder, [bin], { encoding: 'utf8' });
    const lines = r.status === 0 ? (r.stdout || '').split(/[\r\n]+/) : [];
    const first = lines.map((l) => l.trim()).find(Boolean);
    managers.set(bin, first || null);
  }
  return managers.get(bin);
}

function have(bin, probe = ['--version']) {
  const full = resolveBin(bin);
  if (!full) return false;
  const key = `ran:${bin}`;
  if (!managers.has(key)) {
    managers.set(key, spawnSync(full, probe, { stdio: 'ignore' }).status === 0);
  }
  return managers.get(key);
}

/**
 * How this app could be installed here, in preference order. Pure: it looks
 * at the preset and at which managers exist, and installs nothing.
 * @returns {{app:object, installed:string|null, steps:Array}}
 */
export async function plan(appSpec) {
  const app = core.resolveApp(appSpec);
  const be = await core.backend();
  let installed = null;
  try {
    const where = be.locate(app);
    installed = where ? (where.exe || where.bundle || where.desktop || where.exec) : null;
  } catch { installed = null; }

  const spec = app.install || {};
  const per = spec[process.platform] || {};
  const steps = [];

  if (per.winget && process.platform === 'win32' && have('winget', ['--version'])) {
    steps.push({
      via: 'winget',
      what: `${per.winget}${per.source ? ` (${per.source})` : ''}`,
      run: ['winget', ['install', '--exact', '--id', per.winget, ...(per.source ? ['--source', per.source] : []),
        '--accept-package-agreements', '--accept-source-agreements']],
    });
  }
  if (per.brew && process.platform === 'darwin' && have('brew', ['--version'])) {
    steps.push({ via: 'brew', what: `--cask ${per.brew}`, run: ['brew', ['install', '--cask', per.brew]] });
  }
  if (per.flatpak && process.platform === 'linux' && have('flatpak', ['--version'])) {
    steps.push({ via: 'flatpak', what: `flathub ${per.flatpak}`, run: ['flatpak', ['install', '-y', 'flathub', per.flatpak]] });
  }
  if (per.url) {
    steps.push({ via: 'download', what: per.url.replace('{arch}', arch()), url: per.url.replace('{arch}', arch()), hosts: spec.hosts || [] });
  }
  if (spec.page) steps.push({ via: 'page', what: spec.page, url: spec.page });

  return { app, installed, steps };
}

/** A line per option, for `dupe install` and for the "not installed" message. */
export function describe(p) {
  return p.steps.map((s) => {
    switch (s.via) {
      case 'winget': return `  winget      ${s.what}`;
      case 'brew': return `  homebrew    ${s.what}`;
      case 'flatpak': return `  flatpak     ${s.what}`;
      case 'download': return `  download    ${s.what}`;
      default: return `  open        ${s.what}`;
    }
  });
}

// ---- downloading, for the one tier that isn't a package manager

function httpsOnly(url, hosts) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`Refusing a download over ${u.protocol}//: ${url}`);
  if (hosts.length && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    throw new Error(`Refusing a download from ${u.hostname}; this app only publishes on ${hosts.join(', ')}.`);
  }
  return u;
}

/** Follow the vendor's redirect chain by hand so every hop can be checked. */
async function resolve(url, hosts) {
  let current = httpsOnly(url, hosts).toString();
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const r = await fetch(current, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'dupe' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      try { await r.body?.cancel(); } catch { /* nothing buffered */ }
      const next = new URL(r.headers.get('location'), current);
      // Only the first hop has to be the vendor; after that https is the rule,
      // because releases live on CDNs nobody can enumerate in advance.
      if (next.protocol !== 'https:') throw new Error(`Refusing a redirect to ${next.protocol}// (${next.hostname}).`);
      current = next.toString();
      continue;
    }
    if (!r.ok) throw new Error(`${url} answered ${r.status} ${r.statusText}.`);
    return { response: r, url: current };
  }
  throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times.`);
}

// What dupe is willing to run, and the only thing it takes from the URL.
const KINDS = ['.exe', '.msi', '.dmg', '.pkg', '.zip'];

/**
 * The name to save a download under.
 *
 * Not the one in the URL. The last hop of a redirect chain is not the
 * vendor — releases live on CDNs — so the chain got to choose the filename,
 * and a decoded `..%5C..%5CStartup%5Cx.exe` walked straight out of the
 * private temp directory it was supposed to land in. Windows filenames may
 * also contain " and &, which mattered when the file was later handed to a
 * shell. So the chain gets to choose one thing: which of a handful of
 * extensions it is, and only if it names one at all.
 */
function downloadName(url) {
  let last = '';
  try { last = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { last = ''; }
  const ext = KINDS.find((k) => last.toLowerCase().endsWith(k));
  if (!ext) throw new Error(`That download isn't one of ${KINDS.join(', ')} — dupe won't run it. It came from ${new URL(url).host}.`);
  return `installer${ext}`;
}

/** Fetch the installer to a temp file. Returns its path, size and digest. */
export async function download(step, log = () => {}) {
  const { response, url } = await resolve(step.url, step.hosts || []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-install-'));
  const file = path.join(dir, downloadName(url));
  // Belt and braces: whatever the name turned out to be, it stays here.
  if (path.dirname(file) !== dir) throw new Error('Refusing to write the download outside its own directory.');
  const total = Number(response.headers.get('content-length') || 0);
  log(`  from        ${new URL(url).host}${total ? `  ${(total / 1048576).toFixed(1)} MB` : ''}`);

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  // A write stream with no error listener raises an uncaught exception, and
  // an error out of an fs callback cannot be caught by the try/catch around
  // this await — so a full disk mid-download killed the process outright,
  // and took `dupe ui` with it, since the server awaits this inside a
  // request handler.
  const failed = new Promise((_, reject) => out.once('error', reject));
  let seen = 0, lastTick = 0, first = null;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      if (!first) first = Buffer.from(chunk.subarray(0, 8));
      seen += chunk.length;
      if (!out.write(chunk)) await Promise.race([new Promise((r) => out.once('drain', r)), failed]);
      if (total && seen - lastTick > total / 10) { lastTick = seen; log(`  downloaded  ${Math.round((seen / total) * 100)}%`); }
    }
    await Promise.race([new Promise((r) => out.end(r)), failed]);
  } catch (e) {
    out.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Couldn't save the download: ${e.message}`);
  }
  // A connection cut at 60% leaves an installer that is 60% of an installer,
  // and it would have been run.
  if (total && seen !== total) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`That download stopped early — ${seen} bytes of ${total}. Try again.`);
  }
  looksRunnable(first, file, dir);
  const digest = hash.digest('hex');
  log(`  file        ${file}`);
  log(`  sha256      ${digest}`);
  return { file, bytes: seen, sha256: digest, url };
}

/**
 * Is this the kind of file it claims to be?
 *
 * `r.ok` only rules out a non-2xx status, so a CDN error page or a corporate
 * proxy interstitial arrives as a perfectly good 200 and would have been
 * executed. The first bytes settle it.
 */
function looksRunnable(first, file, dir) {
  const ext = path.extname(file).toLowerCase();
  const head = first || Buffer.alloc(0);
  const starts = (...bytes) => bytes.every((b, i) => head[i] === b);
  const ok = ext === '.exe' ? starts(0x4d, 0x5a) // MZ
    : ext === '.msi' ? starts(0xd0, 0xcf, 0x11, 0xe0)
      : ext === '.zip' ? starts(0x50, 0x4b)
        : true; // .dmg and .pkg have no dependable first bytes
  const html = /^\s*(<!doctype|<html)/i.test(head.toString('latin1'));
  if (!ok || html) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`What came back isn't ${ext} — it looks like ${html ? 'a web page' : 'something else'}. The vendor's download page may have moved.`);
  }
}

// ---- running what we fetched

/**
 * Run something, without a shell in the way.
 *
 * `shell: true` on Windows means cmd.exe parses the command line, and the
 * command line included a path dupe had just taken from a URL: a file
 * called `a"&calc&".exe` is a legal Windows filename and cmd runs the middle
 * of it. It also broke the ordinary case — any user whose profile directory
 * has a space in it got `'C:\Users\Two' is not recognized`. Executing the
 * file directly has neither problem.
 *
 * The package managers are resolved to a full path by resolveBin above, so
 * nothing in this file needs a shell at all any more.
 */
function run(cmd, args, log) {
  log(`  running     ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') throw new Error(`${cmd} isn't on this machine.`);
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}.`);
}

function openPage(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* the URL is printed anyway */ }
}

// A downloaded installer is handed to the thing that knows how to run it.
function runInstaller(file, log, expect = []) {
  const ext = path.extname(file).toLowerCase();
  if (process.platform === 'win32') return run(file, [], log);
  if (process.platform === 'darwin' && ext === '.dmg') return installDmg(file, log, expect);
  if (process.platform === 'darwin' && (ext === '.zip' || ext === '.pkg')) {
    return ext === '.pkg'
      ? run('open', [file], log) // a .pkg needs the installer UI and its own authorisation
      : run('ditto', ['-xk', file, '/Applications'], log);
  }
  throw new Error(`dupe doesn't know how to run ${path.basename(file)} on ${process.platform}. It is at ${file}.`);
}

/**
 * Mount, copy the bundle out, unmount. No sudo: /Applications is writable by
 * the admin user, and if it isn't, the error says so plainly.
 *
 * Two rules, both learned the hard way. The image does not get to choose
 * which app is replaced — it must contain the app dupe said it was
 * installing, or nothing happens. And the app already installed is not
 * deleted until its replacement is in place: the copy can fail on a full
 * disk or a read-only volume, and deleting first meant a user who had a
 * working install ended up with none.
 */
function installDmg(file, log, expect = []) {
  const point = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-dmg-'));
  const r = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', point, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Couldn't mount ${path.basename(file)}: ${(r.stderr || '').trim()}`);
  try {
    const bundles = fs.readdirSync(point).filter((n) => n.endsWith('.app'));
    if (!bundles.length) throw new Error(`${path.basename(file)} has no .app inside it.`);
    const bundle = expect.length ? bundles.find((b) => expect.includes(b)) : bundles[0];
    if (!bundle) {
      throw new Error(`${path.basename(file)} contains ${bundles.join(', ')}, not ${expect.join(' or ')}. dupe won't install something else under that name.`);
    }
    const target = path.join('/Applications', bundle);
    const staged = `${target}.dupe-installing`;
    const kept = `${target}.dupe-previous`;
    log(`  installing  ${target}`);
    fs.rmSync(staged, { recursive: true, force: true });
    const cp = spawnSync('cp', ['-R', path.join(point, bundle), staged], { encoding: 'utf8' });
    if (cp.status !== 0) {
      fs.rmSync(staged, { recursive: true, force: true });
      throw new Error(`Couldn't copy into /Applications: ${(cp.stderr || '').trim()}`);
    }
    // The swap. The old one is moved aside, not deleted, until the new one
    // is in place — so a failure here leaves the machine as it was.
    const had = fs.existsSync(target);
    try {
      fs.rmSync(kept, { recursive: true, force: true });
      if (had) fs.renameSync(target, kept);
      fs.renameSync(staged, target);
    } catch (e) {
      if (had && !fs.existsSync(target) && fs.existsSync(kept)) fs.renameSync(kept, target);
      fs.rmSync(staged, { recursive: true, force: true });
      throw new Error(`Couldn't put ${bundle} into /Applications: ${e.message}`);
    }
    fs.rmSync(kept, { recursive: true, force: true });
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', target], { stdio: 'ignore' });
  } finally {
    spawnSync('hdiutil', ['detach', point, '-quiet'], { stdio: 'ignore' });
    fs.rmSync(point, { recursive: true, force: true });
  }
}

/**
 * Install the app, having been told yes.
 * @param {string} appSpec preset id
 * @param {{via?:string}} opts pick a tier explicitly; default is the best one
 */
export async function install(appSpec, { via = null } = {}, log = () => {}) {
  const p = await plan(appSpec);
  if (p.installed) return { ...p, already: true };
  const step = via ? p.steps.find((s) => s.via === via) : p.steps[0];
  if (!step) throw new Error(`dupe has no way to install ${p.app.name} on ${process.platform}. Install it yourself, then run dupe again.`);

  log(`${p.app.name}  via ${step.via}`);
  if (step.via === 'page') {
    openPage(step.url);
    return { ...p, step, opened: step.url };
  }
  if (step.via === 'download') {
    const got = await download(step, log);
    runInstaller(got.file, log, (p.app.darwin && p.app.darwin.bundles) || []);
    fs.rmSync(path.dirname(got.file), { recursive: true, force: true });
    return { ...p, step, downloaded: got };
  }
  run(resolveBin(step.run[0]) || step.run[0], step.run[1], log);
  return { ...p, step };
}

/** Tag the app list from core.state() with how each missing one could be
 *  installed. Kept here rather than in state() so core.js stays out of this. */
export async function annotate(apps) {
  const out = [];
  for (const app of apps) {
    if (app.found) { out.push(app); continue; }
    try {
      const p = await plan(app.id);
      const step = p.steps[0];
      out.push({ ...app, install: step ? { via: step.via, what: step.what } : null });
    } catch {
      out.push(app);
    }
  }
  return out;
}

/** Where an app that isn't here could come from, as advice rather than action. */
export async function suggest(appSpec) {
  try {
    const p = await plan(appSpec);
    if (p.installed || !p.steps.length) return null;
    const app = findApp(appSpec);
    return `${p.app.name} isn't installed here. Run "dupe install ${app ? app.id : appSpec}" and dupe will get it:\n${describe(p).join('\n')}`;
  } catch {
    return null;
  }
}
