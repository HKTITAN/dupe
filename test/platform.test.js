// Platform backends, tested on the platform they are for. CI runs the suite
// on all three, so each machine proves its own half and nobody has to trust
// a code reading of the other two.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customApp } from '../src/apps.js';

const onWindows = process.platform === 'win32';

test('a Squirrel app that updates itself does not lose its profile', { skip: onWindows ? false : 'Windows only' }, async () => {
  // Squirrel installs to <root>\app-<version>\ and replaces that folder on
  // every update. A preset carries a glob and copes; an app found by
  // discovery is recorded at the exact path it was seen at, so without this
  // the first update leaves the profile reading as "not installed here any
  // more" — unrebuildable, for an app sitting right there.
  const be = await import('../src/platform/win32.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-squirrel-'));
  const build = (version) => {
    const dir = path.join(root, `app-${version}`);
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'x');
    fs.writeFileSync(path.join(dir, 'Foo.exe'), 'x');
    return path.join(dir, 'Foo.exe');
  };
  try {
    const found = build('1.0.9');
    assert.equal(be.locate(customApp(found)).exe, found);

    // It updates, and the folder it was found in goes away.
    const moved = build('1.0.10');
    fs.rmSync(path.join(root, 'app-1.0.9'), { recursive: true, force: true });
    assert.equal(be.locate(customApp(found)).exe, moved, 'the profile follows the app');

    // 1.0.10 is newer than 1.0.9 — a string sort would disagree, and Squirrel
    // apps number in the thousands, so the digit count does change.
    build('1.0.9');
    assert.equal(be.locate(customApp(found)).exe, moved, '1.0.10 beats 1.0.9');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an app that never moved is still found where it is', { skip: onWindows ? false : 'Windows only' }, async () => {
  const be = await import('../src/platform/win32.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-plain-'));
  try {
    const exe = path.join(root, 'Plain.exe');
    fs.writeFileSync(exe, 'x');
    assert.equal(be.locate(customApp(exe)).exe, exe);
    // And one that is genuinely gone stays gone, rather than matching
    // something else in the same directory.
    fs.rmSync(exe);
    assert.equal(be.locate(customApp(exe)), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Chromium is recognised by either layout, and absence is not claimed as presence', { skip: onWindows ? false : 'Windows only' }, async () => {
  const be = await import('../src/platform/win32.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-chromium-'));
  try {
    // An Electron app: the asar sits beside the binary.
    const electron = path.join(root, 'electron');
    fs.mkdirSync(path.join(electron, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(electron, 'resources', 'app.asar'), 'x');
    fs.writeFileSync(path.join(electron, 'App.exe'), 'x');
    assert.equal(be.usesChromium(path.join(electron, 'App.exe')), true);
    assert.equal(be.isElectron(path.join(electron, 'App.exe')), true);

    // A browser: its Chromium lives in a version-numbered folder alongside.
    const browser = path.join(root, 'browser');
    fs.mkdirSync(path.join(browser, '141.0.1.2'), { recursive: true });
    fs.writeFileSync(path.join(browser, '141.0.1.2', 'icudtl.dat'), 'x');
    fs.writeFileSync(path.join(browser, 'brow.exe'), 'x');
    assert.equal(be.usesChromium(path.join(browser, 'brow.exe')), true, 'a browser is Chromium too');
    assert.equal(be.isElectron(path.join(browser, 'brow.exe')), false, 'but it is not an Electron app');

    // Something with neither: dupe must not claim it isolates.
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'Thing.exe'), 'x');
    assert.equal(be.usesChromium(path.join(other, 'Thing.exe')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a preset is trusted, an unknown binary is not', async () => {
  const core = await import('../src/core.js');
  const be = await core.backend();
  const { findApp } = await import('../src/apps.js');
  assert.equal(core.isolation(findApp('claude'), be).confident, true);
  // A path that is not an app at all: dupe should decline to promise.
  const nothing = customApp(path.join(os.tmpdir(), 'definitely-not-here-' + process.pid));
  assert.equal(core.isolation(nothing, be).confident, false);
});
