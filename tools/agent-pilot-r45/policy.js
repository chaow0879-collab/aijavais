'use strict';
// Trust decisions for one envelope. Every refusal is final for that envelope (retry: never):
// the runner never "fixes", re-signs or reinterprets a refused dispatch.
const crypto = require('node:crypto');
const C = require('./contract');
const DEFAULTS = require('./config.json');

// live_enabled can only change through an audited source change to config.json. A runtime
// policy file (e.g. supplying the dispatcher public key) may not switch it on; only the
// in-process test harness may, to exercise the refusal paths of live mode.
function loadPolicy(overrides, { allowLiveOverride = false } = {}) {
  if (overrides && Object.hasOwn(overrides, 'live_enabled') && !allowLiveOverride) throw Error('LIVE_OVERRIDE_DENIED');
  if (overrides && Object.hasOwn(overrides, 'allow_local_live') && !allowLiveOverride) throw Error('LIVE_OVERRIDE_DENIED');
  const p = { ...DEFAULTS, ...(overrides || {}) };
  delete p._comment;
  if (typeof p.live_enabled !== 'boolean' || typeof p.allow_fake_cli !== 'boolean' || !Number.isFinite(p.max_budget_usd) || p.max_budget_usd <= 0 || p.max_budget_usd > 5 ||
    !Number.isSafeInteger(p.max_runtime_ms) || p.max_runtime_ms < 1000 || p.max_runtime_ms > 1800000 || !Array.isArray(p.allowed_issues) || typeof p.trusted_keys !== 'object' || p.trusted_keys === null)
    throw Error('INVALID_POLICY');
  return Object.freeze(p);
}
function verifySignature(envelope, policy) {
  const key = policy.trusted_keys[envelope.signature.key_id];
  if (!key || typeof key.pem !== 'string' || !Array.isArray(key.roles) || !key.roles.includes('dispatcher')) return 'UNTRUSTED_KEY';
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) return 'KEY_EXPIRED';
  try {
    const ok = crypto.verify(null, Buffer.from(C.canonical(C.unsigned(envelope))), crypto.createPublicKey(key.pem), Buffer.from(envelope.signature.value, 'base64'));
    return ok ? null : 'BAD_SIGNATURE';
  } catch { return 'BAD_SIGNATURE'; }
}
// Returns null when the envelope may proceed (to dry-run or further live checks), else a reason code.
function authorize(envelope, policy, now = Date.now()) {
  const shape = C.shapeErrors(envelope);
  if (shape.length) return 'MALFORMED_ENVELOPE:' + shape.slice(0, 5).join(',');
  const sig = verifySignature(envelope, policy);
  if (sig) return sig;
  if (envelope.repo !== policy.repo) return 'REPO_NOT_ALLOWED';
  if (!policy.allowed_issues.includes(envelope.issue)) return 'ISSUE_NOT_ALLOWED';
  if (!policy.allowed_roles.includes(envelope.role)) return 'ROLE_NOT_ALLOWED';
  if (!new RegExp(policy.allowed_branch_pattern).test(envelope.source.branch) || envelope.source.branch.includes('..') || /^(main|master)$/.test(envelope.source.branch)) return 'BRANCH_NOT_ALLOWED';
  const issued = Date.parse(envelope.issued_at), expires = Date.parse(envelope.expires_at);
  if (issued > now + 60000) return 'ISSUED_IN_FUTURE';
  if (expires <= now) return 'ENVELOPE_EXPIRED';
  if (expires - issued > policy.max_envelope_age_ms) return 'ENVELOPE_LIFETIME_TOO_LONG';
  // Gate: both independent reviews must have passed the SAME pinned candidate, with no open P0/P1.
  const g = envelope.gate;
  if (policy.pinned_gate_sha && g.gate_sha !== policy.pinned_gate_sha) return 'GATE_SHA_NOT_PINNED';
  if (!policy.accepted_audit_verdicts.includes(g.audit.verdict) || g.audit.reviewed_sha !== g.gate_sha || typeof g.audit.ref !== 'string' || !/^https:\/\/github\.com\//.test(g.audit.ref)) return 'MISSING_OR_FAILED_AUDIT';
  if (!policy.accepted_qa_verdicts.includes(g.qa.verdict) || g.qa.reviewed_sha !== g.gate_sha || typeof g.qa.ref !== 'string' || !/^https:\/\/github\.com\//.test(g.qa.ref)) return 'MISSING_OR_FAILED_QA';
  if (g.open_p0_p1 !== 0) return 'OPEN_P0_P1';
  // Cost: the bound must be known and enforceable before anything is started.
  if (envelope.cost.billing !== 'capped' || !Number.isFinite(envelope.cost.cap_usd) || envelope.cost.cap_usd <= 0) return 'COST_UNDETERMINED';
  if (envelope.cost.cap_usd > policy.max_budget_usd) return 'COST_CAP_ABOVE_POLICY';
  if (envelope.task.cli === 'codex' && policy.codex_spend_limit_attested !== true) return 'COST_CAP_NOT_ENFORCEABLE'; // no native per-run spend cap flag
  if (envelope.task.max_runtime_ms < 1000 || envelope.task.max_runtime_ms > policy.max_runtime_ms) return 'RUNTIME_OUT_OF_POLICY';
  return null;
}
module.exports = { loadPolicy, authorize, verifySignature, DEFAULTS };
