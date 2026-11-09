'use strict';
// R52 (#35) workbench: pure modules (E2) + real server/SQLite/HTTP with a local MOCK model (E3_FAKE).
// No real provider, no paid model, no Secrets: nothing here is E4/E5.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..', '..');
const W = p => require(path.join(ROOT, 'public', 'haloflux-workbench-r52', p));
const C = W('contract.js'), P = W('planner.js'), E = W('editor.js'), J = W('projector.js'), A = W('acceptance.js'), HALO = W('halo.js'), D = W('demo.js');
const F = require('./fixtures.cjs');
const { bootWithMock, finish } = require('./mock-provider.cjs');
const OUT = process.env.R52_OUT || null;
const evidence = { level: 'E2 (pure) + E3_FAKE (real server, local mock model)', blind: {}, e3: {} };
const READY = { connectionId: 'm-local', displayName: 'Local', enabled: true, ready: true, status: 'available', pricingMode: 'local', capabilities: ['reasoning', 'writing', 'data_analysis', 'research', 'vision', 'coding'] };
const PAID = { connectionId: 'm-paid', displayName: 'Paid', enabled: true, ready: true, status: 'available', pricingMode: 'paid', capabilities: ['reasoning', 'writing', 'data_analysis', 'research', 'vision', 'coding'] };
const planFor = (b, extra = {}) => P.plan({ goal: b.goal, domain: b.domain, successCriteria: b.success, ...extra });
const codes = p => p.blocks.map(b => b.code);

test('M1 blind unfamiliar and cross-domain goals produce materially different, honest teams', () => {
  assert.ok(F.BLIND.length >= 6);
  for (const b of F.BLIND) {
    let hits = '';
    try { hits = execFileSync('grep', ['-rl', b.never, path.join(ROOT, 'public'), path.join(ROOT, 'lib'), path.join(ROOT, 'catalog'), path.join(ROOT, 'server.js')], { encoding: 'utf8' }); } catch { hits = ''; }
    assert.equal(hits.trim(), '', b.never + ' must never be enumerated in product source');
  }
  const sigs = new Set();
  const crossRisk = F.BLIND.filter(b => b.expect.highRisk);
  assert.ok(crossRisk.length >= 3, 'at least 3 cross-domain (professional risk) tasks');
  for (const b of F.BLIND) {
    const r = planFor(b, { models: [READY] }); assert.ok(r.ok, b.key);
    const p = r.plan;
    assert.equal(p.simulated, true); assert.equal(p.label, 'SIMULATED'); assert.equal(p.generated_without_model, true);
    for (const o of b.expect.outputs) assert.ok(p.deliverables.some(d => d.kind === o), b.key + ' output ' + o);
    for (const k of b.expect.risk || []) assert.ok(p.human_checkpoints.some(h => h.domain === k), b.key + ' risk ' + k);
    for (const k of b.expect.cannot || []) assert.ok(p.cannot_do.some(c => c.id === k), b.key + ' cannot ' + k);
    assert.equal(p.risk === 'high', b.expect.highRisk, b.key + ' risk level');
    if (b.expect.highRisk) { assert.ok(p.roles.some(r2 => /合规与风险审查员/.test(r2.name))); assert.ok(codes(p).includes('HUMAN_EXPERT_REQUIRED')); }
    assert.ok(p.roles.some(r2 => r2.name === '独立质量复核员'));
    assert.ok(p.roles.every(r2 => r2.model.connection_id === 'm-local' && r2.model.status === 'ready'));
    assert.ok(p.roles.some(r2 => r2.name.includes(b.domain)), 'lead role is named after the user domain, not a template');
    const sig = p.roles.map(r2 => r2.role_id).sort().join(',') + '|' + p.deliverables.map(d => d.kind).sort().join(',');
    sigs.add(sig);
    evidence.blind[b.key] = { goal: b.goal, roles: p.roles.map(r2 => r2.name), deliverables: p.deliverables.map(d => d.label), cannot: p.cannot_do.map(c => c.id), confidence: p.confidence, blocks: codes(p) };
  }
  assert.equal(sigs.size, F.BLIND.length, 'every blind task gets a different team/deliverable signature');
});

test('M1 low information is reported as low confidence and clarification, never as a confident team', () => {
  const p = P.plan({ goal: '帮我弄一下这个事情吧' }).plan;
  assert.equal(p.confidence.level, 'low'); assert.equal(p.status, 'needs_clarification');
  assert.ok(p.cannot_do.some(c => c.id === 'low_confidence'));
  assert.ok(codes(p).includes('NEEDS_CLARIFICATION')); assert.ok(codes(p).includes('NO_MODEL'));
  assert.ok(p.roles[1].name.startsWith('（领域待确认）'), 'no industry is guessed');
  assert.equal(P.plan({ goal: '短' }).ok, false);
  // XSS-looking text is kept as text (rendering uses textContent).
  const x = P.plan({ goal: '<img src=x onerror=alert(1)> 为社区做活动海报', domain: '<b>社区</b>' }).plan;
  assert.ok(x.goal.includes('<img')); assert.ok(x.roles.some(r => r.name.includes('<b>社区</b>')));
});

test('M2 editing: add/remove/rename roles, reorder/retarget steps, models, acceptance — immutable and bounded', () => {
  const b = F.BLIND[0];
  const p0 = planFor(b, { models: [READY, PAID] }).plan;
  const frozen = JSON.stringify(p0);
  let p = E.apply(p0, { op: 'addRole', name: '鸽舍防疫联络员', duty: '对接兽医并记录防疫情况' }, { models: [READY, PAID] });
  assert.equal(JSON.stringify(p0), frozen, 'input plan never mutated');
  const added = p.roles.find(r => r.origin === 'user'); assert.equal(added.role_id, 'custom-1'); assert.ok(p.steps.some(s => s.role_id === 'custom-1'));
  p = E.apply(p, { op: 'editRole', role_id: 'u-scope', name: '赛事需求对接人', boundary: '' });
  assert.equal(p.roles.find(r => r.role_id === 'u-scope').name, '赛事需求对接人');
  const first = p.steps[0].step_id, second = p.steps[1].step_id;
  p = E.apply(p, { op: 'moveStep', step_id: second, delta: -1 }); assert.deepEqual(p.steps.slice(0, 2).map(s => s.step_id), [second, first]);
  p = E.apply(p, { op: 'editStep', step_id: first, title: '确认赛程范围', role_id: 'custom-1' }); assert.equal(p.steps.find(s => s.step_id === first).role_id, 'custom-1');
  p = E.apply(p, { op: 'setModel', role_id: 'custom-1', connection_id: 'm-paid' }, { models: [READY, PAID] });
  assert.equal(p.roles.find(r => r.role_id === 'custom-1').model.status, 'paid_needs_approval'); assert.ok(codes(p).includes('PAID_NOT_APPROVED'));
  p = E.apply(p, { op: 'setModel', role_id: 'custom-1', connection_id: null }); assert.ok(codes(p).includes('NO_MODEL'));
  p = E.apply(p, { op: 'setModel', role_id: 'custom-1', connection_id: 'm-local' }, { models: [READY, PAID] });
  p = E.apply(p, { op: 'editAcceptance', add: '报名须知经俱乐部理事会确认' }); assert.ok(p.acceptance.some(c => c.source === 'user' && c.text.includes('理事会')));
  p = E.apply(p, { op: 'removeRole', role_id: 'u-costing' }); assert.ok(!p.steps.some(s => s.role_id === 'u-costing')); assert.ok(p.warnings.some(w => /核心岗位/.test(w)));
  const bad = [
    [{ op: 'editRole', role_id: 'u-scope', name: '' }, /不能为空/], [{ op: 'editRole', role_id: 'nope', name: 'x' }, /找不到岗位/], [{ op: 'editRole', role_id: 'u-scope', name: 42 }, /必须是文字/],
    [{ op: 'setModel', role_id: 'u-scope', connection_id: '../../etc' }, /不正确/], [{ op: '__proto__' }, /不支持/], [{ op: 'setPermissions', allowed_ops: ['external_publish'] }, /永远不由 AI/],
    [{ op: 'setPermissions', max_cost_usd: -1 }, /0–10000/], [{ op: 'setPermissions', max_cost_usd: 'NaN' }, /0–10000/], [{ op: 'moveStep', step_id: first, delta: 5 }, /上移或下移/]
  ];
  for (const [action, re] of bad) assert.throws(() => E.apply(p, action, { models: [READY] }), re, JSON.stringify(action));
  let full = p; while (full.roles.length < E.MAX.roles) full = E.apply(full, { op: 'addRole', name: '岗位' + full.roles.length });
  assert.throws(() => E.apply(full, { op: 'addRole', name: '超额' }), /最多 12/);
  let single = planFor(b).plan; while (single.roles.length > 1) single = E.apply(single, { op: 'removeRole', role_id: single.roles.at(-1).role_id });
  assert.throws(() => E.apply(single, { op: 'removeRole', role_id: single.roles[0].role_id }), /至少保留/);
  const unknownModel = E.apply(p, { op: 'setModel', role_id: 'u-scope', connection_id: 'ghost' }, { models: [READY] });
  assert.equal(unknownModel.roles.find(r => r.role_id === 'u-scope').model.status, 'unavailable');
});

test('M2 authorization: browser confirmation is required, edits revoke it, paid needs caps, the external op is impossible', () => {
  const b = F.BLIND[3];
  let p = planFor(b, { models: [READY], tools: { docx_generation: { status: 'available', toolId: 'docx_generation' }, xlsx_generation: { status: 'available' }, image_generation: { status: 'needs_setup', howTo: '需配置' }, web_search: { status: 'needs_setup' }, spreadsheet: { status: 'available' }, chart_generation: { status: 'available' } } }).plan;
  let rr = E.runRequest(p); assert.equal(rr.ok, false); assert.equal(rr.code, 'TOOL_NOT_READY', 'real blockers are reported before the missing confirmation');
  p = E.confirm(p, true); rr = E.runRequest(p); assert.equal(rr.ok, false); assert.equal(rr.code, 'TOOL_NOT_READY', rr.reason);
  for (const s of p.steps) for (const t of s.tools) if (t.status !== 'available') p = E.apply(p, { op: 'removeTool', step_id: s.step_id, tool_id: t.tool_id });
  assert.equal(p.permissions.confirmed, false, 'any edit revokes the confirmation');
  assert.equal(E.runRequest(p).code, 'NOT_AUTHORIZED');
  p = E.confirm(p, true); rr = E.runRequest(p); assert.equal(rr.ok, true, rr.reason);
  assert.deepEqual(Object.keys(rr.body).sort(), ['allowedTools', 'approveExternalTools', 'approvePaid', 'maxCost', 'maxOutputTokens', 'maxTokens', 'prices']);
  assert.equal(rr.body.approvePaid, false); assert.equal(rr.body.maxCost, 0);
  p = E.apply(p, { op: 'setModel', role_id: 'u-scope', connection_id: 'm-paid' }, { models: [READY, PAID] }); p = E.confirm(p, true);
  assert.equal(E.runRequest(p).code, 'PAID_NOT_APPROVED');
  p = E.apply(p, { op: 'setPermissions', approve_paid: true, max_cost_usd: 0.5, prices: { 'm-paid': { inputPerMillion: 1, outputPerMillion: 2 } } }); p = E.confirm(p, true);
  rr = E.runRequest(p); assert.equal(rr.ok, true); assert.equal(rr.body.approvePaid, true); assert.equal(rr.body.prices['m-paid'].currency, 'USD');
  assert.ok(!P.OPS.find(o => o.id === 'external_publish').default);
  const noOp = E.apply(p, { op: 'setPermissions', allowed_ops: ['read_materials'] }); assert.ok(codes(E.confirm(noOp, true)).includes('OP_NOT_ALLOWED'));
});

const ev = (seq, type, extra = {}) => F.ev('w', seq, type, extra);
test('M3 projector: IDLE without events, order by seq, duplicates, conflicts, gaps, causality, retraction, unknown types', () => {
  const j = J.createProjector({ clock: () => 0 });
  let s = j.state(0); assert.equal(s.mode, 'IDLE'); assert.equal(s.busy, false); assert.equal(s.phase, 'idle');
  let r = j.ingest([ev(3, 'completed', { role_id: 'a' }), ev(2, 'work_started', { role_id: 'a' })]);
  assert.equal(r.applied, 0); assert.equal(r.buffered, 2); assert.deepEqual(j.state(0).gaps, [{ from: 1, to: 1 }]); assert.equal(j.state(0).busy, false, 'gapped feed never looks busy');
  r = j.ingest([ev(1, 'approved')]); assert.equal(r.applied, 3);
  s = j.state(0); assert.equal(s.roles.a.state, 'completed'); assert.equal(s.roles.a.since_event_id, 'w-e3');
  assert.equal(j.ingest([ev(2, 'work_started', { role_id: 'a' })]).duplicates, 1);
  assert.equal(j.ingest([{ ...ev(2, 'work_started', { role_id: 'a' }), detail: 'tampered' }]).conflicts, 1);
  assert.equal(j.ingest([{ ...ev(2, 'work_started'), event_id: 'other-id' }]).conflicts, 1, 'seq reuse is a conflict');
  assert.equal(j.ingest([{ ...ev(4, 'work_started'), work_id: 'x' }]).otherWork, 1);
  for (const bad of [null, 'x', { ...ev(4, 'x'), schema: 'v0' }, { ...ev(4, 'x'), seq: 0 }, { ...ev(4, 'x'), at: 'never' }, { ...ev(4, 'x'), evidence: 'REAL' }, { ...ev(4, 'x'), role_id: '<script>' }, { ...ev(4, 'retracted') }])
    assert.equal(j.ingest([bad]).rejected, 1, JSON.stringify(bad));
  j.ingest([ev(4, 'work_started', { role_id: 'b', parent_event_id: 'w-e9' }), ev(5, 'mystery_type', { role_id: 'b' }), ev(6, 'blocked', { role_id: 'b' }), ev(7, 'retracted', { retracts: 'w-e6' })]);
  s = j.state(0);
  assert.equal(s.roles.b.state, 'working', 'retracted block is folded away'); assert.ok(s.log.find(l => l.event_id === 'w-e6').retracted);
  assert.equal(s.log.find(l => l.event_id === 'w-e5').recognized, false);
  assert.equal(s.log.find(l => l.event_id === 'w-e4').causality, 'missing_parent');
  assert.deepEqual(s.edges, [{ from: 'a', to: 'b', cause_event_id: 'w-e3', via_event_id: 'w-e4', derived: true }]);
  assert.equal(s.busy, true);
  j.setConnection('disconnected'); s = j.state(0); assert.equal(s.stale, true); assert.equal(s.busy, false, 'disconnected never looks busy'); j.setConnection('connected');
  assert.equal(j.state(10 ** 9).stale, true, 'silence makes the view stale; nothing auto-advances'); assert.equal(j.state(10 ** 9).roles.b.state, 'working');
});

test('M3 projector: role/task cancellation, failure, interruption and unknown cost are never shown as done or $0', () => {
  const j = J.createProjector({});
  j.ingest([ev(1, 'approved'), ev(2, 'work_started', { role_id: 'a' }), ev(3, 'work_started', { role_id: 'b' }), ev(4, 'cancelled', { role_id: 'b' }),
    ev(5, 'cost_reported', { cost: { usd: 0.03, status: 'settled', ledger_id: 'l1' } }), ev(6, 'cost_reported', { cost: { usd: null, status: 'unknown', ledger_id: 'l2' } }),
    ev(7, 'cost_reported', { cost: { usd: 0.03, status: 'settled', ledger_id: 'l1' }, detail: 'replayed ledger row' })]);
  let s = j.state();
  assert.equal(s.roles.b.state, 'cancelled'); assert.equal(s.roles.a.state, 'working');
  assert.equal(s.cost.total_usd, null); assert.equal(s.cost.status, 'unknown'); assert.equal(s.cost.known_usd, 0.03, 'same ledger id counted once'); assert.equal(s.cost.unknown_count, 1);
  j.ingest([ev(8, 'interrupted')]); s = j.state(); assert.equal(s.phase, 'unknown'); assert.equal(s.roles.a.state, 'unknown'); assert.equal(s.busy, false);
  const k = J.createProjector({});
  k.ingest([ev(1, 'approved'), ev(2, 'work_started', { role_id: 'a' }), ev(3, 'cancelled')]);
  assert.equal(k.state().phase, 'cancelled'); assert.equal(k.state().roles.a.state, 'cancelled');
  const u = J.createProjector({}); u.ingest([ev(1, 'cost_reported', { cost: { usd: 0.4, status: 'upper_bound' } })]);
  assert.equal(u.state().cost.total_usd, null); assert.equal(u.state().cost.status, 'not_final');
  assert.equal(C.normalizeCost({ usd: -1, status: 'settled' }).status, 'unknown'); assert.equal(C.normalizeCost({ usd: 5, status: 'unknown' }).usd, null);
});

test('M3 R53 fixture bundle: shuffled, duplicated, retracted, unknown-type and gapped feeds project deterministically', () => {
  const roles = ['u-scope', 'u-lead', 'u-review'];
  const full = F.bundle(roles);
  const a = J.createProjector({}); a.ingest(full.events);
  const b = J.createProjector({}); b.ingest([...full.events].reverse());
  const sa = a.state(0), sb = b.state(0);
  assert.deepEqual(sa.roles, sb.roles, 'arrival order does not change the projection'); assert.deepEqual(sa.edges, sb.edges);
  assert.equal(sa.phase, 'delivered'); assert.equal(sa.roles['u-lead'].state, 'completed'); assert.equal(sa.roles['u-review'].state, 'review', 'retracted block does not stick');
  assert.ok(sa.edges.some(e => !e.derived && e.from === 'u-scope' && e.to === 'u-lead' && e.cause_event_id === 'r53w-e6'));
  assert.equal(sa.cost.total_usd, null);
  const g = J.createProjector({}); g.ingest(F.bundle(roles, { gap: true }).events);
  const sg = g.state(0); assert.deepEqual(sg.gaps, [{ from: 10, to: 10 }]); assert.equal(sg.applied, 9); assert.equal(sg.roles['u-lead'].state, 'working');
  const c = J.createProjector({}); c.ingest(F.bundle(roles, { cancelRole: true }).events); assert.equal(c.state(0).log.find(l => l.seq === 12).type, 'cancelled');
  const art = full.artifacts.map(C.validateArtifact); assert.ok(art.every(x => x.ok)); assert.equal(art[0].artifact.origin, 'fixture');
  for (const bad of [{ ...full.artifacts[0], filename: '../x.svg' }, { ...full.artifacts[0], download_url: 'javascript:alert(1)' }, { ...full.artifacts[0], download_url: 'https://evil.example/x' }]) {
    const v = C.validateArtifact(bad); assert.ok(!v.ok || v.artifact.download_url === null, JSON.stringify(bad).slice(0, 80));
  }
  if (OUT) fs.writeFileSync(path.join(OUT, 'r53-dto-fixture.json'), JSON.stringify(full, null, 2));
});

test('M4 acceptance: "已完成" only with a real server file AND recorded acceptance; mock/fixture files are labelled', () => {
  const plan = planFor(F.BLIND[1]).plan;
  const proj = phase => ({ phase });
  const server = { artifact_id: 'a1', filename: 'x.docx', origin: 'server_artifact', status: 'produced', download_url: '/api/v2/runs/r1/artifacts/a1/download' };
  const mock = { artifact_id: 'a2', filename: 'y.svg', origin: 'fixture', status: 'produced', download_url: 'data:image/svg+xml;base64,AA==' };
  assert.equal(A.view({ plan, projection: proj('idle') }).status, 'none');
  assert.equal(A.view({ plan, projection: proj('accepted'), artifacts: [mock] }).completed, false);
  assert.equal(A.view({ plan, projection: proj('accepted'), artifacts: [mock] }).status, 'accepted_without_file');
  assert.equal(A.view({ plan, projection: proj('accepted'), artifacts: [server] }).completed, true);
  assert.equal(A.view({ plan, projection: proj('delivered'), artifacts: [] }).status, 'delivered_without_file');
  const v = A.view({ plan, projection: proj('delivered'), artifacts: [server, mock], marks: { [plan.acceptance[0].id]: 'failed' } });
  assert.equal(v.mock_files, 1); assert.equal(v.files.find(f => f.mock).label, 'FIXTURE 样例文件'); assert.equal(v.can_accept, false, 'a failed check blocks acceptance'); assert.equal(v.can_rework, true);
  for (const ph of ['cancelled', 'failed', 'unknown']) assert.equal(A.view({ plan, projection: proj(ph), artifacts: [server] }).completed, false, ph);
  assert.equal(A.reworkFeedback(plan, [], '  ').ok, false);
  const fb = A.reworkFeedback(plan, [plan.steps[1].step_id], '学习目标写得不可衡量'); assert.ok(fb.feedback.includes(plan.steps[1].title)); assert.match(fb.note, /新的授权/);
});

test('M3 HALOFLUX layout and demo are traceable and labelled', () => {
  const plan = planFor(F.BLIND[2]).plan;
  const idle = HALO.layout(plan.roles, null, 520); assert.equal(idle.nodes.length, plan.roles.length); assert.ok(idle.nodes.every(n => n.state === 'idle' && !n.source_event_id));
  const j = J.createProjector({ mode: 'DEMO' }); j.ingest(D.demoEvents(plan, 0));
  const s = j.state(0); assert.equal(s.mode, 'DEMO'); assert.deepEqual(s.evidence, ['DEMO']); assert.equal(s.cost.entries, 0);
  assert.ok(D.demoEvents(plan, 0).every(e => e.evidence === 'DEMO' && e.source === 'demo' && e.type !== 'approved' && e.type !== 'accepted'));
  const L = HALO.layout(plan.roles, s, 520);
  for (const n of L.nodes) if (n.state !== 'idle') assert.ok(n.source_event_id, 'every lit node names its source event');
  for (const e of L.edges) assert.ok(e.cause_event_id && e.via_event_id);
  const extra = J.createProjector({}); extra.ingest([F.ev('w', 1, 'work_started', { role_id: 'ghost-role' })]);
  assert.ok(HALO.layout(plan.roles, extra.state(0)).nodes.some(n => n.id === 'ghost-role' && !n.inPlan), 'roles outside the plan are shown, flagged');
  assert.match(HALO.describe(plan.roles, null).head, /IDLE/);
});

test('contract: V2 run view adapter is read-only, ordered, and keeps unknown cost unknown', () => {
  const run = { runId: 'run_abc', status: 'review_required', usage: { cost: 0, reservedCost: 0 },
    events: [{ seq: 41, eventType: 'step_started', stepId: 's1', roleId: 'r1', createdAt: 2 }, { seq: 40, eventType: 'run_started', createdAt: 1 },
      { seq: 42, eventType: 'step_done', stepId: 's1', roleId: 'r1', status: 'done', artifactId: 'art1', createdAt: 3 }, { seq: 43, eventType: 'step_started', stepId: 's2', roleId: 'r2', createdAt: 4 },
      { seq: 44, eventType: 'step_done', stepId: 's2', roleId: 'r2', status: 'quality_failed', createdAt: 5 }, { seq: 45, eventType: 'brand_new_thing', createdAt: 6 }, { seq: 46, eventType: 'review_required', artifactId: 'fin', createdAt: 7 }],
    usageLedger: [{ ledgerId: 'L1', roleId: 'r1', cost: 0, prices: null, createdAt: 3 }, { ledgerId: 'L2', roleId: 'r2', cost: 0.2, costSource: 'conservative_reservation', prices: {}, createdAt: 5 }, { ledgerId: 'L3', cost: null, createdAt: 6 }],
    artifacts: [{ artifactId: 'fin', filename: 'final.md', mime: 'text/markdown', bytes: 10, sha256: 'a'.repeat(64), downloadUrl: '/api/v2/runs/run_abc/artifacts/fin/download' }, { artifactId: 'bad', filename: '../etc/passwd', downloadUrl: '/x' }] };
  const v = C.fromV2Run(run); assert.ok(v.ok);
  assert.deepEqual(v.events.map(e => e.type).slice(0, 7), ['approved', 'work_started', 'completed', 'work_started', 'failed', 'v2.brand_new_thing', 'delivered']);
  assert.deepEqual(v.events.map(e => e.seq), v.events.map((_, i) => i + 1)); assert.ok(v.events.every(e => e.evidence === 'SERVER_RECORDED'));
  assert.equal(v.artifacts.length, 1); assert.equal(v.artifacts[0].origin, 'server_artifact');
  const j = J.createProjector({}); j.ingest(v.events); const s = j.state(0);
  assert.equal(s.roles.r1.state, 'completed'); assert.equal(s.roles.r2.state, 'failed'); assert.equal(s.cost.total_usd, null); assert.equal(s.cost.unknown_count, 1); assert.equal(s.cost.upper_bound_usd, 0.2);
  assert.deepEqual(s.edges.map(e => [e.from, e.to, e.cause_event_id]), [['r1', 'r2', 'v2:run_abc:42']]);
  assert.equal(C.fromV2Run({ runId: '../x' }).ok, false);
});

test('scope: R52 only writes Claude-owned paths; R44 base paths elsewhere are byte-identical', () => {
  let changed;
  try { changed = execFileSync('git', ['diff', '--name-only', '4c198c430806836bb289cd5da57b7fad44c7b0dc', '--', '.'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean); }
  catch (e) { return assert.fail('git history with the R44 base is required: ' + e.message); }
  let untracked = [];
  try { untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { untracked = []; }
  const allowed = [/^public\/project-intake\.html$/, /^public\/project-intake\//, /^public\/haloflux-workbench-r52\//, /^tests\/claude-universal-intake\.test\.js$/, /^tests\/ui\/claude-universal-intake\.e2e\.js$/,
    /^tests\/haloflux-workbench-r52\//, /^docs\/UNIVERSAL-WORKBENCH-R52\.md$/, /^\.github\/workflows\/claude-r52-workbench\.yml$/,
    // R54 (#37) Claude-owned additions on the same frontend lane.
    /^tests\/haloflux-workbench-r54\//, /^docs\/UNIVERSAL-WORKBENCH-R54\.md$/, /^\.github\/workflows\/claude-r54-workbench\.yml$/];
  for (const f of [...changed, ...untracked]) assert.ok(allowed.some(re => re.test(f)), 'R52 must not write ' + f);
  for (const f of ['server.js', 'lib', 'public/panel.html', 'public/workspace.js', 'tools']) assert.ok(!changed.some(c => c === f || c.startsWith(f + '/')), f + ' untouched');
  const app = fs.readFileSync(path.join(ROOT, 'public/haloflux-workbench-r52/app.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(app), 'no HTML string injection in the controller');
  for (const f of fs.readdirSync(path.join(ROOT, 'public/haloflux-workbench-r52'))) {
    const s = fs.readFileSync(path.join(ROOT, 'public/haloflux-workbench-r52', f), 'utf8');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(s), f + ' loads nothing from external hosts');
  }
});

test('E3_FAKE real server: workbench plan → existing APIs → real run events → projection, export, rework, cancel, restart', async t => {
  const f = await bootWithMock();
  t.after(() => f.stop());
  const app = () => f.app;
  const models = (await app().call('GET', '/api/models')).json.models;
  const b = F.BLIND[5];
  // Server truth for tools, from the existing intake API (no model call).
  const sp = await app().call('POST', '/api/v2/intake/plan', { templateId: 'universal', description: b.goal, universal: { domain: b.domain, successCriteria: b.success } });
  assert.equal(sp.status, 200, sp.text); assert.equal(f.state.calls, 0);
  const tools = P.serverTools(sp.json.toolCheck), map = {};
  for (const [k, v] of Object.entries(tools)) if (v.toolId) map[k] = v.toolId;
  let p = P.plan({ goal: b.goal, domain: b.domain, successCriteria: b.success, models, tools }).plan;
  assert.ok(p.roles.every(r => r.model.connection_id === f.model && r.model.status === 'ready'));
  for (const s of p.steps) for (const tl of s.tools) if (tl.status !== 'available') p = E.apply(p, { op: 'removeTool', step_id: s.step_id, tool_id: tl.tool_id }, { models });
  p = E.apply(p, { op: 'moveStep', step_id: p.steps[2].step_id, delta: -1 }, { models });
  p = E.apply(p, { op: 'editRole', role_id: 'u-lead', name: '酒窖经营顾问' }, { models });
  // Not confirmed: the client refuses; nothing is sent.
  assert.equal(E.runRequest(p, map).code, 'NOT_AUTHORIZED');
  const saved = await app().call('POST', '/api/v2/projects', E.toProject(p, map));
  assert.equal(saved.status, 201, saved.text);
  const pid = saved.json.project.projectId;
  assert.deepEqual(saved.json.project.steps.map(s => s.stepId), p.steps.map(s => s.step_id), 'user step order is kept by the existing API');
  assert.equal(saved.json.project.roles.find(r => r.roleId === 'u-lead').name, '酒窖经营顾问');
  assert.equal(f.state.calls, 0, 'saving never calls a model');
  // The server is the authority: tools need an explicit grant even if the browser were bypassed.
  const required = saved.json.project.requiredToolIds;
  if (required.length) {
    const denied = await app().call('POST', '/api/v2/projects/' + pid + '/runs', { maxTokens: 200000, maxOutputTokens: 2000, maxCost: 0 });
    assert.equal(denied.status, 403); assert.equal(denied.json.code, 'tool_permission'); assert.equal(f.state.calls, 0);
  }
  p = E.confirm(p, true);
  const rr = E.runRequest(p, map); assert.ok(rr.ok, rr.reason);
  const started = await app().call('POST', '/api/v2/projects/' + pid + '/runs', { ...rr.body, maxTokens: 200000 });
  assert.equal(started.status, 202, started.text);
  const runId = started.json.run.runId;
  const run = await finish(app(), runId);
  assert.equal(run.status, 'review_required', JSON.stringify(run.error));
  const view = (await app().call('GET', '/api/v2/runs/' + runId)).json.run;
  const v = C.fromV2Run(view); assert.ok(v.ok);
  const j = J.createProjector({ mode: 'LIVE', connection: 'connected' }); j.ingest(v.events);
  let s = j.state();
  assert.equal(s.phase, 'delivered'); assert.ok(p.roles.every(r => s.roles[r.role_id] && s.roles[r.role_id].state === 'completed'));
  assert.equal(s.edges.length, p.steps.length - 1 - p.steps.slice(1).filter((st, i) => st.role_id === p.steps[i].role_id).length);
  assert.equal(s.cost.status, 'settled'); assert.equal(s.cost.total_usd, 0); assert.ok(s.cost.entries >= p.steps.length);
  assert.equal(f.state.calls, p.steps.length, 'one mock call per step, no replay');
  // Real export → real Office bytes, persisted as a server artifact.
  const exp = await fetch(`http://127.0.0.1:${app().port}/api/v2/runs/${runId}/export`, { method: 'POST', headers: { cookie: app().cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${app().port}` }, body: JSON.stringify({ format: 'docx' }) });
  assert.equal(exp.status, 200); const docx = Buffer.from(await exp.arrayBuffer()); assert.equal(docx.subarray(0, 2).toString(), 'PK');
  const v2 = C.fromV2Run((await app().call('GET', '/api/v2/runs/' + runId)).json.run);
  const acc = A.view({ plan: p, projection: s, artifacts: v2.artifacts });
  assert.equal(acc.status, 'awaiting_acceptance'); assert.ok(acc.real_files >= 1); assert.equal(acc.completed, false, 'not completed before the user accepts');
  // Rework = new authorization; then approve.
  const fb = A.reworkFeedback(p, [p.steps[0].step_id], '请把假设单独列出');
  const rw = await app().call('POST', '/api/v2/runs/' + runId + '/review', { decision: 'rework', feedback: fb.feedback, ...rr.body, maxTokens: 400000 });
  assert.equal(rw.status, 200, rw.text);
  await finish(app(), runId);
  const callsAfterRework = f.state.calls; assert.equal(callsAfterRework, p.steps.length * 2);
  const ap = await app().call('POST', '/api/v2/runs/' + runId + '/review', { decision: 'approve', feedback: 'ok' });
  assert.equal(ap.json.run.status, 'approved');
  const done = C.fromV2Run((await app().call('GET', '/api/v2/runs/' + runId)).json.run);
  // Snapshot renumbering: incremental ingest of a newer snapshot conflicts, which is why the UI rebuilds per snapshot.
  const inc = J.createProjector({}); inc.ingest(v.events); const r2 = inc.ingest(done.events);
  assert.ok(r2.conflicts > 0 || inc.state().phase === 'accepted', 'documented: V2 snapshots must be rebuilt, not appended');
  const j2 = J.createProjector({}); j2.ingest(done.events); s = j2.state();
  assert.equal(s.phase, 'accepted'); assert.ok(s.log.some(l => l.type === 'rework_requested'));
  assert.equal(A.view({ plan: p, projection: s, artifacts: done.artifacts }).completed, true);
  evidence.e3.happy = { runId, steps: p.steps.length, events: done.events.length, artifacts: done.artifacts.map(a => [a.filename, a.bytes, a.sha256]), mockCalls: f.state.calls, cost: s.cost };
  // Cancel mid-run: roles that were working become cancelled, never completed.
  f.state.hold = true;
  const c1 = await app().call('POST', '/api/v2/projects/' + pid + '/runs', { ...rr.body, maxTokens: 200000 });
  for (let i = 0; i < 200 && !f.state.held.length; i++) await new Promise(r => setTimeout(r, 10));
  const mid = C.fromV2Run((await app().call('GET', '/api/v2/runs/' + c1.json.run.runId)).json.run);
  const jm = J.createProjector({ mode: 'LIVE', connection: 'connected' }); jm.ingest(mid.events);
  assert.equal(jm.state().busy, true); assert.equal(jm.state().roles[p.steps[0].role_id].state, 'working');
  assert.equal((await app().call('POST', '/api/v2/runs/' + c1.json.run.runId + '/cancel', {})).status, 200);
  f.release();
  const cancelled = await finish(app(), c1.json.run.runId);
  const jc = J.createProjector({}); jc.ingest(C.fromV2Run((await app().call('GET', '/api/v2/runs/' + cancelled.runId)).json.run).events);
  assert.equal(jc.state().phase, 'cancelled'); assert.equal(jc.state().roles[p.steps[0].role_id].state, 'cancelled'); assert.equal(jc.state().busy, false);
  // Crash (SIGKILL) mid-run: startup recovery records run_interrupted; projection is "unknown", nothing replays.
  const c2 = await app().call('POST', '/api/v2/projects/' + pid + '/runs', { ...rr.body, maxTokens: 200000 });
  for (let i = 0; i < 200 && f.state.held.length === 0; i++) await new Promise(r => setTimeout(r, 10));
  const callsBefore = f.state.calls;
  await f.restart({ hard: true }); f.state.held.splice(0);
  const after = (await app().call('GET', '/api/v2/runs/' + c2.json.run.runId)).json.run;
  assert.equal(after.status, 'interrupted');
  const ji = J.createProjector({}); ji.ingest(C.fromV2Run(after).events);
  assert.equal(ji.state().phase, 'unknown'); assert.equal(ji.state().busy, false); assert.equal(ji.state().roles[p.steps[0].role_id].state, 'unknown');
  await new Promise(r => setTimeout(r, 200)); assert.equal(f.state.calls, callsBefore, 'no automatic replay after restart');
  // Graceful shutdown mid-run. The R52 backend marked the run cancelled WITHOUT an event; R53 (229c766,
  // lib/project-engine.js shutdown) closed that gap and now records run_cancelled{reason:server_shutdown}.
  // The projection must come from that real server event, with no derived status event added on top.
  const c3 = await app().call('POST', '/api/v2/projects/' + pid + '/runs', { ...rr.body, maxTokens: 200000 });
  for (let i = 0; i < 200 && f.state.held.length === 0; i++) await new Promise(r => setTimeout(r, 10));
  await f.restart(); f.state.held.splice(0); f.state.hold = false;
  const shut = (await app().call('GET', '/api/v2/runs/' + c3.json.run.runId)).json.run;
  assert.equal(shut.status, 'cancelled');
  const shutEvent = shut.events.find(e => e.eventType === 'run_cancelled');
  assert.ok(shutEvent, 'server records a run_cancelled event on graceful shutdown'); assert.equal(shutEvent.reason, 'server_shutdown');
  const ds = C.fromV2Run(shut);
  assert.ok(!ds.events.some(e => e.event_id.startsWith('v2-status:')), 'no derived status event when the server recorded one');
  const jd = J.createProjector({}); jd.ingest(ds.events); assert.equal(jd.state().phase, 'cancelled'); assert.equal(jd.state().busy, false);
  assert.notEqual(jd.state().roles[p.steps[0].role_id].state, 'working');
  // Adapter fallback stays covered for older/partial snapshots: SAME real run with its cancel event removed
  // (synthetic, labelled) still yields exactly one explicitly derived cancelled event.
  const gap = C.fromV2Run({ ...shut, events: shut.events.filter(e => e.eventType !== 'run_cancelled') });
  const derived = gap.events.filter(e => e.event_id.startsWith('v2-status:'));
  assert.equal(derived.length, 1); assert.equal(derived[0].type, 'cancelled'); assert.match(derived[0].detail, /服务器未记录对应事件/);
  const jg = J.createProjector({}); jg.ingest(gap.events); assert.equal(jg.state().phase, 'cancelled'); assert.equal(jg.state().busy, false);
  evidence.e3.faults = { cancelled: cancelled.status, interrupted: after.status, gracefulShutdown: { status: shut.status, serverEvent: shutEvent.eventType, reason: shutEvent.reason, derivedEventOnSyntheticGap: derived[0].event_id } };
  if (OUT) fs.writeFileSync(path.join(OUT, 'r52-node-evidence.json'), JSON.stringify(evidence, null, 2));
});
