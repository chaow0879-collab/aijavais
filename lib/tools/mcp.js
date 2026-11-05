'use strict';
/*
 * MCP 客户端管理（官方 @modelcontextprotocol/sdk）。
 * 支持 stdio（本机启动的 MCP Server 进程）与 Streamable HTTP（远程 MCP Server）。
 * 发现到的工具注册进 Tool Registry，ID 为 mcp.<serverId>.<工具名>，与内置工具同样经过参数校验、权限、审批、日志。
 *
 * 默认安全策略：
 *   - 新增的 MCP Server 默认停用，需要用户确认启用；其工具默认“每次需要批准”。
 *   - stdio 进程：工作目录为 data/mcp/<serverId>；环境变量只含系统基本变量 + 用户为它配置的变量（加密保存），
 *     不继承平台的 API Key、主密钥等任何机密，也不告诉它数据目录在哪里。
 *   - HTTP：地址必须通过与模型接口相同的 SSRF 校验（公网 https，或显式声明的本地地址）。
 *   - 已知边界：stdio 进程以服务端同一系统用户运行，操作系统层面无法阻止它读取该用户可读的文件；
 *     需要强隔离时请在 Docker 中部署，或在 MCP 配置里用 docker run 启动服务器。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SEC = require('../security');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const toolKey = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

class McpManager {
  constructor({ db, registry, vault, dataDir, policy, emit = () => {} }) {
    this.db = db; this.registry = registry; this.vault = vault; this.dataDir = dataDir; this.policy = policy; this.emit = emit;
    this.conns = new Map(); // serverId -> { client, transport, tools, error, connectedAt }
  }
  _doc(id) { return this.db.getDoc('mcp_servers', 'server_id', id); }
  _save(d) { this.db.putDoc('mcp_servers', 'server_id', d.serverId, d, { enabled: d.enabled ? 1 : 0 }); }
  view(d) {
    const c = this.conns.get(d.serverId);
    return {
      serverId: d.serverId, name: d.name, description: d.description || '', transport: d.transport, command: d.command || '', args: d.args || [], url: d.url || '',
      envKeys: Object.keys(d.envEnc ? this.vault.decrypt(d.envEnc) : {}), headerKeys: Object.keys(d.headersEnc ? this.vault.decrypt(d.headersEnc) : {}),
      enabled: !!d.enabled, connected: !!(c && c.client), error: (c && c.error) || d.lastError || '', tools: c && c.tools ? c.tools.map(t => ({ name: t.name, toolId: t.toolId, description: t.description })) : [],
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    };
  }
  list() { return this.db.listDocs('mcp_servers').map(d => this.view(d)); }

  _validate(input, existing) {
    const transport = input.transport || (existing && existing.transport) || 'stdio';
    if (!['stdio', 'http'].includes(transport)) return 'transport 只能是 stdio 或 http';
    const name = String(input.name ?? (existing && existing.name) ?? '').trim().slice(0, 40);
    if (!name) return '请填写名称';
    if (transport === 'stdio') {
      const cmd = String(input.command ?? (existing && existing.command) ?? '').trim();
      if (!cmd || /[\n\r]/.test(cmd)) return '请填写启动命令（如 npx、node、python、docker）';
      const args = input.args ?? (existing && existing.args) ?? [];
      if (!Array.isArray(args) || args.length > 50 || args.some(a => typeof a !== 'string' || a.length > 500)) return 'args 必须是字符串数组';
    } else {
      const url = String(input.url ?? (existing && existing.url) ?? '');
      const c = SEC.checkBaseUrlSyntax(url, this.policy);
      if (!c.ok) return c.error;
    }
    for (const k of ['env', 'headers']) if (input[k] !== undefined && (typeof input[k] !== 'object' || Array.isArray(input[k]) || Object.entries(input[k]).some(([a, b]) => !/^[\w-]{1,64}$/.test(a) || typeof b !== 'string' || b.length > 4000))) return k + ' 必须是 { 名称: 字符串 }';
    return null;
  }
  add(input) {
    const bad = this._validate(input, null);
    if (bad) return { ok: false, error: bad };
    let id = String(input.serverId || input.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'mcp';
    if (!ID_RE.test(id) || this._doc(id)) id = (id.slice(0, 20) || 'mcp') + '-' + crypto.randomBytes(2).toString('hex');
    const now = Date.now();
    const d = { serverId: id, name: String(input.name).trim().slice(0, 40), description: String(input.description || '').slice(0, 200), transport: input.transport || 'stdio', command: input.command || '', args: input.args || [], url: input.url || '',
      envEnc: input.env ? this.vault.encrypt(input.env) : null, headersEnc: input.headers ? this.vault.encrypt(input.headers) : null, enabled: false, createdAt: now, updatedAt: now };
    this._save(d);
    return { ok: true, server: this.view(d) };
  }
  async update(id, input) {
    const d = this._doc(id);
    if (!d) return { ok: false, error: 'MCP Server 不存在', code: 404 };
    const bad = this._validate(input, d);
    if (bad) return { ok: false, error: bad };
    for (const k of ['name', 'description', 'transport', 'command', 'args', 'url']) if (input[k] !== undefined) d[k] = input[k];
    if (input.env !== undefined) d.envEnc = this.vault.encrypt(input.env);
    if (input.headers !== undefined) d.headersEnc = this.vault.encrypt(input.headers);
    d.updatedAt = Date.now();
    this._save(d);
    if (this.conns.has(id)) { await this.disconnect(id); if (d.enabled) await this.connect(id); }
    return { ok: true, server: this.view(d) };
  }
  async setEnabled(id, on) {
    const d = this._doc(id);
    if (!d) return { ok: false, error: 'MCP Server 不存在', code: 404 };
    d.enabled = !!on; d.updatedAt = Date.now();
    this._save(d);
    if (on) { const r = await this.connect(id); return { ok: r.ok, error: r.error, server: this.view(this._doc(id)) }; }
    await this.disconnect(id);
    return { ok: true, server: this.view(d) };
  }
  async remove(id) {
    await this.disconnect(id);
    const n = this.db.delDoc('mcp_servers', 'server_id', id);
    return n ? { ok: true } : { ok: false, error: 'MCP Server 不存在', code: 404 };
  }

  async connect(id, { timeoutMs = 20000 } = {}) {
    const d = this._doc(id);
    if (!d) return { ok: false, error: 'MCP Server 不存在' };
    await this.disconnect(id);
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    let transport;
    try {
      if (d.transport === 'stdio') {
        const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
        const cwd = path.join(this.dataDir, 'mcp', id);
        fs.mkdirSync(cwd, { recursive: true });
        const env = { ...getDefaultEnvironment(), ...(d.envEnc ? this.vault.decrypt(d.envEnc) : {}) };
        transport = new StdioClientTransport({ command: d.command, args: d.args || [], env, cwd, stderr: 'pipe' });
      } else {
        const t = await SEC.resolveTarget(d.url, this.policy);
        if (!t.ok) throw new Error('地址被拒绝：' + t.error);
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(new URL(d.url), { requestInit: { headers: d.headersEnc ? this.vault.decrypt(d.headersEnc) : {} } });
      }
      const client = new Client({ name: 'aijavais', version: '2.0.0' });
      await withTimeout(client.connect(transport), timeoutMs, '连接超时');
      const listed = await withTimeout(client.listTools(), timeoutMs, '获取工具列表超时');
      const tools = (listed.tools || []).slice(0, 200).map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} }, annotations: t.annotations || {}, toolId: `mcp.${id}.${toolKey(t.name)}` }));
      this.registry.unregisterWhere(x => x.source === 'mcp' && x.serverId === id);
      for (const t of tools) {
        const risk = t.annotations.readOnlyHint ? 'read' : t.annotations.openWorldHint ? 'network' : 'exec'; // 未声明只读的第三方工具按高风险处理
        this.registry.register({
          id: t.toolId, title: `${d.name} · ${t.name}`, description: `（MCP：${d.name}）${t.description}`.slice(0, 900), category: 'mcp', risk, source: 'mcp', serverId: id,
          inputSchema: sanitizeSchema(t.inputSchema), timeoutMs: 120000,
          available: async () => (this.conns.get(id) && this.conns.get(id).client ? { ok: true } : { ok: false, reason: `MCP Server「${d.name}」未连接` }),
          run: async (args, ctx) => {
            const c = this.conns.get(id);
            if (!c || !c.client) throw new Error('MCP Server 未连接');
            const r = await c.client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 120000 });
            const text = (r.content || []).map(p => (p.type === 'text' ? p.text : p.type === 'resource' && p.resource && p.resource.text ? p.resource.text : `[${p.type} 内容]`)).join('\n');
            return { content: text || (r.structuredContent ? JSON.stringify(r.structuredContent) : '（无输出）'), isError: !!r.isError, data: r.structuredContent };
          },
        });
      }
      this.conns.set(id, { client, transport, tools, error: '', connectedAt: Date.now() });
      if (d.lastError) { d.lastError = ''; this._save(d); }
      transport.onclose = () => { const c = this.conns.get(id); if (c && c.client === client) { this.conns.set(id, { ...c, client: null, error: '连接已断开' }); } };
      this.emit({ type: 'mcp_connected', serverId: id, tools: tools.length });
      return { ok: true, tools: tools.map(t => t.toolId) };
    } catch (e) {
      try { if (transport && transport.close) await transport.close(); } catch { /* 忽略 */ }
      const msg = SEC.scrubSecrets(e && e.message || String(e));
      this.conns.set(id, { client: null, tools: [], error: msg });
      d.lastError = msg; this._save(d);
      return { ok: false, error: msg };
    }
  }
  async disconnect(id) {
    const c = this.conns.get(id);
    this.registry.unregisterWhere(x => x.source === 'mcp' && x.serverId === id);
    if (c && c.client) { try { await c.client.close(); } catch { /* 忽略 */ } }
    this.conns.delete(id);
  }
  async connectEnabled() {
    const out = [];
    for (const d of this.db.listDocs('mcp_servers', 'enabled = 1')) out.push({ serverId: d.serverId, ...(await this.connect(d.serverId)) });
    return out;
  }
  async closeAll() { for (const id of [...this.conns.keys()]) await this.disconnect(id); }
}
function withTimeout(p, ms, msg) { let t; return Promise.race([p.finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]); }
/* 第三方工具的 JSON Schema：只保留必要结构，去掉 $ref / 远程引用等 */
function sanitizeSchema(s) {
  const j = JSON.parse(JSON.stringify(s || {}));
  const walk = o => { if (!o || typeof o !== 'object') return; delete o.$ref; delete o.$id; delete o.$schema; for (const v of Object.values(o)) walk(v); };
  walk(j);
  if (j.type !== 'object') return { type: 'object', properties: {} };
  return j;
}

module.exports = { McpManager };
