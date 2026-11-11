'use strict';
// R45: contract shape + trust decisions. Every illegal or unauthorised dispatch is refused
// before any workspace or process exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../agent-pilot-r45/contract');
const P = require('../../agent-pilot-r45/policy');
const H = require('./helpers.cjs');

test('a correctly signed, gated, capped envelope is authorised', () => {
  assert.equal(P.authorize(H.envelope(), H.policy()), null);
});

test('default shipped policy trusts no key and has live execution off', () => {
  const p = P.loadPolicy();
  assert.equal(p.live_enabled, false); assert.equal(p.allow_fake_cli, false); assert.deepEqual(p.trusted_keys, {});
  assert.equal(P.authorize(H.envelope(), p), 'UNTRUSTED_KEY');
  assert.throws(() => P.loadPolicy({ live_enabled: true }), /LIVE_OVERRIDE_DENIED/, 'a policy file cannot switch live on');
  assert.throws(() => P.loadPolicy({ allow_local_live: true }), /LIVE_OVERRIDE_DENIED/);
  assert.throws(() => P.loadPolicy({ max_budget_usd: 1000 }), /INVALID_POLICY/);
});

const cases = [
  ['unsigned / tampered after signing', () => ({ ...H.envelope(), issue: 30 }), 'BAD_SIGNATURE'],
  ['signed by an unknown key', () => H.sign(H.envelope({}, { raw: true }), H.other.privateKey, 'nobody'), 'UNTRUSTED_KEY'],
  ['key without dispatcher role', () => H.sign(H.envelope({}, { raw: true }), H.other.privateKey, 'observer-test'), 'UNTRUSTED_KEY'],
  ['wrong repository', () => H.envelope({ repo: 'evil/fork' }), 'REPO_NOT_ALLOWED'],
  ['issue outside allow-list', () => H.envelope({ issue: 30 }), 'ISSUE_NOT_ALLOWED'],
  ['main branch', () => H.envelope({ source: { branch: 'main' } }), 'BRANCH_NOT_ALLOWED'],
  ['path traversal branch', () => H.envelope({ source: { branch: 'feat/../main' } }), 'BRANCH_NOT_ALLOWED'],
  ['short source SHA', () => H.envelope({ source: { sha: 'abc123' } }), /MALFORMED_ENVELOPE:.*SOURCE/],
  ['expired', () => H.envelope({ issued_at: new Date(Date.now() - 7200000).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() }), 'ENVELOPE_EXPIRED'],
  ['issued in the future', () => H.envelope({ issued_at: new Date(Date.now() + 3600000).toISOString(), expires_at: new Date(Date.now() + 3700000).toISOString() }), 'ISSUED_IN_FUTURE'],
  ['lifetime too long', () => H.envelope({ expires_at: new Date(Date.now() + 86400000).toISOString() }), 'ENVELOPE_LIFETIME_TOO_LONG'],
  ['gate SHA not the pinned candidate', () => H.envelope({ gate: { gate_sha: 'b'.repeat(40), audit: { reviewed_sha: 'b'.repeat(40) }, qa: { reviewed_sha: 'b'.repeat(40) } } }), 'GATE_SHA_NOT_PINNED'],
  ['audit missing verdict', () => H.envelope({ gate: { audit: { verdict: undefined } } }), 'MISSING_OR_FAILED_AUDIT'],
  ['audit REJECT', () => H.envelope({ gate: { audit: { verdict: 'REJECT' } } }), 'MISSING_OR_FAILED_AUDIT'],
  ['audit of another SHA', () => H.envelope({ gate: { audit: { reviewed_sha: 'c'.repeat(40) } } }), 'MISSING_OR_FAILED_AUDIT'],
  ['audit reference not a GitHub link', () => H.envelope({ gate: { audit: { ref: 'trust me' } } }), 'MISSING_OR_FAILED_AUDIT'],
  ['QA FAIL', () => H.envelope({ gate: { qa: { verdict: 'FAIL' } } }), 'MISSING_OR_FAILED_QA'],
  ['QA BLOCKED', () => H.envelope({ gate: { qa: { verdict: 'BLOCKED' } } }), 'MISSING_OR_FAILED_QA'],
  ['open P1', () => H.envelope({ gate: { open_p0_p1: 1 } }), 'OPEN_P0_P1'],
  ['cost unknown', () => H.envelope({ cost: { billing: 'unknown', cap_usd: undefined } }), 'COST_UNDETERMINED'],
  ['zero cap', () => H.envelope({ cost: { cap_usd: 0 } }), 'COST_UNDETERMINED'],
  ['cap above policy', () => H.envelope({ cost: { cap_usd: 3 } }), 'COST_CAP_ABOVE_POLICY'],
  ['codex has no native spend cap', () => H.envelope({ task: { cli: 'codex' } }), 'COST_CAP_NOT_ENFORCEABLE'],
  ['runtime above policy', () => H.envelope({ task: { max_runtime_ms: 99999999 } }), 'RUNTIME_OUT_OF_POLICY'],
  ['write mode requested', () => H.envelope({ task: { mode: 'write' } }), /MALFORMED_ENVELOPE:.*TASK/],
  ['unknown CLI', () => H.envelope({ task: { cli: 'bash' } }), /MALFORMED_ENVELOPE:.*TASK/],
  ['smuggled field (free prompt)', () => H.envelope({ prompt: 'rm -rf /' }), /UNKNOWN_FIELD:prompt/],
  ['bad dispatch id', () => H.envelope({ dispatch_id: '../../../../x' }), /DISPATCH_ID/],
  ['not an object', () => 'PASS', /ENVELOPE_NOT_OBJECT/]
];
for (const [name, make, expected] of cases) test('refuses: ' + name, () => {
  const r = P.authorize(make(), H.policy());
  if (expected instanceof RegExp) assert.match(String(r), expected); else assert.equal(r, expected);
});

test('dedupe key ignores trigger and dispatch id; digest covers everything but the signature', () => {
  const a = H.envelope({ trigger: { kind: 'github_event', event_id: 'e1' }, dispatch_id: 'dsp-event-1' });
  const b = H.envelope({ trigger: { kind: 'fallback_tick', event_id: 'tick-2026-11-06T16:00' }, dispatch_id: 'dsp-tick-1' });
  assert.equal(C.dedupeKey(a), C.dedupeKey(b));
  assert.notEqual(C.envelopeDigest(a), C.envelopeDigest(b));
  assert.notEqual(C.dedupeKey(a), C.dedupeKey(H.envelope({ source: { sha: 'd'.repeat(40) } })));
  assert.equal(C.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('outcome contract rejects inconsistent launch accounting and fake cost', () => {
  const ok = C.makeOutcome({ state: 'DRY_RUN', retry: 'none' });
  assert.deepEqual(C.outcomeErrors(ok), []);
  assert.ok(C.outcomeErrors({ ...ok, agent_launch: { ...ok.agent_launch, real_agent_launch: true } }).includes('LAUNCH_INCONSISTENT'));
  assert.ok(C.outcomeErrors({ ...ok, cost: { known: false, usd: 0 } }).includes('COST'), 'unknown cost must be null, never 0');
  assert.ok(C.outcomeErrors({ ...ok, retry: 'auto' }).includes('RETRY'));
  assert.throws(() => C.makeOutcome({ state: 'DONE' }), /INVALID_OUTCOME_STATE/);
});
