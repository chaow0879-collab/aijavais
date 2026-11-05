'use strict';
/*
 * 模型适配器（Provider Adapter）：统一的“对话 + 工具调用”接口，屏蔽各服务商协议差异。
 *
 *   chat(conn, { system, messages, tools, maxTokens, signal, onText, onBytes, cache }) →
 *     { text, toolCalls: [{ id, name, arguments }], stopReason, usage: { input, output, cacheRead, cacheWrite, source } }
 *
 * 统一消息格式（与服务商无关）：
 *   { role: 'user', content: '…' }
 *   { role: 'assistant', content: '…', toolCalls: [{ id, name, arguments }] }
 *   { role: 'tool', toolCallId, name, content: '…', isError }
 * 工具定义：{ name, description, inputSchema }（name 只含字母数字下划线连字符）。
 *
 * 协议：anthropic（Messages API，流式，tool_use / tool_result，prompt caching 用 cache_control）
 *       openai（Chat Completions 兼容，流式，tool_calls；Gemini / OpenRouter / Groq / Mistral / DeepSeek / 通义 / 本地 Ollama 等走此协议）
 * 出站一律经过 lib/security.js 的 pinnedFetch（SSRF 防护、固定解析 IP、不跟随重定向），流式响应经 lib/sse.js 限流解析。
 * 用量：厂商返回则为 provider（含缓存读 / 写 Token）；否则按字符估算并标记 estimated。
 */
const SEC = require('./security');
const SSE = require('./sse');

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

class LlmError extends Error {
  constructor(message, { kind = 'unknown', status = 0, retryable = false } = {}) { super(message); this.name = 'LlmError'; this.kind = kind; this.status = status; this.retryable = retryable; }
}
function classify(status, body) {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 402) return { kind: 'quota', retryable: false };
  if (status === 404) return { kind: 'not_found', retryable: false };
  if (status === 408) return { kind: 'timeout', retryable: true };
  if (status === 429) return { kind: /quota|insufficient|billing|credit/i.test(body) ? 'quota' : 'rate_limit', retryable: !/quota|insufficient|billing|credit/i.test(body) };
  if (status >= 500) return { kind: 'server', retryable: true };
  if (status === 400 || status === 422) return { kind: 'bad_request', retryable: false };
  return { kind: 'unknown', retryable: false };
}
const estimateTokens = s => Math.ceil(String(s || '').length / 1.6);

/* ---------------- Anthropic ---------------- */
function anthropicBody(conn, { system, messages, tools, maxTokens, cache }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: [{ type: 'text', text: String(m.content || '') }] });
    else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} });
      if (!content.length) content.push({ type: 'text', text: '（无文字输出）' });
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content || ''), ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.content.every(b => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  const body = { model: conn.model, max_tokens: maxTokens || 4096, stream: true, messages: out };
  if (system) body.system = cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    if (cache) body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
  }
  return body;
}
async function anthropicStream(res, { onText }, limits) {
  let text = '', stopReason = null;
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const blocks = new Map(); // index -> { type, id, name, json }
  await SSE.parseSSE(res.body, data => {
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.type === 'message_start') {
      const u = j.message && j.message.usage || {};
      if (Number.isFinite(u.input_tokens)) usage.input = u.input_tokens;
      if (Number.isFinite(u.cache_read_input_tokens)) usage.cacheRead = u.cache_read_input_tokens;
      if (Number.isFinite(u.cache_creation_input_tokens)) usage.cacheWrite = u.cache_creation_input_tokens;
      if (Number.isFinite(u.output_tokens)) usage.output = u.output_tokens;
    } else if (j.type === 'content_block_start') {
      const b = j.content_block || {};
      blocks.set(j.index, { type: b.type, id: b.id, name: b.name, json: '' });
      if (b.type === 'text' && b.text) { text += b.text; onText && onText(b.text); }
    } else if (j.type === 'content_block_delta') {
      const b = blocks.get(j.index);
      if (j.delta && j.delta.type === 'text_delta') { text += j.delta.text || ''; onText && onText(j.delta.text || ''); }
      else if (j.delta && j.delta.type === 'input_json_delta' && b) b.json += j.delta.partial_json || '';
    } else if (j.type === 'message_delta') {
      if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
      if (j.usage && Number.isFinite(j.usage.output_tokens)) usage.output = j.usage.output_tokens;
    } else if (j.type === 'error') throw new LlmError((j.error && j.error.message) || '流式错误', { kind: 'server', retryable: true });
  }, limits);
  const toolCalls = [];
  for (const b of [...blocks.entries()].sort((a, c) => a[0] - c[0]).map(x => x[1])) {
    if (b.type !== 'tool_use') continue;
    let args = {};
    try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = { __invalid_json: b.json.slice(0, 500) }; }
    toolCalls.push({ id: b.id, name: b.name, arguments: args });
  }
  const norm = { tool_use: 'tool_calls', end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length' };
  return { text, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : norm[stopReason] || 'stop', usage };
}

/* ---------------- OpenAI 兼容 ---------------- */
function openaiBody(conn, { system, messages, tools, maxTokens }, includeUsage) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: String(m.content || '') });
    else if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.content ? String(m.content) : null };
      if (m.toolCalls && m.toolCalls.length) o.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }));
      if (o.content === null && !o.tool_calls) o.content = '';
      out.push(o);
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content || '') });
  }
  const body = { model: conn.model, messages: out, stream: true };
  if (maxTokens) body.max_tokens = maxTokens;
  if (includeUsage) body.stream_options = { include_usage: true };
  if (tools && tools.length) { body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } })); body.tool_choice = 'auto'; }
  return body;
}
async function openaiStream(res, { onText }, limits) {
  let text = '', stopReason = null;
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const calls = new Map(); // index -> { id, name, args }
  await SSE.parseSSE(res.body, data => {
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new LlmError(j.error.message || '流式错误', { kind: 'server', retryable: true });
    const ch = j.choices && j.choices[0];
    const d = ch && ch.delta;
    if (d && typeof d.content === 'string' && d.content) { text += d.content; onText && onText(d.content); }
    if (d && Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.size;
        const c = calls.get(i) || { id: '', name: '', args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function && tc.function.name) c.name += tc.function.name;
        if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
        calls.set(i, c);
      }
    }
    if (ch && ch.finish_reason) stopReason = ch.finish_reason;
    if (j.usage) {
      if (Number.isFinite(j.usage.prompt_tokens)) usage.input = j.usage.prompt_tokens;
      if (Number.isFinite(j.usage.completion_tokens)) usage.output = j.usage.completion_tokens;
      const cached = j.usage.prompt_tokens_details && j.usage.prompt_tokens_details.cached_tokens;
      if (Number.isFinite(cached)) usage.cacheRead = cached;
    }
  }, limits);
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => {
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { __invalid_json: c.args.slice(0, 500) }; }
    return { id: c.id || `call_${i}`, name: c.name, arguments: args };
  });
  return { text, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : stopReason === 'length' ? 'length' : 'stop', usage };
}

/*
 * conn：运行时连接对象 { id, type('anthropic'|'openai'), baseUrl, model, apiKey, envKey, noKey }
 * deps：{ policy, keyOf(conn), timeoutMs, limits: { maxEventBytes, maxCallBytes } }
 */
async function chat(conn, req, deps) {
  for (const t of req.tools || []) if (!TOOL_NAME_RE.test(t.name)) throw new LlmError('工具名不合法：' + t.name, { kind: 'bad_request' });
  const key = deps.keyOf(conn);
  if (!key && !conn.noKey) throw new LlmError('未配置 API Key', { kind: 'auth' });
  if (!conn.model) throw new LlmError('未填写模型名', { kind: 'bad_request' });
  const base = String(conn.baseUrl || '').replace(/\/+$/, '');
  let host = '';
  try { host = new URL(base).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { throw new LlmError('Base URL 格式不正确', { kind: 'bad_request' }); }
  if (key && !conn.apiKey && !SEC.envKeyHostOk(conn.envKey, host)) throw new LlmError('环境变量 ' + conn.envKey + ' 只能用于其官方主机', { kind: 'policy' });
  const timeout = AbortSignal.timeout(deps.timeoutMs || 300000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const limits = { maxEventBytes: (deps.limits && deps.limits.maxEventBytes) || 1 << 20, maxTotalBytes: (deps.limits && deps.limits.maxCallBytes) || 8 << 20, onBytes: req.onBytes };

  const send = async includeUsage => {
    let url, headers, body;
    if (conn.type === 'anthropic') {
      url = /\/v1$/.test(base) ? base + '/messages' : base + '/v1/messages';
      headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = anthropicBody(conn, req);
    } else {
      url = base + '/chat/completions';
      headers = { 'content-type': 'application/json' };
      if (key) headers.authorization = 'Bearer ' + key;
      body = openaiBody(conn, req, includeUsage);
    }
    return SEC.pinnedFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, deps.policy);
  };
  const t0 = Date.now();
  try {
    let res = await send(true);
    if (!res.ok && conn.type !== 'anthropic' && res.status === 400) {
      const t = await SSE.readLimitedText(res, 4096);
      if (/stream_options|include_usage/i.test(t)) res = await send(false); // 部分兼容接口不认 stream_options，去掉后重试一次
      else throw new LlmError('HTTP 400：' + SEC.scrubSecrets(t.replace(/\s+/g, ' ').slice(0, 300), [key]), { kind: 'bad_request', status: 400 });
    }
    if (!res.ok) {
      const t = SEC.scrubSecrets((await SSE.readLimitedText(res, 4096)).replace(/\s+/g, ' ').slice(0, 300), [key]);
      throw new LlmError('HTTP ' + res.status + (t ? '：' + t : ''), { status: res.status, ...classify(res.status, t) });
    }
    const r = conn.type === 'anthropic' ? await anthropicStream(res, req, limits) : await openaiStream(res, req, limits);
    const provided = r.usage.input !== null || r.usage.output !== null;
    const promptChars = (req.system || '').length + JSON.stringify(req.messages || []).length + JSON.stringify(req.tools || []).length;
    const usage = provided
      ? { input: r.usage.input || 0, output: r.usage.output || 0, cacheRead: r.usage.cacheRead || 0, cacheWrite: r.usage.cacheWrite || 0, source: 'provider' }
      : { input: Math.ceil(promptChars / 1.6), output: estimateTokens(r.text + JSON.stringify(r.toolCalls)), cacheRead: 0, cacheWrite: 0, source: 'estimated' };
    return { ...r, usage, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e && (e.name === 'TimeoutError' || (signal.aborted && timeout.aborted))) throw new LlmError('请求超时', { kind: 'timeout', retryable: true });
    if (e && (e.name === 'AbortError' || (req.signal && req.signal.aborted))) throw new LlmError('已取消', { kind: 'cancelled' });
    if (e instanceof SSE.LimitError) throw new LlmError(e.message, { kind: 'limit' });
    const msg = SEC.scrubSecrets(e && e.message || String(e), [key]);
    throw new LlmError(msg, { kind: /被拒绝|不允许/.test(msg) ? 'policy' : 'network', retryable: !/被拒绝|不允许/.test(msg) });
  }
}

module.exports = { chat, LlmError, classify, estimateTokens, TOOL_NAME_RE, _internal: { anthropicBody, openaiBody } };
