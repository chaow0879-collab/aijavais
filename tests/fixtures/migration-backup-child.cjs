'use strict';
// Fault injection is confined to this disposable test process. The backup
// itself is produced by real SQLite, with the same permissive deployment umask.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ProjectStore } = require('../../lib/project-store');
const [mode, dir] = process.argv.slice(2);
process.umask(0o022);
fs.chmodSync(dir, 0o755);
const timestamp = 1730000000000;
if (mode === 'collision') Date.now = () => timestamp;
const events = [];
let stagedTarget;
function fileMode(filename) { return fs.lstatSync(filename).mode & 0o777; }
function event(phase, target) {
  const parent = path.dirname(target);
  const value = { phase, target, parent, directoryMode: fileMode(parent), exists: fs.existsSync(target),
    mode: fs.existsSync(target) ? fileMode(target) : null };
  events.push(value); return value;
}
function pause(phase, target) {
  // Synchronous write reaches the parent even while this process is blocked in
  // the injected creation window. Parent kills it; no finally block can run.
  fs.writeSync(1, JSON.stringify({ paused: phase, events, target }) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Pause unexpectedly resumed');
}
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (!/^\s*VACUUM INTO\s/i.test(sql)) return statement;
  return { run: (...args) => {
    stagedTarget = args[0]; event('before_vacuum', stagedTarget);
    const result = statement.run(...args);
    event('after_vacuum_before_chmod', stagedTarget);
    if (mode === 'crash-before-chmod') pause('before_chmod', stagedTarget);
    return result;
  } };
};
const chmod = fs.chmodSync;
fs.chmodSync = (filename, permissions) => {
  if (filename === stagedTarget) {
    event('before_chmod', filename);
    if (mode === 'chmod-failure') throw Object.assign(new Error('MOCK chmod failure'), { code: 'EPERM' });
    if (mode === 'chmod-noop') { chmod(filename, 0o644); return; }
  }
  return chmod(filename, permissions);
};
const link = fs.linkSync;
fs.linkSync = (source, destination) => {
  if (source === stagedTarget) {
    event('before_publish', source);
    if (mode === 'crash-before-publish') pause('before_publish', source);
    if (mode === 'link-failure') throw Object.assign(new Error('MOCK publish failure'), { code: 'EXDEV' });
  }
  const result = link(source, destination);
  if (source === stagedTarget) event('published', destination);
  return result;
};
const unlink = fs.unlinkSync;
fs.unlinkSync = filename => {
  if (filename === stagedTarget && mode === 'unlink-failure') throw Object.assign(new Error('MOCK private-copy cleanup failure'), { code: 'EPERM' });
  return unlink(filename);
};
if (mode === 'unsafe-private-directory') {
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (...args) => {
    const result = mkdtemp(...args);
    // Model a filesystem/provider returning an insecure directory; production
    // must reject before invoking VACUUM, rather than trust the creation call.
    if (String(args[0]).includes('.migration-backup-')) chmod(result, 0o755);
    return result;
  };
}
let store;
try {
  store = new ProjectStore({ dir });
  const result = { ok: true, schemaVersion: store.schemaVersion, migrationBackups: store.migrationBackups || [], events };
  store.close(); store = null;
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  try { store?.close(); } catch { /* Do not hide the injected failure. */ }
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || null, message: error.message, events }) + '\n');
}
