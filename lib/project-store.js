'use strict';
/* V2 durable execution store. Legacy model/team/auth JSON stores remain independent.
 * Schema migrations are forward-only; rollback means restoring a verified SQLite backup.
 * No running work is replayed after restart, including tool calls and paid model calls.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');

const SCHEMA_VERSION = 1;
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
    this.schemaVersion = SCHEMA_VERSION;
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
    const doc = { ...clone(event), runId, createdAt: Date.now() };
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
  getUsage(runId) { return this.db.prepare('SELECT doc FROM usage_ledger WHERE run_id=? ORDER BY created_at,rowid').all(runId).map(parse); }
  getSetting(key, fallback = null) { return parse(this.db.prepare('SELECT doc FROM settings WHERE key=?').get(key)) || fallback; }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET doc=excluded.doc').run(key, JSON.stringify(value)); }
  async backup(target) {
    target = path.resolve(target);
    if (target === this.filename || fs.existsSync(target)) throw new ProjectError('Backup target must be a new file', 'backup_exists', 409);
    await sqliteBackup(this.db, target);
    fs.chmodSync(target, 0o600);
    return { filename: target, schemaVersion: this.schemaVersion };
  }
  close() {
    if (!this.releaseLock) return;
    this.db.close();
    this.releaseLock(); this.releaseLock = null;
  }
}
module.exports = { ProjectStore, ProjectError, SCHEMA_VERSION };
