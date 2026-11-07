'use strict';
// Short-lived private workspace: a fresh clone pinned to the exact source SHA, a private
// HOME and TMPDIR, no git remote, removed afterwards. The task is read-only, so any change
// to the tree or HEAD afterwards is a violation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Seal = require('../first-pilot-r51/workspace-seal');
const workspaces = new WeakMap();

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { PATH: process.env.PATH || '', HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS:'0', LANG: 'C.UTF-8' } }).trim();

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
    Seal.readonly(dir);
    const ws=Object.freeze({ root, dir, home, tmp, sha });workspaces.set(ws,Seal.scan(dir));return ws;
  } catch (e) { Seal.restore(root);fs.rmSync(root, { recursive: true, force: true }); throw Error(e.message === 'WRONG_SHA' ? 'WRONG_SHA' : 'WORKSPACE_FAILED'); }
}
function verifyUnchanged(ws) {
  if(!workspaces.has(ws))return 'READONLY_VIOLATION';
  try{if(Seal.changes(workspaces.get(ws),Seal.scan(ws.dir)).length)return 'READONLY_VIOLATION';
  const head = git(['rev-parse', 'HEAD'], ws.dir), status = git(['status', '--porcelain', '--untracked-files=all'], ws.dir);
  return head === ws.sha && status === '' ? null : 'READONLY_VIOLATION';}catch{return 'READONLY_VIOLATION';}
}
function cleanup(ws) { if(ws){if(!workspaces.has(ws))throw Error('UNKNOWN_WORKSPACE');Seal.restore(ws.root);fs.rmSync(ws.root,{recursive:true,force:true});workspaces.delete(ws);} }
module.exports = { prepare, verifyUnchanged, cleanup };
