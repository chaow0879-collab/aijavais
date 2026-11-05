#!/usr/bin/env node
'use strict';
// A read-only connection avoids triggering execution recovery in a live server.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { publishPrivateBackup } = require('../lib/private-backup');
const dir = path.resolve(process.env.AIJ_DATA_DIR || path.join(__dirname, '..', 'data'));
async function main() {
  const file = path.join(dir, 'projects.sqlite');
  if (!fs.existsSync(file)) throw new Error('Database not initialized: start AIJAVAIS once first');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (process.argv[2] === 'info') {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const integrity = db.prepare('PRAGMA quick_check').get().quick_check;
      const counts = {};
      for (const table of ['projects', 'runs', 'steps', 'messages', 'artifacts', 'usage_ledger']) counts[table] = db.prepare('SELECT count(*) n FROM ' + table).get().n;
      console.log(JSON.stringify({ schemaVersion: version, integrity, counts }, null, 2));
    } else if (process.argv[2] === 'backup') {
      const target = process.argv[3];
      if (!target) throw new Error('Usage: npm run db:backup -- /secure/path/projects-backup.sqlite');
      // Written inside a private 0700 staging directory, verified 0600 + quick_check,
      // then atomically linked without overwriting (see lib/private-backup.js).
      const out = await publishPrivateBackup(target, staged => backup(db, staged), { forbidden: [file, file + '-wal', file + '-shm'] });
      console.log(JSON.stringify({ backup: out.filename, mode: out.mode, bytes: out.bytes, quickCheck: out.quickCheck }));
      console.log('SQLite backup verified. Store the complete private data directory separately for auth/model credentials.');
    } else throw new Error('Usage: node tools/database.js info | backup <new-file>');
  } finally { db.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
