'use strict';
// Regression tests for the R57 independent CodeAudit findings (#2, comment 6730469454):
//   AUD-R57-01 (P1) CI gate accepted an older success / a failing same-name job.
//   AUD-R57-02 (P2) a durable HALT written while reviews are collected was ignored by the final DONE.
//   AUD-R55-01 (P2) role_id "__proto__" polluted Object.prototype in the workbench projector.
// Every counterexample from the audit report is reproduced here; normal matrices must still pass.
// E2 + E3_FAKE only: no real model, no Secrets, no github.com.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const Facts = require('../../tools/event-handoff-r56/facts');
const C = require('../../tools/auto-handoff-r46/contract');

/* ---------------- AUD-R57-01: pure CI gate ---------------- */
const WF = 'r57-candidate-ci';
const pipeline = { ci: { workflows: [WF], required_jobs: ['tests', 'browser'] } };
const ok = [{ name: 'tests', status: 'completed', conclusion: 'success' }, { name: 'browser', status: 'completed', conclusion: 'success' }];
const run = (id, over = {}) => ({ id, run_attempt: 1, workflow_id: 99, name: WF, html_url: 'run/' + id + '/' + (over.run_attempt || 1), status: 'completed', conclusion: 'success', jobs_complete: true, jobs: ok, ...over });
const gate = runs => Facts.ciGate(runs, pipeline);

test('AUD-R57-01: a single successful run with all required jobs is green', () => {
  assert.equal(gate([run(7)]).green, 'run/7/1');
});
for (const [label, newer] of [
  ['failure', { conclusion: 'failure' }], ['cancelled', { conclusion: 'cancelled' }],
  ['in_progress', { status: 'in_progress', conclusion: null }], ['queued', { status: 'queued', conclusion: null }]
]) test('AUD-R57-01: older success + newer ' + label + ' run on the same SHA blocks', () => {
  const r = gate([run(7), run(8, { ...newer, jobs: [] })]);
  assert.equal(r.green, null); assert.equal(r.failed, true); assert.match(r.problem, /^CI_LATEST_RUN_/);
});
test('AUD-R57-01: same run, attempt 2 failure after attempt 1 success blocks', () => {
  const r = gate([run(7), run(7, { run_attempt: 2, conclusion: 'failure', jobs: [] })]);
  assert.equal(r.green, null); assert.equal(r.problem, 'CI_LATEST_RUN_FAILURE');
});
test('AUD-R57-01: newer success after an older failure is green (re-run fixed it)', () => {
  assert.equal(gate([run(7, { conclusion: 'failure', jobs: [] }), run(8)]).green, 'run/8/1');
  assert.equal(gate([run(7, { conclusion: 'failure', jobs: [] }), run(7, { run_attempt: 2 })]).green, 'run/7/2');
});
for (const conclusion of ['failure', 'skipped', 'cancelled', null]) test('AUD-R57-01: extra same-name required job with conclusion ' + conclusion + ' blocks', () => {
  const r = gate([run(7, { jobs: [...ok, { name: 'tests', status: conclusion === null ? 'in_progress' : 'completed', conclusion }] })]);
  assert.equal(r.green, null); assert.equal(r.problem, 'CI_REQUIRED_JOB_NOT_SUCCESS');
});
test('AUD-R57-01: a normal matrix of same-name jobs that all succeed still passes', () => {
  assert.equal(gate([run(7, { jobs: [...ok, { name: 'tests', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'success' }] })]).green, 'run/7/1');
});
test('AUD-R57-01: incomplete job page, missing required job, missing workflow, ambiguous order all block', () => {
  assert.equal(gate([run(7, { jobs_complete: false })]).problem, 'CI_JOBS_INCOMPLETE');
  assert.equal(gate([run(7, { jobs: [ok[0]] })]).problem, 'CI_REQUIRED_JOB_MISSING');
  assert.equal(gate([run(7, { id: 'x' })]).problem, 'CI_UNKNOWN_ORDER');
  assert.equal(gate([run(7), run(7)]).problem, 'CI_DUPLICATE_RUN_ATTEMPT');
  assert.equal(gate([run(7), run(8, { workflow_id: 100 })]).problem, 'CI_WORKFLOW_IDENTITY_AMBIGUOUS');
  assert.equal(Facts.ciGate([run(7)], { ci: { workflows: [WF, 'other'], required_jobs: ['tests'] } }).problem, 'CI_REQUIRED_WORKFLOW_MISSING');
  assert.equal(Facts.ciGate([run(7)], { ci: { workflows: [WF], required_jobs: [] } }).problem, 'CI_POLICY_EMPTY');
  assert.deepEqual(gate([]), { runs: 0, green: null, failed: false });
});

/* ---------------- AUD-R57-01: full joint R56 -> R57 path (audit counterexample 3) ---------------- */
test('AUD-R57-01 E3: success CI7001 then failure CI7002 on the same SHA launches 0 Fake processes', async t => {
  const { fixture } = require('../unattended-go-r57/helpers.cjs');
  const W = require('../event-handoff-r56/world.cjs');
  const Adapter = require('../../tools/unattended-go-r57/r56-adapter');
  const f = await fixture(t, { durable: true, ticketPrefix: 'r56' }), f0 = f.stages[0].f, keys = W.reviewerKeys(), pl = W.pipeline(f0, keys), item = pl.work_items[0];
  const em = await W.emulator(t, path.join(f.dir, 'r56-github.sqlite'));
  await W.seedCandidate(em, f0, item);
  await W.seedCi(em, f0, item, { id: 7001 });
  await W.seedCi(em, f0, item, { id: 7002, conclusion: 'failure' });
  await W.seedReviews(em, f0, item, keys, Date.now());
  for (const s of f.stages) {
    s.collectionPolicy.r56_pipeline_digest = C.digest({ pipeline: pl, item });
    s.f.authorization.manifest.r57_collection_policy_digest = C.digest(s.collectionPolicy);
    for (const [role, pair] of Object.entries(s.f.pairs)) { const p = s.f.authorization.proofs[role]; p.payload.manifest_digest = C.digest(s.f.authorization.manifest); p.signature = crypto.sign(null, Buffer.from(C.canonical(p.payload)), pair.privateKey).toString('base64'); }
  }
  const find = key => f.stages.find(s => s.f.envelope.idempotency_key === key);
  const r = await Adapter.step({ mode: 'fake', pipeline: pl, item, trigger: W.tickTrigger(), readSnapshot: () => em.client.snapshot(pl, item, Date.now()), readLedger: () => f.backend.read(),
    provision: async ticket => find(ticket.idempotency_key), lookupCompleted: async key => find(key), report: (issue, body) => em.client.report(issue, body), now: Date.now() });
  assert.notEqual(r.state, 'STAGE_SUCCEEDED', JSON.stringify(r));
  assert.equal(r.state, 'WAIT_CI'); assert.equal(r.decision?.ci_problem ?? r.ci_problem, 'CI_LATEST_RUN_FAILURE');
  assert.equal(f.launches(), 0);
});

/* ---------------- AUD-R57-02: HALT during review collection ---------------- */
async function persistHalt(backend) {
  const { Ledger } = require('../../tools/auto-handoff-r46/state');
  const cfg = { clock_skew_ms: 60000, max_tasks: 256, max_audit: 4096 };
  await new Ledger(backend, cfg).change(Date.now(), d => { d.halted = true; return { state: 'HALTED' }; });
}
test('AUD-R57-02: durable HALT written inside readReviews turns DONE into BLOCKED/next_allowed=false', async t => {
  const { fixture, signReviews } = require('../unattended-go-r57/helpers.cjs');
  const Control = require('../../tools/unattended-go-r57/control');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = async c => { await persistHalt(f.backend); return signReviews(s.f, c); };
  const r = await Control.runOnce(s);
  assert.equal(r.state, 'BLOCKED', JSON.stringify(r)); assert.equal(r.reason, 'PERSISTENT_HALT'); assert.equal(r.next_allowed, false);
  assert.equal(f.launches(), 1, 'the pre-HALT Fake is the only launch');
  assert.equal((await f.backend.read()).document.halted, true, 'HALT is preserved');
});
test('AUD-R57-02: collectCompleted rechecks HALT after the review read as well', async t => {
  const { fixture, signReviews } = require('../unattended-go-r57/helpers.cjs');
  const Control = require('../../tools/unattended-go-r57/control');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = c => signReviews(s.f, c);
  assert.equal((await Control.runOnce(s)).state, 'DONE');
  s.readReviews = async c => { await persistHalt(f.backend); return signReviews(s.f, c); };
  const r = await Control.collectCompleted({ ...s, mode: 'fake' });
  assert.equal(r.state, 'BLOCKED', JSON.stringify(r)); assert.equal(r.next_allowed, false);
  assert.equal(f.launches(), 1);
});
test('AUD-R57-02: without HALT the normal DONE path is unchanged', async t => {
  const { fixture, signReviews } = require('../unattended-go-r57/helpers.cjs');
  const Control = require('../../tools/unattended-go-r57/control');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = c => signReviews(s.f, c);
  const r = await Control.runOnce(s);
  assert.equal(r.state, 'DONE', JSON.stringify(r)); assert.equal(r.next_allowed, true);
});

/* ---------------- AUD-R55-01: projector prototype pollution ---------------- */
test('AUD-R55-01: role_id "__proto__" / "constructor" / "toString" never touch Object.prototype', () => {
  const Cn = require('../../public/haloflux-workbench-r52/contract.js');
  const P = require('../../public/haloflux-workbench-r52/projector.js');
  for (const role_id of ['__proto__', 'constructor', 'toString', 'normal-role']) {
    const p = P.createProjector ? P.createProjector() : P.create();
    p.ingest([{ schema: Cn.EVENT_SCHEMA, event_id: 'audit-1', work_id: 'audit', seq: 1, type: 'agent_started', role_id, at: Date.now(), evidence: 'FIXTURE', source: 'AUDITOR_LOCAL_JSON' }]);
    const st = p.state();
    assert.equal(({}).state, undefined, 'Object.prototype.state must stay undefined for ' + role_id);
    assert.equal(({}).since_event_id, undefined);
    assert.equal(Object.values(st.roles).length, 1, role_id);
    assert.equal(Object.values(st.roles)[0].role_id, role_id);
  }
});
