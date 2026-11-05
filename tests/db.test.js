'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, backupDb, MIGRATIONS } = require('../lib/db');
const { Vault } = require('../lib/vault');
const { importLegacy } = require('../lib/legacy-import');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aij-db-'));

test('数据库：迁移幂等、文档读写、事务回滚与嵌套、在线备份', () => {
  const dir = tmp(), file = path.join(dir, 'a.db');
  let db = openDb(file);
  assert.equal(db.all('SELECT version FROM schema_migrations').length, MIGRATIONS.length);
  db.close(); db = openDb(file);
  assert.equal(db.all('SELECT version FROM schema_migrations').length, MIGRATIONS.length, '重复打开不重复迁移');
  db.putDoc('tasks', 'task_id', 't1', { id: 't1', title: '任务' }, { kind: 'team', status: 'running', title: '任务' });
  db.putDoc('tasks', 'task_id', 't1', { id: 't1', title: '任务2' }, { kind: 'team', status: 'completed', title: '任务2' });
  assert.equal(db.getDoc('tasks', 'task_id', 't1').title, '任务2');
  assert.equal(db.get("SELECT status FROM tasks WHERE task_id='t1'").status, 'completed');
  assert.throws(() => db.tx(() => { db.putDoc('teams', 'team_id', 'x', { a: 1 }); throw new Error('boom'); }), /boom/);
  assert.equal(db.getDoc('teams', 'team_id', 'x'), null, '异常整体回滚');
  db.tx(() => {
    db.putDoc('teams', 'team_id', 'outer', { a: 1 });
    assert.throws(() => db.tx(() => { db.putDoc('teams', 'team_id', 'inner', { a: 2 }); throw new Error('inner'); }));
  });
  assert.ok(db.getDoc('teams', 'team_id', 'outer')); assert.equal(db.getDoc('teams', 'team_id', 'inner'), null, '嵌套事务只回滚内层');
  db.setSetting('k', { v: 1 }); assert.deepEqual(db.setting('k'), { v: 1 }); assert.equal(db.setting('none', 7), 7);
  db.meta('m', [1, 2]); assert.deepEqual(db.meta('m'), [1, 2]);
  const bk = backupDb(db, path.join(dir, 'bk', 'b.db'));
  const copy = openDb(bk);
  assert.equal(copy.getDoc('tasks', 'task_id', 't1').title, '任务2', '备份是一致的完整快照');
  copy.close(); db.close();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('凭证加密：AES-256-GCM；篡改或换主密钥都无法解密；支持环境变量主密钥', () => {
  const dir = tmp();
  const v = new Vault({ dir, env: {} });
  assert.equal(v.source, 'file');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'master.key')).mode & 0o777, 0o600);
  const enc = v.encrypt({ apiKey: 'sk-secret-123456' });
  assert.ok(!enc.includes('sk-secret'));
  assert.notEqual(enc, v.encrypt({ apiKey: 'sk-secret-123456' }), '每次随机 IV');
  assert.deepEqual(new Vault({ dir, env: {} }).decrypt(enc), { apiKey: 'sk-secret-123456' }, '重启后用同一密钥解密');
  const b = Buffer.from(enc.split(':')[2], 'base64'); b[b.length - 1] ^= 1;
  assert.throws(() => v.decrypt('v1:' + v.kid + ':' + b.toString('base64')), '篡改被检测');
  const other = new Vault({ dir: tmp(), env: {} });
  assert.throws(() => other.decrypt(enc), /主密钥不匹配/);
  const e1 = new Vault({ dir: tmp(), env: { AIJ_MASTER_KEY: 'my-long-master-passphrase' } });
  const e2 = new Vault({ dir: tmp(), env: { AIJ_MASTER_KEY: 'my-long-master-passphrase' } });
  assert.equal(e1.source, 'env'); assert.deepEqual(e2.decrypt(e1.encrypt({ a: 1 })), { a: 1 });
  assert.throws(() => new Vault({ dir: tmp(), env: { AIJ_MASTER_KEY: 'short' } }), /至少 16/);
});

test('旧数据导入：失败时整体回滚、旧文件原样保留；成功后只执行一次', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'teams.json'), JSON.stringify({ teams: [{ teamId: 'team_a', name: 'A', roles: [] }] }));
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ c1: { apiKey: 'sk-x-1234567' } }));
  const db = openDb(path.join(dir, 'aijavais.db'));
  const badVault = { encrypt: () => { throw new Error('加密失败'); } };
  assert.throws(() => importLegacy({ dir, db, vault: badVault }), /加密失败/);
  assert.equal(db.getDoc('teams', 'team_id', 'team_a'), null, '回滚');
  assert.ok(fs.existsSync(path.join(dir, 'teams.json')) && fs.existsSync(path.join(dir, 'credentials.json')), '旧文件未动');
  const v = new Vault({ dir, env: {} });
  const r = importLegacy({ dir, db, vault: v });
  assert.equal(r.imported.teams, 1); assert.equal(r.imported.credentials, 1);
  assert.deepEqual(v.decrypt(db.get('SELECT enc FROM credentials').enc), { apiKey: 'sk-x-1234567' });
  assert.equal(importLegacy({ dir, db, vault: v }).skipped, true, '只导入一次');
  db.close();
});
