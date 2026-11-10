'use strict';
// B7 usability: batch model add, name-based capability suggestions, platform labels. No real provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const Hints = require('../public/model-hints.js');
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
