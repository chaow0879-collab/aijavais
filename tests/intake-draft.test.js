'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectStore } = require('../lib/project-store');
const { IntakeDraftService } = require('../lib/intake-draft');
const sample = require('./fixtures/ai-draft.cjs');
function fixture(t, { pricing = 'local', invoke, timeoutMs = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-draft-'));
  const store = new ProjectStore({ dir });
  const connection = { connectionId: 'draft-model', modelId: 'MOCK-drafter', protocol: 'openai', baseUrl: pricing === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://mock.invalid/v1',
    enabled: true, ready: true, status: 'available', pricingMode: pricing, updatedAt: 1, capabilities: ['reasoning', 'writing'], displayName: 'Local MOCK fixture' };
  const models = { policy: { localTargets: new Set(['127.0.0.1:11434']) }, get: id => id === connection.connectionId ? connection : null,
    status: id => id === connection.connectionId ? connection.status : 'missing', list: () => [{ ...connection }], key: () => 'secret-fixture-key',
    runtime: id => ({ id, baseUrl: connection.baseUrl, model: connection.modelId, type: connection.protocol }) };
  const calls = [], audits = [], tools = { list: () => [{ toolId: 'builtin:text-stats', executionMode: 'builtin', available: true }] }, skills = { get: () => null };
  const service = new IntakeDraftService({ store, models, tools, skills, timeoutMs, audit: (event, detail) => { audits.push({ event, detail }); },
    callModel: async (runtime, opts) => { calls.push({ runtime, opts }); return invoke ? invoke(runtime, opts) : { text: JSON.stringify(sample()), tokens: 30, inTokens: 20, outTokens: 10, estimated: false, usageComplete: true }; } });
  const input = { description: '请为一个全新的跨领域工作需求设计团队与流程。', connectionId: connection.connectionId, maxTokens: 32000, maxOutputTokens: 2048, maxCost: 1,
    ...(pricing !== 'local' ? { approvePaid: true, price: { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' } } : {}) };
  t.after(async () => { await service.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, input, calls, audits, store, connection };
}
test('AI draft: unapproved remote, unknown-free and disguised remote-local send nothing', t => {
  const f = fixture(t, { pricing: 'paid_api' });
  for (const pricing of ['paid_api', 'free_tier', 'unknown', 'local']) {
    f.connection.pricingMode = pricing;
    assert.throws(() => f.service.generate({ ...f.input, approvePaid: false }), e => e.code === 'paid_approval_required');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.store.listSystemUsage().length, 0);
});
test('AI draft: valid proposal is editable normalized data, server recommendations and no project/run/tools', async t => {
  const f = fixture(t);
  const { status, body } = await f.service.generate(f.input);
  assert.equal(status, 200); assert.equal(body.ok, true);
  assert.equal(body.draft.roles.length, 2); assert.equal(body.draft.roles[0].connectionId, '');
  assert.equal(body.modelRecommendations[0].recommendations[0].connectionId, 'draft-model');
  assert.deepEqual(body.handoffs[1].fromStepIds, ['design']);
  assert.equal(body.skillCheck[0].available, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].opts.maxTokens, 2048); assert.equal(f.calls[0].opts.tools, undefined);
  assert.equal(f.store.listProjects().length, 0); assert.equal(f.store.activeRunCount(), 0);
  assert.ok(body.draft.planning.humanDecisions.length); assert.equal(body.usageRecorded, true);
  const row = f.store.listSystemUsage()[0]; assert.equal(row.kind, 'intake_draft'); assert.equal(row.status, 'completed'); assert.equal(row.tokens, 30); assert.equal(row.cost, 0);
  assert.equal(row.reservedTokens, 0); assert.equal(row.reservedCost, 0);
});
test('AI draft: invalid JSON and invalid/duplicate role or step references are billed but fall back manually', async t => {
  const invalid = [ 'not JSON', '[]', JSON.stringify({ goal: 'Only a goal' }),
    JSON.stringify({ ...sample(), roles: [] }), JSON.stringify({ ...sample(), steps: [] }),
    JSON.stringify({ ...sample(), roles: [sample().roles[0], sample().roles[0]] }),
    JSON.stringify({ ...sample(), steps: [{ ...sample().steps[0], roleId: 'absent' }] }) ];
  let response;
  const f = fixture(t, { invoke: async () => ({ text: response, tokens: 10, inTokens: 6, outTokens: 4, estimated: false }) });
  for (response of invalid) {
    const r = await f.service.generate(f.input); assert.equal(r.status, 422); assert.equal(r.body.code, 'invalid_draft'); assert.equal(r.body.fallback, 'manual'); assert.ok(r.body.fallbackDraft.roles.length);
  }
  assert.equal(f.calls.length, invalid.length); assert.equal(f.store.listSystemUsage().length, invalid.length);
  assert.ok(f.store.listSystemUsage().every(r => r.tokens === 10 && r.status === 'failed'));
  assert.equal(f.store.listProjects().length, 0);
});
test('AI draft: token, amount, output and rate preflight stop before call and ledger dispatch', t => {
  const f = fixture(t, { pricing: 'paid_api' });
  for (const [override, code] of [[{ maxTokens: 1 }, 'token_budget_exceeded'], [{ maxCost: 1e-12 }, 'cost_budget_exceeded'], [{ price: { inputPerMillion: 0, outputPerMillion: 0 } }, 'price_required']]) {
    assert.throws(() => f.service.generate({ ...f.input, ...override }), e => e.code === code);
  }
  assert.throws(() => f.service.generate({ ...f.input, maxOutputTokens: 8193 }));
  assert.equal(f.calls.length, 0); assert.equal(f.store.listSystemUsage().length, 0);
  const estimate = f.service.estimate({ ...f.input, approvePaid: false });
  assert.equal(estimate.requestSent, false); assert.ok(estimate.costBound > 0); assert.equal(f.calls.length, 0);
});
test('AI draft: failure with provider usage charges known cost, failure without usage preserves unknown cost', async t => {
  let known = true;
  const f = fixture(t, { pricing: 'paid_api', invoke: async () => { throw Object.assign(new Error('MOCK failure secret-fixture-key'), known ? { tokens: 7, inTokens: 5, outTokens: 2, estimated: false } : { usageUnknown: true }); } });
  const r = await f.service.generate(f.input); assert.equal(r.status, 502); assert.equal(r.body.usage.cost, 0.000018); assert.ok(!JSON.stringify(r.body).includes('secret-fixture-key'));
  known = false;
  const unknown = await f.service.generate(f.input); assert.equal(unknown.body.usage.cost, null); assert.ok(unknown.body.usage.budgetCost > 0); assert.equal(unknown.body.usage.tokenSource, 'reserved_unknown');
  const rows = f.store.listSystemUsage(); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'failed'));
});
test('AI draft: timeout and explicit owner-scoped cancellation retain billing and never save/run', async t => {
  const f = fixture(t, { pricing: 'paid_api', timeoutMs: 40, invoke: async () => new Promise(() => {}) });
  const timeout = await f.service.generate(f.input); assert.equal(timeout.status, 504); assert.equal(timeout.body.code, 'timeout'); assert.equal(timeout.body.usage.cost, null);
  const requestId = 'explicit-cancel';
  const op = f.service.generate({ ...f.input, requestId }, { ownerId: 'owner-a' });
  while (f.calls.length < 2) await new Promise(r => setTimeout(r, 1));
  assert.equal(f.service.cancel('other-owner', requestId), false);
  assert.equal(f.service.cancel('owner-a', requestId), true);
  const cancelled = await op; assert.equal(cancelled.body.code, 'cancelled'); assert.equal(cancelled.body.requestSent, true); assert.equal(cancelled.body.usage.cost, null);
  assert.equal(f.store.listProjects().length, 0); assert.equal(f.store.activeRunCount(), 0);
});
test('AI draft: model-supplied budget/permissions/connection IDs/commands never enter the draft', async t => {
  const malicious = sample();
  Object.assign(malicious, { approvePaid: true, maxCost: 999, allowedTools: ['*'], status: 'running', ownerId: 'attacker', run: true });
  Object.assign(malicious.roles[0], { connectionId: 'attacker-model', primaryConnectionId: 'attacker', fallbackConnectionIds: ['attacker'] });
  Object.assign(malicious.steps[0], { toolCalls: [{ toolId: 'exec', args: { code: 'bad' } }], skillId: 'attacker', checks: [{ type: 'json' }], approveExternalTools: true });
  const f = fixture(t, { invoke: async () => ({ text: '```json\n' + JSON.stringify(malicious) + '\n```', tokens: 1, inTokens: 1, outTokens: 0 }) });
  const r = await f.service.generate(f.input); assert.equal(r.status, 200);
  const encoded = JSON.stringify(r.body.draft); assert.ok(!encoded.includes('attacker')); assert.ok(!encoded.includes('approvePaid')); assert.ok(!encoded.includes('allowedTools'));
  assert.deepEqual(r.body.draft.steps[0].toolCalls, []); assert.equal(r.body.draft.steps[0].skillId, '');
});
test('AI draft: partial usage and provider overrun cannot masquerade as complete/free billing', async t => {
  let overrun = false;
  const f = fixture(t, { pricing: 'paid_api', invoke: async () => overrun ? { text: JSON.stringify(sample()), tokens: 1000000, inTokens: 999999, outTokens: 1 } : { text: JSON.stringify(sample()), tokens: 5, outTokens: 5, usageComplete: false } });
  const partial = await f.service.generate(f.input); assert.equal(partial.body.usage.cost, null); assert.equal(partial.body.usage.tokenSource, 'provider_partial'); assert.ok(partial.body.usage.budgetCost > 0);
  overrun = true; const over = await f.service.generate(f.input); assert.equal(over.status, 402); assert.equal(over.body.code, 'usage_overrun'); assert.equal(f.store.listProjects().length, 0);
});
test('AI draft: ledger prewrite failure sends no call; settlement failure is visible and retains reservation', async t => {
  const f = fixture(t);
  const record = f.store.recordSystemUsage.bind(f.store); f.store.recordSystemUsage = () => { throw new Error('MOCK disk failure secret-fixture-key'); };
  const stopped = await f.service.generate(f.input); assert.equal(stopped.status, 503); assert.equal(stopped.body.requestSent, false); assert.equal(f.calls.length, 0); assert.equal(f.audits[0].event, 'usage_ledger_write_failed');
  f.store.recordSystemUsage = record; f.store.settleSystemUsage = () => { throw new Error('MOCK settlement failure'); };
  const returned = await f.service.generate(f.input); assert.equal(returned.body.usageRecorded, false); assert.ok(returned.body.usageWarning); assert.equal(f.store.listSystemUsage()[0].status, 'reserved');
  assert.equal(f.calls.length, 1); assert.equal(f.store.listProjects().length, 0);
});
test('AI draft: request deduplication, pre-cancel and shutdown do not create hidden extra calls', async t => {
  const f = fixture(t);
  const input = { ...f.input, requestId: 'one-explicit-call' };
  await f.service.generate(input); assert.throws(() => f.service.generate(input), e => e.code === 'duplicate_request');
  const ctl = new AbortController(); ctl.abort(); assert.throws(() => f.service.generate(f.input, { signal: ctl.signal }), e => e.code === 'cancelled');
  assert.equal(f.calls.length, 1);
  const row = f.store.listSystemUsage()[0]; assert.throws(() => f.store.settleSystemUsage(row.ledgerId, {}), e => e.code === 'usage_settled');
});

test('AUD-AB-001: draft success with unsettled ledger is never full success; cost unknown; no second charge (MOCK)', async t => {
  const f = fixture(t, { pricing: 'paid_api' });
  f.store.settleSystemUsage = () => { throw new Error('MOCK settlement failure'); };
  const input = { ...f.input, requestId: 'unsettled-1' };
  const r = await f.service.generate(input);
  assert.equal(r.status, 202, 'not HTTP 200'); assert.equal(r.body.ok, false); assert.equal(r.body.code, 'usage_unsettled');
  assert.equal(r.body.draftStatus, 'generated'); assert.ok(r.body.draft, 'draft stays viewable'); assert.equal(r.body.billingStatus, 'unrecorded');
  assert.equal(r.body.financiallyComplete, false); assert.equal(r.body.reconciliationRequired, true); assert.equal(r.body.requestSent, true);
  assert.equal(r.body.usage.cost, null, 'remote cost shown as unknown, never 0'); assert.ok(r.body.usage.unbookedComputedCost > 0); assert.ok(r.body.usage.costUpperBound > 0);
  assert.match(r.body.retryWarning, /新的收费请求/); assert.equal(r.body.usageAudited, false, 'fixture audit sink did not confirm, so not claimed');
  assert.match(r.body.usageWarning, /审计事件也未能写入/);
  assert.equal(f.store.listSystemUsage()[0].status, 'reserved', 'reservation kept as evidence'); assert.equal(f.store.listProjects().length, 0);
  // Repeated click / refresh resubmitting the same request ID never sends a second paid call.
  assert.throws(() => f.service.generate(input), e => e.code === 'duplicate_request'); assert.equal(f.calls.length, 1);
  assert.equal(f.audits.filter(a => a.event === 'usage_ledger_write_failed').length, 1); assert.doesNotMatch(JSON.stringify(f.audits), /secret-fixture-key|请为一个全新/);
});

test('AUD-AB-001: audit sink that confirms is reported truthfully; settled call is the only full success (MOCK)', async t => {
  const f = fixture(t, { pricing: 'paid_api' });
  f.service.audit = () => true;
  const settle = f.store.settleSystemUsage.bind(f.store); f.store.settleSystemUsage = () => { throw new Error('MOCK'); };
  const unsettled = await f.service.generate(f.input);
  assert.equal(unsettled.body.usageAudited, true); assert.match(unsettled.body.usageWarning, /已记录审计事件/); assert.equal(unsettled.body.ok, false);
  f.store.settleSystemUsage = settle;
  const ok = await f.service.generate(f.input);
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.billingStatus, 'settled'); assert.equal(ok.body.financiallyComplete, true);
  assert.ok(ok.body.usage.cost > 0, 'known provider usage x user rates'); assert.equal(f.calls.length, 2);
});

test('AUD-AB-001: cancel after dispatch with failed settlement keeps cost unknown and does not retry (MOCK)', async t => {
  let release;
  const f = fixture(t, { pricing: 'paid_api', invoke: (rt, opts) => new Promise((resolve, reject) => { release = resolve; opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { usageUnknown: true }))); }) });
  f.store.settleSystemUsage = () => { throw new Error('MOCK settlement failure'); };
  const input = { ...f.input, requestId: 'cancel-then-fail' };
  const pending = f.service.generate(input, { ownerId: 'admin' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.service.cancel('admin', 'cancel-then-fail'), true);
  const r = await pending;
  assert.equal(r.status, 409); assert.equal(r.body.code, 'cancelled'); assert.equal(r.body.draftStatus, 'failed');
  assert.equal(r.body.requestSent, true); assert.equal(r.body.billingStatus, 'unrecorded'); assert.equal(r.body.financiallyComplete, false);
  assert.equal(r.body.usage.cost, null); assert.equal(r.body.reconciliationRequired, true);
  assert.throws(() => f.service.generate(input), e => e.code === 'duplicate_request'); assert.equal(f.calls.length, 1, 'no automatic second call');
  void release;
});

test('#5-F: ledger failure before dispatch is cost 0; verified local target is cost 0; only a dispatched remote call is unknown (MOCK)', async t => {
  const remote = fixture(t, { pricing: 'paid_api' });
  remote.store.settleSystemUsage = () => { throw new Error('MOCK settlement failure'); };
  const ctl = new AbortController();
  // Abort after the reservation is written but before callModel is invoked: settlement then fails too.
  const origReserve = remote.store.recordSystemUsage.bind(remote.store);
  remote.store.recordSystemUsage = d => { const r = origReserve(d); ctl.abort(); return r; };
  const r = await remote.service.generate(remote.input, { signal: ctl.signal });
  assert.equal(r.body.requestSent, false); assert.equal(remote.calls.length, 0);
  assert.equal(r.body.usage.cost, 0, 'not dispatched => no model cost'); assert.equal(r.body.usage.costSource, 'not_dispatched');
  assert.equal(r.body.reconciliationRequired, false); assert.equal(r.body.financiallyComplete, false, 'ledger still not written');
  const local = fixture(t);
  local.store.settleSystemUsage = () => { throw new Error('MOCK settlement failure'); };
  const l = await local.service.generate(local.input);
  assert.equal(l.status, 202); assert.equal(l.body.requestSent, true); assert.equal(l.body.usage.cost, 0, 'verified local free target is never shown as unknown');
  assert.equal(l.body.draftStatus, 'generated');
  // Note: same-requestId de-duplication covered here is in-process only; cross-restart idempotency is Issue #6.
});
