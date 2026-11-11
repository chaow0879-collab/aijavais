'use strict';
// Historical vulnerability observation, NOT a passing security verdict. All sentinels
// and repositories are private disposable fixtures; no host/user files are targets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const base = require('./r55-sources.json').base;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-historical-audit-'));
const env = { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const backend = path.join(root, 'historical-backend');
  git(repo, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', repo, backend]);
  git(backend, ['checkout', '--quiet', '--detach', base]);
  assert.equal(git(backend, ['rev-parse', 'HEAD']), base);
  const W = require(path.join(backend, 'tools/agent-executor/workspace'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source); git(source, ['init', '--quiet']);
  fs.mkdirSync(path.join(source, 'tests'));
  fs.writeFileSync(path.join(source, 'tests/allowed'), 'safe');
  git(source, ['add', '.']); git(source, ['commit', '--quiet', '-m', 'owned fixture']);
  const sha = git(source, ['rev-parse', 'HEAD']);
  const report = { historical_backend_sha: base, orchestrator_sha: git(repo, ['rev-parse', 'HEAD']), level: 'HISTORICAL_VULNERABILITY_OBSERVATION_NOT_SECURITY_PASS', real_model_calls: 0 };
  for (const kind of ['transient', 'symlink']) {
    const ws = W.prepare(source, 'feat/r55-audit-fixture', sha);
    try {
      if (kind === 'transient') {
        fs.writeFileSync(path.join(ws.dir, 'unauthorized'), 'bad');
        fs.unlinkSync(path.join(ws.dir, 'unauthorized'));
      } else {
        const outside = path.join(root, 'owned-outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'sentinel'), 'safe');
        fs.symlinkSync(outside, path.join(ws.dir, 'tests/link'));
        fs.writeFileSync(path.join(ws.dir, 'tests/link/sentinel'), 'changed');
        report.outside_modified = fs.readFileSync(path.join(outside, 'sentinel'), 'utf8') === 'changed';
      }
      report[kind + '_incorrectly_accepted'] = W.verifyChanges(ws, 'qa', ['tests']);
    } finally { W.cleanup(ws); }
  }
  assert.equal(report.transient_incorrectly_accepted, true);
  assert.equal(report.symlink_incorrectly_accepted, true);
  assert.equal(report.outside_modified, true);
  const out = process.env.R55_EVIDENCE_DIR;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'original-r51-vulnerabilities.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
