'use strict';
// B7 usability: batch model add, name-based capability suggestions, platform labels. No real provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const Hints = require('../public/model-hints.js');
const Plan = require('../public/smart-plan.js');
const CAPS = Object.keys(require('../catalog/providers.v1.json').capabilities);

test('B7b: name rules suggest capabilities from the catalog vocabulary only', () => {
  const s = id => Hints.suggestCapabilities(id, CAPS);
  for (const c of ['writing', 'fast', 'low_cost']) assert.ok(s('deepseek-flash').includes(c)), assert.ok(s('qwen-turbo').includes(c));
  for (const c of ['reasoning', 'long_context']) assert.ok(s('deepseek-v4-pro').includes(c)), assert.ok(s('qwen3.8-max').includes(c));
  assert.ok(s('qwen3-coder-plus').includes('coding'));
  assert.ok(s('qwen-vl-max').includes('vision')); assert.ok(s('qwen3.8-omni-flash').includes('vision'));
  assert.ok(s('qwen3.8-flash').includes('chinese'), 'built-in family table');
  assert.deepEqual(s('gpt-x-unknown'), ['reasoning', 'writing', 'chinese', 'data_analysis'], 'owner #10 v2.2: general chat models get the four common abilities by default');
  for (const id of ['deepseek-flash', 'qwen3.8-max', 'qwen-vl-max']) for (const c of s(id)) assert.ok(CAPS.includes(c), c);
});
test('B7a: embedding, rerank, realtime, speech, image and translation models are flagged non-chat with a reason', () => {
  for (const id of ['text-embedding-v4', 'qwen3.7-text-embedding-flash', 'gte-rerank-v2', 'qwen3.8-omni-flash-realtime', 'qwen3-tts-flash', 'fun-asr-flash-2026-06-15', 'z-image-turbo', 'wanx2.1-t2i-turbo', 'qwen-mt-flash', 'MiniMax/speech-2.8-turbo']) {
    assert.ok(Hints.nonChatReason(id), id); assert.deepEqual(Hints.suggestCapabilities(id), [], id);
  }
  for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.8-flash', 'qwen3.8-max', 'qwen3-coder-flash', 'qwen3.8-omni-flash', 'qwen-vl-max', 'qwen-flash-character'])
    assert.equal(Hints.nonChatReason(id), null, id);
});
test('B7c: platform label is "平台 · 模型名" with safe fallbacks', () => {
  assert.equal(Hints.platformLabel({ platformLabel: 'DeepSeek · deepseek-flash' }), 'DeepSeek · deepseek-flash');
  assert.equal(Hints.platformLabel({ providerName: '通义千问', modelId: 'qwen3.8-flash' }), '通义千问 · qwen3.8-flash');
  assert.equal(Hints.platformLabel({ connectionId: 'mc_x' }), 'mc_x');
  assert.equal(Hints.platformLabel(null), '');
});

test('B7a/B7c: batch add saves several models of one provider in one request, all-or-nothing, without echoing the key', async t => {
  const S = await H.boot({}); t.after(() => S.stop());
  const KEY = 'sk-B7-TEST-ONLY-0123456789abcdef';
  const r = await S.call('POST', '/api/models/batch', { providerId: 'deepseek', apiKey: KEY, models: [
    { modelId: 'deepseek-flash', capabilities: Hints.suggestCapabilities('deepseek-flash', CAPS) },
    { modelId: 'deepseek-v4-pro', capabilities: ['reasoning'] }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.connections.length, 2);
  assert.ok(!r.text.includes(KEY), 'response never echoes the key');
  const listed = (await S.call('GET', '/api/models')).json.models;
  assert.deepEqual(listed.map(m => m.platformLabel).sort(), ['DeepSeek · deepseek-flash', 'DeepSeek · deepseek-v4-pro']);
  assert.ok(listed.every(m => m.hasKey && m.keyHint === '••••cdef' && m.baseUrl === 'https://api.deepseek.com'));
  assert.deepEqual(listed.find(m => m.modelId === 'deepseek-v4-pro').capabilities, ['reasoning']);
  assert.ok(!JSON.stringify(listed).includes(KEY));
  // all-or-nothing: one invalid item stores nothing
  const bad = await S.call('POST', '/api/models/batch', { providerId: 'deepseek', apiKey: KEY, models: [{ modelId: 'deepseek-ok' }, { modelId: '' }] });
  assert.equal(bad.status, 400);
  const dup = await S.call('POST', '/api/models/batch', { providerId: 'deepseek', apiKey: KEY, models: [{ modelId: 'a' }, { modelId: 'a' }] });
  assert.equal(dup.status, 400);
  assert.equal((await S.call('POST', '/api/models/batch', { providerId: 'deepseek', apiKey: KEY, models: [] })).status, 400);
  assert.equal((await S.call('GET', '/api/models')).json.models.length, 2, 'failed batches stored nothing');
  // the same-origin/admin gates still apply
  const anon = await H.call(S.port, 'POST', '/api/models/batch', { providerId: 'deepseek', apiKey: KEY, models: [{ modelId: 'x' }] }, { cookie: false });
  assert.ok([401, 403].includes(anon.status), 'anonymous batch add is refused: ' + anon.status);
  // the key file is the only place the key lives
  const creds = fs.readFileSync(path.join(S.dir, 'credentials.json'), 'utf8');
  assert.ok(creds.includes(KEY));
  assert.ok(!fs.readFileSync(path.join(S.dir, 'models.json'), 'utf8').includes(KEY));
});

/* ---------------- B7e/B7g smart plan rules (pure) ---------------- */
const mk = (id, providerId, modelId, price, extra = {}) => ({ connectionId: id, providerId, providerName: providerId === 'deepseek' ? 'DeepSeek' : '通义千问', modelId, enabled: true, status: 'available', pricingMode: 'unknown',
  baseUrl: providerId === 'deepseek' ? 'https://api.deepseek.com' : 'https://dashscope.aliyuncs.com/compatible-mode/v1', price, ...extra });
const DS = { currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2 }, QW = { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 3 }, MAX = { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 };
const POOL = [mk('a', 'deepseek', 'deepseek-flash', DS), mk('b', 'deepseek', 'deepseek-v4-pro', null), mk('c', 'dashscope', 'qwen3.8-flash', QW), mk('d', 'dashscope', 'qwen3.8-max', MAX)];
test('B7e: unknown-price models are never assigned and are named; no priced model -> Chinese fix, no call', () => {
  const p = Plan.plan({ models: POOL, goal: '写一份方案' });
  assert.ok(p.ok); assert.deepEqual(p.skipped, ['DeepSeek · deepseek-v4-pro']);
  assert.ok(p.roles.every(r => r.model.connectionId !== 'b')); assert.ok(!('b' in p.approval.prices));
  const none = Plan.plan({ models: [POOL[1]], goal: '写一份方案' });
  assert.equal(none.ok, false); assert.equal(none.problems[0].code, 'no_priced_model'); assert.match(none.problems[0].text, /价格都未知/);
});
test('B7e: conversion formula — RMB price at FX 7.5 -> USD rates; USD cap = RMB max / 7.5; max clipped to the per-run cap', () => {
  const p = Plan.plan({ models: POOL, goal: '写一份方案', capCny: 5 });
  assert.equal(Plan.FX, 7.5);
  const qw = p.approval.prices.c; assert.ok(Math.abs(qw.inputPerMillion - 1 / 7.5) < 1e-12 && Math.abs(qw.outputPerMillion - 3 / 7.5) < 1e-12);
  if (p.approval.prices.a) assert.ok(Math.abs(p.approval.prices.a.outputPerMillion - 1.2) < 1e-12, 'USD prices pass through');
  assert.equal(p.approval.maxCost, Math.floor(p.chosen.maxCny / 7.5 * 10000) / 10000);
  assert.ok(p.chosen.maxCny >= 3 * p.chosen.estimateCny - 0.1 && p.chosen.maxCny <= 5, 'max = round-up(max(3×estimate, reservation need)) within the cap');
  assert.equal(p.approval.maxOutputTokens, 2048); assert.equal(p.approval.approvePaid, true); assert.deepEqual(p.approval.allowedTools, []); assert.equal(p.approval.approveExternalTools, false);
  assert.match(p.confirmText, /^预计花费约 ¥\d+\.\d{2}，最多不超过 ¥\d+\.\d{2}，超过会自动停下。$/); assert.doesNotMatch(p.confirmText, /\$|USD|美元|Token/i);
});
test('B7e: over the per-run cap -> both options, quality keeps the strong reviewer (no silent downgrade), max never above the cap', () => {
  const p = Plan.plan({ models: POOL, goal: '写一份方案', capCny: 0.3 });
  assert.ok(p.options.quality.overCap); assert.ok(p.options.saving, 'a saving option is offered');
  assert.equal(p.chosen.kind, 'quality', 'quality is the default');
  assert.equal(p.options.quality.roles[1].model.modelId, 'qwen3.8-max', 'quality reviewer stays the strongest tier');
  assert.ok(p.options.quality.maxCny <= 0.3 && p.options.saving.maxCny <= 0.3);
  const s = Plan.plan({ models: POOL, goal: '写一份方案', capCny: 0.3, choice: 'saving' });
  assert.equal(s.chosen.kind, 'saving'); assert.notEqual(s.roles[1].model.modelId, 'qwen3.8-max');
  const inCap = Plan.plan({ models: POOL, goal: '写一份方案', capCny: 5 });
  assert.equal(inCap.options.saving, undefined, 'within the cap there is no cheaper switch at all');
  assert.equal(inCap.roles[1].model.modelId, 'qwen3.8-max');
});
test('B7g: reviewer is a different model than the drafter when one exists; single model does everything', () => {
  const two = [mk('x', 'custom', 'm-flash', QW), mk('y', 'custom', 'n-flash', QW)];
  const p = Plan.plan({ models: two, goal: '写' }); assert.notEqual(p.roles[0].model.connectionId, p.roles[1].model.connectionId);
  const one = Plan.plan({ models: [two[0]], goal: '写' }); assert.equal(one.roles[0].model.connectionId, one.roles[1].model.connectionId);
});
test('B7f: gate errors become plain Chinese with a fix; budget stop is reported as stopped, not overspent', () => {
  assert.match(Plan.explain({ code: 'budget_required', message: 'A positive maxCost is required' }).text, /预算为 0/);
  const stop = Plan.explain({ message: 'Cost budget cannot cover this call; no request sent' });
  assert.equal(stop.budgetStop, true); assert.match(stop.text, /没有超支/);
  for (const e of [{ code: 'model_unverified' }, { code: 'capability_missing' }, { code: 'price_required' }, { message: 'Something English failed' }])
    assert.doesNotMatch(Plan.explain(e).text, /[A-Za-z]{3,}/, JSON.stringify(e));
});
