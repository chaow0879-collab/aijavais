'use strict';
// Local Streamable-HTTP MCP protocol fixture (not a real third-party service).
// Requires a bearer token and the session id it issues; answers tools/call for
// "sse_echo" as an event stream and everything else as JSON.
const http = require('node:http');
module.exports = function start(token = 'fixture-token') {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('unauthorized'); }
      const m = JSON.parse(body || '{}'); seen.push({ method: m.method, session: req.headers['mcp-session-id'] || null, version: req.headers['mcp-protocol-version'] || null });
      if (m.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(404); return res.end(); }
      if (!('id' in m)) { res.writeHead(202); return res.end(); }
      const reply = result => ({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); return res.end(JSON.stringify(reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }))); }
      if (m.method === 'tools/list') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(reply({ tools: ['echo', 'sse_echo'].map(name => ({ name, description: 'HTTP fixture ' + name, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })) }))); }
      if (m.method === 'tools/call' && m.params.name === 'sse_echo') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) + '\n\n');
        return res.end('event: message\ndata: ' + JSON.stringify(reply({ content: [{ type: 'text', text: 'sse:' + m.params.arguments.value }] })) + '\n\n');
      }
      if (m.method === 'tools/call') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(reply({ content: [{ type: 'text', text: 'json:' + m.params.arguments.value }] }))); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
};
