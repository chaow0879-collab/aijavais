'use strict';
// A local protocol fixture. It does not contact a real external MCP provider.
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
lines.on('line', line => {
  const m = JSON.parse(line);
  if (!Object.hasOwn(m, 'id')) return;
  if (m.method === 'initialize') return send(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aijavais-protocol-fixture', version: '1.0.0' } });
  if (m.method === 'tools/list') return send(m.id, { tools: ['echo', 'fail', 'slow', 'large', 'env'].map(name => ({ name, description: 'Local test fixture: ' + name, inputSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 1000 } }, required: ['value'], additionalProperties: false } })) });
  if (m.method !== 'tools/call') return;
  if (m.params.name === 'slow') return;
  if (m.params.name === 'fail') return send(m.id, { isError: true, content: [{ type: 'text', text: 'Fixture failure' }] });
  if (m.params.name === 'large') return send(m.id, { content: [{ type: 'text', text: 'x'.repeat(8000) }] });
  if (m.params.name === 'env') return send(m.id, { content: [{ type: 'text', text: JSON.stringify({ ghPresent: !!process.env.GH_TOKEN, explicit: process.env.AIJ_FIXTURE_ALLOWED || '', inherited: process.env.AIJ_FIXTURE_INHERIT || '' }) }] });
  send(m.id, { content: [{ type: 'text', text: m.params.arguments.value }], structuredContent: { echo: m.params.arguments.value } });
});
