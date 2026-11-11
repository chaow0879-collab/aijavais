'use strict';
// R50 trusted signature broker SEAM. It turns {verified caller, structured owner approval,
// R49-prepared R46 frame} into the Ed25519-signed R45 pilot envelope R49 execute() needs.
// It is not an authorization source by itself: the approval must be a structured token
// signed by an approver key, bound to one exact candidate SHA, its independent review refs,
// a positive cost cap, a runtime cap and a single piece of work. Free text never qualifies.
// Production signing needs an audited KMS/HSM signer: not available -> BLOCKED.
const crypto = require('node:crypto');
const P = require('../agent-pilot-r45/contract');
const { isMinted, reject } = require('./identity');

const LIVE_SIGNING_ENABLED = false;           // only an audited source change may flip this
const TEST_PREFIX = 'r50-test-signer-';
const secrets = new WeakMap();
const SHA = /^[a-f0-9]{40}$/;

class TestSigner {
  // Synthetic key for E2/E3 only. `seed` lets separate test processes share one key that never
  // leaves the test's private temp dir; production code paths refuse this signer.
  constructor({ testOnly, seed } = {}) {
    if (testOnly !== true) reject('TEST_SIGNER_REQUIRES_EXPLICIT_TEST_ONLY');
    const der = seed ? Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]) : null;
    const priv = der ? crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) : crypto.generateKeyPairSync('ed25519').privateKey;
    secrets.set(this, priv);
    this.publicPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
    this.keyId = TEST_PREFIX + crypto.createHash('sha256').update(this.publicPem).digest('hex').slice(0, 12);
    this.test = true;
    Object.freeze(this);
  }
  sign(bytes) { return crypto.sign(null, bytes, secrets.get(this)).toString('base64'); }
}
function productionSigner() { reject('BLOCKED_SIGNER_NOT_CONFIGURED'); } // KMS/HSM signer: not provisioned

function verifyApproval(a, policy, now) {
  const allowed = ['schema', 'approval_id', 'issue', 'role', 'task_id', 'source_sha', 'gate_refs', 'cli', 'mode', 'max_cost_usd', 'max_runtime_ms', 'expires_at', 'one_shot', 'signature'];
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !allowed.includes(k)) || a.schema !== 'aijavais.approval/v1') reject('APPROVAL_MALFORMED');
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(a.approval_id || '') || !Number.isSafeInteger(a.issue) || !SHA.test(a.source_sha || '') || a.one_shot !== true || a.cli !== 'claude' || a.mode !== 'readonly') reject('APPROVAL_MALFORMED');
  if (!a.gate_refs || typeof a.gate_refs.audit !== 'string' || typeof a.gate_refs.qa !== 'string') reject('APPROVAL_MALFORMED');
  if (!Number.isFinite(a.max_cost_usd) || a.max_cost_usd <= 0 || a.max_cost_usd > policy.max_cost_usd || !Number.isSafeInteger(a.max_runtime_ms) || a.max_runtime_ms < 1 || a.max_runtime_ms > policy.max_runtime_ms) reject('APPROVAL_LIMITS');
  const exp = Date.parse(a.expires_at);
  if (!Number.isFinite(exp) || exp <= now || exp - now > policy.max_approval_ttl_ms) reject('APPROVAL_EXPIRED');
  const key = policy.approver_keys[a.signature?.key_id];
  if (!key || a.signature.alg !== 'ed25519') reject('APPROVAL_SIGNER_UNTRUSTED');
  const body = { ...a }; delete body.signature;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(P.canonical(body)), key, Buffer.from(a.signature.value, 'base64')); } catch { ok = false; }
  if (!ok) reject('APPROVAL_SIGNATURE');
  return a;
}
function callerTrusted(c, policy) {
  if (!isMinted(c)) return false; // plain objects / issue text can never be a caller
  return policy.trusted_callers.some(t => t.kind === c.kind && (c.kind === 'github_webhook'
    ? t.repository_id === c.repository_id && t.senders.includes(c.sender) && (t.installation_id ?? null) === c.installation_id
    : t.workflow_ref === c.workflow_ref && t.repository_id === c.repository_id && (c.synthetic !== true || t.allow_synthetic === true)));
}

class Broker {
  constructor({ signer, policy, store, separatedKeys = [] }) {
    if (!signer || typeof signer.sign !== 'function' || typeof signer.keyId !== 'string') reject('SIGNER_REQUIRED');
    if (signer.test === true && policy.allow_test_signer !== true) reject('TEST_SIGNER_NOT_ALLOWED');
    // The broker key must never double as an R46 operator/HALT, V1/V2 audit or approver key.
    const pem = signer.publicPem.trim();
    if (separatedKeys.some(k => String(k).trim() === pem) || Object.values(policy.approver_keys).some(k => String(k).trim() === pem)) reject('KEY_ROLE_CONFLICT');
    Object.assign(this, { signer, policy, store });
    Object.freeze(this);
  }
  // Returns the signed R45 envelope plus an audit receipt. Throws a reason code on refusal.
  sign({ caller, approval, prepared, now }) {
    if (!callerTrusted(caller, this.policy)) reject('CALLER_NOT_TRUSTED');
    const a = verifyApproval(approval, this.policy, now);
    if (this.store.revoked(a.approval_id)) reject('APPROVAL_REVOKED');
    if (!prepared || prepared.evidence !== 'E2_E3_FAKE' || prepared.signature_status !== 'NOT_SIGNED') reject('NOT_A_PREPARED_FRAME');
    const f = prepared.unsigned_envelope;
    if (!f || f.schema !== P.ENVELOPE_SCHEMA || Object.hasOwn(f, 'signature') || P.shapeErrors({ ...f, signature: { key_id: 'x', alg: 'ed25519', value: 'x' } }).length) reject('NOT_A_PREPARED_FRAME');
    // One exact candidate: the code read == the code gated == the code approved (R48 S01 class).
    if (f.source.sha !== a.source_sha || f.gate.gate_sha !== a.source_sha || f.gate.audit.reviewed_sha !== a.source_sha || f.gate.qa.reviewed_sha !== a.source_sha) reject('CANDIDATE_SHA_MISMATCH');
    if (f.issue !== a.issue || f.role !== a.role || (a.task_id !== undefined && prepared.task_id !== undefined && prepared.task_id !== a.task_id)) reject('APPROVAL_SCOPE_MISMATCH');
    if (f.gate.audit.ref !== a.gate_refs.audit || f.gate.qa.ref !== a.gate_refs.qa || !['ACCEPT', 'ACCEPT_WITH_FOLLOWUP'].includes(f.gate.audit.verdict) || f.gate.qa.verdict !== 'PASS' || f.gate.open_p0_p1 !== 0) reject('GATE_EVIDENCE_MISMATCH');
    if (f.task.cli !== a.cli || f.task.mode !== 'readonly' || f.task.max_runtime_ms > a.max_runtime_ms) reject('APPROVAL_LIMITS');
    if (f.cost.billing !== 'capped' || !(f.cost.cap_usd > 0) || f.cost.cap_usd > a.max_cost_usd) reject('COST_NOT_WITHIN_APPROVAL');
    if (Date.parse(f.expires_at) > Date.parse(a.expires_at)) reject('ENVELOPE_OUTLIVES_APPROVAL');
    const work = P.dedupeKey({ ...f, signature: null });
    if (work !== prepared.dedupe_key) reject('NOT_A_PREPARED_FRAME');
    const bound = this.store.bindApproval(a.approval_id, P.sha256(P.canonical(a)), work, now);
    if (bound) reject(bound);
    const signed = { ...f, signature: { key_id: this.signer.keyId, alg: 'ed25519', value: this.signer.sign(Buffer.from(P.canonical(f))) } };
    const receipt = { approval_id: a.approval_id, work_key: work, envelope_digest: P.envelopeDigest(signed), candidate_sha: a.source_sha, broker_key_id: this.signer.keyId, caller: caller.kind, test_signer: this.signer.test === true, live_signing_enabled: LIVE_SIGNING_ENABLED };
    this.store.audit('envelope_signed', receipt, now);
    return { signed, receipt };
  }
}
module.exports = { Broker, TestSigner, productionSigner, verifyApproval, LIVE_SIGNING_ENABLED, TEST_PREFIX };
