'use strict';
// Actual temporary SQLite transactions and killed/restarted child processes.
// Model dispatch is a local MOCK counter; no provider API or paid call is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { ProjectStore, SCHEMA_VERSION } = require('../lib/project-store');
const CHILD = path.join(__dirname, 'fixtures', 'model-request-child.cjs');
const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-request-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const dir = directory(t), store = new ProjectStore({ dir });
  t.after(() => store.close());
  return { dir, store };
}
function claim(store, requestId = 'id-1', ownerId = 'owner-a', extra = {}) {
  return store.claimModelRequest({ ownerId, requestId, kind: 'intake_draft', paramsHash: HASH,
    usage: { kind: 'intake_draft', requestId, connectionId: 'mock-model', modelId: 'MOCK-model', tokens: null, cost: null,
      currency: 'USD', reservedTokens: 1800, reservedCost: 0.25, tokenUpperBound: 1800, costUpperBound: 0.25, approvePaid: true }, ...extra });
}
function usage(store, ledgerId) { return JSON.parse(store.db.prepare('SELECT doc FROM system_usage WHERE id=?').get(ledgerId).doc); }
function count(store, table) { return Number(store.db.prepare('SELECT count(*) n FROM ' + table).get().n); }
function settled(requestSent = true, ok = true) {
  return { status: requestSent ? ok ? 'completed' : 'failed' : 'not_dispatched', ok, requestSent,
    tokens: requestSent ? 30 : 0, cost: requestSent ? 0.01 : 0, reservedTokens: 0, reservedCost: 0, currency: 'USD' };
}
function v3(t, rows = []) {
  const dir = directory(t), store = new ProjectStore({ dir });
  const p = store.createProject({ name: 'Keep project', description: 'Migration must preserve this data.' });
  for (const row of rows) store.recordSystemUsage(row);
  store.close();
  const db = new DatabaseSync(path.join(dir, 'projects.sqlite'));
  db.exec('DROP TABLE model_requests; DROP INDEX system_usage_status; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3;');
  db.close();
  return { dir, projectId: p.projectId };
}
function legacy(requestId, status = 'reserved', extra = {}) {
  return { kind: 'intake_draft', ...(requestId ? { requestId } : {}), status, connectionId: 'legacy-connection', modelId: 'MOCK-legacy',
    tokens: status === 'reserved' ? null : 30, cost: status === 'reserved' ? null : 0.01,
    reservedTokens: 1000, reservedCost: 0.5, maxTokens: 32000, maxOutputTokens: 2048, currency: 'USD', ...extra };
}
function childSync(mode, dir, requestId = 'id-1') {
  const result = spawnSync(process.execPath, ['--no-warnings', CHILD, mode, dir, requestId], { env: childEnvironment(), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function childEnvironment() {
  const env = { ...process.env };
  // These are ordinary application fixtures, not nested node:test workers.
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID']) delete env[key];
  return env;
}

test('request ledger: atomic unique claims bind owner, parameters and one system reservation', t => {
  const { store } = fixture(t);
  const first = claim(store);
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').state, 'claimed');
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').ledgerId, first.ledgerId);
  assert.throws(() => claim(store), e => e.code === 'duplicate_request' && e.status === 409 && e.ledgerId === first.ledgerId);
  assert.throws(() => claim(store, 'id-1', 'owner-a', { paramsHash: OTHER_HASH }), e => e.code === 'idempotency_key_reused');
  const otherOwner = claim(store, 'id-1', 'owner-b');
  assert.notEqual(otherOwner.ledgerId, first.ledgerId);
  assert.equal(count(store, 'system_usage'), 2);
  assert.equal(count(store, 'model_requests'), 2);
  assert.throws(() => claim(store, 'reserved-owner', '*'), e => e.code === 'invalid_request_identity');
});

test('request ledger: failure inserting request rolls reservation back in the same SQLite transaction', t => {
  const { store } = fixture(t);
  store.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON model_requests BEGIN SELECT RAISE(ABORT,'MOCK request write failed'); END;");
  assert.throws(() => claim(store), /MOCK request write failed/);
  assert.equal(count(store, 'system_usage'), 0, 'reservation must not survive a failed claim');
  assert.equal(count(store, 'model_requests'), 0);
  store.db.exec('DROP TRIGGER fail_claim;');
  const first = claim(store);
  assert.ok(first.ledgerId, 'transaction rollback does not permanently occupy a never-dispatched key');
});

test('request ledger: pre-reservation disk failure inserts neither request nor ledger', t => {
  const { store } = fixture(t);
  store.db.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON system_usage BEGIN SELECT RAISE(ABORT,'MOCK reservation failed'); END;");
  assert.throws(() => claim(store), /MOCK reservation failed/);
  assert.equal(count(store, 'system_usage'), 0);
  assert.equal(count(store, 'model_requests'), 0);
});

test('request ledger: dispatch marker is conditional; settlement evidence cannot invent an unsent request', t => {
  const { store } = fixture(t), row = claim(store);
  assert.throws(() => store.settleSystemUsage(row.ledgerId, settled(true)), e => e.code === 'dispatch_state_mismatch');
  const marked = store.markModelRequestDispatching(row.ledgerId);
  assert.equal(marked.state, 'dispatching'); assert.ok(marked.dispatchedAt);
  assert.throws(() => store.markModelRequestDispatching(row.ledgerId), e => e.code === 'request_not_claimed');
  assert.throws(() => store.settleSystemUsage(row.ledgerId, settled(false)), e => e.code === 'dispatch_state_mismatch');
  assert.equal(usage(store, row.ledgerId).status, 'reserved');
  store.settleSystemUsage(row.ledgerId, settled(true));
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').state, 'completed');
  assert.throws(() => store.settleSystemUsage(row.ledgerId, settled(true)), e => e.code === 'usage_settled');
  assert.throws(() => claim(store), e => e.code === 'duplicate_request');
  assert.equal(count(store, 'system_usage'), 1);
});

test('request ledger: failed settlement rolls back both state and bill, then restart preserves unknown expense', t => {
  const dir = directory(t); let store = new ProjectStore({ dir });
  t.after(() => store.close());
  const row = claim(store); store.markModelRequestDispatching(row.ledgerId);
  store.db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON system_usage BEGIN SELECT RAISE(ABORT,'MOCK settlement failed'); END;");
  assert.throws(() => store.settleSystemUsage(row.ledgerId, settled(true)), /MOCK settlement failed/);
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').state, 'dispatching');
  assert.equal(usage(store, row.ledgerId).status, 'reserved');
  assert.equal(usage(store, row.ledgerId).reservedCost, 0.25);
  assert.equal(store.listSystemUsageExceptions({ ownerId: 'owner-a' })[0].requestState, 'dispatching');
  store.db.exec('DROP TRIGGER fail_settlement;'); store.close(); store = new ProjectStore({ dir });
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').state, 'interrupted_unknown');
  assert.equal(usage(store, row.ledgerId).cost, null);
  assert.equal(usage(store, row.ledgerId).reservedCost, 0.25);
  assert.throws(() => claim(store), e => e.code === 'duplicate_request');
  assert.equal(count(store, 'system_usage'), 1);
});

test('request ledger: every terminal state retains its key across reopening and 1001 later requests', t => {
  const dir = directory(t); let store = new ProjectStore({ dir }); t.after(() => store.close());
  const earliest = claim(store, 'earliest'); store.markModelRequestDispatching(earliest.ledgerId); store.settleSystemUsage(earliest.ledgerId, settled());
  const failed = claim(store, 'failed'); store.markModelRequestDispatching(failed.ledgerId); store.settleSystemUsage(failed.ledgerId, settled(true, false));
  const unsent = claim(store, 'unsent'); store.settleSystemUsage(unsent.ledgerId, settled(false, false));
  for (let n = 0; n < 1001; n++) { const row = claim(store, 'history-' + n); store.settleSystemUsage(row.ledgerId, settled(false, false)); }
  store.close(); store = new ProjectStore({ dir });
  for (const requestId of ['earliest', 'failed', 'unsent']) assert.throws(() => claim(store, requestId), e => e.code === 'duplicate_request');
  assert.equal(count(store, 'model_requests'), 1004);
  assert.equal(count(store, 'system_usage'), 1004);
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'earliest').state, 'completed');
});

test('request ledger: a separate process cannot open live DATA or bypass SQLite uniqueness with another writer', t => {
  const { store, dir } = fixture(t); const row = claim(store);
  const opened = childSync('try-open', dir); assert.deepEqual(opened, { opened: false, code: 'data_locked' });
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').state, 'claimed', 'live request was not spuriously recovered');
  const duplicate = childSync('sql-duplicate', dir);
  assert.equal(duplicate.inserted, false); assert.match(duplicate.message, /UNIQUE constraint failed: model_requests/);
  assert.equal(count(store, 'system_usage'), 1, 'failed writer must roll back its own reservation');
  assert.equal(store.getModelRequest('owner-a', 'intake_draft', 'id-1').ledgerId, row.ledgerId);
});

for (const mode of ['claimed', 'dispatching', 'called']) test('request crash: SIGKILL ' + mode + ' recovers conservatively and never replays MOCK dispatch', async t => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['--no-warnings', CHILD, mode, dir, 'crash-request', HASH], { env: childEnvironment(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = await Promise.race([
    once(child, 'message').then(([msg]) => msg),
    once(child, 'exit').then(([code]) => { throw new Error('crash fixture exited early ' + code + ': ' + stderr); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('crash fixture timed out: ' + stderr)), 10000); timer.unref(); }),
  ]);
  assert.equal(ready.ready, true);
  const countFile = path.join(dir, 'mock-dispatch-count.txt');
  const dispatches = () => fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').trim().split('\n').length : 0;
  assert.equal(dispatches(), mode === 'called' ? 1 : 0, 'actual test Mock invocation count before SIGKILL');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
  let store = new ProjectStore({ dir });
  try {
    const request = store.getModelRequest('crash-owner', 'intake_draft', 'crash-request');
    assert.equal(request.state, mode === 'claimed' ? 'not_dispatched' : 'interrupted_unknown');
    const bill = usage(store, ready.ledgerId);
    assert.equal(bill.cost, mode === 'claimed' ? 0 : null);
    assert.equal(bill.costUpperBound, 0.25); assert.equal(bill.tokenUpperBound, 1800);
    assert.equal(bill.reservedCost, mode === 'claimed' ? 0 : 0.25);
    assert.equal(bill.reservedTokens, mode === 'claimed' ? 0 : 1800);
    const afterFirst = JSON.stringify({ request, bill });
    assert.throws(() => claim(store, 'crash-request', 'crash-owner'), e => e.code === 'duplicate_request');
    store.close(); store = new ProjectStore({ dir });
    assert.equal(JSON.stringify({ request: store.getModelRequest('crash-owner', 'intake_draft', 'crash-request'), bill: usage(store, ready.ledgerId) }), afterFirst, 'second startup recovery is exactly idempotent');
    assert.throws(() => claim(store, 'crash-request', 'crash-owner'), e => e.code === 'duplicate_request');
    assert.equal(count(store, 'system_usage'), 1); assert.equal(count(store, 'model_requests'), 1);
    assert.equal(dispatches(), mode === 'called' ? 1 : 0, 'restart never runs the Mock model again');
  } finally { store.close(); }
});

test('schema v4: legacy reserved/duplicate/completed/failed IDs and project data survive v3 migration with an exact private backup', t => {
  const rows = [legacy('legacy-reserved'), legacy('legacy-reserved', 'reserved', { cost: 0 }), legacy('legacy-completed', 'completed'),
    legacy('legacy-failed', 'failed'), legacy(null), { kind: 'connection_test', status: 'completed', cost: null, modelId: 'keep-probe' }];
  const { dir, projectId } = v3(t, rows); let store = new ProjectStore({ dir }); t.after(() => store.close());
  assert.equal(store.schemaVersion, 4); assert.equal(SCHEMA_VERSION, 4); assert.equal(store.getProject(projectId).name, 'Keep project');
  assert.equal(store.migrationBackups.length, 1);
  const backupFile = store.migrationBackups[0]; assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  const backup = new DatabaseSync(backupFile, { readOnly: true });
  assert.equal(Number(backup.prepare('PRAGMA user_version').get().user_version), 3);
  assert.equal(Number(backup.prepare('SELECT count(*) n FROM system_usage').get().n), rows.length);
  assert.equal(backup.prepare("SELECT count(*) n FROM system_usage WHERE json_extract(doc,'$.status')='reserved'").get().n, 3);
  backup.close();
  assert.equal(count(store, 'system_usage'), rows.length, 'all duplicate and ownerless ledger rows retained');
  assert.equal(count(store, 'model_requests'), 3, 'one legacy tombstone per identifiable ID; no fabricated ID');
  const recovered = store.listSystemUsage().filter(row => row.kind === 'intake_draft' && !['completed', 'failed'].includes(row.status));
  assert.equal(recovered.length, 3);
  assert.ok(recovered.every(row => row.cost === null && row.needsReconciliation === true && row.costUpperBound === 0.5 && row.reservedCost === 0.5));
  for (const owner of ['owner-a', 'owner-b']) for (const id of ['legacy-reserved', 'legacy-completed', 'legacy-failed']) {
    assert.throws(() => claim(store, id, owner), e => e.code === 'idempotency_key_reused');
  }
  const snapshot = JSON.stringify(store.listSystemUsage()); store.close(); store = new ProjectStore({ dir });
  assert.equal(JSON.stringify(store.listSystemUsage()), snapshot, 'no second recovery edits or extra row creation');
  assert.equal(store.migrationBackups, undefined, 'already-current DB does not migrate again');
});

test('schema v4: migration SQL failure rolls all changes back and preserves the pre-v4 backup', t => {
  const { dir } = v3(t, [legacy('legacy-kept')]);
  const existingBackups = new Set(fs.readdirSync(dir));
  const filename = path.join(dir, 'projects.sqlite'); let db = new DatabaseSync(filename);
  db.exec("CREATE TRIGGER fail_v4 BEFORE INSERT ON schema_migrations WHEN NEW.version=4 BEGIN SELECT RAISE(ABORT,'MOCK migration failed'); END;"); db.close();
  assert.throws(() => new ProjectStore({ dir }), /MOCK migration failed/);
  assert.equal(fs.existsSync(filename + '.lock'), false, 'failed initialization releases only its own lock');
  db = new DatabaseSync(filename);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 3);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='model_requests'").get().n, 0);
  assert.equal(JSON.parse(db.prepare('SELECT doc FROM system_usage').get().doc).status, 'reserved', 'legacy recovery rolled back with the schema');
  const backups = fs.readdirSync(dir).filter(name => name.includes('.pre-v4-') && !existingBackups.has(name));
  assert.equal(backups.length, 1); assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o777, 0o600);
  db.exec('DROP TRIGGER fail_v4;'); db.close();
  const store = new ProjectStore({ dir }); t.after(() => store.close()); assert.equal(store.schemaVersion, 4);
});

test('schema v4: consistent backup failure aborts before schema or legacy fees are modified', t => {
  const { dir } = v3(t, [legacy('legacy-backup-fail')]);
  const filename = path.join(dir, 'projects.sqlite');
  // Precreate the deterministic VACUUM target; SQLite refuses to overwrite it.
  const realNow = Date.now; const timestamp = 1730000000000;
  const blockedTarget = filename + '.pre-v4-' + timestamp + '.bak'; fs.writeFileSync(blockedTarget, 'existing backup sentinel', { mode: 0o600 });
  Date.now = () => timestamp;
  try { assert.throws(() => new ProjectStore({ dir }), /exists|open|file/i); }
  finally { Date.now = realNow; }
  const db = new DatabaseSync(filename); t.after(() => db.close());
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 3);
  assert.equal(JSON.parse(db.prepare('SELECT doc FROM system_usage').get().doc).status, 'reserved');
  assert.equal(fs.readFileSync(blockedTarget, 'utf8'), 'existing backup sentinel');
  assert.equal(fs.existsSync(filename + '.lock'), false);
});

test('schema v4: corrupt and future databases fail closed, preserve evidence and release startup locks', t => {
  const corruptDir = directory(t), corruptFile = path.join(corruptDir, 'projects.sqlite'); fs.writeFileSync(corruptFile, 'MOCK corrupt SQLite evidence');
  assert.throws(() => new ProjectStore({ dir: corruptDir }), /database|file/i);
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), 'MOCK corrupt SQLite evidence'); assert.equal(fs.existsSync(corruptFile + '.lock'), false);
  const dir = directory(t); const initial = new ProjectStore({ dir }); initial.close();
  const filename = path.join(dir, 'projects.sqlite'); let db = new DatabaseSync(filename); db.exec('PRAGMA user_version=99;'); db.close();
  assert.throws(() => new ProjectStore({ dir }), e => e.code === 'schema_newer');
  db = new DatabaseSync(filename); t.after(() => db.close()); assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 99);
  assert.equal(fs.existsSync(filename + '.lock'), false);
});

test('request exceptions: owner isolation, terminal unknown bills and safe explicit fields without raw prompts or credentials', t => {
  const { store } = fixture(t);
  const a = claim(store, 'owner-a-pending');
  const b = claim(store, 'owner-b-pending', 'owner-b'); store.markModelRequestDispatching(b.ledgerId);
  const unknown = claim(store, 'owner-a-unknown'); store.markModelRequestDispatching(unknown.ledgerId);
  store.settleSystemUsage(unknown.ledgerId, { ...settled(), cost: null, prompt: 'PRIVATE PROMPT', apiKey: 'PRIVATE KEY', error: 'PRIVATE PROVIDER ERROR', needsReconciliation: true });
  const ordinary = claim(store, 'owner-a-settled'); store.markModelRequestDispatching(ordinary.ledgerId); store.settleSystemUsage(ordinary.ledgerId, settled());
  const before = store.db.prepare('SELECT doc FROM system_usage ORDER BY id').all().map(row => row.doc);
  const exceptions = store.listSystemUsageExceptions({ ownerId: 'owner-a' });
  assert.deepEqual(new Set(exceptions.map(row => row.ledgerId)), new Set([a.ledgerId, unknown.ledgerId]));
  assert.equal(exceptions.find(row => row.ledgerId === unknown.ledgerId).cost, null);
  assert.equal(exceptions.find(row => row.ledgerId === unknown.ledgerId).requestState, 'completed');
  assert.doesNotMatch(JSON.stringify(exceptions), /PRIVATE|paramsHash|ownerId|prompt|apiKey/);
  assert.deepEqual(store.listSystemUsageExceptions({ ownerId: 'owner-b' }).map(row => row.ledgerId), [b.ledgerId]);
  assert.deepEqual(store.listSystemUsageExceptions({ ownerId: 'nobody' }), []);
  assert.deepEqual(store.db.prepare('SELECT doc FROM system_usage ORDER BY id').all().map(row => row.doc), before, 'exception reads do not change billing');
});
