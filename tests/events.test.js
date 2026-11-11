'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EV = require('../lib/events');

const norm = (i, c = {}) => EV.normalize(i, { source: 'external', ...c });

test('新旧事件兼容：只带 status 的旧事件继续可用，info 映射为 activity', () => {
  const m = { start: 'task_start', stream: 'model_stream', done: 'task_done', error: 'task_error', handoff: 'handoff', info: 'activity' };
  for (const [status, type] of Object.entries(m)) {
    const r = norm({ agent: 'hook', status });
    assert.ok(r.ok && r.legacy, status);
    assert.equal(r.ev.eventType, type); assert.equal(r.ev.status, status, '旧版 status 原样保留，大屏照常响应');
  }
  assert.equal(norm({ agent: 'hook', status: 'weird' }).ev.status, 'info', '非法旧 status 降为 info');
  assert.equal(norm({ agent: 'hook', status: 'weird' }).ev.eventType, 'activity');
});

test('status 由 eventType 派生；同时给出不一致组合直接拒绝', () => {
  for (const [type, st] of Object.entries(EV.TYPE_STATUS)) {
    const r = norm({ agent: 'a', eventType: type });
    assert.ok(r.ok && !r.legacy, type); assert.equal(r.ev.status, st, type);
    assert.equal(norm({ agent: 'a', eventType: type, status: st }).ok, true, '一致组合通过');
  }
  assert.equal(EV.TYPE_STATUS.task_done, 'info', 'task_done 不触发全屏完成');
  assert.equal(EV.TYPE_STATUS.model_done, 'done');
  const bad = norm({ agent: 'a', eventType: 'tool_start', status: 'done' });
  assert.equal(bad.ok, false); assert.match(bad.error, /不一致/);
  assert.equal(norm({ agent: 'a', eventType: 'bogus' }).ok, false);
  assert.equal(norm({ agent: 'a', eventType: 42 }).ok, false);
  assert.equal(EV.EVENT_TYPES.length, Object.keys(EV.TYPE_STATUS).length, '每个类型都有 status 映射');
});

test('信封字段完整且 verification 只由来源决定', () => {
  const want = { server: 'observed', external: 'reported', demo: 'simulated' };
  for (const source of ['server', 'external', 'demo']) {
    const r = EV.normalize({ agent: 'a', eventType: 'activity', verification: 'observed', source: 'server' }, { source });
    const e = r.ev;
    assert.equal(e.source, source, '客户端声称的 source 被忽略');
    assert.equal(e.verification, want[source], '客户端声称的 verification 被忽略');
    for (const k of ['v', 'eventId', 'sequence', 'taskId', 'runId', 'spanId', 'parentSpanId', 'agentId', 'eventType', 'timestamp', 'status', 'source', 'verification']) assert.ok(k in e, k);
    assert.equal(e.v, 1); assert.equal(e.taskId, null); assert.equal(e.spanId, null);
  }
});

test('eventId 唯一、sequence 严格递增、timestamp 由服务端生成', () => {
  const evs = Array.from({ length: 200 }, () => norm({ agent: 'a', status: 'info', timestamp: 1, sequence: 1, eventId: 'x' }).ev);
  assert.equal(new Set(evs.map(e => e.eventId)).size, 200);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].sequence > evs[i - 1].sequence);
  assert.ok(evs.every(e => e.timestamp > 1000 && e.eventId !== 'x' && e.sequence !== 1));
});

test('关联字段：服务端上下文优先；外部只能提供合法格式；非法整条拒绝', () => {
  const r = EV.normalize({ agent: 'a', eventType: 'model_start', taskId: 'evil', spanId: 'evil' }, { source: 'server', taskId: 't1', runId: 'r1', spanId: 's1', parentSpanId: 's0', attempt: 2 });
  assert.deepEqual([r.ev.taskId, r.ev.runId, r.ev.spanId, r.ev.parentSpanId, r.ev.attempt], ['t1', 'r1', 's1', 's0', 2]);
  const ext = norm({ agent: 'a', status: 'info', taskId: 'ext-1', runId: 'run.1', spanId: 'sp_1' });
  assert.deepEqual([ext.ev.taskId, ext.ev.runId, ext.ev.spanId], ['ext-1', 'run.1', 'sp_1']);
  for (const bad of [{ taskId: 'a b' }, { runId: '../x' }, { spanId: 'x'.repeat(65) }, { parentSpanId: {} }, { attempt: 0 }, { attempt: 1.5 }, { attempt: 101 }, { durationMs: -1 }, { durationMs: 1e12 }]) {
    assert.equal(norm({ agent: 'a', status: 'info', ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('tokenUsage：保留合法零值，来源标识由服务端决定', () => {
  const z = EV.normalize({ agent: 'a', eventType: 'model_done', tokenUsage: { input: 0, output: 0, total: 0 } }, { source: 'server', usageSource: 'provider' });
  assert.deepEqual(z.ev.tokenUsage, { input: 0, output: 0, total: 0, source: 'provider', estimated: false }, '0 不得丢失');
  const e = EV.normalize({ agent: 'a', eventType: 'model_done', tokenUsage: { total: 99 } }, { source: 'server', usageSource: 'estimated' });
  assert.equal(e.ev.tokenUsage.source, 'estimated'); assert.equal(e.ev.tokenUsage.estimated, true);
  // 外部上报永远是 external，即使自称 provider；demo 永远是 unknown
  assert.equal(norm({ agent: 'a', status: 'done', tokenUsage: { total: 5, source: 'provider', estimated: false } }).ev.tokenUsage.source, 'external');
  assert.equal(EV.normalize({ agent: 'a', status: 'done', tokens: 5 }, { source: 'demo' }).ev.tokenUsage.source, 'unknown');
  // 旧版数值 tokens 兼容
  assert.equal(norm({ agent: 'a', status: 'done', tokens: 7 }).ev.tokenUsage.total, 7);
  // 负数 / 非数字 / 无意义的值被丢弃；input+output 自动求 total
  assert.equal(norm({ agent: 'a', status: 'done', tokenUsage: { total: -1 } }).ev.tokenUsage, undefined);
  assert.equal(norm({ agent: 'a', status: 'done', tokenUsage: { total: 'x' } }).ev.tokenUsage, undefined);
  assert.equal(norm({ agent: 'a', status: 'done', tokenUsage: { input: 3, output: 4 } }).ev.tokenUsage.total, 7);
});

test('字段大小与类型校验', () => {
  const r = norm({ agent: 'a'.repeat(100), status: 'info', toolName: 'x'.repeat(200), filePath: 'a\u0000b\n' + 'p'.repeat(500), metadata: { big: 'y'.repeat(5000) } });
  assert.equal(r.ev.agentId.length, 40); assert.equal(r.ev.toolName.length, 60);
  assert.ok(r.ev.filePath.length <= 300 && !/[\u0000-\u001f]/.test(r.ev.filePath));
  assert.deepEqual(r.ev.metadata, { truncated: true });
  assert.deepEqual(norm({ agent: 'a', status: 'info', metadata: { k: 1 } }).ev.metadata, { k: 1 });
  assert.equal(norm({ agent: 'a', status: 'info', metadata: [1, 2] }).ev.metadata, undefined);
  for (const bad of [null, 'x', 5, [], {}, { agent: '   ' }]) assert.equal(norm(bad).ok, false);
  assert.equal(EV.normalize({ agent: 'a' }, { source: 'bogus' }).ok, false);
});
