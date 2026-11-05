'use strict';
/* Tool execution is separate from model output. MCP programs are administrator
 * supplied local configuration, never accepted as HTTP tool definitions. A
 * process has the OS privileges of this service: use a container for untrusted
 * MCP servers. Each call still needs an exact tool ID grant from its caller. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { McpHttp } = require('./mcp-http');
const SEC = require('./security');

const LIMITS = Object.freeze({ maxArgsBytes: 65536, maxOutputBytes: 1048576, maxLineBytes: 1048576, timeoutMs: 15000, maxServers: 20, maxTools: 200 });
const SERVER_ID = /^[a-zA-Z0-9_-]{1,40}$/;
const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;
const CODE_TOOL_ID = /^(?:builtin:)?[a-zA-Z0-9_.-]{1,100}$/;
const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/;
const BLOCKED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP)$/i;
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh']);
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
class ToolError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolError'; this.code = code; }
}
const fail = (code, message) => { throw new ToolError(code, message); };
function assertJson(v, depth = 0, seen = new Set()) {
  if (depth > 16) fail('invalid_arguments', 'JSON nesting exceeds the tool limit');
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return;
  if ((!Array.isArray(v) && !plain(v)) || seen.has(v)) fail('invalid_arguments', 'Tool data must be finite JSON');
  seen.add(v);
  if (Object.keys(v).length > 10000) fail('invalid_arguments', 'Too many JSON fields');
  for (const k of Object.keys(v)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('invalid_arguments', 'Unsafe JSON property');
    assertJson(v[k], depth + 1, seen);
  }
  seen.delete(v);
}
function boundedJson(v, maxBytes, code = 'output_limit') {
  assertJson(v);
  const s = JSON.stringify(v);
  if (Buffer.byteLength(s) > maxBytes) fail(code, 'Tool data exceeds the size limit');
  return s;
}
function validateSchema(value, schema, where = 'arguments', depth = 0) {
  // A conservative useful subset; remote MCP servers remain responsible for
  // their complete JSON Schema (e.g. $ref), in addition to these local bounds.
  if (!plain(schema) || depth > 16) return;
  if (Array.isArray(schema.enum) && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) fail('invalid_arguments', where + ' is not an allowed value');
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = t => t === 'null' ? value === null : t === 'object' ? plain(value) : t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : t === 'number' ? Number.isFinite(value) : typeof value === t;
  if (types.length && !types.some(matches)) fail('invalid_arguments', where + ' has the wrong type');
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) fail('invalid_arguments', where + ' is too short');
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) fail('invalid_arguments', where + ' is too long');
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) fail('invalid_arguments', where + ' is too small');
    if (Number.isFinite(schema.maximum) && value > schema.maximum) fail('invalid_arguments', where + ' is too large');
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) fail('invalid_arguments', where + ' has too many items');
    for (const [i, item] of value.entries()) validateSchema(item, schema.items, where + '[' + i + ']', depth + 1);
  }
  if (plain(value)) {
    const props = plain(schema.properties) ? schema.properties : {};
    for (const k of Array.isArray(schema.required) ? schema.required : []) if (!Object.hasOwn(value, k)) fail('invalid_arguments', where + ' is missing ' + k);
    for (const [k, item] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validateSchema(item, props[k], where + '.' + k, depth + 1);
      else if (schema.additionalProperties === false) fail('invalid_arguments', where + ' has an unexpected field');
    }
  }
}
function cleanServer(raw) {
  if (!plain(raw) || !SERVER_ID.test(raw.id)) fail('invalid_mcp_config', 'MCP server requires a valid id');
  if (typeof raw.command !== 'string' || !path.isAbsolute(raw.command) || raw.command.includes('\0') || SHELLS.has(path.basename(raw.command).toLowerCase())) fail('invalid_mcp_config', 'MCP command must be an absolute executable path, not a shell');
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || args.length > 100 || args.some(a => typeof a !== 'string' || a.length > 8192 || a.includes('\0'))) fail('invalid_mcp_config', 'Invalid MCP argument list');
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd) || raw.cwd.includes('\0'))) fail('invalid_mcp_config', 'MCP cwd must be an absolute local path');
  if (raw.env !== undefined && !plain(raw.env)) fail('invalid_mcp_config', 'MCP env must be an object');
  const env = {};
  for (const [k, v] of Object.entries(raw.env || {})) {
    if (!ENV_NAME.test(k) || BLOCKED_ENV.test(k) || typeof v !== 'string' || v.length > 16384 || v.includes('\0')) fail('invalid_mcp_config', 'Invalid MCP environment entry');
    env[k] = v;
  }
  const envKeys = raw.envKeys || [];
  if (!Array.isArray(envKeys) || envKeys.length > 100 || envKeys.some(k => typeof k !== 'string' || !ENV_NAME.test(k) || BLOCKED_ENV.test(k))) fail('invalid_mcp_config', 'Invalid MCP environment selectors');
  return { id: raw.id, command: raw.command, args: [...args], ...(raw.cwd ? { cwd: raw.cwd } : {}), env, envKeys: [...envKeys], enabled: raw.enabled !== false };
}
function loadMcpServers(file = process.env.AIJ_MCP_SERVERS_FILE) {
  if (!file) return [];
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('invalid_mcp_config', 'AIJ_MCP_SERVERS_FILE must be an absolute local path');
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > 131072) fail('invalid_mcp_config', 'MCP configuration must be a bounded regular file');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('invalid_mcp_config', 'MCP configuration is not valid JSON'); }
  const servers = Array.isArray(doc) ? doc : doc && doc.servers;
  if (!Array.isArray(servers) || servers.length > LIMITS.maxServers) fail('invalid_mcp_config', 'MCP configuration requires a bounded servers array');
  const clean = servers.map(cleanServer);
  if (new Set(clean.map(s => s.id)).size !== clean.length) fail('invalid_mcp_config', 'Duplicate MCP server identifier');
  return clean;
}

class McpStdio {
  constructor(config, { timeoutMs, maxOutputBytes }) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0);
    this.child = null; this.starting = null; this.ready = false; this.closed = false;
  }
  _error(message) {
    // Never return stderr, command arguments, or configured environment values.
    let safe = String(message);
    for (const value of Object.values(this.config.env || {})) if (value.length > 3) safe = safe.split(value).join('[redacted]');
    for (const key of this.config.envKeys || []) if (process.env[key]?.length > 3) safe = safe.split(process.env[key]).join('[redacted]');
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) if (process.env[key]?.length > 3) safe = safe.split(process.env[key]).join('[redacted]');
    return new ToolError('mcp_error', safe.slice(0, 300));
  }
  close(reason = new ToolError('mcp_closed', 'MCP session closed')) {
    this.ready = false; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.cleanup(); p.reject(reason); }
    this.pending.clear();
    const child = this.child; this.child = null;
    if (child) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.kill('SIGTERM');
      const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 500); t.unref();
    }
  }
  async start(signal) {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.closed = false;
    this.starting = (async () => {
      const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', ...this.config.env };
      for (const key of this.config.envKeys) if (process.env[key] !== undefined) env[key] = process.env[key];
      // Credentials are opt-in via envKeys. Do retain managed egress and CA
      // settings so trusted MCP programs use the normal supported network path.
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']) if (process.env[key] !== undefined) env[key] = process.env[key];
      const child = spawn(this.config.command, this.config.args, { cwd: this.config.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.on('error', () => this.close(this._error('MCP process could not start')));
      child.on('exit', () => { if (this.child === child) this.close(this._error('MCP process exited')); });
      child.stdin.on('error', () => this.close(this._error('MCP input closed')));
      child.stdout.on('data', c => this._data(c));
      // Drain bounded-per-chunk stderr without retaining secrets or allowing it
      // to block child output. stderr is deliberately absent from API/audit.
      child.stderr.on('data', () => {});
      const init = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aijavais', version: '2.0.0' } }, signal);
      if (!plain(init) || !['2024-11-05', '2025-03-26', '2025-06-18'].includes(init.protocolVersion) || !plain(init.capabilities)) fail('mcp_protocol', 'MCP server returned an unsupported initialization response');
      this.notify('notifications/initialized', {});
      this.ready = true;
    })();
    try { await this.starting; } catch (e) { this.close(e); throw e; } finally { this.starting = null; }
  }
  _data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // JSON-RPC messages are newline-delimited in the MCP stdio transport.
    let i;
    while ((i = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, i); this.buffer = this.buffer.subarray(i + 1);
      if (line.length > this.maxOutputBytes) return this.close(new ToolError('output_limit', 'MCP response exceeds the limit'));
      if (!line.toString('utf8').trim()) continue;
      let msg;
      try { msg = JSON.parse(line.toString('utf8')); } catch { return this.close(new ToolError('mcp_protocol', 'MCP stdout must contain JSON-RPC only')); }
      if (!plain(msg) || msg.jsonrpc !== '2.0') return this.close(new ToolError('mcp_protocol', 'Invalid MCP JSON-RPC response'));
      if (Object.hasOwn(msg, 'id') && !msg.method) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        clearTimeout(p.timer); p.cleanup(); this.pending.delete(msg.id);
        if (msg.error) p.reject(this._error('MCP request failed: ' + String(msg.error.message || 'protocol error')));
        else if (!Object.hasOwn(msg, 'result')) p.reject(new ToolError('mcp_protocol', 'MCP response is missing result'));
        else p.resolve(msg.result);
      } else if (msg.method && Object.hasOwn(msg, 'id')) {
        // No sampling, elicitation, roots disclosure, or arbitrary reverse calls.
        try { this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Client capability not supported' } }) + '\n'); } catch {}
      }
    }
    if (this.buffer.length > this.maxOutputBytes) this.close(new ToolError('output_limit', 'MCP response exceeds the limit'));
  }
  notify(method, params) {
    if (!this.child || this.closed) fail('mcp_closed', 'MCP session is not running');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  request(method, params, signal) {
    if (!this.child || this.closed) return Promise.reject(new ToolError('mcp_closed', 'MCP session is not running'));
    if (signal?.aborted) return Promise.reject(new ToolError('aborted', 'Tool execution aborted'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = () => this.close(new ToolError('aborted', 'Tool execution aborted'));
      const timer = setTimeout(() => this.close(new ToolError('timeout', 'MCP request timed out')), this.timeoutMs); timer.unref();
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', e => { if (e) this.close(this._error('MCP input write failed')); });
    });
  }
}

const BUILTINS = [
  { toolId: 'builtin:text-stats', name: '文本统计', description: '实际统计 UTF-8 字节、字符、行和词数；不调用模型。', executionMode: 'builtin', available: true, risk: 'read',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200000 } }, required: ['text'], additionalProperties: false } },
  { toolId: 'builtin:json-validate', name: 'JSON 检查', description: '解析并检查 JSON 文本，可要求顶层字段存在。', executionMode: 'builtin', available: true, risk: 'read',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200000 }, requiredKeys: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 100 } }, required: ['text'], additionalProperties: false } },
];

async function invokeCodeHandler(handler, args, { context, signal, timeoutMs }) {
  const controller = new AbortController();
  const abort = () => controller.abort(new ToolError('aborted', 'Tool execution aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ToolError('timeout', 'Built-in tool timed out')), timeoutMs);
  timer.unref();
  try {
    return await new Promise((resolve, reject) => {
      const cancel = () => reject(controller.signal.reason);
      if (controller.signal.aborted) return cancel();
      controller.signal.addEventListener('abort', cancel, { once: true });
      // A code handler is trusted application code, not an OS-isolated worker.
      // Abort/timeout stops this call and signals the handler cooperatively;
      // JavaScript cannot forcibly terminate ignored asynchronous side effects.
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return handler(args, { context, signal: controller.signal });
      }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancel));
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}

class ToolRegistry {
  constructor({ mcpServers, httpServers = [], disabledServers = [], policy = null, tokenFor = () => '', builtinTools = [], audit = null, timeoutMs = LIMITS.timeoutMs, maxOutputBytes = LIMITS.maxOutputBytes } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 300000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 8388608) fail('invalid_tool_config', 'Tool limits are invalid');
    if (audit !== null && typeof audit !== 'function') fail('invalid_tool_config', 'audit must be a function');
    const servers = mcpServers === undefined ? loadMcpServers() : mcpServers;
    if (!Array.isArray(servers) || servers.length > LIMITS.maxServers) fail('invalid_mcp_config', 'Too many MCP servers');
    this.servers = servers.map(cleanServer).filter(s => s.enabled).map(s => ({ ...s, transport: 'stdio' }));
    this.policy = policy; this.tokenFor = tokenFor; this.disabled = new Set(disabledServers); this.logs = [];
    for (const h of httpServers) this.servers.push(this._cleanHttp(h));
    if (new Set(this.servers.map(s => s.id)).size !== this.servers.length) fail('invalid_mcp_config', 'Duplicate MCP server identifier');
    this.audit = audit; this.timeoutMs = timeoutMs; this.maxOutputBytes = maxOutputBytes;
    this.tools = new Map(BUILTINS.map(t => [t.toolId, structuredClone(t)])); this.sessions = new Map();
    this.codeHandlers = new Map();
    if (!Array.isArray(builtinTools) || builtinTools.length > LIMITS.maxTools - BUILTINS.length) fail('invalid_tool_config', 'builtinTools must be a bounded array');
    for (const tool of builtinTools) this.registerBuiltin(tool);
  }
  list() { return [...this.tools.values()].map(t => structuredClone(t)); }
  _cleanHttp(raw) {
    if (!plain(raw) || !SERVER_ID.test(raw.id)) fail('invalid_mcp_config', 'MCP server requires a valid id (letters, digits, - and _)');
    if (!this.policy) fail('invalid_mcp_config', 'Remote MCP needs the outbound network policy');
    const c = SEC.checkBaseUrlSyntax(String(raw.url || ''), this.policy);
    if (!c.ok) fail('invalid_mcp_config', 'MCP URL rejected: ' + c.error);
    return { id: raw.id, transport: 'http', url: c.url.href, name: String(raw.name || raw.id).slice(0, 80), enabled: true };
  }
  /* Public view: never command arguments, environment, URL credentials or tokens. */
  serverList() {
    return this.servers.map(s => ({ serverId: s.id, transport: s.transport, name: s.name || s.id, enabled: !this.disabled.has(s.id), removable: s.transport === 'http',
      ...(s.transport === 'http' ? { host: new URL(s.url).host, hasToken: !!this.tokenFor(s.id) } : { program: path.basename(s.command) }),
      tools: [...this.tools.values()].filter(t => t.serverId === s.id).length }));
  }
  _dropServerTools(id) { for (const [toolId, t] of this.tools) if (t.serverId === id) this.tools.delete(toolId); this.sessions.get(id)?.close(); this.sessions.delete(id); }
  setEnabled(id, enabled) {
    if (!this.servers.some(s => s.id === id)) fail('mcp_missing', 'MCP server is not configured');
    if (enabled) this.disabled.delete(id); else { this.disabled.add(id); this._dropServerTools(id); }
    return [...this.disabled];
  }
  addHttpServer(raw) {
    const server = this._cleanHttp(raw);
    if (this.servers.some(s => s.id === server.id)) fail('tool_conflict', 'An MCP server with this id already exists');
    if (this.servers.length >= LIMITS.maxServers) fail('invalid_mcp_config', 'Too many MCP servers');
    this.servers.push(server); return server;
  }
  removeHttpServer(id) {
    const s = this.servers.find(x => x.id === id);
    if (!s) fail('mcp_missing', 'MCP server is not configured');
    if (s.transport !== 'http') fail('mcp_file_managed', 'This MCP server is defined in the server configuration file; disable it here and ask the administrator to remove it from that file');
    this._dropServerTools(id); this.servers = this.servers.filter(x => x.id !== id); this.disabled.delete(id);
  }
  _log(entry) { this.logs.push({ at: Date.now(), ...entry }); if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500); }
  // Only callers with an actual JavaScript function can register trusted code.
  // No HTTP endpoint, configuration source string, eval, or dynamic module load.
  registerBuiltin(definition) {
    if (!plain(definition) || typeof definition.toolId !== 'string' || !CODE_TOOL_ID.test(definition.toolId) || typeof definition.handler !== 'function') fail('invalid_tool_config', 'Built-in tools require a safe ID and a trusted code handler');
    if (this.tools.has(definition.toolId)) fail('tool_conflict', 'Tool identifier is already registered');
    if (this.tools.size >= LIMITS.maxTools) fail('invalid_tool_config', 'Too many tools');
    if (typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 100 || (definition.description !== undefined && (typeof definition.description !== 'string' || definition.description.length > 4000)) || !plain(definition.inputSchema)) fail('invalid_tool_config', 'Invalid built-in tool metadata');
    boundedJson(definition.inputSchema, 32768, 'invalid_tool_config');
    // risk: read (no side effects) | internal_write (saves files inside AIJAVAIS) | exec (runs code). Unknown -> internal_write.
    const risk = ['read', 'internal_write', 'exec'].includes(definition.risk) ? definition.risk : 'internal_write';
    const tool = { toolId: definition.toolId, name: definition.name, description: definition.description || '', inputSchema: structuredClone(definition.inputSchema), available: true, executionMode: 'builtin', risk };
    this.tools.set(tool.toolId, tool); this.codeHandlers.set(tool.toolId, definition.handler);
    return structuredClone(tool);
  }
  _session(server) {
    let s = this.sessions.get(server.id);
    if (!s || s.closed) { s = server.transport === 'http' ? new McpHttp(server, { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, policy: this.policy, token: this.tokenFor(server.id) }) : new McpStdio(server, this); this.sessions.set(server.id, s); }
    return s;
  }
  async discover({ signal, serverId } = {}) {
    const states = [];
    for (const server of this.servers) {
      if (serverId && server.id !== serverId) continue;
      if (this.disabled.has(server.id)) { states.push({ serverId: server.id, available: false, disabled: true, code: 'disabled', error: 'MCP server is disabled' }); continue; }
      for (const [id, t] of this.tools) if (t.serverId === server.id) this.tools.delete(id);
      const t0 = Date.now();
      try {
        const session = this._session(server); await session.start(signal);
        const found = []; let cursor;
        for (let page = 0; page < 10; page++) {
          const doc = await session.request('tools/list', cursor ? { cursor } : {}, signal);
          if (!plain(doc) || !Array.isArray(doc.tools) || found.length + doc.tools.length > LIMITS.maxTools) fail('mcp_protocol', 'Invalid or excessive MCP tool list');
          for (const tool of doc.tools) {
            if (!plain(tool) || !TOOL_NAME.test(tool.name) || !plain(tool.inputSchema)) fail('mcp_protocol', 'Invalid MCP tool definition');
            boundedJson(tool.inputSchema, 32768);
            found.push({ toolId: 'mcp:' + server.id + ':' + tool.name, serverId: server.id, remoteName: tool.name, name: String(tool.title || tool.name).slice(0, 100), description: String(tool.description || '').slice(0, 4000), inputSchema: structuredClone(tool.inputSchema), executionMode: 'mcp', available: true,
              // MCP tools can have external side effects or costs; server annotations are unverified hints only.
              risk: 'external', annotations: Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].filter(k => typeof tool.annotations?.[k] === 'boolean').map(k => [k, tool.annotations[k]])) });
          }
          cursor = doc.nextCursor;
          if (!cursor) break;
          if (typeof cursor !== 'string' || cursor.length > 1000 || page === 9) fail('mcp_protocol', 'Excessive MCP tool pagination');
        }
        if (new Set(found.map(t => t.toolId)).size !== found.length || this.tools.size + found.length > LIMITS.maxTools) fail('mcp_protocol', 'Duplicate or excessive MCP tools');
        for (const t of found) this.tools.set(t.toolId, t);
        states.push({ serverId: server.id, available: true, tools: found.length });
        this._log({ serverId: server.id, action: 'discover', status: 'done', tools: found.length, durationMs: Date.now() - t0 });
      } catch (e) {
        this.sessions.get(server.id)?.close();
        const error = e instanceof ToolError || e?.name === 'ToolError' ? e.message : 'MCP discovery failed';
        states.push({ serverId: server.id, available: false, code: e.code || 'mcp_error', error });
        this._log({ serverId: server.id, action: 'discover', status: 'error', code: e.code || 'mcp_error', error, durationMs: Date.now() - t0 });
      }
    }
    return { tools: this.list(), servers: states };
  }
  async call(toolId, args, { allowedTools = [], context = {}, signal } = {}) {
    if (!Array.isArray(allowedTools) || allowedTools.length > LIMITS.maxTools || !allowedTools.includes(toolId)) fail('tool_forbidden', 'Tool requires an explicit grant: ' + String(toolId).slice(0, 160));
    const tool = this.tools.get(toolId);
    if (!tool) fail('tool_missing', 'Tool is not registered');
    if (signal?.aborted) fail('aborted', 'Tool execution aborted');
    if (!plain(args)) fail('invalid_arguments', 'Tool arguments must be an object');
    boundedJson(args, LIMITS.maxArgsBytes, 'invalid_arguments'); validateSchema(args, tool.inputSchema);
    args = structuredClone(args);
    const started = Date.now();
    const runId = typeof context?.runId === 'string' ? context.runId.slice(0, 100) : null;
    const event = { toolId, executionMode: tool.executionMode, verification: 'observed', taskId: typeof context?.taskId === 'string' ? context.taskId.slice(0, 100) : runId, runId, stepId: typeof context?.stepId === 'string' ? context.stepId.slice(0, 100) : null, timestamp: started };
    if (this.audit) await this.audit({ ...event, status: 'start' });
    try {
      if (signal?.aborted) fail('aborted', 'Tool execution aborted');
      let result;
      if (toolId === 'builtin:text-stats') {
        result = { content: [], structuredContent: { characters: [...args.text].length, utf8Bytes: Buffer.byteLength(args.text), lines: args.text.length ? args.text.split(/\r\n|\r|\n/).length : 0, words: args.text.trim() ? args.text.trim().split(/\s+/u).length : 0 } };
        result.content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      } else if (toolId === 'builtin:json-validate') {
        let value; try { value = JSON.parse(args.text); } catch { fail('invalid_json', 'Text is not valid JSON'); }
        assertJson(value);
        const missing = (args.requiredKeys || []).filter(k => !plain(value) || !Object.hasOwn(value, k));
        result = { content: [{ type: 'text', text: missing.length ? 'Missing required keys: ' + missing.join(', ') : 'Valid JSON' }], structuredContent: { valid: missing.length === 0, missingKeys: missing } };
      } else if (this.codeHandlers.has(toolId)) {
        const out = await invokeCodeHandler(this.codeHandlers.get(toolId), args, { context, signal, timeoutMs: this.timeoutMs });
        if (!plain(out) || !Array.isArray(out.content)) fail('invalid_result', 'Built-in tool must return a JSON content array');
        if (out.isError) fail('tool_failed', 'Built-in tool reported failure');
        result = { content: out.content, ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}) };
      } else {
        const server = this.servers.find(s => s.id === tool.serverId);
        if (!server) fail('tool_missing', 'MCP server is not configured');
        if (this.disabled.has(server.id)) fail('tool_disabled', 'MCP server is disabled');
        const session = this._session(server); await session.start(signal);
        const out = await session.request('tools/call', { name: tool.remoteName, arguments: args }, signal);
        if (!plain(out) || !Array.isArray(out.content)) fail('mcp_protocol', 'MCP tool result is invalid');
        if (out.isError) fail('tool_failed', 'MCP tool reported failure');
        result = { content: out.content, ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}) };
      }
      boundedJson(result, this.maxOutputBytes);
      if (signal?.aborted) fail('aborted', 'Tool execution aborted');
      const output = { toolId, executionMode: tool.executionMode, verification: 'observed', isError: false, ...result };
      if (this.audit) await this.audit({ ...event, status: 'done', durationMs: Date.now() - started });
      if (tool.serverId) this._log({ serverId: tool.serverId, action: 'call', toolId, status: 'done', durationMs: Date.now() - started });
      return output;
    } catch (e) {
      if (this.audit) await this.audit({ ...event, status: 'error', durationMs: Date.now() - started, code: e.code || 'tool_error' });
      if (tool.serverId) this._log({ serverId: tool.serverId, action: 'call', toolId, status: 'error', code: e.code || 'tool_error', durationMs: Date.now() - started });
      throw e;
    }
  }
  close() { for (const s of this.sessions.values()) s.close(); this.sessions.clear(); }
}

module.exports = { ToolRegistry, ToolError, McpStdio, loadMcpServers, validateSchema, TOOL_LIMITS: LIMITS };
