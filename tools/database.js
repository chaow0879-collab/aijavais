#!/usr/bin/env node
'use strict';
// A read-only connection avoids triggering execution recovery in a live server.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
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
      const dest = path.resolve(target);
      if (fs.existsSync(dest) || dest === file) throw new Error('Backup destination must be a new file');
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      await backup(db, dest);
      fs.chmodSync(dest, 0o600);
      const check = new DatabaseSync(dest, { readOnly: true });
      try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup integrity check failed'); }
      finally { check.close(); }
      console.log('SQLite backup verified. Store the complete private data directory separately for auth/model credentials.');
    } else throw new Error('Usage: node tools/database.js info | backup <new-file>');
  } finally { db.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
