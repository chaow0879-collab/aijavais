'use strict';
// R48: the full cross-branch conformance matrix, executed against the frozen R45 and R46
// code. Each row's verdict is pinned here. Known gaps are asserted AS GAPS (INCOMPATIBLE /
// UNSAFE_ACCEPTED) so the integrator sees them change when fixed; they are never hidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runMatrix } = require('../../tools/agent-interop-r48/matrix');
const { evaluate } = require('../../tools/agent-interop-r48/gonogo');
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED = {
  C01: 'COMPATIBLE', C02: 'COMPATIBLE', C03: 'INCOMPATIBLE', C04: 'INCOMPATIBLE', C05: 'INCOMPATIBLE', C06: 'INCOMPATIBLE', C07: 'INCOMPATIBLE', C08: 'COMPATIBLE_WITH_DELTA',
  C09: 'INCOMPATIBLE', C10: 'INCOMPATIBLE', 'C11-unauth': 'COMPATIBLE_WITH_DELTA', 'C11-fail': 'COMPATIBLE_WITH_DELTA', 'C11-nocost': 'COMPATIBLE_WITH_DELTA', C12: 'SAFE_REFUSAL', C13: 'INCOMPATIBLE',
  S01: 'UNSAFE_ACCEPTED',
  S02: 'SAFE_REFUSAL', S03: 'SAFE_REFUSAL', S04: 'SAFE_REFUSAL', S05: 'SAFE_REFUSAL', S06: 'SAFE_REFUSAL', S07: 'SAFE_REFUSAL', S08: 'SAFE_REFUSAL', S09: 'SAFE_REFUSAL', S10: 'SAFE_REFUSAL',
  S11: 'SAFE_REFUSAL', S12: 'SAFE_REFUSAL', S13: 'SAFE_REFUSAL', S14: 'SAFE_REFUSAL', S15: 'SAFE_REFUSAL', S16: 'SAFE_REFUSAL', S17: 'SAFE_REFUSAL', S18: 'SAFE_REFUSAL', S19: 'SAFE_REFUSAL',
  S20: 'SAFE_REFUSAL', S21: 'SAFE_REFUSAL'
};
let matrix;
test.before(async () => {
  matrix = await runMatrix({ repo: ROOT });
  if (process.env.R48_OUT) { fs.mkdirSync(process.env.R48_OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.R48_OUT, 'interop-matrix.json'), JSON.stringify(matrix, null, 2)); }
});

test('matrix ran against the exact frozen sources and every row executed', () => {
  assert.equal(matrix.sources.r45.sha, '0b95251133d47fd7c0b9280d3ddb5287c2628307');
  assert.equal(matrix.sources.r46.sha, 'a1a258a41c2041ab8d6cebc622cfed0c690c3387');
  assert.deepEqual(matrix.rows.map(r => r.id).sort(), Object.keys(EXPECTED).sort(), 'no row silently skipped or added');
  assert.ok(matrix.rows.every(r => r.method === 'executed'));
  assert.equal(matrix.real_agent_launches, 0);
  assert.equal(matrix.test_broker.private_key_exported, false); assert.equal(matrix.test_broker.live_capable, false);
});
for (const [id, verdict] of Object.entries(EXPECTED)) test(`${id} → ${verdict}`, () => {
  const r = matrix.rows.find(x => x.id === id);
  assert.ok(r, id + ' missing');
  assert.equal(r.verdict, verdict, JSON.stringify(r));
  if (verdict === 'INCOMPATIBLE' || verdict === 'UNSAFE_ACCEPTED') assert.ok(r.delta && r.delta.length > 40, id + ' must carry a minimal delta proposal');
});
test('specific facts behind the key rows', () => {
  const r = id => matrix.rows.find(x => x.id === id).actual;
  assert.equal(r('C03').bridge, 'BLOCKED_TRUSTED_SIGNATURE_BROKER');
  assert.deepEqual([r('C07').r45_level, r('C07').r46], ['E3_FAKE_CLI', 'RUNNER_OUTCOME_INVALID']);
  assert.ok(r('C07').r45_process_keys.includes('exit_code') && !r('C07').r45_process_keys.includes('exit'));
  assert.deepEqual([r('C08').state, r('C08').exit_code, r('C08').actual_agent_launches], ['SUCCESS', 0, 0]);
  assert.equal(r('C10').r46, 'BLOCKED/FAKE_RUNNER_REQUIRED');
  assert.equal(r('C13').r46_pinned_source, 'ab3e07979f67924e795426737e26c5c4d84b8501');
  assert.equal(r('S01').r45, 'AUTHORIZED'); assert.equal(matrix.rows.find(x => x.id === 'S01').severity, 'P1_CANDIDATE_BLOCKS_GO');
  assert.equal(r('S10').launches, 1); assert.equal(r('S10').states.filter(s => s === 'SUCCESS').length, 1);
  assert.equal(r('S17').r46_runner_calls, 0);
  assert.equal(r('C11-nocost').cost, null, 'unknown cost stays null across the seam');
});
test('GO/NO_GO on the real matrix is NO_GO with the gate, protocol, credential and enablement blockers named', () => {
  const g = evaluate({ matrix, preflight: { clis: { claude: { status: 'VERIFIED', version: 'x' } }, credentials: { claude: { status: 'NOT_CONFIGURED' } }, runner: { ephemeral_github_hosted: true } } });
  assert.equal(g.decision, 'NO_GO'); assert.equal(g.real_agent_launches, 0);
  for (const id of ['G01', 'G02', 'G03', 'G04', 'G05', 'G07', 'G09', 'G10', 'G11']) assert.ok(g.blocking.some(b => b.startsWith(id + ':')), id);
  assert.ok(['G12', 'G14', 'G15', 'G16'].every(id => g.items.find(i => i.id === id).status === 'SATISFIED'), 'mechanisms proven in fake runs are recognised');
  if (process.env.R48_OUT) fs.writeFileSync(path.join(process.env.R48_OUT, 'gonogo.json'), JSON.stringify(g, null, 2));
});
test('GO needs every item: a clean matrix plus every external fact; any single gap stays NO_GO', () => {
  const clean = { rows: Object.keys(EXPECTED).filter(id => id.startsWith('S')).map(id => ({ id, verdict: 'SAFE_REFUSAL' })) };
  const pre = { clis: { claude: { status: 'VERIFIED', version: '2.1.318 (Claude Code)' } }, credentials: { claude: { status: 'PRESENT_UNVERIFIED' } }, runner: { ephemeral_github_hosted: true } };
  const facts = { r47_audit: 'ACCEPT', r47_qa: 'PASS', final_candidate_sha: 'f'.repeat(40), final_candidate_audit: 'ACCEPT', final_candidate_qa: 'PASS', broker_key_configured: true, secrets_scoped_to_protected_environment: true, default_branch_workflows: true, remote_cas_verified: true, operator_kill_switch_runbook: true };
  assert.equal(evaluate({ matrix: clean, preflight: pre, facts }).decision, 'GO');
  for (const k of Object.keys(facts)) assert.equal(evaluate({ matrix: clean, preflight: pre, facts: { ...facts, [k]: k.endsWith('_sha') ? null : k.includes('audit') || k.includes('qa') ? 'NOT_RUN' : false } }).decision, 'NO_GO', k);
  assert.equal(evaluate({ matrix: { rows: [...clean.rows.filter(r => r.id !== 'S01'), { id: 'S01', verdict: 'UNSAFE_ACCEPTED' }] }, preflight: pre, facts }).decision, 'NO_GO');
  assert.equal(evaluate({ matrix: clean, preflight: { ...pre, credentials: { claude: { status: 'NOT_CONFIGURED' } } }, facts }).decision, 'NO_GO');
});
