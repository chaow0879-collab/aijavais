'use strict';
// #9 P2-01/02/04 (#14 package 2): capability labels reflect the CURRENT
// connection state; AI tool suggestions are never permissions. Real
// ModelRegistry, real v2 API handler, real SQLite in a temp dir, local HTTP.
// No model is called (planning never dispatches) and nothing is charged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const SEC = require('../lib/security');
const { ModelRegistry } = require('../lib/models');
const { createV2Api } = require('../lib/v2-api');
const { validateDraft } = require('../lib/intake-draft');
const sample = require('./fixtures/ai-draft.cjs');
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'providers.v1.json'), 'utf8'));
const ENV = { LOCAL_MODEL_TARGETS: '127.0.0.1:11434' };
const SOFTWARE = require('../public/project-intake/catalog.v1.json').templates.find(t => t.id === 'software-development');
const roleMap = id => Object.fromEntries(SOFTWARE.roles.map(r => [r.id, id]));
const registry = (env = ENV) => new ModelRegistry({ catalog: CATALOG, policy: SEC.policyFromEnv(env), env });
function localModel(r) {
  const added = r.add({ providerId: 'ollama', modelId: 'MOCK-local', displayName: 'Local MOCK', baseUrl: 'http://127.0.0.1:11434/v1', pricingMode: 'local', capabilities: ['reasoning', 'writing'] });
  assert.ok(added.ok, added.error); return added.connection.connectionId;
}

test('P2-01/04 registry: verified labels are current state; history is reported separately and never as verified', () => {
  const r = registry();
  const id = localModel(r);
  const states = [];
  const snap = label => { const c = r.getCapabilities(id); states.push({ label, status: r.status(id), verified: c.verified, historical: c.historicalProbe }); return c; };
  assert.deepEqual(snap('never tested').verified, []);
  r.recordTest(id, { ok: true, ms: 5 });
  const ok = snap('tested+recorded'); assert.deepEqual(ok.verified, ['chat']); assert.equal(ok.currentStatus, 'available'); assert.ok(ok.verifiedAt);
  r.setEnabled(id, false);
  const disabled = snap('disabled after success');
  assert.deepEqual(disabled.verified, [], 'disabled connection has no current capability'); assert.equal(disabled.currentStatus, 'disabled');
  assert.equal(disabled.historicalProbe.ok, true, 'history kept, labelled as history'); assert.match(disabled.note, /历史测试结果不代表当前可用/);
  r.setEnabled(id, true); assert.deepEqual(snap('re-enabled').verified, ['chat']);
  r.recordTest(id, { ok: true, ms: 5, usageRecorded: false });
  const unrecorded = snap('success but usage not recorded');
  assert.deepEqual(unrecorded.verified, []); assert.equal(unrecorded.historicalProbe.usageRecorded, false); assert.match(unrecorded.note, /未完整记账/);
  r.recordTest(id, { ok: false, error: 'MOCK refused' }); assert.deepEqual(snap('failed probe').verified, []);
  // Remote connection whose key comes from an env var that is absent => not ready.
  const remote = r.add({ providerId: 'custom', modelId: 'm', baseUrl: 'https://gw.example.com/v1', envKey: 'AIJ_TEST_ABSENT_KEY', displayName: 'Not ready' });
  assert.ok(remote.ok, remote.error);
  r.recordTest(remote.connection.connectionId, { ok: true, ms: 1 }); // historical success, key since unavailable
  const notReady = r.getCapabilities(remote.connection.connectionId);
  assert.equal(notReady.currentStatus, 'not_ready'); assert.deepEqual(notReady.verified, []);
  // Target change invalidates the old probe.
  r.recordTest(id, { ok: true, ms: 5 }); assert.deepEqual(r.getCapabilities(id).verified, ['chat']);
  assert.ok(r.update(id, { baseUrl: 'http://127.0.0.1:11434/v2' }).ok);
  assert.deepEqual(r.getCapabilities(id).verified, [], 'stale snapshot after target change is not verified');
  test.diagnostic?.(JSON.stringify(states));
});

async function apiFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-captruth-'));
  const models = registry();
  let dispatches = 0;
  const api = createV2Api({ dir, models, teams: { list: () => [] }, emit: () => {}, callModel: async () => { dispatches++; throw new Error('planning must not call a model'); } });
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json' }); res.end(b); };
  const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(JSON.parse(b || '{}'))); });
  const server = http.createServer(async (req, res) => { if (!(await api.handle(req, res, new URL(req.url, 'http://x'), { readBody, json, user: { userId: 'admin-cap' } }))) json(res, 404, {}); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (method, p, body) => { const r = await fetch('http://127.0.0.1:' + server.address().port + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  return { models, call, api, dispatches: () => dispatches };
}

test('P2-01/04 HTTP planFrom: free-only plans accept a local model only while it is CURRENTLY verified (enabled, ready, recorded probe)', async t => {
  const f = await apiFixture(t);
  const id = localModel(f.models);
  const plan = async () => {
    const r = await f.call('POST', '/api/v2/intake/plan', { templateId: 'software-development', description: '实现一个带测试的命令行小工具并写说明。', budgetMode: 'free_only',
      assignments: roleMap(id) });
    assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.plan;
  };
  const freeIssue = p => p.modelIssues.some(x => /尚未确认免费资格/.test(x));
  const matrix = [];
  f.models.recordTest(id, { ok: true, ms: 3 });
  let p = await plan(); matrix.push(['available', freeIssue(p)]); assert.equal(freeIssue(p), false, 'verified local loopback target is free-eligible');
  f.models.recordTest(id, { ok: true, ms: 3, usageRecorded: false });
  p = await plan(); matrix.push(['unrecorded probe', freeIssue(p)]); assert.equal(freeIssue(p), true, 'old code trusted lastTest.ok here');
  f.models.recordTest(id, { ok: true, ms: 3 }); f.models.setEnabled(id, false);
  p = await plan(); matrix.push(['disabled', freeIssue(p)]); assert.equal(freeIssue(p), true);
  assert.ok(p.modelIssues.some(x => /已停用或尚未就绪/.test(x))); assert.equal(p.readyForAutomatedExecution, false);
  f.models.setEnabled(id, true);
  p = await plan(); matrix.push(['re-enabled', freeIssue(p)]); assert.equal(freeIssue(p), false);
  // Client-supplied "verified" models and tools are ignored; server registry is authoritative.
  const spoof = await f.call('POST', '/api/v2/intake/plan', { templateId: 'software-development', description: '实现一个带测试的命令行小工具并写说明。', budgetMode: 'free_only',
    assignments: roleMap('ghost'), availableModels: [{ connectionId: 'ghost', enabled: true, ready: true, verifiedCapabilities: ['coding', 'reasoning'], localityVerified: true, pricingMode: 'local' }] });
  t.diagnostic(JSON.stringify(spoof.json.plan.modelIssues));
  assert.ok(spoof.json.plan.modelIssues.some(x => /未检测到所选模型连接/.test(x)));
  assert.equal(f.dispatches(), 0, 'planning never calls a model');
  t.diagnostic(JSON.stringify(matrix));
});

test('P2-02 AI tool suggestions are structured requirements, never permissions; saving grants nothing; runs still demand explicit grants', async t => {
  const f = await apiFixture(t);
  const id = localModel(f.models); f.models.recordTest(id, { ok: true, ms: 3 });
  const malicious = sample();
  Object.assign(malicious, { tools: ['builtin:text-stats', 'code_execution', 'web_search', 'definitely-not-a-tool'], allowedTools: ['*'], toolPermissions: { granted: ['*'] },
    toolRecommendations: [{ toolId: 'code_execution', permission: 'granted' }], approveExternalTools: true, approvePaid: true });
  const tools = { list: () => f.api.tools.list() };
  const out = validateDraft(JSON.stringify(malicious), '恶意工具字段污染测试，确认不会越权。', { models: f.models, tools, skills: { get: () => null } });
  assert.deepEqual(out.toolPermissions.granted, []); assert.equal(out.toolPermissions.approveExternalTools, false);
  const byId = Object.fromEntries(out.toolRecommendations.map(x => [x.intakeId, x]));
  assert.equal(byId['builtin:text-stats'].verification, 'registered_available'); assert.equal(byId['builtin:text-stats'].permission, 'not_granted');
  assert.equal(byId['definitely-not-a-tool'].verification, 'unverified'); assert.equal(byId['definitely-not-a-tool'].highRisk, true);
  assert.equal(byId.web_search.verification, 'unverified');
  for (const rec of out.toolRecommendations) { assert.equal(rec.source, 'ai_suggestion'); assert.equal(rec.approval, 'needs_approval_per_run'); }
  assert.ok(!JSON.stringify(out.draft).includes('"*"'), 'model wildcard never enters the draft');
  // Save through the real API exactly as the browser does, with forged permission fields appended.
  const body = { ...out.draft, allowedTools: ['*', 'builtin:text-stats'], approval: { allowedTools: ['*'] }, toolPermissions: { granted: ['*'] },
    planning: { ...out.draft.planning, recommendedTools: [{ toolId: 'code_execution', permission: 'granted' }] } };
  body.roles = body.roles.map(r => ({ ...r, connectionId: id }));
  const saved = await f.call('POST', '/api/v2/projects', body);
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const project = saved.json.project;
  for (const k of ['allowedTools', 'approval', 'toolPermissions']) assert.equal(project[k], undefined, k + ' is not persisted');
  assert.equal(project.planning.recommendedTools, undefined);
  assert.deepEqual(project.requiredToolIds.includes('builtin:text-stats'), true, 'requirement kept for honest validation');
  const runs = (await f.call('GET', '/api/v2/projects/' + project.projectId)).json.runs; assert.deepEqual(runs, [], 'saving never starts a run');
  // Even with the unknown tools removed, a run without an explicit per-run grant is refused before any model call.
  const cleaned = { ...project, requiredToolIds: ['builtin:text-stats'], expectedVersion: project.version };
  assert.equal((await f.call('PUT', '/api/v2/projects/' + project.projectId, cleaned)).status, 200);
  const denied = await f.call('POST', '/api/v2/projects/' + project.projectId + '/runs', { maxTokens: 32000, maxCost: 0 });
  assert.equal(denied.status, 403); assert.equal(denied.json.code, 'tool_permission');
  assert.equal(f.dispatches(), 0);
});
