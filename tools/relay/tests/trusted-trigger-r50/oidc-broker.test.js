'use strict';
// M1/M3: GitHub Actions OIDC caller identity (real RS256 verification, synthetic JWKS) and
// the trusted signature broker seam (structured owner approvals, exact-SHA binding,
// one-shot scope, revocation, key separation). Production signer/IdP: BLOCKED.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyOidc } = require('../../trusted-trigger-r50/oidc');
const { Broker, TestSigner, productionSigner, LIVE_SIGNING_ENABLED, verifyApproval } = require('../../trusted-trigger-r50/broker');
const { verifyDelivery } = require('../../trusted-trigger-r50/intake');
const R49 = require('../../first-handoff-r49/control');
const A = require('../../agent-pilot-r45/policy');
const X = require('./helpers.cjs');

const now = Date.now();
const pol = X.r50Policy();
test('OIDC: valid synthetic schedule token yields a minted caller identity', () => {
  const id = verifyOidc(X.oidcToken({}, { now }), { jwks: X.JWKS, policy: pol, now });
  assert.equal(id.kind, 'github_actions_oidc'); assert.equal(id.event_name, 'schedule'); assert.equal(id.synthetic, true);
});
test('OIDC: no JWKS / identity provider → BLOCKED_IDENTITY_PROVIDER', () => {
  assert.throws(() => verifyOidc(X.oidcToken({}, { now }), { jwks: null, policy: pol, now }), e => e.code === 'BLOCKED_IDENTITY_PROVIDER');
});
for (const [name, token, code] of [
  ['alg none', () => X.oidcToken({}, { now, alg: 'none' }), 'OIDC_ALG'],
  ['HS256 key confusion', () => X.oidcToken({}, { now, alg: 'HS256' }), 'OIDC_ALG'],
  ['unknown kid', () => X.oidcToken({}, { now, kid: 'other' }), 'OIDC_UNKNOWN_KEY'],
  ['foreign signing key', () => X.oidcToken({}, { now, key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), 'OIDC_SIGNATURE'],
  ['tampered claims', () => X.oidcToken({}, { now, tamper: { ref: 'refs/heads/main', repository_id: '1446621245', sha: 'f'.repeat(40) } }), 'OIDC_SIGNATURE'],
  ['wrong issuer', () => X.oidcToken({ iss: 'https://evil.example' }, { now }), 'OIDC_ISSUER'],
  ['wrong audience', () => X.oidcToken({ aud: 'sts.amazonaws.com' }, { now }), 'OIDC_AUDIENCE'],
  ['expired', () => X.oidcToken({ exp: Math.floor(now / 1000) - 10 }, { now }), 'OIDC_TIME'],
  ['not yet valid', () => X.oidcToken({ nbf: Math.floor(now / 1000) + 600 }, { now }), 'OIDC_TIME'],
  ['other repository', () => X.oidcToken({ repository: 'evil/aijavais' }, { now }), 'OIDC_REPOSITORY'],
  ['other repository id', () => X.oidcToken({ repository_id: '1' }, { now }), 'OIDC_REPOSITORY'],
  ['feature branch ref', () => X.oidcToken({ ref: 'refs/heads/feat/x' }, { now }), 'OIDC_REF'],
  ['pull_request event', () => X.oidcToken({ event_name: 'pull_request' }, { now }), 'OIDC_EVENT'],
  ['pull_request_target event', () => X.oidcToken({ event_name: 'pull_request_target' }, { now }), 'OIDC_EVENT'],
  ['other workflow file', () => X.oidcToken({ workflow_ref: 'chaow0879-collab/aijavais/.github/workflows/evil.yml@refs/heads/main' }, { now }), 'OIDC_WORKFLOW'],
  ['self-hosted runner', () => X.oidcToken({ runner_environment: 'self-hosted' }, { now }), 'OIDC_WORKFLOW'],
  ['short sha', () => X.oidcToken({ sha: 'abc' }, { now }), 'OIDC_SHA']
]) test('OIDC refused: ' + name, () => assert.throws(() => verifyOidc(token(), { jwks: X.JWKS, policy: pol, now }), e => e.code === code));

// ---------- broker ----------
const webhookCaller = ctx => verifyDelivery(X.delivery(ctx.f), { secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, now: ctx.f.now });
const prepared = (ctx, over = {}) => ({ ...R49.prepare({ ...ctx.f.input(), ...over }), task_id: ctx.f.envelope.task_id });
const sign = (ctx, { caller, approval, prep } = {}) => ctx.broker.sign({ caller: caller || webhookCaller(ctx), approval: approval || X.approval(ctx.f), prepared: prep || prepared(ctx), now: ctx.f.now });

test('broker signs the exact R49-prepared frame; R45 accepts it with the broker key; receipt is audited', t => {
  const ctx = X.base(t), { signed, receipt } = sign(ctx);
  assert.equal(A.authorize(signed, ctx.f.policy, ctx.f.now), null);
  assert.equal(signed.source.sha, X.H.HEAD); assert.equal(signed.gate.gate_sha, X.H.HEAD);
  assert.equal(receipt.test_signer, true); assert.equal(receipt.live_signing_enabled, false);
  assert.ok(ctx.store.auditLog().some(e => e.kind === 'envelope_signed' && e.detail.approval_id === receipt.approval_id));
});
const refusals = [
  ['S01: approval for another SHA (cross-candidate re-sign)', ctx => sign(ctx, { approval: X.approval(ctx.f, { source_sha: '9'.repeat(40) }) }), 'CANDIDATE_SHA_MISMATCH'],
  ['frame source moved after preparation', ctx => { const p = prepared(ctx); p.unsigned_envelope = { ...p.unsigned_envelope, source: { ...p.unsigned_envelope.source, sha: '8'.repeat(40) } }; return sign(ctx, { prep: p }); }, 'CANDIDATE_SHA_MISMATCH'],
  ['gate SHA differs from source (S01)', ctx => { const p = prepared(ctx); p.unsigned_envelope = { ...p.unsigned_envelope, gate: { ...p.unsigned_envelope.gate, gate_sha: '7'.repeat(40) } }; return sign(ctx, { prep: p }); }, 'CANDIDATE_SHA_MISMATCH'],
  ['audit evidence ref differs from approval', ctx => sign(ctx, { approval: X.approval(ctx.f, { gate_refs: { audit: 'https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-999', qa: ctx.f.envelope.audit_refs.qa } }) }), 'GATE_EVIDENCE_MISMATCH'],
  ['other issue', ctx => sign(ctx, { approval: X.approval(ctx.f, { issue: 99 }) }), 'APPROVAL_SCOPE_MISMATCH'],
  ['other role', ctx => sign(ctx, { approval: X.approval(ctx.f, { role: 'qa' }) }), 'APPROVAL_SCOPE_MISMATCH'],
  ['other task id', ctx => sign(ctx, { approval: X.approval(ctx.f, { task_id: 'another-task' }) }), 'APPROVAL_SCOPE_MISMATCH'],
  ['zero budget', ctx => sign(ctx, { approval: X.approval(ctx.f, { max_cost_usd: 0 }) }), 'APPROVAL_LIMITS'],
  ['huge budget', ctx => sign(ctx, { approval: X.approval(ctx.f, { max_cost_usd: 1000 }) }), 'APPROVAL_LIMITS'],
  ['frame cost above approval', ctx => sign(ctx, { approval: X.approval(ctx.f, { max_cost_usd: 0.05 }) }), 'COST_NOT_WITHIN_APPROVAL'],
  ['runtime beyond approval', ctx => sign(ctx, { approval: X.approval(ctx.f, { max_runtime_ms: 10 }) }), 'APPROVAL_LIMITS'],
  ['codex instead of claude', ctx => sign(ctx, { approval: X.approval(ctx.f, { cli: 'codex' }) }), 'APPROVAL_MALFORMED'],
  ['write mode', ctx => sign(ctx, { approval: X.approval(ctx.f, { mode: 'write' }) }), 'APPROVAL_MALFORMED'],
  ['expired approval', ctx => sign(ctx, { approval: X.approval(ctx.f, { expires_at: new Date(ctx.f.now - 1000).toISOString() }) }), 'APPROVAL_EXPIRED'],
  ['approval valid for too long', ctx => sign(ctx, { approval: X.approval(ctx.f, { expires_at: new Date(ctx.f.now + 30 * 86400000).toISOString() }) }), 'APPROVAL_EXPIRED'],
  ['approval with an extra field (free-text grant)', ctx => sign(ctx, { approval: X.approval(ctx.f, { note: 'please also allow writes' }) }), 'APPROVAL_MALFORMED'],
  ['approval signature tampered', ctx => { const a = X.approval(ctx.f); a.max_cost_usd = 0.09; return sign(ctx, { approval: a }); }, 'APPROVAL_SIGNATURE'],
  ['approval by an untrusted key', ctx => { const a = X.approval(ctx.f); a.signature.key_id = 'stranger'; return sign(ctx, { approval: a }); }, 'APPROVAL_SIGNER_UNTRUSTED'],
  ['issue comment text instead of an approval token', ctx => sign(ctx, { approval: 'APPROVED: run the pilot now' }), 'APPROVAL_MALFORMED'],
  ['plain-object caller (not minted by a verifier)', ctx => sign(ctx, { caller: { kind: 'github_webhook', repository_id: 1446621245, sender: 'planner', installation_id: 77 } }), 'CALLER_NOT_TRUSTED'],
  ['synthetic OIDC caller when policy forbids synthetic', ctx => { const b = new Broker({ signer: ctx.signer, policy: X.r50Policy({ trusted_callers: [{ kind: 'github_actions_oidc', repository_id: '1446621245', workflow_ref: X.r50Policy().trusted_workflow_ref }] }), store: ctx.store }); return b.sign({ caller: verifyOidc(X.oidcToken({}, { now: ctx.f.now }), { jwks: X.JWKS, policy: pol, now: ctx.f.now }), approval: X.approval(ctx.f), prepared: prepared(ctx), now: ctx.f.now }); }, 'CALLER_NOT_TRUSTED'],
  ['already-signed frame', ctx => { const p = prepared(ctx); p.signature_status = 'SIGNED'; return sign(ctx, { prep: p }); }, 'NOT_A_PREPARED_FRAME']
];
for (const [name, fn, code] of refusals) test('broker refused: ' + name, t => { const ctx = X.base(t); assert.throws(() => fn(ctx), e => e.code === code, name); });

test('one approval = one piece of work: same work re-signs (event and tick), other work is refused; revocation is final', t => {
  const ctx = X.base(t), a = X.approval(ctx.f);
  const first = sign(ctx, { approval: a });
  const tick = require('../../auto-handoff-r46/triggers').tick(ctx.f.now, ctx.f.config);
  const again = sign(ctx, { approval: a, prep: prepared(ctx, { trigger: tick }) });
  assert.equal(again.receipt.work_key, first.receipt.work_key);
  const other = X.base(t, 'success'); other.f.envelope.task_id = 'different-task'; other.f.signPilot(); delete other.f.signed;
  const otherPrep = { ...R49.prepare(other.f.input()), task_id: 'different-task' };
  const b2 = new Broker({ signer: ctx.signer, policy: X.r50Policy(), store: ctx.store });
  assert.throws(() => b2.sign({ caller: webhookCaller(ctx), approval: X.approval(other.f, { approval_id: a.approval_id, task_id: 'different-task' }), prepared: otherPrep, now: ctx.f.now }), e => e.code === 'APPROVAL_ID_REUSED', 'a reused approval id with different content (another task) is refused even though the work key is the same');
  ctx.store.revoke(a.approval_id, 'owner withdrew', ctx.f.now);
  assert.throws(() => sign(ctx, { approval: a }), e => e.code === 'APPROVAL_REVOKED');
});

test('key separation and production defaults: no test signer without opt-in, no shared keys, no production signer, live signing off', t => {
  const ctx = X.base(t);
  assert.throws(() => new TestSigner(), e => e.code === 'TEST_SIGNER_REQUIRES_EXPLICIT_TEST_ONLY');
  assert.throws(() => new Broker({ signer: ctx.signer, policy: { ...X.r50Policy(), allow_test_signer: false }, store: ctx.store }), e => e.code === 'TEST_SIGNER_NOT_ALLOWED');
  assert.throws(() => new Broker({ signer: ctx.signer, policy: X.r50Policy(), store: ctx.store, separatedKeys: [ctx.signer.publicPem] }), e => e.code === 'KEY_ROLE_CONFLICT', 'broker key must not be an R46 operator/HALT/audit key');
  assert.throws(() => new Broker({ signer: ctx.signer, policy: X.r50Policy({ approver_keys: { x: ctx.signer.publicPem } }), store: ctx.store }), e => e.code === 'KEY_ROLE_CONFLICT');
  assert.throws(() => productionSigner(), e => e.code === 'BLOCKED_SIGNER_NOT_CONFIGURED');
  assert.equal(LIVE_SIGNING_ENABLED, false);
  assert.doesNotMatch(JSON.stringify(ctx.signer) + Object.keys(ctx.signer).join(), /PRIVATE KEY/);
  const shipped = require('../../trusted-trigger-r50/config.json');
  assert.deepEqual([shipped.enabled, shipped.allow_test_signer, shipped.trusted_callers.length, Object.keys(shipped.approver_keys).length], [false, false, 0, 0]);
  assert.throws(() => verifyApproval(X.approval(ctx.f), { ...X.r50Policy(), approver_keys: {} }, ctx.f.now), e => e.code === 'APPROVAL_SIGNER_UNTRUSTED', 'shipped config trusts no approver');
});
