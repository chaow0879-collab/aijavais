'use strict';
/*
 * AIJAVAIS 消息总线（最小实现，纯内存，零依赖）
 *
 * Task（用户任务）/ Message（智能体之间交换的结构化消息）/ Event（已发生的工作事实）三者分开：
 *   - 消息表示“通信内容”；事件表示“通信动作已经发生”。消息创建成功 ≠ 对方已处理。
 *   - messageId、createdAt、from（发送身份）、status 全部由服务端控制，模型输出只能提供 type / to / content 等业务字段。
 *   - 所有查询与投递都以 taskId 为边界，任务之间的消息互不可见。
 *   - 调度器（服务端）逐条控制发送与投递；总线不会自行调用任何模型，也不允许消息扩大预算。
 *
 * 信封（必有）：v, messageId, threadId, taskId, runId, from, to, type, round, createdAt, content, status
 * 可选：spanId, replyTo, artifactRefs, metadata
 * 保留身份：user（只能发 request，可接收成果类消息）、scheduler（只能发 system_notice / decision）
 */
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const MESSAGE_TYPES = Object.freeze(['request', 'question', 'answer', 'proposal', 'review', 'revision', 'decision', 'artifact', 'system_notice']);
const MESSAGE_STATUSES = Object.freeze(['created', 'queued', 'delivered', 'consumed', 'failed', 'cancelled']);
const TASK_END_STATES = Object.freeze(['completed', 'partial', 'failed', 'cancelled', 'budget_exceeded', 'timed_out']);
const TRANSITIONS = Object.freeze({
  created: ['queued', 'failed', 'cancelled'],
  queued: ['delivered', 'failed', 'cancelled'],
  delivered: ['consumed', 'failed', 'cancelled'],
  consumed: [], failed: [], cancelled: [],
});
const TERMINAL = new Set(['consumed', 'failed', 'cancelled']);

const DEFAULT_LIMITS = Object.freeze({ maxRounds: 3, maxMessages: 20, maxQuestionsPerRound: 3 });
const HARD_LIMITS = Object.freeze({ maxRounds: 10, maxMessages: 100, maxQuestionsPerRound: 10 }); // 配置也不能突破
const MAX_TEXT = 20000;
const FORMATS = ['text', 'markdown', 'json'];
const ID_RE = /^[\w.-]{1,64}$/;
const AGENT_RE = /^[\w.-]{1,40}$/;
const RESERVED = Object.freeze({ USER: 'user', SCHEDULER: 'scheduler' });
const USER_RECEIVES = new Set(['answer', 'proposal', 'review', 'revision', 'decision', 'artifact']);
const SCHEDULER_SENDS = new Set(['system_notice', 'decision']);

const fail = error => ({ ok: false, error });
const clone = o => structuredClone(o);

function cleanContent(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return fail('content 必须是对象 {format, text}');
  const format = c.format === undefined ? 'text' : c.format;
  if (!FORMATS.includes(format)) return fail('content.format 只能是 ' + FORMATS.join(' / '));
  if (typeof c.text !== 'string') return fail('content.text 必须是字符串');
  if (c.text.length > MAX_TEXT) return fail('content.text 超过 ' + MAX_TEXT + ' 字符');
  return { ok: true, content: { format, text: c.text } };
}
/* artifactRefs 只能引用服务端成果的 ID，不接受路径 */
function cleanRefs(r) {
  if (r === undefined || r === null) return { ok: true, refs: [] };
  if (!Array.isArray(r) || r.length > 10) return fail('artifactRefs 必须是最多 10 项的数组');
  const refs = [];
  for (const x of r) {
    const id = typeof x === 'string' ? x : (x && typeof x === 'object' ? x.artifactId : undefined);
    if (typeof id !== 'string' || !ID_RE.test(id)) return fail('artifactRefs 只能是成果 ID（字母、数字、下划线、点、连字符），不得是路径');
    refs.push({ artifactId: id });
  }
  return { ok: true, refs };
}
function cleanMeta(m) {
  if (m === undefined || m === null) return { ok: true };
  if (typeof m !== 'object' || Array.isArray(m)) return fail('metadata 必须是对象');
  let s; try { s = JSON.stringify(m); } catch { return fail('metadata 无法序列化'); }
  if (s.length > 2048) return fail('metadata 超过 2KB');
  return { ok: true, metadata: JSON.parse(s) };
}

/* 校验一个已经成型的信封（用于读取存储、测试、对外 schema 一致性）。返回 { ok, error? } */
function validateEnvelope(m) {
  if (!m || typeof m !== 'object') return fail('消息必须是对象');
  for (const k of ['messageId', 'threadId', 'taskId', 'runId', 'from', 'to', 'type', 'round', 'createdAt', 'content', 'status']) {
    if (m[k] === undefined || m[k] === null) return fail('缺少必需字段 ' + k);
  }
  if (m.v !== PROTOCOL_VERSION) return fail('不支持的协议版本');
  for (const k of ['messageId', 'threadId', 'taskId', 'runId']) if (typeof m[k] !== 'string' || !ID_RE.test(m[k])) return fail(k + ' 格式不合法');
  for (const k of ['from', 'to']) if (typeof m[k] !== 'string' || !AGENT_RE.test(m[k])) return fail(k + ' 格式不合法');
  if (!MESSAGE_TYPES.includes(m.type)) return fail('未知消息类型');
  if (!MESSAGE_STATUSES.includes(m.status)) return fail('未知消息状态');
  if (!Number.isInteger(m.round) || m.round < 1 || m.round > HARD_LIMITS.maxRounds) return fail('round 不合法');
  if (!Number.isInteger(m.createdAt) || m.createdAt <= 0) return fail('createdAt 不合法');
  const c = cleanContent(m.content); if (!c.ok) return c;
  if (m.spanId != null && !ID_RE.test(m.spanId)) return fail('spanId 格式不合法');
  if (m.replyTo != null && !ID_RE.test(m.replyTo)) return fail('replyTo 格式不合法');
  if (m.artifactRefs !== undefined) { const r = cleanRefs(m.artifactRefs); if (!r.ok) return r; }
  return { ok: true };
}

class MessageBus {
  constructor({ maxTasks = 200, now = Date.now } = {}) {
    this.maxTasks = maxTasks; this.now = now; this.tasks = new Map(); this.n = 0;
    this.onTransition = null; // (info:{message, from, to, reason}) => void，由服务端把投递等动作转成事件
    this.onEvict = null; // (taskId) => void，已结束任务被清理时通知（用于同步清理成果等）
  }

  registerTask(taskId, { runId, agents, limits } = {}) {
    if (typeof taskId !== 'string' || !ID_RE.test(taskId)) return fail('taskId 格式不合法');
    if (this.tasks.has(taskId)) return fail('任务已注册');
    if (typeof runId !== 'string' || !ID_RE.test(runId)) return fail('runId 格式不合法');
    if (!Array.isArray(agents) || !agents.length || agents.length > 8 || agents.some(a => typeof a !== 'string' || !AGENT_RE.test(a) || Object.values(RESERVED).includes(a))) {
      return fail('agents 必须是 1–8 个合法的智能体 ID（不得使用保留身份 user / scheduler）');
    }
    const lim = { ...DEFAULT_LIMITS };
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const v = limits && limits[k];
      if (v !== undefined) { if (!Number.isInteger(v) || v < 1) return fail('limits.' + k + ' 必须是正整数'); lim[k] = Math.min(v, HARD_LIMITS[k]); }
    }
    /* 内存上限：只清理已结束的任务（最早结束的先清）；全部仍在运行时拒绝注册，绝不删除运行中任务的上下文 */
    while (this.tasks.size >= this.maxTasks) {
      let key = null, oldest = Infinity;
      for (const [k, t] of this.tasks) if (t.state !== 'active' && (t.endedAt || 0) < oldest) { oldest = t.endedAt || 0; key = k; }
      if (key === null) return fail('消息总线已满：' + this.maxTasks + ' 个任务都在运行中，请稍后再试');
      this._evict(key);
    }
    this.tasks.set(taskId, { taskId, runId, agents: new Set(agents), limits: lim, state: 'active', messages: [], byId: new Map(), threads: new Set(), replied: new Set(), seen: new Set() });
    return { ok: true, limits: { ...lim } };
  }

  /* 结束任务：未处理完的消息全部 cancelled，之后拒绝一切发送与投递。幂等。 */
  endTask(taskId, state) {
    const t = this.tasks.get(taskId);
    if (!t) return fail('任务不存在');
    if (!TASK_END_STATES.includes(state)) return fail('未知的任务终态：' + state);
    if (t.state !== 'active') return { ok: true, already: true, state: t.state };
    t.state = state; t.endedAt = this.now();
    for (const m of t.messages) if (!TERMINAL.has(m.status)) this._move(t, m, 'cancelled', '任务已终止：' + state);
    return { ok: true, state };
  }

  _evict(taskId) {
    this.tasks.delete(taskId);
    if (this.onEvict) { try { this.onEvict(taskId); } catch { /* 回调异常不影响总线 */ } }
  }

  /* 清理结束超过 retentionMs 的任务（定时调用）；返回清理数量 */
  sweepEnded(retentionMs, now = this.now()) {
    let n = 0;
    for (const [k, t] of [...this.tasks]) if (t.state !== 'active' && now - (t.endedAt || 0) > retentionMs) { this._evict(k); n++; }
    return n;
  }

  activeCount() { let n = 0; for (const t of this.tasks.values()) if (t.state === 'active') n++; return n; }

  taskState(taskId) { const t = this.tasks.get(taskId); return t ? t.state : null; }

  send(input) {
    if (!input || typeof input !== 'object') return fail('消息必须是对象');
    const t = this.tasks.get(input.taskId);
    if (!t) return fail('任务不存在或未注册');
    if (t.state !== 'active') return fail('任务已终止（' + t.state + '），拒绝发送新消息');
    const { from, to, type } = input;
    if (!MESSAGE_TYPES.includes(type)) return fail('未知消息类型：' + String(type).slice(0, 30));

    /* 收发方 */
    const isAgent = x => t.agents.has(x);
    if (from === RESERVED.USER) { if (type !== 'request') return fail('user 只能发送 request'); }
    else if (from === RESERVED.SCHEDULER) { if (!SCHEDULER_SENDS.has(type)) return fail('scheduler 只能发送 system_notice / decision'); }
    else if (!isAgent(from)) return fail('发送方不是该任务的参与者：' + String(from).slice(0, 40));
    else if (type === 'system_notice') return fail('system_notice 只能由 scheduler 发送');
    if (to === RESERVED.USER) { if (!USER_RECEIVES.has(type)) return fail('user 不接收 ' + type + ' 类消息'); }
    else if (to === RESERVED.SCHEDULER) return fail('不能向 scheduler 发送消息');
    else if (!isAgent(to)) return fail('接收方不是该任务的参与者：' + String(to).slice(0, 40));
    if (from === to) return fail('不能给自己发消息');
    if (t.messages.length >= t.limits.maxMessages) return fail('消息数量已达上限（' + t.limits.maxMessages + '）');

    const c = cleanContent(input.content); if (!c.ok) return c;
    const refs = cleanRefs(input.artifactRefs); if (!refs.ok) return refs;
    const meta = cleanMeta(input.metadata); if (!meta.ok) return meta;
    if (input.spanId != null && (typeof input.spanId !== 'string' || !ID_RE.test(input.spanId))) return fail('spanId 格式不合法');
    if (type === 'artifact' && !refs.refs.length) return fail('artifact 类消息必须带 artifactRefs');
    if (type !== 'artifact' && !c.content.text.trim()) return fail('content.text 不能为空');

    /* 回复关系与线程 */
    let threadId, parent = null;
    if (input.replyTo != null) {
      parent = t.byId.get(input.replyTo); // 只在本任务内查找，天然隔离其他任务
      if (!parent) return fail('回复的消息不存在，或不属于该任务');
      if (parent.to !== from || parent.from !== to) return fail('只能回复发给自己的消息，且收件方必须是原发送方');
      if (parent.status !== 'delivered' && parent.status !== 'consumed') return fail('被回复的消息尚未投递（状态：' + parent.status + '）');
      if (parent.type === 'question' && type !== 'answer') return fail('question 只能用 answer 回复');
      if (input.threadId != null && input.threadId !== parent.threadId) return fail('threadId 与被回复消息的线程不一致');
      threadId = parent.threadId;
      const rk = parent.messageId + ':' + from + ':' + type;
      if (t.replied.has(rk)) return fail('重复回复：同一发送方已用 ' + type + ' 回复过该消息');
    } else if (input.threadId != null) {
      if (typeof input.threadId !== 'string' || !t.threads.has(input.threadId)) return fail('threadId 不存在，或不属于该任务');
      threadId = input.threadId;
    }

    /* 轮次 */
    let round = input.round;
    if (round === undefined || round === null) round = parent ? parent.round : 1;
    if (!Number.isInteger(round) || round < 1) return fail('round 必须是正整数');
    if (round > t.limits.maxRounds) return fail('已超过最大轮次（' + t.limits.maxRounds + '）');
    if (parent && round !== parent.round && round !== parent.round + 1) return fail('round 只能等于或比被回复消息大 1');

    /* 每轮提问数 */
    if (type === 'question') {
      const q = t.messages.filter(m => m.type === 'question' && m.round === round).length;
      if (q >= t.limits.maxQuestionsPerRound) return fail('本轮提问数已达上限（' + t.limits.maxQuestionsPerRound + '）');
    }

    /* 重复消息检测：同线程、同轮次、同发收方、同类型、内容相同 */
    const key = crypto.createHash('sha256').update([from, to, type, threadId || '-', round, c.content.text.trim()].join('\u0000')).digest('hex');
    if (t.seen.has(key)) return fail('重复消息：相同内容已在本线程本轮发送过');

    if (!threadId) { threadId = 'th_' + (++this.n).toString(36) + '_' + crypto.randomBytes(3).toString('hex'); t.threads.add(threadId); }
    const message = {
      v: PROTOCOL_VERSION,
      messageId: 'm_' + (++this.n).toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
      threadId, taskId: t.taskId, runId: t.runId,
      from, to, type, replyTo: parent ? parent.messageId : null, round,
      createdAt: this.now(), content: c.content, artifactRefs: refs.refs, status: 'created',
    };
    if (input.spanId != null) message.spanId = input.spanId;
    if (meta.metadata !== undefined) message.metadata = meta.metadata;
    t.seen.add(key);
    if (parent) t.replied.add(parent.messageId + ':' + from + ':' + type);
    t.messages.push(message); t.byId.set(message.messageId, message);
    return { ok: true, message: clone(message) };
  }

  _move(t, m, to, reason) {
    const from = m.status;
    m.status = to; m.updatedAt = this.now();
    if (reason) m.statusReason = String(reason).slice(0, 200);
    if (this.onTransition) { try { this.onTransition({ message: clone(m), from, to, reason: m.statusReason }); } catch { /* 回调异常不影响总线 */ } }
  }
  _transition(taskId, messageId, to, reason) {
    const t = this.tasks.get(taskId);
    if (!t) return fail('任务不存在');
    const m = t.byId.get(messageId);
    if (!m) return fail('消息不存在，或不属于该任务');
    if (!TRANSITIONS[m.status].includes(to)) return fail('非法状态转换：' + m.status + ' → ' + to);
    if (t.state !== 'active' && to !== 'cancelled') return fail('任务已终止，拒绝投递');
    this._move(t, m, to, reason);
    return { ok: true, message: clone(m) };
  }
  queue(taskId, messageId) { return this._transition(taskId, messageId, 'queued'); }
  deliver(taskId, messageId) { return this._transition(taskId, messageId, 'delivered'); }
  consume(taskId, messageId) { return this._transition(taskId, messageId, 'consumed'); }
  fail(taskId, messageId, reason) { return this._transition(taskId, messageId, 'failed', reason); }
  cancel(taskId, messageId, reason) { return this._transition(taskId, messageId, 'cancelled', reason); }

  /* 取出收件方下一条待处理（queued）消息并投递；无则 null */
  next(taskId, agentId) {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'active') return null;
    const m = t.messages.find(x => x.to === agentId && x.status === 'queued');
    return m ? this._transition(taskId, m.messageId, 'delivered').message : null;
  }
  inbox(taskId, agentId) {
    const t = this.tasks.get(taskId);
    return t ? t.messages.filter(m => m.to === agentId && (m.status === 'queued' || m.status === 'delivered')).map(clone) : [];
  }
  get(taskId, messageId) { const m = this.tasks.get(taskId)?.byId.get(messageId); return m ? clone(m) : null; }
  list(taskId, { threadId } = {}) {
    const t = this.tasks.get(taskId);
    return t ? t.messages.filter(m => !threadId || m.threadId === threadId).map(clone) : [];
  }
  stats(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    const byStatus = {}; for (const s of MESSAGE_STATUSES) byStatus[s] = 0;
    for (const m of t.messages) byStatus[m.status]++;
    return { state: t.state, total: t.messages.length, byStatus, threads: t.threads.size, limits: { ...t.limits }, maxRound: t.messages.reduce((a, m) => Math.max(a, m.round), 0) };
  }
}

module.exports = {
  PROTOCOL_VERSION, MAX_TEXT, MESSAGE_TYPES, MESSAGE_STATUSES, TASK_END_STATES, TRANSITIONS, DEFAULT_LIMITS, HARD_LIMITS, RESERVED,
  MessageBus, validateEnvelope,
};
