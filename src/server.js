// `dupe ui`: serves the interface from docs/ on 127.0.0.1 and exposes the
// core operations as a small JSON API so the same page that works on any
// device can, on this computer, detect apps and build profiles.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import { loadIcon, makeIcon } from './icon.js';
import { encodePng } from './image/png.js';
import { resize } from './image/resize.js';
import { loadStore } from './store.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.json': 'application/json' };

const iconCache = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Only a page served by this very server may call the API: same-origin
// requests carry a matching Host, which also defeats DNS rebinding.
function sameOrigin(req) {
  const host = req.headers.host || '';
  return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) && (!req.headers.origin || req.headers.origin.endsWith('//' + host));
}

async function appIcon(appId, profileHex) {
  const key = `${appId}:${profileHex || ''}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const be = await core.backend();
  const app = core.resolveApp(appId);
  const where = be.locate(app);
  if (!where) throw new Error('not installed');
  const file = where.exe || (where.bundle ? path.join(where.bundle, 'Contents', 'Resources', 'electron.icns') : null);
  if (!file || !fs.existsSync(file)) throw new Error('no icon source');
  let img = loadIcon(file);
  if (profileHex) img = makeIcon(img, profileHex, 'auto').master;
  const png = encodePng(resize(img, 128, 128));
  iconCache.set(key, png);
  return png;
}

async function api(req, res, url) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/state') return json(res, 200, await core.state());
  if (req.method === 'GET' && p.startsWith('/api/app-icon/')) {
    const [, , , id] = p.split('/');
    try {
      const png = await appIcon(decodeURIComponent(id), url.searchParams.get('color'));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
      return res.end(png);
    } catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (req.method === 'GET' && p.startsWith('/api/profile-icon/')) {
    const [, , , app, profile] = p.split('/').map(decodeURIComponent);
    const rec = loadStore().profiles.find((r) => r.app === app && r.profile === profile);
    const file = rec && (rec.icon ? path.join(path.dirname(rec.icon), 'icon.png') : rec.iconPng);
    if (file && fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (rec) {
      try {
        const png = await appIcon(rec.app, rec.color);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(png);
      } catch { /* fall through */ }
    }
    return json(res, 404, { error: 'no icon' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const body = await readBody(req);
  const lines = [];
  const log = (l) => lines.push(l);
  try {
    if (p === '/api/add') {
      const record = await core.add(body.app, body.profile, { color: body.color, label: body.label, treatment: body.treatment }, log);
      return json(res, 200, { record, hint: core.hint(record), log: lines });
    }
    if (p === '/api/remove') {
      const record = await core.remove(body.app, body.profile, { purge: !!body.purge }, log);
      return json(res, 200, { record, log: lines });
    }
    if (p === '/api/rebuild') {
      const results = await core.rebuild(body.app, {}, log);
      return json(res, 200, { results, log: lines });
    }
    if (p === '/api/open') {
      const record = await core.open(body.app, body.profile);
      return json(res, 200, { record });
    }
    return json(res, 404, { error: 'Unknown endpoint' });
  } catch (e) {
    return json(res, 400, { error: e.message, log: lines });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(DOCS, rel));
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

export function serve({ port = 0, open = true } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = `http://127.0.0.1:${server.address().port}/`;
      console.log(`dupe ui at ${addr}  (Ctrl-C to stop)`);
      if (open) openBrowser(addr);
      resolve({ server, url: addr });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* the URL is printed anyway */ }
}
