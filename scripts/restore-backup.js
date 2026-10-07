#!/usr/bin/env node
'use strict';

// Restores an Aqdi backup (.sql.gz.enc) into a database. Run it by hand, on the
// server (cPanel Terminal) or on a laptop, with the same SECRET_BOX_KEY and the
// database credentials in the environment or .env.
//
//   node scripts/restore-backup.js --file backups/aqdi-20261007-0200.sql.gz.enc --target aqdi_restore_check
//
// Options:
//   --file <path>      the backup file (required)
//   --target <name>    the database to restore into (required); created when missing
//   --sha <hex>        the expected sha256 (otherwise the backups table is asked)
//   --overwrite        allow a target that already has tables
//   --i-know-this-overwrites-production
//                      needed when --target equals DB_NAME (the live database)
// Exit code 0 only when the file is authentic and every table's row count matches.

require('dotenv').config({ quiet: true });

const { restoreBackup, BackupError } = require('../services/backup');

function parse(argv) {
  const args = { file: null, target: null, sha: null, overwrite: false, production: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--sha') args.sha = argv[++i];
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--i-know-this-overwrites-production') args.production = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args.unknown = a;
  }
  return args;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help || args.unknown || !args.file || !args.target) {
    console.error('Usage: node scripts/restore-backup.js --file <backup.sql.gz.enc> --target <database> [--sha <hex>] [--overwrite] [--i-know-this-overwrites-production]');
    return args.help ? 0 : 2;
  }
  try {
    const result = await restoreBackup({
      file: args.file, target: args.target, expectedSha: args.sha, overwrite: args.overwrite, allowProduction: args.production, log: (m) => console.log(m),
    });
    const names = Object.keys(result.tables);
    console.log(`\nRestored ${names.length} tables into ${args.target}. Row counts (restored / in backup):`);
    for (const name of names) console.log(`  ${name.padEnd(28)} ${String(result.tables[name]).padStart(8)} / ${result.expected[name]}`);
    console.log('\nOK: every table matches.');
    return 0;
  } catch (err) {
    if (err instanceof BackupError) console.error(`REFUSED (${err.code}): ${err.message}`);
    else console.error(`FAILED (${err.code || err.name})`);
    return 1;
  }
}

main().then((code) => process.exit(code));
