'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EV = require('../lib/events');
const { Runtime } = require('../lib/runtime');
const { ArtifactStore } = require('../lib/artifacts');

const ev = (input, ctx) => { const r = EV.normalize(input, ctx); assert.ok(r.ok, r.error); return r.ev; };
const srv = (type, sid, extra = {}, usageSource) => ev({ agent: 'conn-a', eventType: type, ...extra }, { source: 'server', spanId: sid, usageSource });

test('同一 span 只结算一次：重复的 done / error 不会重复计 token 或错误数', () => {
  const rt = new Runtime();
  rt.apply(srv('model_start', 's1'));
  const first = rt.apply(srv('model_done', 's1', { tokenUsage: { input: 10, output: 20 } }, 'provider'));
  assert.equal(first.tokens, 30); assert.equal(first.ignored, false);
  const again = rt.apply(srv('model_done', 's1', { tokenUsage: { input: 10, output: 20 } }, 'provider'));
  assert.equal(again.ignored, true);
  rt.apply(srv('model_error', 's1', { tokenUsage: { total: 99 } }, 'estimated'));
  assert.deepEqual([rt.totals.tokens, rt.totals.estimatedTokens, rt.totals.errors, rt.totals.calls], [30, 0, 0, 1]);
});

test('token 为 0 时保留准确含义：事件里是 0，不计入统计，也不被当成“未知”', () => {
  const e = srv('model_done', 's2', { tokenUsage: { input: 0, output: 0 } }, 'provider');
  assert.deepEqual(e.tokenUsage, { input: 0, output: 0, total: 0, source: 'provider', estimated: false });
  const rt = new Runtime(); rt.apply(srv('model_start', 's2')); rt.apply(e);
  assert.equal(rt.totals.tokens, 0); assert.equal(rt.agents.get('conn-a').status, 'idle');
  const unknown = srv('model_error', 's3');
  assert.equal(unknown.tokenUsage, undefined, '没有任何用量信息 = 未知，不编造 0');
});

test('失败调用：估算用量计入 estimatedTokens，厂商用量计入 tokens；错误数 +1', () => {
  const rt = new Runtime();
  rt.apply(srv('model_start', 'f1')); rt.apply(srv('model_error', 'f1', { tokenUsage: { total: 40 } }, 'estimated'));
  rt.apply(srv('model_start', 'f2')); rt.apply(srv('model_error', 'f2', { tokenUsage: { input: 7, output: 3 } }, 'provider'));
  assert.deepEqual([rt.totals.tokens, rt.totals.estimatedTokens, rt.totals.errors], [10, 40, 2]);
  assert.equal(rt.agents.get('conn-a').status, 'error');
});

test('超时清理后迟到的 done：结算一次真实用量，不会再被重复计算', () => {
  const rt = new Runtime();
  rt.apply(srv('model_start', 'z1'));
  const swept = rt.sweep(Date.now() + 10 * 60e3, 1000);
  assert.equal(swept.length, 1); assert.equal(rt.agents.get('conn-a').status, 'idle');
  rt.apply(srv('model_done', 'z1', { tokenUsage: { total: 5 } }, 'provider'));
  rt.apply(srv('model_done', 'z1', { tokenUsage: { total: 5 } }, 'provider'));
  assert.equal(rt.totals.tokens, 5);
});

test('并发：一个 span 结束不影响另一个 span 的 working 状态', () => {
  const rt = new Runtime();
  rt.apply(srv('model_start', 'p1')); rt.apply(srv('model_start', 'p2'));
  rt.apply(srv('model_done', 'p1', {}, 'provider'));
  assert.equal(rt.agents.get('conn-a').status, 'working'); assert.equal(rt.agents.get('conn-a').active, 1);
  rt.apply(srv('model_error', 'p2'));
  assert.equal(rt.agents.get('conn-a').status, 'error'); assert.equal(rt.agents.get('conn-a').active, 0);
});

test('agentId 绑定来源与上报主体', () => {
  const rt = new Runtime();
  rt.apply(ev({ agent: 'hook-1', status: 'start' }, { source: 'external' }), {}, 'tokenA');
  assert.equal(rt.check('hook-1', 'external', 'tokenA'), null);
  assert.match(rt.check('hook-1', 'external', 'tokenB'), /其它上报主体/);
  assert.match(rt.check('hook-1', 'server', null), /其它来源/);
  assert.ok(!('owner' in rt.publicAgents()[0]) && !('spans' in rt.publicAgents()[0]), '快照不暴露内部字段');
});

test('成果存储：按任务隔离、上限明确报错、列表不含正文', () => {
  const st = new ArtifactStore({ maxArtifactChars: 100, maxTaskChars: 150, maxPerTask: 3 });
  const a = st.put('t1', { text: 'x'.repeat(80), producer: 'p' });
  assert.ok(a.ok);
  assert.equal(st.get('t2', a.artifact.artifactId), null, '其它任务不可读取');
  assert.equal(st.get('t1', '../etc'), null);
  assert.equal(st.get('t1', a.artifact.artifactId).text.length, 80);
  assert.equal(st.put('t1', { text: 'y'.repeat(101) }).ok, false);
  assert.match(st.put('t1', { text: 'y'.repeat(80) }).error, /总量/);
  assert.ok(!('text' in st.list('t1')[0]));
  st.drop('t1'); assert.equal(st.list('t1').length, 0);
});
