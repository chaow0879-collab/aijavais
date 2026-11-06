'use strict';
// Short-lived private workspace: a fresh clone pinned to the exact source SHA, a private
// HOME and TMPDIR, no git remote, removed afterwards. The task is read-only, so any change
// to the tree or HEAD afterwards is a violation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { PATH: process.env.PATH || '', HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' } }).trim();

function prepare(sourceRepo, sha) {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'aij-pilot-'));
  fs.chmodSync(root, 0o700);
  const dir = path.join(root, 'repo'), home = path.join(root, 'home'), tmp = path.join(root, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', path.resolve(sourceRepo), dir]);
    try { git(['checkout', '--quiet', '--detach', sha], dir); } catch { throw Error('WRONG_SHA'); }
    if (git(['rev-parse', 'HEAD'], dir) !== sha) throw Error('WRONG_SHA');
    git(['remote', 'remove', 'origin'], dir);
    return { root, dir, home, tmp, sha };
  } catch (e) { fs.rmSync(root, { recursive: true, force: true }); throw Error(e.message === 'WRONG_SHA' ? 'WRONG_SHA' : 'WORKSPACE_FAILED'); }
}
function verifyUnchanged(ws) {
  const head = git(['rev-parse', 'HEAD'], ws.dir), status = git(['status', '--porcelain', '--untracked-files=all'], ws.dir);
  return head === ws.sha && status === '' ? null : 'READONLY_VIOLATION';
}
function cleanup(ws) { if (ws) fs.rmSync(ws.root, { recursive: true, force: true }); }
module.exports = { prepare, verifyUnchanged, cleanup };
