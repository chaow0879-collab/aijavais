'use strict';
// R48: exact-SHA source assembly and the test-only bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemble, cleanup, ensureCommit, SOURCES, GATE_FACTS } = require('../../agent-interop-r48/sources');
const { TestBroker, toR45, toR46, TEST_KEY_PREFIX } = require('../../agent-interop-r48/bridge');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

test('assembles both frozen trees from exact SHAs with blob verification, read-only, no cross-ownership', t => {
  const m = assemble(ROOT); t.after(() => cleanup(m));
  assert.equal(m.sources.r45.sha, '0b95251133d47fd7c0b9280d3ddb5287c2628307');
  assert.equal(m.sources.r46.sha, 'a1a258a41c2041ab8d6cebc622cfed0c690c3387');
  for (const s of ['r45', 'r46']) { assert.equal(m.sources[s].ancestry, 'VERIFIED'); assert.ok(m.sources[s].files > 10); assert.match(m.sources[s].tree_digest, /^[a-f0-9]{64}$/); }
  assert.deepEqual(m.ownership, { r46_contains_r45_runner: false, r45_contains_r46_control: false });
  const f = path.join(m.sources.r46.dir, 'tools/auto-handoff-r46/contract.js');
  assert.equal(fs.statSync(f).mode & 0o222, 0, 'assembled sources are read-only');
  assert.match(fs.readFileSync(f, 'utf8'), /const SOURCE='ab3e07979f67924e795426737e26c5c4d84b8501'/, 'the R46 pin is to the REJECTED R43 candidate');
});

test('a missing source commit is BLOCKED_SOURCE (never falls back to a branch or latest)', () => {
  assert.throws(() => ensureCommit(ROOT, '0123456789abcdef0123456789abcdef01234567', { allowFetch: false }), e => e.message === 'BLOCKED_SOURCE' && /COMMIT_NOT_AVAILABLE/.test(e.detail));
  assert.throws(() => ensureCommit(ROOT, 'main', { allowFetch: false }), e => e.message === 'BLOCKED_SOURCE' && e.detail === 'NOT_A_40_CHAR_SHA');
});

test('assembly never overwrites an existing non-empty target', t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r48-occupied-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'keep.txt'), 'x');
  assert.throws(() => assemble(ROOT, { root: d }), e => e.message === 'BLOCKED_SOURCE' && e.detail === 'TARGET_NOT_EMPTY');
  assert.equal(fs.readFileSync(path.join(d, 'keep.txt'), 'utf8'), 'x');
});

test('gate facts keep the REJECTED R43 candidate and the not-yet-accepted R47 fix distinct', () => {
  assert.equal(GATE_FACTS.r43_audit, 'REJECT');
  assert.notEqual(GATE_FACTS.r43_candidate, GATE_FACTS.r47_fix_candidate);
  assert.equal(GATE_FACTS.r47_independent_audit, 'NOT_YET_ACCEPTED');
  assert.notEqual(SOURCES.r45.sha, GATE_FACTS.r47_fix_candidate, 'R45 tree is not the R47 fix');
});

test('test broker: explicit opt-in, private key never reachable, recognisable key id', () => {
  assert.throws(() => new TestBroker(), /EXPLICIT_TEST_ONLY/);
  const b = new TestBroker({ testOnly: true });
  assert.ok(b.keyId.startsWith(TEST_KEY_PREFIX));
  assert.doesNotMatch(JSON.stringify(b) + Object.keys(b).join(), /PRIVATE KEY/);
  assert.ok(Object.isFrozen(b));
  assert.match(Object.values(b.trustEntry())[0].pem, /BEGIN PUBLIC KEY/);
});

test('bridge: no broker → BLOCKED_TRUSTED_SIGNATURE_BROKER; refuses non-R46 frames', () => {
  const prepared = { evidence: 'E2_E3_FAKE', signature_status: 'NOT_SIGNED', unsigned_envelope: { a: 1 } };
  assert.equal(toR45(prepared).status, 'BLOCKED_TRUSTED_SIGNATURE_BROKER');
  assert.throws(() => toR45({ ...prepared, signature_status: 'SIGNED' }), /NOT_AN_R46_FAKE_FRAME/);
  assert.throws(() => toR45(prepared, { broker: { sign: () => ({}) } }), /ONLY_TEST_BROKER/);
});

test('bridge toR46: exactly two field mappings, never upgrades/relabels real launches, never invents states', () => {
  const fake = { state: 'SUCCESS', process: { pid: 1, exit_code: 0 }, evidence: { level: 'E3_FAKE_CLI', log_sha256: 'x' }, agent_launch: { real_agent_launch: false, actual_agent_launches: 0 } };
  const r = toR46(fake);
  assert.equal(r.status, 'MAPPED'); assert.equal(r.outcome.evidence.level, 'E3_FAKE'); assert.equal(r.outcome.process.exit, 0);
  assert.equal(fake.evidence.level, 'E3_FAKE_CLI', 'input not mutated');
  assert.throws(() => toR46({ ...fake, agent_launch: { real_agent_launch: true, actual_agent_launches: 1 } }), /REAL_OUTCOME_NOT_MAPPABLE/);
  assert.throws(() => toR46({ ...fake, evidence: { level: 'E4_CANDIDATE_REQUIRES_INDEPENDENT_VERIFICATION' } }), /REAL_OUTCOME_NOT_MAPPABLE/);
  assert.equal(toR46({ ...fake, state: 'DUPLICATE', evidence: { level: 'E3_FAKE_CLI', previous_run_id: 'p' } }).status, 'BLOCKED_R46_STATE_UNMAPPED');
  assert.equal(toR46({ ...fake, state: 'DRY_RUN', evidence: { level: 'E2' } }).status, 'BLOCKED_R46_STATE_UNMAPPED');
});
