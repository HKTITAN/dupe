import path from 'node:path';
import { parseArgs } from 'node:util';
import { NAMED, ORDER, resolveColor } from './palette.js';
import { loadIcon, makeIcon, writeIcoFile, writeIcnsFile, writePng } from './icon.js';
import * as core from './core.js';
import * as upd from './update.js';
import * as schedule from './schedule.js';
import * as inst from './install.js';
import { VERSION } from './embedded.js';
import { bold, dim, ink, pad, swatch } from './tty.js';

const HELP = `dupe ${VERSION} — run any desktop app as several isolated, colour-coded profiles

Usage
  dupe list                      Apps found on this machine and profiles built so far
  dupe status [app] [profile]    Whether each profile is level; name one to see what it isolates
  dupe install <app>             Install the stock app itself, if it isn't here yet
  dupe add <app> [profile]       Build a profile (e.g. dupe add claude work; profile defaults to work)
  dupe remove <app> <profile>    Remove a profile's launcher (keeps its data unless --purge)
  dupe update [app] [profile]    Rebuild the profiles that are behind
  dupe autoupdate [on|off]       Do that in the background from now on (bare: show the schedule)
  dupe rebuild [app]             Rebuild every profile, behind or not
  dupe open <app> <profile>      Launch a profile
  dupe ui                        Open the interface in your browser, connected to this computer
  dupe icon <file> <out>         Recolour any icon file (.exe .ico .icns .png) on its own
  dupe colors                    The named palette
  dupe log                       What the background updater has done lately
  dupe uninstall                 Remove every profile and everything dupe has written

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

Options for status / update
  --json                status only: the same answer as JSON, for scripts
  --all                 Rebuild every profile, not only the ones that are behind
  --force               Rebuild a profile even while it's open (it will be closed)
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
      via: { type: 'string' }, json: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version || cmd === 'version') { console.log(VERSION); return 0; }
  if (values.help || !cmd || cmd === 'help') { process.stdout.write(HELP); return 0; }
  const log = (l) => console.log(l);

  switch (cmd) {
    case 'list': return list();
    case 'colors': return colors();
    case 'status': return status(rest, values);
    case 'log': return showLog();
    case 'uninstall': return uninstall(values, log);
    case 'install': {
      if (!rest[0]) throw new Error('Usage: dupe install <app>');
      return install(rest[0], values, log);
    }
    case 'add': {
      if (!rest[0]) throw new Error('Usage: dupe add <app> [profile]');
      // Blue still means work, and the work one is the profile everybody
      // builds first, so it is what you get for not saying.
      const profile = rest[1] || 'work';
      if (values.install) await install(rest[0], { ...values, yes: true }, log);
      const existed = !!core.findProfile((await import('./store.js')).loadStore(), rest[0], profile);
      let record;
      try {
        record = await core.add(rest[0], profile, values, log);
      } catch (e) {
        // The commonest first-run failure is that the app isn't here at all;
        // say where it comes from rather than just that it's missing.
        const advice = await inst.suggest(rest[0]);
        throw advice ? new Error(`${e.message}\n\n${advice}`) : e;
      }
      console.log(`\n${swatch(record.color)} ${existed ? 'Updated' : 'Built'} ${bold(`"${record.label}"`)}. ${core.hint(record)}`);
      // Said once, when the first profile appears and nothing is keeping it
      // level yet. After that you know, and it stays quiet.
      const built = (await import('./store.js')).loadStore().profiles.length;
      if (!existed && built === 1 && !schedule.status().enabled) {
        console.log(dim(`\n${record.appName} updates itself; this copy of it doesn't, unless you say so:`));
        console.log(dim('  dupe autoupdate on'));
      }
      return 0;
    }
    case 'remove': case 'rm': {
      if (!rest[0] || !rest[1]) throw new Error('Usage: dupe remove <app> <profile> [--purge]');
      const store = (await import('./store.js')).loadStore();
      const doomed = core.findProfile(store, rest[0], rest[1]);
      if (!doomed) throw new Error(`No profile ${rest[0]}/${rest[1]}. Run dupe list.`);
      // --purge is the irreversible one: it takes the logins with it, so a
      // terminal is asked first. A script that says --purge means it, and is
      // not stopped by a question nobody is there to answer.
      if (values.purge && !values.yes && process.stdin.isTTY && process.stdout.isTTY) {
        console.log(`${swatch(doomed.color)} ${bold(doomed.label)}`);
        console.log(`  ${doomed.launcher || doomed.bundle || doomed.desktop}`);
        console.log(`  ${doomed.dataDir}  ${bold('and everything in it, including the login')}`);
        if (!(await confirm('\nDelete both?'))) { console.log('Left alone.'); return 0; }
      }
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
  console.log(bold('Presets'));
  const apps = await inst.annotate(s.apps);
  for (const app of apps) {
    const how = app.install ? dim(`  ·  dupe install ${app.id}`) : '';
    const where = app.found ? dim(app.found) : `${dim('not installed')}${how}`;
    console.log(`  ${app.found ? '●' : dim('○')} ${app.id.padEnd(10)} ${app.name.padEnd(20)} ${where}`);
  }
  if (s.others && s.others.length) {
    console.log(`\n${bold('Also on this machine')}  ${dim('— Electron apps with no preset. They work the same way.')}`);
    const names = s.others.map((o) => o.name);
    const width = process.stdout.columns || 80;
    let line = ' ';
    for (const n of names) {
      if (line.length + n.length + 2 > width - 2) { console.log(line); line = ' '; }
      line += ` ${n}${n === names[names.length - 1] ? '' : ','}`;
    }
    if (line.trim()) console.log(line);
    const example = /\s/.test(names[0]) ? `"${names[0]}"` : names[0];
    console.log(dim(`  dupe add ${example} work${names.length > 1 ? '  — or any of the others' : ''}`));
  }

  console.log(`\n${bold('Profiles')}`);
  if (!s.profiles.length) { console.log(dim('  none yet — try: dupe add claude work')); return 0; }
  // Which are behind, so one command answers both "what have I built" and
  // "is any of it stale". Best effort: a list that can't reach an app is
  // still a list.
  const behind = new Map();
  try {
    for (const p of (await upd.check()).profiles) behind.set(`${p.app}/${p.profile}`, p);
  } catch { /* fall back to showing what was built */ }
  for (const p of s.profiles) {
    const key = `${p.app}/${p.profile}`;
    const state = behind.get(key);
    const level = !state || state.state === 'current';
    const note = !state ? dim(p.launcher || p.bundle || p.desktop)
      : state.state === 'current' ? dim(state.version ? `current · ${state.version}` : 'current')
        : state.state === 'missing' ? dim(`${p.appName} isn't installed here any more`)
          : ink(p.color, `behind — ${state.why || 'the app has changed'}`);
    console.log(`  ${swatch(p.color, { filled: level })} ${pad(bold(p.label), 26)} ${pad(dim(key), 24)} ${note}`);
  }
  if ([...behind.values()].some((p) => p.state === 'stale')) console.log(dim('\n  dupe update brings them level. dupe status says more.'));
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

async function showLog() {
  const fs = await import('node:fs');
  const { LOG_FILE } = await import('./store.js');
  let text = '';
  try { text = fs.readFileSync(LOG_FILE, 'utf8'); } catch { /* nothing has run */ }
  const lines = text.split('\n').filter(Boolean).slice(-30);
  if (!lines.length) {
    console.log(schedule.status().enabled
      ? 'Nothing yet — the background updater only writes when it changes something.'
      : "Nothing yet. Auto-update is off; dupe autoupdate on starts it.");
    return 0;
  }
  for (const line of lines) {
    const at = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)  (.*)$/.exec(line);
    console.log(at ? `${dim(at[1])}  ${at[2]}` : line);
  }
  console.log(dim(`\n${LOG_FILE}`));
  return 0;
}

async function status(rest, values) {
  const s = await upd.check({ app: rest[0], profile: rest[1] });
  if (values.json) { console.log(JSON.stringify(s, null, 2)); return 0; }
  if (!s.profiles.length) {
    console.log(rest[0] ? `No profile ${rest.filter(Boolean).join('/')}. Run dupe list.` : 'No profiles yet — try: dupe add claude work');
    return 0;
  }
  // Naming one profile is a narrower question, so it gets a fuller answer:
  // what this profile actually keeps to itself. That is the promise the tool
  // makes, and until now there was no way to look at it.
  if (rest[0] && rest[1] && s.profiles.length === 1) return detail(s.profiles[0]);
  for (const p of s.profiles) {
    const mark = p.state === 'missing' ? dim('·') : swatch(p.color, { filled: p.state === 'current' });
    const note = p.state === 'current' ? dim(p.version ? `current · ${p.version}` : 'current')
      : p.state === 'missing' ? dim(`${p.appName} isn't installed here any more`)
        : `behind — ${p.why || 'the app has changed'}${p.running ? dim(', and open right now') : ''}`;
    console.log(`  ${mark} ${pad(bold(p.label), 26)} ${pad(dim(`${p.app}/${p.profile}`), 24)} ${note}`);
  }
  const auto = schedule.status();
  console.log('');
  if (s.stale) {
    console.log(auto.enabled
      ? `${s.stale} behind. Auto-update will pick ${s.stale === 1 ? 'it' : 'them'} up ${auto.detail || 'on its next run'}, or run dupe update now.`
      : `${s.stale} behind. Run dupe update, or dupe autoupdate on to keep them level from now on.`);
  } else {
    console.log(auto.enabled ? `All level. Auto-update is on, ${auto.detail || ''}`.trim() : 'All level. Auto-update is off — dupe autoupdate on keeps it that way.');
  }
  return 0;
}

// Everything dupe has written, in the order that leaves nothing orphaned:
// the schedule first, so nothing fires at a half-removed install, then the
// profiles, then dupe's own directory.
async function uninstall(values, log) {
  const store = (await import('./store.js')).loadStore();
  const auto = schedule.status();
  if (!values.yes) {
    console.log('dupe uninstall removes:');
    if (auto.enabled) console.log(`  the ${auto.mechanism} job that keeps profiles up to date`);
    for (const p of store.profiles) console.log(`  "${p.label}"  (${p.launcher || p.bundle || p.desktop})`);
    console.log(`  ${(await import('./store.js')).DUPE_HOME}`);
    console.log(values.purge ? '  and every profile\'s data, including its logins' : "\n  Profile data is kept. Add --purge to delete logins and history too.");
    console.log('\nRun it again with --yes to go ahead. dupe itself is removed with npm uninstall -g @hktitan/dupe,');
    console.log('or by deleting the binary you downloaded.');
    return 0;
  }
  if (auto.enabled) { schedule.disable(); log('  schedule    removed'); }
  for (const p of [...store.profiles]) {
    try {
      await core.remove(p.app, p.profile, { purge: values.purge }, log);
    } catch (e) {
      log(`  skipped     ${p.label}: ${e.message}`);
    }
  }
  const { DUPE_HOME } = await import('./store.js');
  const fs = await import('node:fs');
  fs.rmSync(DUPE_HOME, { recursive: true, force: true });
  log(`  removed     ${DUPE_HOME}`);
  console.log('\nGone. Remove dupe itself with npm uninstall -g @hktitan/dupe, or by deleting the binary.');
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

/** Everything one profile keeps to itself, and what it is a copy of. */
async function detail(summary) {
  const { loadStore } = await import('./store.js');
  const rec = loadStore().profiles.find((p) => p.app === summary.app && p.profile === summary.profile);
  if (!rec) { console.log('That profile is no longer in the store.'); return 1; }
  const line = (k, v) => v && console.log(`  ${dim(k.padEnd(12))} ${v}`);

  console.log(`${swatch(rec.color, { filled: summary.state === 'current' })} ${bold(rec.label)}   ${dim(`${rec.app}/${rec.profile}`)}`);
  console.log('');
  line('separate', `${rec.dataDir}${dim('   ← the login, the history, everything it stores')}`);
  // Some apps keep state outside the Chromium profile, and the preset pins
  // that too. It is the difference between "mostly separate" and separate,
  // so it belongs here rather than only in the README.
  const preset = upd.appOf(rec);
  const env = { ...(preset.env ? preset.env(rec.dataDir) : {}), ...(rec.extraEnv || {}) };
  for (const [k, v] of Object.entries(env)) line('', `${v}${dim(`   ← ${k}`)}`);
  for (const a of (preset.args ? preset.args(rec.dataDir) : [])) line('', `${a.replace(/^--[^=]+=/, '')}${dim(`   ← ${(/^--[^=]+/.exec(a) || [''])[0]}`)}`);
  line('launcher', rec.launcher || rec.bundle || rec.desktop);
  if (rec.shortcut) line('start menu', rec.shortcut);
  if (rec.aumid) line('taskbar id', rec.aumid);
  if (rec.bundleId) line('bundle id', rec.bundleId);
  if (rec.wmClass) line('wm class', rec.wmClass);
  if ((rec.extraArgs || []).length) line('extra flags', rec.extraArgs.join(' '));
  console.log('');
  line('copy of', `${summary.source || rec.source}${summary.version ? dim(`   ${summary.version}`) : ''}`);
  line('icon', `${ink(rec.color, rec.color)} ${dim(`${colorNameOf(rec.color)} · ${rec.treatment}${rec.iconFile ? ' · your own icon' : ''}`)}`);
  line('built', `${ago(rec.builtAt)}${rec.builtBy ? dim(`   by dupe ${rec.builtBy}`) : ''}`);
  console.log('');
  console.log(summary.state === 'current' ? `  ${dim('Level with the app it copies.')}`
    : summary.state === 'missing' ? `  ${rec.appName} isn't installed here any more.`
      : `  Behind — ${summary.why || 'the app has changed'}. ${dim('dupe update brings it level.')}`);
  return 0;
}

function colorNameOf(hex) {
  const name = ORDER.find((n) => NAMED[n].toLowerCase() === String(hex).toLowerCase());
  return name || 'custom';
}

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
  for (const name of ORDER) console.log(`  ${swatch(NAMED[name])} ${ink(NAMED[name], name.padEnd(8))} ${dim(NAMED[name])}`);
  console.log(dim('\nAll sit at the same OKLCH lightness and chroma, so a row of profiles reads as one set.'));
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
