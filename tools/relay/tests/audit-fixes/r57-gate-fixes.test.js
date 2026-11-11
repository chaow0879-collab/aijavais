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
const Facts = require('../../event-handoff-r56/facts');
const C = require('../../auto-handoff-r46/contract');

/* ---------------- AUD-R57-01: pure CI gate ---------------- */
const WF = 'r57-candidate-ci';
const pipeline = { ci: { workflows: [WF], required_jobs: ['tests', 'browser'] } };
const ok = [{ name: 'tests', status: 'completed', conclusion: 'success' }, { name: 'browser', status: 'completed', conclusion: 'success' }];
const run = (id, over = {}) => ({ id, run_attempt: 1, workflow_id: 99, name: WF, html_url: 'run/' + id + '/' + (over.run_attempt || 1), status: 'completed', conclusion: 'success', jobs_complete: true, jobs: ok, ...over });
const gate = runs => Facts.ciGate(runs, pipeline, true);

test('AUD-R57-01: a single successful run with all required jobs is green', () => {
  assert.equal(gate([run(7)]).green, 'run/7/1');
});
for (const [label, newer] of [
  ['failure', { conclusion: 'failure' }], ['cancelled', { conclusion: 'cancelled' }],
  ['in_progress', { status: 'in_progress', conclusion: null }], ['queued', { status: 'queued', conclusion: null }]
]) test('AUD-R57-01: older success + newer ' + label + ' run on the same SHA blocks', () => {
  const r = gate([run(7), run(8, { ...newer, jobs: [] })]);
  assert.equal(r.green, null); assert.equal(r.failed, true); assert.match(r.problem, /^CI_RUN_/);
});
test('AUD-R57-01: same run, attempt 2 failure after attempt 1 success blocks', () => {
  const r = gate([run(7), run(7, { run_attempt: 2, conclusion: 'failure', jobs: [] })]);
  assert.equal(r.green, null); assert.equal(r.problem, 'CI_RUN_FAILURE');
});
test('AUD-R57-01: a failed run that was re-run to success is green; a different newer success does not hide it', () => {
  assert.equal(gate([run(7, { conclusion: 'failure', jobs: [] }), run(7, { run_attempt: 2 })]).green, 'run/7/2');
  assert.equal(gate([run(7, { conclusion: 'failure', jobs: [] }), run(8)]).problem, 'CI_RUN_FAILURE');
});
/* AUD-BC72-01 (P1): re-running an OLDER run must not be masked by a newer run id that succeeded. */
for (const [label, older] of [['failure', { conclusion: 'failure' }], ['in_progress', { status: 'in_progress', conclusion: null }]])
  test('AUD-BC72-01: older run re-attempt ' + label + ' + newer success blocks', () => {
    const r = gate([run(10, { run_attempt: 2, ...older, jobs: [] }), run(11)]);
    assert.equal(r.green, null); assert.match(r.problem, /^CI_RUN_/);
  });
/* AUD-BC72-02/03 (P2): missing fields and truncated run lists are UNKNOWN. */
test('AUD-BC72-02/03: missing jobs_complete, workflow_id, run_attempt or job status, or an incomplete run list block', () => {
  const { jobs_complete, ...noJc } = run(7); assert.equal(gate([noJc]).problem, 'CI_JOBS_INCOMPLETE');
  const { workflow_id, ...noWf } = run(7); assert.equal(gate([noWf]).problem, 'CI_WORKFLOW_IDENTITY_UNKNOWN');
  const { run_attempt, ...noAt } = run(7); assert.equal(gate([noAt]).problem, 'CI_UNKNOWN_ORDER');
  assert.equal(gate([run(7, { jobs: [{ name: 'tests', conclusion: 'success' }, ok[1]] })]).problem, 'CI_REQUIRED_JOB_NOT_SUCCESS');
  assert.equal(Facts.ciGate([run(7)], pipeline, false).problem, 'CI_RUN_LIST_INCOMPLETE');
  // AUD-0EA9-01: a missing completeness flag is UNKNOWN and blocks (no default-to-complete).
  for (const missing of [undefined, null, 'true', 1]) assert.equal(Facts.ciGate([run(7)], pipeline, missing).problem, 'CI_RUN_LIST_INCOMPLETE', 'runs_complete=' + missing + ' must block');
  assert.equal(Facts.ciGate([run(7)], pipeline, true).green, 'run/7/1');
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
  assert.equal(gate([run(7, { run_attempt: 'x' })]).problem, 'CI_UNKNOWN_ORDER');
  assert.equal(Facts.ciGate([run(7)], { ci: { workflows: [WF, 'other'], required_jobs: ['tests'] } }, true).problem, 'CI_REQUIRED_WORKFLOW_MISSING');
  assert.equal(Facts.ciGate([run(7)], { ci: { workflows: [WF], required_jobs: [] } }, true).problem, 'CI_POLICY_EMPTY');
  assert.deepEqual(gate([]), { runs: 0, green: null, failed: false });
});

/* ---------------- full joint R56 -> R57 path (real local HTTP/SQLite GitHub emulator) ---------------- */
async function joint(t, seedRuns) {
  const { fixture } = require('../unattended-go-r57/helpers.cjs');
  const W = require('../event-handoff-r56/world.cjs');
  const Adapter = require('../../unattended-go-r57/r56-adapter');
  const f = await fixture(t, { durable: true, ticketPrefix: 'r56' }), f0 = f.stages[0].f, keys = W.reviewerKeys(), pl = W.pipeline(f0, keys), item = pl.work_items[0];
  const em = await W.emulator(t, path.join(f.dir, 'r56-github.sqlite'));
  await W.seedCandidate(em, f0, item);
  for (const r of seedRuns) await W.seedCi(em, f0, item, r);
  await W.seedReviews(em, f0, item, keys, Date.now());
  for (const s of f.stages) {
    s.collectionPolicy.r56_pipeline_digest = C.digest({ pipeline: pl, item });
    s.f.authorization.manifest.r57_collection_policy_digest = C.digest(s.collectionPolicy);
    for (const [role, pair] of Object.entries(s.f.pairs)) { const p = s.f.authorization.proofs[role]; p.payload.manifest_digest = C.digest(s.f.authorization.manifest); p.signature = crypto.sign(null, Buffer.from(C.canonical(p.payload)), pair.privateKey).toString('base64'); }
  }
  const find = key => f.stages.find(s => s.f.envelope.idempotency_key === key);
  const step = (over = {}) => Adapter.step({ mode: 'fake', pipeline: pl, item, trigger: W.tickTrigger(), readSnapshot: () => em.client.snapshot(pl, item, Date.now()), readLedger: () => f.backend.read(),
    provision: async ticket => find(ticket.idempotency_key), lookupCompleted: async key => find(key), report: (issue, body) => em.client.report(issue, body), now: Date.now(), ...over });
  Object.assign(f, { __em: em, __pl: pl, __item: item });
  return { f, step, find };
}
test('AUD-R57-01 E3: success CI7001 then failure CI7002 on the same SHA launches 0 Fake processes', async t => {
  const { f, step } = await joint(t, [{ id: 7001 }, { id: 7002, conclusion: 'failure' }]);
  const r = await step();
  assert.equal(r.state, 'WAIT_CI', JSON.stringify(r)); assert.equal(r.decision?.ci_problem ?? r.ci_problem, 'CI_RUN_FAILURE');
  assert.equal(f.launches(), 0);
});
for (const [label, older] of [['failure', { conclusion: 'failure' }], ['in_progress', { status: 'in_progress', conclusion: null }]])
  test('AUD-BC72-01 E3: re-run of older CI7001 (attempt 2 ' + label + ') + newer CI7002 success launches 0 Fake processes', async t => {
    const { f, step } = await joint(t, [{ id: 7001, run_attempt: 2, ...older }, { id: 7002 }]);
    const r = await step();
    assert.equal(r.state, 'WAIT_CI', JSON.stringify(r)); assert.equal(f.launches(), 0);
  });
test('AUD-0EA9-01 E3: a snapshot without runs_complete is UNKNOWN: no STAGE_SUCCEEDED, 0 Fake processes', async t => {
  const { f, step } = await joint(t, [{ id: 7001 }]);
  for (const strip of [s => { delete s.runs_complete; }, s => { s.runs_complete = undefined; }, s => { s.runs_complete = 'true'; }]) {
    const r = await step({ readSnapshot: async () => { const s = await f.__em.client.snapshot(f.__pl, f.__item, Date.now()); assert.equal(s.runs_complete, true); strip(s); return s; } });
    assert.notEqual(r.state, 'STAGE_SUCCEEDED', JSON.stringify(r)); assert.notEqual(r.state, 'HANDOFF_COMPLETE', JSON.stringify(r));
  }
  assert.equal(f.launches(), 0);
  assert.equal((await step()).state, 'STAGE_SUCCEEDED', 'control: the same world with an explicit runs_complete=true proceeds');
  assert.equal(f.launches(), 1);
});
test('AUD-BC72-04 E3: durable HALT written during the final completion lookups blocks HANDOFF_COMPLETE', async t => {
  const { f, step, find } = await joint(t, [{ id: 7001 }]);
  for (let i = 0; i < 3; i++) assert.equal((await step()).state, 'STAGE_SUCCEEDED');
  assert.equal(f.launches(), 3);
  let lookups = 0;
  const r = await step({ lookupCompleted: async key => { if (++lookups === 4) await persistHalt(f.backend); return find(key); } });
  assert.notEqual(r.state, 'HANDOFF_COMPLETE', JSON.stringify(r)); assert.equal(r.reason, 'PERSISTENT_HALT');
  assert.equal((await f.backend.read()).document.halted, true); assert.equal(f.launches(), 3);
});

/* ---------------- AUD-R57-02: HALT during review collection ---------------- */
async function persistHalt(backend) {
  const { Ledger } = require('../../auto-handoff-r46/state');
  const cfg = { clock_skew_ms: 60000, max_tasks: 256, max_audit: 4096 };
  await new Ledger(backend, cfg).change(Date.now(), d => { d.halted = true; return { state: 'HALTED' }; });
}
test('AUD-R57-02: durable HALT written inside readReviews turns DONE into BLOCKED/next_allowed=false', async t => {
  const { fixture, signReviews } = require('../unattended-go-r57/helpers.cjs');
  const Control = require('../../unattended-go-r57/control');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = async c => { await persistHalt(f.backend); return signReviews(s.f, c); };
  const r = await Control.runOnce(s);
  assert.equal(r.state, 'BLOCKED', JSON.stringify(r)); assert.equal(r.reason, 'PERSISTENT_HALT'); assert.equal(r.next_allowed, false);
  assert.equal(f.launches(), 1, 'the pre-HALT Fake is the only launch');
  assert.equal((await f.backend.read()).document.halted, true, 'HALT is preserved');
});
test('AUD-R57-02: collectCompleted rechecks HALT after the review read as well', async t => {
  const { fixture, signReviews } = require('../unattended-go-r57/helpers.cjs');
  const Control = require('../../unattended-go-r57/control');
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
  const Control = require('../../unattended-go-r57/control');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = c => signReviews(s.f, c);
  const r = await Control.runOnce(s);
  assert.equal(r.state, 'DONE', JSON.stringify(r)); assert.equal(r.next_allowed, true);
});

/* ---------------- AUD-R55-01: projector prototype pollution ---------------- */
test('AUD-R55-01: role_id "__proto__" / "constructor" / "toString" never touch Object.prototype', () => {
  const Cn = require('../../../../lib/work-contract.js');
  const P = require('../../../../public/haloflux-workbench-r52/projector.js');
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
