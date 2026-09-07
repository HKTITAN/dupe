// `dupe ui` listens on 127.0.0.1, and everything on the machine can reach
// that — including a page you have open from anywhere else. Browsers attach
// Origin to fetch and XHR, but not to an <img>, a <script> or an <iframe>,
// and those carry the same Host as a real request. So the page is handed a
// secret when it is served and has to give it back; these tests are the
// proof, because the failure is silent and remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DUPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-server-test-'));

const { serve } = await import('../src/server.js');
const { server, url } = await serve({ port: 0, open: false });
const at = (p) => new URL(p, url).toString();

test('a request with no token is refused, however it is dressed', async () => {
  // What an <img src="http://127.0.0.1:PORT/api/updates"> on another site
  // looks like from here: right Host, no Origin, no token.
  for (const p of ['/api/state', '/api/updates', '/api/icon?source=claude']) {
    const r = await fetch(at(p));
    assert.equal(r.status, 403, `${p} should be refused`);
  }
  // And a POST, which is the one that changes things.
  const r = await fetch(at('/api/update'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 403);
});

test('the page is served with a token, and that token works', async () => {
  const html = await (await fetch(at('/'))).text();
  const token = /name="dupe-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(token && token.length >= 16, 'the page carries a token');

  // fetch can send a header.
  const byHeader = await fetch(at('/api/state'), { headers: { 'X-Dupe-Token': token } });
  assert.equal(byHeader.status, 200);
  const state = await byHeader.json();
  assert.ok(Array.isArray(state.apps));

  // An <img> cannot, so the icon routes take it in the query instead. The
  // icon itself may not exist on this machine; 403 is the failure we care
  // about, not 404.
  const byQuery = await fetch(at(`/api/icon?source=claude&t=${encodeURIComponent(token)}`));
  assert.notEqual(byQuery.status, 403, 'a token in the query is accepted');
});

test('a wrong token is refused, and a token of the wrong length does not throw', async () => {
  for (const bad of ['', 'nope', 'x'.repeat(200)]) {
    const r = await fetch(at('/api/state'), { headers: { 'X-Dupe-Token': bad } });
    assert.equal(r.status, 403, `"${bad.slice(0, 8)}" should be refused`);
  }
});

test('an Origin from somewhere else is refused even with a token', async () => {
  const html = await (await fetch(at('/'))).text();
  const token = /name="dupe-token" content="([^"]+)"/.exec(html)[1];
  const r = await fetch(at('/api/state'), {
    headers: { 'X-Dupe-Token': token, Origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.DUPE_HOME, { recursive: true, force: true });
});
