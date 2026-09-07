#!/usr/bin/env node
// A scheduled job, and a macOS clone healing itself at launch, don't inherit
// the shell that set DUPE_HOME, so it travels on the command line instead.
// It has to reach the environment before any module that reads it is loaded,
// which is why this happens here and why the import below is dynamic.
const at = process.argv.indexOf('--dupe-home');
if (at > 1 && process.argv[at + 1]) {
  process.env.DUPE_HOME = process.argv[at + 1];
  process.argv.splice(at, 2);
}
const { main } = await import('../src/cli.js');

main(process.argv.slice(2)).then(
  (code) => process.exit(code || 0),
  (err) => {
    // What a user needs is the sentence, not the stack. DUPE_DEBUG=1 for the rest.
    console.error(process.env.DUPE_DEBUG || !err || !err.message ? (err && err.stack ? err.stack : String(err)) : err.message);
    process.exit(1);
  },
);
