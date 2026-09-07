#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code || 0),
  (err) => {
    // What a user needs is the sentence, not the stack. DUPE_DEBUG=1 for the rest.
    console.error(process.env.DUPE_DEBUG || !err || !err.message ? (err && err.stack ? err.stack : String(err)) : err.message);
    process.exit(1);
  },
);
