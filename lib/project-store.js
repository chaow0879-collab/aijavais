'use strict';
/* V2 durable execution store. Legacy model/team/auth JSON stores remain independent.
 * Schema migrations are forward-only; rollback means restoring a verified SQLite backup.
 * No running work is replayed after restart, including tool calls and paid model calls.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');
const { publishPrivateBackup, BackupError } = require('./private-backup');

const SCHEMA_VERSION = 5;
// Forward-only migrations. Each runs in one transaction after an automatic
// consistent pre-migration copy (VACUUM INTO) of an existing database.
const MIGRATIONS = [
  { version: 2, description: 'Project materials: uploaded files, bytes and extracted text', sql: `
    CREATE TABLE project_files(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, sha256 TEXT NOT NULL, metadata TEXT NOT NULL, content BLOB NOT NULL, text TEXT NOT NULL);
    CREATE INDEX project_files_project ON project_files(project_id,created_at);` },
  { version: 3, description: 'System usage ledger for model calls outside project runs (connection tests)', sql: `
    CREATE TABLE system_usage(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
    CREATE INDEX system_usage_time ON system_usage(created_at);` },
  { version: 4, description: 'Durable model request claims, dispatch state and conservative restart recovery', sql: `
    CREATE TABLE model_requests(
      owner_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL, params_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('claimed','dispatching','completed','failed','not_dispatched','interrupted_unknown')),
      ledger_id TEXT NOT NULL UNIQUE REFERENCES system_usage(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      dispatched_at INTEGER, settled_at INTEGER,
      PRIMARY KEY(owner_id,kind,request_id));
    CREATE INDEX model_requests_state ON model_requests(state);
    CREATE INDEX system_usage_status ON system_usage(json_extract(doc,'$.status'));`, apply: migrateLegacyRequests },
  // B8: front-end user accounts. The administrator stays in auth.json; users never get admin rights.
  // password holds the scrypt record (salt + hash only, never plaintext); caps are integer fen (CNY).
  { version: 5, description: 'Front-end user accounts: username, scrypt password, enabled flag and monthly CNY cap', sql: `
    CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), monthly_cap_fen INTEGER NOT NULL CHECK(monthly_cap_fen >= 0),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, password TEXT NOT NULL);
    CREATE INDEX projects_owner ON projects(owner_id,created_at);
    CREATE INDEX runs_created ON runs(created_at);` },
];
const FILE_LIMITS = Object.freeze({ maxFilesPerProject: 50, maxProjectBytes: 64 * 1024 * 1024 });
const id = prefix => prefix + crypto.randomBytes(12).toString('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const parse = row => row ? JSON.parse(row.doc) : null;
class ProjectError extends Error {
  constructor(message, code = 'invalid', status = 400) { super(message); this.code = code; this.status = status; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // Malformed lock is not evidence of a dead owner.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function readLock(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > 2048) throw new ProjectError('Invalid database lock; inspect it while all instances are stopped', 'data_locked', 503);
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new ProjectError('Unreadable database lock; inspect it while all instances are stopped', 'data_locked', 503); }
}
function acquireLock(filename) {
  const lockfile = filename + '.lock';
  const token = crypto.randomBytes(16).toString('hex');
  const create = () => {
    const fd = fs.openSync(lockfile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = readLock(lockfile);
    if (pidAlive(old.pid)) throw new ProjectError('This data directory is already owned by a live application instance', 'data_locked', 503);
    // Serialize stale-owner recovery so two fresh processes cannot remove each other's locks.
    // A crash during this tiny recovery critical section fails closed for manual inspection.
    const recovery = lockfile + '.recovery';
    let recoveryFd;
    try { recoveryFd = fs.openSync(recovery, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') throw new ProjectError('Database lock recovery is already in progress; inspect stale recovery lock with all instances stopped', 'data_locked', 503); throw err; }
    try {
      fs.writeFileSync(recoveryFd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      const current = readLock(lockfile);
      if (current.token !== old.token || pidAlive(current.pid)) throw new ProjectError('Database lock ownership changed', 'data_locked', 503);
      fs.unlinkSync(lockfile);
      try { create(); }
      catch (err) { if (err.code === 'EEXIST') throw new ProjectError('Database lock acquired by another instance', 'data_locked', 503); throw err; }
    } finally { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
  }
  return () => {
    try { if (readLock(lockfile).token === token) fs.unlinkSync(lockfile); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
}

const LEGACY_OWNER = '*'; // A v3 row has no provable owner; reserve its key across all owners.
function requestRecord(row) {
  return row ? { ownerId: row.owner_id, kind: row.kind, requestId: row.request_id, paramsHash: row.params_hash,
    state: row.state, ledgerId: row.ledger_id, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    dispatchedAt: row.dispatched_at === null ? null : Number(row.dispatched_at), settledAt: row.settled_at === null ? null : Number(row.settled_at) } : null;
}
function bound(...values) { return Math.max(0, ...values.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)); }
function interruptedUsage(current, now, legacy = false) {
  // Even a historical zero cost is not proof that a request was never sent.
  // Preserve the reservation and its bounds instead of manufacturing a bill.
  const tokenBound = bound(current.reservedTokens, current.tokenUpperBound, current.tokens);
  const costBound = bound(current.reservedCost, current.costUpperBound, current.budgetCost, current.cost);
  return { ...current, status: 'interrupted_unknown', requestSent: true, ok: false,
    tokens: null, cost: null, tokenSource: 'reserved_unknown', costSource: legacy ? 'legacy_dispatch_unknown' : 'restart_unknown',
    budgetCost: costBound, tokenUpperBound: tokenBound, costUpperBound: costBound,
    reservedTokens: tokenBound, reservedCost: costBound, needsReconciliation: true, interruptedAt: now };
}
function notDispatchedUsage(current, now) {
  return { ...current, status: 'not_dispatched', requestSent: false, ok: false,
    tokens: 0, inTokens: 0, outTokens: 0, cost: 0, budgetCost: 0,
    tokenUpperBound: bound(current.tokenUpperBound, current.reservedTokens), costUpperBound: bound(current.costUpperBound, current.reservedCost),
    reservedTokens: 0, reservedCost: 0, tokenSource: 'not_dispatched', costSource: 'not_dispatched_restart',
    needsReconciliation: false, settledAt: now, errorCode: 'restart_before_dispatch' };
}
function migrateLegacyRequests(db) {
  const now = Date.now();
  const insert = db.prepare('INSERT INTO model_requests(owner_id,kind,request_id,params_hash,state,ledger_id,created_at,updated_at,dispatched_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,kind,request_id) DO NOTHING');
  // Process every historic draft, not only the pending ones: a completed v3 ID
  // must not become a fresh paid request after upgrading. Never delete a ledger
  // row when duplicate historic IDs are collapsed to one blocking tombstone.
  for (const row of db.prepare("SELECT id,created_at,doc FROM system_usage WHERE json_extract(doc,'$.kind')='intake_draft' ORDER BY created_at,rowid").all()) {
    let doc = JSON.parse(row.doc);
    if (doc.status === 'reserved') {
      doc = interruptedUsage(doc, now, true);
      db.prepare('UPDATE system_usage SET doc=? WHERE id=?').run(JSON.stringify(doc), row.id);
    }
    if (typeof doc.requestId !== 'string' || !doc.requestId) continue;
    const state = ['completed', 'failed', 'not_dispatched'].includes(doc.status) ? doc.status : 'interrupted_unknown';
    insert.run(LEGACY_OWNER, 'intake_draft', doc.requestId, 'legacy-v3-unknown', state, row.id, Number(row.created_at), now,
      null, state === 'interrupted_unknown' ? null : (Number(doc.settledAt) || now));
  }
}

function migrationBackup(db, filename, version) {
  const backup = `${filename}.pre-v${version}-${Date.now()}.bak`;
  // Existing DATA may be 0755. mkdtemp creates a private directory from the
  // outset, so VACUUM's initial file mode (possibly 0644) is never exposed.
  // Do not temporarily change the process-wide umask or rely on its value.
  const staging = fs.mkdtempSync(path.join(path.dirname(filename), '.migration-backup-'));
  const directory = fs.lstatSync(staging);
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) {
    throw new ProjectError('Migration backup directory is not private', 'backup_permissions', 503);
  }
  const stagedBackup = path.join(staging, 'backup.sqlite');
  db.prepare('VACUUM INTO ?').run(stagedBackup);
  fs.chmodSync(stagedBackup, 0o600);
  const file = fs.lstatSync(stagedBackup);
  if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
    throw new ProjectError('Migration backup file is not private', 'backup_permissions', 503);
  }
  // Same-filesystem link is atomic and refuses an existing destination. Both
  // names reference the already-protected inode; unlike rename, no old backup
  // can be overwritten. Unsupported filesystems fail closed before migration.
  fs.linkSync(stagedBackup, backup);
  fs.unlinkSync(stagedBackup);
  fs.rmdirSync(staging);
  // On any failure/crash, retain the private directory and/or published backup
  // as recovery evidence. Never delete a possibly complete migration backup.
  return backup;
}

class ProjectStore {
  constructor({ dir } = {}) {
    if (!dir) throw new ProjectError('ProjectStore requires a persistent data directory');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.filename = path.join(path.resolve(dir), 'projects.sqlite');
    this.releaseLock = acquireLock(this.filename);
    try {
    this.db = new DatabaseSync(this.filename);
    fs.chmodSync(this.filename, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    const v = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (v > SCHEMA_VERSION) throw new ProjectError('Database schema is newer than this application', 'schema_newer', 503);
    if (v === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT NOT NULL);
        CREATE TABLE projects(id TEXT PRIMARY KEY, version INTEGER NOT NULL, owner_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE TABLE runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX runs_project ON runs(project_id,created_at);
        CREATE TABLE steps(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, step_id TEXT NOT NULL, ordinal INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(run_id,step_id));
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX events_run ON events(run_id,seq);
        CREATE TABLE messages(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX messages_run ON messages(run_id,created_at);
        CREATE TABLE artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, metadata TEXT NOT NULL, content BLOB NOT NULL);
        CREATE INDEX artifacts_run ON artifacts(run_id,created_at);
        CREATE TABLE usage_ledger(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE TABLE settings(key TEXT PRIMARY KEY, doc TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      this.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(1, Date.now(), 'V2 projects, bounded runs, evidence, artifact bytes and usage ledger');
    });
    let current = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    for (const m of MIGRATIONS) {
      if (current >= m.version) continue;
      if (current > 1 || v !== 0) {
        // Publish a protected consistent copy before changing the schema.
        const backup = migrationBackup(this.db, this.filename, m.version);
        this.migrationBackups = [...(this.migrationBackups || []), backup];
      }
      this.transaction(() => {
        this.db.exec(m.sql);
        if (m.apply) m.apply(this.db);
        this.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version, Date.now(), m.description);
        this.db.exec(`PRAGMA user_version=${m.version}`);
      });
      current = m.version;
    }
    this.schemaVersion = SCHEMA_VERSION;
    // The DATA lock is held before recovering any request. Another live owner
    // cannot be mistaken for an interrupted executor. Recovery never sends I/O.
    this.recoverModelRequests();
    this.transaction(() => {
      const rows = this.db.prepare("SELECT doc FROM runs WHERE status IN ('running','queued') OR json_extract(doc,'$.executionActive')=1").all();
      for (const row of rows) {
        const run = parse(row);
        const u = run.usage || {};
        const outstandingTokens = Number(u.reservedTokens) || 0, outstandingCost = Number(u.reservedCost) || 0;
        if (outstandingTokens || outstandingCost) this.recordUsage(run.runId, { tokenSource: 'reserved_unknown', tokens: outstandingTokens, cost: outstandingCost, costSource: 'restart_unknown', currency: 'USD', failed: true });
        this.updateRun(run.runId, { status: run.status === 'cancelled' ? 'cancelled' : 'interrupted', executionActive: false, error: 'Server restarted; no model or tool call was replayed', interruptedAt: Date.now(),
          usage: { ...u, usedTokens: (u.usedTokens || 0) + outstandingTokens, estimatedTokens: (u.estimatedTokens || 0) + outstandingTokens, cost: (u.cost || 0) + outstandingCost, reservedTokens: 0, reservedCost: 0 } });
        this.appendEvent(run.runId, { eventType: 'run_interrupted', executionMode: 'server', reason: 'restart' });
        for (const step of this.getSteps(run.runId)) if (step.status === 'running') this.saveStep(run.runId, { ...step, status: 'interrupted', endedAt: Date.now() });
        for (const message of this.getMessages(run.runId)) if (['created', 'queued', 'delivered'].includes(message.status)) this.putMessage(run.runId, { ...message, status: 'interrupted', interruptedAt: Date.now() });
      }
    });
    } catch (err) {
      try { this.db?.close(); } catch { /* Preserve initialization error. */ }
      this.releaseLock(); this.releaseLock = null;
      throw err;
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  createProject(input, { ownerId = null } = {}) {
    const now = Date.now(), projectId = id('prj_');
    const doc = { ...clone(input), projectId, ownerId, version: 1, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').run(projectId, 1, ownerId, now, now, JSON.stringify(doc));
    return doc;
  }
  getProject(projectId) { return parse(this.db.prepare('SELECT doc FROM projects WHERE id=?').get(String(projectId))); }
  listProjects({ ownerId, limit = 100 } = {}) {
    limit = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = ownerId === undefined ? this.db.prepare('SELECT doc FROM projects ORDER BY updated_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT doc FROM projects WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?').all(ownerId, limit);
    return rows.map(parse);
  }
  updateProject(projectId, input, { expectedVersion } = {}) {
    return this.transaction(() => {
      const previous = this.getProject(projectId);
      if (!previous) throw new ProjectError('Project not found', 'not_found', 404);
      if (!Number.isInteger(expectedVersion) || previous.version !== expectedVersion) throw new ProjectError('Project version changed; reload before saving', 'version_conflict', 409);
      const doc = { ...previous, ...clone(input), projectId, ownerId: previous.ownerId, createdAt: previous.createdAt, version: previous.version + 1, updatedAt: Date.now() };
      this.db.prepare('UPDATE projects SET version=?,updated_at=?,doc=? WHERE id=?').run(doc.version, doc.updatedAt, JSON.stringify(doc), projectId);
      return doc;
    });
  }
  deleteProject(projectId) {
    if (this.db.prepare("SELECT id FROM runs WHERE project_id=? AND (status IN ('running','queued') OR json_extract(doc,'$.executionActive')=1)").get(projectId)) throw new ProjectError('Wait for active or cancelled in-flight work to settle before deleting', 'run_active', 409);
    return this.db.prepare('DELETE FROM projects WHERE id=?').run(projectId).changes > 0;
  }
  createRun(project, options = {}) {
    const now = Date.now(), runId = id('run_');
    const doc = { runId, projectId: project.projectId, projectVersion: project.version, ownerId: project.ownerId, status: 'running', round: 1, createdAt: now, updatedAt: now,
      steps: [], usage: { providerTokens: 0, estimatedTokens: 0, cost: 0, reservedCost: 0, reservedTokens: 0, currency: 'USD' }, ...clone(options) };
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(runId, project.projectId, doc.status, now, now, JSON.stringify(doc));
    return doc;
  }
  getRun(runId) { return parse(this.db.prepare('SELECT doc FROM runs WHERE id=?').get(String(runId))); }
  listRuns(projectId, { limit = 100 } = {}) {
    limit = Math.max(1, Math.min(500, Number(limit) || 100));
    return (projectId ? this.db.prepare('SELECT doc FROM runs WHERE project_id=? ORDER BY created_at DESC LIMIT ?').all(projectId, limit)
      : this.db.prepare('SELECT doc FROM runs ORDER BY created_at DESC LIMIT ?').all(limit)).map(parse);
  }
  activeRunCount() { return Number(this.db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued') OR json_extract(doc,'$.executionActive')=1").get().n); }
  updateRun(runId, changes) {
    const previous = this.getRun(runId);
    if (!previous) throw new ProjectError('Run not found', 'not_found', 404);
    const doc = { ...previous, ...clone(changes), runId, projectId: previous.projectId, updatedAt: Date.now() };
    this.db.prepare('UPDATE runs SET status=?,updated_at=?,doc=? WHERE id=?').run(doc.status, doc.updatedAt, JSON.stringify(doc), runId);
    return doc;
  }
  saveStep(runId, step) {
    this.db.prepare('INSERT INTO steps VALUES(?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET ordinal=excluded.ordinal,doc=excluded.doc')
      .run(runId, step.stepId, step.ordinal || 0, JSON.stringify(step));
  }
  getSteps(runId) { return this.db.prepare('SELECT doc FROM steps WHERE run_id=? ORDER BY ordinal').all(runId).map(parse); }
  appendEvent(runId, event) {
    const previous=this.db.prepare('SELECT seq,doc FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(runId);
    const run=this.getRun(runId);
    const doc = { ...clone(event), runId, createdAt: Date.now(), eventId: id('evt_'),
      parentId: previous ? (JSON.parse(previous.doc).eventId || runId+':'+previous.seq) : null,
      projectId:run.projectId, actor:event.roleId||(['run_started','run_approved','rework_started','criteria_recorded'].includes(event.eventType)?'human':'system'), sourceSha:require('./product-events').sourceSha,
      evidence:run.projectSnapshot?.planning?.workflowSchema ? 'E3_LOCAL_ADAPTER_UNVERIFIED' : 'MODEL_ADAPTER_UNVERIFIED' };
    const result = this.db.prepare('INSERT INTO events(run_id,created_at,doc) VALUES(?,?,?)').run(runId, doc.createdAt, JSON.stringify(doc));
    return { ...doc, seq: Number(result.lastInsertRowid) };
  }
  getEvents(runId, { after = 0, limit = 1000 } = {}) {
    return this.db.prepare('SELECT seq,doc FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(runId, Number(after) || 0, Math.max(1, Math.min(5000, Number(limit) || 1000))).map(row => ({ ...parse(row), seq: Number(row.seq) }));
  }
  putMessage(runId, message) {
    const doc = { ...clone(message), messageId: message.messageId || id('msg_'), runId, createdAt: message.createdAt || Date.now() };
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(doc.messageId, runId, doc.createdAt, JSON.stringify(doc));
    return doc;
  }
  getMessages(runId) { return this.db.prepare('SELECT doc FROM messages WHERE run_id=? ORDER BY created_at,rowid').all(runId).map(parse); }
  putArtifact(runId, { buffer, text, mime = 'text/plain; charset=utf-8', filename = 'result.txt', kind = 'text', producer = null, ...extra }) {
    const bytes = buffer === undefined ? Buffer.from(String(text || ''), 'utf8') : Buffer.from(buffer);
    if (bytes.length > 16 * 1024 * 1024) throw new ProjectError('Artifact exceeds 16 MiB', 'artifact_limit');
    const runBytes = Number(this.db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM artifacts WHERE run_id=?').get(runId).n);
    if (runBytes + bytes.length > 64 * 1024 * 1024) throw new ProjectError('Run artifact storage exceeds 64 MiB', 'artifact_limit');
    const artifactId = id('art_'), createdAt = Date.now();
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const metadata = { ...clone(extra), artifactId, runId, createdAt, mime, filename: path.basename(String(filename)).slice(0, 160), kind, producer, bytes: bytes.length, sha256 };
    this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)').run(artifactId, runId, createdAt, mime, sha256, JSON.stringify(metadata), bytes);
    return metadata;
  }
  listArtifacts(runId) { return this.db.prepare('SELECT metadata FROM artifacts WHERE run_id=? ORDER BY created_at,rowid').all(runId).map(r => JSON.parse(r.metadata)); }
  getArtifact(runId, artifactId) {
    const row = this.db.prepare('SELECT metadata,content FROM artifacts WHERE id=? AND run_id=?').get(String(artifactId), String(runId));
    return row ? { ...JSON.parse(row.metadata), buffer: Buffer.from(row.content) } : null;
  }
  recordUsage(runId, usage) {
    const doc = { ...clone(usage), ledgerId: id('use_'), runId, createdAt: Date.now() };
    this.db.prepare('INSERT INTO usage_ledger VALUES(?,?,?,?)').run(doc.ledgerId, runId, doc.createdAt, JSON.stringify(doc));
    return doc;
  }
  /* ---------------- B8 users (front-end accounts) ---------------- */
  createUser({ username, password, monthlyCapFen }) {
    const userId = id('usr_'), now = Date.now();
    try {
      this.db.prepare('INSERT INTO users(id,username,enabled,monthly_cap_fen,created_at,updated_at,password) VALUES(?,?,1,?,?,?,?)')
        .run(userId, username, monthlyCapFen, now, now, JSON.stringify(password));
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new ProjectError('这个用户名已经有人用了', 'username_taken', 409);
      throw e;
    }
    return this.getUser(userId);
  }
  _userView(row) {
    if (!row) return null;
    const pw = JSON.parse(row.password);
    return { userId: row.id, username: row.username, enabled: row.enabled === 1, monthlyCapFen: Number(row.monthly_cap_fen), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), passwordChangedAt: pw.changedAt || null };
  }
  getUser(userId) { return this._userView(this.db.prepare('SELECT * FROM users WHERE id=?').get(String(userId))); }
  /* Internal only: includes the scrypt record. Never send this to a client. */
  getUserCredentials(username) {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(String(username));
    return row ? { ...this._userView(row), password: JSON.parse(row.password) } : null;
  }
  listUsers() { return this.db.prepare('SELECT * FROM users ORDER BY created_at,rowid').all().map(r => this._userView(r)); }
  updateUser(userId, { enabled, monthlyCapFen, password } = {}) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(String(userId));
      if (!row) throw new ProjectError('使用者不存在', 'not_found', 404);
      const next = { enabled: enabled === undefined ? row.enabled : (enabled ? 1 : 0), cap: monthlyCapFen === undefined ? row.monthly_cap_fen : monthlyCapFen, password: password === undefined ? row.password : JSON.stringify(password) };
      this.db.prepare('UPDATE users SET enabled=?,monthly_cap_fen=?,password=?,updated_at=? WHERE id=?').run(next.enabled, next.cap, next.password, Date.now(), row.id);
      return this.getUser(row.id);
    });
  }
  /* Conservative spend of one owner's runs created since `since` (USD, as the engine records it).
   * Finished runs count their recorded cost (incl. restart_unknown reservations). A run that may still
   * spend counts its whole authorized ceiling for the current round, never less than what is recorded. */
  ownerSpend(ownerId, since) {
    const rows = this.db.prepare('SELECT r.doc FROM runs r JOIN projects p ON p.id=r.project_id WHERE p.owner_id=? AND r.created_at>=?').all(String(ownerId), Number(since) || 0);
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    let settledUsd = 0, committedUsd = 0, activeRuns = 0;
    for (const row of rows) {
      const run = parse(row), u = run.usage || {};
      const recorded = num(u.cost) + num(u.reservedCost);
      const active = ['running', 'queued'].includes(run.status) || run.executionActive === true;
      settledUsd += num(u.cost);
      committedUsd += active ? Math.max(recorded, num(u.roundStartCost) + num(run.approval?.maxCost)) : recorded;
      if (active) activeRuns++;
    }
    return { settledUsd, committedUsd, activeRuns, runs: rows.length };
  }
  countRuns(projectId) { return Number(this.db.prepare('SELECT count(*) n FROM runs WHERE project_id=?').get(String(projectId)).n); }
  getUsage(runId) { return this.db.prepare('SELECT doc FROM usage_ledger WHERE run_id=? ORDER BY created_at,rowid').all(runId).map(parse); }
  getSetting(key, fallback = null) { return parse(this.db.prepare('SELECT doc FROM settings WHERE key=?').get(key)) || fallback; }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET doc=excluded.doc').run(key, JSON.stringify(value)); }
  putProjectFile(projectId, { buffer, filename, mime, kind, extraction }) {
    return this.transaction(() => {
      if (!this.getProject(projectId)) throw new ProjectError('Project not found', 'not_found', 404);
      const stats = this.db.prepare('SELECT count(*) n, COALESCE(SUM(length(content)),0) bytes FROM project_files WHERE project_id=?').get(projectId);
      if (Number(stats.n) >= FILE_LIMITS.maxFilesPerProject) throw new ProjectError(`每个项目最多 ${FILE_LIMITS.maxFilesPerProject} 个资料文件`, 'file_limit', 413);
      if (Number(stats.bytes) + buffer.length > FILE_LIMITS.maxProjectBytes) throw new ProjectError('项目资料总大小超过 64 MB', 'file_limit', 413);
      const fileId = id('fil_'), createdAt = Date.now();
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const text = String(extraction.text || '');
      const metadata = { fileId, projectId, filename: path.basename(String(filename)).slice(0, 160), mime, kind, bytes: buffer.length, sha256, createdAt,
        extraction: { status: extraction.status, extractor: extraction.extractor || null, chars: text.length, note: extraction.note || '', meta: clone(extraction.meta || {}) } };
      this.db.prepare('INSERT INTO project_files VALUES(?,?,?,?,?,?,?)').run(fileId, projectId, createdAt, sha256, JSON.stringify(metadata), buffer, text);
      return metadata;
    });
  }
  listProjectFiles(projectId) { return this.db.prepare('SELECT metadata FROM project_files WHERE project_id=? ORDER BY created_at,rowid').all(String(projectId)).map(r => JSON.parse(r.metadata)); }
  getProjectFile(projectId, fileId, { content = false, text = false } = {}) {
    const cols = ['metadata', ...(content ? ['content'] : []), ...(text ? ['text'] : [])].join(',');
    const row = this.db.prepare(`SELECT ${cols} FROM project_files WHERE id=? AND project_id=?`).get(String(fileId), String(projectId));
    if (!row) return null;
    return { ...JSON.parse(row.metadata), ...(content ? { buffer: Buffer.from(row.content) } : {}), ...(text ? { text: row.text } : {}) };
  }
  deleteProjectFile(projectId, fileId) {
    if (this.db.prepare("SELECT id FROM runs WHERE project_id=? AND (status IN ('running','queued') OR json_extract(doc,'$.executionActive')=1)").get(String(projectId))) throw new ProjectError('项目正在运行，结束后再删除资料', 'run_active', 409);
    return this.db.prepare('DELETE FROM project_files WHERE id=? AND project_id=?').run(String(fileId), String(projectId)).changes > 0;
  }
  /* Model calls outside project runs (e.g. connection tests). Unknown cost stays null, never 0. */
  recordSystemUsage(usage) {
    const doc = { ...clone(usage), ledgerId: id('sys_'), createdAt: Date.now() };
    this.db.prepare('INSERT INTO system_usage VALUES(?,?,?)').run(doc.ledgerId, doc.createdAt, JSON.stringify(doc));
    return doc;
  }
  getModelRequest(ownerId, kind, requestId) {
    // Wildcard tombstones take precedence over an exact owner match.
    return requestRecord(this.db.prepare('SELECT * FROM model_requests WHERE kind=? AND request_id=? AND owner_id IN (?,?) ORDER BY CASE WHEN owner_id=? THEN 0 ELSE 1 END LIMIT 1')
      .get(kind, requestId, ownerId, LEGACY_OWNER, LEGACY_OWNER));
  }
  rejectModelRequestDuplicate(previous, paramsHash) {
    const changed = previous.ownerId === LEGACY_OWNER || previous.paramsHash !== paramsHash;
    const error = new ProjectError(changed ? 'Request ID is already bound to different or historical parameters; no model request was sent' : 'This request ID was already submitted; no duplicate model request was sent',
      changed ? 'idempotency_key_reused' : 'duplicate_request', 409);
    error.requestState = previous.state; error.ledgerId = previous.ledgerId;
    throw error;
  }
  claimModelRequest({ ownerId, kind = 'intake_draft', requestId, paramsHash, usage }) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId === LEGACY_OWNER || typeof requestId !== 'string' || !requestId ||
      typeof paramsHash !== 'string' || !/^[a-f0-9]{64}$/.test(paramsHash) || kind !== 'intake_draft') throw new ProjectError('Invalid model request identity', 'invalid_request_identity');
    return this.transaction(() => {
      const previous = this.getModelRequest(ownerId, kind, requestId);
      if (previous) this.rejectModelRequestDuplicate(previous, paramsHash);
      // Keep this public call inside the transaction: injected failures and a
      // failing request INSERT must roll back the reservation together.
      const doc = this.recordSystemUsage({ ...clone(usage), kind, ownerId, requestId, status: 'reserved' });
      this.db.prepare('INSERT INTO model_requests(owner_id,kind,request_id,params_hash,state,ledger_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(ownerId, kind, requestId, paramsHash, 'claimed', doc.ledgerId, doc.createdAt, doc.createdAt);
      return doc;
    });
  }
  markModelRequestDispatching(ledgerId) {
    return this.transaction(() => {
      const usage = parse(this.db.prepare('SELECT doc FROM system_usage WHERE id=?').get(ledgerId));
      if (!usage || usage.status !== 'reserved') throw new ProjectError('Model reservation is unavailable', 'usage_settled', 409);
      const now = Date.now();
      const result = this.db.prepare("UPDATE model_requests SET state='dispatching',dispatched_at=?,updated_at=? WHERE ledger_id=? AND state='claimed'").run(now, now, ledgerId);
      if (Number(result.changes) !== 1) throw new ProjectError('Model request cannot be dispatched again', 'request_not_claimed', 409);
      return requestRecord(this.db.prepare('SELECT * FROM model_requests WHERE ledger_id=?').get(ledgerId));
    });
  }
  settleSystemUsage(ledgerId, usage) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT doc FROM system_usage WHERE id=?').get(ledgerId);
      if (!row) throw new ProjectError('System usage reservation not found', 'usage_missing', 409);
      const current = JSON.parse(row.doc);
      if (current.kind !== 'intake_draft' || current.status !== 'reserved') throw new ProjectError('System usage was already settled', 'usage_settled', 409);
      const request = this.db.prepare('SELECT * FROM model_requests WHERE ledger_id=?').get(ledgerId);
      if (request && !['claimed', 'dispatching'].includes(request.state)) throw new ProjectError('Model request was already settled', 'usage_settled', 409);
      if (request && ((request.state === 'claimed' && usage.requestSent !== false) || (request.state === 'dispatching' && usage.requestSent !== true))) {
        throw new ProjectError('Dispatch evidence does not match settlement', 'dispatch_state_mismatch', 409);
      }
      const now = Date.now();
      const doc = { ...current, ...clone(usage), kind: current.kind, ownerId: current.ownerId, requestId: current.requestId,
        ledgerId: current.ledgerId, createdAt: current.createdAt, settledAt: now };
      if (request) {
        const state = request.state === 'claimed' ? 'not_dispatched' : doc.ok ? 'completed' : 'failed';
        const changed = this.db.prepare('UPDATE model_requests SET state=?,updated_at=?,settled_at=? WHERE ledger_id=? AND state=?').run(state, now, now, ledgerId, request.state);
        if (Number(changed.changes) !== 1) throw new ProjectError('Model request settlement changed', 'usage_settled', 409);
      }
      this.db.prepare('UPDATE system_usage SET doc=? WHERE id=?').run(JSON.stringify(doc), ledgerId);
      return doc;
    });
  }
  recoverModelRequests() {
    return this.transaction(() => {
      const now = Date.now();
      const requests = this.db.prepare("SELECT r.*,s.doc FROM model_requests r JOIN system_usage s ON s.id=r.ledger_id WHERE r.state IN ('claimed','dispatching')").all();
      for (const request of requests) {
        const knownUnsent = request.state === 'claimed';
        const doc = knownUnsent ? notDispatchedUsage(JSON.parse(request.doc), now) : interruptedUsage(JSON.parse(request.doc), now);
        const changed = this.db.prepare('UPDATE model_requests SET state=?,updated_at=?,settled_at=? WHERE ledger_id=? AND state=?')
          .run(knownUnsent ? 'not_dispatched' : 'interrupted_unknown', now, knownUnsent ? now : null, request.ledger_id, request.state);
        if (Number(changed.changes) !== 1) throw new ProjectError('Model request recovery changed', 'recovery_conflict', 503);
        this.db.prepare('UPDATE system_usage SET doc=? WHERE id=?').run(JSON.stringify(doc), request.ledger_id);
      }
      // Be conservative for unpaired reservations imported after migration (or
      // left by older code): missing dispatch evidence never proves zero cost.
      for (const row of this.db.prepare("SELECT s.id,s.doc FROM system_usage s LEFT JOIN model_requests r ON r.ledger_id=s.id WHERE r.ledger_id IS NULL AND json_extract(s.doc,'$.kind')='intake_draft' AND json_extract(s.doc,'$.status')='reserved'").all()) {
        const doc = interruptedUsage(JSON.parse(row.doc), now, true);
        this.db.prepare('UPDATE system_usage SET doc=? WHERE id=?').run(JSON.stringify(doc), row.id);
        if (typeof doc.requestId === 'string' && doc.requestId) this.db.prepare("INSERT INTO model_requests(owner_id,kind,request_id,params_hash,state,ledger_id,created_at,updated_at) VALUES(?,'intake_draft',?,'legacy-v3-unknown','interrupted_unknown',?,?,?) ON CONFLICT(owner_id,kind,request_id) DO NOTHING")
          .run(LEGACY_OWNER, doc.requestId, row.id, Number(doc.createdAt) || now, now);
      }
      return requests.length;
    });
  }
  listSystemUsageExceptions({ ownerId, limit = 200 } = {}) {
    limit = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = this.db.prepare(`SELECT s.id,s.created_at,s.doc,r.owner_id,r.state FROM system_usage s LEFT JOIN model_requests r ON r.ledger_id=s.id
      WHERE json_extract(s.doc,'$.kind')='intake_draft'
      AND (json_extract(s.doc,'$.cost') IS NULL OR json_extract(s.doc,'$.needsReconciliation')=1 OR json_extract(s.doc,'$.status')='reserved')
      AND (? IS NULL OR r.owner_id=? OR r.owner_id='*' OR (r.owner_id IS NULL AND (json_extract(s.doc,'$.ownerId')=? OR json_extract(s.doc,'$.ownerId') IS NULL)))
      ORDER BY s.created_at DESC,s.rowid DESC LIMIT ?`).all(ownerId ?? null, ownerId ?? null, ownerId ?? null, limit);
    // An explicit allowlist keeps prompts, credentials, provider errors and
    // configuration snapshots out of this administrative exception endpoint.
    return rows.map(row => {
      const doc = JSON.parse(row.doc);
      return { ledgerId: row.id, requestId: typeof doc.requestId === 'string' ? doc.requestId : null,
        connectionId: typeof doc.connectionId === 'string' ? doc.connectionId : null, modelId: typeof doc.modelId === 'string' ? doc.modelId : null,
        createdAt: Number(row.created_at), updatedAt: doc.interruptedAt || doc.settledAt || Number(row.created_at),
        status: doc.status, requestState: row.state || 'legacy_unknown', requestSent: doc.requestSent ?? null,
        cost: doc.cost ?? null, currency: 'USD', budgetCost: bound(doc.budgetCost, doc.reservedCost),
        costUpperBound: bound(doc.costUpperBound, doc.reservedCost), tokenUpperBound: bound(doc.tokenUpperBound, doc.reservedTokens),
        reservedCost: bound(doc.reservedCost), reservedTokens: bound(doc.reservedTokens),
        needsReconciliation: doc.needsReconciliation === true || doc.cost === null || row.state === 'dispatching',
        note: '保守预留/用户价表估算不等于厂商账单；本接口只读，不触发模型或修改费用。' };
    });
  }
  listSystemUsage({ limit = 200 } = {}) { return this.db.prepare('SELECT doc FROM system_usage ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.max(1, Math.min(1000, Number(limit) || 200))).map(parse); }
  async backup(target) {
    // Private 0700 staging, 0600 + quick_check, atomic no-overwrite link (lib/private-backup.js).
    try {
      const out = await publishPrivateBackup(target, staged => sqliteBackup(this.db, staged), { forbidden: [this.filename, this.filename + '-wal', this.filename + '-shm'] });
      return { ...out, schemaVersion: this.schemaVersion };
    } catch (e) { throw e instanceof BackupError ? new ProjectError(e.message, e.code, e.status) : e; }
  }
  close() {
    if (!this.releaseLock) return;
    this.db.close();
    this.releaseLock(); this.releaseLock = null;
  }
}
module.exports = { ProjectStore, ProjectError, SCHEMA_VERSION, FILE_LIMITS };
