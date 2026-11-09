'use strict';
// Independent-CodeAudit counterexamples for reviewed SHA bc72f00020b71ac8efd77ba0683a64c0998845c9.
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
  assert.equal(HEAD, 'bc72f00020b71ac8efd77ba0683a64c0998845c9');
});

/* ================= (a) AUD-R57-01 ciGate / facts / github.js ================= */
const Facts = req('tools/event-handoff-r56/facts.js');
const WF = 'aud-wf';
const PL = { ci: { workflows: [WF], required_jobs: ['tests', 'browser'] } };
const J = (n, c = 'success', s = 'completed') => ({ name: n, status: s, conclusion: c });
const OK = [J('tests'), J('browser')];
const run = (id, o = {}) => ({ id, run_attempt: 1, run_number: id, workflow_id: 555, name: WF, html_url: 'u/' + id + '/' + (o.run_attempt || 1), status: 'completed', conclusion: 'success', jobs_complete: true, jobs: OK, ...o });
const g = runs => Facts.ciGate(runs, PL);
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
  const r = Facts.ciGate(snap.runs, PL);
  note('runlist_truncation', { listed_total_count: list.length, captured: snap.runs.length, max_captured_id: Math.max(...snap.runs.map(x => x.id)), gate: r });
  assert.equal(r.green, null, 'incomplete run list (total_count 51 > captured ' + snap.runs.length + ') treated as complete: ' + JSON.stringify(r));
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
  return { ...f, em, step, W, ciDoc };
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
test('E03 declared blob mismatch is a violation', t => {
  const s = sandbox(t); fs.appendFileSync(path.join(s.dir, 'lib/auth.js'), '\n// aud\n');
  const M = JSON.parse(fs.readFileSync(s.json, 'utf8')); M.post_r57.changes['lib/auth.js'] = { to: '100644 blob ' + '0'.repeat(40), reason: 'aud' }; fs.writeFileSync(s.json, JSON.stringify(M, null, 2));
  s.git('commit', '-qam', 'aud'); const v = s.verify(); note('E03', v); assert.ok(v.some(x => x.startsWith('POST_R57_BLOB_MISMATCH:lib/auth.js')), JSON.stringify(v));
});
test('E04 undeclared deletion of a protected file is a violation', t => {
  const s = sandbox(t); s.git('rm', '-q', 'tools/auto-handoff-r46/state.js'); s.git('commit', '-qm', 'aud');
  const v = s.verify(); note('E04', v); assert.ok(v.length > 0, JSON.stringify(v));
});
test('E05 moving post_r57.base to HEAD does not hide a protected change', t => {
  const s = sandbox(t); fs.appendFileSync(path.join(s.dir, 'lib/auth.js'), '\n// aud\n'); s.git('commit', '-qam', 'aud');
  const M = JSON.parse(fs.readFileSync(s.json, 'utf8')); M.post_r57.base = s.git('rev-parse', 'HEAD'); fs.writeFileSync(s.json, JSON.stringify(M, null, 2)); s.git('commit', '-qam', 'aud2');
  const v = s.verify(); note('E05', v); assert.ok(v.length > 0, JSON.stringify(v));
});
test('E06 WEAKENING PROBE: JSON-only self-declaration in an own path whitelists a change to ANY protected security-core file', t => {
  const s = sandbox(t);
  fs.appendFileSync(path.join(s.dir, 'lib/security.js'), '\n// aud: arbitrary change to SSRF/TLS core\n'); s.git('add', '-A'); s.git('commit', '-qm', 'aud');
  const b = s.blob('lib/security.js');
  const M = JSON.parse(fs.readFileSync(s.json, 'utf8')); M.post_r57.changes['lib/security.js'] = { to: b, reason: 'anything' }; fs.writeFileSync(s.json, JSON.stringify(M, null, 2)); s.git('commit', '-qam', 'declare');
  const v = s.verify();
  s.git('rm', '-q', 'tools/auto-handoff-r46/state.js'); const M2 = JSON.parse(fs.readFileSync(s.json, 'utf8')); M2.post_r57.changes['tools/auto-handoff-r46/state.js'] = { to: null, reason: 'anything' }; fs.writeFileSync(s.json, JSON.stringify(M2, null, 2)); s.git('commit', '-qam', 'delete core');
  const v2 = s.verify();
  note('E06', { security_js_declared: v, r46_state_deleted_declared: v2 });
  // Expected for a guard that is not weaker than the pre-R57 one: protected paths outside a fixed allowlist are never accepted by data alone.
  assert.ok(v.length > 0 && v2.length > 0, 'guard accepted self-declared protected change: ' + JSON.stringify({ v, v2 }));
});
