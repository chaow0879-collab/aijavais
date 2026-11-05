#!/usr/bin/env node
'use strict';
/* READ-ONLY inventory of SQLite backup artefacts in the DATA directory
 * (#2 AUD-68-FU-01, #14 package 4). It never deletes, moves, renames, chmods,
 * restores or rolls back anything, never follows symlinks, and never opens a
 * database in a mode that can write (-wal/-shm included): integrity checks use
 * `file:...?immutable=1` read-only connections on regular files only.
 *
 * Reports:  .migration-backup-*  private staging dirs left by an interrupted migration
 *           .private-backup-*    private staging dirs left by an interrupted operator backup
 *           projects.sqlite.pre-vN-<ms>.bak  published migration backups
 * For each: kind, permissions/ownership, size, times, symlink status, SQLite
 * header (schema user_version), quick_check, and whether a staged copy is the
 * same inode as a published backup ("published"). A quick_check of "ok" is
 * NOT proof that a copy is complete or safe to restore; every item is marked
 * recoveryUse: manual_review_required. Cleanup or restore needs a separate,
 * human-approved procedure (docs/BACKUP-OPERATIONS.md).
 *
 * Usage: node tools/backup-inventory.js [DATA_DIR] [--json]
 * Exit:  0 scanned, nothing needing attention; 2 scanned, attention needed;
 *        1 could not scan (fail closed: no partial "all clear"). */
const fs = require('node:fs');
const path = require('node:path');
const { quickCheck } = require('../lib/private-backup');

const PATTERNS = [
  { kind: 'migration_staging', re: /^\.migration-backup-[A-Za-z0-9]+$/ },
  { kind: 'operator_backup_staging', re: /^\.private-backup-[A-Za-z0-9]+$/ },
  { kind: 'published_migration_backup', re: /^projects\.sqlite\.pre-v(\d+)-(\d+)\.bak$/ },
];
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const octal = mode => (mode & 0o777).toString(8).padStart(3, '0');
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

function header(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buf = Buffer.alloc(100);
    const n = fs.readSync(fd, buf, 0, 100, 0);
    if (n < 100 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') return { sqlite: false };
    const pageSize = buf.readUInt16BE(16);
    return { sqlite: true, pageSize: pageSize === 1 ? 65536 : pageSize, userVersion: buf.readUInt32BE(60), walMode: buf[18] === 2 || buf[19] === 2 };
  } finally { fs.closeSync(fd); }
}
function inspectFile(file, st, attention) {
  const out = { size: st.size, mode: octal(st.mode), uid: st.uid, ownedByCurrentUser: uid === null ? null : st.uid === uid, nlink: st.nlink, mtime: iso(st.mtimeMs), dev: st.dev, ino: st.ino };
  if (out.mode !== '600') attention.push('file mode ' + out.mode + ' (expected 600)');
  if (out.ownedByCurrentUser === false) attention.push('owned by another uid; not opened');
  if (out.ownedByCurrentUser === false || st.size === 0) { out.quickCheck = st.size === 0 ? 'empty_file' : 'not_run_foreign_owner'; return out; }
  try { Object.assign(out, { header: header(file) }); } catch (e) { out.header = { error: e.code || e.message }; attention.push('header unreadable'); return out; }
  if (!out.header.sqlite) { out.quickCheck = 'not_sqlite'; attention.push('not a SQLite database (possibly incomplete)'); return out; }
  try { out.quickCheck = quickCheck(file); } catch (e) { out.quickCheck = 'error: ' + String(e.message).slice(0, 160); }
  if (out.quickCheck !== 'ok') attention.push('quick_check ' + out.quickCheck);
  return out;
}
function inventory(dataDir) {
  dataDir = path.resolve(dataDir);
  const rootStat = fs.lstatSync(dataDir); // throws => fail closed
  if (!rootStat.isDirectory()) throw new Error('DATA path is not a directory (symlinks are not followed): ' + dataDir);
  const names = fs.readdirSync(dataDir).sort();
  const items = [], published = new Map();
  for (const name of names) {
    const match = PATTERNS.find(p => p.re.test(name));
    if (!match) continue;
    const full = path.join(dataDir, name), st = fs.lstatSync(full), attention = [];
    const item = { kind: match.kind, name, path: full, type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      mode: octal(st.mode), uid: st.uid, ownedByCurrentUser: uid === null ? null : st.uid === uid, created: iso(st.birthtimeMs), mtime: iso(st.mtimeMs), attention, recoveryUse: 'manual_review_required' };
    if (item.type === 'symlink') { attention.push('symlink not followed'); items.push(item); continue; }
    if (match.kind === 'published_migration_backup') {
      const m = match.re.exec(name); item.targetSchemaVersion = Number(m[1]); item.createdFromName = iso(Number(m[2]));
      if (item.type !== 'file') attention.push('not a regular file'); else { item.file = inspectFile(full, st, attention); published.set(st.dev + ':' + st.ino, name); }
    } else {
      if (item.type !== 'directory') attention.push('not a directory');
      else {
        if (item.mode !== '700') attention.push('staging directory mode ' + item.mode + ' (expected 700)');
        if (item.ownedByCurrentUser === false) attention.push('staging directory owned by another uid; contents not opened');
        else {
          item.entries = [];
          for (const child of fs.readdirSync(full).sort()) {
            const cp = path.join(full, child), cs = fs.lstatSync(cp), entry = { name: child, type: cs.isSymbolicLink() ? 'symlink' : cs.isFile() ? 'file' : cs.isDirectory() ? 'directory' : 'other' };
            if (child !== 'backup.sqlite') attention.push('unexpected entry ' + child);
            if (entry.type === 'symlink') attention.push('symlink ' + child + ' not followed');
            else if (entry.type === 'file' && child === 'backup.sqlite') entry.file = inspectFile(cp, cs, attention);
            item.entries.push(entry);
          }
          if (!item.entries.length) attention.push('empty staging directory (interrupted before the copy was written)');
        }
      }
    }
    items.push(item);
  }
  // A staged copy that is the same inode as a published backup was already published
  // (crash/unlink failure after link). Otherwise it was never published.
  for (const item of items) for (const entry of item.entries || []) {
    if (!entry.file) continue;
    const key = entry.file.dev + ':' + entry.file.ino;
    entry.published = published.has(key) ? published.get(key) : false;
    if (!entry.published) item.attention.push('staged copy was never published: possibly incomplete; never restore without quick_check, identity/version check and approval');
  }
  for (const item of items) for (const f of [item.file, ...(item.entries || []).map(e => e.file)]) if (f) { delete f.dev; delete f.ino; }
  let disk = null;
  try { const s = fs.statfsSync(dataDir); disk = { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }; } catch { disk = null; }
  const leftoverBytes = items.reduce((n, i) => n + (i.file?.size || 0) + (i.entries || []).reduce((m, e) => m + (e.file?.size || 0), 0), 0);
  return { dataDir, scannedAt: new Date().toISOString(), readOnly: true, aclChecked: false, items, leftoverBytes, disk,
    attentionCount: items.filter(i => i.attention.length).length,
    note: 'Read-only scan. POSIX mode/owner only; ACLs are not inspected. quick_check ok is not proof of completeness or restorability. Nothing was deleted, moved, restored or rolled back.' };
}
function main(argv) {
  const args = argv.filter(a => a !== '--json');
  if (args.some(a => a.startsWith('-'))) { console.error('Unsupported option. This tool is read-only and has no delete/restore/rollback options.'); return 1; }
  if (args.length > 1) { console.error('Usage: node tools/backup-inventory.js [DATA_DIR] [--json]'); return 1; }
  const dir = args[0] || process.env.AIJ_DATA_DIR || path.join(__dirname, '..', 'data');
  let report;
  try { report = inventory(dir); } catch (e) { console.error(JSON.stringify({ ok: false, error: e.code || e.message, note: 'Scan failed; no conclusion about backups can be drawn.' })); return 1; }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`DATA ${report.dataDir} — ${report.items.length} backup artefact(s), ${report.attentionCount} need attention, leftover bytes ${report.leftoverBytes}` + (report.disk ? `, free ${report.disk.freeBytes}` : ''));
    for (const i of report.items) console.log(`- [${i.kind}] ${i.name} ${i.type} mode=${i.mode}` + (i.attention.length ? ' ATTENTION: ' + i.attention.join('; ') : ''));
    console.log(report.note);
  }
  return report.attentionCount ? 2 : 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { inventory, main };
