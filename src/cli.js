import path from 'node:path';
import { parseArgs } from 'node:util';
import { NAMED, ORDER, resolveColor } from './palette.js';
import { loadIcon, makeIcon, writeIcoFile, writeIcnsFile, writePng } from './icon.js';
import * as core from './core.js';

const HELP = `dupe — run any desktop app as several isolated, colour-coded profiles

Usage
  dupe list                      Apps found on this machine and profiles built so far
  dupe add <app> <profile>       Build a profile (e.g. dupe add claude work)
  dupe remove <app> <profile>    Remove a profile's launcher (keeps its data unless --purge)
  dupe rebuild [app]             Rebuild profiles after the stock app updated
  dupe open <app> <profile>      Launch a profile
  dupe ui                        Open the interface in your browser, connected to this computer
  dupe icon <file> <out>         Recolour any icon file (.exe .ico .icns .png) on its own
  dupe colors                    The named palette

<app> is a preset id (dupe list) or a path to an app: .app, .exe, .desktop, AppImage.

Options for add / rebuild
  --color <name|#hex>   Profile colour. Defaults to the next unused palette colour.
  --label <text>        Display name. Defaults to "<App> <Profile>".
  --treatment <t>       auto | hue | ramp-light | ramp-dark | none   (none keeps the icon as is)
  --arg <flag>          Extra launch flag (repeatable)
  --env KEY=VALUE       Extra environment variable (repeatable)
  --icon <file>         Use this icon (.png .ico .icns .exe) instead of the app's own
  --purge               With remove: also delete the profile's data

Options for ui
  --port <n>            Port to listen on (default: a free one)
  --no-open             Don't open the browser
`;

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      color: { type: 'string' }, label: { type: 'string' }, treatment: { type: 'string' },
      arg: { type: 'string', multiple: true }, env: { type: 'string', multiple: true }, icon: { type: 'string' },
      purge: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
      port: { type: 'string' }, open: { type: 'boolean', default: true },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd || cmd === 'help') { process.stdout.write(HELP); return 0; }
  const log = (l) => console.log(l);

  switch (cmd) {
    case 'list': return list();
    case 'colors': return colors();
    case 'add': {
      if (!rest[0] || !rest[1]) throw new Error('Usage: dupe add <app> <profile>');
      const record = await core.add(rest[0], rest[1], values, log);
      console.log(`\nBuilt "${record.label}". ${core.hint(record)}`);
      return 0;
    }
    case 'remove': case 'rm': {
      if (!rest[0] || !rest[1]) throw new Error('Usage: dupe remove <app> <profile> [--purge]');
      const record = await core.remove(rest[0], rest[1], { purge: values.purge }, log);
      console.log(values.purge ? '\nRemoved, including its data.' : `\nRemoved. Its data is still at ${record.dataDir}; pass --purge to delete that too.`);
      return 0;
    }
    case 'rebuild': {
      const results = await core.rebuild(rest[0], values, log);
      if (!results.length) console.log('Nothing to rebuild.');
      return 0;
    }
    case 'open': case 'launch': {
      if (!rest[0] || !rest[1]) throw new Error('Usage: dupe open <app> <profile>');
      await core.open(rest[0], rest[1]);
      return 0;
    }
    case 'ui': {
      const { serve } = await import('./server.js');
      await serve({ port: values.port ? Number(values.port) : 0, open: values.open });
      return new Promise(() => {}); // stays up until Ctrl-C
    }
    case 'icon': return icon(rest, values);
    default:
      throw new Error(`Unknown command "${cmd}". Run dupe --help.`);
  }
}

async function list() {
  const s = await core.state();
  console.log('Presets');
  for (const app of s.apps) {
    const mark = app.found ? '●' : '○';
    const note = app.verified ? '' : '  (Electron/Chromium flag, not individually verified)';
    console.log(`  ${mark} ${app.id.padEnd(10)} ${app.name.padEnd(20)} ${app.found ? app.found : 'not installed'}${app.found ? '' : note}`);
  }
  console.log('\nProfiles');
  if (!s.profiles.length) { console.log('  none yet — try: dupe add claude work'); return 0; }
  for (const p of s.profiles) {
    const target = p.launcher || p.bundle || p.desktop;
    console.log(`  ${p.color}  ${p.app}/${p.profile}`.padEnd(32) + ` "${p.label}"  ${target}`);
  }
  return 0;
}

function colors() {
  for (const name of ORDER) console.log(`  ${name.padEnd(8)} ${NAMED[name]}`);
  console.log('\nAll sit at the same OKLCH lightness and chroma, so a row of profiles reads as one set.');
  return 0;
}

function icon([input, output], values) {
  if (!input || !output) throw new Error('Usage: dupe icon <in.exe|.ico|.icns|.png> <out.ico|.icns|.png> --color blue');
  const source = loadIcon(input);
  const color = resolveColor(values.color) || NAMED.blue;
  const { master, treatment, stats } = makeIcon(source, color, values.treatment || 'auto');
  const ext = path.extname(output).toLowerCase();
  let sizes;
  if (ext === '.ico') sizes = writeIcoFile(master, output);
  else if (ext === '.icns') sizes = writeIcnsFile(master, output);
  else { writePng(master, output); sizes = [master.width]; }
  console.log(`${input} ${source.width}px → ${output} ${color} (${treatment}; field L ${stats.fieldL.toFixed(2)}, chroma ${stats.meanChroma.toFixed(3)}) sizes ${sizes.join(' ')}`);
  return 0;
}
