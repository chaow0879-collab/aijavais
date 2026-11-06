'use strict';
// #14 package 4 / #2 AUD-68-FU-01/02/03: operator backup hardening and a
// read-only inventory of leftover backup artefacts. Temporary directories and
// real SQLite only; never touches business DATA. Fault injection uses injected
// fs implementations or the existing disposable migration child fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');
const { ProjectStore } = require('../lib/project-store');
const { publishPrivateBackup, immutableUri } = require('../lib/private-backup');
const { inventory, main: inventoryMain } = require('../tools/backup-inventory');
const ROOT = path.join(__dirname, '..');
const CHILD = path.join(__dirname, 'fixtures', 'migration-backup-child.cjs');
const mode = f => fs.lstatSync(f).mode & 0o777;
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function tmp(t, prefix = 'aij-backup-ops-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function storeWithData(t) {
  const dir = tmp(t), store = new ProjectStore({ dir });
  store.createProject({ name: 'Sensitive project', description: 'Private text that must never sit in a world-readable file.' });
  t.after(() => store.close());
  return { dir, store };
}
function cleanEnv() { const env = { ...process.env }; for (const k of ['NODE_TEST_CONTEXT', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID']) delete env[k]; return env; }
// Full recursive snapshot without following symlinks: proves "read-only".
function snapshot(dir) {
  const out = {};
  const walk = p => { for (const name of fs.readdirSync(p).sort()) { const f = path.join(p, name), s = fs.lstatSync(f);
    out[path.relative(dir, f)] = { mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, link: s.isSymbolicLink() ? fs.readlinkSync(f) : null, sha: s.isFile() ? sha(f) : null };
    if (s.isDirectory()) walk(f); } };
  walk(dir); return out;
}

test('AUD-68-FU-03 reproduced: the pre-fix pattern (write then chmod) exposes a 0644 backup in a 0755 directory under umask 022', async t => {
  const { dir, store } = storeWithData(t);
  const previous = process.umask(0o022); t.after(() => process.umask(previous));
  const shared = tmp(t); fs.chmodSync(shared, 0o755);
  const target = path.join(shared, 'old-pattern.sqlite');
  await sqliteBackup(store.db, target); // exactly what the old backup()/db:backup did before chmod
  t.diagnostic(JSON.stringify({ oldPatternModeBeforeChmod: mode(target).toString(8), parentMode: mode(shared).toString(8) }));
  assert.equal(mode(target), 0o644, 'window was real: other local users could read the full database copy');
  assert.equal(mode(shared), 0o755); void dir;
});

test('ProjectStore.backup(): written inside a private 0700 staging dir, published 0600 + quick_check, data intact, no leftovers', async t => {
  const { store } = storeWithData(t);
  const previous = process.umask(0o022); t.after(() => process.umask(previous));
  const shared = tmp(t); fs.chmodSync(shared, 0o755);
  const target = path.join(shared, 'nested', 'backup.sqlite');
  const out = await store.backup(target);
  assert.equal(out.mode, '600'); assert.equal(out.quickCheck, 'ok'); assert.equal(mode(target), 0o600);
  assert.equal(mode(path.dirname(target)), 0o700, 'newly created parent is private');
  const db = new DatabaseSync(immutableUri(target), { readOnly: true }); // immutable: no -wal/-shm side files
  try { assert.equal(db.prepare('SELECT count(*) n FROM projects').get().n, 1); } finally { db.close(); }
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['backup.sqlite'], 'staging removed');
  // Observe the creation window through the helper with the same writer.
  const seen = [];
  await publishPrivateBackup(path.join(shared, 'observed.sqlite'), async staged => {
    await sqliteBackup(store.db, staged);
    seen.push({ stagedMode: mode(staged), stagingDirMode: mode(path.dirname(staged)), destExists: fs.existsSync(path.join(shared, 'observed.sqlite')) });
  });
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen[0].stagedMode, 0o644, 'SQLite still creates 0644 under umask 022 ...');
  assert.equal(seen[0].stagingDirMode, 0o700, '... but only inside a 0700 directory');
  assert.equal(seen[0].destExists, false, 'nothing is published before chmod + verification');
});

test('backup fails closed and never overwrites: existing file, symlink, live DB, concurrent creation, chmod failure/fake success, unsafe staging, EXDEV, ENOSPC, corrupt copy', async t => {
  const { store, dir } = storeWithData(t);
  const area = tmp(t);
  const writer = staged => sqliteBackup(store.db, staged);
  const leftovers = () => fs.readdirSync(area).filter(n => n.startsWith('.private-backup-'));
  // Existing file / symlink / live database.
  const existing = path.join(area, 'existing.sqlite'); fs.writeFileSync(existing, 'KEEP-ME'); const before = sha(existing);
  await assert.rejects(store.backup(existing), e => e.code === 'backup_exists'); assert.equal(sha(existing), before);
  const victim = path.join(area, 'victim.txt'); fs.writeFileSync(victim, 'VICTIM'); const link = path.join(area, 'link.sqlite'); fs.symlinkSync(victim, link);
  await assert.rejects(store.backup(link), e => e.code === 'backup_exists'); assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
  await assert.rejects(store.backup(path.join(dir, 'projects.sqlite')), e => e.code === 'backup_exists');
  // Destination appears while the copy is being written: link() refuses, nothing overwritten.
  const racing = path.join(area, 'racing.sqlite');
  await assert.rejects(publishPrivateBackup(racing, async staged => { await writer(staged); fs.writeFileSync(racing, 'OTHER-PROCESS'); }), e => e.code === 'backup_exists');
  assert.equal(fs.readFileSync(racing, 'utf8'), 'OTHER-PROCESS');
  // Injected filesystem faults.
  const fake = overrides => ({ ...fs, ...overrides });
  const cases = [
    ['chmod EPERM', { chmodSync: () => { throw Object.assign(new Error('MOCK chmod'), { code: 'EPERM' }); } }, /MOCK chmod/],
    // Force an unsafe postcondition: SQLite may already create 0600 on some hosts.
    ['chmod fake success', { chmodSync: file => { fs.chmodSync(file, 0o644); } }, e => e.code === 'backup_permissions'],
    ['unsafe staging dir', { mkdtempSync: (...a) => { const d = fs.mkdtempSync(...a); fs.chmodSync(d, 0o755); return d; } }, e => e.code === 'backup_permissions'],
    ['EXDEV link', { linkSync: () => { throw Object.assign(new Error('MOCK cross-device'), { code: 'EXDEV' }); } }, /cross-device/],
  ];
  const matrix = [];
  for (const [label, overrides, expected] of cases) {
    const target = path.join(area, label.replace(/\W+/g, '-') + '.sqlite'); let wrote = false;
    await assert.rejects(publishPrivateBackup(target, async s => { wrote = true; await writer(s); }, { fsImpl: fake(overrides) }), expected);
    assert.equal(fs.existsSync(target), false, label + ': nothing published');
    matrix.push({ label, wrote, published: false });
    if (label === 'unsafe staging dir') assert.equal(wrote, false, 'refused before the first byte');
  }
  const enospc = path.join(area, 'enospc.sqlite');
  await assert.rejects(publishPrivateBackup(enospc, async s => { fs.writeFileSync(s, 'partial'); throw Object.assign(new Error('MOCK no space left on device'), { code: 'ENOSPC' }); }), e => e.code === 'ENOSPC');
  assert.equal(fs.existsSync(enospc), false);
  const corrupt = path.join(area, 'corrupt.sqlite');
  await assert.rejects(publishPrivateBackup(corrupt, async s => { fs.writeFileSync(s, Buffer.alloc(4096, 7)); }), e => ['backup_integrity', 'ERR_SQLITE_ERROR'].includes(e.code) || /not a database|integrity/i.test(e.message));
  assert.equal(fs.existsSync(corrupt), false, 'a copy that fails quick_check is never published');
  assert.deepEqual(leftovers(), [], 'own disposable staging copies are removed; the source database is untouched');
  assert.equal(store.listProjects().length, 1);
  t.diagnostic(JSON.stringify(matrix));
});

test('npm run db:backup (tools/database.js): umask 022 + existing 0755 directory publishes 0600, refuses to overwrite, keeps live DB intact', t => {
  const { dir, store } = storeWithData(t); store.close();
  const shared = tmp(t); fs.chmodSync(shared, 0o755);
  const target = path.join(shared, 'ops-backup.sqlite');
  const run = () => spawnSync('/bin/sh', ['-c', 'umask 022; exec "$0" --no-warnings tools/database.js backup "$1"', process.execPath, target], { cwd: ROOT, env: { ...cleanEnv(), AIJ_DATA_DIR: dir }, encoding: 'utf8', timeout: 20000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /"mode":"600"/); assert.equal(mode(target), 0o600);
  const digest = sha(target);
  const second = run();
  assert.equal(second.status, 1); assert.match(second.stderr, /new file/); assert.equal(sha(target), digest, 'existing backup untouched');
  assert.deepEqual(fs.readdirSync(shared), ['ops-backup.sqlite']);
});

function v3Dir(t) {
  const dir = tmp(t, 'aij-inventory-'), store = new ProjectStore({ dir });
  store.createProject({ name: 'Inventory', description: 'Leftover backup inventory fixture.' });
  const old = store.migrationBackups || []; store.close(); for (const f of old) fs.unlinkSync(f);
  const db = new DatabaseSync(path.join(dir, 'projects.sqlite'));
  db.exec('DROP TABLE model_requests; DROP INDEX system_usage_status; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3;'); db.close();
  return dir;
}
function child(modeName, dir) { return spawnSync(process.execPath, ['--no-warnings', CHILD, modeName, dir], { env: cleanEnv(), encoding: 'utf8', timeout: 10000 }); }

test('read-only inventory: real leftovers (unlink failure, link failure, unsafe staging, SIGKILL before chmod) are reported, nothing is changed', async t => {
  const dirs = {};
  for (const m of ['unlink-failure', 'link-failure', 'unsafe-private-directory']) { dirs[m] = v3Dir(t); child(m, dirs[m]); }
  dirs.sigkill = v3Dir(t);
  const proc = spawn(process.execPath, ['--no-warnings', CHILD, 'crash-before-chmod', dirs.sigkill], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000); proc.stdout.on('data', b => { out += b; if (out.includes('\n')) { clearTimeout(timer); resolve(); } }); });
  const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited;
  const summary = {};
  for (const [label, dir] of Object.entries(dirs)) {
    const before = snapshot(dir);
    const report = inventory(dir);
    assert.deepEqual(snapshot(dir), before, label + ': inventory changed nothing (no delete/chmod/-wal/-shm)');
    summary[label] = report.items.map(i => ({ kind: i.kind, mode: i.mode, attention: i.attention, entries: (i.entries || []).map(e => ({ name: e.name, published: e.published, quickCheck: e.file?.quickCheck, mode: e.file?.mode })), file: i.file && { mode: i.file.mode, quickCheck: i.file.quickCheck, nlink: i.file.nlink } }));
    assert.ok(report.items.every(i => i.recoveryUse === 'manual_review_required')); assert.equal(report.readOnly, true); assert.equal(report.aclChecked, false);
  }
  t.diagnostic(JSON.stringify(summary));
  // unlink failure: published 0600 backup + same-inode private copy => "published"
  const u = summary['unlink-failure'];
  const stagedU = u.find(i => i.kind === 'migration_staging'), pubU = u.find(i => i.kind === 'published_migration_backup');
  assert.equal(pubU.file.mode, '600'); assert.equal(pubU.file.quickCheck, 'ok'); assert.equal(pubU.file.nlink, 2);
  assert.match(stagedU.entries[0].published, /^projects\.sqlite\.pre-v4-\d+\.bak$/);
  // link failure: complete copy, never published => attention, never "recoverable"
  const l = summary['link-failure'].find(i => i.kind === 'migration_staging');
  assert.equal(l.entries[0].published, false); assert.equal(l.entries[0].quickCheck, 'ok'); assert.ok(l.attention.some(a => /never published/.test(a)));
  // unsafe directory: mode reported, empty (VACUUM refused before first byte)
  const s = summary['unsafe-private-directory'].find(i => i.kind === 'migration_staging');
  assert.equal(s.mode, '755'); assert.ok(s.attention.some(a => /expected 700/.test(a))); assert.ok(s.attention.some(a => /empty staging/.test(a)));
  // SIGKILL before chmod: 0644 copy only inside the 0700 directory
  const k = summary.sigkill.find(i => i.kind === 'migration_staging');
  assert.equal(k.mode, '700'); assert.equal(k.entries[0].mode, '644'); assert.ok(k.attention.some(a => /file mode 644/.test(a)));
});

test('read-only inventory: symlinks, foreign files, truncated copies and CLI misuse fail closed without side effects', t => {
  const dir = tmp(t, 'aij-inventory-edge-');
  const outside = tmp(t, 'aij-outside-'); fs.writeFileSync(path.join(outside, 'secret.sqlite'), 'NOT-YOURS');
  fs.symlinkSync(outside, path.join(dir, '.migration-backup-evil1'));
  fs.symlinkSync(path.join(outside, 'secret.sqlite'), path.join(dir, 'projects.sqlite.pre-v4-1730000000000.bak'));
  const trunc = path.join(dir, '.migration-backup-trunc1'); fs.mkdirSync(trunc, { mode: 0o700 });
  fs.writeFileSync(path.join(trunc, 'backup.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(40)]), { mode: 0o600 });
  fs.writeFileSync(path.join(trunc, 'unexpected.txt'), 'x', { mode: 0o600 });
  const before = snapshot(dir), outsideBefore = snapshot(outside);
  const report = inventory(dir);
  assert.deepEqual(snapshot(dir), before); assert.deepEqual(snapshot(outside), outsideBefore, 'symlink targets are never opened');
  const byName = Object.fromEntries(report.items.map(i => [i.name, i]));
  assert.equal(byName['.migration-backup-evil1'].type, 'symlink'); assert.ok(byName['.migration-backup-evil1'].attention.includes('symlink not followed'));
  assert.equal(byName['projects.sqlite.pre-v4-1730000000000.bak'].type, 'symlink'); assert.equal(byName['projects.sqlite.pre-v4-1730000000000.bak'].file, undefined);
  const tr = byName['.migration-backup-trunc1'];
  assert.equal(tr.entries.find(e => e.name === 'backup.sqlite').file.quickCheck, 'not_sqlite'); assert.ok(tr.attention.some(a => /unexpected entry unexpected.txt/.test(a)));
  // CLI: unsupported destructive flags are refused; a missing DATA dir is a failure, not "all clear".
  const quiet = fn => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return fn(); } finally { console.log = log; console.error = err; } };
  assert.equal(quiet(() => inventoryMain([dir, '--delete'])), 1); assert.equal(quiet(() => inventoryMain(['--restore', dir])), 1);
  assert.equal(quiet(() => inventoryMain([path.join(dir, 'missing')])), 1);
  assert.equal(quiet(() => inventoryMain([dir, '--json'])), 2);
  const empty = tmp(t, 'aij-inventory-empty-'); assert.equal(quiet(() => inventoryMain([empty])), 0);
  assert.deepEqual(snapshot(dir), before);
});
