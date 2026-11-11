'use strict';
/* Private, verified, no-overwrite publication of an operator SQLite backup
 * (ProjectStore.backup(target) and `npm run db:backup`). Same pattern as the
 * audited migration backup (#6/#8, AUD-68-SEC-01), which stays untouched:
 *   1. a fresh mkdtemp directory (0700 from creation) next to the destination,
 *   2. the SQLite backup is written INSIDE it (its initial umask mode, e.g.
 *      0644, is never reachable through a 0700 parent),
 *   3. chmod 0600 + lstat verification (fails closed on a "fake" chmod),
 *   4. PRAGMA quick_check on a read-only immutable connection,
 *   5. link() to the destination: atomic, never overwrites (EEXIST), never
 *      crosses filesystems (same directory),
 *   6. remove the staging name/directory.
 * Before the old code's chmod, a backup written into an existing 0755
 * directory with umask 022 was briefly readable by other local users; and an
 * existsSync()-then-write sequence could overwrite a file created in between.
 * Trust boundary (as documented for #8): the destination's parent directory
 * must not be writable by untrusted users; same-UID attackers and exotic ACL
 * filesystems are out of scope and are not claimed to be protected. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class BackupError extends Error {
  constructor(message, code, status = 409) { super(message); this.code = code; this.status = status; }
}
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const immutableUri = file => 'file:' + encodeURI(path.resolve(file)).replace(/\?/g, '%3F').replace(/#/g, '%23') + '?immutable=1';
function quickCheck(file) {
  const db = new DatabaseSync(immutableUri(file), { readOnly: true });
  try { return db.prepare('PRAGMA quick_check').get().quick_check; } finally { db.close(); }
}
async function publishPrivateBackup(dest, write, { forbidden = [], fsImpl = fs } = {}) {
  dest = path.resolve(dest);
  if (forbidden.map(f => path.resolve(f)).includes(dest)) throw new BackupError('Backup target must not be the live database', 'backup_exists');
  if (exists(dest)) throw new BackupError('Backup target must be a new file', 'backup_exists');
  const parent = path.dirname(dest);
  fsImpl.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fsImpl.lstatSync(parent);
  if (!parentStat.isDirectory()) throw new BackupError('Backup directory is not a directory', 'backup_permissions', 503);
  const staging = fsImpl.mkdtempSync(path.join(parent, '.private-backup-'));
  const staged = path.join(staging, 'backup.sqlite');
  try {
    const dir = fsImpl.lstatSync(staging);
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && dir.uid !== process.getuid())) {
      throw new BackupError('Backup staging directory is not private', 'backup_permissions', 503);
    }
    await write(staged);
    fsImpl.chmodSync(staged, 0o600);
    const file = fsImpl.lstatSync(staged);
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw new BackupError('Backup file is not private', 'backup_permissions', 503);
    const integrity = quickCheck(staged);
    if (integrity !== 'ok') throw new BackupError('Backup integrity check failed: ' + String(integrity).slice(0, 200), 'backup_integrity', 503);
    try { fsImpl.linkSync(staged, dest); }
    catch (e) { if (e.code === 'EEXIST') throw new BackupError('Backup target appeared concurrently; nothing was overwritten', 'backup_exists'); throw e; }
    const out = fsImpl.lstatSync(dest);
    return { filename: dest, bytes: out.size, mode: (out.mode & 0o777).toString(8), quickCheck: integrity };
  } finally {
    // The source database is untouched, so our own staging copy is disposable:
    // after publication the destination name holds the same inode; before it,
    // the copy was never published. Removal is best-effort and never affects dest.
    try { fsImpl.unlinkSync(staged); } catch { /* absent or already removed */ }
    try { fsImpl.rmdirSync(staging); } catch { /* leave a non-empty/odd directory for inspection */ }
  }
}
module.exports = { publishPrivateBackup, quickCheck, immutableUri, BackupError };
