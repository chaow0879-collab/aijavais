'use strict';
/* MCP Streamable HTTP client (zero npm deps). JSON-RPC requests are POSTed to
 * one endpoint; the server answers with application/json or a text/event-stream
 * carrying the response. Every request goes through SEC.pinnedFetch, so the URL
 * obeys the same SSRF, DNS-pinning, TLS and no-redirect rules as model calls.
 * Authentication: optional static bearer token held server-side only. OAuth
 * authorization flows are NOT implemented. Server-initiated requests (sampling,
 * elicitation, roots) are not supported and are not answered. */
const SEC = require('./security');
const SSE = require('./sse');

class McpHttpError extends Error { constructor(code, message) { super(message); this.name = 'ToolError'; this.code = code; } }
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

class McpHttp {
  constructor(config, { timeoutMs = 15000, maxOutputBytes = 1048576, policy, token } = {}) {
    this.config = config; this.timeoutMs = timeoutMs; this.maxOutputBytes = maxOutputBytes; this.policy = policy; this.token = token || '';
    this.sessionId = null; this.protocolVersion = null; this.ready = false; this.closed = false; this.nextId = 1; this.starting = null;
  }
  _safe(message) {
    let s = String(message || '');
    if (this.token.length > 3) s = s.split(this.token).join('[redacted]');
    return s.slice(0, 300);
  }
  _headers() {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}) };
  }
  async _post(message, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let res;
    try { res = await SEC.pinnedFetch(this.config.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(message), signal: sig, maxBytes: this.maxOutputBytes }, this.policy); }
    catch (e) {
      if (signal?.aborted) throw new McpHttpError('aborted', 'Tool execution aborted');
      if (timeout.aborted) throw new McpHttpError('timeout', 'MCP request timed out');
      throw new McpHttpError('mcp_unreachable', this._safe('MCP server unreachable: ' + e.message));
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) this.sessionId = sid;
    if (res.status === 401 || res.status === 403) { await SSE.readLimitedText(res, 1024).catch(() => ''); throw new McpHttpError('mcp_auth', 'MCP server rejected the credentials (HTTP ' + res.status + '); OAuth sign-in is not supported, use a static token'); }
    if (res.status === 404 && this.sessionId && message.method !== 'initialize') { this.ready = false; this.sessionId = null; throw new McpHttpError('mcp_closed', 'MCP session expired; test the connection again'); }
    if (!('id' in message)) { await SSE.readLimitedText(res, 1024).catch(() => ''); if (res.status >= 400) throw new McpHttpError('mcp_error', 'MCP notification failed (HTTP ' + res.status + ')'); return null; }
    if (!res.ok) { const t = await SSE.readLimitedText(res, 512).catch(() => ''); throw new McpHttpError('mcp_error', this._safe('MCP HTTP ' + res.status + (t ? ': ' + t.replace(/\s+/g, ' ') : ''))); }
    const type = String(res.headers.get('content-type') || '');
    let reply = null;
    const accept = msg => { if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.id === message.id && !msg.method) reply = msg; };
    if (type.includes('text/event-stream')) {
      await SSE.parseSSE(res.body, data => { if (reply) return; try { accept(JSON.parse(data)); } catch { /* ignore non-JSON events */ } }, { maxEventBytes: this.maxOutputBytes, maxTotalBytes: this.maxOutputBytes });
    } else if (type.includes('application/json')) {
      const text = await SSE.readLimitedText(res, this.maxOutputBytes);
      let doc; try { doc = JSON.parse(text); } catch { throw new McpHttpError('mcp_protocol', 'MCP server returned invalid JSON'); }
      for (const m of Array.isArray(doc) ? doc : [doc]) accept(m);
    } else throw new McpHttpError('mcp_protocol', 'MCP server returned an unsupported content type');
    if (!reply) throw new McpHttpError('mcp_protocol', 'MCP server did not answer the request');
    if (reply.error) throw new McpHttpError('mcp_error', this._safe('MCP request failed: ' + (reply.error.message || 'protocol error')));
    if (!('result' in reply)) throw new McpHttpError('mcp_protocol', 'MCP response is missing result');
    return reply.result;
  }
  async start(signal) {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.closed = false;
    this.starting = (async () => {
      const init = await this._post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: 'aijavais', version: '2.0.0' } } }, signal);
      if (!init || typeof init !== 'object' || !PROTOCOLS.includes(init.protocolVersion) || !init.capabilities || typeof init.capabilities !== 'object') throw new McpHttpError('mcp_protocol', 'MCP server returned an unsupported initialization response');
      this.protocolVersion = init.protocolVersion;
      await this._post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, signal);
      this.ready = true;
    })();
    try { await this.starting; } catch (e) { this.ready = false; throw e; } finally { this.starting = null; }
  }
  request(method, params, signal) {
    if (this.closed) return Promise.reject(new McpHttpError('mcp_closed', 'MCP session is not running'));
    return this._post({ jsonrpc: '2.0', id: this.nextId++, method, params }, signal);
  }
  close() { this.ready = false; this.closed = true; this.sessionId = null; this.protocolVersion = null; }
}
module.exports = { McpHttp, McpHttpError };
