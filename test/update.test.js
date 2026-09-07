// Staying level with the stock app: what counts as out of date, and what the
// three schedulers are asked to run. Everything here is pure — no launchd, no
// schtasks, no systemd — so it runs the same on any machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Point everything dupe owns at a scratch directory before the modules that
// read it are loaded.
process.env.DUPE_HOME = path.join(os.tmpdir(), 'dupe-test-home');

const { classify, summarize } = await import('../src/update.js');
const schedule = await import('../src/schedule.js');
const { selfHealScript } = await import('../src/platform/darwin.js');

const stamp = (id, mtimeMs = 0) => ({ path: '/Applications/Claude.app', version: '1.4.2', id, mtimeMs });

test('a profile is current when the app still matches its fingerprint', () => {
  const record = { sourceStamp: 'a|b|1:2|3:4', builtAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(classify(record, stamp('a|b|1:2|3:4')), 'current');
  assert.equal(classify(record, stamp('a|c|1:2|3:4')), 'stale');
});

test('an app that cannot be found leaves the profile missing, not stale', () => {
  assert.equal(classify({ sourceStamp: 'x' }, null), 'missing');
  assert.equal(classify({}, null), 'missing');
});

test('a profile from before fingerprints falls back to comparing times', () => {
  const builtAt = '2026-01-01T00:00:00.000Z';
  const built = Date.parse(builtAt);
  // Built after the app was last written: nothing has happened since.
  assert.equal(classify({ builtAt }, stamp('any', built - 60_000)), 'current');
  // The app was written after the profile was built: it moved on without us.
  assert.equal(classify({ builtAt }, stamp('any', built + 60_000)), 'stale');
  // No usable times at all: don't cry wolf.
  assert.equal(classify({}, stamp('any', 0)), 'current');
});

test('summarize says what a run did', () => {
  assert.equal(summarize({ checked: 0, updated: [], deferred: [], failed: [], missing: [], current: 0 }), 'No profiles yet.');
  assert.equal(
    summarize({ checked: 3, updated: [1], deferred: [1], failed: [], missing: [], current: 1 }),
    '1 updated, 1 left open, 1 already current.',
  );
});

test('intervals are read in hours or minutes and bounded', () => {
  assert.equal(schedule.parseInterval('6h'), 360);
  assert.equal(schedule.parseInterval('90m'), 90);
  assert.equal(schedule.parseInterval('2'), 120); // bare numbers are hours
  assert.throws(() => schedule.parseInterval('5m'), /between 15m and 24h/);
  assert.throws(() => schedule.parseInterval('48h'), /between 15m and 24h/);
  assert.throws(() => schedule.parseInterval('soon'), /hours or minutes/);
  assert.equal(schedule.humanInterval(360), 'every 6 hours');
  assert.equal(schedule.humanInterval(60), 'every hour');
  assert.equal(schedule.humanInterval(90), 'every 90 minutes');
});

test('only POSIX sources are watched, and macOS watches the Info.plist inside', () => {
  assert.deepEqual(
    schedule.watchPaths([
      { platform: 'darwin', source: '/Applications/Claude.app' },
      { platform: 'linux', source: '/usr/share/applications/claude.desktop' },
      { platform: 'linux', source: '"/opt/quoted/app"' },
      { platform: 'win32', source: 'C:\\Program Files\\Claude\\Claude.exe' },
      { platform: 'darwin' },
    ]),
    ['/Applications/Claude.app/Contents/Info.plist', '/opt/quoted/app', '/usr/share/applications/claude.desktop'],
  );
});

test('the launchd agent runs on an interval and on the watched bundles', () => {
  const plist = schedule.launchdPlist({
    command: '/usr/local/bin/node',
    args: ['/opt/dupe/bin/dupe.js', 'update', '--scheduled'],
    minutes: 360,
    watch: ['/Applications/Claude.app/Contents/Info.plist'],
    env: { DUPE_HOME: '/Users/x/.dupe' },
  });
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>WatchPaths<\/key>/);
  assert.match(plist, /<string>\/Applications\/Claude\.app\/Contents\/Info\.plist<\/string>/);
  assert.match(plist, /<key>DUPE_HOME<\/key>/);
});

test('the launchd agent escapes what it interpolates', () => {
  const plist = schedule.launchdPlist({ command: '/bin/a&b', args: ['<x>'], minutes: 60 });
  assert.match(plist, /<string>\/bin\/a&amp;b<\/string>/);
  assert.match(plist, /<string>&lt;x&gt;<\/string>/);
  assert.ok(!plist.includes('<key>WatchPaths</key>'), 'no empty WatchPaths array');
});

test('the scheduled task scopes its logon trigger to one user', () => {
  // A logon trigger with no UserId means "any user signs in", and registering
  // one of those needs administrator rights — schtasks answers Access denied.
  const xml = schedule.taskXml({
    command: 'C:\\dupe\\dupe-autoupdate.exe', args: [], minutes: 360, userId: 'HK\\harsh',
    start: new Date(2026, 0, 2, 3, 4, 5),
  });
  assert.match(xml, /<LogonTrigger>.*<UserId>HK\\harsh<\/UserId>.*<\/LogonTrigger>/);
  assert.match(xml, /<Interval>PT6H<\/Interval>/);
  assert.match(xml, /<StartBoundary>2026-01-02T03:04:05<\/StartBoundary>/);
  assert.match(xml, /<Command>C:\\dupe\\dupe-autoupdate\.exe<\/Command>/);

  const anonymous = schedule.taskXml({ command: 'x', args: [], minutes: 30 });
  assert.ok(!anonymous.includes('<LogonTrigger>'), 'no unscoped logon trigger without a user');
  assert.match(anonymous, /<Interval>PT30M<\/Interval>/);
});

test('systemd gets a realtime timer when the interval divides the clock', () => {
  const six = schedule.systemdUnits({ command: 'node', args: ['dupe.js'], minutes: 360 });
  assert.match(six.timer, /OnCalendar=\*-\*-\* 0\/6:00:00/);
  assert.match(six.timer, /Persistent=true/); // catches up a run the machine slept through

  // Persistent= means nothing for a monotonic timer, so it isn't claimed.
  const ninety = schedule.systemdUnits({ command: 'node', args: [], minutes: 90 });
  assert.match(ninety.timer, /OnUnitActiveSec=90min/);
  assert.ok(!ninety.timer.includes('Persistent'));

  const half = schedule.systemdUnits({ command: 'node', args: [], minutes: 30 });
  assert.match(half.timer, /OnCalendar=\*:0\/30/);
});

test('systemd watches the stock apps too, the way launchd does', () => {
  const withWatch = schedule.systemdUnits({
    command: 'node', args: [], minutes: 360,
    watch: ['/usr/share/applications/claude.desktop'],
  });
  assert.match(withWatch.path, /PathChanged=\/usr\/share\/applications\/claude\.desktop/);
  assert.match(withWatch.path, /WantedBy=paths\.target/);
  assert.equal(schedule.systemdUnits({ command: 'node', args: [], minutes: 360 }).path, null);
});

test('the cron fallback repeats at the right rate and is tagged for removal', () => {
  assert.match(schedule.cronLine({ command: 'node', args: ['dupe.js'], minutes: 30 }), /^\*\/30 \* \* \* \* /);
  assert.match(schedule.cronLine({ command: 'node', args: [], minutes: 360 }), /^0 \*\/6 \* \* \* /);
  assert.match(schedule.cronLine({ command: 'node', args: [], minutes: 60 }), /# dupe autoupdate$/);
});

test('a macOS clone carries the fingerprint it was taken from', () => {
  const sh = selfHealScript(
    { id: 'claude', name: 'Claude' },
    { profile: 'work', label: 'Claude Work' },
    stamp('1.4.2|20260101|1750000000:4096|1750000000:120000'),
  );
  assert.match(sh, /BUILT_FROM='1\.4\.2\|20260101\|1750000000:4096\|1750000000:120000'/);
  assert.match(sh, /SOURCE='\/Applications\/Claude\.app'/);
  assert.match(sh, /update 'claude' 'work' --quiet/);
  // The shell half of stamp() has to produce the same four fields.
  assert.match(sh, /printf '%s\|%s\|%s\|%s'/);
  assert.equal(stamp('a|b|c|d').id.split('|').length, 4);
  // Nothing here may stop the app from starting.
  assert.match(sh, /if \[ -d "\$SOURCE" \] && \[ -x "\$\{DUPE\[0\]\}" \]/);
});

test('a clone with no fingerprint still launches', () => {
  const sh = selfHealScript({ id: 'x', name: 'X' }, { profile: 'p', label: 'L' }, null);
  assert.ok(!sh.includes('_dupe_stamp'));
  assert.match(sh, /^#/);
});
