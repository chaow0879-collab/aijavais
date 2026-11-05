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

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';

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
const totals = { calls: 0, tokens: 0, errors: 0 };
const clients = new Set();
const str = (s, n) => String(s == null ? '' : s).slice(0, n);

function ingest(ev) {
  const id = str(ev.agent || 'unknown', 40).trim() || 'unknown';
  const status = ['start', 'stream', 'done', 'error', 'info', 'handoff'].includes(ev.status) ? ev.status : 'info';
  const now = Date.now();
  let a = agents.get(id);
  if (!a) {
    if (agents.size >= 200) {
      const old = [...agents.values()].filter(x => x.status !== 'working').sort((x, y) => x.last - y.last)[0];
      if (old) agents.delete(old.id);
    }
    a = { id, label: id, model: '', role: '', status: 'idle', task: '', calls: 0, tokens: 0, errors: 0, since: now, last: now, ms: 0, live: 0 };
    agents.set(id, a);
  }
  a.last = now;
  if (ev.label) a.label = str(ev.label, 40);
  if (ev.model) a.model = str(ev.model, 60);
  if (ev.role !== undefined) a.role = str(ev.role, 40);
  if (ev.task !== undefined) a.task = str(ev.task, 80);

  let tokens;
  if (status === 'start') {
    a.status = 'working'; a.since = now; a.calls++; totals.calls++; a.live = 0;
  } else if (status === 'stream') {
    if (a.status !== 'working') { a.status = 'working'; a.since = now; }
    if (Number.isFinite(ev.tokens)) a.live = ev.tokens;
  } else if (status === 'done') {
    a.status = 'idle';
    a.ms = Number.isFinite(ev.ms) ? ev.ms : now - a.since;
    if (Number.isFinite(ev.tokens) && ev.tokens > 0) { a.tokens += ev.tokens; totals.tokens += ev.tokens; tokens = ev.tokens; }
  } else if (status === 'error') {
    a.status = 'error'; a.errors++; totals.errors++;
  }
  const working = [...agents.values()].filter(x => x.status === 'working').length;
  const out = {
    type: 'event', t: now, agent: id, label: a.label, model: a.model, role: a.role, status,
    task: a.task, tokens: tokens !== undefined ? tokens : (Number.isFinite(ev.tokens) ? ev.tokens : undefined),
    ms: Number.isFinite(ev.ms) ? ev.ms : undefined, to: ev.to ? str(ev.to, 40) : undefined, working,
  };
  if (ev.error) out.error = str(ev.error, 160);
  if (cfg.settings.showText && ev.text) out.text = str(ev.text, 400);
  broadcast(out);
  return out;
}

function snapshot() {
  const list = [...agents.values()].sort((a, b) => b.last - a.last).slice(0, 24).map(a => ({
    id: a.id, label: a.label, model: a.model, role: a.role, status: a.status, task: a.task,
    calls: a.calls, tokens: a.tokens, errors: a.errors, since: a.since, last: a.last, ms: a.ms, live: a.live,
  }));
  return {
    type: 'state', now: Date.now(), working: list.filter(a => a.status === 'working').length, agents: list,
    providers: cfg.providers.map(p => ({ id: p.id, label: p.label, model: p.model, enabled: p.enabled !== false, ready: providerReady(p) })),
    totals: { ...totals, agents: agents.size }, showText: !!cfg.settings.showText,
  };
}
function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }
}
setInterval(() => {
  const now = Date.now(), limit = cfg.settings.idleTimeoutSec * 1000;
  for (const a of agents.values()) {
    if (a.status === 'working' && now - a.last > limit) { a.status = 'idle'; ingest({ agent: a.id, status: 'info', task: '超时，回到待机' }); }
    else if (a.status === 'error' && now - a.last > 30000) a.status = 'idle';
  }
  broadcast(snapshot());
}, 2000).unref?.();
setInterval(() => { for (const res of clients) { try { res.write(': hb\n\n'); } catch { clients.delete(res); } } }, 15000).unref?.();

/* ------------------------------------------------------------------ 模型调用 */
const providerKey = p => p.apiKey || (p.envKey && process.env[p.envKey]) || '';
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
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let t = '';
    try { t = (await res.text()).replace(/\s+/g, ' ').slice(0, 240); } catch { /* ignore */ }
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

async function callModel(p, { role, task, system, prompt, maxTokens }) {
  ingest({ agent: p.id, label: p.label, model: p.model, role, task, status: 'start' });
  const t0 = Date.now();
  let out = '', inTok = 0, outTok = 0, pending = '', lastEmit = 0;
  const flush = force => {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    ingest({ agent: p.id, status: 'stream', tokens: outTok || Math.ceil(out.length / 1.6), text: pending });
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
    const total = (inTok + outTok) || Math.ceil((prompt.length + out.length) / 1.6);
    const ms = Date.now() - t0;
    ingest({ agent: p.id, status: 'done', tokens: total, ms });
    return { text: out, tokens: total, ms, estimated: !(inTok + outTok) };
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? '请求超时' : (e?.message || String(e));
    ingest({ agent: p.id, status: 'error', error: msg });
    throw new Error(msg);
  }
}

/* ------------------------------------------------------------------ 双模型任务 */
const runs = new Map();
const SYS_DRAFT = '你是任职资格体系管理系统开发团队的助手。请直接完成用户任务，输出可直接使用的结果，语言精炼，不要寒暄。';
const SYS_REVIEW = '你是严格的交叉审核者。请逐条指出上一份输出中的错误、遗漏、前后不一致之处，并给出可执行的修改建议。只给审核意见，不要重写全文。';
const SYS_REVISE = '请根据审核意见修订你的原稿，直接输出最终版本；末尾单独一行列出“采纳 / 未采纳”的审核意见编号。';

async function runPipeline(run, A, B) {
  const steps = run.steps;
  const doStep = async (label, p, role, system, prompt) => {
    const s = { label, providerId: p.id, provider: p.label, status: 'running', text: '', tokens: 0, ms: 0 };
    steps.push(s);
    try {
      const r = await callModel(p, { role, task: run.title, system, prompt });
      Object.assign(s, { status: 'done', text: r.text, tokens: r.tokens, ms: r.ms });
      return r.text;
    } catch (e) { Object.assign(s, { status: 'error', error: e.message }); throw e; }
  };
  try {
    const draft = await doStep('起草', A, '起草', SYS_DRAFT, run.task);
    if (run.mode === 'single') { run.status = 'done'; return; }
    ingest({ agent: A.id, status: 'handoff', to: B.id, role: '交接审核' });
    const review = await doStep('交叉审核', B, '审核', SYS_REVIEW, `【任务】\n${run.task}\n\n【待审核输出】\n${draft}`);
    if (run.mode === 'review') { run.status = 'done'; return; }
    ingest({ agent: B.id, status: 'handoff', to: A.id, role: '回交修订' });
    await doStep('修订', A, '修订', SYS_REVISE, `【任务】\n${run.task}\n\n【你的原稿】\n${draft}\n\n【审核意见】\n${review}`);
    run.status = 'done';
  } catch (e) { run.status = 'error'; run.error = e.message; }
}

/* ------------------------------------------------------------------ 演示（无需任何 API Key） */
let demoTimer = null;
function startDemo(seconds) {
  clearInterval(demoTimer);
  const A = { agent: 'demo-claude', label: 'CLAUDE(演示)', model: 'demo' }, B = { agent: 'demo-gpt', label: 'CHATGPT(演示)', model: 'demo' };
  const total = Math.max(6, Math.min(120, seconds | 0 || 15)), t0 = Date.now();
  let phase = 0, tok = 0;
  const third = total / 3;
  ingest({ ...A, status: 'start', role: '起草', task: '演示：起草评审流程' });
  demoTimer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    tok += 30 + (Math.random() * 40 | 0);
    if (phase === 0 && el > third) { phase = 1; ingest({ ...A, status: 'done', tokens: tok, ms: el * 1000 }); ingest({ ...A, status: 'handoff', to: B.agent }); ingest({ ...B, status: 'start', role: '审核', task: '演示：交叉审核' }); tok = 0; }
    else if (phase === 1 && el > 2 * third) { phase = 2; ingest({ ...B, status: 'done', tokens: tok, ms: third * 1000 }); ingest({ ...B, status: 'handoff', to: A.agent }); ingest({ ...A, status: 'start', role: '修订', task: '演示：修订终稿' }); tok = 0; }
    else if (el > total) { clearInterval(demoTimer); ingest({ ...A, status: 'done', tokens: tok, ms: third * 1000 }); return; }
    ingest({ ...(phase === 1 ? B : A), status: 'stream', tokens: tok });
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
  enabled: p.enabled !== false, hasKey: !!p.apiKey, envReady: !!(p.envKey && process.env[p.envKey]), keyHint: p.apiKey ? '••••' + p.apiKey.slice(-4) : '',
});
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
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state' && m === 'GET') return json(res, 200, snapshot());

  if (!authOK(req)) return json(res, 401, { error: '需要管理令牌（x-admin-token）。令牌见服务启动日志或 data/config.json' });

  if (p === '/api/config' && m === 'GET') {
    return json(res, 200, {
      providers: cfg.providers.map(maskProvider), settings: cfg.settings, presets: PRESETS,
      token: isLoopbackAddr(req.socket.remoteAddress) ? cfg.token : undefined,
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
    let prov = b.id ? cfg.providers.find(x => x.id === b.id) : null;
    if (!prov) {
      let id = slug(b.label || b.id || 'ai'), n = 2;
      while (cfg.providers.some(x => x.id === id)) id = slug(b.label || 'ai') + '-' + n++;
      prov = { id, apiKey: '' };
      cfg.providers.push(prov);
    }
    prov.label = str(b.label || prov.label || 'AI', 40);
    prov.type = b.type === 'anthropic' ? 'anthropic' : 'openai';
    prov.baseUrl = str(b.baseUrl, 300).trim();
    if (prov.baseUrl && !/^https?:\/\//i.test(prov.baseUrl)) return json(res, 400, { error: 'Base URL 必须以 http:// 或 https:// 开头' });
    prov.model = str(b.model, 80).trim();
    prov.role = str(b.role, 80);
    prov.envKey = str(b.envKey, 60).trim();
    prov.enabled = b.enabled !== false;
    if (b.clearKey) prov.apiKey = '';
    else if (typeof b.apiKey === 'string' && b.apiKey.trim()) prov.apiKey = b.apiKey.trim();
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
    ingest(b);
    return json(res, 200, { ok: true });
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
    const run = { id, title: str(task.replace(/\s+/g, ' '), 30), task, mode, status: 'running', steps: [], createdAt: Date.now() };
    runs.set(id, run);
    while (runs.size > 20) runs.delete(runs.keys().next().value);
    runPipeline(run, A, B);
    return json(res, 200, { runId: id });
  }
  if ((mm = p.match(/^\/api\/runs\/(\w+)$/)) && m === 'GET') {
    const r = runs.get(mm[1]);
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
server.listen(PORT, HOST, () => {
  console.log('\n  AI 星环 已启动');
  console.log(`  大屏      http://localhost:${PORT}/`);
  console.log(`  管理界面  http://localhost:${PORT}/admin.html`);
  for (const u of lanUrls()) console.log(`  局域网    ${u}/   （远程访问管理接口需令牌）`);
  if (lanUrls().length) console.log(`  管理令牌  ${cfg.token}`);
  console.log('  按 Ctrl+C 停止\n');
});
