'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SEC = require('../lib/security');
const { chat, LlmError } = require('../lib/llm');
const { startMockLlm } = require('./fixtures/mock-llm');

const deps = port => ({ policy: SEC.policyFromEnv({ LOCAL_MODEL_TARGETS: '127.0.0.1:' + port }), keyOf: c => c.apiKey, timeoutMs: 3000 });
const conn = (port, type) => ({ id: 'c1', type, baseUrl: `http://127.0.0.1:${port}${type === 'openai' ? '/v1' : ''}`, model: 'mock-a', apiKey: 'k-123456' });
const TOOLS = [{ name: 'file_write', description: '写文件', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }];

for (const type of ['anthropic', 'openai']) {
  test(`${type}：流式文本、工具调用（参数分片拼接）、工具结果回传、用量与缓存 Token`, async t => {
    let round = 0;
    const m = await startMockLlm(req => {
      round++;
      if (round === 1) return { text: '我先写文件。', toolCalls: [{ id: 'call_x1', name: 'file_write', arguments: { name: '报告.md', body: '中文内容'.repeat(10) } }], usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 10 } };
      return { text: '已完成：' + req.messages.filter(x => x.role === 'tool').map(x => x.content).join(','), usage: { input: 150, output: 12 } };
    });
    t.after(m.close);
    const deltas = [];
    const r1 = await chat(conn(m.port, type), { system: '你是执行工程师', messages: [{ role: 'user', content: '写一份报告' }], tools: TOOLS, cache: true, onText: d => deltas.push(d) }, deps(m.port));
    assert.equal(r1.text, '我先写文件。'); assert.equal(deltas.join(''), '我先写文件。');
    assert.equal(r1.stopReason, 'tool_calls');
    assert.deepEqual(r1.toolCalls, [{ id: 'call_x1', name: 'file_write', arguments: { name: '报告.md', body: '中文内容'.repeat(10) } }]);
    assert.equal(r1.usage.source, 'provider'); assert.equal(r1.usage.input, 120); assert.equal(r1.usage.output, 30); assert.equal(r1.usage.cacheRead, 80);
    if (type === 'anthropic') {
      assert.equal(r1.usage.cacheWrite, 10);
      assert.equal(m.log[0].raw.system[0].cache_control.type, 'ephemeral', 'Anthropic 系统提示词带缓存标记');
      assert.equal(m.log[0].headers['x-api-key'], 'k-123456');
    } else assert.equal(m.log[0].headers.authorization, 'Bearer k-123456');
    const r2 = await chat(conn(m.port, type), { system: '你是执行工程师', messages: [{ role: 'user', content: '写一份报告' }, { role: 'assistant', content: r1.text, toolCalls: r1.toolCalls }, { role: 'tool', toolCallId: 'call_x1', name: 'file_write', content: 'art_123' }], tools: TOOLS }, deps(m.port));
    assert.equal(r2.text, '已完成：art_123', '工具结果按协议回传给模型');
    assert.equal(r2.stopReason, 'stop');
    const seen = m.log[1].messages;
    assert.deepEqual(seen.map(x => x.role), ['user', 'assistant', 'tool']);
    assert.equal(seen[1].toolCalls[0].name, 'file_write');
  });
}

test('错误分类：401 不重试、429 可重试、额度不足不重试、超时、取消、没有用量时估算', async t => {
  const m = await startMockLlm(req => {
    const u = req.messages[0].content;
    if (u === '401') return { status: 401, text: 'invalid key' };
    if (u === '429') return { status: 429, text: 'rate limited' };
    if (u === 'quota') return { status: 429, text: 'insufficient_quota' };
    if (u === 'hang') return { hang: true };
    return { text: '无用量的回复', usage: null };
  });
  t.after(m.close);
  const c = conn(m.port, 'openai');
  const err = async u => { try { await chat(c, { messages: [{ role: 'user', content: u }] }, { ...deps(m.port), timeoutMs: 500 }); return null; } catch (e) { return e; } };
  const e401 = await err('401'); assert.ok(e401 instanceof LlmError); assert.deepEqual([e401.kind, e401.retryable], ['auth', false]);
  const e429 = await err('429'); assert.deepEqual([e429.kind, e429.retryable], ['rate_limit', true]);
  const eq = await err('quota'); assert.deepEqual([eq.kind, eq.retryable], ['quota', false]);
  const eh = await err('hang'); assert.deepEqual([eh.kind, eh.retryable], ['timeout', true]);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
  try { await chat(c, { messages: [{ role: 'user', content: 'hang' }], signal: ac.signal }, deps(m.port)); assert.fail('应当取消'); } catch (e) { assert.equal(e.kind, 'cancelled'); }
  const r = await chat(c, { messages: [{ role: 'user', content: 'x' }] }, deps(m.port));
  assert.equal(r.usage.source, 'estimated'); assert.ok(r.usage.input > 0 && r.usage.output > 0);
  await assert.rejects(chat(c, { messages: [], tools: [{ name: 'bad.name' }] }, deps(m.port)), /工具名不合法/);
  await assert.rejects(chat({ ...c, apiKey: '' }, { messages: [] }, deps(m.port)), /未配置 API Key/);
  await assert.rejects(chat({ ...c, baseUrl: 'http://10.1.2.3/v1' }, { messages: [{ role: 'user', content: 'x' }] }, deps(m.port)), e => e.kind === 'policy', 'SSRF 策略同样适用');
});
