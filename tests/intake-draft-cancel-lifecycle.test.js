'use strict';
// #7 / AUD-AB-003 / #14 package 1: user request lifecycle vs. underlying model
// call lifecycle. All model adapters are local MOCKs or a local HTTP fixture;
// no real vendor is contacted and nothing is charged. Ground truth for
// "in flight" comes from the adapter's own counters (tests/fixtures/
// lifecycle-provider.cjs), never from the service's wrapper promises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ProjectStore } = require('../lib/project-store');
const { IntakeDraftService, MAX_SLOTS } = require('../lib/intake-draft');
const { createV2Api } = require('../lib/v2-api');
const { controlledProvider, hangingHttpProvider, httpCallModel, okResult } = require('./fixtures/lifecycle-provider.cjs');

const PRICE = { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' };
function models(pricing = 'paid_api') {
  const connection = { connectionId: 'draft-model', modelId: 'MOCK-drafter', protocol: 'openai', baseUrl: pricing === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://mock.invalid/v1',
    enabled: true, ready: true, status: 'available', pricingMode: pricing, updatedAt: 1, capabilities: ['reasoning', 'writing'], displayName: 'MOCK' };
  return { connection, policy: { localTargets: new Set(['127.0.0.1:11434']) }, get: id => id === connection.connectionId ? connection : null,
    status: id => id === connection.connectionId ? connection.status : 'missing', list: () => [{ ...connection }], key: () => 'secret-fixture-key',
    runtime: id => ({ id, baseUrl: connection.baseUrl, model: connection.modelId, type: connection.protocol }) };
}
function fixture(t, { mode = 'ignore', timeoutMs = 60000, abortGraceMs = 20, closeGraceMs = 50, pricing = 'paid_api', dir } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-cancel-'));
  const store = new ProjectStore({ dir });
  const provider = controlledProvider({ mode });
  const audits = [];
  const m = models(pricing);
  const service = new IntakeDraftService({ store, models: m, tools: { list: () => [] }, skills: { get: () => null }, callModel: provider.callModel,
    timeoutMs, abortGraceMs, closeGraceMs, audit: (event, detail) => { audits.push({ event, detail }); return true; } });
  let closed = false;
  const cleanup = async () => {
    if (closed) return; closed = true;
    for (const c of provider.pending()) c.resolve();
    await service.close(); store.close();
  };
  t.after(async () => { await cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  const input = (requestId, extra = {}) => ({ description: '请为一个全新的跨领域工作需求设计团队与流程。', connectionId: 'draft-model', maxTokens: 32000, maxOutputTokens: 2048, maxCost: 1,
    ...(pricing === 'local' ? {} : { approvePaid: true, price: PRICE }), requestId, ...extra });
  const rows = () => store.db.prepare("SELECT r.request_id requestId, r.state, s.doc FROM model_requests r JOIN system_usage s ON s.id=r.ledger_id ORDER BY s.created_at, s.rowid")
    .all().map(r => ({ requestId: r.requestId, state: r.state, ...JSON.parse(r.doc) }));
  const evidence = label => ({ label, started: provider.metrics.started, underlyingInFlight: provider.metrics.underlyingInFlight,
    peakUnderlyingInFlight: provider.metrics.peakUnderlyingInFlight, callModelCount: provider.calls.length, ...service.stats(),
    ledger: rows().map(r => ({ requestId: r.requestId, state: r.state, status: r.status, cost: r.cost ?? null })) });
  return { dir, store, provider, service, audits, input, rows, evidence, cleanup, models: m };
}
const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(t, value) { t.diagnostic(JSON.stringify(value)); }

test('TC7-01 non-cooperative cancel: underlying peak stays <= 3; 4th request is refused until a real call ends (MOCK)', async t => {
  const f = fixture(t, { mode: 'ignore' });
  assert.equal(MAX_SLOTS, 3);
  const ops = ['a', 'b', 'c'].map(id => f.service.generate(f.input(id), { ownerId: 'owner' }));
  await f.provider.until(() => f.provider.metrics.started === 3, 'three dispatches');
  assert.equal(f.provider.metrics.underlyingInFlight, 3);
  for (const id of ['a', 'b', 'c']) assert.equal(f.service.cancel('owner', id), true);
  const answered = await Promise.all(ops);
  for (const r of answered) {
    assert.equal(r.status, 409); assert.equal(r.body.code, 'cancelled'); assert.equal(r.body.billingStatus, 'dispatch_outstanding');
    assert.equal(r.body.requestSent, true); assert.equal(r.body.usage.cost, null, 'dispatched + unconfirmed => unknown, never 0');
    assert.ok(r.body.usage.costUpperBound > 0); assert.ok(r.body.ledgerId); assert.equal(r.body.financiallyComplete, false);
    assert.equal(r.body.providerMayStillBill, true);
  }
  // Outer wrappers are finished, but the provider still has three calls running.
  assert.equal(f.provider.metrics.underlyingInFlight, 3);
  const before = f.evidence('after cancelling three non-cooperative calls'); log(t, before);
  assert.equal(before.activeRequests, 0); assert.equal(before.activeSlots, 3); assert.equal(before.outstandingAfterResponse, 3);
  assert.ok(f.rows().every(r => r.state === 'dispatching' && r.status === 'reserved'), 'reservation evidence retained, nothing settled early');
  // Immediately and repeatedly try to send more work: refused, nothing dispatched, no ledger rows.
  for (let i = 0; i < 5; i++) {
    assert.throws(() => f.service.generate(f.input('fourth-' + i), { ownerId: 'owner' }), e => e.code === 'draft_busy' && e.status === 429);
    await tick();
  }
  assert.equal(f.provider.metrics.started, 3); assert.equal(f.provider.metrics.peakUnderlyingInFlight, 3);
  assert.equal(f.rows().length, 3, 'refused requests never claim or reserve');
  // A real underlying completion releases exactly one slot and settles exactly once with the real usage.
  f.provider.calls[0].resolve(okResult());
  await f.provider.until(() => f.service.stats().activeSlots === 2, 'one slot released');
  const late = f.rows().find(r => r.requestId === 'a');
  assert.equal(late.status, 'failed'); assert.equal(late.errorCode, 'cancelled'); assert.equal(late.lateSettlement, true);
  assert.equal(late.cost, 0.00008, 'real provider usage x user rates once the call truly ended'); assert.equal(late.state, 'failed');
  const fourth = f.service.generate(f.input('fourth-ok'), { ownerId: 'owner' });
  await f.provider.until(() => f.provider.metrics.started === 4, 'fourth dispatch');
  assert.throws(() => f.service.generate(f.input('fifth'), { ownerId: 'owner' }), e => e.code === 'draft_busy');
  f.provider.calls[3].resolve(okResult());
  assert.equal((await fourth).status, 200);
  // Remaining orphans end: one with unknown usage (stays null), one normally.
  f.provider.calls[1].reject(Object.assign(new Error('MOCK stream broke'), { usageUnknown: true }));
  f.provider.calls[2].resolve(okResult());
  await f.provider.until(() => f.service.stats().activeSlots === 0, 'all slots released');
  const after = f.evidence('after all underlying calls really ended'); log(t, after);
  assert.equal(after.peakUnderlyingInFlight, 3); assert.equal(f.provider.metrics.peakUnderlyingInFlight, 3);
  assert.equal(after.callModelCount, 4); assert.equal(after.lateSettlements, 3);
  const b = f.rows().find(r => r.requestId === 'b');
  assert.equal(b.cost, null); assert.equal(b.needsReconciliation, true); assert.equal(b.state, 'failed');
  assert.equal(f.rows().length, 4); assert.ok(f.rows().every(r => r.status !== 'reserved'));
  // A settled ledger row can never be settled again.
  assert.throws(() => f.store.settleSystemUsage(b.ledgerId, { requestSent: true }), e => e.code === 'usage_settled');
});

test('TC7-01 repeated cancel/resubmit storms and a second click on the same ID never exceed 3 or re-dispatch (MOCK)', async t => {
  const f = fixture(t, { mode: 'ignore' });
  let n = 0, refused = 0;
  for (let round = 0; round < 4; round++) {
    const ids = [];
    while (f.service.stats().activeSlots < 3) { const id = 'storm-' + n++; ids.push(id); f.service.generate(f.input(id), { ownerId: 'owner' }); }
    await f.provider.until(() => f.provider.metrics.underlyingInFlight === 3, 'three in flight');
    for (const id of ids) f.service.cancel('owner', id);
    // User clicks again with the SAME request ID: durable duplicate, no new call.
    for (const id of ids) assert.throws(() => f.service.generate(f.input(id), { ownerId: 'owner' }), e => ['duplicate_request', 'draft_busy'].includes(e.code));
    for (let i = 0; i < 3; i++) { try { f.service.generate(f.input('storm-new-' + round + '-' + i), { ownerId: 'owner' }); } catch (e) { assert.equal(e.code, 'draft_busy'); refused++; } }
    assert.ok(f.provider.metrics.underlyingInFlight <= 3);
    // Finish the oldest pending provider call; capacity returns only now.
    f.provider.pending()[0].resolve(okResult());
    await f.provider.until(() => f.service.stats().activeSlots <= 2, 'slot released');
    for (const c of f.provider.pending()) c.resolve(okResult());
    await f.provider.until(() => f.service.stats().activeSlots === 0, 'idle');
  }
  log(t, f.evidence('storm summary'));
  assert.equal(f.provider.metrics.peakUnderlyingInFlight, 3); assert.equal(refused, 12);
  assert.equal(f.provider.metrics.started, f.rows().length, 'every dispatch has exactly one ledger row');
  assert.ok(f.rows().every(r => r.state === 'failed' && r.settledAt), 'each cancelled call settled exactly once after it truly ended');
  // After the storm the service admits new work (no permanent lockout / livelock).
  const ok = f.service.generate(f.input('after-storm'), { ownerId: 'owner' });
  await f.provider.until(() => f.provider.pending().length === 1, 'admitted'); f.provider.pending()[0].resolve(okResult());
  assert.equal((await ok).status, 200);
});

test('TC7-02 timeout: provider ignores the signal; outer 504, slot kept, cost null with bound, no automatic resend (MOCK)', async t => {
  const f = fixture(t, { mode: 'ignore', timeoutMs: 30 });
  const started = Date.now();
  const r = await f.service.generate(f.input('timeout-1'), { ownerId: 'owner' });
  assert.ok(Date.now() - started < 1000, 'answered promptly after the timeout');
  assert.equal(r.status, 504); assert.equal(r.body.code, 'timeout'); assert.equal(r.body.usage.cost, null); assert.ok(r.body.usage.costUpperBound > 0);
  assert.equal(r.body.billingStatus, 'dispatch_outstanding'); assert.equal(r.body.requestId, 'timeout-1'); assert.ok(r.body.ledgerId);
  await sleep(60);
  assert.equal(f.provider.metrics.started, 1, 'never retried or replayed'); assert.equal(f.service.stats().activeSlots, 1);
  assert.equal(f.rows()[0].state, 'dispatching');
  log(t, f.evidence('timeout outstanding'));
  // Late completion with partial usage keeps cost unknown (never 0) and the conservative budget figure.
  f.provider.calls[0].resolve({ text: 'late', tokens: 5, outTokens: 5, usageComplete: false });
  await f.provider.until(() => f.service.stats().activeSlots === 0, 'released');
  const row = f.rows()[0];
  assert.equal(row.errorCode, 'timeout'); assert.equal(row.cost, null); assert.ok(row.budgetCost > 0); assert.equal(row.needsReconciliation, true);
  assert.equal(f.provider.metrics.started, 1);
});

test('TC7-04 cancel/resolve races: every interleaving settles one ledger row once, never invents 0 or double charges (MOCK)', async t => {
  const f = fixture(t, { mode: 'ignore' });
  const cases = [];
  // 1. resolve-before-cancel with the event loop flushed: normal success, cancel finds nothing.
  {
    const op = f.service.generate(f.input('race-resolve-first'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.pending().length === 1, 'dispatch');
    f.provider.pending()[0].resolve(okResult());
    const r = await op; const cancelled = f.service.cancel('owner', 'race-resolve-first');
    assert.equal(r.status, 200); assert.equal(cancelled, false); cases.push(['resolve-first', r.status, r.body.billingStatus]);
  }
  // 2. cancel-before-resolve in the same tick: cancelled, actual usage known -> cost known (not null, not 0).
  {
    const op = f.service.generate(f.input('race-cancel-first'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.pending().length === 1, 'dispatch');
    const call = f.provider.pending()[0];
    f.service.cancel('owner', 'race-cancel-first'); call.resolve(okResult());
    const r = await op;
    assert.equal(r.status, 409); assert.equal(r.body.billingStatus, 'settled'); assert.equal(r.body.usage.cost, 0.00008); cases.push(['cancel-first', r.status, r.body.usage.cost]);
  }
  // 3. resolve then cancel in the same synchronous turn (cancel wins the decision; usage still real).
  {
    const op = f.service.generate(f.input('race-same-turn'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.pending().length === 1, 'dispatch');
    const call = f.provider.pending()[0];
    call.resolve(okResult()); const cancelled = f.service.cancel('owner', 'race-same-turn');
    const r = await op;
    assert.equal(cancelled, true); assert.ok([200, 409].includes(r.status));
    assert.equal(r.body.usage.cost, 0.00008, 'real usage recorded either way'); cases.push(['same-turn', r.status, r.body.usage.cost]);
  }
  // 4. provider failure (unknown usage) then cancel: cost stays unknown, one row.
  {
    const op = f.service.generate(f.input('race-fail-cancel'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.pending().length === 1, 'dispatch');
    f.provider.pending()[0].reject(Object.assign(new Error('MOCK network reset'), { usageUnknown: true })); f.service.cancel('owner', 'race-fail-cancel');
    const r = await op; assert.equal(r.body.usage.cost, null); assert.equal(r.body.billingStatus, 'settled'); cases.push(['fail-then-cancel', r.status, r.body.usage.cost]);
  }
  // 5. settlement (ledger) failure then cancel: unrecorded, cost unknown, reservation kept, no retry.
  {
    const settle = f.store.settleSystemUsage.bind(f.store);
    f.store.settleSystemUsage = () => { throw new Error('MOCK settlement disk failure'); };
    const op = f.service.generate(f.input('race-ledger-fail'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.pending().length === 1, 'dispatch');
    f.service.cancel('owner', 'race-ledger-fail'); f.provider.pending()[0].resolve(okResult());
    const r = await op; f.store.settleSystemUsage = settle;
    assert.equal(r.body.billingStatus, 'unrecorded'); assert.equal(r.body.usage.cost, null); assert.equal(r.body.reconciliationRequired, true);
    assert.equal(f.rows().find(x => x.requestId === 'race-ledger-fail').status, 'reserved'); cases.push(['ledger-fail-cancel', r.status, r.body.billingStatus]);
  }
  // 6. late resolve after the response, then a stray second resolve/reject from a buggy adapter: still one transition.
  {
    const op = f.service.generate(f.input('race-late-double'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.pending().length === 1, 'dispatch');
    const call = f.provider.pending()[0];
    f.service.cancel('owner', 'race-late-double'); const r = await op; assert.equal(r.body.billingStatus, 'dispatch_outstanding');
    call.resolve(okResult()); call.resolve(okResult()); call.reject(new Error('stray'));
    await f.provider.until(() => f.service.stats().activeSlots === 0, 'released');
    const row = f.rows().find(x => x.requestId === 'race-late-double'); assert.equal(row.lateSettlement, true); assert.equal(row.cost, 0.00008);
    cases.push(['late-double', r.status, row.cost]);
  }
  log(t, { cases, ...f.evidence('race matrix') });
  assert.equal(f.provider.metrics.started, 6); assert.equal(f.rows().length, 6);
  assert.equal(f.audits.filter(a => a.event === 'intake_draft_late_settlement').length, 1);
  assert.ok(f.rows().every(r => r.cost !== 0), 'remote dispatched calls are never recorded as free');
});

test('TC7-05 close() is bounded, reports outstanding calls, never frees their capacity; restart recovers unknown without replay (MOCK + SQLite)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-cancel-close-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { mode: 'ignore', closeGraceMs: 80, dir });
  const ops = ['x', 'y', 'z'].map(id => f.service.generate(f.input(id), { ownerId: 'owner' }));
  await f.provider.until(() => f.provider.metrics.started === 3, 'three dispatches');
  const t0 = Date.now();
  const closed = await f.service.close();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, 'bounded shutdown: ' + elapsed + 'ms');
  assert.equal(closed.outstanding, 3); assert.equal(closed.ledgerIds.length, 3);
  for (const r of await Promise.all(ops)) { assert.equal(r.body.billingStatus, 'dispatch_outstanding'); assert.equal(r.body.usage.cost, null); }
  const stats = f.service.stats(); log(t, { elapsedMs: elapsed, closed, ...f.evidence('after bounded close') });
  assert.equal(stats.activeSlots, 3, 'capacity of still-running calls is not released at shutdown');
  assert.equal(f.provider.metrics.underlyingInFlight, 3, 'shutdown does not pretend provider calls stopped');
  assert.ok(f.audits.some(a => a.event === 'intake_draft_close_outstanding' && a.detail.count === 3));
  assert.throws(() => f.service.generate(f.input('after-close'), { ownerId: 'owner' }), e => e.code === 'service_closing' && e.status === 503);
  f.store.close();
  // A provider finishing after shutdown never writes to the closed DB and never throws/unhandled-rejects.
  f.provider.calls[0].resolve(okResult()); f.provider.calls[1].reject(new Error('late failure'));
  await f.provider.until(() => f.service.stats().lateAfterClose === 2, 'late after close');
  // Restart: #8 conservative recovery; nothing replayed, cost unknown, bound kept.
  const reopened = new ProjectStore({ dir });
  try {
    const rows = reopened.db.prepare("SELECT r.state, s.doc FROM model_requests r JOIN system_usage s ON s.id=r.ledger_id").all();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const doc = JSON.parse(row.doc);
      assert.equal(row.state, 'interrupted_unknown'); assert.equal(doc.cost, null); assert.ok(doc.costUpperBound > 0 || doc.reservedCost > 0);
    }
    assert.equal(reopened.recoverModelRequests(), 0, 'recovery is idempotent');
  } finally { reopened.close(); }
  assert.equal(f.provider.metrics.started, 3, 'no replay across restart');
  f.provider.calls[2].resolve(okResult());
  await f.provider.until(() => f.service.stats().lateAfterClose === 3, 'last late');
});

test('TC7-06 cooperative adapter: cancel stops the provider within the grace window and frees capacity at once (MOCK control)', async t => {
  for (const mode of ['honor', 'honor-with-usage']) {
    const f = fixture(t, { mode, abortGraceMs: 200 });
    const ops = ['p', 'q', 'r'].map(id => f.service.generate(f.input(id), { ownerId: 'owner' }));
    await f.provider.until(() => f.provider.metrics.started === 3, 'three dispatches');
    for (const id of ['p', 'q', 'r']) f.service.cancel('owner', id);
    const answered = await Promise.all(ops);
    assert.equal(f.provider.metrics.underlyingInFlight, 0, 'provider really stopped');
    for (const r of answered) {
      assert.equal(r.status, 409); assert.equal(r.body.billingStatus, 'settled'); assert.equal(r.body.usageRecorded, true);
      if (mode === 'honor') assert.equal(r.body.usage.cost, null, 'aborted stream with unknown usage stays unknown');
      else assert.equal(r.body.usage.cost, 0.000028, 'provider-reported partial usage is charged, not hidden');
    }
    assert.equal(f.service.stats().activeSlots, 0);
    const next = f.service.generate(f.input('next'), { ownerId: 'owner' });
    await f.provider.until(() => f.provider.metrics.started === 4, 'immediate admission');
    f.provider.calls[3].resolve(okResult()); assert.equal((await next).status, 200);
    log(t, { mode, ...f.evidence('cooperative control') });
    assert.ok(f.provider.metrics.peakUnderlyingInFlight <= 3); assert.equal(f.service.stats().lateSettlements, 0);
    await f.cleanup();
  }
});

test('TC7-01/06 before dispatch: cancel while still claimed is provably unsent, cost 0, slot freed (MOCK)', async t => {
  const f = fixture(t, { mode: 'ignore' });
  const op = f.service.generate(f.input('pre-dispatch'), { ownerId: 'owner' });
  assert.equal(f.service.cancel('owner', 'pre-dispatch'), true); // before the first await resolves
  const r = await op;
  assert.equal(r.status, 409); assert.equal(r.body.requestSent, false); assert.equal(r.body.usage.cost, 0); assert.equal(r.body.billingStatus, 'not_dispatched');
  assert.equal(f.provider.metrics.started, 0); assert.equal(f.service.stats().activeSlots, 0); assert.equal(f.rows()[0].state, 'not_dispatched');
});

test('local free target: outstanding call still holds capacity even though its cost is 0 (MOCK)', async t => {
  const f = fixture(t, { mode: 'ignore', pricing: 'local' });
  const ops = [1, 2, 3].map(i => f.service.generate(f.input('local-' + i), { ownerId: 'owner' }));
  await f.provider.until(() => f.provider.metrics.started === 3, 'three');
  for (const i of [1, 2, 3]) f.service.cancel('owner', 'local-' + i);
  await Promise.all(ops);
  assert.throws(() => f.service.generate(f.input('local-4'), { ownerId: 'owner' }), e => e.code === 'draft_busy');
  for (const c of f.provider.pending()) c.resolve(okResult());
  await f.provider.until(() => f.service.stats().activeSlots === 0, 'released');
  assert.ok(f.rows().every(r => r.cost === 0 && r.status === 'failed'));
});

// ---- Real local HTTP: the actual v2 route, actual sockets, actual provider sockets ----
async function httpFixture(t, { honorSignal }) {
  const provider = await hangingHttpProvider();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-cancel-http-'));
  const m = models('paid_api');
  const audits = [];
  const api = createV2Api({ dir, models: m, teams: { list: () => [] }, callModel: httpCallModel(provider.port, { honorSignal }), emit: () => {}, audit: (e, d) => { audits.push({ e, d }); return true; } });
  const json = (res, code, obj) => { if (res.writableEnded || res.destroyed) return; const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  const readBody = req => new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } }); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await api.handle(req, res, url, { readBody, json, user: { userId: 'admin-http' } }))) json(res, 404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  // Raw request whose socket we can destroy mid-flight (true client disconnect).
  const rawPost = (p, body) => {
    const req = http.request(base + p, { method: 'POST', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {}); req.end(JSON.stringify(body)); return req;
  };
  t.after(async () => {
    for (const r of provider.state.requests) r.finish?.();
    await api.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const input = requestId => ({ description: '为跨领域新项目设计适合的岗位和步骤，随后人工编辑确认。', connectionId: 'draft-model', approvePaid: true, maxTokens: 32000, maxCost: 1, price: PRICE, requestId });
  const until = async (fn, label, ms = 4000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout: ' + label); await sleep(10); } };
  return { provider, api, call, rawPost, input, until, audits };
}

test('TC7-03 HTTP client disconnect, non-cooperative adapter: provider socket stays open, slot held, no resend, late settle once (local HTTP)', async t => {
  const f = await httpFixture(t, { honorSignal: false });
  const reqs = ['h1', 'h2', 'h3'].map(id => f.rawPost('/api/v2/intake/ai-draft', f.input(id)));
  await f.until(() => f.provider.state.requests.length === 3, 'three provider requests');
  for (const r of reqs) r.destroy(); // browser tab closed / network dropped
  await f.until(async () => (await f.call('GET', '/api/v2/intake/ai-draft/status')).json.outstandingAfterResponse === 3, 'outstanding');
  const status = (await f.call('GET', '/api/v2/intake/ai-draft/status')).json;
  log(t, { status, providerOpen: f.provider.state.open, providerPeakOpen: f.provider.state.peakOpen });
  assert.equal(status.activeSlots, 3); assert.equal(status.underlyingInFlight, 3); assert.equal(f.provider.state.open, 3, 'provider sockets truly still open');
  assert.ok(f.provider.state.requests.every(r => !r.closedByClient));
  const busy = await f.call('POST', '/api/v2/intake/ai-draft', f.input('h4'));
  assert.equal(busy.status, 429); assert.equal(busy.json.code, 'draft_busy'); assert.equal(f.provider.state.requests.length, 3);
  const pending = (await f.call('GET', '/api/v2/usage/system/exceptions')).json.exceptions;
  assert.equal(pending.length, 3); assert.ok(pending.every(e => e.cost === null && e.requestState === 'dispatching'));
  // Provider finishes: one late settlement each, then capacity returns.
  for (const r of f.provider.state.requests) r.finish();
  await f.until(async () => (await f.call('GET', '/api/v2/intake/ai-draft/status')).json.activeSlots === 0, 'released');
  const usage = (await f.call('GET', '/api/v2/usage/system')).json.usage.filter(u => u.kind === 'intake_draft');
  log(t, usage.map(u => [u.status, u.lateSettlement, u.cost, u.tokens, u.tokenSource]));
  assert.equal(usage.length, 3); assert.ok(usage.every(u => u.status === 'failed' && u.lateSettlement === true && u.cost === 0.00008), 'real provider usage x user rates, recorded once');
  assert.equal(f.provider.state.peakOpen, 3); assert.equal(f.provider.state.requests.length, 3, 'never re-sent');
});

test('TC7-03/06 HTTP client disconnect, cooperative adapter: provider socket is really closed and capacity freed (local HTTP)', async t => {
  const f = await httpFixture(t, { honorSignal: true });
  const reqs = ['c1', 'c2', 'c3'].map(id => f.rawPost('/api/v2/intake/ai-draft', f.input(id)));
  await f.until(() => f.provider.state.requests.length === 3, 'three provider requests');
  for (const r of reqs) r.destroy();
  await f.until(() => f.provider.state.requests.every(r => r.closedByClient), 'provider sockets closed by our client');
  await f.until(async () => (await f.call('GET', '/api/v2/intake/ai-draft/status')).json.activeSlots === 0, 'released');
  const usage = (await f.call('GET', '/api/v2/usage/system')).json.usage.filter(u => u.kind === 'intake_draft');
  assert.equal(usage.length, 3); assert.ok(usage.every(u => u.status === 'failed' && u.cost === null && u.needsReconciliation === true), 'stopped stream: usage unknown, not free');
  const next = f.call('POST', '/api/v2/intake/ai-draft', f.input('c4'));
  await f.until(() => f.provider.state.requests.length === 4, 'admitted');
  f.provider.state.requests[3].finish();
  assert.equal((await next).status, 200);
  log(t, { providerRequests: f.provider.state.requests.length, peakOpen: f.provider.state.peakOpen, status: (await f.call('GET', '/api/v2/intake/ai-draft/status')).json });
});

test('TC7-03 HTTP explicit cancel route answers the waiting client and keeps owner isolation (local HTTP)', async t => {
  const f = await httpFixture(t, { honorSignal: false });
  const waiting = f.call('POST', '/api/v2/intake/ai-draft', f.input('route-cancel'));
  await f.until(() => f.provider.state.requests.length === 1, 'provider request');
  const cancel = await f.call('POST', '/api/v2/intake/ai-draft/cancel', { requestId: 'route-cancel' });
  assert.equal(cancel.status, 202);
  const r = await waiting;
  assert.equal(r.status, 409); assert.equal(r.json.billingStatus, 'dispatch_outstanding'); assert.equal(r.json.usage.cost, null); assert.ok(r.json.ledgerId);
  const again = await f.call('POST', '/api/v2/intake/ai-draft', f.input('route-cancel'));
  assert.equal(again.status, 409); assert.equal(again.json.code, 'duplicate_request'); assert.equal(again.json.requestState, 'dispatching');
  assert.equal(f.provider.state.requests.length, 1);
  assert.equal((await f.call('POST', '/api/v2/intake/ai-draft/cancel', { requestId: 'route-cancel' })).status, 404, 'an answered request is no longer cancellable');
});
