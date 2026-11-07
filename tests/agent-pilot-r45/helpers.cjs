'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const C = require('../../tools/agent-pilot-r45/contract');
const P = require('../../tools/agent-pilot-r45/policy');

const ROOT = path.resolve(__dirname, '..', '..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const GATE = HEAD; // R49: valid fixtures authorize the exact code they execute.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const pem = k => k.export({ type: 'spki', format: 'pem' });

function sign(envelope, key = privateKey, keyId = 'dispatcher-test') {
  const body = C.unsigned(envelope);
  return { ...body, signature: { key_id: keyId, alg: 'ed25519', value: crypto.sign(null, Buffer.from(C.canonical(body)), key).toString('base64') } };
}
function envelope(over = {}, { raw = false } = {}) {
  const now = Date.now();
  const e = {
    schema: C.ENVELOPE_SCHEMA, repo: 'chaow0879-collab/aijavais', issue: 29, role: 'developer', phase: 'pilot',
    dispatch_id: 'dsp-' + crypto.randomUUID(), trigger: { kind: 'github_event', event_id: 'evt-1' },
    source: { branch: 'feat/claude-r45-trusted-runner-pilot', sha: HEAD },
    gate: { gate_sha: GATE, audit: { verdict: 'ACCEPT', reviewed_sha: GATE, ref: 'https://github.com/chaow0879-collab/aijavais/issues/2#fixture' }, qa: { verdict: 'PASS', reviewed_sha: GATE, ref: 'https://github.com/chaow0879-collab/aijavais/issues/4#fixture' }, open_p0_p1: 0 },
    task: { cli: 'claude', mode: 'readonly', template: 'readonly-repo-summary', max_runtime_ms: 20000 },
    cost: { billing: 'capped', cap_usd: 0.1 },
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 600000).toISOString(),
    signature: { key_id: 'x', alg: 'ed25519', value: 'x' }
  };
  const merged = deepMerge(e, over);
  return raw ? merged : sign(merged);
}
function deepMerge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v === undefined ? undefined : (a && typeof a[k] === 'object' && a[k] !== null && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
const trusted = { 'dispatcher-test': { pem: pem(publicKey), roles: ['dispatcher'] }, 'observer-test': { pem: pem(other.publicKey), roles: ['observer'] } };
const policy = (over = {}) => P.loadPolicy({ trusted_keys: trusted, allow_fake_cli: true, pinned_gate_sha: GATE, ...over }, { allowLiveOverride: true });
function tmp(t, prefix = 'r45-test-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
// A marked wrapper named like the real CLI, so the runner sees exactly the real argument shape.
function fakeCli(dir, mode, name = 'claude') {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const counter = path.join(dir, 'invocations.jsonl');
  const file = path.join(bin, name);
  fs.writeFileSync(file, '#!/bin/sh\n# AIJAVAIS_FAKE_CLI test double\nexec "' + process.execPath + '" "' + path.join(__dirname, 'fake-cli.cjs') + '" ' + mode + ' "' + counter + '" "$@"\n', { mode: 0o700 });
  return { file, counter, launches: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0) };
}
module.exports = { ROOT, HEAD, GATE, sign, envelope, policy, trusted, tmp, fakeCli, other, privateKey };
