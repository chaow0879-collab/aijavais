'use strict';
// AUD-68-SEC-01: actual temporary SQLite backups, permissive old DATA/umask,
// fault injection and SIGKILL. No provider API, business DATA or production code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { ProjectStore, SCHEMA_VERSION } = require('../lib/project-store');
const CHILD = path.join(__dirname, 'fixtures', 'migration-backup-child.cjs');
function mode(filename) { return fs.lstatSync(filename).mode & 0o777; }
function snapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    return { version: Number(db.prepare('PRAGMA user_version').get().user_version),
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      usage: db.prepare('SELECT * FROM system_usage ORDER BY id').all(),
      settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
      migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      tables: db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() };
  } finally { db.close(); }
}
function fixture(t, { migrationFailure = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-backup-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProjectStore({ dir });
  store.createProject({ name: 'Private project retained', description: 'Sensitive project text must never enter a public backup window.' });
  store.setSetting('private-setting', { text: 'Preserve exact settings' });
  store.recordSystemUsage({ kind: 'intake_draft', requestId: 'old-request', status: 'reserved', modelId: 'MOCK-only',
    cost: null, tokens: null, reservedCost: 0.25, reservedTokens: 2000 });
  const oldBackups = store.migrationBackups || [];
  store.close();
  for (const file of oldBackups) fs.unlinkSync(file);
  const filename = path.join(dir, 'projects.sqlite'), db = new DatabaseSync(filename);
  db.exec('DROP TABLE users; DROP INDEX projects_owner; DROP INDEX runs_created; DROP TABLE model_requests; DROP INDEX system_usage_status; DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3;'); // B8: a true v3 shape (no v4/v5 objects)
  if (migrationFailure) db.exec("CREATE TRIGGER deny_v4 BEFORE INSERT ON schema_migrations WHEN NEW.version=4 BEGIN SELECT RAISE(ABORT,'MOCK migration failure'); END;");
  db.close();
  fs.chmodSync(dir, 0o755);
  return { dir, filename, before: snapshot(filename) };
}
function childEnvironment() {
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID']) delete env[key];
  return env;
}
function run(modeName, dir) {
  const result = spawnSync(process.execPath, ['--no-warnings', CHILD, modeName, dir], { env: childEnvironment(), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function protectedCreation(events) {
  const before = events.find(e => e.phase === 'before_vacuum');
  const created = events.find(e => e.phase === 'after_vacuum_before_chmod');
  assert.ok(before, 'actual VACUUM execution was observed');
  assert.equal(before.directoryMode, 0o700, 'directory is private before the first SQLite byte');
  assert.equal(before.exists, false, 'SQLite has not created the target at the pre-write boundary');
  assert.equal(path.basename(before.parent).startsWith('.migration-backup-'), true);
  assert.ok(created); assert.equal(created.directoryMode, 0o700);
  assert.equal(created.exists, true);
  // SQLite may initially use0644 underumask022. It is protected by the0700
  // ancestor throughout creation, rather than trusting any final chmod.
  assert.equal(created.target, before.target);
  return created;
}
function privateCopies(dir) {
  return fs.readdirSync(dir).filter(n => n.startsWith('.migration-backup-'))
    .map(n => ({ directory: path.join(dir, n), file: path.join(dir, n, 'backup.sqlite') }));
}
function published(dir) { return fs.readdirSync(dir).filter(n => n.includes('.pre-v4-')).map(n => path.join(dir, n)); }
function assertV3Preserved(f) { assert.deepEqual(snapshot(f.filename), f.before); }
function assertPrivateCopy(f) {
  const copies = privateCopies(f.dir); assert.equal(copies.length, 1);
  assert.equal(mode(copies[0].directory), 0o700);
  assert.deepEqual(snapshot(copies[0].file), f.before, 'original v3 contents survive in the protected backup');
  return copies[0];
}

test('backup security: existing DATA0755 and umask022 remain protected from VACUUM creation through atomic publication', t => {
  const f = fixture(t), result = run('success', f.dir);
  assert.equal(result.ok, true); assert.equal(result.schemaVersion, SCHEMA_VERSION); assert.equal(mode(f.dir), 0o755);
  const created = protectedCreation(result.events);
  t.diagnostic('Observed real VACUUM pre-chmod file mode=' + created.mode.toString(8).padStart(4, '0') + '; enclosing directory=0700; existing DATA=0755; child umask=0022.');
  const publish = result.events.find(e => e.phase === 'before_publish'); assert.equal(publish.mode, 0o600); assert.equal(publish.directoryMode, 0o700);
  const final = result.events.find(e => e.phase === 'published'); assert.equal(final.mode, 0o600);
  assert.equal(result.migrationBackups.length, 2, 'B8: v3 -> v4 -> v5, one protected copy before each step');
  assert.equal(path.dirname(result.migrationBackups[0]), f.dir); assert.equal(mode(result.migrationBackups[0]), 0o600);
  assert.deepEqual(snapshot(result.migrationBackups[0]), f.before);
  assert.deepEqual(privateCopies(f.dir), [], 'only successfully published copies are cleaned up');
  const db = new DatabaseSync(f.filename, { readOnly: true }); t.after(() => db.close());
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  const row = JSON.parse(db.prepare('SELECT doc FROM system_usage').get().doc);
  assert.equal(row.cost, null); assert.equal(row.status, 'interrupted_unknown'); assert.equal(row.reservedCost, 0.25);
});

for (const window of ['before-chmod', 'before-publish']) test('backup security: SIGKILL ' + window + ' retains private complete backup and unmodifiedv3', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--no-warnings', CHILD, 'crash-' + window, f.dir], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('backup crash fixture timeout: ' + stderr)), 10000); timer.unref();
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('backup fixture exited before pause: ' + code + ' ' + stderr)); });
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); } }
    });
  });
  protectedCreation(ready.events);
  assert.equal(mode(ready.target), window === 'before-publish' ? 0o600 : ready.events.find(e => e.phase === 'after_vacuum_before_chmod').mode);
  assert.equal(mode(path.dirname(ready.target)), 0o700);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exit; assert.equal(signal, 'SIGKILL');
  assertV3Preserved(f); assertPrivateCopy(f); assert.deepEqual(published(f.dir), []);
  // A later clean startup can recover the dead-PID lock, while never deleting
  // the private evidence left by the interrupted backup.
  const restarted = new ProjectStore({ dir: f.dir }); restarted.close();
  assert.equal(mode(path.dirname(ready.target)), 0o700);
  assert.deepEqual(snapshot(ready.target), f.before);
});

test('backup security: chmod failure leaves full backup behind0700 and aborts migration without source damage', t => {
  const f = fixture(t), result = run('chmod-failure', f.dir);
  assert.equal(result.ok, false); assert.equal(result.code, 'EPERM'); protectedCreation(result.events);
  assertV3Preserved(f); assertPrivateCopy(f); assert.deepEqual(published(f.dir), []);
  assert.equal(fs.existsSync(f.filename + '.lock'), false);
});

test('backup security: publication failure retains private0600 backup and unchangedv3', t => {
  const f = fixture(t), result = run('link-failure', f.dir);
  assert.equal(result.ok, false); assert.equal(result.code, 'EXDEV'); protectedCreation(result.events);
  assert.equal(result.events.find(e => e.phase === 'before_publish').mode, 0o600);
  assertV3Preserved(f); const copy = assertPrivateCopy(f); assert.equal(mode(copy.file), 0o600);
  assert.deepEqual(published(f.dir), []); assert.equal(fs.existsSync(f.filename + '.lock'), false);
});

test('backup security: ineffective chmod cannot publish a0644 file even when chmod reports success', t => {
  const f = fixture(t), result = run('chmod-noop', f.dir);
  assert.equal(result.ok, false); assert.equal(result.code, 'backup_permissions'); protectedCreation(result.events);
  assertV3Preserved(f); const copy = assertPrivateCopy(f); assert.equal(mode(copy.file), 0o644);
  assert.deepEqual(published(f.dir), [], 'unverified file is never published outside its private ancestor');
});

test('backup security: cleanup failure after publication preserves both protected links and leavesv3 unchanged', t => {
  const f = fixture(t), result = run('unlink-failure', f.dir);
  assert.equal(result.ok, false); assert.equal(result.code, 'EPERM'); protectedCreation(result.events);
  assertV3Preserved(f); const copy = assertPrivateCopy(f); const copies = published(f.dir);
  assert.equal(copies.length, 1); assert.equal(mode(copies[0]), 0o600); assert.equal(mode(copy.file), 0o600);
  assert.equal(fs.lstatSync(copies[0]).ino, fs.lstatSync(copy.file).ino);
  assert.deepEqual(snapshot(copies[0]), f.before); assert.equal(fs.existsSync(f.filename + '.lock'), false);
});

test('backup security: existing formal backup is never overwritten when publishing another consistent copy', t => {
  const f = fixture(t), existing = f.filename + '.pre-v4-1730000000000.bak';
  fs.writeFileSync(existing, 'existing backup sentinel', { mode: 0o600 });
  const result = run('collision', f.dir);
  assert.equal(result.ok, false); assert.equal(result.code, 'EEXIST');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing backup sentinel'); assert.equal(mode(existing), 0o600);
  assertV3Preserved(f); assertPrivateCopy(f);
});

test('backup security: SQL migration failure rolls v3 back and preserves the already published0600 consistent backup', t => {
  const f = fixture(t, { migrationFailure: true }), result = run('success', f.dir);
  assert.equal(result.ok, false); assert.match(result.message, /MOCK migration failure/); protectedCreation(result.events);
  assertV3Preserved(f); const copies = published(f.dir); assert.equal(copies.length, 1);
  assert.equal(mode(copies[0]), 0o600); assert.deepEqual(snapshot(copies[0]), f.before);
  assert.deepEqual(privateCopies(f.dir), []); assert.equal(fs.existsSync(f.filename + '.lock'), false);
});

test('backup security: insecure staging directory fails closed before VACUUM can create sensitive bytes', t => {
  const f = fixture(t), result = run('unsafe-private-directory', f.dir);
  assert.equal(result.ok, false); assert.deepEqual(result.events, [], 'no SQLite backup operation occurs');
  assertV3Preserved(f); assert.deepEqual(published(f.dir), []);
  for (const copy of privateCopies(f.dir)) assert.equal(fs.existsSync(copy.file), false, 'insecure directory contains no copied data');
  assert.equal(fs.existsSync(f.filename + '.lock'), false);
});
