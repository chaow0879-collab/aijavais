'use strict';
// Actual service dispatch counters, real temporary SQLite; no vendor requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectStore } = require('../lib/project-store');
const { IntakeDraftService } = require('../lib/planner/ai-draft');
const sample = require('./fixtures/ai-draft.cjs');

function fixture(t, invoke) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-durable-draft-'));
  const c = { connectionId: 'model', modelId: 'MOCK', baseUrl: 'https://mock.invalid/v1', protocol: 'openai',
    pricingMode: 'paid_api', updatedAt: 1, enabled: true, status: 'available' };
  const models = { get: () => c, list: () => [c], status: () => 'available', policy: {}, key: () => 'fixture-secret', runtime: () => ({ model: c.modelId }) };
  const input = { requestId: 'durable-id', connectionId: 'model', description: 'Design a general purpose project team.', approvePaid: true,
    maxTokens: 32000, maxOutputTokens: 2048, maxCost: 1, price: { inputPerMillion: 2, outputPerMillion: 4 } };
  let calls = 0, service, store;
  const result = { text: JSON.stringify(sample()), tokens: 30, inTokens: 20, outTokens: 10, estimated: false };
  const start = () => {
    store = new ProjectStore({ dir });
    service = new IntakeDraftService({ store, models, timeoutMs: 1000,
      callModel: async (...args) => { calls++; return invoke ? invoke(...args) : result; } });
  };
  start();
  const f = { input, c, get calls() { return calls; }, get service() { return service; }, get store() { return store; },
    async restart() { await service.close(); store.close(); start(); } };
  t.after(async () => { await service.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('durable draft: concurrent same ID and normalized parameters dispatch exactly once, changed payload rejected', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = f.service.generate(f.input);
  assert.throws(() => f.service.generate({ ...f.input, description: '  ' + f.input.description + '  ', maxTokens: '32000' }), e => e.code === 'duplicate_request');
  assert.throws(() => f.service.generate({ ...f.input, description: 'A different task needs a new team.' }), e => e.code === 'idempotency_key_reused');
  await new Promise(r => setImmediate(r));
  assert.equal(f.calls, 1);
  release({ text: JSON.stringify(sample()), tokens: 1, inTokens: 1, outTokens: 0 });
  assert.equal((await pending).status, 200);
  assert.equal(f.store.listSystemUsage().length, 1);
  assert.throws(() => f.service.generate(f.input), e => e.code === 'duplicate_request' && e.requestState === 'completed');
  assert.equal(f.calls, 1);
});

test('durable draft: successful, failed and unsettled IDs cannot dispatch after restart', async t => {
  for (const mode of ['completed', 'failed', 'unsettled']) {
    const f = fixture(t, async () => mode === 'failed' ? { text: 'bad JSON', tokens: 1, inTokens: 1, outTokens: 0 }
      : { text: JSON.stringify(sample()), tokens: 2, inTokens: 1, outTokens: 1 });
    if (mode === 'unsettled') f.store.settleSystemUsage = () => { throw new Error('MOCK full disk'); };
    const first = await f.service.generate(f.input);
    assert.equal(first.status, mode === 'completed' ? 200 : mode === 'failed' ? 422 : 202);
    await f.restart();
    assert.throws(() => f.service.generate(f.input), e => e.code === 'duplicate_request' && e.requestState === (mode === 'unsettled' ? 'interrupted_unknown' : mode));
    assert.equal(f.calls, 1, mode + ': actual Mock dispatch count');
    const rows = f.store.listSystemUsage(); assert.equal(rows.length, 1);
    if (mode === 'unsettled') { assert.equal(rows[0].cost, null); assert.ok(rows[0].reservedCost > 0); }
  }
});

test('durable draft: params digest binds target snapshot, budget and normalized rates without storing prompts/secrets', async t => {
  const f = fixture(t);
  await f.service.generate(f.input);
  for (const changed of [{ maxCost: 2 }, { maxOutputTokens: 2047 }, { price: { inputPerMillion: 3, outputPerMillion: 4 } }]) {
    assert.throws(() => f.service.generate({ ...f.input, ...changed }), e => e.code === 'idempotency_key_reused');
  }
  f.c.updatedAt = 2;
  assert.throws(() => f.service.generate(f.input), e => e.code === 'idempotency_key_reused');
  const requests = f.store.db.prepare('SELECT * FROM model_requests').all();
  assert.equal(requests.length, 1); assert.equal(requests[0].params_hash.length, 64);
  assert.doesNotMatch(JSON.stringify(requests), /fixture-secret|general purpose|mock.invalid/);
  assert.equal(f.calls, 1);
});

test('durable draft: two owners can use same ID without overwriting active handles; cancel remains owner scoped', async t => {
  const f = fixture(t, (_rt, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('MOCK cancelled')))));
  const a = f.service.generate(f.input, { ownerId: 'a' });
  const b = f.service.generate(f.input, { ownerId: 'b' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.calls, 2);
  assert.equal(f.service.cancel('c', f.input.requestId), false);
  assert.equal(f.service.cancel('a', f.input.requestId), true);
  await a;
  assert.equal(f.service.active.size, 1);
  assert.equal(f.service.cancel('b', f.input.requestId), true);
  await b;
  assert.equal(f.store.listSystemUsage().length, 2);
});

test('durable draft: failed atomic claim rolls back and permits safe same-ID submission with zero extra sends', async t => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER deny_claim BEFORE INSERT ON model_requests BEGIN SELECT RAISE(ABORT,'MOCK claim failure'); END;");
  const noCall = await f.service.generate(f.input);
  assert.equal(noCall.status, 503); assert.equal(noCall.body.requestSent, false); assert.equal(f.calls, 0);
  assert.equal(f.store.listSystemUsage().length, 0);
  f.store.db.exec('DROP TRIGGER deny_claim');
  assert.equal((await f.service.generate(f.input)).status, 200);
  assert.equal(f.calls, 1);
});

test('durable draft: failed dispatch marker sends nothing; settled unsent ID remains blocked after restart', async t => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER deny_dispatch BEFORE UPDATE OF state ON model_requests WHEN NEW.state='dispatching' BEGIN SELECT RAISE(ABORT,'MOCK dispatch failure'); END;");
  const noCall = await f.service.generate(f.input);
  assert.equal(noCall.body.requestSent, false); assert.equal(noCall.body.usage.cost, 0); assert.equal(f.calls, 0);
  assert.equal(f.store.getModelRequest('admin', 'intake_draft', f.input.requestId).state, 'not_dispatched');
  await f.restart();
  assert.throws(() => f.service.generate(f.input), e => e.code === 'duplicate_request');
  assert.equal(f.calls, 0);
});

test('durable draft: 1001 later completed Mock calls never evict an older successful ID', async t => {
  const f = fixture(t);
  await f.service.generate(f.input);
  for (let n = 0; n < 1001; n++) await f.service.generate({ ...f.input, requestId: 'later-' + n });
  assert.equal(f.calls, 1002);
  await f.restart();
  assert.throws(() => f.service.generate(f.input), e => e.code === 'duplicate_request');
  assert.equal(f.calls, 1002, 'zero additional dispatches after 1001 calls and restart');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM system_usage').get().n, 1002);
});

test('durable draft: idempotency lookup disk failure returns503 with no dispatch or raw error exposure', async t => {
  const f = fixture(t);
  f.store.getModelRequest = () => { throw new Error('PRIVATE DB PROMPT fixture-secret'); };
  const r = await f.service.generate(f.input);
  assert.equal(r.status, 503); assert.equal(r.body.code, 'usage_ledger_unavailable'); assert.equal(r.body.requestSent, false);
  assert.equal(f.calls, 0); assert.equal(f.store.listSystemUsage().length, 0);
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE DB|fixture-secret/);
});
