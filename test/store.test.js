// What the store promises: that a profile written by one process survives a
// second one that read the file before it, that a file it can't parse is
// never mistaken for an empty machine, and that a label can't be something
// the filesystem will refuse. All three were bugs once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-store-test-'));
process.env.DUPE_HOME = HOME;

const store = await import('../src/store.js');
const { checkLabel } = await import('../src/core.js');

const FILE = path.join(HOME, 'profiles.json');
const profile = (app, name, extra = {}) => ({ app, profile: name, label: `${app} ${name}`, color: '#1b91e3', ...extra });

function reset() {
  fs.rmSync(FILE, { force: true });
  for (const f of fs.readdirSync(HOME)) if (f.startsWith('profiles.json')) fs.rmSync(path.join(HOME, f), { force: true });
}

test('an empty machine reads as an empty store, not an error', () => {
  reset();
  assert.deepEqual(store.loadStore(), { version: 1, profiles: [] });
});

test('a store survives a round trip', () => {
  reset();
  const s = store.loadStore();
  store.upsertProfile(s, profile('claude', 'work'));
  store.saveStore(s);
  assert.equal(store.loadStore().profiles.length, 1);
  assert.equal(store.loadStore().profiles[0].label, 'claude work');
});

test('a file that will not parse is moved aside rather than read as no profiles', () => {
  reset();
  fs.writeFileSync(FILE, '{ this is not json');
  assert.throws(() => store.loadStore(), /isn't readable JSON/);
  // The bad copy is kept, and the next run starts clean rather than looping.
  assert.ok(fs.readdirSync(HOME).some((f) => f.startsWith('profiles.json.corrupt-')));
  assert.deepEqual(store.loadStore(), { version: 1, profiles: [] });
});

test('a truncated write is never visible, because the write is a rename', () => {
  reset();
  const s = store.loadStore();
  for (let i = 0; i < 40; i++) store.upsertProfile(s, profile('claude', `p${i}`));
  store.saveStore(s);
  // No temporary file is left behind, and what landed is complete.
  assert.deepEqual(fs.readdirSync(HOME).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(store.loadStore().profiles.length, 40);
});

test('a commit merges into the store as it is now, not the copy it read', () => {
  reset();
  // What a long rebuild does: read the store...
  const mine = store.loadStore();
  store.upsertProfile(mine, profile('claude', 'work'));
  store.saveStore(mine);
  const stale = store.loadStore(); // ...and hold on to it while building.

  // Meanwhile someone runs `dupe add slack personal`.
  const theirs = store.loadStore();
  store.upsertProfile(theirs, profile('slack', 'personal'));
  store.saveStore(theirs);

  // The rebuild finishes and writes its one record.
  assert.equal(stale.profiles.length, 1); // it never saw Slack
  store.commitProfile(profile('claude', 'work', { builtBy: '0.1.2' }));

  const after = store.loadStore();
  assert.equal(after.profiles.length, 2, 'the profile added during the rebuild is still there');
  assert.ok(after.profiles.find((p) => p.app === 'slack'));
  assert.equal(after.profiles.find((p) => p.app === 'claude').builtBy, '0.1.2');
});

test('a profile removed while it was being rebuilt is not resurrected', () => {
  reset();
  store.commitProfile(profile('claude', 'work'));
  store.commitRemoval('claude', 'work');
  const back = store.commitProfile(profile('claude', 'work'), { ifPresent: true });
  assert.equal(back, null);
  assert.deepEqual(store.loadStore().profiles, []);
});

test('a plain commit does create a profile that is not there yet', () => {
  reset();
  assert.ok(store.commitProfile(profile('claude', 'work')));
  assert.equal(store.loadStore().profiles.length, 1);
});

test('a lock left behind by a dead process does not wedge the next run', () => {
  reset();
  const lock = path.join(HOME, 'profiles.lock');
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  store.commitProfile(profile('claude', 'work'));
  assert.equal(store.loadStore().profiles.length, 1);
  assert.equal(fs.existsSync(lock), false, 'the stale lock is broken and cleaned up');
});

test('labels have to be something a filename, a .desktop and a bundle all accept', () => {
  assert.equal(checkLabel('Claude Work'), 'Claude Work');
  assert.equal(checkLabel('Claude · Acme'), 'Claude · Acme');
  for (const bad of ['Bad/Name', 'Bad\\Name', 'a:b', 'a"b', 'a<b', 'a|b', 'a?b', 'a*b']) {
    assert.throws(() => checkLabel(bad), /can't contain/, `${bad} should be refused`);
  }
  assert.throws(() => checkLabel('   '), /needs some text/);
  assert.throws(() => checkLabel(' Claude'), /start or end with/);
  assert.throws(() => checkLabel('Claude.'), /start or end with/);
  assert.throws(() => checkLabel('NUL'), /reserved device name/);
  assert.throws(() => checkLabel('x'.repeat(65)), /under 64/);
});

test('the suggested label in the error is one that would work', () => {
  try {
    checkLabel('Claude/Work');
    assert.fail('should have thrown');
  } catch (e) {
    const suggested = /--label "([^"]+)"/.exec(e.message);
    assert.ok(suggested, 'the message offers a replacement');
    assert.equal(checkLabel(suggested[1]), suggested[1]);
  }
});

test('two profiles cannot share a display name', async () => {
  reset();
  const core = await import('../src/core.js');
  const { findApp } = await import('../src/apps.js');
  const app = findApp('claude');
  const s = store.loadStore();
  store.upsertProfile(s, { ...profile('claude', 'work'), label: 'Claude Work' });

  // On macOS the clone is <label>.app beside the stock app, so the same
  // label is the same path and the second build deletes the first.
  assert.throws(
    () => core.prepare(app, 'personal', { label: 'Claude Work' }, s, null),
    /already the name of claude\/work/,
  );
  // The profile that owns the label may of course keep it.
  assert.equal(core.prepare(app, 'work', { label: 'Claude Work' }, s, s.profiles[0]).label, 'Claude Work');
});

test('a rebuild refuses to close a profile that is open', async () => {
  const core = await import('../src/core.js');
  const open = { label: 'Busy One', app: 'x', profile: 'y' };
  const be = { running: () => true };
  assert.throws(() => core.refuseIfOpen(be, open, {}), /open right now/);
  // --force is the way through, and a closed profile never asks.
  assert.doesNotThrow(() => core.refuseIfOpen(be, open, { force: true }));
  assert.doesNotThrow(() => core.refuseIfOpen({ running: () => false }, open, {}));
  // A backend that cannot tell must not block the build.
  assert.doesNotThrow(() => core.refuseIfOpen({ running: () => { throw new Error('no'); } }, open, {}));
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
