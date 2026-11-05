'use strict';
// #14 package 5: seeded fault-injection regression for the draft request
// lifecycle (#7) and ledger (#5/#6/#8). A fixed-seed PRNG generates operation
// sequences (submit, duplicate click, cancel, provider resolve/partial/unknown/
// failure, ledger settlement failure, cooperative vs non-cooperative calls,
// bounded close + restart recovery). Invariants are checked after EVERY step.
// Reproduce one sequence: FAULT_SEEDS=1234 FAULT_OPS=200 node --test tests/fault-regression.test.js
// All model calls are local MOCKs; temp SQLite only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectStore } = require('../lib/project-store');
const { IntakeDraftService } = require('../lib/intake-draft');
const { okResult } = require('./fixtures/lifecycle-provider.cjs');

const SEEDS = (process.env.FAULT_SEEDS || '1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765,10946').split(',').map(Number);
const OPS = Number(process.env.FAULT_OPS) || 70;
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 3)); };

async function runSeed(seed) {
  const rand = mulberry32(seed), pick = a => a[Math.floor(rand() * a.length)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-fault-' + seed + '-'));
  let store = new ProjectStore({ dir });
  const connection = { connectionId: 'm', modelId: 'MOCK-fault', protocol: 'openai', baseUrl: 'https://mock.invalid/v1', enabled: true, ready: true, status: 'available', pricingMode: 'paid_api', updatedAt: 1 };
  const models = { policy: { localTargets: new Set() }, get: () => connection, status: () => 'available', list: () => [connection], key: () => '', runtime: () => ({}) };
  const truth = { inFlight: 0, peak: 0, started: 0 }, pending = [];
  const callModel = (rt, opts) => {
    truth.started++; truth.inFlight++; truth.peak = Math.max(truth.peak, truth.inFlight);
    const cooperative = rand() < 0.4;
    return new Promise((resolve, reject) => {
      const call = { done: false, finish(kind, v) { if (call.done) return; call.done = true; truth.inFlight--; pending.splice(pending.indexOf(call), 1); (kind === 'ok' ? resolve : reject)(v); } };
      pending.push(call);
      if (cooperative) opts.signal.addEventListener('abort', () => call.finish('err', Object.assign(new Error('MOCK aborted'), { usageUnknown: true })), { once: true });
    });
  };
  const settleCount = new Map(); let failNextSettle = false, injectedSettleFailures = 0;
  const wrapStore = s => {
    const settle = s.settleSystemUsage.bind(s);
    s.settleSystemUsage = (ledgerId, usage) => {
      if (failNextSettle) { failNextSettle = false; injectedSettleFailures++; throw new Error('MOCK settlement failure'); }
      const out = settle(ledgerId, usage); settleCount.set(ledgerId, (settleCount.get(ledgerId) || 0) + 1); return out;
    };
  };
  wrapStore(store);
  const service = new IntakeDraftService({ store, models, tools: { list: () => [] }, skills: { get: () => null }, callModel, timeoutMs: 60000, abortGraceMs: 2, closeGraceMs: 10, audit: () => true });
  const input = id => ({ description: '确定性故障注入回归：草案请求生命周期。', connectionId: 'm', approvePaid: true, maxTokens: 32000, maxCost: 1, price: { inputPerMillion: 2, outputPerMillion: 4 }, requestId: id });
  const ids = [], answers = new Map(), outcomes = {};
  const count = k => { outcomes[k] = (outcomes[k] || 0) + 1; };
  const rows = () => store.db.prepare('SELECT r.state, r.dispatched_at, s.doc FROM model_requests r JOIN system_usage s ON s.id=r.ledger_id').all().map(r => ({ state: r.state, dispatched: r.dispatched_at !== null, ...JSON.parse(r.doc) }));
  const check = label => {
    const st = service.stats(), all = rows();
    const ctx = `seed=${seed} after ${label}`;
    assert.ok(truth.inFlight <= 3, ctx + ' underlying in flight ' + truth.inFlight);
    assert.ok(st.activeSlots <= 3, ctx + ' slots ' + st.activeSlots);
    assert.ok(st.activeSlots >= truth.inFlight, ctx + ' a running provider call must hold a slot');
    assert.equal(st.underlyingInFlight, truth.inFlight, ctx + ' service view equals ground truth');
    assert.equal(all.filter(r => r.dispatched).length, truth.started, ctx + ' every dispatch has exactly one durable row');
    for (const [ledgerId, n] of settleCount) assert.ok(n <= 1, ctx + ' ledger ' + ledgerId + ' settled ' + n + ' times');
    for (const r of all) if (r.requestSent && r.status !== 'reserved') assert.ok(r.cost === null || r.cost > 0, ctx + ' dispatched paid row has cost 0');
    for (const r of all) if (!r.dispatched && r.status !== 'reserved') assert.equal(r.cost, 0, ctx + ' never-dispatched row must be provably 0');
  };
  for (let step = 0; step < OPS; step++) {
    const roll = rand();
    let label;
    if (roll < 0.34) {
      const dup = ids.length && rand() < 0.2, id = dup ? pick(ids) : 's' + seed + '-' + step; label = dup ? 'duplicate-click' : 'submit';
      try { const p = service.generate(input(id), { ownerId: 'fault' }); if (!dup) ids.push(id); answers.set(id, p); p.then(r => count('answer:' + r.status + ':' + (r.body.billingStatus || r.body.code))); }
      catch (e) { count('refused:' + e.code); assert.ok(['draft_busy', 'duplicate_request', 'idempotency_key_reused'].includes(e.code), 'unexpected refusal ' + e.code); }
    } else if (roll < 0.52) { label = 'cancel'; if (ids.length) service.cancel('fault', pick(ids)); }
    else if (roll < 0.80) {
      label = 'provider-end';
      if (pending.length) {
        const call = pick(pending), kind = rand();
        if (kind < 0.5) call.finish('ok', okResult());
        else if (kind < 0.65) call.finish('ok', { text: 'partial', tokens: 5, outTokens: 5, usageComplete: false });
        else if (kind < 0.85) call.finish('err', Object.assign(new Error('MOCK network reset'), { usageUnknown: true }));
        else call.finish('err', Object.assign(new Error('MOCK 500 with usage'), { tokens: 12, inTokens: 10, outTokens: 2 }));
      }
    } else if (roll < 0.86) { label = 'inject-settle-failure'; failNextSettle = true; }
    else label = 'idle';
    await flush(); check(label);
  }
  // Drain: providers end, all answers arrive, every settled row settled once.
  while (pending.length) { pending[0].finish('ok', okResult()); await flush(); check('drain'); }
  failNextSettle = false;
  await Promise.all([...answers.values()]); await flush(); check('drained');
  assert.equal(service.stats().activeSlots, 0, `seed=${seed} no slot leaked`);
  const leftovers = rows().filter(r => r.status === 'reserved');
  assert.ok(leftovers.length <= injectedSettleFailures, `seed=${seed} only injected settlement failures may stay reserved`);
  // Bounded close with one outstanding non-cooperative call, then restart recovery.
  const before = truth.started;
  const extra = service.generate(input('s' + seed + '-final'), { ownerId: 'fault' });
  await flush();
  const closed = await service.close();
  assert.ok(closed.outstanding <= 1); await extra;
  store.close();
  for (const c of [...pending]) c.finish('ok', okResult());
  await flush();
  store = new ProjectStore({ dir });
  const recovered = rows();
  assert.ok(recovered.every(r => !['claimed', 'dispatching'].includes(r.state)), `seed=${seed} recovery left nothing in flight`);
  assert.ok(recovered.filter(r => r.state === 'interrupted_unknown').every(r => r.cost === null), `seed=${seed} interrupted rows stay unknown`);
  assert.ok(truth.started <= before + 1, `seed=${seed} no replay on restart`);
  assert.ok(truth.peak <= 3, `seed=${seed} peak ${truth.peak}`);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
  return { seed, ops: OPS, dispatched: truth.started, peakUnderlyingInFlight: truth.peak, injectedSettleFailures, reservedAfterDrain: leftovers.length, outcomes };
}

test(`seeded fault regression: ${SEEDS.length} seeds x ${OPS} ops keep capacity, single settlement, no fake zero, no replay (MOCK + SQLite)`, async t => {
  const results = [];
  for (const seed of SEEDS) results.push(await runSeed(seed));
  const total = results.reduce((n, r) => n + r.dispatched, 0);
  t.diagnostic(JSON.stringify({ seeds: SEEDS.length, ops: OPS, totalDispatched: total, maxPeak: Math.max(...results.map(r => r.peakUnderlyingInFlight)), sample: results.slice(0, 3) }));
  assert.ok(total > SEEDS.length * 3, 'sequences actually exercised dispatches');
  assert.ok(results.some(r => Object.keys(r.outcomes).some(k => k.includes('dispatch_outstanding'))), 'non-cooperative outstanding path exercised');
  assert.ok(results.some(r => Object.keys(r.outcomes).some(k => k.startsWith('refused:draft_busy'))), 'capacity refusal path exercised');
  assert.ok(results.some(r => r.injectedSettleFailures > 0), 'settlement failure path exercised');
});
