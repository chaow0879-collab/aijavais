'use strict';
/*
 * AIJAVAIS 统一事件协议 v1
 *
 * 信封字段（所有事件必有）：
 *   v          协议版本（1）
 *   eventId    全局递增且唯一：<启动时间戳36进制>-<序号>
 *   taskId     所属任务，无任务的外部信号为 null
 *   agentId    产生事件的智能体（沿用供应商 id，如 claude / chatgpt / claude-code）
 *   eventType  见 EVENT_TYPES
 *   timestamp  毫秒时间戳（服务端生成，不信任客户端）
 *   status     start | stream | done | error | info | handoff
 *              （与旧版大屏兼容；大屏仍按 status 响应，新视觉将按 eventType 响应）
 *   source     server | external | demo
 *              server   = 服务端自己发起的真实模型调用 / 真实执行记录
 *              external = 经令牌鉴权的外部上报（hooks、脚本），内容由上报方负责
 *              demo     = 模拟演示，永远不得当作真实 AI 工作
 *
 * 可选字段：toolName、filePath、durationMs、tokenUsage、metadata
 */
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;

const EVENT_TYPES = Object.freeze([
  'task_start', 'planning', 'model_stream', 'tool_start', 'tool_done', 'file_change',
  'handoff', 'review', 'test_start', 'test_result', 'task_done', 'task_error',
  // 以下两类用于服务端自己的模型调用，区别于任务级事件
  'model_start', 'model_done',
]);
const STATUSES = Object.freeze(['start', 'stream', 'done', 'error', 'info', 'handoff']);
const SOURCES = Object.freeze(['server', 'external', 'demo']);

/* 旧版只有 status 时，推导 eventType，保证 signal.js / 旧脚本无需修改 */
const LEGACY_TYPE = { start: 'task_start', stream: 'model_stream', done: 'task_done', error: 'task_error', handoff: 'handoff', info: 'planning' };
/* 新类型缺省 status：不触发大屏的“开工 / 完成”大动作，避免工具调用误放大效果 */
const TYPE_DEFAULT_STATUS = {
  task_start: 'start', planning: 'info', model_stream: 'stream', tool_start: 'stream', tool_done: 'info',
  file_change: 'info', handoff: 'handoff', review: 'info', test_start: 'stream', test_result: 'info',
  task_done: 'done', task_error: 'error', model_start: 'start', model_done: 'done',
};

const BOOT = Date.now().toString(36);
let seq = 0;
const nextEventId = () => BOOT + '-' + (++seq).toString(36);
const newTaskId = () => 't' + crypto.randomBytes(6).toString('hex');

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const finite = x => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const TASK_ID_RE = /^[\w-]{1,40}$/;

/* tokenUsage 只接受 {input, output, total, estimated} 的非负数 */
function cleanUsage(u, legacyTokens) {
  if (u && typeof u === 'object') {
    const o = {};
    for (const k of ['input', 'output', 'total']) { const v = finite(u[k]); if (v !== undefined && v >= 0) o[k] = Math.floor(v); }
    if (o.total === undefined && (o.input !== undefined || o.output !== undefined)) o.total = (o.input || 0) + (o.output || 0);
    if (typeof u.estimated === 'boolean') o.estimated = u.estimated;
    return Object.keys(o).length ? o : undefined;
  }
  const t = finite(legacyTokens);
  return t !== undefined && t >= 0 ? { total: Math.floor(t) } : undefined;
}

/* metadata：只保留可 JSON 化的浅层对象，序列化后不超过 2KB */
function cleanMeta(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  let s;
  try { s = JSON.stringify(m); } catch { return undefined; }
  if (s.length > 2048) return { truncated: true };
  return JSON.parse(s);
}

/*
 * 把任意输入规范化为信封。source 由服务端传入，绝不读取客户端的 source 字段。
 * 返回 { ok:true, ev } 或 { ok:false, error }。
 */
function normalize(input, { source, taskId } = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: '事件必须是 JSON 对象' };
  if (!SOURCES.includes(source)) return { ok: false, error: '内部错误：缺少事件来源' };
  const agentId = clip(input.agentId || input.agent || '', 40).trim();
  if (!agentId) return { ok: false, error: '缺少 agent / agentId 字段' };

  let eventType = input.eventType;
  if (eventType !== undefined && !EVENT_TYPES.includes(eventType)) {
    return { ok: false, error: '未知 eventType：' + clip(eventType, 30) + '。可用：' + EVENT_TYPES.join(', ') };
  }
  let status = input.status;
  if (status !== undefined && !STATUSES.includes(status)) status = 'info';
  if (!eventType) eventType = LEGACY_TYPE[status] || 'planning';
  if (!status) status = TYPE_DEFAULT_STATUS[eventType] || 'info';

  let tid = taskId !== undefined ? taskId : input.taskId;
  if (tid != null && !TASK_ID_RE.test(String(tid))) return { ok: false, error: 'taskId 只允许字母、数字、下划线、连字符，最长 40 位' };

  const usage = cleanUsage(input.tokenUsage, input.tokens);
  const ev = {
    v: PROTOCOL_VERSION,
    eventId: nextEventId(),
    taskId: tid == null ? null : String(tid),
    agentId,
    eventType,
    timestamp: Date.now(),
    status,
    source,
  };
  if (input.toolName) ev.toolName = clip(input.toolName, 60);
  if (input.filePath) ev.filePath = clip(input.filePath, 300);
  const dur = finite(input.durationMs !== undefined ? input.durationMs : input.ms);
  if (dur !== undefined && dur >= 0) ev.durationMs = Math.floor(dur);
  if (usage) ev.tokenUsage = usage;
  const meta = cleanMeta(input.metadata);
  if (meta) ev.metadata = meta;
  return { ok: true, ev };
}

/*
 * 分级脱敏（level）：
 *   2 管理员 / 本机     完整
 *   1 观看者（VIEW_TOKEN）去掉模型输出片段、文件路径、元数据（保留任务标题与简短错误）
 *   0 匿名远程观看者     再去掉任务标题与错误细节
 * 状态、类型、工具名、耗时、Token 在各级别都保留，大屏视觉不受影响。
 */
const STRIP = { 1: ['text', 'filePath', 'metadata'], 0: ['text', 'filePath', 'metadata', 'task', 'error'] };
function redact(obj, level) {
  if (!obj || typeof obj !== 'object' || level >= 2) return obj;
  const o = { ...obj };
  for (const k of STRIP[level] || STRIP[0]) delete o[k];
  return o;
}

module.exports = { PROTOCOL_VERSION, EVENT_TYPES, STATUSES, SOURCES, normalize, redact, newTaskId, cleanUsage, TASK_ID_RE };
