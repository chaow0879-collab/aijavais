'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/budget');
const policy = { localTargets: new Set(['127.0.0.1:11434']) };
const local = { connectionId: 'local', pricingMode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai', modelId: 'mock', updatedAt: 1 };
const remote = { ...local, connectionId: 'remote', baseUrl: 'https://example.invalid/v1', pricingMode: 'paid_api' };
const paid = { approvePaid: true, maxCost: 1, prices: { remote: { inputPerMillion: 2, outputPerMillion: 4 } } };
test('shared budget: local is exact allowlisted loopback plus local pricing, never a remote free label', () => {
  assert.equal(B.isLocalFree(local, policy), true);
  assert.equal(B.isLocalFree({ ...remote, pricingMode: 'local' }, policy), false);
  assert.equal(B.isLocalFree(local, { localTargets: new Set() }), false);
  for (const pricingMode of ['unknown', 'free_tier', 'paid_api']) assert.throws(() => B.authorizeModels({ connections: [{ ...remote, pricingMode }], policy }), e => e.code === 'paid_approval_required');
  assert.throws(() => B.authorizeModels({ connections: [remote], policy, input: { ...paid, prices: { remote: { inputPerMillion: 0, outputPerMillion: 0 } } } }), e => e.code === 'price_required');
});
test('shared budget: conservative UTF-8 preflight, target snapshots and no reservation on denied call', () => {
  const approval = B.authorizeModels({ connections: [local], policy, input: { maxTokens: 300, maxOutputTokens: 10 } });
  const usage = B.initialUsage();
  const r = B.reserveCall({ approval, usage, connection: local, policy, system: '中', prompt: '文' });
  assert.equal(r.reservation.inputTokensBound, 262); assert.equal(r.reservation.tokenBound, 272);
  assert.equal(usage.reservedTokens, 0); assert.equal(r.usage.reservedTokens, 272);
  assert.throws(() => B.reserveCall({ approval, usage: r.usage, connection: local, policy, system: '', prompt: '' }), e => e.code === 'token_budget_exceeded');
  assert.throws(() => B.reserveCall({ approval, usage, connection: { ...local, updatedAt: 2 }, policy, system: '', prompt: '' }), e => e.code === 'model_changed');
});
test('shared budget: complete provider usage, zero usage, failed and partial/unknown charges stay distinct', () => {
  const approval = B.authorizeModels({ connections: [remote], policy, input: paid });
  const r = B.reserveCall({ approval, usage: B.initialUsage(), connection: remote, policy, system: 'system', prompt: 'prompt' });
  const settle = result => B.settleCall({ usage: r.usage, connectionId: 'remote', reservation: r.reservation, result });
  const complete = settle({ tokens: 15, inTokens: 10, outTokens: 5, estimated: false });
  assert.equal(complete.entry.cost, 0.00004); assert.equal(complete.entry.tokenSource, 'provider'); assert.equal(complete.usage.reservedTokens, 0);
  assert.equal(settle({ tokens: 0, inTokens: 0, outTokens: 0, estimated: false }).entry.cost, 0);
  const partial = settle({ tokens: 5, outTokens: 5, usageComplete: false });
  assert.equal(partial.entry.tokenSource, 'provider_partial'); assert.equal(partial.entry.cost, r.reservation.costBound);
  const unknown = B.settleCall({ usage: r.usage, connectionId: 'remote', reservation: r.reservation, failed: true, error: 'Mock failure' });
  assert.equal(unknown.entry.failed, true); assert.equal(unknown.entry.tokenSource, 'reserved_unknown'); assert.equal(unknown.entry.cost, r.reservation.costBound);
});
test('shared budget: round accounting, currency/input limits and overrun stop decision', () => {
  assert.throws(() => B.authorizeModels({ connections: [local], policy, input: { maxOutputTokens: 8193 } }));
  assert.throws(() => B.authorizeModels({ connections: [remote], policy, input: { ...paid, prices: { remote: { inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' } } } }), e => e.code === 'price_required');
  const approval = B.authorizeModels({ connections: [local], policy, input: { maxTokens: 500, maxOutputTokens: 10 } });
  const r = B.reserveCall({ approval, usage: { ...B.initialUsage(), usedTokens: 900, roundStartTokens: 900 }, connection: local, policy, system: '', prompt: '' });
  const over = B.settleCall({ usage: r.usage, connectionId: 'local', reservation: r.reservation, result: { tokens: 300, inTokens: 290, outTokens: 10 } });
  assert.equal(over.overrun, true); assert.equal(over.usage.usedTokens, 1200);
  const excessOutput = B.settleCall({ usage: r.usage, connectionId: 'local', reservation: r.reservation, result: { tokens: 11, inTokens: 0, outTokens: 11 } });
  assert.equal(excessOutput.overrun, true, 'per-side output bound also holds when total tokens fit');
});
