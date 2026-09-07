// `dupe ui`: serves the interface from docs/ on 127.0.0.1 and exposes the
// core operations as a small JSON API so the same page that works on any
// device can, on this computer, detect apps and build profiles.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import * as upd from './update.js';
import * as schedule from './schedule.js';
import * as install from './install.js';
import { loadIcon, makeIcon } from './icon.js';
import { encodePng } from './image/png.js';
import { resize } from './image/resize.js';
import { loadStore } from './store.js';
import { EMBEDDED } from './embedded.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.json': 'application/json' };

import crypto from 'node:crypto';
import { DUPE_HOME } from './store.js';
import { ORDER, NAMED, resolveColor } from './palette.js';

// Recoloured icons are cached in memory and on disk (keyed by source path,
// colour and the source file's mtime), and pre-rendered for every installed
// app at startup so the colour strips appear at once.
// Bounded, because every distinct colour is a full recolour and a PNG kept
// in memory. The interface only ever asks for the eight palette hues plus the
// original, per app; a few hundred entries is more than a warm session needs.
const ICON_CACHE_MAX = 400;
const iconCache = new Map();

function remember(key, png) {
  iconCache.set(key, png);
  while (iconCache.size > ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value);
  return png;
}
// The decoded source, too: one app is recoloured nine ways for its strip, and
// pulling the icon out of a .exe's resources or an .icns is the expensive
// half of that. Keyed by path and mtime, so an app that updates is re-read.
const sourceCache = new Map();
const CACHE_DIR = path.join(DUPE_HOME, 'cache', 'icons');

function cacheFile(file, hex) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs | 0; } catch { /* aliases deny stat */ }
  const key = crypto.createHash('sha1').update(`${file}|${hex || ''}|${mtime}`).digest('hex');
  return path.join(CACHE_DIR, `${key}.png`);
}

async function warmIcons() {
  try {
    const s = await core.state();
    for (const app of s.apps) {
      if (!app.found) continue;
      for (const hex of [null, ...ORDER.map((n) => NAMED[n])]) {
        try { await appIcon(app.id, hex); } catch { /* not every app has an extractable icon */ }
        await new Promise((r) => setImmediate(r)); // let requests through between renders
      }
    }
  } catch { /* warm-up is best effort */ }
}

function loadSource(file) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs | 0; } catch { /* aliases deny stat */ }
  const key = `${file}|${mtime}`;
  if (!sourceCache.has(key)) {
    sourceCache.clear(); // one app's icon at a time is all the strips need
    sourceCache.set(key, loadIcon(file));
  }
  return sourceCache.get(key);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// A custom icon arrives as base64 in the body, so the cap is generous — but
// it is a cap, and going past it has to come back as an answer. Destroying
// the socket silently left the request hanging until the browser gave up.
const MAX_BODY = 8e6;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      data += c;
      if (data.length > MAX_BODY) { over = true; reject(new Error(`That's larger than ${MAX_BODY / 1e6} MB — pick a smaller icon.`)); req.destroy(); }
    });
    req.on('end', () => { if (!over) { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("That request wasn't valid JSON.")); } } });
    req.on('aborted', () => { if (!over) reject(new Error('The request was cut short.')); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

/**
 * Only the page this server served may call the API.
 *
 * The Host check below defeats DNS rebinding, and browsers attach Origin to
 * fetch, XHR and cross-origin form posts, so those are covered. What is not
 * covered is everything that omits Origin: an `<img>`, a `<script>`, an
 * `<iframe>`, a top-level navigation. Those carry `Host: 127.0.0.1:<port>`
 * like any same-origin request, so treating a missing Origin as friendly let
 * any page on the internet reach every GET route — and /api/updates writes
 * to profiles.json and spawns a process per profile. An ephemeral port is
 * 16k guesses with an <img> onerror, which is a speed bump, not a control.
 *
 * So the page is given a secret when it is served, and has to hand it back.
 * Headers cover fetch; the query string covers the icon endpoints, which are
 * loaded as image sources and cannot carry a header.
 */
const TOKEN = crypto.randomBytes(24).toString('base64url');

function invited(req, url) {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return false;
  if (req.headers.origin && !req.headers.origin.endsWith('//' + host)) return false;
  const offered = req.headers['x-dupe-token'] || url.searchParams.get('t') || '';
  // Same length every time, so the comparison leaks nothing by timing.
  const a = Buffer.from(String(offered));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The app's own icon, optionally recoloured. `source` is a preset id or a
// path to the app; results are cached per source and colour.
async function appIcon(source, profileHex) {
  const key = `${source}:${profileHex || ''}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const be = await core.backend();
  const app = core.resolveApp(source);
  const where = be.locate(app);
  if (!where) throw new Error('not installed');
  let file = where.exe || null;
  if (!file && where.bundle) {
    const res = path.join(where.bundle, 'Contents', 'Resources');
    const icns = fs.existsSync(res) ? fs.readdirSync(res).find((f) => f.endsWith('.icns')) : null;
    file = icns ? path.join(res, icns) : null;
  }
  if (!file && where.iconFile) file = where.iconFile;
  if (!file || !fs.existsSync(file)) throw new Error('no icon source');
  const onDisk = cacheFile(file, profileHex);
  if (fs.existsSync(onDisk)) {
    const png = fs.readFileSync(onDisk);
    return remember(key, png);
  }
  let img = loadSource(file);
  if (profileHex) img = makeIcon(img, profileHex, 'auto').master;
  const png = encodePng(resize(img, 128, 128));
  remember(key, png);
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(onDisk, png); } catch { /* cache is optional */ }
  return png;
}

async function api(req, res, url) {
  if (!invited(req, url)) return json(res, 403, { error: 'That request did not come from the page dupe served.' });
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/state') {
    const s = await core.state();
    s.apps = await install.annotate(s.apps);
    return json(res, 200, s);
  }
  if (req.method === 'GET' && p === '/api/updates') return json(res, 200, await upd.check({ app: url.searchParams.get('app') || undefined }));
  if (req.method === 'GET' && (p.startsWith('/api/app-icon/') || p === '/api/icon')) {
    const source = p === '/api/icon' ? url.searchParams.get('source') : decodeURIComponent(p.split('/')[3]);
    try {
      if (!source) throw new Error('source required');
      // Through the same door the CLI uses: a name or a #rrggbb, nothing
      // else. Anything accepted here becomes a cache key, a recolour on the
      // event loop and a file on disk.
      const asked = url.searchParams.get('color');
      const png = await appIcon(source, asked ? resolveColor(asked) : null);
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
  // Development only: docs/banner.html and docs/cheatsheet.html post their
  // rendered PNGs here when the server was started with DUPE_DEV_BANNER=1.
  // Inert otherwise, and it only ever writes one of the artwork files in docs/.
  if (p === '/api/dev/png') {
    if (!process.env.DUPE_DEV_BANNER) return json(res, 404, { error: 'Unknown endpoint' });
    const name = url.searchParams.get('name') || 'banner.png';
    if (!/^(banner|cheatsheet)\.png$/.test(name)) return json(res, 400, { error: 'Not one of the artwork files.' });
    const chunks = [];
    await new Promise((resolve, reject) => { req.on('data', (c) => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 2e7) req.destroy(); }); req.on('end', resolve); req.on('error', reject); });
    const out = path.join(DOCS, name);
    fs.writeFileSync(out, Buffer.concat(chunks));
    return json(res, 200, { saved: out, bytes: fs.statSync(out).size });
  }
  const lines = [];
  const log = (l) => lines.push(l);
  try {
    const body = await readBody(req);
    if (p === '/api/add') {
      const record = await core.add(body.app, body.profile, { color: body.color, label: body.label, treatment: body.treatment, iconData: body.iconData, icon: body.icon }, log);
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
    if (p === '/api/update') {
      const result = await upd.update({ app: body.app, profile: body.profile, all: !!body.all, force: !!body.force }, log);
      return json(res, 200, { result, summary: upd.summarize(result), log: lines, profiles: loadStore().profiles });
    }
    if (p === '/api/install') {
      const r = await install.install(body.app, { via: body.via }, log);
      return json(res, 200, { ok: true, opened: r.opened || null, already: !!r.already, log: lines });
    }
    if (p === '/api/autoupdate') {
      const status = body.on ? await schedule.enable({ every: body.every }) : body.on === false ? schedule.disable() : schedule.status();
      return json(res, 200, { autoupdate: status });
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

// Static files come from docs/ in a checkout, or from the copies embedded in
// a compiled binary (see scripts/build-embed.js).
// The interface is one file, served from docs/ in a checkout or from the
// copy embedded in a compiled binary. The token goes in as it is served, so
// the same file works unchanged on GitHub Pages, where there is no server,
// no token, and nothing to call.
function withToken(html) {
  return html.replace('<head>', `<head><meta name="dupe-token" content="${TOKEN}">`);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const type = TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream';
  const isPage = rel === '/index.html';
  const file = path.normalize(path.join(DOCS, rel));
  if (file.startsWith(DOCS) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (!isPage) return fs.createReadStream(file).pipe(res);
    return res.end(withToken(fs.readFileSync(file, 'utf8')));
  }
  const embedded = EMBEDDED[`docs${rel.replace(/\\/g, '/')}`];
  if (embedded !== undefined) {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return res.end(isPage ? withToken(embedded) : embedded);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
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
      setTimeout(warmIcons, 50);
      resolve({ server, url: addr });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* the URL is printed anyway */ }
}
