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
const ACC = require('./lib/access');
const PERM = require('./lib/permissions');
const { ModelRegistry, diagnose } = require('./lib/models');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.AIJ_DATA_DIR ? path.resolve(process.env.AIJ_DATA_DIR) : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const MODELS_FILE = path.join(DATA, 'models.json');       // 模型注册信息（不含密钥）
const CREDS_FILE = path.join(DATA, 'credentials.json');   // 模型凭证（0600，接口永不返回明文）
const TASKS_FILE = path.join(DATA, 'tasks.json');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
/* 出站安全策略（见 lib/security.js 顶部说明）：ALLOWED_BASE_HOSTS、ALLOWED_BASE_PORTS、LOCAL_MODEL_TARGETS；
   访问控制：VIEW_TOKEN（观看令牌）、INGEST_TOKEN + INGEST_AGENTS（外部上报凭证）、ANON_VIEW=0（禁止匿名观看）、TRUST_PROXY=1（反向代理后取真实 IP） */
const POLICY = SEC.policyFromEnv(process.env);
const VIEW_TOKEN = process.env.VIEW_TOKEN && process.env.VIEW_TOKEN.length >= 12 ? process.env.VIEW_TOKEN : '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ANON_VIEW = process.env.ANON_VIEW !== '0';
const authThrottle = new SEC.AuthThrottle(); // 每个来源 IP：1 分钟内 8 次无效凭证后锁定 5 分钟
/* 限流：按主体分别计数（外部上报每秒 100 条、突发 200；新建任务每秒 2 个、突发 5） */
const limiters = new Map();
function rateOk(kind, key, perSec, burst) {
  const k = kind + '\u0000' + key;
  let l = limiters.get(k);
  if (!l) { l = new SEC.RateLimiter(perSec, burst); limiters.set(k, l); if (limiters.size > 2000) limiters.delete(limiters.keys().next().value); }
  return l.take();
}

/* ------------------------------------------------------------------ 配置 */
/* 服务商目录：版本化数据文件 catalog/providers.v1.json（不写死在代码或页面里） */
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'providers.v1.json'), 'utf8'));

const DEFAULT_SETTINGS = { showText: false, idleTimeoutSec: 120, maxTokens: 4096, timeoutSec: 300, defaultConnectionId: '' };

function defaultConfig() {
  return { token: crypto.randomBytes(12).toString('hex'), settings: { ...DEFAULT_SETTINGS }, providers: [], ingestTokens: [] };
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
  c.ingestTokens = Array.isArray(c.ingestTokens) ? c.ingestTokens.filter(t => t && /^[\w-]{1,32}$/.test(t.name) && /^[a-f0-9]{64}$/.test(t.hash)) : [];
  return c;
}
const cfg = loadConfig();
/* 环境变量提供的上报凭证（云端部署用），不写入配置文件 */
const ENV_INGEST = process.env.INGEST_TOKEN && process.env.INGEST_TOKEN.length >= 16
  ? { name: 'env', hash: ACC.sha256(process.env.INGEST_TOKEN), agents: String(process.env.INGEST_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean) } : null;
const access = ACC.createAccess({
  adminToken: () => cfg.token, viewToken: VIEW_TOKEN, trustProxy: TRUST_PROXY,
  ingestTokens: () => (ENV_INGEST ? [ENV_INGEST, ...cfg.ingestTokens] : cfg.ingestTokens),
});
/* ------------------------------------------------------------------ 模型注册中心（lib/models.js） */
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const models = new ModelRegistry({ catalog: CATALOG, policy: POLICY });
models.load({ models: readJson(MODELS_FILE), credentials: readJson(CREDS_FILE) });
function saveModels() { const d = models.serialize(); writeJsonAtomic(MODELS_FILE, d.models); writeJsonAtomic(CREDS_FILE, d.credentials); }
/* 旧版 config.json 里的 providers → 模型连接（先写新文件，成功后才从旧配置里移除） */
if (Array.isArray(cfg.providers) && cfg.providers.length) {
  const n = models.migrateLegacy(cfg.providers);
  try { saveModels(); delete cfg.providers; if (n) console.log(`  已将 ${n} 个旧版供应商迁移为模型连接（data/models.json）`); }
  catch (e) { console.error('模型配置迁移失败，保留旧配置：', e.message); }
} else delete cfg.providers;
/* 云端部署（配置不持久）：用环境变量固定令牌并自动建立模型连接。
   ADMIN_TOKEN=管理令牌；<KEY 环境变量> + <ID>_MODEL，如 ANTHROPIC_API_KEY + CLAUDE_MODEL。 */
if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 12) cfg.token = process.env.ADMIN_TOKEN;
for (const [id, providerId] of [['claude', 'anthropic'], ['chatgpt', 'openai'], ['kimi', 'moonshot'], ['deepseek', 'deepseek']]) {
  const prov = CATALOG.providers.find(x => x.providerId === providerId), model = (process.env[id.toUpperCase() + '_MODEL'] || '').trim();
  if (!prov || !process.env[prov.envKey] || !model || models.has(id)) continue;
  const r = models.add({ connectionId: id, providerId, modelId: model, envKey: prov.envKey });
  if (!r.ok) console.error('环境变量模型连接 ' + id + ' 未建立：', r.error);
}
if (cfg.settings.defaultConnectionId && !models.has(cfg.settings.defaultConnectionId)) cfg.settings.defaultConnectionId = '';
try { saveModels(); } catch (e) { console.error('无法写入 data/models.json：', e.message); }
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
const isProviderId = id => models.has(id);

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
  const list = RT.publicAgents(24).map(a => ACC.redactAgent(a, level));
  return {
    type: 'state', now: Date.now(), working: list.filter(a => a.status === 'working').length, agents: list,
    providers: level >= ACC.LEVEL.VIEWER ? models.list().map(c => ({ id: c.connectionId, label: c.displayName, model: c.modelId, enabled: c.enabled, ready: c.ready })) : [],
    totals: { ...RT.totals, agents: RT.agents.size }, showText: level >= 2 && !!cfg.settings.showText,
  };
}
function sseSend(res, line) { try { res.write(line); } catch { clients.delete(res); } }
function broadcast(obj) {
  const cache = {};
  for (const res of clients) {
    const lvl = res._lvl;
    sseSend(res, cache[lvl] || (cache[lvl] = 'data: ' + JSON.stringify(ACC.redactEvent(obj, lvl)) + '\n\n'));
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

async function streamChat(p, { system, prompt, maxTokens, onDelta, onUsage, onActivity, onBytes }) {
  const key = providerKey(p);
  if (!key && !p.noKey) throw new Error('未配置 API Key（可在管理界面填写，或设置环境变量 ' + (p.envKey || '—') + '）');
  if (!p.model) throw new Error('未填写模型名');
  if (!p.baseUrl) throw new Error('未填写 Base URL');
  /* 密钥来源优先级：供应商里显式保存的 apiKey > 环境变量（envKey）。
     环境变量密钥与目标主机严格绑定：官方变量只发往官方主机，没有白名单例外；第三方接口请用 AIJ_*_KEY。 */
  let host;
  try { host = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { throw new Error('Base URL 格式不正确'); }
  if (key && !p.apiKey && !SEC.envKeyHostOk(p.envKey, host)) {
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
    headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = 'Bearer ' + key;
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

/* 当前可用的模型连接：存在、未停用、已就绪；返回运行时对象（含凭证，仅服务端内部使用） */
function connectionState(id) {
  const c = models.get(id);
  if (!c) return { error: '不存在（可能已被删除）', code: 'connection_missing' };
  if (c.enabled === false) return { error: '已停用', code: 'connection_disabled' };
  if (!models.ready(id)) return { error: '未就绪（缺少 API Key 或模型名）', code: 'connection_not_ready' };
  return { p: models.runtime(id) };
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
/* ------------------------------------------------------------------ 模型连接：兼容视图、影响分析、删除、测试、模型发现 */
const legacyView = c => ({
  id: c.connectionId, label: c.displayName, type: c.protocol, baseUrl: c.baseUrl, model: c.modelId, role: c.notes || '', envKey: c.envKey || '',
  enabled: c.enabled, hasKey: c.hasKey, envReady: c.envReady, keyHint: c.keyHint, providerId: c.providerId, status: c.status,
});
function fromLegacy(b) {
  const prov = models.inferProvider(b.baseUrl, b.type);
  const o = { providerId: prov.providerId, protocol: b.type === 'anthropic' ? 'anthropic' : 'openai', baseUrl: b.baseUrl, modelId: b.model, displayName: b.label, notes: b.role, envKey: b.envKey, enabled: b.enabled !== false, clearKey: !!b.clearKey };
  if (typeof b.apiKey === 'string') o.apiKey = b.apiKey;
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
/* 团队对模型连接的引用（由团队注册中心提供；未接入时为空） */
let teamRefs = () => [];
let replaceInTeams = () => 0;
/* 删除 / 停用前的影响分析 */
function modelImpact(id) {
  const running = [...tasks.values()].filter(t => t.status === 'running' && (t.agents || []).some(x => x.connectionId === id)).map(t => ({ id: t.id, title: t.title }));
  const teams = teamRefs(id);
  const alternatives = models.list().filter(c => c.connectionId !== id && c.enabled && c.ready).map(c => ({ connectionId: c.connectionId, displayName: c.displayName }));
  const isDefault = cfg.settings.defaultConnectionId === id;
  const blockers = [];
  if (running.length) blockers.push(`有 ${running.length} 个运行中的任务正在使用它（已发出的调用会完成，后续步骤会停止）`);
  if (teams.length) blockers.push(`被 ${teams.length} 个团队岗位引用`);
  if (isDefault) blockers.push('是当前默认模型');
  return { connectionId: id, runningTasks: running, teams, isDefault, alternatives, historyKept: true, blockers };
}
/*
 * 删除模型连接：
 *   - 有运行中任务：需要 force=1（已发出的调用按原配置完成，下一步明确停止）
 *   - 被团队引用：需要 replacement=<另一个连接>（替换为它）或 detach=1（岗位改为“待分配”）
 *   - 是默认模型：默认改为 replacement，否则清空
 * 历史任务保留执行时的模型信息，不受影响。
 */
function removeConnection(id, { replacement = '', force = false, detach = false } = {}) {
  const impact = modelImpact(id);
  if (replacement) {
    if (replacement === id) return { code: 400, error: '替代模型不能是自己' };
    const st = models.get(replacement);
    if (!st) return { code: 400, error: '替代模型不存在' };
    if (st.enabled === false) return { code: 400, error: '替代模型已停用' };
  }
  if (impact.runningTasks.length && !force) return { code: 409, error: '有运行中的任务正在使用该模型。确认删除请加 force=1', impact };
  if (impact.teams.length && !replacement && !detach) return { code: 409, error: '该模型被团队岗位引用。请选择替代模型（replacement），或确认把这些岗位改为待分配（detach=1）', impact };
  const replaced = replaceInTeams(id, replacement || null);
  if (impact.isDefault) cfg.settings.defaultConnectionId = replacement || '';
  const r = models.remove(id);
  saveModels(); saveConfig();
  return { ok: true, removed: r.removed, replacement: replacement || null, teamRolesUpdated: replaced, defaultConnectionId: cfg.settings.defaultConnectionId, impact };
}
async function testConnection(id) {
  const rt = models.runtime(id);
  const t0 = Date.now();
  let out;
  try {
    const r = await callModel(rt, { role: '连接测试', task: '连接测试', prompt: '只回复一个字：好', maxTokens: 32 });
    out = { ok: true, ms: Date.now() - t0, tokens: r.tokens, reply: r.text.slice(0, 60) };
  } catch (e) { out = { ok: false, ms: Date.now() - t0, error: e.message, hint: diagnose(e.message) }; }
  models.recordTest(id, out);
  saveModels();
  return { ...out, connection: models.view(models.get(id)) };
}
/* 从服务商接口读取可用模型列表（不预置、不编造模型名）。可用已保存连接的凭证，或本次粘贴的 Key（不保存） */
async function discoverModels(b) {
  let base, protocol, key;
  if (b.connectionId) {
    const rt = models.runtime(b.connectionId);
    if (!rt) return { ok: false, error: '模型连接不存在' };
    base = rt.baseUrl; protocol = rt.type; key = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : providerKey(rt);
  } else {
    const prov = CATALOG.providers.find(x => x.providerId === b.providerId);
    if (!prov) return { ok: false, error: '未知的服务商' };
    base = String(b.baseUrl || prov.baseUrl || '').trim().replace(/\/+$/, ''); protocol = prov.protocol;
    key = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    if (!key && prov.envKey && process.env[prov.envKey] && SEC.envKeyHostOk(prov.envKey, (() => { try { return new URL(base).hostname; } catch { return ''; } })())) key = process.env[prov.envKey];
  }
  if (!base) return { ok: false, error: '缺少 Base URL' };
  const url = protocol === 'anthropic' ? (/\/v1$/.test(base) ? base + '/models' : base + '/v1/models') + '?limit=100' : base + '/models';
  const headers = protocol === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : (key ? { authorization: 'Bearer ' + key } : {});
  try {
    const res = await SEC.pinnedFetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000), maxBytes: 2 << 20 }, POLICY);
    const text = await SSE.readLimitedText(res, 2 << 20);
    if (!res.ok) { const e = 'HTTP ' + res.status + '：' + SEC.scrubSecrets(text.replace(/\s+/g, ' ').slice(0, 200), [key]); return { ok: false, error: e, hint: diagnose(e) }; }
    let j; try { j = JSON.parse(text); } catch { return { ok: false, error: '服务商返回的不是 JSON', hint: '该服务商可能不支持模型列表接口，请手动填写模型名。' }; }
    const list = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []).map(x => String(x.id || x.name || '').replace(/^models\//, '')).filter(x => /^[\w.:/@-]{1,80}$/.test(x));
    return { ok: true, models: [...new Set(list)].sort().slice(0, 300) };
  } catch (e) {
    const msg = SEC.scrubSecrets(e?.name === 'TimeoutError' ? '请求超时' : (e?.message || String(e)), [key]);
    return { ok: false, error: msg, hint: diagnose(msg) };
  }
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
  const ip = access.clientIp(req);
  /* 凭证防爆破：无效凭证累计到阈值后，该 IP 携带凭证的请求一律 429 */
  if (authThrottle.locked(ip)) {
    const pre = access.identify(req);
    if (pre.presented && pre.kind !== 'local') return json(res, 429, { error: '无效凭证尝试过多，请 5 分钟后再试' });
  }
  const who = access.identify(req);
  if (who.invalid) { authThrottle.fail(ip); return json(res, 401, { error: '凭证无效' }); }

  if ((p === '/api/events' || p === '/api/state') && m === 'GET') {
    if (who.kind === 'ingest') return json(res, 403, { error: '上报凭证不能订阅事件流' });
    if (who.level === ACC.LEVEL.ANON && !ANON_VIEW) return json(res, 401, { error: '需要观看令牌（通过 ?view=令牌 访问大屏）' });
    if (p === '/api/state') return json(res, 200, snapshot(who.level));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res._lvl = who.level; // 2 管理员/本机：完整；1 观看者；0 匿名：只含驱动动画的字段（见 lib/access.js 允许列表）
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot(who.level)) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/event' && m === 'POST') {
    if (!['local', 'admin', 'ingest'].includes(who.kind)) return json(res, 401, { error: '需要上报凭证（x-ingest-token）' });
    if (!rateOk('ingest', who.id, 100, 200)) return json(res, 429, { error: '上报过于频繁' });
    const b = await readBody(req, 64 << 10);
    if (!b || typeof b !== 'object' || !(b.agent || b.agentId)) return json(res, 400, { error: '缺少 agent 字段' });
    const r = ingest(b, { source: 'external', owner: who.id, allowedAgents: who.agents });
    if (r.error) return json(res, r.code || 400, { error: r.error });
    return json(res, 200, { ok: true, eventId: r.eventId, ...(r.duplicate ? { duplicate: true } : {}) });
  }

  /* 其余接口：仅管理员 / 本机 */
  if (who.level < ACC.LEVEL.ADMIN) return json(res, 401, { error: '需要管理令牌（x-admin-token）。令牌保存在 data/config.json' });
  const user = PERM.userFromPrincipal(who);

  if (p === '/api/ingest-tokens' && m === 'GET') {
    return json(res, 200, { tokens: [...(ENV_INGEST ? [{ name: 'env', agents: ENV_INGEST.agents, fromEnv: true }] : []), ...cfg.ingestTokens.map(t => ({ name: t.name, agents: t.agents, hint: t.hint, createdAt: t.createdAt }))] });
  }
  if (p === '/api/ingest-tokens' && m === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if (!/^[\w-]{1,32}$/.test(name) || name === 'env') return json(res, 400, { error: '名称只能包含字母、数字、下划线、连字符（1–32 位），且不能是 env' });
    if (cfg.ingestTokens.some(t => t.name === name)) return json(res, 400, { error: '名称已存在' });
    const agentsList = Array.isArray(b.agents) ? b.agents.map(x => String(x).trim()).filter(Boolean) : [];
    if (agentsList.length > 20 || agentsList.some(x => !/^[\w.-]{1,40}$/.test(x) || /^demo-/i.test(x) || models.has(x))) return json(res, 400, { error: 'agents 必须是最多 20 个合法 ID，且不能是模型连接 ID 或 demo- 开头' });
    const t = ACC.newIngestToken();
    cfg.ingestTokens.push({ name, hash: t.hash, hint: t.hint, agents: agentsList, createdAt: Date.now() });
    saveConfig();
    return json(res, 200, { name, token: t.token, agents: agentsList, note: '凭证只显示这一次，请妥善保存' });
  }
  let mt;
  if ((mt = p.match(/^\/api\/ingest-tokens\/([\w-]{1,32})$/)) && m === 'DELETE') {
    const i = cfg.ingestTokens.findIndex(t => t.name === mt[1]);
    if (i < 0) return json(res, 404, { error: '不存在' });
    cfg.ingestTokens.splice(i, 1); saveConfig();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/config' && m === 'GET') {
    return json(res, 200, {
      models: models.list(), catalog: CATALOG, settings: cfg.settings,
      providers: models.list().map(legacyView), // 兼容旧版管理界面
      /* 不通过配置接口回传管理令牌；令牌见 data/config.json */
      server: { port: PORT, host: HOST, lan: lanUrls(), node: process.version, localTargets: [...POLICY.localTargets] },
    });
  }
  if (p === '/api/catalog' && m === 'GET') return json(res, 200, CATALOG);
  if (p === '/api/settings' && m === 'POST') {
    const b = await readBody(req);
    const s = cfg.settings;
    if (typeof b.showText === 'boolean') s.showText = b.showText;
    if (Number.isFinite(b.idleTimeoutSec)) s.idleTimeoutSec = Math.max(10, Math.min(3600, b.idleTimeoutSec | 0));
    if (Number.isFinite(b.maxTokens)) s.maxTokens = Math.max(256, Math.min(64000, b.maxTokens | 0));
    if (Number.isFinite(b.timeoutSec)) s.timeoutSec = Math.max(30, Math.min(1800, b.timeoutSec | 0));
    if (b.defaultConnectionId !== undefined) {
      if (b.defaultConnectionId && !models.has(b.defaultConnectionId)) return json(res, 400, { error: '默认模型不存在' });
      s.defaultConnectionId = b.defaultConnectionId || '';
    }
    saveConfig();
    return json(res, 200, { settings: s });
  }

  /* ---------------- 模型注册中心 ---------------- */
  if (p === '/api/models' && m === 'GET') return json(res, 200, { models: models.list(), defaultConnectionId: cfg.settings.defaultConnectionId });
  if (p === '/api/models' && m === 'POST') {
    const r = models.add(await readBody(req));
    if (!r.ok) return json(res, 400, { error: r.error });
    if (!cfg.settings.defaultConnectionId) { cfg.settings.defaultConnectionId = r.connection.connectionId; saveConfig(); }
    saveModels();
    return json(res, 200, { connection: r.connection });
  }
  if (p === '/api/models/discover' && m === 'POST') return json(res, 200, await discoverModels(await readBody(req)));
  let mm;
  if ((mm = p.match(/^\/api\/models\/([\w-]{1,40})(?:\/(enable|disable|test|impact|capabilities))?$/))) {
    const id = mm[1], act = mm[2];
    if (!models.has(id)) return json(res, 404, { error: '模型连接不存在' });
    if (!act && m === 'GET') return json(res, 200, { connection: models.view(models.get(id)), impact: modelImpact(id) });
    if (!act && (m === 'PUT' || m === 'POST')) {
      const r = models.update(id, await readBody(req));
      if (!r.ok) return json(res, r.code || 400, { error: r.error });
      saveModels();
      return json(res, 200, { connection: r.connection });
    }
    if ((act === 'enable' || act === 'disable') && m === 'POST') {
      const r = models.setEnabled(id, act === 'enable');
      saveModels();
      return json(res, 200, { connection: r.connection, impact: act === 'disable' ? modelImpact(id) : undefined });
    }
    if (act === 'test' && m === 'POST') return json(res, 200, await testConnection(id));
    if (act === 'impact' && m === 'GET') return json(res, 200, modelImpact(id));
    if (act === 'capabilities' && m === 'GET') return json(res, 200, models.getCapabilities(id));
    if (!act && m === 'DELETE') {
      const r = removeConnection(id, { replacement: url.searchParams.get('replacement') || '', force: url.searchParams.get('force') === '1', detach: url.searchParams.get('detach') === '1' });
      return json(res, r.code || 200, r);
    }
    return json(res, 405, { error: '不支持的操作' });
  }

  /* ---------------- 旧接口（兼容）：/api/providers → 模型注册中心 ---------------- */
  if (p === '/api/providers' && m === 'POST') {
    const b = await readBody(req);
    const input = fromLegacy(b);
    const r = b.id && models.has(b.id) ? models.update(b.id, input) : models.add(input);
    if (!r.ok) return json(res, 400, { error: r.error });
    if (!cfg.settings.defaultConnectionId) { cfg.settings.defaultConnectionId = r.connection.connectionId; saveConfig(); }
    saveModels();
    return json(res, 200, { provider: legacyView(r.connection) });
  }
  if ((mm = p.match(/^\/api\/providers\/([\w-]+)$/)) && m === 'DELETE') {
    if (!models.has(mm[1])) return json(res, 404, { error: '不存在' });
    const r = removeConnection(mm[1], { force: true, detach: true });
    return json(res, r.code || 200, r);
  }
  if ((mm = p.match(/^\/api\/providers\/([\w-]+)\/test$/)) && m === 'POST') {
    if (!models.has(mm[1])) return json(res, 404, { error: '不存在' });
    return json(res, 200, await testConnection(mm[1]));
  }
  if (p === '/api/demo' && m === 'POST') {
    const b = await readBody(req);
    startDemo(b.seconds);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/run' && m === 'POST') {
    if (!rateOk('run', who.id, 2, 5)) return json(res, 429, { error: '提交任务过于频繁' });
    const b = await readBody(req);
    const task = typeof b.task === 'string' ? b.task.trim() : '';
    if (!task) return json(res, 400, { error: '任务内容为空' });
    if (task.length > MAX_TASK_CHARS) return json(res, 400, { error: `任务内容 ${task.length} 字符，超过 ${MAX_TASK_CHARS} 字符上限。请精简或拆分后再提交（系统不会自动截断）` });
    const mode = ['single', 'review', 'full'].includes(b.mode) ? b.mode : 'full';
    const sa = connectionState(b.a || cfg.settings.defaultConnectionId);
    if (sa.error) return json(res, 400, { error: '模型 A ' + sa.error, code: sa.code });
    let sb = null;
    if (mode !== 'single') { sb = connectionState(b.b || b.a || cfg.settings.defaultConnectionId); if (sb.error) return json(res, 400, { error: '模型 B ' + sb.error, code: sb.code }); }
    let id;
    do id = crypto.randomBytes(6).toString('hex'); while (tasks.has(id));
    const run = { id, kind: 'internal', ownerId: user.userId, runId: EV.newRunId(), title: str(task.replace(/\s+/g, ' '), 30), task, mode, status: 'running', steps: [], createdAt: Date.now() };
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
  if (p === '/api/runs' && m === 'GET') {
    const list = [...tasks.values()].filter(t => PERM.can(user, 'task.view', { ownerId: t.ownerId || t.owner })).reverse().slice(0, 100).map(taskSummary);
    return json(res, 200, { runs: list });
  }
  if ((mm = p.match(/^\/api\/runs\/([\w-]+)$/)) && m === 'GET') {
    const r = tasks.get(mm[1]);
    if (!r || !PERM.can(user, 'task.view', { ownerId: r.ownerId || r.owner })) return json(res, 404, { error: '不存在' });
    return json(res, 200, r);
  }
  return json(res, 404, { error: '未知接口' });
}

function serveStatic(req, res, url) {
  /* 观看令牌换 Cookie：访问 /?view=令牌 后写入 HttpOnly Cookie 并去掉地址栏里的令牌；大屏的 EventSource 自动带上 Cookie */
  const vt = url.searchParams.get('view');
  if (vt !== null) {
    const ip = access.clientIp(req);
    if (authThrottle.locked(ip)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('尝试过多，请稍后再试'); }
    const clean = url.pathname + (() => { const q = new URLSearchParams(url.search); q.delete('view'); const s = q.toString(); return s ? '?' + s : ''; })();
    if (!access.viewTokenOk(vt)) { authThrottle.fail(ip); res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('观看令牌无效'); }
    const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
    res.writeHead(303, { location: clean, 'set-cookie': `aij_view=${encodeURIComponent(vt)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`, 'cache-control': 'no-store' });
    return res.end();
  }
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
