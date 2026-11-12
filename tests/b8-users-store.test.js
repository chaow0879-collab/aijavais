'use strict';
/* B8 schema v5 users table, v4 -> v5 migration (backup first), user accounts and monthly CNY cap. No network, no paid calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ProjectStore, SCHEMA_VERSION } = require('../lib/project-store');
const { createUsers, monthStart, usdToFen } = require('../lib/users');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-b8-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function v4(t) {
  const dir = tmp(t); const store = new ProjectStore({ dir });
  const p = store.createProject({ name: 'Keep v4 project', description: 'kept' }, { ownerId: 'admin' });
  store.close();
  const db = new DatabaseSync(path.join(dir, 'projects.sqlite'));
  db.exec('DROP TABLE users; DROP INDEX projects_owner; DROP INDEX runs_created; DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4;');
  db.close();
  return { dir, projectId: p.projectId };
}

test('B8 schema v5: a v4 database upgrades with a private pre-v5 backup, keeps data and is not migrated twice', t => {
  assert.equal(SCHEMA_VERSION, 5);
  const { dir, projectId } = v4(t);
  let store = new ProjectStore({ dir });
  assert.equal(store.schemaVersion, 5);
  assert.equal(store.getProject(projectId).name, 'Keep v4 project');
  assert.equal(store.migrationBackups.length, 1);
  assert.match(path.basename(store.migrationBackups[0]), /\.pre-v5-\d+\.bak$/);
  assert.equal(fs.statSync(store.migrationBackups[0]).mode & 0o777, 0o600);
  const backup = new DatabaseSync(store.migrationBackups[0], { readOnly: true });
  assert.equal(Number(backup.prepare('PRAGMA user_version').get().user_version), 4, 'backup is the untouched v4 database');
  assert.equal(backup.prepare("SELECT count(*) n FROM sqlite_master WHERE name='users'").get().n, 0);
  backup.close();
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version), [1, 2, 3, 4, 5]);
  const u = store.createUser({ username: 'alice', password: { salt: '00', hash: '11', changedAt: 1 }, monthlyCapFen: 1000 });
  store.close();
  store = new ProjectStore({ dir }); t.after(() => store.close());
  assert.equal(store.migrationBackups, undefined, 'already v5: no second migration');
  assert.equal(store.getUser(u.userId).username, 'alice');
});

test('B8 schema v5: a failed v5 migration rolls back to v4 and keeps the pre-v5 backup', t => {
  const { dir } = v4(t);
  const filename = path.join(dir, 'projects.sqlite'), existing = new Set(fs.readdirSync(dir));
  let db = new DatabaseSync(filename);
  db.exec("CREATE TRIGGER fail_v5 BEFORE INSERT ON schema_migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'MOCK v5 failed'); END;"); db.close();
  assert.throws(() => new ProjectStore({ dir }), /MOCK v5 failed/);
  db = new DatabaseSync(filename);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 4);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='users'").get().n, 0);
  assert.equal(fs.readdirSync(dir).filter(n => n.includes('.pre-v5-') && !existing.has(n)).length, 1);
  db.exec('DROP TRIGGER fail_v5;'); db.close();
  const store = new ProjectStore({ dir }); t.after(() => store.close()); assert.equal(store.schemaVersion, 5);
});

test('B8 users: scrypt only (no plaintext), unique names, disable, reset password, sessions revoked', async t => {
  const dir = tmp(t), store = new ProjectStore({ dir }); t.after(() => store.close());
  const revoked = [];
  const users = createUsers({ store, onRevoke: (id, why) => revoked.push([id, why]) });
  await assert.rejects(users.create({ username: 'a', password: 'good-password-1', monthlyCapCny: 10 }), e => e.code === 'invalid_username');
  await assert.rejects(users.create({ username: 'alice', password: 'short', monthlyCapCny: 10 }), e => e.code === 'weak_password');
  await assert.rejects(users.create({ username: 'alice', password: 'good-password-1', monthlyCapCny: -1 }), e => e.code === 'invalid_cap');
  const a = await users.create({ username: 'alice', password: 'good-password-1', monthlyCapCny: 12.345 });
  assert.equal(a.monthlyCapFen, 1234, 'cap is floored to the fen');
  await assert.rejects(users.create({ username: 'ALICE', password: 'good-password-1', monthlyCapCny: 1 }), e => e.code === 'username_taken');
  const raw = fs.readFileSync(path.join(dir, 'projects.sqlite')).toString('latin1');
  assert.ok(!raw.includes('good-password-1'), 'no plaintext password in the database file');
  assert.equal(JSON.stringify(users.list()).includes('salt'), false, 'list never returns the password record');
  assert.equal((await users.authenticate('alice', 'good-password-1')).userId, a.userId);
  assert.equal(await users.authenticate('alice', 'wrong-password-1'), null);
  assert.equal(await users.authenticate('nobody', 'good-password-1'), null);
  users.update(a.userId, { enabled: false });
  assert.deepEqual(revoked.at(-1), [a.userId, 'user_disabled']);
  assert.equal(await users.authenticate('alice', 'good-password-1'), null, 'disabled user cannot log in');
  assert.equal(users.active(a.userId), false);
  users.update(a.userId, { enabled: true });
  await users.resetPassword(a.userId, 'another-password-2');
  assert.deepEqual(revoked.at(-1), [a.userId, 'password_reset']);
  assert.equal(await users.authenticate('alice', 'good-password-1'), null);
  assert.equal((await users.authenticate('alice', 'another-password-2')).username, 'alice');
});

test('B8 monthly cap: conservative spend (active runs count their whole ceiling), plain-language refusal, Beijing calendar month', async t => {
  const dir = tmp(t), store = new ProjectStore({ dir }); t.after(() => store.close());
  let clock = Date.UTC(2026, 10, 15, 4); // 2026-11-15 12:00 Beijing
  const users = createUsers({ store, now: () => clock });
  const u = await users.create({ username: 'bob', password: 'good-password-1', monthlyCapCny: 10 });
  const other = await users.create({ username: 'carol', password: 'good-password-1', monthlyCapCny: 10 });
  assert.equal(monthStart(Date.UTC(2026, 10, 30, 16, 30)), Date.UTC(2026, 10, 30, 16), '2026-12-01 00:30 Beijing is already December');
  const p = store.createProject({ name: 'b', description: 'b' }, { ownerId: u.userId });
  const q = store.createProject({ name: 'c', description: 'c' }, { ownerId: other.userId });
  const usd = cny => cny / 7.5;
  // finished run: recorded cost only
  const r1 = store.createRun(p, { approval: { maxCost: usd(5) }, usage: { cost: usd(3), reservedCost: 0 } });
  store.updateRun(r1.runId, { status: 'approved', executionActive: false });
  // another user's spend never counts
  const r3 = store.createRun(q, { approval: { maxCost: usd(9) }, usage: { cost: usd(9), reservedCost: 0 } });
  store.updateRun(r3.runId, { status: 'approved', executionActive: false });
  assert.equal(users.spend(u.userId).spentFen, 300);
  assert.doesNotThrow(() => users.assertQuota(u.userId, usd(7)));
  assert.throws(() => users.assertQuota(u.userId, usd(7.01)), e => e.code === 'monthly_quota_insufficient' && /本月额度只剩 ¥7\.00/.test(e.message) && !/[A-Za-z]/.test(e.message));
  // active run counts its full authorized ceiling, not the little it has spent so far
  const r2 = store.createRun(p, { approval: { maxCost: usd(7) }, usage: { cost: usd(0.5), reservedCost: 0 }, executionActive: true });
  assert.equal(store.getRun(r2.runId).status, 'running');
  assert.equal(users.spend(u.userId).spentFen, 1000);
  assert.throws(() => users.assertQuota(u.userId, usd(0.01)), e => e.code === 'monthly_quota_exhausted' && e.message === '本月额度已用完，请联系管理员' && e.status === 402);
  // when it finishes, only what it really recorded stays
  store.updateRun(r2.runId, { status: 'awaiting_review', executionActive: false });
  assert.equal(users.spend(u.userId).spentFen, 350);
  // admin raises the cap / next month starts fresh
  users.update(u.userId, { monthlyCapCny: 3.5 });
  assert.throws(() => users.assertQuota(u.userId, usd(0.01)), e => e.code === 'monthly_quota_exhausted');
  clock = Date.UTC(2026, 10, 30, 16, 1); // 2026-12-01 00:01 Beijing
  assert.equal(users.spend(u.userId).spentFen, 0);
  assert.equal(usdToFen(0.0001), 1, 'spend is rounded up, never down');
});
