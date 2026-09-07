// The background job that keeps profiles current, expressed in whatever the
// platform already runs on login: a launchd agent on macOS, a Scheduled Task
// on Windows, a systemd user timer (or a crontab line) on Linux. Each one
// runs `dupe update --scheduled`, which rebuilds only the profiles whose
// stock app has actually changed and leaves running ones for the next round.
//
// Nothing here is a daemon: the job is asleep until the OS wakes it, and
// `dupe autoupdate off` removes every trace of it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DUPE_HOME, HOME, LOG_FILE, loadStore } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DUPE_HOME, 'autoupdate.json');

export const LABEL = 'com.github.hktitan.dupe.autoupdate';
export const TASK_NAME = 'dupe autoupdate';
export const UNIT = 'dupe-autoupdate';
export const DEFAULT_EVERY = '6h';

const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd', 'user');
const WIN_DIR = path.join(DUPE_HOME, 'autoupdate');

// ---- state file: what we asked for, and what the last run did.

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(DUPE_HOME, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  } catch { /* the schedule still works without its bookkeeping */ }
  return next;
}

/** "6h", "90m", "45" (minutes assumed only with the m suffix) → minutes. */
export function parseInterval(spec) {
  const m = /^(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|minutes?)?$/i.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`--every takes hours or minutes, like 6h or 90m (got "${spec}").`);
  const unit = (m[2] || 'h')[0].toLowerCase();
  const minutes = Math.round(unit === 'm' ? Number(m[1]) : Number(m[1]) * 60);
  if (minutes < 15 || minutes > 24 * 60) throw new Error(`--every must be between 15m and 24h (got "${spec}").`);
  return minutes;
}

export function humanInterval(minutes) {
  if (!minutes) return '';
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

/**
 * How to invoke this same dupe again from a scheduler, or from a clone's own
 * launcher: the script under the interpreter running now, or the compiled
 * binary, which is its own.
 *
 * DUPE_HOME moves everything dupe owns, and none of these callers inherits
 * the shell that set it — a launchd agent, a Scheduled Task and a crontab
 * line each have their own idea of the environment — so when it is set it
 * travels as an argument, which every one of them carries faithfully.
 */
export function selfCommand(extra = []) {
  const script = path.resolve(HERE, '..', 'bin', 'dupe.js');
  const home = process.env.DUPE_HOME ? ['--dupe-home', process.env.DUPE_HOME] : [];
  return fs.existsSync(script)
    ? { command: process.execPath, args: [script, ...home, ...extra] }
    : { command: process.execPath, args: [...home, ...extra] };
}

// ---- macOS: a launchd agent, on an interval and on any stock app changing.

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Files whose change should trigger a catch-up: the stock app behind each
 *  profile. Both launchd (WatchPaths) and systemd (a .path unit) re-arm when
 *  a watched path is replaced, which is exactly what an app update does. */
export function watchPaths(profiles) {
  const out = new Set();
  for (const p of profiles || []) {
    // Always POSIX paths for POSIX schedulers, whichever OS is writing them.
    const source = String(p.source || '').replace(/^"|"$/g, '').replace(/\/+$/, '');
    if (!source.startsWith('/')) continue;
    if (p.platform === 'darwin') out.add(`${source}/Contents/Info.plist`);
    else if (p.platform === 'linux') out.add(source);
  }
  return [...out].sort();
}

export function launchdPlist({ command, args, minutes, watch = [], env = {} }) {
  const strings = (items) => items.map((s) => `      <string>${xml(s)}</string>`).join('\n');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${xml(LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    strings([command, ...args]),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StartInterval</key>',
    `  <integer>${minutes * 60}</integer>`,
  ];
  if (watch.length) lines.push('  <key>WatchPaths</key>', '  <array>', strings(watch), '  </array>');
  if (Object.keys(env).length) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [k, v] of Object.entries(env)) lines.push(`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`);
    lines.push('  </dict>');
  }
  lines.push(
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>Nice</key>',
    '  <integer>5</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(LOG_FILE)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(LOG_FILE)}</string>`,
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join('\n');
}

function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function darwinEnable(minutes) {
  const { command, args } = selfCommand(['update', '--scheduled']);
  const body = launchdPlist({ command, args, minutes, watch: watchPaths(loadStore().profiles) });
  const unchanged = fs.existsSync(PLIST) && fs.readFileSync(PLIST, 'utf8') === body;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (!unchanged) fs.writeFileSync(PLIST, body);
  const domain = `gui/${process.getuid()}`;
  if (unchanged && launchctl(['print', `${domain}/${LABEL}`]).status === 0) return { changed: false };
  launchctl(['bootout', `${domain}/${LABEL}`]); // ignore: it may not be loaded
  let r = launchctl(['bootstrap', domain, PLIST]);
  if (r.status !== 0) r = launchctl(['load', '-w', PLIST]); // older macOS
  if (r.status !== 0) throw new Error(`launchctl wouldn't load the agent: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`);
  return { changed: true };
}

function darwinDisable() {
  const domain = `gui/${process.getuid()}`;
  launchctl(['bootout', `${domain}/${LABEL}`]);
  if (fs.existsSync(PLIST)) launchctl(['unload', '-w', PLIST]);
  fs.rmSync(PLIST, { force: true });
}

function darwinStatus(state) {
  if (!fs.existsSync(PLIST)) return { enabled: false, mechanism: 'launchd' };
  const loaded = launchctl(['print', `gui/${process.getuid()}/${LABEL}`]).status === 0 ||
    launchctl(['list', LABEL]).status === 0;
  const watched = watchPaths(loadStore().profiles).length;
  return {
    enabled: loaded,
    mechanism: 'launchd',
    detail: loaded
      ? `${humanInterval(state.everyMinutes)}${watched ? ', and whenever a stock app changes' : ''}`
      : 'the agent file is there but launchd has not loaded it',
    where: PLIST,
  };
}

// ---- Windows: a Scheduled Task, at logon and on a repeating trigger.

const twoDigit = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${twoDigit(d.getMonth() + 1)}-${twoDigit(d.getDate())}T${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}:${twoDigit(d.getSeconds())}`;
const isoDuration = (minutes) => (minutes % 60 === 0 ? `PT${minutes / 60}H` : `PT${minutes}M`);

export function taskXml({ command, args, minutes, userId, start = new Date() }) {
  const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Author>dupe</Author>',
    '    <Description>Rebuild dupe profiles whose stock app has changed. Removed by: dupe autoupdate off</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    // Scoped to this user on purpose: a logon trigger with no UserId means
    // "any user signs in", and registering one of those needs administrator
    // rights. With the UserId it registers as an ordinary user.
    userId ? `    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId><Delay>PT2M</Delay></LogonTrigger>` : '',
    '    <CalendarTrigger>',
    `      <StartBoundary>${xml(localIso(start))}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    `      <Repetition><Interval>${isoDuration(minutes)}</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`,
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    userId ? `      <UserId>${xml(userId)}</UserId>` : '',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(command)}</Command>`,
    argLine ? `      <Arguments>${xml(argLine)}</Arguments>` : '',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].filter((l) => l !== '').join('\r\n');
}

// A console program run from the task scheduler flashes a window every time.
// The Windows backend already needs csc.exe, so compile a windowless stub
// that starts the real thing with no console at all.
async function winShim(command, args) {
  const { findCsc } = await import('./platform/win32.js');
  const { EMBEDDED } = await import('./embedded.js');
  const csc = findCsc();
  if (!csc) return null;
  const tpl = path.join(HERE, 'platform', 'win32-autoupdate.cs');
  const template = fs.existsSync(tpl) ? fs.readFileSync(tpl, 'utf8') : EMBEDDED['win32-autoupdate.cs'];
  if (!template) return null;
  const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  const src = template
    .replace('@COMMAND@', command.replace(/"/g, '""'))
    .replace('@ARGUMENTS@', argLine.replace(/"/g, '""'));
  fs.mkdirSync(WIN_DIR, { recursive: true });
  const cs = path.join(WIN_DIR, 'autoupdate.cs');
  const exe = path.join(WIN_DIR, 'dupe-autoupdate.exe');
  fs.writeFileSync(cs, src);
  spawnSync('taskkill', ['/F', '/IM', path.basename(exe)], { stdio: 'ignore' });
  const r = spawnSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${exe}`, cs], { encoding: 'utf8' });
  return r.status === 0 ? exe : null;
}

async function win32Enable(minutes) {
  const self = selfCommand(['update', '--scheduled']);
  fs.mkdirSync(WIN_DIR, { recursive: true });
  const shim = await winShim(self.command, self.args).catch(() => null);
  const action = shim ? { command: shim, args: [] } : self;
  const userId = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : null;
  const body = taskXml({ ...action, minutes, userId });
  const file = path.join(WIN_DIR, 'task.xml');
  fs.writeFileSync(file, Buffer.from('\ufeff' + body, 'utf16le')); // schtasks wants UTF-16
  const r = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`schtasks wouldn't register the task: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`);
  return { changed: true, windowless: !!shim };
}

function win32Disable() {
  spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  spawnSync('taskkill', ['/F', '/IM', 'dupe-autoupdate.exe'], { stdio: 'ignore' });
  fs.rmSync(WIN_DIR, { recursive: true, force: true });
}

// schtasks localises its list output but not the CSV column order.
function csvFields(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function win32Status(state) {
  if (!state.enabled && !fs.existsSync(WIN_DIR)) return { enabled: false, mechanism: 'schtasks' };
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH', '/V'], { encoding: 'utf8' });
  if (r.status !== 0) return { enabled: false, mechanism: 'schtasks' };
  const row = csvFields((r.stdout || '').split(/\r?\n/).find((l) => l.trim()) || '');
  return {
    enabled: true,
    mechanism: 'schtasks',
    detail: `${humanInterval(state.everyMinutes)}, and 2 minutes after you sign in`,
    where: TASK_NAME,
    next: row[2] || null,
  };
}

// ---- Linux: a systemd user timer, or a crontab line where there is no systemd.

// A realtime schedule where the interval divides the clock, so Persistent=
// can catch up a run the machine slept through. Monotonic otherwise.
function calendarSpec(minutes) {
  if (minutes < 60) return 60 % minutes === 0 ? `*:0/${minutes}` : null;
  const hours = minutes / 60;
  return Number.isInteger(hours) && 24 % hours === 0 ? `*-*-* 0/${hours}:00:00` : null;
}

export function systemdUnits({ command, args, minutes, watch = [], env = {} }) {
  const line = [command, ...args].map((a) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
  const service = [
    '[Unit]',
    'Description=Rebuild dupe profiles whose stock app has changed',
    'Documentation=https://github.com/HKTITAN/dupe',
    '',
    '[Service]',
    'Type=oneshot',
    ...Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`),
    `ExecStart=${line}`,
    'Nice=10',
    'IOSchedulingClass=idle',
    '',
  ].join('\n');
  const calendar = calendarSpec(minutes);
  const timer = [
    '[Unit]',
    'Description=Check whether the apps behind dupe profiles have updated',
    '',
    '[Timer]',
    'OnStartupSec=2min',
    // Persistent= only means anything for a realtime timer, so it is set
    // only alongside OnCalendar; otherwise the schedule stays monotonic.
    ...(calendar ? [`OnCalendar=${calendar}`, 'Persistent=true'] : [`OnUnitActiveSec=${minutes}min`]),
    'AccuracySec=1min',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  // The systemd answer to launchd's WatchPaths: catch up within seconds of
  // the stock app changing rather than at the next tick.
  const pathUnit = watch.length ? [
    '[Unit]',
    'Description=Watch the apps behind dupe profiles for updates',
    '',
    '[Path]',
    ...watch.map((w) => `PathChanged=${w}`),
    '',
    '[Install]',
    'WantedBy=paths.target',
    '',
  ].join('\n') : null;
  return { service, timer, path: pathUnit };
}

/** The crontab line used where `systemctl --user` isn't available. */
export function cronLine({ command, args, minutes }) {
  const when = minutes < 60 ? `*/${minutes} * * * *` : `0 */${Math.max(1, Math.round(minutes / 60))} * * *`;
  const line = [command, ...args].map((a) => (/[\s"\\]/.test(a) ? `"${a}"` : a)).join(' ');
  return `${when} ${line}  # ${CRON_MARK}`;
}

const CRON_MARK = 'dupe autoupdate';

function systemctl(args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
}

function hasSystemd() {
  return spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout !== undefined &&
    spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;
}

function readCrontab() {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') : '';
}

function writeCrontab(text) {
  const r = spawnSync('crontab', ['-'], { input: text.endsWith('\n') ? text : text + '\n', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`crontab wouldn't take the entry: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
}

function stripCron(text) {
  return text.split('\n').filter((l) => !l.includes(`# ${CRON_MARK}`)).join('\n').replace(/\n{3,}/g, '\n\n');
}

function linuxEnable(minutes) {
  const self = selfCommand(['update', '--scheduled']);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (hasSystemd()) {
    const units = systemdUnits({ ...self, minutes, watch: watchPaths(loadStore().profiles) });
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    const before = readUnits();
    fs.writeFileSync(path.join(UNIT_DIR, `${UNIT}.service`), units.service);
    fs.writeFileSync(path.join(UNIT_DIR, `${UNIT}.timer`), units.timer);
    if (units.path) fs.writeFileSync(path.join(UNIT_DIR, `${UNIT}.path`), units.path);
    else fs.rmSync(path.join(UNIT_DIR, `${UNIT}.path`), { force: true });
    const same = before.service === units.service && before.timer === units.timer && before.path === units.path;
    if (same && systemctl(['is-active', `${UNIT}.timer`]).stdout.trim() === 'active') return { changed: false, mechanism: 'systemd' };
    systemctl(['daemon-reload']);
    const r = systemctl(['enable', '--now', `${UNIT}.timer`]);
    if (r.status !== 0) throw new Error(`systemctl wouldn't enable the timer: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    if (units.path) systemctl(['enable', '--now', `${UNIT}.path`]);
    return { changed: true, mechanism: 'systemd' };
  }
  const text = stripCron(readCrontab()).replace(/\s*$/, '');
  writeCrontab(`${text}\n${cronLine({ ...self, minutes })}`);
  return { changed: true, mechanism: 'cron' };
}

function readUnits() {
  const read = (ext) => {
    try { return fs.readFileSync(path.join(UNIT_DIR, `${UNIT}.${ext}`), 'utf8'); } catch { return null; }
  };
  return { service: read('service'), timer: read('timer'), path: read('path') };
}

function linuxDisable() {
  if (fs.existsSync(path.join(UNIT_DIR, `${UNIT}.timer`))) {
    if (fs.existsSync(path.join(UNIT_DIR, `${UNIT}.path`))) systemctl(['disable', '--now', `${UNIT}.path`]);
    systemctl(['disable', '--now', `${UNIT}.timer`]);
    for (const ext of ['timer', 'service', 'path']) fs.rmSync(path.join(UNIT_DIR, `${UNIT}.${ext}`), { force: true });
    systemctl(['daemon-reload']);
  }
  const cron = readCrontab();
  if (cron.includes(`# ${CRON_MARK}`)) writeCrontab(stripCron(cron));
}

function linuxStatus(state) {
  if (fs.existsSync(path.join(UNIT_DIR, `${UNIT}.timer`))) {
    const active = systemctl(['is-active', `${UNIT}.timer`]).stdout || '';
    const next = (systemctl(['show', `${UNIT}.timer`, '-p', 'NextElapseUSecRealtime', '--value']).stdout || '').trim();
    return {
      enabled: active.trim() === 'active',
      mechanism: 'systemd',
      detail: humanInterval(state.everyMinutes),
      where: path.join(UNIT_DIR, `${UNIT}.timer`),
      next: next && next !== 'n/a' ? next : null,
    };
  }
  if (readCrontab().includes(`# ${CRON_MARK}`)) {
    return { enabled: true, mechanism: 'cron', detail: humanInterval(state.everyMinutes), where: 'crontab' };
  }
  return { enabled: false, mechanism: 'systemd' };
}

// ---- the three, behind one door.

/** Whether the background job is installed, and what it looks like. Cheap
 *  when it isn't: nothing is spawned until an artifact is found on disk. */
export function status() {
  const state = readState();
  let s;
  try {
    switch (process.platform) {
      case 'darwin': s = darwinStatus(state); break;
      case 'win32': s = win32Status(state); break;
      case 'linux': s = linuxStatus(state); break;
      default: s = { enabled: false, mechanism: null, detail: `No scheduler for ${process.platform}.` };
    }
  } catch (e) {
    s = { enabled: false, mechanism: null, detail: e.message };
  }
  return {
    ...s,
    every: state.every || DEFAULT_EVERY,
    everyMinutes: state.everyMinutes || parseInterval(DEFAULT_EVERY),
    lastRun: state.lastRun || null,
    log: LOG_FILE,
    supported: ['darwin', 'win32', 'linux'].includes(process.platform),
  };
}

/** Install (or re-install with a new interval) the background job. */
export async function enable({ every = null } = {}) {
  const state = readState();
  const spec = every || state.every || DEFAULT_EVERY;
  const minutes = parseInterval(spec);
  let extra = {};
  switch (process.platform) {
    case 'darwin': extra = darwinEnable(minutes); break;
    case 'win32': extra = await win32Enable(minutes); break;
    case 'linux': extra = linuxEnable(minutes); break;
    default: throw new Error(`dupe has no scheduler for ${process.platform}.`);
  }
  writeState({ enabled: true, every: spec, everyMinutes: minutes, installedAt: new Date().toISOString() });
  return { ...status(), ...extra };
}

/** Remove it, along with everything it wrote. */
export function disable() {
  switch (process.platform) {
    case 'darwin': darwinDisable(); break;
    case 'win32': win32Disable(); break;
    case 'linux': linuxDisable(); break;
    default: break;
  }
  writeState({ enabled: false });
  return status();
}

/** Re-write the job if what it should contain has changed: the set of apps
 *  being watched moves with the profile list on macOS and Linux. Silent and
 *  best effort — adding a profile must never fail because of the scheduler. */
export function refresh() {
  try {
    const state = readState();
    if (!state.enabled) return false;
    const minutes = state.everyMinutes || parseInterval(DEFAULT_EVERY);
    if (process.platform === 'darwin') return fs.existsSync(PLIST) && darwinEnable(minutes).changed;
    if (process.platform === 'linux') return fs.existsSync(path.join(UNIT_DIR, `${UNIT}.timer`)) && linuxEnable(minutes).changed;
    return false;
  } catch {
    return false;
  }
}
