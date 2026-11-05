#!/usr/bin/env node
/*
 * AI 星环 · 本地服务（零依赖，Node 18+）
 *  - 静态托管 public/（大屏 panel.html、管理界面 admin.html）
 *  - /api/events  SSE 实时事件流，大屏据此转动
 *  - /api/event   外部 AI / 脚本 / Claude Code hooks 往这里推送状态
 *  - 管理外部 AI 供应商（Claude / ChatGPT / Kimi / DeepSeek / 任意 OpenAI 兼容接口）
 *  - /api/run     双模型协同任务：A 起草 → B 审核 → A 修订
 *
 * 默认只监听 127.0.0.1。API Key 只保存在本机 data/config.json。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const EV = require('./lib/events');
const SEC = require('./lib/security');
const MSG = require('./lib/messages');
const SSE = require('./lib/sse');
const { Runtime } = require('./lib/runtime');
const { ArtifactStore } = require('./lib/artifacts');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.AIJ_DATA_DIR ? path.resolve(process.env.AIJ_DATA_DIR) : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const TASKS_FILE = path.join(DATA, 'tasks.json');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
/* 出站安全策略（见 lib/security.js 顶部说明）：ALLOWED_BASE_HOSTS、ALLOWED_BASE_PORTS、LOCAL_MODEL_TARGETS；
   另有 VIEW_TOKEN、TRUST_PROXY（后续批次使用） */
const POLICY = SEC.policyFromEnv(process.env);
const VIEW_TOKEN = process.env.VIEW_TOKEN && process.env.VIEW_TOKEN.length >= 12 ? process.env.VIEW_TOKEN : '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const authThrottle = new SEC.AuthThrottle();
const externalLimiter = new SEC.RateLimiter(100, 200); // 外部上报：每秒 100 条，突发 200

/* ------------------------------------------------------------------ 配置 */
const PRESETS = {
  claude: { label: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', modelHint: 'claude-sonnet-5-5' },
  chatgpt: { label: 'ChatGPT', type: 'openai', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', modelHint: '填写 OpenAI 模型名' },
  kimi: { label: 'Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', envKey: 'MOONSHOT_API_KEY', modelHint: '填写 Kimi 模型名' },
  deepseek: { label: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', modelHint: '填写 DeepSeek 模型名' },
  custom: { label: '自定义', type: 'openai', baseUrl: '', envKey: '', modelHint: '任意 OpenAI 兼容接口' },
};

const DEFAULT_SETTINGS = { showText: false, idleTimeoutSec: 120, maxTokens: 4096, timeoutSec: 300 };

function defaultConfig() {
  return { token: crypto.randomBytes(12).toString('hex'), settings: { ...DEFAULT_SETTINGS }, providers: [] };
}
function saveConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}
function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { c = null; }
  const d = defaultConfig();
  if (!c || typeof c !== 'object') { c = d; }
  c.token = c.token || d.token;
  c.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
  c.providers = Array.isArray(c.providers) ? c.providers : [];
  /* 旧配置里不合规的 envKey 一律清空（防止借它读取任意环境变量） */
  for (const p of c.providers) if (!SEC.isAllowedEnvKey(p.envKey)) { console.error(`供应商 ${p.id} 的 envKey 不在允许范围，已清空：`, p.envKey); p.envKey = ''; }
  return c;
}
const cfg = loadConfig();
/* 云端部署（配置不持久）：用环境变量固定令牌并自动建立供应商。
   ADMIN_TOKEN=管理令牌；<KEY 环境变量> + <ID>_MODEL，如 ANTHROPIC_API_KEY + CLAUDE_MODEL。 */
if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 12) cfg.token = process.env.ADMIN_TOKEN;
for (const id of ['claude', 'chatgpt', 'kimi', 'deepseek']) {
  const pr = PRESETS[id], model = (process.env[id.toUpperCase() + '_MODEL'] || '').trim();
  if (!process.env[pr.envKey] || !model || cfg.providers.some(x => x.id === id)) continue;
  cfg.providers.push({ id, apiKey: '', label: pr.label, type: pr.type, baseUrl: pr.baseUrl, model, role: '', envKey: pr.envKey, enabled: true });
}
try { saveConfig(); } catch (e) { console.error('无法写入 data/config.json：', e.message); }

/* ------------------------------------------------------------------ 状态 */
/* 运行时计数见 lib/runtime.js：totals 只统计 source=server 的真实调用；tokens（厂商用量）与 estimatedTokens（估算）分开 */
const RT = new Runtime();
const clients = new Set(); // 每个 res 带 res._lvl：2 管理员/本机，1 观看者，0 匿名
const str = (s, n) => String(s == null ? '' : s).slice(0, n);

/* ------------------------------------------------------------------ 任务模型（事件与任务通过 taskId 关联，落盘保存） */
const MAX_TASKS = 100, MAX_TASK_EVENTS = 300;
const tasks = new Map();
let tasksDirty = false, tasksTimer = null;
function loadTasks() {
  let arr; try { arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { arr = []; }
  for (const t of Array.isArray(arr) ? arr : []) {
    if (!t || !EV.TASK_ID_RE.test(String(t.id))) continue;
    if (t.status === 'running') { t.status = 'interrupted'; t.error = '服务重启，任务中断'; }
    tasks.set(t.id, t);
  }
}
function writeTasksNow() {
  tasksDirty = false;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = TASKS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...tasks.values()]), { mode: 0o600 });
    fs.renameSync(tmp, TASKS_FILE);
  } catch (e) { console.error('无法写入 data/tasks.json：', e.message); }
}
function persistTasks() {
  tasksDirty = true;
  if (tasksTimer) return;
  tasksTimer = setTimeout(() => { tasksTimer = null; if (tasksDirty) writeTasksNow(); }, 800);
  tasksTimer.unref?.();
}
/* 立即落盘（任务结束、服务关闭时使用） */
function flushTasks() {
  if (tasksTimer) { clearTimeout(tasksTimer); tasksTimer = null; }
  writeTasksNow();
}
/* 超出上限时先删最早的已结束任务；运行中的任务永不删除 */
function trimTasks() {
  while (tasks.size > MAX_TASKS) {
    const key = [...tasks.entries()].find(([, t]) => t.status !== 'running')?.[0];
    if (key === undefined) return;
    tasks.delete(key);
  }
}
function taskSummary(t) {
  const { steps, events, ...rest } = t;
  return { ...rest, stepCount: (steps || []).length, eventCount: t.eventCount || 0 };
}
/* 把事件挂到任务上：逐 token 的 model_stream 只计数，不逐条保存，避免膨胀 */
function recordTaskEvent(ev) {
  const t = ev.taskId && tasks.get(ev.taskId);
  if (!t) return;
  t.eventCount = (t.eventCount || 0) + 1;
  if (ev.eventType === 'model_stream') { t.streamEvents = (t.streamEvents || 0) + 1; return; }
  (t.events || (t.events = [])).push(ev);
  if (t.events.length > MAX_TASK_EVENTS) t.events.splice(1, 1); // 保留首条 task_start，丢弃最旧的中间事件
  persistTasks();
}

/* 外部上报去重：同一主体、同一 agent 的同一 clientEventId 只处理一次（重试 / 网络重发不会重复计数） */
const seenClientEvents = new Map();
const MAX_CLIENT_EVENTS = 5000;
const MAX_EXTERNAL_TASKS_PER_OWNER = 50;
const isProviderId = id => cfg.providers.some(p => p.id === id);

/* 外部上报的任务归属：平台内部任务一律拒绝；外部任务只属于首次创建它的上报主体 */
function claimExternalTask(taskId, owner, input) {
  if (!taskId) return { ok: true };
  const t = tasks.get(taskId);
  if (t) {
    if (t.kind !== 'external' || t.owner !== owner) return { ok: false, code: 403, error: '无权向任务 ' + taskId + ' 上报事件：该任务不属于当前上报主体' };
    return { ok: true };
  }
  let n = 0;
  for (const x of tasks.values()) if (x.kind === 'external' && x.owner === owner) n++;
  if (n >= MAX_EXTERNAL_TASKS_PER_OWNER) return { ok: false, code: 429, error: '该上报主体的外部任务数量已达上限（' + MAX_EXTERNAL_TASKS_PER_OWNER + '）' };
  tasks.set(taskId, { id: taskId, kind: 'external', owner, title: str(input.task || taskId, 30), status: 'reported', verification: 'reported', createdAt: Date.now(), steps: [], events: [] });
  trimTasks(); persistTasks();
  return { ok: true };
}

/*
 * ingest：身份与归属校验 → 去重 → 规范化 → 运行时计数（lib/runtime.js）→ 记录到任务 → 广播。
 * opts：{ source, owner（外部上报主体）, allowedAgents（该主体允许使用的 agentId，可空）,
 *         taskId, runId, spanId, parentSpanId, attempt, agentInstanceId, roleId, usageSource }
 * 返回事件对象，或 { error, code }，或 { duplicate, eventId }。
 */
function ingest(ev, opts = {}) {
  const source = opts.source || 'server';
  const owner = source === 'external' ? (opts.owner || 'local') : null;
  const input = ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : {};
  const aid = str(input.agentId !== undefined ? input.agentId : input.agent, 40).trim();
  let dedupKey = null;
  if (source === 'external') {
    if (aid && (isProviderId(aid) || /^demo-/i.test(aid))) return { code: 400, error: '外部事件不能使用平台模型连接 ID 或 demo- 前缀的 agentId，请换一个名称' };
    if (aid && Array.isArray(opts.allowedAgents) && opts.allowedAgents.length && !opts.allowedAgents.includes(aid)) return { code: 403, error: '当前上报凭证无权使用 agentId "' + aid + '"' };
    if (input.clientEventId !== undefined && input.clientEventId !== null) {
      if (typeof input.clientEventId !== 'string' || !EV.ID_RE.test(input.clientEventId)) return { code: 400, error: 'clientEventId 格式不合法（字母、数字、下划线、点、连字符，最长 64 位）' };
      dedupKey = owner + '\u0000' + aid + '\u0000' + input.clientEventId;
      if (seenClientEvents.has(dedupKey)) return { duplicate: true, eventId: seenClientEvents.get(dedupKey) };
    }
  } else if (source === 'demo' && !/^demo-/.test(aid)) return { code: 400, error: '演示事件的 agentId 必须以 demo- 开头' };
  const conflict = RT.check(aid, source, owner);
  if (conflict) return { code: 409, error: conflict };

  const norm = EV.normalize(input, {
    source, taskId: opts.taskId, runId: opts.runId, spanId: opts.spanId, parentSpanId: opts.parentSpanId,
    attempt: opts.attempt, agentInstanceId: opts.agentInstanceId, roleId: opts.roleId, usageSource: opts.usageSource,
  });
  if (!norm.ok) return { code: 400, error: norm.error };
  const env = norm.ev;
  if (source === 'external') {
    const claim = claimExternalTask(env.taskId, owner, input);
    if (!claim.ok) return { code: claim.code, error: claim.error };
    if (dedupKey) {
      seenClientEvents.set(dedupKey, env.eventId);
      if (seenClientEvents.size > MAX_CLIENT_EVENTS) seenClientEvents.delete(seenClientEvents.keys().next().value);
    }
  }
  const { agent: a, tokens } = RT.apply(env, input, owner);
  const tk = env.tokenUsage && env.tokenUsage.total;
  /* 输出 = 新协议信封 + 旧版字段（大屏 panel.html 仍按旧字段响应，协议向后兼容） */
  const out = {
    ...env,
    type: 'event', t: env.timestamp, agent: a.id, label: a.label, model: a.model, role: a.role,
    task: a.task, tokens: tokens !== undefined ? tokens : tk,
    ms: env.durationMs, to: input.to ? str(input.to, 40) : undefined, working: RT.working(),
  };
  if (input.error) out.error = str(input.error, 160);
  if (cfg.settings.showText && input.text) out.text = str(input.text, 400);
  recordTaskEvent(out);
  broadcast(out);
  return out;
}

function snapshot(level = 2) {
  const list = RT.publicAgents(24).map(a => EV.redact(a, level));
  return {
    type: 'state', now: Date.now(), working: list.filter(a => a.status === 'working').length, agents: list,
    providers: cfg.providers.map(p => ({ id: p.id, label: p.label, model: p.model, enabled: p.enabled !== false, ready: providerReady(p) })),
    totals: { ...RT.totals, agents: RT.agents.size }, showText: level >= 2 && !!cfg.settings.showText,
  };
}
function sseSend(res, line) { try { res.write(line); } catch { clients.delete(res); } }
function broadcast(obj) {
  const cache = {};
  for (const res of clients) {
    const lvl = res._lvl;
    sseSend(res, cache[lvl] || (cache[lvl] = 'data: ' + JSON.stringify(EV.redact(obj, lvl)) + '\n\n'));
  }
}
function broadcastState() {
  const cache = {};
  for (const res of clients) {
    const lvl = res._lvl;
    sseSend(res, cache[lvl] || (cache[lvl] = 'data: ' + JSON.stringify(snapshot(lvl)) + '\n\n'));
  }
}
setInterval(() => {
  for (const a of RT.sweep(Date.now(), cfg.settings.idleTimeoutSec * 1000)) {
    ingest({ agent: a.id, eventType: 'activity', task: '超时，回到待机' }, { source: a.source, owner: a.owner });
  }
  broadcastState();
}, 2000).unref?.();
setInterval(() => { for (const res of clients) sseSend(res, ': hb\n\n'); }, 15000).unref?.();

/* ------------------------------------------------------------------ 模型调用 */
loadTasks();
/* 流量上限：单事件 / 单次调用 / 单任务累计，防止异常上游无限输出 */
const LIMITS = { maxEventBytes: 1 << 20, maxCallBytes: 8 << 20, maxTaskBytes: 32 << 20 };
const MAX_TASK_CHARS = 200000; // 单个任务输入上限：超过直接拒绝，不截断
/* 仅供自动化测试：缩短超时 / 流量上限以便快速覆盖失败路径；生产环境不要设置 */
const TEST_TIMEOUT_MS = Number(process.env.AIJ_TEST_TIMEOUT_MS) || 0;
if (Number(process.env.AIJ_TEST_MAX_CALL_BYTES) > 0) LIMITS.maxCallBytes = Number(process.env.AIJ_TEST_MAX_CALL_BYTES);
const taskBytes = new Map();
const providerKey = p => p.apiKey || (p.envKey && SEC.isAllowedEnvKey(p.envKey) && process.env[p.envKey]) || '';
const providerReady = p => !!(providerKey(p) && p.model);

async function streamChat(p, { system, prompt, maxTokens, onDelta, onUsage, onActivity, onBytes }) {
  const key = providerKey(p);
  if (!key) throw new Error('未配置 API Key（可在管理界面填写，或设置环境变量 ' + (p.envKey || '—') + '）');
  if (!p.model) throw new Error('未填写模型名');
  if (!p.baseUrl) throw new Error('未填写 Base URL');
  /* 密钥来源优先级：供应商里显式保存的 apiKey > 环境变量（envKey）。
     环境变量密钥与目标主机严格绑定：官方变量只发往官方主机，没有白名单例外；第三方接口请用 AIJ_*_KEY。 */
  let host;
  try { host = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { throw new Error('Base URL 格式不正确'); }
  if (!p.apiKey && !SEC.envKeyHostOk(p.envKey, host)) {
    throw new Error('环境变量 ' + p.envKey + ' 只能用于其官方主机；第三方接口请直接填写 API Key，或改用 AIJ_ 开头的环境变量名');
  }
  const base = p.baseUrl.replace(/\/+$/, '');
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS || cfg.settings.timeoutSec * 1000);
  let url, headers, body;
  if (p.type === 'anthropic') {
    url = /\/v1$/.test(base) ? base + '/messages' : base + '/v1/messages';
    headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = { model: p.model, max_tokens: maxTokens || cfg.settings.maxTokens, stream: true, messages: [{ role: 'user', content: prompt }] };
    if (system) body.system = system;
  } else {
    url = base + '/chat/completions';
    headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    body = { model: p.model, messages, stream: true };
    if (/api\.openai\.com/.test(base)) body.stream_options = { include_usage: true };
  }
  /* 出站：校验 + 固定解析 IP 连接 + 不跟随重定向（见 lib/security.js） */
  const res = await SEC.pinnedFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, POLICY);
  if (!res.ok) {
    let t = '';
    try { t = SEC.scrubSecrets((await SSE.readLimitedText(res, 4096)).replace(/\s+/g, ' ').slice(0, 240), [key]); } catch { /* ignore */ }
    throw new Error('HTTP ' + res.status + (t ? '：' + t : ''));
  }
  await SSE.parseSSE(res.body, data => {
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (p.type === 'anthropic') {
      if (j.type === 'message_start') onUsage(j.message?.usage?.input_tokens, undefined);
      else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') onDelta(j.delta.text || '');
      else if (j.type === 'content_block_delta') onActivity();
      else if (j.type === 'message_delta') onUsage(undefined, j.usage?.output_tokens);
      else if (j.type === 'error') throw new Error(j.error?.message || 'stream error');
    } else {
      if (j.error) throw new Error(j.error.message || 'stream error');
      const d = j.choices?.[0]?.delta;
      if (d?.content) onDelta(d.content);
      else if (d?.reasoning_content) onActivity();
      if (j.usage) onUsage(j.usage.prompt_tokens, j.usage.completion_tokens);
    }
  }, { maxEventBytes: LIMITS.maxEventBytes, maxTotalBytes: LIMITS.maxCallBytes, onBytes });
}

async function callModel(p, { role, task, system, prompt, maxTokens, taskId, runId, parentSpanId, attempt, agentInstanceId, roleId }) {
  const spanId = EV.newSpanId();
  const T = { taskId, runId, spanId, parentSpanId, attempt, agentInstanceId, roleId };
  ingest({ agent: p.id, label: p.label, model: p.model, role, task, eventType: 'model_start' }, T);
  const t0 = Date.now();
  /* inSeen / outSeen：厂商是否真的返回了该项用量 —— 区分“0”与“未知” */
  let out = '', inTok = 0, outTok = 0, inSeen = false, outSeen = false, pending = '', lastEmit = 0;
  const flush = force => {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    ingest({ agent: p.id, eventType: 'model_stream', tokenUsage: { total: outSeen ? outTok : Math.ceil(out.length / 1.6) }, text: pending }, { ...T, usageSource: outSeen ? 'provider' : 'estimated' });
    pending = '';
  };
  /* 当前用量：厂商返回过就用厂商值（含 0），否则估算；什么都没有时返回 null（未知） */
  const usageNow = () => {
    if (inSeen || outSeen) return { usage: { input: inSeen ? inTok : undefined, output: outSeen ? outTok : undefined, total: (inSeen ? inTok : 0) + (outSeen ? outTok : 0) }, source: 'provider' };
    if (out.length) return { usage: { total: Math.ceil((prompt.length + out.length) / 1.6) }, source: 'estimated' };
    return null;
  };
  try {
    await streamChat(p, {
      system, prompt, maxTokens,
      onDelta: t => { out += t; if (cfg.settings.showText) pending += t; flush(false); },
      onUsage: (i, o) => {
        if (Number.isFinite(i) && i >= 0 && (i > 0 || !inSeen)) { inTok = i; inSeen = true; }
        if (Number.isFinite(o) && o >= 0 && (o > 0 || !outSeen)) { outTok = o; outSeen = true; }
      },
      onActivity: () => flush(false),
      onBytes: n => {
        if (!taskId) return;
        const used = (taskBytes.get(taskId) || 0) + n;
        taskBytes.set(taskId, used);
        if (taskBytes.size > 500) taskBytes.delete(taskBytes.keys().next().value);
        if (used > LIMITS.maxTaskBytes) throw new SSE.LimitError('任务累计响应超过 ' + LIMITS.maxTaskBytes + ' 字节上限');
      },
    });
    flush(true);
    const ms = Date.now() - t0;
    const u = usageNow() || { usage: { total: Math.ceil(prompt.length / 1.6) }, source: 'estimated' };
    /* 厂商未返回 usage 时为估算值，事件里明确标记 estimated，不当作真实计费依据 */
    ingest({ agent: p.id, eventType: 'model_done', durationMs: ms, tokenUsage: u.usage }, { ...T, usageSource: u.source });
    return { text: out, tokens: u.usage.total, inTokens: inTok, outTokens: outTok, ms, estimated: u.source !== 'provider', spanId };
  } catch (e) {
    /* 写入事件 / 任务记录 / 响应前统一脱敏，防止上游错误回显密钥 */
    const msg = SEC.scrubSecrets(e?.name === 'TimeoutError' ? '请求超时' : (e?.message || String(e)), [providerKey(p)]);
    /* 失败调用：已有用量则如实结算（厂商值或估算），没有任何输出时不附用量（= 未知） */
    const u = usageNow();
    ingest({ agent: p.id, eventType: 'model_error', error: msg, durationMs: Date.now() - t0, ...(u ? { tokenUsage: u.usage } : {}) }, u ? { ...T, usageSource: u.source } : T);
    throw new Error(msg);
  }
}

/* ------------------------------------------------------------------ 双模型任务 */
const SYS_DRAFT = '你是多 AI 协作平台中的通用助手。请直接完成用户任务，输出可直接使用的结果，语言精炼，不要寒暄。';
const SYS_REVIEW = '你是严格的交叉审核者。请逐条指出上一份输出中的错误、遗漏、前后不一致之处，并给出可执行的修改建议。只给审核意见，不要重写全文。';
const SYS_REVISE = '请根据审核意见修订你的原稿，直接输出最终版本；末尾单独一行列出“采纳 / 未采纳”的审核意见编号。';

/*
 * 消息总线 + 成果存储：A→B→A 的交接以结构化消息完成，消息与成果只保存在内存。
 * 身份三层解耦：connectionId（用户配置的模型连接）≠ agentInstanceId（本任务中承担某岗位的实例）≠ roleId（岗位）。
 * 同一个模型连接可以同时承担多个岗位，每个岗位是独立实例，照样通过消息总线通信；注册失败时任务直接失败，不切换执行机制。
 */
const bus = new MSG.MessageBus();
const artifacts = new ArtifactStore();
bus.onEvict = taskId => artifacts.drop(taskId);
setInterval(() => bus.sweepEnded(3600e3), 60e3).unref?.(); // 结束超过 1 小时的任务释放消息与成果

const instanceOf = (taskId, instanceId) => (tasks.get(taskId)?.agents || []).find(x => x.instanceId === instanceId);
bus.onTransition = ({ message: m, to }) => {
  if (to !== 'delivered') return;
  const from = instanceOf(m.taskId, m.from), dest = instanceOf(m.taskId, m.to);
  if (!from || !dest) return; // user / scheduler 参与的投递不产生 handoff
  ingest({ agent: from.connectionId, to: dest.connectionId, role: m.type === 'review' ? '回交修订' : '交接审核', eventType: 'handoff',
    metadata: { messageId: m.messageId, messageType: m.type, round: m.round, toAgentInstanceId: dest.instanceId, toRoleId: dest.roleId } },
  { taskId: m.taskId, runId: m.runId, agentInstanceId: from.instanceId, roleId: from.roleId });
};

/* 当前可用的模型连接：存在、未停用、已就绪 */
function connectionState(id) {
  const p = cfg.providers.find(x => x.id === id);
  if (!p) return { error: '不存在（可能已被删除）', code: 'connection_missing' };
  if (p.enabled === false) return { error: '已停用', code: 'connection_disabled' };
  if (!providerReady(p)) return { error: '未就绪（缺少 API Key 或模型名）', code: 'connection_not_ready' };
  return { p };
}

const MSG_PREVIEW = 2000;
/* 把文本装进消息：超过正文上限时完整存为成果，消息只带预览与引用（不截断、不丢内容） */
function packText(taskId, text, producer, label) {
  if (text.length <= MSG.MAX_TEXT) return { content: { format: 'text', text } };
  const r = artifacts.put(taskId, { kind: 'text', text, producer, label });
  if (!r.ok) throw Object.assign(new Error('内容过长且无法保存为成果：' + r.error), { code: 'artifact_limit' });
  const a = r.artifact;
  return {
    content: { format: 'text', text: text.slice(0, MSG_PREVIEW) + `\n…（全文 ${a.chars} 字符，见成果 ${a.artifactId}）` },
    artifactRefs: [a.artifactId],
    metadata: { fullTextArtifact: a.artifactId, chars: a.chars, sha256: a.sha256 },
  };
}
/* 接收方读取消息全文：有成果引用就取成果，取不到则报错（绝不把预览当全文） */
function readText(taskId, m) {
  const ref = m.metadata && m.metadata.fullTextArtifact;
  if (!ref) return m.content.text;
  const a = artifacts.get(taskId, ref);
  if (!a || a.chars !== m.metadata.chars) throw Object.assign(new Error('消息引用的成果 ' + ref + ' 缺失或不完整'), { code: 'artifact_missing' });
  return a.text;
}

async function runPipeline(run, A, B) {
  const steps = run.steps;
  const mkInst = (roleId, roleName, conn) => ({
    instanceId: 'ai_' + crypto.randomBytes(4).toString('hex') + '_' + roleId, roleId, roleName,
    connectionId: conn.id, connectionLabel: conn.label, model: conn.model, type: conn.type,
  });
  const drafter = mkInst('drafter', '起草', A);
  const reviewer = run.mode === 'single' ? null : mkInst('reviewer', '审核', B);
  run.agents = reviewer ? [drafter, reviewer] : [drafter]; // 落盘：历史任务保留执行时的模型信息
  const T = { taskId: run.id, runId: run.runId };

  /* 每一步开始前重新确认模型连接可用：停用 / 删除后不再发起新调用；已经发出的调用按开始时的配置完成 */
  const doStep = async (label, inst, system, prompt) => {
    const st = connectionState(inst.connectionId);
    if (st.error) throw Object.assign(new Error(`模型连接「${inst.connectionLabel}」${st.error}，任务在「${label}」前停止`), { code: st.code });
    const s = { label, roleId: inst.roleId, agentInstanceId: inst.instanceId, connectionId: inst.connectionId, provider: inst.connectionLabel, model: st.p.model, status: 'running', text: '', tokens: 0, ms: 0 };
    steps.push(s);
    try {
      const r = await callModel({ ...st.p }, { role: inst.roleName, task: run.title, system, prompt, taskId: run.id, runId: run.runId, agentInstanceId: inst.instanceId, roleId: inst.roleId });
      Object.assign(s, { status: 'done', text: r.text, tokens: r.tokens, ms: r.ms, estimated: r.estimated });
      return r.text;
    } catch (e) { Object.assign(s, { status: 'error', error: e.message }); throw e; }
  };
  const idOf = x => (x === 'user' ? 'user' : x.instanceId);
  const hop = (from, to, type, text, o = {}) => {
    const packed = packText(run.id, text, idOf(from), type);
    const sent = bus.send({ taskId: run.id, from: idOf(from), to: idOf(to), type, round: o.round, replyTo: o.replyTo, threadId: o.threadId, ...packed });
    if (!sent.ok) throw Object.assign(new Error('消息发送失败：' + sent.error), { code: 'message_rejected' });
    const id = sent.message.messageId;
    if (!bus.queue(run.id, id).ok) throw Object.assign(new Error('消息入队失败'), { code: 'message_rejected' });
    const d = to === 'user' ? bus.deliver(run.id, id).message : bus.next(run.id, idOf(to));
    if (!d || d.messageId !== id) throw Object.assign(new Error('消息投递失败'), { code: 'message_rejected' });
    return d;
  };
  const take = m => bus.consume(run.id, m.messageId);

  ingest({ agent: A.id, label: A.label, task: run.title, eventType: 'task_start' }, { ...T, agentInstanceId: drafter.instanceId, roleId: drafter.roleId });
  let registered = false;
  try {
    const reg = bus.registerTask(run.id, { runId: run.runId, agents: run.agents.map(x => x.instanceId) });
    if (!reg.ok) throw Object.assign(new Error('消息总线注册失败：' + reg.error), { code: 'bus_unavailable' });
    registered = true;
    const req = hop('user', drafter, 'request', run.task, { round: 1 }); take(req);
    const draft = await doStep('起草', drafter, SYS_DRAFT, readText(run.id, req));
    if (run.mode === 'single') {
      take(hop(drafter, 'user', 'proposal', draft, { round: 1, threadId: req.threadId }));
    } else {
      const m1 = hop(drafter, reviewer, 'proposal', draft, { round: 1, threadId: req.threadId }); take(m1);
      const review = await doStep('交叉审核', reviewer, SYS_REVIEW, `【任务】\n${run.task}\n\n【待审核输出】\n${readText(run.id, m1)}`);
      if (run.mode === 'review') {
        take(hop(reviewer, 'user', 'review', review, { round: 1, threadId: m1.threadId }));
      } else {
        const m2 = hop(reviewer, drafter, 'review', review, { round: 1, replyTo: m1.messageId }); take(m2);
        const final = await doStep('修订', drafter, SYS_REVISE, `【任务】\n${run.task}\n\n【你的原稿】\n${draft}\n\n【审核意见】\n${readText(run.id, m2)}`);
        take(hop(drafter, 'user', 'revision', final, { round: 2, threadId: m2.threadId }));
      }
    }
    run.status = 'done';
    bus.endTask(run.id, 'completed');
    ingest({ agent: A.id, task: run.title, eventType: 'task_done' }, { ...T, agentInstanceId: drafter.instanceId, roleId: drafter.roleId });
  } catch (e) {
    run.status = 'error'; run.error = e.message; run.errorCode = e.code || 'model_error';
    if (registered) {
      for (const m of bus.list(run.id)) if (m.status === 'delivered') bus.fail(run.id, m.messageId, '处理失败：' + String(e.message).slice(0, 100));
      bus.endTask(run.id, 'failed');
    }
    ingest({ agent: A.id, task: run.title, eventType: 'task_error', error: e.message }, { ...T, agentInstanceId: drafter.instanceId, roleId: drafter.roleId });
  }
  if (registered) { run.messageStats = bus.stats(run.id); run.artifacts = artifacts.list(run.id); } // 只保存统计与成果元数据，正文只在内存中
  run.endedAt = Date.now();
  flushTasks(); // 任务结束（成功 / 失败）立即落盘，不等防抖定时器
}

/* ------------------------------------------------------------------ 演示（无需任何 API Key） */
let demoTimer = null;
function startDemo(seconds) {
  clearInterval(demoTimer);
  const A = { agent: 'demo-claude', label: 'CLAUDE(演示)', model: 'demo' }, B = { agent: 'demo-gpt', label: 'CHATGPT(演示)', model: 'demo' };
  const total = Math.max(6, Math.min(120, seconds | 0 || 15)), t0 = Date.now();
  let phase = 0, tok = 0;
  const third = total / 3;
  ingest({ ...A, status: 'start', role: '起草', task: '演示：起草评审流程' }, { source: 'demo' });
  demoTimer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    tok += 30 + (Math.random() * 40 | 0);
    if (phase === 0 && el > third) { phase = 1; ingest({ ...A, status: 'done', tokens: tok, ms: el * 1000 }, { source: 'demo' }); ingest({ ...A, status: 'handoff', to: B.agent }, { source: 'demo' }); ingest({ ...B, status: 'start', role: '审核', task: '演示：交叉审核' }, { source: 'demo' }); tok = 0; }
    else if (phase === 1 && el > 2 * third) { phase = 2; ingest({ ...B, status: 'done', tokens: tok, ms: third * 1000 }, { source: 'demo' }); ingest({ ...B, status: 'handoff', to: A.agent }, { source: 'demo' }); ingest({ ...A, status: 'start', role: '修订', task: '演示：修订终稿' }, { source: 'demo' }); tok = 0; }
    else if (el > total) { clearInterval(demoTimer); ingest({ ...A, status: 'done', tokens: tok, ms: third * 1000 }, { source: 'demo' }); return; }
    ingest({ ...(phase === 1 ? B : A), status: 'stream', tokens: tok }, { source: 'demo' });
  }, 300);
}

/* ------------------------------------------------------------------ HTTP */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const isLoopbackAddr = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const localHostHeader = req => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function authOK(req) {
  if (isLoopbackAddr(req.socket.remoteAddress) && localHostHeader(req)) return true;
  const t = req.headers['x-admin-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return !!t && safeEq(t, cfg.token);
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(b);
}
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON 格式错误')); } });
    req.on('error', reject);
  });
}
const maskProvider = p => ({
  id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, model: p.model, role: p.role || '', envKey: p.envKey || '',
  enabled: p.enabled !== false, hasKey: !!p.apiKey, envReady: !!(p.envKey && SEC.isAllowedEnvKey(p.envKey) && process.env[p.envKey]), keyHint: p.apiKey ? '••••' + p.apiKey.slice(-4) : '',
});
const hostOf = u => { try { return new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
/* 保存供应商前的统一校验。返回错误文本，或 null 表示通过。 */
function validateProviderInput(next, existing, newKey, clearKey) {
  if (!SEC.isAllowedEnvKey(next.envKey)) {
    return 'envKey 只能是 ' + Object.keys(SEC.ENV_KEY_HOST).join(' / ') + '，或以 AIJ_ 开头、以 _KEY 结尾的自定义名称';
  }
  let host = '';
  if (next.baseUrl) {
    const c = SEC.checkBaseUrlSyntax(next.baseUrl, POLICY);
    if (!c.ok) return c.error;
    host = c.host;
  }
  const keyAfter = clearKey ? '' : (newKey || (existing && existing.apiKey) || '');
  /* 没有显式 API Key 时将使用环境变量：官方变量必须与官方主机一一绑定 */
  if (host && !keyAfter && next.envKey && !SEC.envKeyHostOk(next.envKey, host)) {
    return '环境变量 ' + next.envKey + ' 只能用于 ' + SEC.ENV_KEY_HOST[next.envKey] + '；第三方接口请直接填写 API Key，或改用 AIJ_ 开头的环境变量名';
  }
  /* 已保存的 API Key 不会自动转发到新主机：换主机必须重新填写 */
  if (existing && existing.apiKey && !newKey && !clearKey) {
    const old = hostOf(existing.baseUrl);
    if (old && host && old !== host) return '更换 Base URL 的主机后，需要重新填写 API Key（已保存的密钥不会自动发往新主机）';
  }
  return null;
}
const slug = s => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ai').slice(0, 24);

function lanUrls() {
  if (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1') return [];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (m !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: '跨站请求被拒绝' });

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    /* 过渡实现：目前所有连接按完整级别（2）收发，与分级前行为一致；第三批将改为按令牌区分 0/1/2 级并做字段白名单 */
    res._lvl = 2;
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot(2)) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state' && m === 'GET') return json(res, 200, snapshot());

  if (!authOK(req)) return json(res, 401, { error: '需要管理令牌（x-admin-token）。令牌见服务启动日志或 data/config.json' });

  if (p === '/api/config' && m === 'GET') {
    return json(res, 200, {
      providers: cfg.providers.map(maskProvider), settings: cfg.settings, presets: PRESETS,
      /* 不再通过配置接口回传管理令牌；令牌见服务启动日志或 data/config.json */
      server: { port: PORT, host: HOST, lan: lanUrls(), root: ROOT, node: process.version },
    });
  }
  if (p === '/api/settings' && m === 'POST') {
    const b = await readBody(req);
    const s = cfg.settings;
    if (typeof b.showText === 'boolean') s.showText = b.showText;
    if (Number.isFinite(b.idleTimeoutSec)) s.idleTimeoutSec = Math.max(10, Math.min(3600, b.idleTimeoutSec | 0));
    if (Number.isFinite(b.maxTokens)) s.maxTokens = Math.max(256, Math.min(64000, b.maxTokens | 0));
    if (Number.isFinite(b.timeoutSec)) s.timeoutSec = Math.max(30, Math.min(1800, b.timeoutSec | 0));
    saveConfig();
    return json(res, 200, { settings: s });
  }
  if (p === '/api/providers' && m === 'POST') {
    const b = await readBody(req);
    const existing = b.id ? cfg.providers.find(x => x.id === b.id) : null;
    const next = {
      label: str(b.label || (existing && existing.label) || 'AI', 40),
      type: b.type === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: str(b.baseUrl, 300).trim(),
      model: str(b.model, 80).trim(),
      role: str(b.role, 80),
      envKey: str(b.envKey, 60).trim(),
      enabled: b.enabled !== false,
    };
    const newKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    /* 先校验、通过后才修改配置：校验失败不留下任何半成品 */
    const bad = validateProviderInput(next, existing, newKey, !!b.clearKey);
    if (bad) return json(res, 400, { error: bad });
    let prov = existing;
    if (!prov) {
      let id = slug(b.label || b.id || 'ai'), n = 2;
      while (cfg.providers.some(x => x.id === id)) id = slug(b.label || 'ai') + '-' + n++;
      prov = { id, apiKey: '' };
      cfg.providers.push(prov);
    }
    Object.assign(prov, next);
    if (b.clearKey) prov.apiKey = '';
    else if (newKey) prov.apiKey = newKey;
    saveConfig();
    return json(res, 200, { provider: maskProvider(prov) });
  }
  let mm;
  if ((mm = p.match(/^\/api\/providers\/([\w-]+)$/)) && m === 'DELETE') {
    const i = cfg.providers.findIndex(x => x.id === mm[1]);
    if (i < 0) return json(res, 404, { error: '不存在' });
    cfg.providers.splice(i, 1); saveConfig();
    return json(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/providers\/([\w-]+)\/test$/)) && m === 'POST') {
    const prov = cfg.providers.find(x => x.id === mm[1]);
    if (!prov) return json(res, 404, { error: '不存在' });
    const t0 = Date.now();
    try {
      const r = await callModel(prov, { role: '连接测试', task: '连接测试', prompt: '只回复一个字：好', maxTokens: 32 });
      return json(res, 200, { ok: true, ms: Date.now() - t0, tokens: r.tokens, reply: r.text.slice(0, 60) });
    } catch (e) { return json(res, 200, { ok: false, ms: Date.now() - t0, error: e.message }); }
  }
  if (p === '/api/event' && m === 'POST') {
    const b = await readBody(req);
    if (!b || typeof b !== 'object' || !b.agent) return json(res, 400, { error: '缺少 agent 字段' });
    const r = ingest(b, { source: 'external', owner: 'local' });
    if (r.error) return json(res, r.code || 400, { error: r.error });
    return json(res, 200, { ok: true, eventId: r.eventId, ...(r.duplicate ? { duplicate: true } : {}) });
  }
  if (p === '/api/demo' && m === 'POST') {
    const b = await readBody(req);
    startDemo(b.seconds);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/run' && m === 'POST') {
    const b = await readBody(req);
    const task = typeof b.task === 'string' ? b.task.trim() : '';
    if (!task) return json(res, 400, { error: '任务内容为空' });
    if (task.length > MAX_TASK_CHARS) return json(res, 400, { error: `任务内容 ${task.length} 字符，超过 ${MAX_TASK_CHARS} 字符上限。请精简或拆分后再提交（系统不会自动截断）` });
    const mode = ['single', 'review', 'full'].includes(b.mode) ? b.mode : 'full';
    const sa = connectionState(b.a);
    if (sa.error) return json(res, 400, { error: '模型 A ' + sa.error, code: sa.code });
    let sb = null;
    if (mode !== 'single') { sb = connectionState(b.b); if (sb.error) return json(res, 400, { error: '模型 B ' + sb.error, code: sb.code }); }
    let id;
    do id = crypto.randomBytes(6).toString('hex'); while (tasks.has(id));
    const run = { id, kind: 'internal', runId: EV.newRunId(), title: str(task.replace(/\s+/g, ' '), 30), task, mode, status: 'running', steps: [], createdAt: Date.now() };
    tasks.set(id, run);
    trimTasks();
    persistTasks();
    runPipeline(run, sa.p, sb && sb.p).catch(e => console.error('任务执行异常：', e && e.message)); // 兜底：任何异常都不影响服务进程
    return json(res, 200, { runId: id });
  }
  if ((mm = p.match(/^\/api\/runs\/([\w-]+)\/artifacts$/)) && m === 'GET') {
    if (!tasks.has(mm[1])) return json(res, 404, { error: '不存在' });
    return json(res, 200, { artifacts: artifacts.list(mm[1]) }); // 仅内存；服务重启或结束 1 小时后为空
  }
  if ((mm = p.match(/^\/api\/runs\/([\w-]+)\/artifacts\/(art_[a-f0-9]{12})$/)) && m === 'GET') {
    const a = artifacts.get(mm[1], mm[2]);
    return a ? json(res, 200, a) : json(res, 404, { error: '成果不存在或已过期' });
  }
  if ((mm = p.match(/^\/api\/runs\/([\w-]+)\/messages$/)) && m === 'GET') {
    if (!tasks.has(mm[1])) return json(res, 404, { error: '不存在' });
    return json(res, 200, { messages: bus.list(mm[1]), stats: bus.stats(mm[1]) }); // 仅内存；服务重启后为空
  }
  if ((mm = p.match(/^\/api\/runs\/([\w-]+)$/)) && m === 'GET') {
    const r = tasks.get(mm[1]);
    return r ? json(res, 200, r) : json(res, 404, { error: '不存在' });
  }
  return json(res, 404, { error: '未知接口' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/panel.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=3600', 'accept-ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message || '服务内部错误' });
    else try { res.end(); } catch { /* ignore */ }
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用。可换端口启动：PORT=8800 node server.js（Windows：set PORT=8800 后再运行）`);
  else console.error(e);
  process.exit(1);
});
/* 关闭时：仍在运行的任务标记为中断并立即落盘，避免重启后状态与实际不一致 */
function shutdown() {
  for (const t of tasks.values()) if (t.status === 'running') { t.status = 'interrupted'; t.error = '服务停止，任务中断'; t.endedAt = Date.now(); }
  flushTasks();
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
server.listen(PORT, HOST, () => {
  console.log('\n  AI 星环 已启动');
  console.log(`  大屏      http://localhost:${PORT}/`);
  console.log(`  管理界面  http://localhost:${PORT}/admin.html`);
  for (const u of lanUrls()) console.log(`  局域网    ${u}/   （远程访问管理接口需令牌）`);
  if (lanUrls().length) console.log('  远程管理需要令牌：保存在 data/config.json（不在日志中打印）');
  console.log('  按 Ctrl+C 停止\n');
});
