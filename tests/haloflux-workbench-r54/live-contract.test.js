'use strict';
// R54 (#37): the workbench's R53 contract layer. Pure mapping (E2) + the REAL R53 backend
// (397b46c, materialised read-only by overlay.cjs) with a local MOCK model (E3_FAKE). No paid model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..', '..');
const W = p => require(path.join(ROOT, 'public', 'haloflux-workbench-r52', p));
const C = W('contract.js'), P = W('planner.js'), E = W('editor.js'), J = W('projector.js'), A = W('acceptance.js'), L = W('live-r53.js');
const { bootR53, settled, materialize, R53_SHA } = require('./overlay.cjs');
const F = require('../haloflux-workbench-r52/fixtures.cjs');
const OUT = process.env.R54_OUT || null;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const evidence = { level: 'E2 (pure) + E3_FAKE (real R53 backend ' + R53_SHA + ' overlay + local MOCK model)', r53: R53_SHA, blind: {}, flow: {} };
const LOCAL = { connectionId: 'm-local', displayName: 'Local', enabled: true, ready: true, status: 'available', pricingMode: 'local', capabilities: ['reasoning', 'writing', 'data_analysis', 'research', 'vision', 'coding'] };
const REMOTE = { ...LOCAL, connectionId: 'm-remote', displayName: 'Remote', pricingMode: 'paid' };
const codes = p => p.blocks.map(b => b.code);

// A recorded-shape R53 plan response used only for the pure tests (the E3 tests use the live server).
function fakeResp() {
  return { schema: 'aijavais.universal-workflow/v1', status: 'PLAN_SIMULATED', evidence: 'E2_RULES_NOT_AI', clarifications: [],
    project: { name: '通用编队：赛鸽', description: '为赛鸽俱乐部做排期表', roles: [
      { roleId: 'u-scope', name: '范围协调员', duty: 'd', boundary: 'b', standard: 's', requiredCapabilities: ['reasoning'] },
      { roleId: 'u-lead', name: '负责人', duty: 'd', boundary: 'b', standard: 's', requiredCapabilities: ['reasoning'] },
      { roleId: 'u-review', name: '独立质量复核员', duty: 'd', boundary: 'b', standard: 's', requiredCapabilities: ['reasoning'] }],
      steps: [{ stepId: 'u-step-scope', roleId: 'u-scope', title: '澄清', kind: 'work' }, { stepId: 'u-step-lead', roleId: 'u-lead', title: '核心', kind: 'work' }, { stepId: 'u-step-review', roleId: 'u-review', title: '复核', kind: 'peer_review' }],
      standards: ['排期覆盖全部环节', '未虚构数据'], deliverables: ['schedule'], maxReworks: 2, planning: {} },
    modelRecommendations: [{ roleId: 'u-scope', candidates: [{ connectionId: 'm-local' }] }, { roleId: 'u-lead', candidates: [{ connectionId: 'm-remote' }] }, { roleId: 'u-review', candidates: [{ connectionId: 'm-local' }] }],
    acceptance: { expertReviewRequired: false } };
}
const localPlan = () => P.plan({ goal: '为赛鸽俱乐部做排期表', domain: '赛鸽', models: [LOCAL, REMOTE] }).plan;

test('M0/M1 mapping: server plan is the authority; per-role grants, remote block, peer-review rule, edits revoke grants', () => {
  assert.throws(() => L.fromServerPlan({ status: 'OK' }, localPlan(), []), /不是 R53/);
  let p = L.fromServerPlan(fakeResp(), localPlan(), [LOCAL, REMOTE]);
  assert.equal(p.contract, 'r53'); assert.equal(p.label, 'PLAN_SIMULATED'); assert.equal(p.evidence, 'E2_RULES_NOT_AI');
  assert.deepEqual(p.steps.map(s => s.kind), ['work', 'work', 'peer_review']); assert.deepEqual(p.acceptance.map(c => c.id), ['criterion-1', 'criterion-2']);
  assert.equal(p.roles[1].model.connection_id, 'm-remote');
  assert.ok(codes(p).includes('BLOCKED_UNENFORCEABLE_COST_CAP')); assert.ok(codes(p).includes('ROLE_NOT_APPROVED'));
  assert.equal(L.roleStatus(p, p.roles[1], null).status, 'blocked');
  assert.throws(() => E.apply(p, { op: 'setRoleGrant', role_id: 'u-lead', approved: true }, { models: [LOCAL, REMOTE] }), /远程\/收费/);
  p = E.apply(p, { op: 'setModel', role_id: 'u-lead', connection_id: 'm-local' }, { models: [LOCAL, REMOTE] });
  for (const r of p.roles) p = E.apply(p, { op: 'setRoleGrant', role_id: r.role_id, approved: true, max_tokens: 50000 }, { models: [LOCAL] });
  assert.ok(!codes(p).includes('ROLE_NOT_APPROVED')); assert.equal(E.runRequest(p).code, 'NOT_AUTHORIZED');
  p = E.confirm(p, true); assert.equal(E.runRequest(p).ok, true);
  assert.equal(L.roleStatus(p, p.roles[0], null).status, 'approved');
  const kept = E.apply(p, { op: 'setRoleGrant', role_id: 'u-scope', max_tokens: 60000 });
  assert.equal(kept.permissions.roles['u-lead'].approved, true, 'changing one grant keeps the others'); assert.equal(kept.permissions.confirmed, false);
  const edited = E.apply(p, { op: 'editRole', role_id: 'u-lead', name: '新名字' });
  assert.ok(Object.values(edited.permissions.roles).every(g => g.approved === false), 'editing the team revokes every role grant');
  // Peer review rules mirror the server's validation.
  const noReview = E.apply(p, { op: 'editStep', step_id: 'u-step-review', kind: 'work' }); assert.ok(codes(noReview).includes('PEER_REVIEW_MISSING'));
  const selfReview = E.apply(p, { op: 'editStep', step_id: 'u-step-review', role_id: 'u-lead' }); assert.ok(codes(selfReview).includes('PEER_REVIEW_CONFLICT'));
  const first = E.apply(p, { op: 'moveStep', step_id: 'u-step-review', delta: -1 }); assert.ok(!codes(first).includes('PEER_REVIEW_CONFLICT'));
  assert.ok(codes(E.apply(first, { op: 'moveStep', step_id: 'u-step-review', delta: -1 })).includes('PEER_REVIEW_CONFLICT'), 'review first has nothing to review');
  assert.throws(() => E.apply(p, { op: 'editStep', step_id: 'u-step-scope', kind: 'boss' }), /工作或独立复核/);
  assert.throws(() => E.apply(localPlan(), { op: 'setRoleGrant', role_id: 'u-scope', approved: true }), /通用工作流后端/);
  // Bodies.
  const body = L.approvalBody(p, 'rid-1');
  assert.deepEqual(Object.keys(body.rolePermissions).sort(), p.roles.map(r => r.role_id).sort());
  assert.ok(Object.values(body.rolePermissions).every(g => g.approved === true && g.connectionId === 'm-local' && g.maxTokens === 50000 && g.maxCost === 0 && Array.isArray(g.allowedTools)));
  assert.equal(body.approved, true); assert.equal(body.requestId, 'rid-1');
  const proj = L.toUniversalProject(p);
  assert.equal(proj.planning.workflowSchema, 'aijavais.universal-workflow/v1'); assert.deepEqual(proj.steps.map(s => s.kind), ['work', 'work', 'peer_review']);
  assert.equal(L.reworkBody(p, { requestId: 'x', feedback: ' ' }).ok, false); assert.equal(L.reworkBody(p, { requestId: 'x', feedback: 'a', fromStepId: 'ghost' }).ok, false);
  const rb = L.reworkBody(p, { requestId: 'x', feedback: '改排期', fromStepId: 'u-step-lead' }); assert.equal(rb.body.fromStepId, 'u-step-lead'); assert.ok(rb.body.rolePermissions);
  const run = { round: 2, projectSnapshot: { standards: ['a', 'b'] } };
  assert.deepEqual(L.criteriaBody(run, { 'criterion-1': { status: 'passed', note: 'ok' }, 'criterion-9': { status: 'passed' } }, 'c1'),
    { requestId: 'c1', expectedRound: 2, checks: { 'criterion-1': { status: 'passed', note: 'ok' }, 'criterion-2': { status: 'unverified' } } });
  const ab = L.acceptBody({ artifact_id: 'a1', sha256: 'f'.repeat(64) }, { confirmCriteria: true, acknowledgeSimulation: true, expertReviewNote: '  ' });
  assert.equal(ab.expertReviewNote, undefined); assert.equal(ab.acknowledgeUnknownCost, undefined);
  // Request IDs: identical retry -> same ID; changed content -> new ID; IDs carry no user text.
  const ids = L.requestIds('seed');
  assert.equal(ids('start', { a: 1, b: 2 }), ids('start', { b: 2, a: 1 })); assert.notEqual(ids('start', { a: 1 }), ids('start', { a: 2 }));
  assert.match(ids('rework', { fb: '<script>机密</script>' }), /^r54-rework-seed-\d+-[0-9a-f]{8}$/);
  for (const [status, code, re] of [[409, 'criteria_not_passed', /未通过/], [403, 'role_permission', /岗位/], [402, 'BLOCKED_UNENFORCEABLE_COST_CAP', /费用硬上限/], [401, undefined, /登录/], [409, undefined, /版本冲突/], [500, 'weird', /服务器拒绝/]])
    assert.match(L.explain(status, code ? { code, error: 'x' } : {}).human, re, String(code));
});

test('M3 incremental pull: cursor pages, overlap after reconnect and backward cursors are handled honestly', async () => {
  const all = [...new Map(F.bundle(['a', 'b', 'c'], { work: 'w54' }).events.map(e => [e.seq, e])).values()].sort((x, y) => x.seq - y.seq); // one per seq
  const pages = []; const fetchPage = async (after, limit) => { pages.push([after, limit]); const ev = all.filter(e => e.seq > after).slice(0, limit); return { events: ev, cursor: ev.length ? ev.at(-1).seq : after, artifacts: [] }; };
  const j = J.createProjector({}), st = { cursor: 0 };
  await L.pull(fetchPage, j, st, { limit: 4 });
  assert.equal(st.cursor, all.length); assert.equal(j.state(0).applied, all.length); assert.deepEqual(pages.map(p => p[0]), [0, 4, 8, 12, 16].filter(x => x <= all.length));
  st.cursor = 5; const again = j.ingest(all.slice(5)); assert.equal(again.duplicates, all.length - 5, 'reconnect overlap is de-duplicated');
  await assert.rejects(L.pull(async () => ({ events: [], cursor: 1 }), J.createProjector({}), { cursor: 3 }), /backwards/);
  await assert.rejects(L.pull(async () => ({ nope: 1 }), J.createProjector({}), { cursor: 0 }), /bad_workbench_page/);
});

test('E3_FAKE real R53 backend: 8 blind goals, auth, versioned save, per-role refusal, idempotent start, events, criteria, targeted rework, acceptance', async t => {
  const f = await bootR53();
  t.after(() => f.stop());
  const app = () => f.app;
  const models = (await app().call('GET', '/api/models')).json.models;
  const overlay = materialize();
  evidence.overlay = { r53: overlay.r53, overlaidFiles: overlay.overlaid.length };
  // Blind goals through the live server plan.
  const sigs = new Set();
  for (const b of F.BLIND) {
    const r = await app().call('POST', '/api/v2/universal/plan', L.planRequest({ goal: b.goal, domain: b.domain, successCriteria: b.success }));
    assert.equal(r.status, 200, r.text);
    const p = L.fromServerPlan(r.json, P.plan({ goal: b.goal, domain: b.domain, successCriteria: b.success, models }).plan, models);
    assert.ok(p.roles.length >= 3); assert.ok(p.steps.some(s => s.kind === 'peer_review')); assert.ok(p.roles.every(r2 => r2.model.connection_id === f.model));
    sigs.add(p.roles.map(r2 => r2.role_id).join(','));
    evidence.blind[b.key] = { roles: p.roles.map(r2 => r2.name), blocks: codes(p) };
  }
  assert.ok(sigs.size >= 6, 'server plans differ across blind goals: ' + sigs.size);
  assert.equal(f.state.calls, 0); assert.equal((await app().call('GET', '/api/v2/projects')).json.projects.length, 0, 'planning never saves');
  // Unauthenticated: refused.
  assert.equal((await f.H.call(app().port, 'POST', '/api/v2/universal/plan', { goal: '未登录的请求生成报告' }, { cookie: false })).status, 401);
  // Plan -> edit -> grants -> save (versioned).
  const b = F.BLIND[3];
  let p = L.fromServerPlan((await app().call('POST', '/api/v2/universal/plan', L.planRequest({ goal: b.goal, domain: b.domain, successCriteria: b.success }))).json,
    P.plan({ goal: b.goal, domain: b.domain, models }).plan, models);
  p = E.apply(p, { op: 'editRole', role_id: p.roles[0].role_id, name: '档案范围协调员' }, { models });
  const grantAll = q => { for (const r of q.roles) q = E.apply(q, { op: 'setRoleGrant', role_id: r.role_id, approved: true }, { models }); return E.confirm(q, true); };
  p = grantAll(p);
  const created = await app().call('POST', '/api/v2/universal/projects', { project: L.toUniversalProject(p) });
  assert.equal(created.status, 201, created.text); const pid = created.json.project.projectId; assert.equal(created.json.project.version, 1);
  assert.equal(created.json.project.roles[0].name, '档案范围协调员');
  const put = await app().call('PUT', '/api/v2/projects/' + pid, { ...L.toUniversalProject(p), expectedVersion: 1 });
  assert.equal(put.status, 200, put.text); assert.equal(put.json.project.version, 2); assert.equal(put.json.project.planning.workflowSchema, L.WORKFLOW);
  const stale = await app().call('PUT', '/api/v2/projects/' + pid, { ...L.toUniversalProject(p), expectedVersion: 1 });
  assert.equal(stale.status, 409); assert.match(L.explain(stale.status, stale.json).human, /版本冲突|方案已被修改|不允许/);
  // Per-role refusals dispatch nothing.
  const ids = L.requestIds('e3');
  const base = L.approvalBody(p, 'unused');
  const one = p.roles[0].role_id;
  for (const [name, mutate] of [['global not approved', x => { x.approved = false; }], ['role not approved', x => { x.rolePermissions[one].approved = false; }],
    ['role missing', x => { delete x.rolePermissions[one]; }], ['wrong connection', x => { x.rolePermissions[one].connectionId = 'conn_ghost'; }], ['role tool beyond global', x => { x.rolePermissions[one].allowedTools = ['mcp:write']; }]]) {
    const bodyX = JSON.parse(JSON.stringify(base)); bodyX.requestId = ids('deny', name); mutate(bodyX);
    const r = await app().call('POST', `/api/v2/universal/projects/${pid}/runs`, bodyX);
    assert.ok(r.status === 403 || r.status === 409, name + ' ' + r.status + ' ' + r.text); assert.ok(L.explain(r.status, r.json).human.length > 5);
  }
  assert.equal(f.state.calls, 0, 'refusals dispatch zero model calls');
  // Start; identical retry is idempotent; reused ID with different content is refused.
  const startBody = L.approvalBody(p, ids('start', { pid, v: 2, gen: 0 }));
  const s1 = await app().call('POST', `/api/v2/universal/projects/${pid}/runs`, startBody);
  assert.equal(s1.status, 202, s1.text); const runId = s1.json.run.runId;
  const s2 = await app().call('POST', `/api/v2/universal/projects/${pid}/runs`, startBody);
  assert.equal(s2.status, 202); assert.equal(s2.json.run.duplicate, true); assert.equal(s2.json.run.noReplay, true);
  const s3 = await app().call('POST', `/api/v2/universal/projects/${pid}/runs`, { ...startBody, maxTokens: startBody.maxTokens - 1 });
  assert.equal(s3.status, 409); assert.equal(s3.json.code, 'idempotency_key_reused');
  let run = await settled(f, runId);
  assert.equal(run.status, 'review_required'); const steps = p.steps.length; assert.equal(f.state.calls, steps, 'exactly one dispatch per step, no replay');
  // Incremental events: small pages, reversed and re-fetched input give the same projection.
  const j = J.createProjector({ mode: 'LIVE' }), cur = { cursor: 0 };
  const page = async (after, limit) => (await app().call('GET', `/api/v2/universal/runs/${runId}/workbench?after=${after}&limit=${limit}`)).json;
  const last = await L.pull(page, j, cur, { limit: 7 });
  const full = (await app().call('GET', `/api/v2/universal/runs/${runId}/workbench`)).json;
  assert.equal(cur.cursor, full.events.length); assert.equal(j.ingest(full.events).duplicates, full.events.length);
  const rev = J.createProjector({}); rev.ingest([...full.events].reverse());
  const s = j.state();
  assert.deepEqual(rev.state().roles, s.roles); assert.equal(s.phase, 'delivered');
  assert.ok(p.roles.every(r => s.roles[r.role_id] && s.roles[r.role_id].state === 'completed'), JSON.stringify(Object.values(s.roles).map(r => r.state)));
  assert.ok(s.edges.some(e => !e.derived), 'explicit server hand-offs are drawn'); assert.equal(s.cost.total_usd, null, 'vendor bill unknown, never $0');
  assert.ok(Object.values(s.cost_by_role).every(c => c.unknown)); assert.equal(L.roleStatus(p, p.roles[0], s).unknown_cost, true);
  assert.ok(last.artifacts.every(a => C.validateArtifact(a).ok));
  // Deliver round 1, criteria failed -> accept refused; then targeted rework from step 3.
  const d1 = await app().call('POST', `/api/v2/universal/runs/${runId}/deliver`, { requestId: ids('deliver', { r: 1 }), format: 'docx' });
  assert.equal(d1.status, 201, d1.text); const art1 = d1.json.artifact; assert.equal(art1.round, 1);
  const file1 = await fetch(`http://127.0.0.1:${app().port}${art1.downloadUrl}`, { headers: { cookie: app().cookie } }).then(r => r.arrayBuffer()).then(Buffer.from);
  assert.equal(sha(file1), art1.sha256, 'downloaded bytes match the server SHA-256');
  run = (await app().call('GET', '/api/v2/universal/runs/' + runId)).json.run;
  const crit = await app().call('POST', `/api/v2/universal/runs/${runId}/criteria`, L.criteriaBody(run, { 'criterion-1': { status: 'failed', note: '缺少编号' } }, ids('crit', { r: 1, f: 1 })));
  assert.equal(crit.status, 201, crit.text);
  const delivered1 = L.deliveries(run = (await app().call('GET', '/api/v2/universal/runs/' + runId)).json.run, (await page(0, 1000)).artifacts);
  assert.equal(delivered1.filter(x => x.current).length, 1);
  const refused = await app().call('POST', `/api/v2/universal/runs/${runId}/accept`, L.acceptBody(delivered1[0], { confirmCriteria: true, acknowledgeSimulation: true }));
  assert.equal(refused.status, 409); assert.equal(refused.json.code, 'criteria_not_passed');
  const noAck = await app().call('POST', `/api/v2/universal/runs/${runId}/accept`, L.acceptBody(delivered1[0], { confirmCriteria: true }));
  assert.equal(noAck.status, 403); assert.equal(noAck.json.code, 'acceptance_required');
  const from = p.steps[2].step_id, callsBefore = f.state.calls;
  const rb = L.reworkBody(p, { requestId: ids('rework', { r: 1 }), feedback: '编号格式统一', fromStepId: from });
  const rw = await app().call('POST', `/api/v2/universal/runs/${runId}/rework`, rb.body);
  assert.equal(rw.status, 202, rw.text); assert.equal(rw.json.run.round, 2);
  run = await settled(f, runId);
  assert.equal(run.round, 2); assert.equal(f.state.calls - callsBefore, steps - 2, 'only the dependent suffix re-ran');
  const ev2 = (await app().call('GET', `/api/v2/universal/runs/${runId}/events`)).json.events;
  const reworkEv = ev2.find(e => e.raw_type === 'rework_started'); assert.ok(reworkEv);
  await L.pull(page, j, cur, { limit: 50 }); assert.ok(j.state().log.some(l => l.type === 'rework_requested'));
  // Old round file can no longer be accepted.
  const old = await app().call('POST', `/api/v2/universal/runs/${runId}/accept`, L.acceptBody(art1 && { artifact_id: art1.artifactId, sha256: art1.sha256 }, { confirmCriteria: true, acknowledgeSimulation: true }));
  assert.equal(old.status, 409); assert.equal(old.json.code, 'artifact_version_conflict');
  const d2 = await app().call('POST', `/api/v2/universal/runs/${runId}/deliver`, { requestId: ids('deliver', { r: 2 }), format: 'docx' });
  assert.equal(d2.status, 201); assert.equal(d2.json.artifact.round, 2);
  run = (await app().call('GET', '/api/v2/universal/runs/' + runId)).json.run;
  const allPassed = Object.fromEntries(run.projectSnapshot.standards.map((_, i) => ['criterion-' + (i + 1), { status: 'passed' }]));
  assert.equal((await app().call('POST', `/api/v2/universal/runs/${runId}/criteria`, L.criteriaBody(run, allPassed, ids('crit', { r: 2 })))).status, 201);
  const wb = (await page(0, 1000));
  const cur2 = L.deliveries(run = (await app().call('GET', '/api/v2/universal/runs/' + runId)).json.run, wb.artifacts).filter(x => x.current);
  assert.equal(cur2.length, 1); assert.ok(wb.artifacts.some(a => a.artifact_id === art1.artifactId && a.status === 'superseded'), 'round-1 file is marked superseded');
  const ok = await app().call('POST', `/api/v2/universal/runs/${runId}/accept`, L.acceptBody(cur2[0], { confirmCriteria: true, acknowledgeSimulation: true }));
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.run.status, 'approved');
  const accepted = ok.json.run.reviews.at(-1).acceptance;
  assert.equal(accepted.professionalQuality, 'NOT_VERIFIED'); assert.equal(accepted.round, 2); assert.equal(accepted.sha256, cur2[0].sha256);
  await L.pull(page, j, cur, { limit: 50 });
  const fin = j.state(); assert.equal(fin.phase, 'accepted');
  assert.equal(A.view({ plan: p, projection: fin, artifacts: (await page(0, 1000)).artifacts.map(a => C.validateArtifact(a).artifact) }).completed, true);
  const docx = path.join(OUT || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r54-')), 'r54-accepted-round2.docx');
  fs.writeFileSync(docx, await fetch(`http://127.0.0.1:${app().port}${cur2[0].download_url}`, { headers: { cookie: app().cookie } }).then(r => r.arrayBuffer()).then(Buffer.from));
  const parsed = spawnSync('python3', ['-c', 'import sys,docx;print("\\n".join(p.text for p in docx.Document(sys.argv[1]).paragraphs))', docx], { encoding: 'utf8' });
  evidence.flow.happy = { runId, steps, calls: f.state.calls, rounds: 2, acceptedSha: cur2[0].sha256, docxParse: parsed.status === 0 ? (/NOT PROFESSIONALLY VERIFIED/.test(parsed.stdout) ? 'PARSED_WITH_E3_MARK' : 'PARSED') : 'NOT_RUN' };
  if (parsed.status === 0) assert.match(parsed.stdout, /NOT PROFESSIONALLY VERIFIED/);
});

test('E3_FAKE real R53 backend: unknown usage needs explicit acknowledgement; cancel mid-run; expert review note', async t => {
  const f = await bootR53();
  t.after(() => f.stop());
  const app = () => f.app, models = (await app().call('GET', '/api/models')).json.models, ids = L.requestIds('e3b');
  const make = async (goal, domain) => {
    let p = L.fromServerPlan((await app().call('POST', '/api/v2/universal/plan', L.planRequest({ goal, domain, successCriteria: '内容可核对' }))).json, P.plan({ goal, domain, models }).plan, models);
    for (const r of p.roles) p = E.apply(p, { op: 'setRoleGrant', role_id: r.role_id, approved: true }, { models });
    p = E.confirm(p, true);
    const pid = (await app().call('POST', '/api/v2/universal/projects', { project: L.toUniversalProject(p) })).json.project.projectId;
    return { p, pid };
  };
  // Unknown usage (provider reports none).
  f.state.mode = 'unknown';
  const u = await make('为古籍修复档案整理一份修复记录文档', '古籍修复档案');
  const r1 = await app().call('POST', `/api/v2/universal/projects/${u.pid}/runs`, L.approvalBody(u.p, ids('start', 1)));
  let run = await settled(f, r1.json.run.runId); assert.equal(run.cost.unknown, true); assert.equal(run.cost.usd, null);
  const d = await app().call('POST', `/api/v2/universal/runs/${run.runId}/deliver`, { requestId: ids('d', 1), format: 'xlsx' });
  assert.equal(d.status, 201); assert.equal(d.json.artifact.filename.endsWith('.xlsx'), true);
  run = (await app().call('GET', '/api/v2/universal/runs/' + run.runId)).json.run;
  const art = L.deliveries(run, (await app().call('GET', `/api/v2/universal/runs/${run.runId}/workbench`)).json.artifacts).find(a => a.current);
  const noAck = await app().call('POST', `/api/v2/universal/runs/${run.runId}/accept`, L.acceptBody(art, { confirmCriteria: true, acknowledgeSimulation: true }));
  assert.equal(noAck.status, 403); assert.equal(noAck.json.code, 'unknown_cost_ack_required'); assert.match(L.explain(403, noAck.json).human, /费用未知/);
  const withAck = await app().call('POST', `/api/v2/universal/runs/${run.runId}/accept`, L.acceptBody(art, { confirmCriteria: true, acknowledgeSimulation: true, acknowledgeUnknownCost: true }));
  assert.equal(withAck.status, 200, withAck.text);
  // Cancel mid-run: busy only while the server says so; afterwards cancelled, never completed.
  f.state.mode = 'hang';
  const c = await make('为冰雕节写一份游客安全提示文案', '冰雕艺术节');
  const r2 = await app().call('POST', `/api/v2/universal/projects/${c.pid}/runs`, L.approvalBody(c.p, ids('start', 2)));
  for (let i = 0; i < 200 && !f.state.held.length; i++) await f.H.sleep(10);
  const jm = J.createProjector({ mode: 'LIVE', connection: 'connected' });
  await L.pull(async (a, l) => (await app().call('GET', `/api/v2/universal/runs/${r2.json.run.runId}/workbench?after=${a}&limit=${l}`)).json, jm, { cursor: 0 });
  assert.equal(jm.state().phase, 'working');
  assert.equal((await app().call('POST', `/api/v2/universal/runs/${r2.json.run.runId}/cancel`, {})).status, 200);
  f.state.mode = 'ok'; f.release();
  const cancelled = await settled(f, r2.json.run.runId); assert.equal(cancelled.status, 'cancelled');
  const jc = J.createProjector({}); jc.ingest((await app().call('GET', `/api/v2/universal/runs/${cancelled.runId}/workbench`)).json.events);
  assert.equal(jc.state().phase, 'cancelled'); assert.equal(jc.state().busy, false); assert.ok(!Object.values(jc.state().roles).some(r => r.state === 'working'));
  // High-risk goal: acceptance needs a qualified human review note (platform never certifies it).
  const x = await make('为潜水俱乐部编写减压病急救培训讲义', '休闲潜水培训');
  assert.equal(x.p.expert_review_required, true); assert.ok(codes(x.p).includes('HUMAN_EXPERT_REQUIRED'));
  const r3 = await app().call('POST', `/api/v2/universal/projects/${x.pid}/runs`, L.approvalBody(x.p, ids('start', 3)));
  run = await settled(f, r3.json.run.runId);
  await app().call('POST', `/api/v2/universal/runs/${run.runId}/deliver`, { requestId: ids('d', 3), format: 'pptx' });
  run = (await app().call('GET', '/api/v2/universal/runs/' + run.runId)).json.run;
  const a3 = L.deliveries(run, (await app().call('GET', `/api/v2/universal/runs/${run.runId}/workbench`)).json.artifacts).find(a => a.current);
  const ex = await app().call('POST', `/api/v2/universal/runs/${run.runId}/accept`, L.acceptBody(a3, { confirmCriteria: true, acknowledgeSimulation: true }));
  assert.equal(ex.status, 409); assert.equal(ex.json.code, 'expert_review_required');
  const ex2 = await app().call('POST', `/api/v2/universal/runs/${run.runId}/accept`, L.acceptBody(a3, { confirmCriteria: true, acknowledgeSimulation: true, expertReviewNote: '持证潜水教练张三已审阅（用户声明）' }));
  assert.equal(ex2.status, 200, ex2.text); assert.equal(ex2.json.run.reviews.at(-1).acceptance.expertVerification, 'USER_ATTESTATION_NOT_INDEPENDENTLY_VERIFIED');
  evidence.flow.faults = { unknownCostAck: 'required', cancel: cancelled.status, expertNote: 'required' };
  if (OUT) fs.writeFileSync(path.join(OUT, 'r54-node-evidence.json'), JSON.stringify(evidence, null, 2));
});
