'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageBus, validateEnvelope, MESSAGE_TYPES, MESSAGE_STATUSES, TRANSITIONS } = require('../lib/messages');

function mk(over = {}) {
  const bus = new MessageBus();
  assert.ok(bus.registerTask('t1', { runId: 'r1', agents: ['claude', 'chatgpt'], ...over }).ok);
  return bus;
}
const txt = (s = 'hello') => ({ format: 'text', text: s });
/* 把消息推进到 delivered，便于回复 */
const flow = (bus, taskId, id) => { assert.ok(bus.queue(taskId, id).ok); assert.ok(bus.deliver(taskId, id).ok); };

test('创建消息：信封字段齐全，服务端控制 messageId / createdAt / status', () => {
  const bus = mk();
  const r = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('请审核安全问题'), messageId: 'evil', createdAt: 1, status: 'consumed', runId: 'evil' });
  assert.ok(r.ok, r.error);
  const m = r.message;
  assert.notEqual(m.messageId, 'evil'); assert.notEqual(m.createdAt, 1); assert.equal(m.status, 'created'); assert.equal(m.runId, 'r1', 'runId 来自任务注册，不信任调用方');
  assert.deepEqual([m.v, m.round, m.replyTo, m.taskId], [1, 1, null, 't1']);
  assert.ok(validateEnvelope(m).ok, validateEnvelope(m).error);
  assert.ok(m.threadId && m.messageId.startsWith('m_'));
});

test('信封校验：缺字段 / 非法值被拒绝', () => {
  const m = mk().send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request', content: txt() }).message;
  for (const k of ['messageId', 'threadId', 'taskId', 'runId', 'from', 'to', 'type', 'round', 'createdAt', 'content', 'status']) {
    const x = { ...m }; delete x[k]; assert.equal(validateEnvelope(x).ok, false, k);
  }
  assert.equal(validateEnvelope({ ...m, type: 'chat' }).ok, false);
  assert.equal(validateEnvelope({ ...m, status: 'done' }).ok, false);
  assert.equal(validateEnvelope({ ...m, round: 0 }).ok, false);
  assert.equal(validateEnvelope({ ...m, taskId: '../x' }).ok, false);
  assert.equal(validateEnvelope({ ...m, v: 2 }).ok, false);
  assert.equal(validateEnvelope(null).ok, false);
});

test('收发方校验：参与者、保留身份、自发自收', () => {
  const bus = mk();
  const send = o => bus.send({ taskId: 't1', type: 'question', content: txt(), ...o });
  assert.equal(send({ from: 'stranger', to: 'chatgpt' }).ok, false, '非参与者不能发');
  assert.equal(send({ from: 'claude', to: 'stranger' }).ok, false, '不能发给非参与者');
  assert.equal(send({ from: 'claude', to: 'claude' }).ok, false);
  assert.equal(send({ from: 'claude', to: 'scheduler' }).ok, false);
  assert.equal(send({ from: 'user', to: 'claude', type: 'question' }).ok, false, 'user 只能发 request');
  assert.ok(send({ from: 'user', to: 'claude', type: 'request' }).ok);
  assert.equal(send({ from: 'claude', to: 'chatgpt', type: 'system_notice' }).ok, false, '模型不能冒充系统通知');
  assert.ok(send({ from: 'scheduler', to: 'claude', type: 'system_notice' }).ok);
  assert.equal(send({ from: 'scheduler', to: 'claude', type: 'question' }).ok, false);
  assert.equal(send({ from: 'claude', to: 'user', type: 'question' }).ok, false, 'user 不接收 question');
  assert.ok(send({ from: 'claude', to: 'user', type: 'revision' }).ok);
  assert.equal(bus.registerTask('t2', { runId: 'r', agents: ['user'] }).ok, false, '保留身份不能当智能体');
});

test('回复关系：只能回复发给自己且已投递的消息；question 只能 answer；不重复回复', () => {
  const bus = mk();
  const q = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('Q1') }).message;
  const early = bus.send({ taskId: 't1', from: 'chatgpt', to: 'claude', type: 'answer', content: txt('A'), replyTo: q.messageId });
  assert.equal(early.ok, false, '未投递前不能回复'); assert.match(early.error, /尚未投递/);
  flow(bus, 't1', q.messageId);
  assert.equal(bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'answer', content: txt('x'), replyTo: q.messageId }).ok, false, '不能回复自己发出的');
  assert.equal(bus.send({ taskId: 't1', from: 'chatgpt', to: 'claude', type: 'review', content: txt('x'), replyTo: q.messageId }).ok, false, 'question 只能 answer');
  assert.equal(bus.send({ taskId: 't1', from: 'chatgpt', to: 'claude', type: 'answer', content: txt('x'), replyTo: 'nope' }).ok, false);
  const a = bus.send({ taskId: 't1', from: 'chatgpt', to: 'claude', type: 'answer', content: txt('A1'), replyTo: q.messageId });
  assert.ok(a.ok, a.error);
  assert.equal(a.message.threadId, q.threadId, '回复沿用线程'); assert.equal(a.message.replyTo, q.messageId); assert.equal(a.message.round, 1);
  assert.equal(bus.send({ taskId: 't1', from: 'chatgpt', to: 'claude', type: 'answer', content: txt('A2 不同内容'), replyTo: q.messageId }).ok, false, '同一消息不得被同类型重复回复');
  assert.equal(bus.send({ taskId: 't1', from: 'chatgpt', to: 'claude', type: 'answer', content: txt('x'), replyTo: q.messageId, threadId: 'th_other' }).ok, false, 'threadId 必须一致');
});

test('跨任务隔离：消息、线程、回复、投递互不可见', () => {
  const bus = new MessageBus();
  bus.registerTask('t1', { runId: 'r1', agents: ['claude', 'chatgpt'] });
  bus.registerTask('t2', { runId: 'r2', agents: ['claude', 'chatgpt'] });
  const m1 = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('只属于 t1') }).message;
  flow(bus, 't1', m1.messageId);
  assert.equal(bus.get('t2', m1.messageId), null);
  assert.equal(bus.list('t2').length, 0); assert.equal(bus.inbox('t2', 'chatgpt').length, 0);
  assert.equal(bus.send({ taskId: 't2', from: 'chatgpt', to: 'claude', type: 'answer', content: txt('越界回复'), replyTo: m1.messageId }).ok, false);
  assert.equal(bus.send({ taskId: 't2', from: 'claude', to: 'chatgpt', type: 'question', content: txt('x'), threadId: m1.threadId }).ok, false, '不能挂到别的任务的线程');
  assert.equal(bus.consume('t2', m1.messageId).ok, false); assert.equal(bus.queue('t2', m1.messageId).ok, false);
  assert.equal(bus.next('t2', 'chatgpt'), null);
  assert.equal(bus.send({ taskId: 'nope', from: 'claude', to: 'chatgpt', type: 'question', content: txt() }).ok, false);
  // 同样内容在不同任务里不算重复
  assert.ok(bus.send({ taskId: 't2', from: 'claude', to: 'chatgpt', type: 'question', content: txt('只属于 t1') }).ok);
});

test('状态机：合法转换、终态不可变、next 只投递给收件方', () => {
  const bus = mk();
  const events = []; bus.onTransition = e => events.push(`${e.from}>${e.to}`);
  const m = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'proposal', content: txt('方案') }).message;
  assert.equal(bus.deliver('t1', m.messageId).ok, false, 'created 不能直接 delivered');
  assert.equal(bus.next('t1', 'claude'), null, '发送方收不到自己发出的');
  assert.ok(bus.queue('t1', m.messageId).ok);
  assert.equal(bus.inbox('t1', 'chatgpt').length, 1);
  const d = bus.next('t1', 'chatgpt'); assert.equal(d.messageId, m.messageId); assert.equal(d.status, 'delivered');
  assert.equal(bus.next('t1', 'chatgpt'), null, '同一条不会被投递两次');
  assert.ok(bus.consume('t1', m.messageId).ok);
  for (const to of ['queued', 'delivered', 'failed', 'cancelled']) assert.equal(bus._transition('t1', m.messageId, to).ok, false, 'consumed 是终态：' + to);
  assert.deepEqual(events, ['created>queued', 'queued>delivered', 'delivered>consumed']);
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...MESSAGE_STATUSES].sort());
  const f = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'proposal', content: txt('另一条') }).message;
  assert.ok(bus.fail('t1', f.messageId, '模型调用失败').ok);
  assert.equal(bus.get('t1', f.messageId).statusReason, '模型调用失败');
});

test('限制：轮次、消息总数、每轮提问数；配置不能突破硬上限', () => {
  const bus = mk({ limits: { maxMessages: 4, maxQuestionsPerRound: 2, maxRounds: 2 } });
  const q = i => bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('问题 ' + i) });
  assert.ok(q(1).ok && q(2).ok);
  const third = q(3); assert.equal(third.ok, false); assert.match(third.error, /提问数/);
  assert.equal(bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request', content: txt('r'), round: 3 }).ok, false, '超过最大轮次');
  assert.ok(bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('第二轮问题'), round: 2 }).ok, '下一轮可以再提问');
  assert.ok(bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request', content: txt('第四条') }).ok);
  const over = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request', content: txt('第五条') });
  assert.equal(over.ok, false); assert.match(over.error, /数量已达上限/);
  const big = new MessageBus(); big.registerTask('t', { runId: 'r', agents: ['a', 'b'], limits: { maxMessages: 9999, maxRounds: 999 } });
  assert.deepEqual([big.stats('t').limits.maxMessages, big.stats('t').limits.maxRounds], [100, 10]);
  assert.equal(big.registerTask('x', { runId: 'r', agents: ['a'], limits: { maxRounds: 0 } }).ok, false);
});

test('重复消息检测、内容与引用校验', () => {
  const bus = mk();
  const base = { taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request' };
  assert.ok(bus.send({ ...base, content: txt('同一内容') }).ok);
  const dup = bus.send({ ...base, content: txt('  同一内容  ') }); assert.equal(dup.ok, false); assert.match(dup.error, /重复消息/);
  assert.ok(bus.send({ ...base, content: txt('同一内容'), round: 2 }).ok, '不同轮次不算重复');
  assert.equal(bus.send({ ...base, content: txt('   ') }).ok, false, '空内容');
  assert.equal(bus.send({ ...base, content: 'raw string' }).ok, false);
  assert.equal(bus.send({ ...base, content: { format: 'html', text: 'x' } }).ok, false);
  assert.equal(bus.send({ ...base, content: txt('x'.repeat(20001)) }).ok, false);
  assert.equal(bus.send({ ...base, type: 'artifact', content: txt('') }).ok, false, 'artifact 必须带引用');
  assert.equal(bus.send({ ...base, type: 'artifact', content: txt(''), artifactRefs: ['../etc/passwd'] }).ok, false, '引用不得是路径');
  assert.equal(bus.send({ ...base, type: 'artifact', content: txt(''), artifactRefs: [{ artifactId: 'a/b' }] }).ok, false);
  const ok = bus.send({ ...base, type: 'artifact', content: txt(''), artifactRefs: ['art_1', { artifactId: 'art-2' }] });
  assert.ok(ok.ok, ok.error); assert.deepEqual(ok.message.artifactRefs, [{ artifactId: 'art_1' }, { artifactId: 'art-2' }]);
  assert.equal(bus.send({ ...base, content: txt('m'), metadata: { k: 'v'.repeat(3000) } }).ok, false);
  assert.equal(bus.send({ ...base, content: txt('s'), spanId: '../x' }).ok, false);
  assert.equal(bus.send({ ...base, content: txt('s2'), spanId: 'span_1' }).message.spanId, 'span_1');
});

test('任务终止：未处理消息被取消，之后拒绝发送与投递；终态幂等', () => {
  const bus = mk();
  const a = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('a') }).message;
  const b = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'question', content: txt('b') }).message;
  bus.queue('t1', a.messageId); bus.queue('t1', b.messageId); bus.deliver('t1', a.messageId); bus.consume('t1', a.messageId);
  assert.equal(bus.endTask('t1', 'bogus').ok, false);
  const e = bus.endTask('t1', 'cancelled'); assert.ok(e.ok);
  assert.equal(bus.get('t1', a.messageId).status, 'consumed', '已完成的不改');
  assert.equal(bus.get('t1', b.messageId).status, 'cancelled'); assert.match(bus.get('t1', b.messageId).statusReason, /任务已终止/);
  assert.equal(bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request', content: txt('after') }).ok, false);
  assert.equal(bus.next('t1', 'chatgpt'), null); assert.equal(bus.deliver('t1', b.messageId).ok, false);
  assert.deepEqual(bus.endTask('t1', 'completed'), { ok: true, already: true, state: 'cancelled' }, '终态不可被改写');
  assert.equal(bus.taskState('t1'), 'cancelled'); assert.equal(bus.stats('t1').byStatus.cancelled, 1);
});

test('任务注册校验与内存上限', () => {
  const bus = new MessageBus({ maxTasks: 3 });
  assert.equal(bus.registerTask('../x', { runId: 'r', agents: ['a'] }).ok, false);
  assert.equal(bus.registerTask('t', { runId: 'bad id', agents: ['a'] }).ok, false);
  assert.equal(bus.registerTask('t', { runId: 'r', agents: [] }).ok, false);
  assert.ok(bus.registerTask('t', { runId: 'r', agents: ['a', 'b'] }).ok);
  assert.equal(bus.registerTask('t', { runId: 'r', agents: ['a', 'b'] }).ok, false, '重复注册');
  bus.registerTask('t2', { runId: 'r', agents: ['a'] }); bus.registerTask('t3', { runId: 'r', agents: ['a'] });
  bus.endTask('t2', 'completed');
  bus.registerTask('t4', { runId: 'r', agents: ['a'] });
  assert.equal(bus.taskState('t2'), null, '优先淘汰已终止的任务'); assert.equal(bus.taskState('t'), 'active');
  assert.ok(MESSAGE_TYPES.includes('system_notice') && MESSAGE_TYPES.length === 9);
});

test('返回值是副本：外部修改不影响总线内部状态', () => {
  const bus = mk();
  const m = bus.send({ taskId: 't1', from: 'claude', to: 'chatgpt', type: 'request', content: txt('x') }).message;
  m.status = 'consumed'; m.content.text = 'hacked'; m.from = 'user';
  const real = bus.get('t1', m.messageId);
  assert.equal(real.status, 'created'); assert.equal(real.content.text, 'x'); assert.equal(real.from, 'claude');
  bus.list('t1')[0].status = 'failed'; assert.equal(bus.get('t1', m.messageId).status, 'created');
});
