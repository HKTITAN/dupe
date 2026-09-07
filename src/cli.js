import path from 'node:path';
import { parseArgs } from 'node:util';
import { NAMED, ORDER, resolveColor } from './palette.js';
import { loadIcon, makeIcon, writeIcoFile, writeIcnsFile, writePng } from './icon.js';
import * as core from './core.js';
import * as upd from './update.js';
import * as schedule from './schedule.js';
import * as inst from './install.js';

const HELP = `dupe — run any desktop app as several isolated, colour-coded profiles

Usage
  dupe list                      Apps found on this machine and profiles built so far
  dupe install <app>             Install the stock app itself, if it isn't here yet
  dupe add <app> <profile>       Build a profile (e.g. dupe add claude work)
  dupe remove <app> <profile>    Remove a profile's launcher (keeps its data unless --purge)
  dupe update [app] [profile]    Rebuild the profiles whose stock app has changed
  dupe autoupdate [on|off]       Do that in the background from now on (bare: show the schedule)
  dupe rebuild [app]             Rebuild every profile, changed or not
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

Options for install (and add --install)
  --yes                 Don't ask first. Required when there's no terminal to ask in.
  --via <how>           winget | brew | flatpak | download | page. Default: the best available.

Options for update
  --all                 Rebuild every profile, not only the ones that are behind
  --force               Rebuild a profile even while it's open (it will be restarted)
  --quiet               Say nothing; write to ~/.dupe/logs/autoupdate.log instead

Options for autoupdate
  --every <6h|90m>      How often to check. 15m to 24h; the default is every 6 hours.

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
      all: { type: 'boolean', default: false }, force: { type: 'boolean', default: false },
      every: { type: 'string' }, scheduled: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      install: { type: 'boolean', default: false }, yes: { type: 'boolean', short: 'y', default: false },
      via: { type: 'string' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd || cmd === 'help') { process.stdout.write(HELP); return 0; }
  const log = (l) => console.log(l);

  switch (cmd) {
    case 'list': return list();
    case 'colors': return colors();
    case 'install': {
      if (!rest[0]) throw new Error('Usage: dupe install <app>');
      return install(rest[0], values, log);
    }
    case 'add': {
      if (!rest[0] || !rest[1]) throw new Error('Usage: dupe add <app> <profile>');
      if (values.install) await install(rest[0], { ...values, yes: true }, log);
      let record;
      try {
        record = await core.add(rest[0], rest[1], values, log);
      } catch (e) {
        // The commonest first-run failure is that the app isn't here at all;
        // say where it comes from rather than just that it's missing.
        const advice = await inst.suggest(rest[0]);
        throw advice ? new Error(`${e.message}\n\n${advice}`) : e;
      }
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
    case 'update': {
      if (values.scheduled) { await upd.scheduledRun({ app: rest[0], profile: rest[1] }); return 0; }
      return update(rest, values, log);
    }
    case 'autoupdate': case 'auto': return autoupdate(rest, values);
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
  const apps = await inst.annotate(s.apps);
  for (const app of apps) {
    const mark = app.found ? '●' : '○';
    const how = app.install ? `  ·  dupe install ${app.id}` : '';
    console.log(`  ${mark} ${app.id.padEnd(10)} ${app.name.padEnd(20)} ${app.found ? app.found : `not installed${how}`}`);
  }
  console.log('\nProfiles');
  if (!s.profiles.length) { console.log('  none yet — try: dupe add claude work'); return 0; }
  for (const p of s.profiles) {
    const target = p.launcher || p.bundle || p.desktop;
    console.log(`  ${p.color}  ${p.app}/${p.profile}`.padEnd(32) + ` "${p.label}"  ${target}`);
  }
  return 0;
}

// Nothing is installed without a yes: a terminal is asked, and a script has
// to say --yes for itself.
async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function install(appSpec, values, log) {
  const p = await inst.plan(appSpec);
  if (p.installed) { console.log(`${p.app.name} is already installed: ${p.installed}`); return 0; }
  if (!p.steps.length) throw new Error(`dupe has no way to install ${p.app.name} on ${process.platform}. Install it yourself, then run dupe again.`);

  const step = values.via ? p.steps.find((s) => s.via === values.via) : p.steps[0];
  if (!step) throw new Error(`No "${values.via}" option for ${p.app.name} here. There is:\n${inst.describe(p).join('\n')}`);
  console.log(`${p.app.name} isn't installed here. dupe can get it:`);
  console.log(inst.describe({ steps: [step] }).join('\n'));
  if (p.steps.length > 1) console.log(`  (or --via ${p.steps.slice(1).map((s) => s.via).join(' / ')})`);
  if (step.via === 'download') console.log('  Downloads the vendor\'s installer over https and runs it. The exact\n              URL, size and SHA-256 are printed before it starts.');

  if (!values.yes && !(await confirm(step.via === 'page' ? 'Open that page?' : 'Go ahead?'))) {
    console.log(process.stdin.isTTY ? 'Left it alone.' : 'Nothing done — pass --yes to install without being asked.');
    return 1;
  }
  const r = await inst.install(appSpec, { via: step.via }, log);
  if (r.opened) console.log(`\nOpened ${r.opened}. Install it there, then run dupe again.`);
  else console.log(`\nInstalled ${p.app.name}. Now: dupe add ${p.app.id} work`);
  return 0;
}

async function update(rest, values, log) {
  // --quiet is what a profile's own launcher uses when it catches itself up
  // at launch: there is no terminal to print to, only the log.
  const lines = [];
  const r = await upd.update(
    { app: rest[0], profile: rest[1], all: values.all, force: values.force },
    values.quiet ? (l) => lines.push(l) : log,
  );
  if (values.quiet) {
    if (lines.length) upd.appendLog([...lines, upd.summarize(r)]);
    return r.failed.length ? 1 : 0;
  }
  if (!r.checked) { console.log('No profiles yet — try: dupe add claude work'); return 0; }
  console.log(`${r.updated.length || r.deferred.length || r.failed.length || r.missing.length ? '\n' : ''}${upd.summarize(r)}`);
  if (r.deferred.length && !values.force) {
    const them = r.deferred.length === 1 ? 'it' : 'them';
    console.log(`Close ${r.deferred.map((d) => `"${d.label}"`).join(', ')} and run it again, or dupe update --force to rebuild ${them} now.`);
  }
  if (r.missing.length) console.log(`Not installed any more: ${r.missing.map((m) => `"${m.label}"`).join(', ')}. Reinstall the app, or dupe remove the profile.`);
  return r.failed.length ? 1 : 0;
}

const ago = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : null);

async function autoupdate(rest, values) {
  const action = (rest[0] || 'status').toLowerCase();
  if (action === 'on' || action === 'enable') {
    const s = await schedule.enable({ every: values.every });
    console.log(`Auto-update is on — ${s.detail || schedule.humanInterval(s.everyMinutes)}.`);
    if (s.windowless === false) console.log('  note        csc.exe was missing, so the task runs in a console window every time.');
    return report(s);
  }
  if (action === 'off' || action === 'disable') {
    schedule.disable();
    console.log('Auto-update is off. Profiles stay as they are until you run dupe update.');
    return 0;
  }
  if (action !== 'status') throw new Error('Usage: dupe autoupdate [on|off]  (bare shows the schedule)');

  const s = schedule.status();
  if (!s.supported) { console.log(`No scheduler for ${process.platform}.`); return 0; }
  if (!s.enabled) {
    console.log('Auto-update is off.');
    console.log(`  turn it on  dupe autoupdate on${values.every ? ` --every ${values.every}` : ''}`);
    console.log(`  or by hand  dupe update`);
    return 0;
  }
  console.log(`Auto-update is on — ${s.detail || schedule.humanInterval(s.everyMinutes)}.`);
  return report(s);
}

function report(s) {
  const line = (k, v) => v && console.log(`  ${k.padEnd(11)} ${v}`);
  line(s.mechanism === 'schtasks' ? 'task' : s.mechanism === 'cron' ? 'crontab' : 'agent', s.where);
  line('next run', s.next);
  const last = s.lastRun;
  if (last) {
    const what = last.updated ? `${last.updated} updated` : last.deferred ? `${last.deferred} left open` : 'nothing to do';
    line('last run', `${ago(last.at)}  ·  ${what}${last.failed ? `, ${last.failed} failed` : ''}`);
  }
  line('log', s.log);
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
