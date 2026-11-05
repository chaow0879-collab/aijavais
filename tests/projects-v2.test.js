'use strict';
/* Model adapters below are explicit MOCKS. These tests exercise the real SQLite,
 * scheduler, lifecycle, permissions and accounting; no paid API call is made. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { ProjectStore, SCHEMA_VERSION } = require('../lib/project-store');
const { ProjectEngine } = require('../lib/project-engine');

function fixture(t, { callModel, pricing = 'local', tools, skills } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-v2-projects-'));
  const store = new ProjectStore({ dir });
  const connections = [{ connectionId: 'model-a', modelId: 'mock-model', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    displayName: 'Mock adapter fixture', enabled: true, lastTest: { ok: true }, pricingMode: pricing, updatedAt: 1, capabilities: ['writing'] }];
  const models = {
    policy: { localTargets: new Set(['127.0.0.1:11434']) },
    get: id => connections.find(c => c.connectionId === id), list: () => structuredClone(connections), key: () => '',
    status(id) { const c = this.get(id); return !c ? 'missing' : !c.enabled ? 'disabled' : c.lastTest?.ok ? 'available' : 'untested'; },
    runtime(id) { const c = this.get(id); return { id, model: c.modelId, baseUrl: c.baseUrl, type: c.protocol }; },
  };
  const calls = [];
  const invoke = async (p, options) => {
    calls.push({ p, options });
    return callModel ? callModel(p, options) : { text: `Output for ${options.role}: verified MOCK fixture content`, tokens: 15, inTokens: 10, outTokens: 5, estimated: false, ms: 1 };
  };
  const emitted = [];
  const engine = new ProjectEngine({ store, models, callModel: invoke, tools, skills, emit: ev => emitted.push(ev) });
  t.after(async () => { await engine.close(); try { store.close(); } catch { /* tests may close explicitly */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const input = { name: 'Durable multi-role test', description: 'Create and review a documented project using explicit mock adapters.',
    roles: [
      { roleId: 'draft', name: 'Author', duty: 'Draft report', boundary: 'Do not approve your own result', standard: 'Include evidence', connectionId: 'model-a', requiredCapabilities: ['writing'] },
      { roleId: 'review', name: 'Reviewer', duty: 'Review the prior role output', connectionId: 'model-a' },
    ],
    steps: [{ stepId: 'draft', roleId: 'draft', title: 'Draft', checks: [{ type: 'contains', value: 'MOCK' }] }, { stepId: 'review', roleId: 'review', title: 'Review' }],
    standards: ['No fabricated actions'], quantification: [{ label: 'Required sections', selectedText: 'At least three' }], maxReworks: 1 };
  return { store, engine, models, connections, calls, emitted, input, dir };
}

test('V2 SQLite persistence: optimistic versions, real artifact bytes, backups and run isolation', async t => {
  const f = fixture(t);
  const project = f.engine.create(f.input, { ownerId: 'owner-a' });
  assert.equal(project.version, 1);
  assert.equal(project.ownerId, 'owner-a');
  assert.equal(fs.statSync(f.store.filename).mode & 0o777, 0o600);
  assert.throws(() => f.engine.update(project.projectId, { name: 'stale' }, { expectedVersion: 0 }), /version changed/);
  const updated = f.engine.update(project.projectId, { name: 'Edited' }, { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  assert.throws(() => f.engine.update(project.projectId, { roles: [] }, { expectedVersion: 2 }), /roles/);
  const run = f.engine.start(project.projectId);
  const done = await f.engine.wait(run.runId);
  assert.equal(done.status, 'review_required');
  assert.equal(done.steps.length, 2);
  assert.equal(f.store.getSteps(run.runId)[0].output.includes('MOCK'), true);
  const data = f.store.getArtifact(run.runId, done.finalArtifactId);
  assert.ok(Buffer.isBuffer(data.buffer));
  assert.equal(data.buffer.toString(), done.steps[1].output);
  assert.equal(f.store.getArtifact('different-run', done.finalArtifactId), null);
  const backupFile = path.join(f.dir, 'backup.sqlite');
  await f.store.backup(backupFile);
  assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  const saved = new DatabaseSync(backupFile, { readOnly: true });
  assert.equal(saved.prepare('SELECT count(*) n FROM projects').get().n, 1);
  assert.equal(saved.prepare('SELECT count(*) n FROM artifacts').get().n, 3);
  saved.close();
  await assert.rejects(f.store.backup(backupFile), /new file/);
});

test('V2 actual scheduler passes one role output to another and preserves message/usage evidence', async t => {
  const f = fixture(t);
  const project = f.engine.create(f.input);
  assert.equal(f.engine.validate(project.projectId).ok, true);
  const run = f.engine.start(project.projectId);
  const done = await f.engine.wait(run.runId);
  assert.equal(done.status, 'review_required');
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].options.system, /Do not approve your own result/);
  assert.match(f.calls[0].options.system, /At least three/);
  assert.ok(f.calls[1].options.prompt.includes(done.steps[0].output));
  assert.equal(done.steps[0].connectionId, done.steps[1].connectionId);
  assert.notEqual(done.steps[0].agentInstanceId, done.steps[1].agentInstanceId);
  const messages = f.store.getMessages(run.runId);
  assert.equal(messages[0].status, 'consumed');
  assert.equal(messages[1].from, 'draft');
  assert.equal(messages[1].to, 'review');
  assert.equal(messages[2].to, 'human-reviewer');
  assert.equal(messages[2].status, 'delivered');
  assert.equal(done.usage.providerTokens, 30);
  assert.equal(done.usage.estimatedTokens, 0);
  assert.equal(f.store.getUsage(run.runId).length, 2);
  assert.equal(f.emitted.every(e => e.type === 'project_run' && !e.output && !e.prompt), true);
  assert.equal(f.engine.review(run.runId, { decision: 'approve' }).status, 'approved');
  assert.throws(() => f.engine.review(run.runId, { decision: 'approve' }), /awaiting human review/);
});

test('V2 paid and unverified-free labels cannot bypass explicit approval, prices or preflight budgets', async t => {
  const f = fixture(t, { pricing: 'paid_api' });
  const p = f.engine.create(f.input);
  assert.throws(() => f.engine.start(p.projectId), e => e.code === 'paid_approval_required');
  assert.throws(() => f.engine.start(p.projectId, { approvePaid: true, maxCost: 1 }), e => e.code === 'price_required');
  assert.throws(() => f.engine.start(p.projectId, { approvePaid: true, maxCost: 1, prices: { 'model-a': { inputPerMillion: 0, outputPerMillion: 0 } } }), /Zero or unknown/);
  const run = f.engine.start(p.projectId, { approvePaid: true, maxCost: 0.000001, prices: { 'model-a': { inputPerMillion: 3, outputPerMillion: 10 } } });
  const failed = await f.engine.wait(run.runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'cost_budget_exceeded');
  assert.equal(f.calls.length, 0);
  f.connections[0].pricingMode = 'free_tier';
  assert.throws(() => f.engine.start(p.projectId), e => e.code === 'paid_approval_required');
  f.connections[0].pricingMode = 'local';
  f.connections[0].baseUrl = 'https://paid.example.invalid/v1';
  assert.throws(() => f.engine.start(p.projectId), e => e.code === 'paid_approval_required');
});

test('V2 authorized paid MOCK adapter records provider usage and user rate calculation separately', async t => {
  const f = fixture(t, { pricing: 'paid_api' });
  const p = f.engine.create(f.input);
  const run = f.engine.start(p.projectId, { approvePaid: true, maxCost: 1, prices: { 'model-a': { inputPerMillion: 2, outputPerMillion: 4 } } });
  const done = await f.engine.wait(run.runId);
  assert.equal(done.status, 'review_required');
  assert.equal(done.usage.cost, 0.00008);
  assert.equal(f.store.getUsage(run.runId)[0].costSource, 'provider_usage_x_user_rates');
  assert.equal(f.store.getUsage(run.runId)[0].currency, 'USD');
  assert.throws(() => f.engine.review(run.runId, { decision: 'rework', feedback: 'Please correct it' }), e => e.code === 'paid_approval_required');
  assert.equal(f.calls.length, 2);
});

test('V2 changing model configuration after approval blocks later steps before a remote request', async t => {
  let release;
  const f = fixture(t, { callModel: async () => { await new Promise(resolve => { release = resolve; }); return { text: 'MOCK retained output', tokens: 2, inTokens: 1, outTokens: 1, estimated: false }; } });
  const p = f.engine.create(f.input);
  const run = f.engine.start(p.projectId);
  f.connections[0].baseUrl = 'https://remote.example.invalid/v1';
  f.connections[0].pricingMode = 'paid_api';
  f.connections[0].updatedAt = 2;
  release();
  const result = await f.engine.wait(run.runId);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'model_changed');
  assert.equal(f.calls.length, 1);
});

test('V2 review and bounded rework need explicit human action; quality failure retains output', async t => {
  const f = fixture(t);
  const p = f.engine.create(f.input);
  const run = f.engine.start(p.projectId);
  await f.engine.wait(run.runId);
  assert.throws(() => f.engine.review(run.runId, { decision: 'rework' }), /feedback/);
  f.engine.review(run.runId, { decision: 'rework', feedback: 'Strengthen evidence' });
  const revised = await f.engine.wait(run.runId);
  assert.equal(revised.round, 2);
  assert.equal(revised.status, 'review_required');
  assert.equal(revised.steps.length, 4);
  assert.match(f.calls[2].options.prompt, /Strengthen evidence/);
  assert.throws(() => f.engine.review(run.runId, { decision: 'rework', feedback: 'Again' }), e => e.code === 'rework_limit');
  const bad = f.engine.create({ ...f.input, steps: [{ roleId: 'draft', title: 'JSON', checks: [{ type: 'json' }] }] });
  const badRun = f.engine.start(bad.projectId);
  const failed = await f.engine.wait(badRun.runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'quality_failed');
  assert.equal(failed.steps[0].status, 'quality_failed');
  assert.ok(failed.steps[0].artifactId);
});

test('V2 tool permission, real adapter evidence, skill before/after and mandatory checks', async t => {
  const toolCalls = [], phases = [], skillContexts = [];
  const tools = { list: () => [{ toolId: 'builtin:text-stats' }], async call(toolId, args, opts) {
    assert.ok(opts.allowedTools.includes(toolId)); toolCalls.push({ toolId, args, context: opts.context });
    return { toolId, executionMode: 'builtin', content: [{ type: 'text', text: 'actual deterministic adapter result' }] };
  } };
  const skills = { get: id => id === 'evidence' ? { skillId: id } : null, async execute(id, opts) { phases.push(opts.phase); skillContexts.push({ input: opts.input, context: opts.context }); return { skillId: id, ok: true, prompt: 'Skill evidence discipline' }; } };
  const f = fixture(t, { tools, skills });
  const p = f.engine.create({ ...f.input, steps: [
    { roleId: 'draft', title: 'Draft', skillId: 'evidence', toolCalls: [{ toolId: 'builtin:text-stats', args: { text: 'actual text' } }] },
    { roleId: 'review', title: 'Review prior output', skillId: 'evidence', toolCalls: [{ toolId: 'builtin:text-stats', args: {} }] },
  ] });
  assert.throws(() => f.engine.start(p.projectId), e => e.code === 'tool_permission');
  const run = f.engine.start(p.projectId, { allowedTools: ['builtin:text-stats'] });
  const result = await f.engine.wait(run.runId);
  assert.equal(result.status, 'review_required');
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(phases, ['before', 'after', 'before', 'after']);
  assert.equal(toolCalls[0].context.input, p.description);
  assert.equal(toolCalls[1].context.input, result.steps[0].output);
  assert.equal(toolCalls[1].context.runId, run.runId);
  assert.equal(skillContexts[0].context.input, p.description);
  assert.equal(skillContexts[1].context.input, result.steps[0].output);
  assert.equal(skillContexts[2].context.input, result.steps[0].output);
  assert.equal(skillContexts[3].context.input, result.steps[1].output);
  assert.ok(skillContexts.every(x => x.input === x.context.input));
  assert.equal(result.steps[0].toolExecutions[0].executionMode, 'builtin');
  assert.match(f.calls[0].options.system, /Skill evidence discipline/);
  assert.ok(result.artifacts.some(a => a.kind === 'tool-result'));
});

test('V2 cancellation aborts model adapter, stops after-skill tools and preserves unknown reservation', async t => {
  const phases = [];
  const skills = { get: () => ({ skillId: 'evidence' }), async execute(id, opts) { phases.push(opts.phase); return { skillId: id, ok: true, prompt: '' }; } };
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { skills, callModel: (p, opts) => new Promise((resolve, reject) => { entered(); opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { usageUnknown: true })), { once: true }); }) });
  const p = f.engine.create({ ...f.input, steps: [{ roleId: 'draft', title: 'Draft', skillId: 'evidence' }] });
  const run = f.engine.start(p.projectId);
  await entry;
  f.engine.cancel(run.runId);
  const stopped = await f.engine.wait(run.runId);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(phases, ['before']);
  assert.ok(stopped.usage.estimatedTokens > 0);
  assert.equal(f.store.getUsage(run.runId)[0].tokenSource, 'reserved_unknown');
});

test('V2 restart marks pending work interrupted and commits uncertain reservations without replay', t => {
  const f = fixture(t);
  const p = f.engine.create(f.input);
  const run = f.store.createRun(p, { usage: { usedTokens: 0, providerTokens: 0, estimatedTokens: 0, cost: 0, reservedTokens: 123, reservedCost: 0.45 } });
  f.store.close();
  const restored = new ProjectStore({ dir: f.dir });
  t.after(() => restored.close());
  const interrupted = restored.getRun(run.runId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.usage.estimatedTokens, 123);
  assert.equal(interrupted.usage.cost, 0.45);
  assert.equal(interrupted.usage.reservedCost, 0);
  assert.equal(restored.getUsage(run.runId)[0].costSource, 'restart_unknown');
  assert.equal(f.calls.length, 0);
});

test('V2 independent live store instance is denied without mutating the first instance', t => {
  const f = fixture(t);
  const p = f.engine.create(f.input);
  const run = f.store.createRun(p);
  assert.throws(() => new ProjectStore({ dir: f.dir }), e => e.code === 'data_locked');
  const second = spawnSync(process.execPath, ['-e', `const {ProjectStore}=require(${JSON.stringify(path.resolve(__dirname, '../lib/project-store'))});try{new ProjectStore({dir:process.argv[1]});process.exit(2)}catch(e){if(e.code!=='data_locked')throw e;console.log('DENIED')}`, f.dir], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /DENIED/);
  assert.equal(f.store.getRun(run.runId).status, 'running');
});

test('V2 dead-PID lock can be recovered; future database schema fails closed and releases lock', t => {
  const f = fixture(t);
  f.store.close();
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(f.dir, 'projects.sqlite.lock'), JSON.stringify({ pid: Number(child.stdout), token: 'dead-owner' }), { mode: 0o600 });
  const recovered = new ProjectStore({ dir: f.dir });
  assert.equal(recovered.schemaVersion, SCHEMA_VERSION);
  recovered.close();
  const future = new DatabaseSync(path.join(f.dir, 'projects.sqlite'));
  future.exec('PRAGMA user_version=999'); future.close();
  assert.throws(() => new ProjectStore({ dir: f.dir }), e => e.code === 'schema_newer');
  assert.equal(fs.existsSync(path.join(f.dir, 'projects.sqlite.lock')), false);
});

test('V2 cancelled but in-flight model call prevents cascade deletion until accounting settles', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { callModel: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { text: 'MOCK cancelled result', tokens: 5, inTokens: 3, outTokens: 2, estimated: false }; } });
  const p = f.engine.create(f.input);
  const run = f.engine.start(p.projectId);
  await started;
  f.engine.cancel(run.runId);
  assert.throws(() => f.store.deleteProject(p.projectId), e => e.code === 'run_active');
  assert.equal(f.store.activeRunCount(), 1);
  release();
  const stopped = await f.engine.wait(run.runId);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.executionActive, false);
  assert.equal(f.store.getUsage(run.runId)[0].tokens, 5);
  assert.equal(f.store.deleteProject(p.projectId), true);
});

test('V2 known failed provider usage is charged; invalid negative adapter usage keeps unknown reservation', async t => {
  const f = fixture(t, { pricing: 'paid_api', callModel: async () => { throw Object.assign(new Error('provider failed after billing'), { tokens: 9, inTokens: 5, outTokens: 4, estimated: false, usageUnknown: false }); } });
  const p = f.engine.create(f.input);
  const opts = { approvePaid: true, maxCost: 1, prices: { 'model-a': { inputPerMillion: 2, outputPerMillion: 4 } } };
  const run = f.engine.start(p.projectId, opts);
  const failed = await f.engine.wait(run.runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.usage.providerTokens, 9);
  assert.equal(f.store.getUsage(run.runId)[0].failed, true);
  assert.equal(failed.usage.cost, 0.000026);
  const g = fixture(t, { callModel: async () => ({ text: 'MOCK result', tokens: 3, inTokens: -9, outTokens: 12, estimated: false }) });
  const p2 = g.engine.create(g.input);
  const run2 = g.engine.start(p2.projectId);
  const result2 = await g.engine.wait(run2.runId);
  assert.ok(result2.usage.estimatedTokens > 3);
  assert.equal(g.store.getUsage(run2.runId)[0].tokenSource, 'reserved_unknown');
});

test('V2 partial provider usage does not turn unknown input billing into zero cost', async t => {
  const f = fixture(t, { pricing: 'paid_api', callModel: async () => ({ text: 'MOCK partial usage', tokens: 5, inTokens: 0, outTokens: 5, usageComplete: false, estimated: false }) });
  const p = f.engine.create({ ...f.input, steps: [f.input.steps[0]] });
  const run = f.engine.start(p.projectId, { approvePaid: true, maxCost: 1, prices: { 'model-a': { inputPerMillion: 2, outputPerMillion: 4 } } });
  const done = await f.engine.wait(run.runId);
  const usage = f.store.getUsage(run.runId)[0];
  assert.equal(done.status, 'review_required');
  assert.equal(usage.tokenSource, 'provider_partial');
  assert.equal(done.usage.providerTokens, 5);
  assert.ok(done.usage.estimatedTokens > 0);
  assert.ok(usage.budgetTokens > 5);
  assert.ok(done.usage.cost > 0.00002);
  assert.equal(usage.costSource, 'conservative_reservation');
});

test('V2 model/tool readiness and project schema are checked on the server, never plan claims', t => {
  const f = fixture(t);
  const p = f.engine.create({ ...f.input, plan: { readyForAutomatedExecution: true }, requiredToolIds: ['unregistered:tool'] });
  assert.equal(f.engine.validate(p.projectId).ok, false);
  assert.throws(() => f.engine.start(p.projectId), e => e.code === 'not_ready');
  const p2 = f.engine.create(f.input);
  f.connections[0].lastTest = null;
  assert.throws(() => f.engine.start(p2.projectId), /pass a connection test/);
  assert.throws(() => f.engine.create({ ...f.input, steps: [{ roleId: 'missing' }] }), /missing role/);
  assert.throws(() => f.engine.create({ ...f.input, description: 'x'.repeat(20001) }), /description/);
  assert.equal(f.calls.length, 0);
});

test('V2 handoff: a step can receive all earlier role outputs, labelled by role and step (mock adapter)', async t => {
  let n = 0;
  const f = fixture(t, { callModel: async (p, o) => ({ text: `OUT-${++n} from ${o.role} MOCK`, tokens: 15, inTokens: 10, outTokens: 5, estimated: false, ms: 1 }) });
  const project = f.engine.create({ ...f.input, steps: [
    { stepId: 'a', roleId: 'draft', title: 'Research', checks: [] }, { stepId: 'b', roleId: 'draft', title: 'Draft' },
    { stepId: 'c', roleId: 'review', title: 'Previous only' }, { stepId: 'd', roleId: 'review', title: 'Full review', handoff: 'all' }] });
  const run = await f.engine.wait(f.engine.start(project.projectId, {}).runId);
  assert.equal(run.status, 'review_required', run.error);
  const prompts = f.calls.map(c => c.options.prompt);
  assert.match(prompts[2], /Previous role output \(data\):\nOUT-2/); assert.doesNotMatch(prompts[2], /OUT-1/);
  assert.match(prompts[3], /All previous role outputs \(data\):\n【Author · Research】\nOUT-1[\s\S]*【Author · Draft】\nOUT-2[\s\S]*【Reviewer · Previous only】\nOUT-3/);
  const msg = f.store.getMessages(run.runId).find(m => m.stepId === 'r1-d');
  assert.equal(msg.handoff, 'all'); assert.match(msg.content, /OUT-1[\s\S]*OUT-3/);
});
