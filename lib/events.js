'use strict';
/*
 * AIJAVAIS 统一事件协议 v1（定稿）
 *
 * 概念区分：Task（用户任务）/ Message（智能体之间的结构化通信，见 lib/messages.js）/ Event（已经发生的工作事实）。
 * 事件用于审计与视觉呈现；“消息创建成功”不等于“对方已处理”，处理动作以对应事件为准。
 *
 * 信封字段（所有事件必有）：
 *   v            协议版本（1）
 *   eventId      <启动标记>-<序号36进制>，全局唯一
 *   sequence     本次服务运行内严格递增的整数（排序、断线恢复）
 *   taskId       所属任务，无任务为 null
 *   runId        一次执行实例，无则 null
 *   spanId       一次模型 / 工具调用实例，无则 null
 *   parentSpanId 调用层级，无则 null
 *   agentId      产生事件的智能体（沿用供应商 id）
 *   eventType    见 EVENT_TYPES
 *   timestamp    毫秒时间戳（服务端生成，不信任客户端）
 *   status       start | stream | done | error | info | handoff（兼容旧大屏）
 *   source       server | external | demo（服务端赋值，永不读取客户端传来的值）
 *   verification observed | reported | simulated（由 source 推导，服务端生成）
 * 可选字段：attempt、agentInstanceId（本次任务中承担某岗位的智能体实例）、roleId（岗位）、toolName、filePath、durationMs、tokenUsage、metadata
 *   agentId 保持为模型连接 ID（大屏按它显示“哪个模型在工作”）；同一模型承担多个岗位时用 agentInstanceId / roleId 区分。
 *
 * 真实性：server→observed（平台自己发起并观察到的模型调用）；
 *         external→reported（经鉴权的外部上报，不等于平台独立验证过的事实）；
 *         demo→simulated（模拟，不得计入真实统计）。
 *
 * status 规则：
 *   - 带 eventType 的新事件：status 一律由服务端按 TYPE_STATUS 派生；客户端若同时给出不一致的 status，整条拒绝。
 *   - 只带 status 的旧事件（signal.js、Claude Code hooks）：继续兼容，eventType 由 LEGACY_TYPE 推导，status 原样保留。
 */
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;

const EVENT_TYPES = Object.freeze([
  'task_start', 'planning', 'model_stream', 'tool_start', 'tool_done', 'file_change',
  'handoff', 'review', 'test_start', 'test_result', 'task_done', 'task_error',
  // 以下为服务端自己的模型调用（span 级）所需：任务级事件 ≠ 模型调用事件
  'model_start', 'model_done', 'model_error', 'activity',
]);
const STATUSES = Object.freeze(['start', 'stream', 'done', 'error', 'info', 'handoff']);
const SOURCES = Object.freeze(['server', 'external', 'demo']);
const VERIFICATION = Object.freeze({ server: 'observed', external: 'reported', demo: 'simulated' });
const USAGE_SOURCES = Object.freeze(['provider', 'estimated', 'external', 'unknown']);

/* eventType → status：task_done 为 info，避免与 model_done 重复触发全屏“完成”动画 */
const TYPE_STATUS = Object.freeze({
  task_start: 'start', planning: 'info', model_start: 'start', model_stream: 'stream', model_done: 'done', model_error: 'error',
  tool_start: 'stream', tool_done: 'info', file_change: 'info', handoff: 'handoff', review: 'info',
  test_start: 'stream', test_result: 'info', task_done: 'info', task_error: 'error', activity: 'info',
});
/* 旧版只有 status 时推导 eventType；旧版 info 不再被误解为 planning，而是 activity */
const LEGACY_TYPE = Object.freeze({ start: 'task_start', stream: 'model_stream', done: 'task_done', error: 'task_error', handoff: 'handoff', info: 'activity' });

const BOOT = Date.now().toString(36);
let seq = 0;
const newTaskId = () => 't' + crypto.randomBytes(6).toString('hex');
const newRunId = () => 'r' + crypto.randomBytes(6).toString('hex');
const newSpanId = () => 's' + crypto.randomBytes(6).toString('hex');

const ID_RE = /^[\w.-]{1,64}$/;
const TASK_ID_RE = /^[\w-]{1,40}$/;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const stripCtl = s => s.replace(/[\u0000-\u001f\u007f]/g, ' ');
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

/* tokenUsage：只接受非负数（保留合法的 0）；来源标识由服务端按事件来源决定，不信任客户端 */
function cleanUsage(u, legacyTokens, source, serverUsageSource) {
  const raw = {};
  if (u && typeof u === 'object' && !Array.isArray(u)) {
    for (const k of ['input', 'output', 'total']) { const v = num(u[k]); if (v !== undefined && v >= 0) raw[k] = Math.floor(v); }
  } else {
    const t = num(legacyTokens);
    if (t !== undefined && t >= 0) raw.total = Math.floor(t);
  }
  if (!Object.keys(raw).length) return undefined;
  if (raw.total === undefined && (raw.input !== undefined || raw.output !== undefined)) raw.total = (raw.input || 0) + (raw.output || 0);
  let src;
  if (source === 'server') src = USAGE_SOURCES.includes(serverUsageSource) && serverUsageSource !== 'external' ? serverUsageSource : (u && USAGE_SOURCES.includes(u.source) && (u.source === 'provider' || u.source === 'estimated') ? u.source : 'unknown');
  else if (source === 'external') src = 'external';
  else src = 'unknown';
  return { ...raw, source: src, estimated: src === 'estimated' };
}

/* metadata：只保留可 JSON 化的对象，序列化后不超过 2KB */
function cleanMeta(m) {
  if (m === undefined || m === null) return undefined;
  if (typeof m !== 'object' || Array.isArray(m)) return undefined;
  let s;
  try { s = JSON.stringify(m); } catch { return undefined; }
  if (s.length > 2048) return { truncated: true };
  return JSON.parse(s);
}

/* 可选的关联 ID：缺省为 null；格式不合法则整条拒绝 */
function idOrNull(v, name, re = ID_RE) {
  if (v === undefined || v === null || v === '') return { ok: true, v: null };
  if (typeof v !== 'string' || !re.test(v)) return { ok: false, error: name + ' 格式不合法（字母、数字、下划线、点、连字符，最长 64 位）' };
  return { ok: true, v };
}

/*
 * 规范化为信封。source 与 verification 由服务端决定。
 * ctx（服务端自己产生事件时传入，优先于 input）：{ source, taskId, runId, spanId, parentSpanId, attempt, usageSource }
 * 返回 { ok:true, ev, legacy } 或 { ok:false, error }。
 */
function normalize(input, ctx = {}) {
  const source = ctx.source;
  if (!SOURCES.includes(source)) return { ok: false, error: '内部错误：缺少事件来源' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '事件必须是 JSON 对象' };
  const agentId = clip(input.agentId !== undefined ? input.agentId : input.agent, 40).trim();
  if (!agentId) return { ok: false, error: '缺少 agent / agentId 字段' };

  /* eventType / status */
  let eventType = input.eventType, status = input.status, legacy = false;
  if (eventType !== undefined && eventType !== null) {
    if (typeof eventType !== 'string' || !EVENT_TYPES.includes(eventType)) {
      return { ok: false, error: '未知 eventType：' + clip(eventType, 30) + '。可用：' + EVENT_TYPES.join(', ') };
    }
    const derived = TYPE_STATUS[eventType];
    if (status !== undefined && status !== null && status !== derived) {
      return { ok: false, error: 'status 与 eventType 不一致：eventType=' + eventType + ' 对应 status=' + derived + '（收到 ' + clip(status, 20) + '）' };
    }
    status = derived;
  } else {
    legacy = true;
    if (!STATUSES.includes(status)) status = 'info';
    eventType = LEGACY_TYPE[status];
  }

  /* 关联 ID：服务端上下文优先；外部上报只能提供合法格式的值 */
  const pick = (k, re) => idOrNull(ctx[k] !== undefined ? ctx[k] : input[k], k, re);
  const t = pick('taskId', TASK_ID_RE), r = pick('runId'), s = pick('spanId'), ps = pick('parentSpanId');
  const ai = pick('agentInstanceId'), ro = pick('roleId');
  for (const x of [t, r, s, ps, ai, ro]) if (!x.ok) return { ok: false, error: x.error };

  let attempt;
  const att = ctx.attempt !== undefined ? ctx.attempt : input.attempt;
  if (att !== undefined && att !== null) {
    if (!Number.isInteger(att) || att < 1 || att > 100) return { ok: false, error: 'attempt 必须是 1–100 的整数' };
    attempt = att;
  }
  const dur = num(input.durationMs !== undefined ? input.durationMs : input.ms);
  if (dur !== undefined && (dur < 0 || dur > 86400000)) return { ok: false, error: 'durationMs 超出范围（0–86400000）' };

  const n = ++seq;
  const ev = {
    v: PROTOCOL_VERSION,
    eventId: BOOT + '-' + n.toString(36),
    sequence: n,
    taskId: t.v, runId: r.v, spanId: s.v, parentSpanId: ps.v,
    agentId, eventType,
    timestamp: Date.now(),
    status,
    source,
    verification: VERIFICATION[source],
  };
  if (attempt !== undefined) ev.attempt = attempt;
  if (ai.v) ev.agentInstanceId = ai.v;
  if (ro.v) ev.roleId = ro.v;
  if (input.toolName) ev.toolName = clip(stripCtl(String(input.toolName)), 60);
  if (input.filePath) ev.filePath = clip(stripCtl(String(input.filePath)), 300);
  if (dur !== undefined) ev.durationMs = Math.floor(dur);
  const usage = cleanUsage(input.tokenUsage, input.tokens, source, ctx.usageSource);
  if (usage) ev.tokenUsage = usage;
  const meta = cleanMeta(input.metadata);
  if (meta) ev.metadata = meta;
  return { ok: true, ev, legacy };
}

/* 分级脱敏已移至 lib/access.js（字段允许列表） */

module.exports = {
  PROTOCOL_VERSION, EVENT_TYPES, STATUSES, SOURCES, VERIFICATION, USAGE_SOURCES, TYPE_STATUS, LEGACY_TYPE,
  normalize, cleanUsage, newTaskId, newRunId, newSpanId, TASK_ID_RE, ID_RE,
};
