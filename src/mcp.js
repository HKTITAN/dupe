#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0) exposing dupe to agents. No dependencies:
// the protocol surface an agent needs — initialize, tools/list, tools/call,
// ping — is small enough to speak directly.
import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.js';
import { NAMED, ORDER, resolveColor } from './palette.js';
import { loadIcon, makeIcon, writeIcoFile, writeIcnsFile, writePng } from './icon.js';

const PROTOCOL = '2025-06-18';
const SERVER = { name: 'dupe', version: '0.1.0' };

const TOOLS = [
  {
    name: 'list_apps',
    description: 'Apps dupe knows how to profile, whether each is installed on this computer and where, plus every profile already built. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_profile',
    description: 'Build an isolated, colour-coded profile of a desktop app: its own data directory, launcher, Dock/Start Menu entry and recoloured icon. `app` is a preset id from list_apps (claude, chatgpt, grok-bot, slack, discord, notion, obsidian, vscode, cursor, chrome, edge, brave) or an absolute path to the app (.app bundle, .exe, .desktop, AppImage). Rebuilds in place if the profile exists.',
    inputSchema: {
      type: 'object',
      required: ['app', 'profile'],
      properties: {
        app: { type: 'string', description: 'Preset id or path to the app' },
        profile: { type: 'string', description: 'Short profile name, e.g. "work" or "client-a"' },
        color: { type: 'string', description: 'Palette name (blue, green, purple, amber, red, teal, pink, gray) or #rrggbb. Default: next unused palette colour for that app.' },
        label: { type: 'string', description: 'Display name. Default: "<App> <Profile>"' },
        treatment: { type: 'string', enum: ['auto', 'hue', 'ramp-light', 'ramp-dark', 'none'], description: 'How the icon is recoloured. Default auto; none keeps the icon as is.' },
        icon: { type: 'string', description: 'Absolute path to a custom icon (.png, .ico, .icns, .exe) to use instead of the app\'s own' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra launch flags' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables for the launcher' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'remove_profile',
    description: 'Remove a profile\'s launcher and menu entry. Profile data is kept unless purge is true.',
    inputSchema: {
      type: 'object', required: ['app', 'profile'],
      properties: { app: { type: 'string' }, profile: { type: 'string' }, purge: { type: 'boolean', description: 'Also delete the profile\'s data directory' } },
      additionalProperties: false,
    },
  },
  {
    name: 'rebuild_profiles',
    description: 'Rebuild every profile (or only one app\'s) from the current stock app. Needed on macOS after the stock app updates; harmless elsewhere.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'Limit to this preset id' } }, additionalProperties: false },
  },
  {
    name: 'open_profile',
    description: 'Launch a built profile.',
    inputSchema: { type: 'object', required: ['app', 'profile'], properties: { app: { type: 'string' }, profile: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'recolor_icon',
    description: 'Recolour an icon file toward a colour, keeping its detail, and write .png, .ico or .icns. Input may be .png, .ico, .icns, or a Windows .exe (icon is extracted from its resources). Useful for phone launchers, Shortcuts, or any app dupe can\'t automate.',
    inputSchema: {
      type: 'object', required: ['input', 'output'],
      properties: {
        input: { type: 'string', description: 'Absolute path to the source icon or executable' },
        output: { type: 'string', description: 'Absolute path ending in .png, .ico or .icns' },
        color: { type: 'string', description: 'Palette name or #rrggbb. Default blue (#1b91e3).' },
        treatment: { type: 'string', enum: ['auto', 'hue', 'ramp-light', 'ramp-dark'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'palette',
    description: 'The named profile colours (all at one OKLCH lightness and chroma so a set of profiles reads as a family).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function text(s) { return { content: [{ type: 'text', text: s }] }; }
function fail(s) { return { content: [{ type: 'text', text: s }], isError: true }; }

async function callTool(name, a = {}) {
  const lines = [];
  const log = (l) => lines.push(l);
  switch (name) {
    case 'list_apps': {
      const s = await core.state();
      return { ...text(JSON.stringify(s, null, 2)), structuredContent: s };
    }
    case 'add_profile': {
      const record = await core.add(a.app, a.profile, { color: a.color, label: a.label, treatment: a.treatment, icon: a.icon, arg: a.args, env: a.env ? Object.entries(a.env).map(([k, v]) => `${k}=${v}`) : undefined }, log);
      return { ...text(`${lines.join('\n')}\n\nBuilt "${record.label}". ${core.hint(record)}`), structuredContent: { record, hint: core.hint(record) } };
    }
    case 'remove_profile': {
      const record = await core.remove(a.app, a.profile, { purge: !!a.purge }, log);
      return { ...text(`${lines.join('\n')}\n\n${a.purge ? 'Removed, including its data.' : `Removed. Data kept at ${record.dataDir}.`}`), structuredContent: { record } };
    }
    case 'rebuild_profiles': {
      const results = await core.rebuild(a.app, {}, log);
      return { ...text(results.length ? lines.join('\n') : 'Nothing to rebuild.'), structuredContent: { results } };
    }
    case 'open_profile': {
      const record = await core.open(a.app, a.profile);
      return { ...text(`Opened ${record.label}.`), structuredContent: { record } };
    }
    case 'recolor_icon': {
      const source = loadIcon(a.input);
      const color = resolveColor(a.color) || NAMED.blue;
      const { master, treatment, stats } = makeIcon(source, color, a.treatment || 'auto');
      const ext = path.extname(a.output).toLowerCase();
      fs.mkdirSync(path.dirname(a.output), { recursive: true });
      let sizes;
      if (ext === '.ico') sizes = writeIcoFile(master, a.output);
      else if (ext === '.icns') sizes = writeIcnsFile(master, a.output);
      else { writePng(master, a.output); sizes = [master.width]; }
      const out = { output: a.output, color, treatment, sizes, fieldLightness: +stats.fieldL.toFixed(3), meanChroma: +stats.meanChroma.toFixed(3) };
      return { ...text(`Wrote ${a.output} (${color}, ${treatment}, sizes ${sizes.join(' ')}).`), structuredContent: out };
    }
    case 'palette': {
      const p = ORDER.map((n) => ({ name: n, hex: NAMED[n] }));
      return { ...text(p.map((c) => `${c.name.padEnd(7)} ${c.hex}`).join('\n')), structuredContent: { colors: p } };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---- transport: newline-delimited JSON-RPC over stdio
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = { protocolVersion: params && params.protocolVersion ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER, instructions: 'dupe builds isolated, colour-coded profiles of desktop apps. Call list_apps first; add_profile builds one. Everything runs on this computer; nothing is uploaded.' };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'tools/call':
        try { result = await callTool(params.name, params.arguments || {}); }
        catch (e) { result = fail(e.message); }
        break;
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}
