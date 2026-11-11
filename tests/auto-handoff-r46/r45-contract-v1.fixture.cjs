'use strict';
// R45 machine contract between the control plane (Codex R46: trusted event + 10-minute
// fallback, remote claim) and this one-shot runner. Both sides only exchange these two
// JSON documents; neither imports the other's source.
const crypto = require('node:crypto');

const ENVELOPE_SCHEMA = 'aijavais.pilot.envelope/v1';
const OUTCOME_SCHEMA = 'aijavais.pilot.outcome/v1';
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/;
const STATES = ['DRY_RUN', 'SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED', 'BLOCKED', 'REJECTED', 'DUPLICATE', 'HUMAN_REVIEW_REQUIRED'];

// Deterministic JSON: sorted keys, no undefined. Used for signatures and digests.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const unsigned = envelope => { const { signature, ...rest } = envelope; void signature; return rest; };
const envelopeDigest = envelope => sha256(canonical(unsigned(envelope)));
// The same work (whatever triggered it: GitHub event or fallback tick) has one dedupe key.
const dedupeKey = e => sha256(canonical([e.repo, e.issue, e.role, e.phase, e.source.sha, e.gate.gate_sha, e.task.cli, e.task.template]));

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, max = 200) => typeof x === 'string' && x.length > 0 && x.length <= max;
// Shape check only (no trust decisions). Unknown top-level fields are refused so a
// control plane cannot smuggle options the runner would silently ignore.
function shapeErrors(e) {
  const err = [];
  const need = (ok, code) => { if (!ok) err.push(code); };
  if (!isObj(e)) return ['ENVELOPE_NOT_OBJECT'];
  const allowed = ['schema', 'repo', 'issue', 'role', 'phase', 'dispatch_id', 'trigger', 'source', 'gate', 'task', 'cost', 'issued_at', 'expires_at', 'signature'];
  for (const k of Object.keys(e)) if (!allowed.includes(k)) err.push('UNKNOWN_FIELD:' + k.slice(0, 40));
  need(e.schema === ENVELOPE_SCHEMA, 'SCHEMA');
  need(str(e.repo, 100) && /^[\w.-]+\/[\w.-]+$/.test(e.repo), 'REPO');
  need(Number.isSafeInteger(e.issue) && e.issue > 0, 'ISSUE');
  need(['developer', 'audit', 'qa'].includes(e.role), 'ROLE');
  need(str(e.phase, 60) && /^[a-z0-9_-]+$/.test(e.phase), 'PHASE');
  need(str(e.dispatch_id, 100) && ID.test(e.dispatch_id), 'DISPATCH_ID');
  need(isObj(e.trigger) && ['github_event', 'fallback_tick', 'manual_operator'].includes(e.trigger.kind) && str(e.trigger.event_id, 120), 'TRIGGER');
  need(isObj(e.source) && str(e.source.branch, 200) && SHA.test(e.source.sha || ''), 'SOURCE');
  const g = e.gate;
  need(isObj(g) && SHA.test(g.gate_sha || '') && isObj(g.audit) && isObj(g.qa) && Number.isSafeInteger(g.open_p0_p1), 'GATE');
  const t = e.task;
  need(isObj(t) && ['claude', 'codex'].includes(t.cli) && t.mode === 'readonly' && str(t.template, 60) && Number.isSafeInteger(t.max_runtime_ms), 'TASK');
  need(isObj(e.cost) && ['capped', 'unknown'].includes(e.cost.billing), 'COST');
  need(Number.isFinite(Date.parse(e.issued_at)) && Number.isFinite(Date.parse(e.expires_at)), 'TIME');
  need(isObj(e.signature) && str(e.signature.key_id, 80) && e.signature.alg === 'ed25519' && str(e.signature.value, 200), 'SIGNATURE');
  return err;
}

// The outcome is the only thing the control plane needs to settle its remote claim.
function makeOutcome(fields) {
  const o = {
    schema: OUTCOME_SCHEMA, run_id: fields.run_id || crypto.randomUUID(), dispatch_id: fields.dispatch_id || null, dedupe_key: fields.dedupe_key || null,
    envelope_digest: fields.envelope_digest || null, source_sha: fields.source_sha || null, gate_sha: fields.gate_sha || null,
    state: fields.state, reason: fields.reason || null, retry: fields.retry || 'never',
    process: fields.process || null,
    cost: fields.cost || { known: false, usd: null, cap_usd: null },
    agent_launch: fields.agent_launch || { mode: 'none', real_agent_launch: false, actual_agent_launches: 0, process_launches: 0, cli: null, cli_version: null },
    evidence: { level: 'E2', log_sha256: null, log_file: null, ci_ref: process.env.GITHUB_RUN_ID ? (process.env.GITHUB_SERVER_URL || 'https://github.com') + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID : null, ...(fields.evidence || {}) },
    finished_at: new Date().toISOString()
  };
  if (!STATES.includes(o.state)) throw Error('INVALID_OUTCOME_STATE');
  return o;
}
function outcomeErrors(o) {
  const err = [];
  if (!isObj(o) || o.schema !== OUTCOME_SCHEMA) return ['SCHEMA'];
  if (!STATES.includes(o.state)) err.push('STATE');
  if (!['none', 'never', 'manual_only'].includes(o.retry)) err.push('RETRY');
  if (!isObj(o.cost) || typeof o.cost.known !== 'boolean' || (o.cost.known ? !Number.isFinite(o.cost.usd) : o.cost.usd !== null)) err.push('COST');
  if (!isObj(o.agent_launch) || typeof o.agent_launch.real_agent_launch !== 'boolean' || ![0, 1].includes(o.agent_launch.actual_agent_launches)) err.push('LAUNCH');
  if (o.agent_launch && o.agent_launch.real_agent_launch !== (o.agent_launch.actual_agent_launches === 1)) err.push('LAUNCH_INCONSISTENT');
  if (o.source_sha !== null && !SHA.test(o.source_sha)) err.push('SOURCE_SHA');
  return err;
}
module.exports = { ENVELOPE_SCHEMA, OUTCOME_SCHEMA, STATES, SHA, canonical, sha256, unsigned, envelopeDigest, dedupeKey, shapeErrors, makeOutcome, outcomeErrors };
