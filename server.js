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
const agents = new Map();
/* totals 只统计平台自己发起并观察到的真实模型调用（source=server）。
   tokens = 厂商返回的真实用量；estimatedTokens = 估算值，单独统计，不当作计费依据；外部上报与演示只计事件数。 */
const totals = { calls: 0, tokens: 0, estimatedTokens: 0, errors: 0, reportedEvents: 0, simulatedEvents: 0 };
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
function trimTasks() { while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value); }
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

/* 外部上报去重：同一 agent 的同一 clientEventId 只处理一次（重试 / 网络重发不会重复计数） */
const seenClientEvents = new Map();
const MAX_CLIENT_EVENTS = 5000;
const isProviderId = id => cfg.providers.some(p => p.id === id);

/*
 * ingest：校验 → 去重 → 规范化 → 更新运行时计数 → 记录到任务 → 广播。
 * opts：{ source, taskId, runId, spanId, parentSpanId, attempt, usageSource }（服务端上下文，优先于事件体内的同名字段）
 * 运行时计数规则：
 *   - 模型调用并发数按 spanId 集合统计（a.spans），一个供应商同时跑多个任务互不覆盖；
 *   - task_* 任务级事件不改变“正在调用模型”的状态；
 *   - totals 只计 source=server 的真实调用；external（reported）与 demo（simulated）不进入真实统计。
 */
function ingest(ev, opts = {}) {
  const source = opts.source || 'server';
  const input = ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : {};
  const aid = str(input.agentId !== undefined ? input.agentId : input.agent, 40).trim();
  if (source === 'external') {
    if (aid && (isProviderId(aid) || /^demo-/i.test(aid))) return { error: '外部事件不能使用平台供应商 ID 或 demo- 前缀的 agentId，请换一个名称' };
    if (input.clientEventId !== undefined && input.clientEventId !== null) {
      if (typeof input.clientEventId !== 'string' || !EV.ID_RE.test(input.clientEventId)) return { error: 'clientEventId 格式不合法（字母、数字、下划线、点、连字符，最长 64 位）' };
      const dk = aid + '\u0000' + input.clientEventId;
      if (seenClientEvents.has(dk)) return { duplicate: true, eventId: seenClientEvents.get(dk) };
    }
  } else if (source === 'demo' && !/^demo-/.test(aid)) return { error: '演示事件的 agentId 必须以 demo- 开头' };
  const existing = aid ? agents.get(aid) : null;
  if (existing && existing.source !== source) return { error: 'agentId "' + aid + '" 已被其它来源（' + existing.source + '）占用，不能以 ' + source + ' 身份写入' };

  const norm = EV.normalize(input, { source, taskId: opts.taskId, runId: opts.runId, spanId: opts.spanId, parentSpanId: opts.parentSpanId, attempt: opts.attempt, usageSource: opts.usageSource });
  if (!norm.ok) return { error: norm.error };
  const env = norm.ev;
  if (source === 'external' && input.clientEventId) {
    seenClientEvents.set(aid + '\u0000' + input.clientEventId, env.eventId);
    if (seenClientEvents.size > MAX_CLIENT_EVENTS) seenClientEvents.delete(seenClientEvents.keys().next().value);
  }
  const id = env.agentId;
  const status = env.status;
  const now = env.timestamp;
  let a = existing;
  if (!a) {
    if (agents.size >= 200) {
      const old = [...agents.values()].filter(x => x.status !== 'working').sort((x, y) => x.last - y.last)[0];
      if (old) agents.delete(old.id);
    }
    a = { id, source, verification: env.verification, label: id, model: '', role: '', status: 'idle', task: '', calls: 0, tokens: 0, estimatedTokens: 0, errors: 0, since: now, last: now, ms: 0, live: 0, active: 0, spans: new Set() };
    agents.set(id, a);
  }
  a.last = now;
  if (input.label) a.label = str(input.label, 40);
  if (input.model) a.model = str(input.model, 60);
  if (input.role !== undefined) a.role = str(input.role, 40);
  if (input.task !== undefined) a.task = str(input.task, 80);

  const usage = env.tokenUsage;
  const tk = usage && usage.total;
  let tokens;
  if (source === 'server') {
    const et = env.eventType, sid = env.spanId;
    if (et === 'model_start') {
      a.spans.add(sid); a.status = 'working'; a.since = now; a.calls++; totals.calls++; a.live = 0;
    } else if (et === 'model_stream') {
      if (a.spans.has(sid) && a.status !== 'working') { a.status = 'working'; a.since = now; }
      if (tk !== undefined) a.live = tk;
    } else if (et === 'model_done') {
      a.spans.delete(sid);
      if (!a.spans.size) a.status = 'idle';
      a.ms = env.durationMs !== undefined ? env.durationMs : now - a.since;
      if (tk > 0) {
        if (usage.source === 'provider') { a.tokens += tk; totals.tokens += tk; tokens = tk; }
        else { a.estimatedTokens += tk; totals.estimatedTokens += tk; }
      }
    } else if (et === 'model_error') {
      a.spans.delete(sid);
      a.status = a.spans.size ? 'working' : 'error'; a.errors++; totals.errors++;
    }
    a.active = a.spans.size;
  } else {
    /* external / demo：沿用旧的 status 计数（供 signal.js 与演示使用），但不进入真实统计 */
    if (source === 'external') totals.reportedEvents++; else totals.simulatedEvents++;
    if (status === 'start') {
      a.active++; a.status = 'working'; a.since = now; a.calls++; a.live = 0;
    } else if (status === 'stream') {
      if (a.status !== 'working') { a.status = 'working'; a.since = now; }
      if (tk !== undefined) a.live = tk;
    } else if (status === 'done') {
      a.active = Math.max(0, a.active - 1);
      if (!a.active) a.status = 'idle';
      a.ms = env.durationMs !== undefined ? env.durationMs : now - a.since;
      if (tk > 0) { a.tokens += tk; tokens = tk; }
    } else if (status === 'error') {
      a.active = Math.max(0, a.active - 1);
      a.status = a.active ? 'working' : 'error'; a.errors++;
    }
  }
  const working = [...agents.values()].filter(x => x.status === 'working').length;
  /* 输出 = 新协议信封 + 旧版字段（大屏 panel.html 仍按旧字段响应，协议向后兼容） */
  const out = {
    ...env,
    type: 'event', t: now, agent: id, label: a.label, model: a.model, role: a.role,
    task: a.task, tokens: tokens !== undefined ? tokens : tk,
    ms: env.durationMs, to: input.to ? str(input.to, 40) : undefined, working,
  };
  if (input.error) out.error = str(input.error, 160);
  if (cfg.settings.showText && input.text) out.text = str(input.text, 400);
  recordTaskEvent(out);
  broadcast(out);
  return out;
}

function snapshot(level = 2) {
  const list = [...agents.values()].sort((a, b) => b.last - a.last).slice(0, 24).map(a => EV.redact({
    id: a.id, label: a.label, model: a.model, role: a.role, status: a.status, task: a.task,
    calls: a.calls, tokens: a.tokens, estimatedTokens: a.estimatedTokens, errors: a.errors, since: a.since, last: a.last, ms: a.ms, live: a.live,
    source: a.source, verification: a.verification,
  }, level));
  return {
    type: 'state', now: Date.now(), working: list.filter(a => a.status === 'working').length, agents: list,
    providers: cfg.providers.map(p => ({ id: p.id, label: p.label, model: p.model, enabled: p.enabled !== false, ready: providerReady(p) })),
    totals: { ...totals, agents: agents.size }, showText: level >= 2 && !!cfg.settings.showText,
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
  const now = Date.now(), limit = cfg.settings.idleTimeoutSec * 1000;
  for (const a of agents.values()) {
    if (a.status === 'working' && now - a.last > limit) { a.status = 'idle'; a.active = 0; a.spans.clear(); ingest({ agent: a.id, eventType: 'activity', task: '超时，回到待机' }, { source: a.source }); }
    else if (a.status === 'error' && now - a.last > 30000) a.status = 'idle';
  }
  broadcastState();
}, 2000).unref?.();
setInterval(() => { for (const res of clients) sseSend(res, ': hb\n\n'); }, 15000).unref?.();

/* ------------------------------------------------------------------ 模型调用 */
loadTasks();
const providerKey = p => p.apiKey || (p.envKey && SEC.isAllowedEnvKey(p.envKey) && process.env[p.envKey]) || '';
const providerReady = p => !!(providerKey(p) && p.model);

async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }
}

async function streamChat(p, { system, prompt, maxTokens, onDelta, onUsage, onActivity }) {
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
  const signal = AbortSignal.timeout(cfg.settings.timeoutSec * 1000);
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
    try { t = SEC.scrubSecrets((await res.text()).replace(/\s+/g, ' ').slice(0, 240), [key]); } catch { /* ignore */ }
    throw new Error('HTTP ' + res.status + (t ? '：' + t : ''));
  }
  await readSSE(res, data => {
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (p.type === 'anthropic') {
      if (j.type === 'message_start') onUsage(j.message?.usage?.input_tokens, 0);
      else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') onDelta(j.delta.text || '');
      else if (j.type === 'content_block_delta') onActivity();
      else if (j.type === 'message_delta') onUsage(0, j.usage?.output_tokens);
      else if (j.type === 'error') throw new Error(j.error?.message || 'stream error');
    } else {
      if (j.error) throw new Error(j.error.message || 'stream error');
      const d = j.choices?.[0]?.delta;
      if (d?.content) onDelta(d.content);
      else if (d?.reasoning_content) onActivity();
      if (j.usage) onUsage(j.usage.prompt_tokens, j.usage.completion_tokens);
    }
  });
}

async function callModel(p, { role, task, system, prompt, maxTokens, taskId, runId, parentSpanId, attempt }) {
  const spanId = EV.newSpanId();
  const T = { taskId, runId, spanId, parentSpanId, attempt };
  ingest({ agent: p.id, label: p.label, model: p.model, role, task, eventType: 'model_start' }, T);
  const t0 = Date.now();
  let out = '', inTok = 0, outTok = 0, pending = '', lastEmit = 0;
  const flush = force => {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    ingest({ agent: p.id, eventType: 'model_stream', tokenUsage: { total: outTok || Math.ceil(out.length / 1.6) }, text: pending }, { ...T, usageSource: outTok ? 'provider' : 'estimated' });
    pending = '';
  };
  try {
    await streamChat(p, {
      system, prompt, maxTokens,
      onDelta: t => { out += t; if (cfg.settings.showText) pending += t; flush(false); },
      onUsage: (i, o) => { if (i) inTok = i; if (o) outTok = o; },
      onActivity: () => flush(false),
    });
    flush(true);
    const estimated = !(inTok + outTok);
    const total = (inTok + outTok) || Math.ceil((prompt.length + out.length) / 1.6);
    const ms = Date.now() - t0;
    /* 厂商未返回 usage 时为估算值，事件里明确标记 estimated，不当作真实计费依据 */
    ingest({ agent: p.id, eventType: 'model_done', durationMs: ms, tokenUsage: { input: inTok || undefined, output: outTok || undefined, total } }, { ...T, usageSource: estimated ? 'estimated' : 'provider' });
    return { text: out, tokens: total, inTokens: inTok, outTokens: outTok, ms, estimated, spanId };
  } catch (e) {
    /* 写入事件 / 任务记录 / 响应前统一脱敏，防止上游错误回显密钥 */
    const msg = SEC.scrubSecrets(e?.name === 'TimeoutError' ? '请求超时' : (e?.message || String(e)), [providerKey(p)]);
    ingest({ agent: p.id, eventType: 'model_error', error: msg, durationMs: Date.now() - t0 }, T);
    throw new Error(msg);
  }
}

/* ------------------------------------------------------------------ 双模型任务 */
const SYS_DRAFT = '你是多 AI 协作平台中的通用助手。请直接完成用户任务，输出可直接使用的结果，语言精炼，不要寒暄。';
const SYS_REVIEW = '你是严格的交叉审核者。请逐条指出上一份输出中的错误、遗漏、前后不一致之处，并给出可执行的修改建议。只给审核意见，不要重写全文。';
const SYS_REVISE = '请根据审核意见修订你的原稿，直接输出最终版本；末尾单独一行列出“采纳 / 未采纳”的审核意见编号。';

/* 消息总线：A→B→A 的交接以结构化消息完成。消息只保存在内存；“已交接”以投递事件为准（handoff 事件由消息投递驱动）。 */
const bus = new MSG.MessageBus();
bus.onTransition = ({ message: m, to }) => {
  if (to !== 'delivered' || m.from === MSG.RESERVED.USER || m.to === MSG.RESERVED.USER || m.from === MSG.RESERVED.SCHEDULER) return;
  ingest({ agent: m.from, to: m.to, role: m.type === 'review' ? '回交修订' : '交接审核', eventType: 'handoff', metadata: { messageId: m.messageId, messageType: m.type, round: m.round } },
    { taskId: m.taskId, runId: m.runId });
};

async function runPipeline(run, A, B) {
  const steps = run.steps;
  const doStep = async (label, p, role, system, prompt) => {
    const s = { label, providerId: p.id, provider: p.label, status: 'running', text: '', tokens: 0, ms: 0 };
    steps.push(s);
    try {
      const r = await callModel(p, { role, task: run.title, system, prompt, taskId: run.id, runId: run.runId });
      Object.assign(s, { status: 'done', text: r.text, tokens: r.tokens, ms: r.ms });
      return r.text;
    } catch (e) { Object.assign(s, { status: 'error', error: e.message }); throw e; }
  };
  const T = { taskId: run.id, runId: run.runId };
  /* 同一个供应商自己审自己时没有“两个参与者”，不走消息总线，仍直接发 handoff 事件 */
  const useBus = !(B && B.id === A.id) && bus.registerTask(run.id, { runId: run.runId, agents: B ? [A.id, B.id] : [A.id] }).ok;
  const hop = (from, to, type, text, o = {}) => {
    if (!useBus) {
      if (from !== 'user' && to !== 'user') ingest({ agent: from, to, role: type === 'review' ? '回交修订' : '交接审核', eventType: 'handoff' }, T);
      return { messageId: null, threadId: null, content: { text } };
    }
    const cut = text.length > MSG.MAX_TEXT;
    const sent = bus.send({ taskId: run.id, from, to, type, round: o.round, replyTo: o.replyTo, threadId: o.threadId,
      content: { format: 'text', text: cut ? text.slice(0, MSG.MAX_TEXT - 20) + '\n…[内容过长已截断]' : text }, metadata: cut ? { truncated: true } : undefined });
    if (!sent.ok) throw new Error('消息发送失败：' + sent.error);
    const id = sent.message.messageId;
    if (!bus.queue(run.id, id).ok) throw new Error('消息入队失败');
    const d = to === 'user' ? bus.deliver(run.id, id) : { ok: !!bus.next(run.id, to), message: bus.get(run.id, id) };
    if (!d.ok) throw new Error('消息投递失败');
    return d.message;
  };
  const take = m => { if (m.messageId) bus.consume(run.id, m.messageId); };

  ingest({ agent: A.id, label: A.label, task: run.title, eventType: 'task_start' }, T);
  try {
    const req = hop('user', A.id, 'request', run.task, { round: 1 }); take(req);
    const draft = await doStep('起草', A, '起草', SYS_DRAFT, req.content.text);
    if (run.mode === 'single') {
      take(hop(A.id, 'user', 'proposal', draft, { round: 1, threadId: req.threadId }));
    } else {
      const m1 = hop(A.id, B.id, 'proposal', draft, { round: 1, threadId: req.threadId }); take(m1);
      const review = await doStep('交叉审核', B, '审核', SYS_REVIEW, `【任务】\n${run.task}\n\n【待审核输出】\n${m1.content.text}`);
      if (run.mode === 'review') {
        take(hop(B.id, 'user', 'review', review, { round: 1, threadId: m1.threadId }));
      } else {
        const m2 = hop(B.id, A.id, 'review', review, { round: 1, replyTo: m1.messageId }); take(m2);
        const final = await doStep('修订', A, '修订', SYS_REVISE, `【任务】\n${run.task}\n\n【你的原稿】\n${draft}\n\n【审核意见】\n${m2.content.text}`);
        take(hop(A.id, 'user', 'revision', final, { round: 2, threadId: m2.threadId }));
      }
    }
    run.status = 'done';
    if (useBus) bus.endTask(run.id, 'completed');
    ingest({ agent: A.id, task: run.title, eventType: 'task_done' }, T);
  } catch (e) {
    run.status = 'error'; run.error = e.message;
    if (useBus) {
      for (const m of bus.list(run.id)) if (m.status === 'delivered') bus.fail(run.id, m.messageId, '处理失败：' + String(e.message).slice(0, 100));
      bus.endTask(run.id, 'failed');
    }
    ingest({ agent: A.id, task: run.title, eventType: 'task_error', error: e.message }, T);
  }
  if (useBus) run.messageStats = bus.stats(run.id); // 只保存统计，消息正文只在内存中
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
    const r = ingest(b, { source: 'external' });
    if (r.error) return json(res, 400, { error: r.error });
    return json(res, 200, { ok: true, eventId: r.eventId, ...(r.duplicate ? { duplicate: true } : {}) });
  }
  if (p === '/api/demo' && m === 'POST') {
    const b = await readBody(req);
    startDemo(b.seconds);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/run' && m === 'POST') {
    const b = await readBody(req);
    const task = str(b.task, 20000).trim();
    if (!task) return json(res, 400, { error: '任务内容为空' });
    const A = cfg.providers.find(x => x.id === b.a), B = cfg.providers.find(x => x.id === b.b);
    const mode = ['single', 'review', 'full'].includes(b.mode) ? b.mode : 'full';
    if (!A) return json(res, 400, { error: '请选择模型 A' });
    if (mode !== 'single' && !B) return json(res, 400, { error: '请选择模型 B' });
    const id = crypto.randomBytes(6).toString('hex');
    const run = { id, runId: EV.newRunId(), title: str(task.replace(/\s+/g, ' '), 30), task, mode, status: 'running', steps: [], createdAt: Date.now() };
    tasks.set(id, run);
    trimTasks();
    persistTasks();
    runPipeline(run, A, B);
    return json(res, 200, { runId: id });
  }
  if ((mm = p.match(/^\/api\/runs\/(\w+)\/messages$/)) && m === 'GET') {
    if (!tasks.has(mm[1])) return json(res, 404, { error: '不存在' });
    return json(res, 200, { messages: bus.list(mm[1]), stats: bus.stats(mm[1]) }); // 仅内存；服务重启后为空
  }
  if ((mm = p.match(/^\/api\/runs\/(\w+)$/)) && m === 'GET') {
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
  if (lanUrls().length) console.log(`  管理令牌  ${cfg.token}`);
  console.log('  按 Ctrl+C 停止\n');
});
