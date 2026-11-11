'use strict';
// R50 test fixtures. Every key here is synthetic and confined to the test process and its
// private temp dirs: the approver key, the broker test signer, the OIDC RSA key and the
// webhook secret can authorize nothing outside a test (live paths stay compiled OFF).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R49 = require('../first-handoff-r49/helpers.cjs');
const H = require('../agent-pilot-r45/helpers.cjs');
const P = require('../../agent-pilot-r45/contract');
const CFG = require('../../trusted-trigger-r50/config.json');
const { Broker, TestSigner } = require('../../trusted-trigger-r50/broker');
const { TriggerStore } = require('../../trusted-trigger-r50/store');

const SECRET = 'R50_SYNTHETIC_WEBHOOK_SECRET_NOT_A_CREDENTIAL_0123456789';
const INSTALLATION = 77;
const approver = crypto.generateKeyPairSync('ed25519');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { synthetic: true, keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'r50-synthetic-kid', use: 'sig', alg: 'RS256' }] };
const pem = k => k.export({ type: 'spki', format: 'pem' });

function r50Policy(over = {}) {
  const c = { ...CFG, installation_id: INSTALLATION, allow_test_signer: true, approver_keys: { 'owner-synthetic': pem(approver.publicKey) },
    trusted_callers: [
      { kind: 'github_webhook', repository_id: 1446621245, senders: ['planner'], installation_id: INSTALLATION },
      { kind: 'github_actions_oidc', repository_id: '1446621245', workflow_ref: CFG.trusted_workflow_ref, allow_synthetic: true }
    ], ...over };
  delete c._comment; return c;
}
// R49's own fixture (synthetic reviews, R46 authorization, R45 policy), minus R49's pre-made
// signature: R50's broker has to produce it. The R45 policy trusts the broker signer only.
function base(t, mode = 'success', { seed, runtime } = {}) {
  const f = R49.setup(t, mode, runtime ? { runtime } : {});
  delete f.signed;
  const dir = H.tmp(t, 'r50-state-');
  const signer = new TestSigner({ testOnly: true, seed });
  f.policy = H.policy({ allowed_issues: [32], pinned_gate_sha: H.HEAD, trusted_keys: { [signer.keyId]: { pem: signer.publicPem, roles: ['dispatcher'] } } });
  const store = new TriggerStore(path.join(dir, 'trigger.sqlite'));
  t.after(() => store.close());
  const separated = Object.values(f.pairs).map(p => pem(p.publicKey));
  const broker = new Broker({ signer, policy: r50Policy(), store, separatedKeys: separated });
  return { f, signer, store, broker, dir, separated };
}
function approval(f, over = {}) {
  const a = { schema: 'aijavais.approval/v1', approval_id: 'appr-' + crypto.randomUUID(), issue: f.envelope.issue, role: f.envelope.role === 'integrator' ? 'developer' : f.envelope.role, task_id: f.envelope.task_id,
    source_sha: H.HEAD, gate_refs: { audit: f.envelope.audit_refs.audit, qa: f.envelope.audit_refs.qa }, cli: 'claude', mode: 'readonly', max_cost_usd: 0.1, max_runtime_ms: 30000,
    expires_at: new Date(f.now + 2 * 3600000).toISOString(), one_shot: true, ...over };
  delete a.signature;
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  return { ...a, signature: { key_id: 'owner-synthetic', alg: 'ed25519', value: crypto.sign(null, Buffer.from(P.canonical(a)), approver.privateKey).toString('base64') } };
}
function delivery(f, { event = 'issue_comment', payload = {}, headers = {}, secret = SECRET, at = f.now } = {}) {
  const base = event === 'workflow_run'
    ? { action: 'completed', repository: { full_name: 'chaow0879-collab/aijavais', id: f.config.repository_id, fork: false }, sender: { login: 'planner' }, installation: { id: INSTALLATION },
        workflow_run: { conclusion: 'success', event: 'push', head_repository: { full_name: 'chaow0879-collab/aijavais', fork: false }, head_sha: f.candidate_sha, head_branch: f.config.trusted_event_branches[0], updated_at: new Date(at).toISOString() } }
    : { action: 'created', repository: { full_name: 'chaow0879-collab/aijavais', id: f.config.repository_id, fork: false }, sender: { login: 'planner' }, installation: { id: INSTALLATION },
        issue: { number: f.envelope.issue, author_association: 'OWNER' }, comment: { author_association: 'OWNER', body: 'run it now please (text is never an approval)', created_at: new Date(at).toISOString() } };
  const body = JSON.stringify(deepMerge(base, payload));
  return { body, headers: { 'content-type': 'application/json', 'user-agent': 'GitHub-Hookshot/r50fixture', 'x-github-event': event, 'x-github-delivery': crypto.randomUUID(),
    'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex'), ...headers } };
}
function deepMerge(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v; return o; }
function oidcToken(claimsOver = {}, { alg = 'RS256', kid = 'r50-synthetic-kid', key = rsa.privateKey, now = Date.now(), tamper } = {}) {
  const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const sec = Math.floor(now / 1000);
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: CFG.oidc_audience, repository: CFG.repo, repository_id: '1446621245', ref: 'refs/heads/main', ref_type: 'branch',
    sha: H.HEAD, event_name: 'schedule', workflow_ref: CFG.trusted_workflow_ref, runner_environment: 'github-hosted', run_id: '424242', iat: sec - 5, nbf: sec - 5, exp: sec + 300, ...claimsOver };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const head = enc({ alg, typ: 'JWT', kid }), body = enc(claims);
  const sig = alg === 'none' ? '' : alg === 'HS256' ? crypto.createHmac('sha256', pem(rsa.publicKey)).update(head + '.' + body).digest('base64url') : crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), key).toString('base64url');
  return head + '.' + (tamper ? enc({ ...claims, ...tamper }) : body) + '.' + sig;
}
const r46cfg = f => ({ ...f.config, allowed_senders: ['planner'] });
module.exports = { SECRET, INSTALLATION, JWKS, r50Policy, base, approval, delivery, oidcToken, r46cfg, H, approverPublic: pem(approver.publicKey) };
