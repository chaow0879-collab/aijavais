'use strict';
// R48 regression: neither frozen package regressed. R46's own suite is re-executed from the
// exact-SHA read-only tree; R45's own files on this branch must be byte-identical to R45's
// frozen SHA (R48 never edits them) and its suite is re-executed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { assemble, cleanup, SOURCES } = require('../../agent-interop-r48/sources');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const env = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const counts = out => Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(k => [k, Number((out.match(new RegExp('ℹ ' + k + ' (\\d+)')) || [])[1])]));

test('R46 frozen suite (a1a258a) re-executed from the assembled tree: 101 tests, 0 fail, 0 skip', { timeout: 600000 }, t => {
  const m = assemble(ROOT); t.after(() => cleanup(m));
  const files = ['control.test.js', 'github.test.js', 'pilot-contract.test.js'].map(f => 'tools/relay/tests/auto-handoff-r46/' + f);
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: m.sources.r46.dir, encoding: 'utf8', env: env(), timeout: 580000 });
  const c = counts(r.stdout + r.stderr);
  assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter(l => /^✖/.test(l)).join('\n'));
  assert.deepEqual(c, { tests: 101, pass: 101, fail: 0, skipped: 0, cancelled: 0 });
});

test('R45 package on this branch is byte-identical to frozen 0b95251 and its suite still passes (65)', { timeout: 300000 }, () => {
  const changed = execFileSync('git', ['diff', '--name-only', SOURCES.r45.sha, 'HEAD', '--', 'tools/relay/agent-pilot-r45', 'tools/relay/tests/agent-pilot-r45'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(changed, '', 'R48 must not modify R45: ' + changed);
  const r = spawnSync(process.execPath, ['--test', ...['policy', 'runner', 'preflight', 'handoff'].map(f => 'tools/relay/tests/agent-pilot-r45/' + f + '.test.js')], { cwd: ROOT, encoding: 'utf8', env: env(), timeout: 280000 });
  assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter(l => /^✖/.test(l)).join('\n'));
  assert.deepEqual(counts(r.stdout + r.stderr), { tests: 65, pass: 65, fail: 0, skipped: 0, cancelled: 0 });
});
