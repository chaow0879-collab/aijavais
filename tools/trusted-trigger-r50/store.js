'use strict';
// Durable one-shot bookkeeping for the trigger/broker layer (NOT the work ledger: R46 CAS
// stays the single authority for claims). SQLite, private directory, WAL, every insert is
// a unique-key transaction so concurrent processes cannot both "win" a delivery or approval.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function privateFile(file) {
  const abs = path.resolve(file), dir = path.dirname(abs);
  const roots = [os.tmpdir(), process.env.RUNNER_TEMP].filter(Boolean).map(r => path.resolve(r) + path.sep);
  if (!roots.some(r => abs.startsWith(r))) throw Object.assign(Error('STORE_MUST_BE_PRIVATE_TEMP'), { code: 'STORE_MUST_BE_PRIVATE_TEMP' });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) || st.uid !== process.getuid()) throw Object.assign(Error('UNSAFE_STORE_DIR'), { code: 'UNSAFE_STORE_DIR' });
  return abs;
}
class TriggerStore {
  constructor(file) {
    this.file = privateFile(file);
    if (!fs.existsSync(this.file)) fs.closeSync(fs.openSync(this.file, 'wx', 0o600));
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, event TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(approval_id TEXT PRIMARY KEY, approval_digest TEXT NOT NULL, work_key TEXT NOT NULL, first_signed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revocations(approval_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  // true only for the first sighting of a delivery id, across processes and restarts.
  claimDelivery(id, event, at) { return this.db.prepare('INSERT OR IGNORE INTO deliveries VALUES (?,?,?)').run(id, event, at).changes === 1; }
  // An approval id names exactly one approval content and one piece of work. Re-signing the
  // same work under the same approval (event and tick for one task) is idempotent; a reused
  // id with different content, or other work, is refused. Returns null or a reason code.
  bindApproval(approvalId, approvalDigest, workKey, at) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT approval_digest, work_key FROM approvals WHERE approval_id=?').get(approvalId);
      if (!row) this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?)').run(approvalId, approvalDigest, workKey, at);
      this.db.exec('COMMIT');
      return !row ? null : row.approval_digest !== approvalDigest ? 'APPROVAL_ID_REUSED' : row.work_key !== workKey ? 'APPROVAL_SCOPE_EXCEEDED' : null;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  revoke(approvalId, reason, at) { this.db.prepare('INSERT OR IGNORE INTO revocations VALUES (?,?,?)').run(approvalId, String(reason).slice(0, 80), at); }
  revoked(approvalId) { return !!this.db.prepare('SELECT 1 FROM revocations WHERE approval_id=?').get(approvalId); }
  audit(kind, detail, at = Date.now()) { this.db.prepare('INSERT INTO audit(at,kind,detail) VALUES (?,?,?)').run(at, kind, JSON.stringify(detail).slice(0, 2000)); }
  auditLog() { return this.db.prepare('SELECT at,kind,detail FROM audit ORDER BY seq').all().map(r => ({ at: r.at, kind: r.kind, detail: JSON.parse(r.detail) })); }
  close() { this.db.close(); }
}
module.exports = { TriggerStore };
