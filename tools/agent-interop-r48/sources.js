'use strict';
// R48: assemble the two frozen source trees (R45 runner, R46 control plane) READ-ONLY in a
// fresh temporary directory, straight from exact 40-char commits. Every extracted file is
// checked against its Git blob id; a missing commit is BLOCKED_SOURCE (never "latest").
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SOURCES = Object.freeze({
  r45: Object.freeze({ sha: '0b95251133d47fd7c0b9280d3ddb5287c2628307', issue: 29, ci: 42248277575, ancestor: '4c198c430806836bb289cd5da57b7fad44c7b0dc',
    paths: ['tools/agent-pilot-r45', 'tests/agent-pilot-r45'] }),
  r46: Object.freeze({ sha: 'a1a258a41c2041ab8d6cebc622cfed0c690c3387', issue: 30, ci: 42253344324, ancestor: 'ab3e07979f67924e795426737e26c5c4d84b8501',
    paths: ['tools/auto-handoff-r46', 'tools/agent-executor', 'tools/agent-scheduler', 'tests/auto-handoff-r46', 'tests/agent-scheduler', '.github/workflows/auto-handoff-r46.yml'] })
});
// Facts the matrix must never confuse: which candidate the gates actually judged.
const GATE_FACTS = Object.freeze({
  r43_candidate: 'ab3e07979f67924e795426737e26c5c4d84b8501', r43_audit: 'REJECT', r43_audit_ref: 'https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6689538804',
  r47_fix_candidate: '3c37035befab9e411724686ff22e44333174e217', r47_independent_audit: 'NOT_YET_ACCEPTED'
});
const SHA = /^[a-f0-9]{40}$/;
const git = (repo, args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: opts.encoding === null ? null : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, timeout: 120000,
  env: { PATH: process.env.PATH || '', HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' } });
const blobId = buf => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');

function haveCommit(repo, sha) { try { return git(repo, ['cat-file', '-t', sha]).trim() === 'commit'; } catch { return false; } }
// Fetch only the exact commit; never a branch name, never a fallback.
function ensureCommit(repo, sha, { allowFetch = true } = {}) {
  if (!SHA.test(sha)) throw Object.assign(Error('BLOCKED_SOURCE'), { detail: 'NOT_A_40_CHAR_SHA' });
  if (haveCommit(repo, sha)) return 'LOCAL';
  if (allowFetch) { try { git(repo, ['fetch', '--quiet', '--no-tags', 'origin', sha]); } catch { /* reported below */ } }
  if (!haveCommit(repo, sha)) throw Object.assign(Error('BLOCKED_SOURCE'), { detail: 'COMMIT_NOT_AVAILABLE:' + sha });
  return 'FETCHED_EXACT_SHA';
}
function assemble(repo, { root, allowFetch = true } = {}) {
  repo = path.resolve(repo);
  const dir = root || fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'r48-sources-'));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw Object.assign(Error('BLOCKED_SOURCE'), { detail: 'TARGET_NOT_EMPTY' }); // never overwrite
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest = { schema: 'aijavais.interop.sources/v1', assembled_at: new Date().toISOString(), repo_head: git(repo, ['rev-parse', 'HEAD']).trim(), sources: {} };
  for (const [name, s] of Object.entries(SOURCES)) {
    const origin = ensureCommit(repo, s.sha, { allowFetch });
    // The frozen source must descend from its declared base (provenance, not a stray commit).
    let ancestry = 'VERIFIED';
    try { git(repo, ['merge-base', '--is-ancestor', s.ancestor, s.sha]); } catch { ancestry = 'NOT_AN_ANCESTOR'; }
    if (ancestry !== 'VERIFIED') { try { ensureCommit(repo, s.ancestor, { allowFetch }); git(repo, ['merge-base', '--is-ancestor', s.ancestor, s.sha]); ancestry = 'VERIFIED'; } catch { /* stays */ } }
    if (ancestry !== 'VERIFIED') throw Object.assign(Error('BLOCKED_SOURCE'), { detail: name + ':ANCESTRY:' + s.ancestor });
    const out = path.join(dir, name);
    fs.mkdirSync(out, { mode: 0o700 });
    const entries = git(repo, ['ls-tree', '-r', s.sha, '--', ...s.paths]).trim().split('\n').filter(Boolean).map(l => { const [meta, file] = l.split('\t'); const [mode, type, id] = meta.split(' '); return { mode, type, id, file }; });
    if (!entries.length) throw Object.assign(Error('BLOCKED_SOURCE'), { detail: name + ':NO_FILES' });
    const files = [];
    for (const e of entries) {
      if (e.type !== 'blob' || !/^100(644|755)$/.test(e.mode) || e.file.includes('..')) throw Object.assign(Error('BLOCKED_SOURCE'), { detail: name + ':UNEXPECTED_ENTRY:' + e.file });
      const buf = git(repo, ['cat-file', 'blob', e.id], { encoding: null });
      if (blobId(buf) !== e.id) throw Object.assign(Error('BLOCKED_SOURCE'), { detail: name + ':BLOB_MISMATCH:' + e.file });
      const target = path.join(out, e.file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, buf, { mode: e.mode === '100755' ? 0o500 : 0o400, flag: 'wx' }); // read-only copies, never overwritten
      files.push({ file: e.file, blob: e.id });
    }
    manifest.sources[name] = { sha: s.sha, issue: s.issue, ci_run: s.ci, origin, ancestor: s.ancestor, ancestry, files: files.length, tree_digest: crypto.createHash('sha256').update(files.map(f => f.file + ':' + f.blob).join('\n')).digest('hex'), dir: out, sample: files.slice(0, 3) };
  }
  // Ownership sanity: neither frozen tree contains the other's package (no hidden coupling).
  manifest.ownership = {
    r46_contains_r45_runner: fs.existsSync(path.join(dir, 'r46', 'tools/agent-pilot-r45')),
    r45_contains_r46_control: fs.existsSync(path.join(dir, 'r45', 'tools/auto-handoff-r46'))
  };
  manifest.root = dir;
  return manifest;
}
function cleanup(manifest) {
  if (!manifest?.root) return;
  for (const p of walk(manifest.root)) try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
  fs.rmSync(manifest.root, { recursive: true, force: true });
}
function* walk(d) { yield d; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
module.exports = { SOURCES, GATE_FACTS, assemble, cleanup, ensureCommit };
