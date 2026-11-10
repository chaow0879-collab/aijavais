'use strict';
// Independent-CodeAudit counterexamples for reviewed SHA c7de4a7fa16b190b63317bdc2df81cb6c4c5e77b
// (re-run of the 72 checks of #2 comment 6758654197 with S02 rebased to 26f76f9 + exit/close probes X01-X03).
// Written by the auditor, not copied from the author's tests/audit-fixes. E2/E3_FAKE only:
// no real model, no Secrets, no github.com writes. REVIEWED_ROOT points at a checkout of the reviewed SHA.
// Each test asserts the SAFE expectation; a FAIL is a real finding against the reviewed code.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const R = path.resolve(process.env.REVIEWED_ROOT || process.cwd());
const req = p => require(path.join(R, p));
const OUT = process.env.AUDIT_OUT;
const obs = {};
const note = (k, v) => { obs[k] = v; if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify(obs, null, 2)); } };
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: R, encoding: 'utf8' }).trim();
test('provenance: REVIEWED_ROOT is exactly the reviewed SHA', () => {
  note('reviewed_head', HEAD);
  assert.equal(HEAD, 'c7de4a7fa16b190b63317bdc2df81cb6c4c5e77b');
});

/* ================= (a) AUD-R57-01 ciGate / facts / github.js ================= */
const Facts = req('tools/event-handoff-r56/facts.js');
const WF = 'aud-wf';
const PL = { ci: { workflows: [WF], required_jobs: ['tests', 'browser'] } };
const J = (n, c = 'success', s = 'completed') => ({ name: n, status: s, conclusion: c });
const OK = [J('tests'), J('browser')];
const run = (id, o = {}) => ({ id, run_attempt: 1, run_number: id, workflow_id: 555, name: WF, html_url: 'u/' + id + '/' + (o.run_attempt || 1), status: 'completed', conclusion: 'success', jobs_complete: true, jobs: OK, ...o });
// 85c4f63 removed the default for the 3rd argument: per-run semantics are tested with an explicit complete=true
// (otherwise every negative would pass vacuously on CI_RUN_LIST_INCOMPLETE); completeness itself is N01/N02/N07-N09.
const g = runs => Facts.ciGate(runs, PL, true);
const blocks = (r, label) => { note('ciGate:' + label, r); assert.equal(r.green, null, label + ' must not be green: ' + JSON.stringify(r)); };

test('A01 positive: single success run, all required jobs', () => assert.equal(g([run(10)]).green, 'u/10/1'));
test('A02 positive: normal matrix (3x tests + browser all success) still green', () =>
  assert.equal(g([run(10, { jobs: [J('tests'), J('tests'), J('tests'), J('browser')] })]).green, 'u/10/1'));
for (const [k, o] of [['failure', { conclusion: 'failure' }], ['cancelled', { conclusion: 'cancelled' }], ['in_progress', { status: 'in_progress', conclusion: null }], ['waiting', { status: 'waiting', conclusion: null }], ['timed_out', { conclusion: 'timed_out' }], ['action_required', { conclusion: 'action_required' }]])
  test('A03 newer run ' + k + ' after older success blocks', () => blocks(g([run(10), run(11, { ...o, jobs: [] })]), 'newer_' + k));
test('A04 same run attempt2 failure after attempt1 success blocks', () => blocks(g([run(10), run(10, { run_attempt: 2, conclusion: 'failure', jobs: [] })]), 'attempt2_failure'));
test('A05 same run attempt2 in_progress blocks', () => blocks(g([run(10), run(10, { run_attempt: 2, status: 'in_progress', conclusion: null, jobs: [] })]), 'attempt2_in_progress'));
for (const c of ['failure', 'skipped', 'cancelled', null, 'neutral'])
  test('A06 extra same-name required job conclusion=' + c + ' blocks', () => blocks(g([run(10, { jobs: [...OK, J('tests', c, c === null ? 'in_progress' : 'completed')] })]), 'samename_' + c));
test('A07 required job success but status in_progress blocks', () => blocks(g([run(10, { jobs: [J('tests', 'success', 'in_progress'), J('browser')] })]), 'job_status_in_progress'));
test('A08 incomplete job page (jobs_complete=false) blocks', () => blocks(g([run(10, { jobs_complete: false })]), 'jobs_incomplete'));
test('A09 run_number disagrees with id order: id decides, newest id failure still blocks', () =>
  blocks(g([run(10, { run_number: 99 }), run(11, { run_number: 1, conclusion: 'failure', jobs: [] })]), 'run_number_inverted'));
// ---- new bypass probes (auditor-designed) ----
test('A10 NEW: re-run of an OLDER run (id 10 attempt 2) fails after newer run 11 succeeded -> must block', () =>
  blocks(g([run(10, { run_attempt: 2, conclusion: 'failure', jobs: [] }), run(11)]), 'older_run_rerun_failure'));
test('A11 NEW: re-run of an OLDER run is still in_progress while newer run 11 is success -> must block', () =>
  blocks(g([run(10, { run_attempt: 2, status: 'in_progress', conclusion: null, jobs: [] }), run(11)]), 'older_run_rerun_in_progress'));
test('A12 NEW: jobs_complete field ABSENT must not default to complete', () => {
  const r0 = run(10); delete r0.jobs_complete; blocks(g([r0]), 'jobs_complete_absent');
});
test('A13 NEW: workflow_id missing on one run must not disable identity check', () =>
  blocks(g([run(10), run(11, { workflow_id: undefined })]), 'workflow_id_missing'));
test('A14 workflow_id differs (same display name, different workflow file) blocks', () => blocks(g([run(10), run(11, { workflow_id: 777 })]), 'workflow_id_ambiguous'));
test('A15 run_attempt null/0/string blocks as unknown order', () => {
  for (const v of [null, 0, '2']) blocks(g([run(10, { run_attempt: v })]), 'attempt_' + String(v));
});
// facts.read pre-filter: does a newer FAILED run with an event outside policy.events stay invisible?
test('A16 observation: facts pre-filter drops runs whose event is not in pipeline.ci.events', () => {
  const ci = [run(10, { event: 'push' }), run(11, { event: 'schedule', conclusion: 'failure', jobs: [] })];
  const visible = ci.filter(r => ['push', 'workflow_dispatch'].includes(r.event));
  note('event_filter_visible', visible.map(r => r.id));
  assert.equal(visible.length, 1); // documents behaviour only; scope-limited by workflow triggers
});
// github.js: the run LIST page has no completeness check (total_count ignored, hard per_page=50, slice(0,50)).
test('A17 NEW: run-list pagination incomplete (51 runs, newest failure beyond page) must not be green', async () => {
  const { GitHubFacts } = req('tools/event-handoff-r56/github.js');
  const C = req('tools/auto-handoff-r46/contract.js');
  const sha = 'c'.repeat(40), br = 'integrate/aud-probe';
  const mk = (id, conclusion) => ({ id, run_attempt: 1, workflow_id: 555, name: WF, html_url: 'u/' + id, head_sha: sha, head_branch: br, event: 'push', status: 'completed', conclusion, head_repository: { full_name: C.REPO, fork: false } });
  const list = []; for (let i = 1; i <= 50; i++) list.push(mk(i, 'success')); list.push(mk(51, 'failure'));
  const transport = async (m, route) => {
    if (route.includes('/git/ref/heads/')) return { status: 200, data: { object: { sha } } };
    if (route.includes('/comments?')) return { status: 200, data: [] };
    if (/\/actions\/runs\?/.test(route)) return { status: 200, data: { total_count: list.length, workflow_runs: list } };
    if (/\/jobs$/.test(route)) return { status: 200, data: { total_count: 2, jobs: OK } };
    return { status: 404 };
  };
  const snap = await new GitHubFacts(transport, { repo: C.REPO }).snapshot({ review_issues: { audit: 2, qa: 4 }, repo: C.REPO }, { branch: br, issue: 40 }, Date.now());
  const r = Facts.ciGate(snap.runs, PL, snap.runs_complete); // same 3rd argument facts.read() passes
  note('runlist_truncation', { listed_total_count: list.length, captured: snap.runs.length, runs_complete: snap.runs_complete, max_captured_id: Math.max(...snap.runs.map(x => x.id)), gate: r });
  assert.equal(r.green, null, 'incomplete run list (total_count 51 > captured ' + snap.runs.length + ') treated as complete: ' + JSON.stringify(r));
});

// ---- new probes on the 0ea9067 fix (auditor-designed) ----
test('N01 NEW: run-list completeness UNKNOWN (3rd arg omitted/undefined, i.e. snapshot without runs_complete) must not be green', () => {
  const r1 = Facts.ciGate([run(10)], PL), r2 = Facts.ciGate([run(10)], PL, undefined);
  note('N01', { omitted: r1, undefined: r2 });
  assert.equal(r2.green, null, 'missing runs_complete treated as complete: ' + JSON.stringify(r2));
});
test('N02 runs_complete truthy but not true ("true", 1, {}) blocks', () => {
  for (const v of ['true', 1, {}]) blocks(Facts.ciGate([run(10)], PL, v), 'runs_complete_' + JSON.stringify(v));
});
test('N03 stricter semantics: older failed run NEVER re-run + newer success blocks', () => blocks(g([run(10, { conclusion: 'failure', jobs: [] }), run(11)]), 'older_failure_not_rerun'));
test('N04 positive: failed run re-run to success (same id, attempt 2) + newer success is green', () =>
  assert.equal(g([run(10, { run_attempt: 2 }), run(11)]).green, 'u/11/1'));
test('N05 observation (liveness, fail-closed): branch with >50 lifetime runs (other SHAs) never yields complete run list', async () => {
  const { GitHubFacts } = req('tools/event-handoff-r56/github.js');
  const C = req('tools/auto-handoff-r46/contract.js');
  const sha = 'd'.repeat(40), br = 'integrate/aud-probe';
  const mk = (id, s) => ({ id, run_attempt: 1, workflow_id: 555, name: WF, html_url: 'u/' + id, head_sha: s, head_branch: br, event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: C.REPO, fork: false } });
  const all = []; for (let i = 1; i <= 50; i++) all.push(mk(i, 'e'.repeat(40))); all.push(mk(51, sha));
  const transport = async (m, route) => {
    if (route.includes('/git/ref/heads/')) return { status: 200, data: { object: { sha } } };
    if (route.includes('/comments?')) return { status: 200, data: [] };
    if (/\/actions\/runs\?/.test(route)) return { status: 200, data: { total_count: all.length, workflow_runs: all.slice().reverse().slice(0, 50) } }; // GitHub: newest first, 50 per page
    if (/\/jobs$/.test(route)) return { status: 200, data: { total_count: 2, jobs: OK } };
    return { status: 404 };
  };
  const snap = await new GitHubFacts(transport, { repo: C.REPO }).snapshot({ review_issues: { audit: 2, qa: 4 }, repo: C.REPO }, { branch: br, issue: 40 }, Date.now());
  const cand = snap.runs.filter(r => r.head_sha === sha);
  const r = Facts.ciGate(cand, PL, snap.runs_complete);
  note('N05_liveness', { branch_total_runs: all.length, candidate_runs_captured: cand.length, runs_complete: snap.runs_complete, gate: r });
  assert.equal(r.green, null); // fail-closed; recorded as availability observation, not a bypass
});

/* ---- (a) joint R56 -> R57 path through the real local HTTP/SQLite emulator ---- */
async function world(t, seed) {
  const { fixture, C } = req('tests/unattended-go-r57/helpers.cjs');
  const W = req('tests/event-handoff-r56/world.cjs');
  const Adapter = req('tools/unattended-go-r57/r56-adapter.js');
  const f = await fixture(t, { durable: true, ticketPrefix: 'r56' }), f0 = f.stages[0].f, keys = W.reviewerKeys(), pipeline = W.pipeline(f0, keys), item = pipeline.work_items[0];
  const em = await W.emulator(t, path.join(f.dir, 'aud-github.sqlite'));
  await W.seedCandidate(em, f0, item);
  const ciDoc = (id, o = {}) => ({ id, run_attempt: 1, workflow_id: 9001, name: 'r57-candidate-ci', html_url: 'https://github.com/' + C.REPO + '/actions/runs/' + id, head_sha: f0.candidate_sha, head_branch: item.branch, event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: C.REPO, fork: false }, jobs: [J('tests'), J('browser')], ...o });
  await seed(em, ciDoc);
  await W.seedReviews(em, f0, item, keys, Date.now());
  for (const s of f.stages) {
    s.collectionPolicy.r56_pipeline_digest = C.digest({ pipeline, item });
    s.f.authorization.manifest.r57_collection_policy_digest = C.digest(s.collectionPolicy);
    for (const [role, pair] of Object.entries(s.f.pairs)) { const p = s.f.authorization.proofs[role]; p.payload.manifest_digest = C.digest(s.f.authorization.manifest); p.signature = crypto.sign(null, Buffer.from(C.canonical(p.payload)), pair.privateKey).toString('base64'); }
  }
  const find = key => f.stages.find(s => s.f.envelope.idempotency_key === key);
  const step = (trigger, over = {}) => Adapter.step({ mode: 'fake', pipeline, item, trigger, readSnapshot: () => em.client.snapshot(pipeline, item, Date.now()), readLedger: () => f.backend.read(),
    provision: async ticket => find(ticket.idempotency_key), lookupCompleted: async key => find(key), report: (issue, body) => em.client.report(issue, body), now: Date.now(), ...over });
  return { ...f, em, step, W, ciDoc, pipeline, item };
}
const joint = [
  ['B01 success 7001 then FAILURE 7002', async (em, d) => { await em.run(d(7001)); await em.run(d(7002, { conclusion: 'failure', jobs: [J('tests', 'failure'), J('browser', 'failure')] })); }, 0],
  ['B02 success 7001 then CANCELLED 7002', async (em, d) => { await em.run(d(7001)); await em.run(d(7002, { conclusion: 'cancelled', jobs: [] })); }, 0],
  ['B03 success 7001 then IN_PROGRESS 7002', async (em, d) => { await em.run(d(7001)); await em.run(d(7002, { status: 'in_progress', conclusion: null, jobs: [] })); }, 0],
  ['B04 same run 7001 attempt2 failure (replaces attempt1)', async (em, d) => { await em.run(d(7001, { run_attempt: 2, conclusion: 'failure', jobs: [] })); }, 0],
  ['B05 same-name required job failure inside success run', async (em, d) => { await em.run(d(7001, { jobs: [J('tests'), J('browser'), J('tests', 'failure')] })); }, 0],
  ['B06 NEW older run 7001 re-run attempt2 FAILURE after newer 7002 success', async (em, d) => { await em.run(d(7001, { run_attempt: 2, conclusion: 'failure', jobs: [] })); await em.run(d(7002)); }, 0],
  ['B07 NEW older run 7001 re-run attempt2 IN_PROGRESS after newer 7002 success', async (em, d) => { await em.run(d(7001, { run_attempt: 2, status: 'in_progress', conclusion: null, jobs: [] })); await em.run(d(7002)); }, 0],
  ['B08 positive: normal matrix success (tests x2 + browser)', async (em, d) => { await em.run(d(7001, { jobs: [J('tests'), J('tests'), J('browser')] })); }, 1],
];
for (const [label, seed, expected] of joint) test('joint E3 ' + label + ' -> Fake launches ' + expected, async t => {
  const w = await world(t, seed);
  const r = await w.step(w.W.eventTrigger(w.stages[0].f, w.stages[0].x.store));
  note('joint:' + label, { state: r.state, reason: r.reason, ci_problem: r.decision?.ci_problem ?? r.ci_problem ?? null, fake_launches: w.launches() });
  assert.equal(w.launches(), expected, label + ' -> ' + r.state + ' ' + (r.reason || ''));
  if (expected === 0) assert.notEqual(r.state, 'STAGE_SUCCEEDED');
  else assert.equal(r.state, 'STAGE_SUCCEEDED');
});

async function seed51(em, d) { for (let i = 1; i <= 50; i++) await em.run(d(7000 + i)); await em.run(d(7051, { conclusion: 'failure', jobs: [] })); }
test('N06 control: 51 runs on branch (emulator returns all, client keeps 50) -> runs_complete=false -> WAIT_CI, 0 Fake', async t => {
  const w = await world(t, seed51);
  const r = await w.step(w.W.eventTrigger(w.stages[0].f, w.stages[0].x.store));
  note('N06', { state: r.state, ci_problem: r.decision?.ci_problem ?? r.ci_problem ?? null, fake_launches: w.launches() });
  assert.equal(w.launches(), 0); assert.notEqual(r.state, 'STAGE_SUCCEEDED');
});
test('N07 NEW joint: same 51 runs, readSnapshot omits runs_complete (field missing) -> must stay 0 Fake', async t => {
  const w = await world(t, seed51);
  const r = await w.step(w.W.eventTrigger(w.stages[0].f, w.stages[0].x.store), { readSnapshot: async () => { const sn = await w.em.client.snapshot(w.pipeline, w.item, Date.now()); delete sn.runs_complete; return sn; } });
  note('N07', { state: r.state, ci_problem: r.decision?.ci_problem ?? r.ci_problem ?? null, fake_launches: w.launches() });
  assert.equal(w.launches(), 0, 'missing runs_complete + truncated list (failure 7051 dropped) launched ' + w.launches() + ' Fake -> ' + r.state);
});

test('N08 NEW joint: snapshot runs_complete null / 1 / {} / false -> 0 Fake, never STAGE_SUCCEEDED; control true proceeds', async t => {
  const w = await world(t, async (em, d) => { await em.run(d(7001)); });
  const ev = w.W.eventTrigger(w.stages[0].f, w.stages[0].x.store), res = {};
  for (const v of [null, 1, {}, false]) {
    const r = await w.step(ev, { readSnapshot: async () => { const sn = await w.em.client.snapshot(w.pipeline, w.item, Date.now()); sn.runs_complete = v; return sn; } });
    res[JSON.stringify(v)] = { state: r.state, reason: r.reason || r.decision?.reason || null };
    assert.notEqual(r.state, 'STAGE_SUCCEEDED', JSON.stringify(v));
  }
  res.launches_before_control = w.launches();
  assert.equal(w.launches(), 0);
  const ok = await w.step(ev); res.control = ok.state; res.launches_after_control = w.launches();
  note('N08', res);
  assert.equal(ok.state, 'STAGE_SUCCEEDED'); assert.equal(w.launches(), 1);
});
test('N09 read(): snapshot without runs_complete is rejected as UNKNOWN source (check), not a CI fact', () => {
  let err = null; try { Facts.read({ complete: true, checked_at: Date.now(), repository: {}, issues: {}, runs: [], refs: {} }, { max_snapshot_age_ms: 60000, repo: 'x', repository_id: 1, ci: PL.ci }, { branch: 'integrate/x', issue: 1 }, Date.now()); } catch (e) { err = e.code || e.message; }
  note('N09', err); assert.match(String(err), /UNKNOWN_INCOMPLETE_OR_STALE_SOURCE/);
});

/* ================= (b) AUD-R57-02 read-then-await ================= */
async function persistHalt(backend) {
  const { Ledger } = req('tools/auto-handoff-r46/state.js');
  await new Ledger(backend, { clock_skew_ms: 60000, max_tasks: 256, max_audit: 4096 }).change(Date.now(), d => { d.halted = true; return { state: 'HALTED' }; });
}
test('C01 runOnce: HALT written inside readReviews -> not DONE, next_allowed!==true, launches=1', async t => {
  const { fixture, signReviews } = req('tests/unattended-go-r57/helpers.cjs');
  const Control = req('tools/unattended-go-r57/control.js');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = async c => { await persistHalt(f.backend); return signReviews(s.f, c); };
  const r = await Control.runOnce(s);
  note('C01', { state: r.state, reason: r.reason, next_allowed: r.next_allowed, launches: f.launches(), halted: (await f.backend.read()).document.halted });
  assert.notEqual(r.state, 'DONE'); assert.notEqual(r.next_allowed, true); assert.equal(f.launches(), 1);
});
test('C02 collectCompleted: HALT inside readReviews -> not DONE', async t => {
  const { fixture, signReviews } = req('tests/unattended-go-r57/helpers.cjs');
  const Control = req('tools/unattended-go-r57/control.js');
  const f = await fixture(t, { count: 1 }), s = f.stages[0];
  s.readReviews = c => signReviews(s.f, c);
  assert.equal((await Control.runOnce(s)).state, 'DONE');
  s.readReviews = async c => { await persistHalt(f.backend); return signReviews(s.f, c); };
  const r = await Control.collectCompleted({ ...s, mode: 'fake' });
  note('C02', { state: r.state, reason: r.reason, next_allowed: r.next_allowed });
  assert.notEqual(r.state, 'DONE'); assert.notEqual(r.next_allowed, true);
});
test('C03 runOnce: HALT inside readGitHub (receipt collection) -> not DONE', async t => {
  const { fixture, signReviews } = req('tests/unattended-go-r57/helpers.cjs');
  const Control = req('tools/unattended-go-r57/control.js');
  const f = await fixture(t, { count: 1 }), s = f.stages[0], orig = s.readGitHub;
  let done = false; s.readGitHub = async (m, r) => { if (!done && f.launches() === 1) { done = true; await persistHalt(f.backend); } return orig(m, r); };
  s.readReviews = c => signReviews(s.f, c);
  const r = await Control.runOnce(s);
  note('C03', { state: r.state, reason: r.reason, next_allowed: r.next_allowed });
  assert.notEqual(r.state, 'DONE'); assert.notEqual(r.next_allowed, true);
});
test('C04 NEW parentGate: HALT written while stage-2 reads PARENT reviews -> stage 2 must not launch', async t => {
  const { fixture, signReviews } = req('tests/unattended-go-r57/helpers.cjs');
  const Control = req('tools/unattended-go-r57/control.js');
  const f = await fixture(t, { count: 2 });
  f.stages[0].readReviews = c => signReviews(f.stages[0].f, c);
  let injected = false;
  f.stages[1].readReviews = async c => { if (!injected && c.receipt.task_id === f.stages[0].f.envelope.task_id) { injected = true; await persistHalt(f.backend); } return c.receipt.task_id === f.stages[0].f.envelope.task_id ? signReviews(f.stages[0].f, c) : signReviews(f.stages[1].f, c); };
  const r = await Control.runChain({ mode: 'fake', stages: f.stages });
  note('C04', { state: r.state, reason: r.reason, stage_states: (r.stages || []).map(x => x.state + ':' + x.reason), injected, launches: f.launches() });
  assert.equal(injected, true, 'parent review read occurred');
  assert.equal(f.launches(), 1, 'no Fake after durable HALT');
  assert.notEqual(r.state, 'DONE');
});
test('C05 NEW r56-adapter: HALT after last collectCompleted (during final lookup/currentGate) -> must not report HANDOFF_COMPLETE', async t => {
  const w = await world(t, async (em, d) => { await em.run(d(7001)); });
  const ev = w.W.eventTrigger(w.stages[0].f, w.stages[0].x.store);
  const results = [await w.step(ev), await w.step(w.W.tickTrigger()), await w.step(w.W.tickTrigger())];
  assert.ok(results.every(r => r.state === 'STAGE_SUCCEEDED'), JSON.stringify(results.map(r => r.state + ':' + r.reason)));
  const find = key => w.stages.find(s => s.f.envelope.idempotency_key === key);
  let calls = 0, injected = false;
  const end = await w.step(w.W.tickTrigger(), { lookupCompleted: async key => { calls++; if (calls === 4) { injected = true; await persistHalt(w.backend); } return find(key); } });
  note('C05', { state: end.state, reason: end.reason, lookup_calls: calls, injected, halted: (await w.backend.read()).document.halted, launches: w.launches() });
  assert.equal(injected, true);
  assert.notEqual(end.state, 'HANDOFF_COMPLETE', 'final success reported although ledger is durably HALTED');
});

test('N-C06 NEW r56-adapter: HALT written inside the FINAL currentGate snapshot read -> must not report HANDOFF_COMPLETE', async t => {
  const w = await world(t, async (em, d) => { await em.run(d(7001)); });
  const ev = w.W.eventTrigger(w.stages[0].f, w.stages[0].x.store);
  const results = [await w.step(ev), await w.step(w.W.tickTrigger()), await w.step(w.W.tickTrigger())];
  assert.ok(results.every(r => r.state === 'STAGE_SUCCEEDED'), JSON.stringify(results.map(r => r.state + ':' + r.reason)));
  const find = key => w.stages.find(s => s.f.envelope.idempotency_key === key);
  let lookups = 0, armed = false, injected = false;
  const end = await w.step(w.W.tickTrigger(), {
    lookupCompleted: async key => { if (++lookups === 4) armed = true; return find(key); },
    readSnapshot: async () => { const sn = await w.em.client.snapshot(w.pipeline, w.item, Date.now()); if (armed && !injected) { injected = true; await persistHalt(w.backend); } return sn; } });
  note('N-C06', { state: end.state, reason: end.reason, lookups, injected, halted: (await w.backend.read()).document.halted, launches: w.launches() });
  assert.equal(injected, true);
  assert.notEqual(end.state, 'HANDOFF_COMPLETE'); assert.equal(w.launches(), 3);
});

/* ================= (c) AUD-R55-01 prototype pollution ================= */
const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];
test('D01 projector: special role_id in agent_started / handoff / cost events never pollutes Object.prototype; state() works', () => {
  const Cn = req('public/haloflux-workbench-r52/contract.js'), P = req('public/haloflux-workbench-r52/projector.js');
  const res = {};
  for (const id of PROTO_KEYS) {
    const p = P.createProjector({}), at = Date.now();
    const ev = (n, type, o = {}) => ({ schema: Cn.EVENT_SCHEMA, event_id: 'aud-' + n, work_id: 'aud', seq: n, type, role_id: id, at, evidence: 'FIXTURE', source: 'AUDITOR', ...o });
    p.ingest([ev(1, 'agent_started', { cost: { usd: 0.01, status: 'estimated', ledger_id: 'L1' } }), ev(2, 'handoff', { to_role_id: id === '__proto__' ? 'constructor' : '__proto__' }), ev(3, 'agent_completed', { cost: { usd: null, status: 'unknown', ledger_id: 'L2' } })]);
    let st, err = null; try { st = p.state(); } catch (e) { err = String(e); }
    res[id] = { err, roles: st && Object.keys(st.roles), proto_state: ({}).state, proto_since: ({}).since_event_id, proto_entries: ({}).entries };
    assert.equal(err, null, id); assert.equal(({}).state, undefined, id); assert.equal(({}).since_event_id, undefined, id); assert.equal(({}).entries, undefined, id);
    assert.ok(Object.prototype.hasOwnProperty.call(st.roles, id), id);
  }
  note('D01', res);
});
test('D02 observation: sibling editor/planner role grant lookup with role_id "__proto__"/"toString" (fail-closed check)', () => {
  const Pl = req('public/haloflux-workbench-r52/planner.js');
  const grants = {}; // as editor.finish would build: own entries only via `if (!grants[id]) grants[id] = {...}`
  const out = {};
  for (const id of ['__proto__', 'toString', 'constructor']) { out[id] = { inherited_truthy: !!grants[id], approved_seen: !!(grants[id] && grants[id].approved) }; }
  note('D02', out);
  for (const id of Object.keys(out)) assert.equal(out[id].approved_seen, false, 'fail-closed for ' + id);
  assert.equal(({}).approved, undefined);
  void Pl;
});

/* ================= (d) provenance guard sources.js post_r57 ================= */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-src-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=aud', '-c', 'user.email=aud@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['clone', '-q', '--no-hardlinks', R, dir]); git('checkout', '-q', '--detach', HEAD);
  const verify = () => JSON.parse(execFileSync(process.execPath, ['-e', "try{const r=require('./tools/unattended-go-r57/sources.js').verify();console.log(JSON.stringify(r.violations))}catch(e){console.log(JSON.stringify(['THREW:'+e.message.split('\\n')[0]]))}"], { cwd: dir, encoding: 'utf8' }));
  const blob = p => git('ls-tree', 'HEAD', '--', p).split('\t')[0];
  const json = path.join(dir, 'tools/unattended-go-r57/sources.json');
  return { dir, git, verify, blob, json };
}
test('E01 guard at reviewed HEAD has 0 violations (positive)', t => { const s = sandbox(t); const v = s.verify(); note('E01', v); assert.deepEqual(v, []); });
test('E02 undeclared change to security core lib/auth.js is a violation', t => {
  const s = sandbox(t); fs.appendFileSync(path.join(s.dir, 'lib/auth.js'), '\n// aud\n'); s.git('commit', '-qam', 'aud');
  const v = s.verify(); note('E02', v); assert.ok(v.some(x => x === 'POST_R57_UNDECLARED:lib/auth.js'), JSON.stringify(v));
});
// sources.json no longer carries post_r57 (moved into sources.js). E03/E05/E06 now probe the OLD JSON route:
// it must be ignored, so the same protected changes stay violations.
const addJsonPost = (s, changes, base) => { const M = JSON.parse(fs.readFileSync(s.json, 'utf8')); M.post_r57 = { base: base || '049a3376a2d08042fcac1833b324bc87b0137ba1', changes }; fs.writeFileSync(s.json, JSON.stringify(M, null, 2)); };
test('E03 (re-run) JSON-declared lib/auth.js change with wrong blob is a violation', t => {
  const s = sandbox(t); fs.appendFileSync(path.join(s.dir, 'lib/auth.js'), '\n// aud\n');
  addJsonPost(s, { 'lib/auth.js': { to: '100644 blob ' + '0'.repeat(40), reason: 'aud' } });
  s.git('commit', '-qam', 'aud'); const v = s.verify(); note('E03', v); assert.ok(v.some(x => x.includes('lib/auth.js')), JSON.stringify(v));
});
test('E04 undeclared deletion of a protected file is a violation', t => {
  const s = sandbox(t); s.git('rm', '-q', 'tools/auto-handoff-r46/state.js'); s.git('commit', '-qm', 'aud');
  const v = s.verify(); note('E04', v); assert.ok(v.length > 0, JSON.stringify(v));
});
// Auditor-script correction (local pre-run): changing JSON `base` makes verify() THROW (git merge-base fails),
// i.e. fail-closed BLOCKED/exit1; the first draft of this assertion only accepted a lib/auth.js violation.
test('E05 (re-run) moving base to HEAD in sources.json does not hide a protected change (violation or fail-closed throw)', t => {
  const s = sandbox(t); fs.appendFileSync(path.join(s.dir, 'lib/auth.js'), '\n// aud\n'); s.git('commit', '-qam', 'aud');
  const h = s.git('rev-parse', 'HEAD');
  addJsonPost(s, {}, h); s.git('commit', '-qam', 'aud2'); const va = s.verify();             // (a) only JSON post_r57.base moved
  const M = JSON.parse(fs.readFileSync(s.json, 'utf8')); M.base = h; fs.writeFileSync(s.json, JSON.stringify(M, null, 2)); s.git('commit', '-qam', 'aud3');
  const vb = s.verify();                                                                        // (b) JSON base moved as well
  note('E05', { post_r57_base_only: va, base_too: vb });
  assert.ok(va.some(x => x.includes('lib/auth.js')), JSON.stringify(va));
  assert.ok(vb.some(x => x.includes('lib/auth.js') || x.startsWith('THREW:')), JSON.stringify(vb));
});
test('E06 (re-run) JSON-only self-declaration of lib/security.js change and r46 state.js deletion is NOT accepted', t => {
  const s = sandbox(t);
  fs.appendFileSync(path.join(s.dir, 'lib/security.js'), '\n// aud: arbitrary change to SSRF/TLS core\n'); s.git('add', '-A'); s.git('commit', '-qm', 'aud');
  addJsonPost(s, { 'lib/security.js': { to: s.blob('lib/security.js'), reason: 'anything' } }); s.git('commit', '-qam', 'declare');
  const v = s.verify();
  s.git('rm', '-q', 'tools/auto-handoff-r46/state.js'); addJsonPost(s, { 'lib/security.js': { to: s.blob('lib/security.js'), reason: 'anything' }, 'tools/auto-handoff-r46/state.js': { to: null, reason: 'anything' } }); s.git('commit', '-qam', 'delete core');
  const v2 = s.verify();
  note('E06', { security_js_declared: v, r46_state_deleted_declared: v2 });
  assert.ok(v.some(x => x.includes('lib/security.js')) && v2.some(x => x.includes('tools/auto-handoff-r46/state.js')), 'guard accepted JSON self-declared protected change: ' + JSON.stringify({ v, v2 }));
});
// ---- new provenance probes (deletion declarations, modes, JSON tampering, author-editable table) ----
test('N-E07 a file declared deleted (to:null) that is re-added is a violation', t => {
  const s = sandbox(t); fs.writeFileSync(path.join(s.dir, 'AGENTS.md'), 'aud re-added\n'); s.git('add', '-A'); s.git('commit', '-qm', 'aud');
  const v = s.verify(); note('N-E07', v); assert.ok(v.some(x => x.includes('AGENTS.md')), JSON.stringify(v));
});
test('N-E08 mode change (chmod +x) on a declared file is a violation', t => {
  const s = sandbox(t); fs.chmodSync(path.join(s.dir, 'README.md'), 0o755); s.git('add', '-A'); s.git('commit', '-qm', 'aud');
  const v = s.verify(); note('N-E08', v); assert.ok(v.some(x => x.includes('README.md')), JSON.stringify(v));
});
test('N-E09 tampering sources.json r56.head / deltas cannot whitelist a post-R57 change', t => {
  const s = sandbox(t);
  fs.appendFileSync(path.join(s.dir, 'tools/event-handoff-r56/bridge.js'), '\n// aud\n'); s.git('commit', '-qam', 'aud');
  const M = JSON.parse(fs.readFileSync(s.json, 'utf8')); const r56before = M.r56 && M.r56.head;
  if (M.r56) M.r56.head = s.git('rev-parse', 'HEAD');
  M.deltas['lib/security.js'] = { from: 'x', to: 'y', reason: 'aud' }; fs.writeFileSync(s.json, JSON.stringify(M, null, 2)); s.git('commit', '-qam', 'aud2');
  const v = s.verify(); note('N-E09', { r56_head_before: r56before, violations: v });
  assert.ok(v.some(x => x.includes('tools/event-handoff-r56/bridge.js')), JSON.stringify(v));
  assert.ok(v.some(x => x === 'UNEXPECTED_RUNTIME_EXCEPTION:lib/security.js'), JSON.stringify(v));
});
test('N-E10 observation: the hard-coded POST_R57 table lives in an own (unguarded) path; editing sources.js still whitelists a protected change (author-declared, as labelled)', t => {
  const s = sandbox(t);
  const from = s.git('ls-tree', '049a3376a2d08042fcac1833b324bc87b0137ba1', '--', 'lib/security.js').split('\t')[0];
  fs.appendFileSync(path.join(s.dir, 'lib/security.js'), '\n// aud\n'); s.git('add', '-A'); s.git('commit', '-qm', 'aud');
  const to = s.blob('lib/security.js'); const f = path.join(s.dir, 'tools/unattended-go-r57/sources.js');
  const src = fs.readFileSync(f, 'utf8'); const anchor = 'changes:Object.freeze({\n';
  assert.ok(src.includes(anchor), 'anchor');
  fs.writeFileSync(f, src.replace(anchor, anchor + '  "lib/security.js":{from:"' + from + '",to:"' + to + '",reason:"aud"},\n')); s.git('commit', '-qam', 'declare in code');
  const v = s.verify();
  const label = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./tools/unattended-go-r57/sources.js').verify().review))"], { cwd: s.dir, encoding: 'utf8' }));
  note('N-E10', { violations: v, review_label: label, sources_js_in_own_path: true });
  assert.equal(label, 'AUTHOR_CANDIDATE_NOT_INDEPENDENT_ACCEPT'); // guard self-labels as author declaration, not provenance proof
});

/* ================= (e) 85c4f63 delta: sources.js table and the author-CI attempt1 flake ================= */
test('S02 sources.js delta vs 26f76f9: exactly one added entry (executor.test.js), from == R57-base blob, to == HEAD blob; all other entries and logic unchanged', t => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.dir, 'tools/unattended-go-r57/sources.old.cjs'), s.git('show', '26f76f9b96247b0f8d19f36ba130a80181bdda4b:tools/unattended-go-r57/sources.js'));
  const N = require(path.join(s.dir, 'tools/unattended-go-r57/sources.js')).POST_R57, O = require(path.join(s.dir, 'tools/unattended-go-r57/sources.old.cjs')).POST_R57;
  const strip = x => x.replace(/const POST_R57=Object\.freeze\([\s\S]*?\n\}\)\}\);\n/, '<TABLE>\n').trimEnd();
  const added = Object.keys(N.changes).filter(k => !(k in O.changes)), removed = Object.keys(O.changes).filter(k => !(k in N.changes));
  const changed = Object.keys(O.changes).filter(k => k in N.changes && JSON.stringify(N.changes[k]) !== JSON.stringify(O.changes[k]));
  const P = 'tests/agent-executor/executor.test.js', e = N.changes[P] || {};
  const res = { base_equal: N.base === O.base, added, removed, changed, entry: e,
    from_is_r57_base_blob: e.from === s.git('ls-tree', '049a3376a2d08042fcac1833b324bc87b0137ba1', '--', P).split('\t')[0],
    from_is_26f76f9_blob: e.from === s.git('ls-tree', '26f76f9b96247b0f8d19f36ba130a80181bdda4b', '--', P).split('\t')[0],
    to_is_head_blob: e.to === s.blob(P),
    logic_outside_table_identical: strip(fs.readFileSync(path.join(s.dir, 'tools/unattended-go-r57/sources.js'), 'utf8')) === strip(s.git('show', '26f76f9b96247b0f8d19f36ba130a80181bdda4b:tools/unattended-go-r57/sources.js')) };
  note('S02', res);
  assert.deepEqual(added, [P]); assert.deepEqual(removed, []); assert.deepEqual(changed, []);
  assert.ok(res.base_equal && res.from_is_r57_base_blob && res.to_is_head_blob && res.logic_outside_table_identical, JSON.stringify(res));
});
// Author attempt1 automation failure was gate-integration.test.js:8 "R42 V2 new-role latest BLOCKED prevents even a Fake job claim"
// (not executor.test.js:68). Hypothesis: demo() stamps comments with wall-clock new Date() AFTER computing `now`; the test's
// "newer" comment uses now+1, so on a slow runner the original READY comment is chronologically newer.
function r42(t, nowSkewMs, newerAt) {
  const { demo } = req('tools/agent-executor/demo'), { Executor } = req('tools/agent-executor/engine'), { Store } = req('tools/agent-executor/store'), { FakeAdapter } = req('tools/agent-executor/adapters'), P = req('tools/agent-executor/policy'), { evaluate } = req('tools/agent-scheduler/state');
  const f = demo('qa', 'codex', Date.now() - nowSkewMs); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-r42-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  f.store = new Store(dir); const audit = f.snapshot.issues[2].comments[0], c = structuredClone(audit);
  c.created_at = new Date(newerAt(f, audit)).toISOString(); c.body = c.body.replace('role: CodeAudit\n', 'role: Independent-CodeAudit\n').replace('status: READY_FOR_REVIEW', 'status: BLOCKED');
  f.snapshot.issues[2].comments.push(c);
  f.payload.source_digest = P.digest(f.snapshot); f.payload.gate_digest = P.gateDigest(evaluate(f.snapshot, f.policy.gate_config, f.now));
  const r = new Executor(f.policy, f.store).run(f.request, f.sign(), f.snapshot, new FakeAdapter('codex', 'cli', [{ type: 'result' }]), f.now);
  return { state: r.state, reason: r.reason || null, jobs: Object.keys(f.store.snapshot().jobs).length, original_at: audit.created_at, blocked_at: c.created_at, now: new Date(f.now).toISOString() };
}
test('F01 reproduce flake deterministically: fixture `now` 5 ms before comment stamping + test-style now+1 -> BLOCKED comment is OLDER -> SUCCESS (test bug, gate correct)', t => {
  const r = r42(t, 5, f => f.now + 1); note('F01', r);
  assert.ok(Date.parse(r.blocked_at) < Date.parse(r.original_at), 'precondition: test-style "newer" comment is actually older');
  assert.equal(r.state, 'SUCCESS'); // documents the false-fail mechanism of the author test
});
test('F02 gate correctness: BLOCKED comment truly newest (max created_at + 1) blocks with 0 jobs, even with the same skew', t => {
  const r = r42(t, 5, (f, a) => Date.parse(a.created_at) + 1); note('F02', r);
  assert.notEqual(r.state, 'SUCCESS'); assert.equal(r.jobs, 0);
});
test('F03 gate correctness: same-millisecond tie resolves to source order (pushed BLOCKED is latest) and blocks', t => {
  const r = r42(t, 5, (f, a) => Date.parse(a.created_at)); note('F03', r);
  assert.notEqual(r.state, 'SUCCESS'); assert.equal(r.jobs, 0);
});

/* ================= (f) 26f76f9: AUD-85C4-01 fix effectiveness and AUD-0EA9-02 pull_request trigger ================= */
const GI = 'tests/agent-executor/gate-integration.test.js';
const NEG = ['R42 V2 new-role latest BLOCKED prevents even a Fake job claim', 'R42 V2 new-role latest REJECTED prevents even a Fake job claim'];
const POS = ['R42 V2 accepts audited V1 CodeAudit protocol for Fake QA track only', 'R42 V2 accepts audited V1 Independent-CodeAudit protocol for Fake QA track only'];
const skewFile = (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-skew-')), f = path.join(d, 'skew.cjs');
  // Date.now() lags the wall clock that `new Date()` uses by 50 ms: magnifies the original fixture race deterministically.
  fs.writeFileSync(f, "'use strict';const r=Date.now;Date.now=()=>r.call(Date)-50;\n"); return f; })();
function tapRun(cwd, file, names, extra = []) {
  const r = require('node:child_process').spawnSync(process.execPath, [...extra, '--test', '--test-reporter=tap', '--test-concurrency=1', ...names.map(n => '--test-name-pattern=^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), file], { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const res = {}; for (const n of names) res[n] = new RegExp('^ok \\d+ - ' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').test(r.stdout) ? 'PASS' : (new RegExp('^not ok \\d+ - ' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').test(r.stdout) ? 'FAIL' : 'NOT_RUN');
  return { exit: r.status, tests: +(/# tests (\d+)/.exec(r.stdout) || [])[1], res };
}
test('K01 regression proof: OLD (85c4f63) test file under 50 ms Date.now lag -> both negatives FAIL (race reproduced on the real test)', t => {
  const s = sandbox(t), old = 'tests/agent-executor/gate-integration.old85c4.test.js';
  fs.writeFileSync(path.join(s.dir, old), s.git('show', '85c4f633376bf24de6794004320d992164f33ef9:' + GI));
  const r = tapRun(s.dir, old, NEG, ['--require', skewFile]); note('K01', r);
  assert.deepEqual(Object.values(r.res), ['FAIL', 'FAIL'], JSON.stringify(r));
});
test('K02 fix: NEW (26f76f9) test file under the same 50 ms lag -> both negatives PASS and positives still PASS (not vacuous)', t => {
  const s = sandbox(t);
  const neg = tapRun(s.dir, GI, NEG, ['--require', skewFile]), pos = tapRun(s.dir, GI, POS, ['--require', skewFile]);
  note('K02', { neg, pos });
  assert.deepEqual(Object.values(neg.res), ['PASS', 'PASS'], JSON.stringify(neg));
  assert.deepEqual(Object.values(pos.res), ['PASS', 'PASS'], JSON.stringify(pos)); // gate still issues SUCCESS under skew -> negatives block because of BLOCKED/REJECTED
});
test('M01 mutation: gate picks the OLDEST audit report (state.js latest(): .at(-1) -> [0]) -> new negatives must FAIL (still an effective negative test)', t => {
  const s = sandbox(t), f = path.join(s.dir, 'tools/agent-scheduler/state.js'), src = fs.readFileSync(f, 'utf8');
  const a = 'const latest=(issue,role)=>reports(issue,role).at(-1);'; assert.ok(src.includes(a), 'mutation anchor');
  const base = tapRun(s.dir, GI, NEG);
  fs.writeFileSync(f, src.replace(a, 'const latest=(issue,role)=>reports(issue,role)[0];'));
  const mut = tapRun(s.dir, GI, NEG); note('M01', { unmutated: base, mutated: mut });
  assert.deepEqual(Object.values(base.res), ['PASS', 'PASS'], JSON.stringify(base));
  assert.deepEqual(Object.values(mut.res), ['FAIL', 'FAIL'], 'mutation not detected: ' + JSON.stringify(mut));
});
const MAIN_SHA = 'adb4d02306af7c0be4d5491f996279877354e308'; // origin/main at audit time (ancestor of 26f76f9)
test('P01 PR merge tree (refs/pull/N/merge simulation: main + merge 26f76f9, --no-ff) -> sources guard 0 violations', t => {
  const s = sandbox(t);
  const anc = (() => { try { s.git('merge-base', '--is-ancestor', MAIN_SHA, HEAD); return true; } catch { return false; } })();
  s.git('checkout', '-q', '--detach', MAIN_SHA); s.git('merge', '-q', '--no-ff', '--no-edit', HEAD);
  const tree_equal_head = s.git('rev-parse', 'HEAD^{tree}') === s.git('rev-parse', HEAD + '^{tree}');
  const v = s.verify(); note('P01', { main_is_ancestor: anc, merge_tree_equals_head_tree: tree_equal_head, violations: v });
  assert.equal(anc, true); assert.deepEqual(v, []);
});
test('P02 PR merge tree when main has its OWN later change (hotfix to README.md / lib/auth.js) -> guard reports violations (fail-closed; PR stays red until declared)', t => {
  const s = sandbox(t), out = {};
  // main (adb4d02, 2026-11-05) predates the R57 base and has no lib/; simulate (a) a hotfix to an existing file, (b) a new main-only file.
  for (const [file, mode] of [['server.js', 'append'], ['docs/MAIN-HOTFIX.md', 'create']]) {
    s.git('checkout', '-q', '--detach', MAIN_SHA); const fp = path.join(s.dir, file);
    if (mode === 'append') fs.appendFileSync(fp, '\n// main-only hotfix (audit sim)\n'); else fs.writeFileSync(fp, 'main-only doc (audit sim)\n');
    s.git('add', '-A'); s.git('commit', '-qm', 'main hotfix');
    let merged = true; try { s.git('merge', '-q', '--no-ff', '--no-edit', HEAD); } catch (e) { merged = 'CONFLICT'; s.git('merge', '--abort'); }
    out[file] = { merged, violations: merged === true ? s.verify() : null };
  }
  note('P02', out);
  for (const [file, r] of Object.entries(out)) if (r.merged === true) assert.ok(r.violations.some(x => x.includes(file)), file + ' ' + JSON.stringify(r));
});
test('Y01 workflow trigger: pull_request into main added; no pull_request_target; contents: read; checkouts persist no credentials-bearing secrets', () => {
  const y = fs.readFileSync(path.join(R, '.github/workflows/codex-r57-unattended.yml'), 'utf8');
  const res = { pull_request_main: /\n  pull_request:\n    branches: \[main\]\n/.test(y), pull_request_target: /pull_request_target/.test(y), contents_read: /\npermissions:\n  contents: read\n/.test(y),
    secrets_refs: (y.match(/secrets\./g) || []).length, push_branches: (/\n  push:\n    branches: (\[.*\])/.exec(y) || [])[1],
    sources_guard_on_merge_commit: /ref: \$\{\{ github\.sha \}\}\n[\s\S]{0,400}node tools\/unattended-go-r57\/sources\.js/.test(y) };
  note('Y01', res);
  assert.ok(res.pull_request_main && !res.pull_request_target && res.contents_read && res.secrets_refs === 0, JSON.stringify(res));
});

/* ================= (g) c7de4a7: child 'exit' vs 'close' ================= */
const { spawn: spawnP } = require('node:child_process');
function childRun(evt, bytes) {
  return new Promise((resolve, reject) => {
    const code = `require('node:fs').writeSync(1, Buffer.alloc(${bytes}, 120)); process.exit(0)`;
    const c = spawnP(process.execPath, ['-e', code]); let n = 0; c.stdout.on('data', b => n += b.length); c.on('error', reject); c.on(evt, () => resolve(n));
  });
}
test('X01 mechanism: on "exit" the parent may not have drained child stdout; on "close" it always has (2 MiB written synchronously, 20 runs each)', async () => {
  const B = 2 * 1024 * 1024, exitLens = [], closeLens = [];
  for (let i = 0; i < 20; i++) { exitLens.push(await childRun('exit', B)); closeLens.push(await childRun('close', B)); }
  const res = { bytes: B, exit_truncated_runs: exitLens.filter(n => n < B).length, exit_min: Math.min(...exitLens), close_truncated_runs: closeLens.filter(n => n < B).length };
  note('X01', res);
  assert.equal(res.close_truncated_runs, 0, JSON.stringify(res)); // the property the fix relies on
});
test('X02 mutation: Store.claim without DUPLICATE_JOB / ROLE_BUSY checks -> the edited four-process test must FAIL (assertion still detects double claims)', t => {
  const s = sandbox(t), f = path.join(s.dir, 'tools/agent-executor/store.js'), src = fs.readFileSync(f, 'utf8');
  const a1 = "if(s.jobs[key])return {blocked:'DUPLICATE_JOB',key};", a2 = "if(Object.values(s.jobs).some(j=>j.role===request.role&&ACTIVE.includes(j.state)))return {blocked:'ROLE_BUSY',key};";
  assert.ok(src.includes(a1) && src.includes(a2), 'mutation anchors');
  const T = 'tests/agent-executor/executor.test.js', N = ['four competing processes claim a job once without launching any Agent'];
  const base = tapRun(s.dir, T, N);
  fs.writeFileSync(f, src.replace(a1, '').replace(a2, ''));
  const mut = tapRun(s.dir, T, N); note('X02', { unmutated: base, mutated: mut });
  assert.deepEqual(Object.values(base.res), ['PASS'], JSON.stringify(base));
  assert.deepEqual(Object.values(mut.res), ['FAIL'], 'mutation not detected: ' + JSON.stringify(mut));
});
test('X03 diff is exactly the exit->close swap plus comment; assertions (exactly one unblocked claim, one job) unchanged', t => {
  const s = sandbox(t), T = 'tests/agent-executor/executor.test.js';
  const d = s.git('diff', '-U0', '26f76f9b96247b0f8d19f36ba130a80181bdda4b', HEAD, '--', T).split('\n').filter(l => /^[-+][^-+]/.test(l));
  const [m, p] = [d.find(l => l[0] === '-').slice(1), d.find(l => l[0] === '+').slice(1)];
  const norm = x => x.replace(/\/\*[\s\S]*?\*\//g, '').replace("c.on('close',", "c.on('exit',");
  const assertLine = s.git('show', HEAD + ':' + T).split('\n').find(l => l.includes("assert.equal(r.filter(x=>!x.blocked).length,1)"));
  note('X03', { changed_lines: d.length, equal_after_normalising: norm(p) === m, assert_line_present: !!assertLine });
  assert.equal(d.length, 2); assert.equal(norm(p), m); assert.ok(assertLine && assertLine.includes("Object.keys(f.store.snapshot().jobs).length,1"));
});
test('X04 observation: real-test shape (4 concurrent children, ~200 B JSON line, 100 rounds) -> count of "exit"-time truncations (documented possible, may be 0)', async () => {
  let trunc = 0, total = 0;
  for (let i = 0; i < 100; i++) { const rs = await Promise.all([1, 2, 3, 4].map(() => childRun('exit', 200))); total += 4; trunc += rs.filter(n => n < 200).length; }
  note('X04', { total, exit_truncated: trunc }); assert.ok(total === 400);
});
