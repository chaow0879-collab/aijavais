'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolRegistry, McpStdio, loadMcpServers } = require('../lib/tools-v2');
const fixture = path.join(__dirname, 'fixtures', 'mcp-v2-server.cjs');
const config = () => [{ id: 'fixture', command: process.execPath, args: [fixture] }];
const grant = toolId => ({ allowedTools: [toolId], context: { taskId: 'test-task' } });

test('tools: default registry exposes only real bounded built-ins and requires exact grants', async () => {
  const tools = new ToolRegistry({ mcpServers: [] });
  assert.equal(tools.list().length, 2);
  assert.ok(tools.list().every(t => t.executionMode === 'builtin' && t.available));
  await assert.rejects(tools.call('builtin:text-stats', { text: 'hello' }), { code: 'tool_forbidden' });
  await assert.rejects(tools.call('builtin:text-stats', { text: 'hello' }, { allowedTools: ['*'] }), { code: 'tool_forbidden' });
  const out = await tools.call('builtin:text-stats', { text: 'hello 世界\n😀' }, grant('builtin:text-stats'));
  assert.deepEqual(out.structuredContent, { characters: 10, utf8Bytes: 17, lines: 2, words: 3 });
  assert.equal(out.executionMode, 'builtin'); assert.equal(out.verification, 'observed');
});

test('tools: built-in JSON checks parse data and identify missing keys', async () => {
  const tools = new ToolRegistry({ mcpServers: [] });
  const good = await tools.call('builtin:json-validate', { text: '{"a":1}', requiredKeys: ['a'] }, grant('builtin:json-validate'));
  assert.equal(good.structuredContent.valid, true);
  const missing = await tools.call('builtin:json-validate', { text: '{"a":1}', requiredKeys: ['b'] }, grant('builtin:json-validate'));
  assert.equal(missing.structuredContent.valid, false); assert.deepEqual(missing.structuredContent.missingKeys, ['b']);
  await assert.rejects(tools.call('builtin:json-validate', { text: '{bad' }, grant('builtin:json-validate')), { code: 'invalid_json' });
});

test('tools: argument validation rejects types, unsafe keys and oversized bodies', async () => {
  const tools = new ToolRegistry({ mcpServers: [] }); const allowed = grant('builtin:text-stats');
  for (const args of [{}, { text: 4 }, { text: 'x', extra: true }, JSON.parse('{"text":"x","__proto__":{}}'), { text: 'x'.repeat(70000) }]) await assert.rejects(tools.call('builtin:text-stats', args, allowed), { code: 'invalid_arguments' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.call('builtin:text-stats', { text: 'x' }, { ...allowed, signal: controller.signal }), { code: 'aborted' });
});

test('tools: audit records execution kind and task without argument contents', async () => {
  const events = []; const tools = new ToolRegistry({ mcpServers: [], audit: e => events.push(e) });
  await tools.call('builtin:text-stats', { text: 'private task content' }, grant('builtin:text-stats'));
  assert.deepEqual(events.map(e => e.status), ['start', 'done']);
  assert.equal(events[1].taskId, 'test-task'); assert.equal(events[1].executionMode, 'builtin');
  assert.ok(!JSON.stringify(events).includes('private task content'));
  await assert.rejects(tools.call('builtin:json-validate', { text: '{' }, grant('builtin:json-validate')));
  assert.equal(events.at(-1).status, 'error'); assert.equal(events.at(-1).code, 'invalid_json');
});

test('tools: local MCP protocol fixture completes initialize/list/call and distinguishes mcp execution', async t => {
  const tools = new ToolRegistry({ mcpServers: config() }); t.after(() => tools.close());
  const discovery = await tools.discover();
  assert.deepEqual(discovery.servers, [{ serverId: 'fixture', available: true, tools: 5 }]);
  const id = 'mcp:fixture:echo';
  await assert.rejects(tools.call(id, { value: 'hello' }), { code: 'tool_forbidden' });
  const result = await tools.call(id, { value: 'hello' }, grant(id));
  assert.equal(result.executionMode, 'mcp'); assert.equal(result.structuredContent.echo, 'hello');
  assert.equal(result.content[0].text, 'hello');
  await assert.rejects(tools.call(id, { wrong: true }, grant(id)), { code: 'invalid_arguments' });
  await assert.rejects(tools.call('mcp:fixture:fail', { value: 'x' }, grant('mcp:fixture:fail')), { code: 'tool_failed' });
});

test('tools: MCP children receive explicit credentials only; process configuration is never listed', async t => {
  const prior = { gh: process.env.GH_TOKEN, inherited: process.env.AIJ_FIXTURE_INHERIT };
  process.env.GH_TOKEN = 'fixture-never-forward-this'; process.env.AIJ_FIXTURE_INHERIT = 'explicit-selector';
  t.after(() => {
    if (prior.gh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prior.gh;
    if (prior.inherited === undefined) delete process.env.AIJ_FIXTURE_INHERIT; else process.env.AIJ_FIXTURE_INHERIT = prior.inherited;
  });
  const servers = config(); servers[0].env = { AIJ_FIXTURE_ALLOWED: 'selected-value' }; servers[0].envKeys = ['AIJ_FIXTURE_INHERIT'];
  const tools = new ToolRegistry({ mcpServers: servers }); t.after(() => tools.close()); await tools.discover();
  const id = 'mcp:fixture:env'; const result = await tools.call(id, { value: '' }, grant(id));
  assert.deepEqual(JSON.parse(result.content[0].text), { ghPresent: false, explicit: 'selected-value', inherited: 'explicit-selector' });
  const listed = JSON.stringify(tools.list()); assert.ok(!listed.includes('selected-value')); assert.ok(!listed.includes(process.execPath));
});

test('tools: MCP timeout, cancellation and output bounds close their sessions', async t => {
  const tools = new ToolRegistry({ mcpServers: config(), timeoutMs: 300, maxOutputBytes: 4096 }); t.after(() => tools.close());
  await tools.discover();
  await assert.rejects(tools.call('mcp:fixture:slow', { value: '' }, grant('mcp:fixture:slow')), { code: 'timeout' });
  assert.equal(tools.sessions.get('fixture').closed, true);
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 150);
  try { await assert.rejects(tools.call('mcp:fixture:slow', { value: '' }, { ...grant('mcp:fixture:slow'), signal: ctrl.signal }), { code: 'aborted' }); } finally { clearTimeout(timer); }
  await assert.rejects(tools.call('mcp:fixture:large', { value: '' }, grant('mcp:fixture:large')), { code: 'output_limit' });
  assert.equal(tools.sessions.get('fixture').closed, true);
});

test('tools: administrator MCP file validation rejects shell commands and dynamic loader environment', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-mcp-v2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'servers.json');
  fs.writeFileSync(file, JSON.stringify({ servers: config() })); assert.equal(loadMcpServers(file)[0].id, 'fixture');
  for (const server of [{ id: 'bad', command: 'node' }, { id: 'bad', command: '/bin/sh', args: ['-c', 'echo bad'] }, { ...config()[0], env: { NODE_OPTIONS: '--require bad.js' } }]) {
    fs.writeFileSync(file, JSON.stringify({ servers: [server] })); assert.throws(() => loadMcpServers(file), { code: 'invalid_mcp_config' });
  }
  fs.writeFileSync(file, JSON.stringify({ servers: [...config(), ...config()] })); assert.throws(() => loadMcpServers(file), { code: 'invalid_mcp_config' });
  assert.throws(() => loadMcpServers('relative.json'), { code: 'invalid_mcp_config' });
});

test('tools: unavailable MCP process is reported unavailable without exposing commands or stderr', async t => {
  const tools = new ToolRegistry({ mcpServers: [{ id: 'missing', command: '/missing/aijavais-secret-program' }], timeoutMs: 100 }); t.after(() => tools.close());
  const out = await tools.discover(); assert.equal(out.servers[0].available, false); assert.equal(tools.list().length, 2);
  assert.ok(!JSON.stringify(out).includes('aijavais-secret-program'));
});

test('tools: cancellation closes all in-flight calls on a shared MCP session', async t => {
  // Sessions are shared per configured server. Cancellation is fail-closed for
  // that server, rather than falsely claiming independent process isolation.
  const tools = new ToolRegistry({ mcpServers: config(), timeoutMs: 1000 }); t.after(() => tools.close()); await tools.discover();
  const signal = new AbortController();
  const a = tools.call('mcp:fixture:slow', { value: 'a' }, { ...grant('mcp:fixture:slow'), signal: signal.signal });
  const b = tools.call('mcp:fixture:slow', { value: 'b' }, grant('mcp:fixture:slow'));
  const results = Promise.allSettled([a, b]);
  setTimeout(() => signal.abort(), 30);
  const settled = await results;
  assert.ok(settled.every(r => r.status === 'rejected' && r.reason.code === 'aborted'));
});

test('tools: scrub configured credentials before truncation and correlate run/step audit', async () => {
  const value = 'long-fixture-secret-that-straddles-truncation';
  const s = new McpStdio({ id: 'test', command: process.execPath, args: [], env: { KEY: value }, envKeys: [] }, { timeoutMs: 100, maxOutputBytes: 4096 });
  const error = s._error('x'.repeat(290) + value);
  assert.ok(!error.message.includes('long-fixtu')); assert.ok(error.message.includes('[redacted]'));
  const audit = [];
  const tools = new ToolRegistry({ mcpServers: [], audit: e => audit.push(e) });
  await tools.call('builtin:text-stats', { text: '' }, { allowedTools: ['builtin:text-stats'], context: { runId: 'run-1', stepId: 'step-1' } });
  assert.equal(audit[0].taskId, 'run-1'); assert.equal(audit[0].stepId, 'step-1');
});

const codeTool = handler => ({ toolId: 'docx_generation', name: 'Document generator', description: 'Trusted code extension fixture', inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['title'], additionalProperties: false }, handler });

test('tools: trusted code registration executes real handlers with schema, grants, context and safe metadata', async () => {
  let calls = 0; const audit = [];
  const tools = new ToolRegistry({ mcpServers: [], audit: e => audit.push(e), builtinTools: [codeTool(async (args, { context, signal }) => {
    calls++; assert.equal(signal.aborted, false);
    return { content: [{ type: 'text', text: args.title }], structuredContent: { artifactId: 'actual-artifact-' + calls, runId: context.runId }, executionMode: 'forged' };
  })] });
  const metadata = tools.list().find(t => t.toolId === 'docx_generation');
  assert.equal(metadata.executionMode, 'builtin'); assert.equal(metadata.available, true); assert.equal(metadata.handler, undefined);
  metadata.inputSchema.required.length = 0;
  await assert.rejects(tools.call('docx_generation', { title: 'Test' }), { code: 'tool_forbidden' });
  await assert.rejects(tools.call('docx_generation', {}, grant('docx_generation')), { code: 'invalid_arguments' });
  assert.equal(calls, 0);
  const result = await tools.call('docx_generation', { title: 'Real handler' }, { allowedTools: ['docx_generation'], context: { runId: 'run-doc' } });
  assert.equal(calls, 1); assert.equal(result.executionMode, 'builtin'); assert.equal(result.structuredContent.runId, 'run-doc');
  assert.equal(result.structuredContent.artifactId, 'actual-artifact-1'); assert.equal(audit.at(-1).status, 'done');
  const added = tools.registerBuiltin({ ...codeTool(() => ({ content: [] })), toolId: 'artifact_read' });
  assert.equal(added.toolId, 'artifact_read');
});

test('tools: code registration cannot override existing IDs, claim MCP namespace or register HTTP strings', () => {
  const tools = new ToolRegistry({ mcpServers: [] });
  assert.throws(() => tools.registerBuiltin({ ...codeTool(() => ({ content: [] })), toolId: 'builtin:text-stats' }), { code: 'tool_conflict' });
  assert.throws(() => tools.registerBuiltin({ ...codeTool(() => ({ content: [] })), toolId: 'mcp:fixture:echo' }), { code: 'invalid_tool_config' });
  assert.throws(() => tools.registerBuiltin(codeTool('async () => ({content: []})')), { code: 'invalid_tool_config' });
  assert.throws(() => new ToolRegistry({ mcpServers: [], builtinTools: [{ ...codeTool(() => ({ content: [] })), inputSchema: null }] }), { code: 'invalid_tool_config' });
  tools.registerBuiltin(codeTool(() => ({ content: [] })));
  assert.throws(() => tools.registerBuiltin(codeTool(() => ({ content: [] }))), { code: 'tool_conflict' });
});

test('tools: code handler output is bounded JSON and cannot override execution metadata', async () => {
  for (const [handler, code] of [
    [() => null, 'invalid_result'], [() => ({ content: [] , structuredContent: { value: Infinity } }), 'invalid_arguments'],
    [() => ({ content: [], structuredContent: { callback: () => true } }), 'invalid_arguments'],
    [() => ({ content: [], isError: true }), 'tool_failed'],
    [() => ({ content: [{ type: 'text', text: 'x'.repeat(9000) }] }), 'output_limit'],
  ]) {
    const tools = new ToolRegistry({ mcpServers: [], maxOutputBytes: 4096, builtinTools: [codeTool(handler)] });
    await assert.rejects(tools.call('docx_generation', { title: 'x' }, grant('docx_generation')), { code });
  }
});

test('tools: cancelling code handlers rejects the call and emits error without a success audit', async () => {
  const signal = new AbortController(); let observedAbort = false; const audit = [];
  const tools = new ToolRegistry({ mcpServers: [], audit: e => audit.push(e), builtinTools: [codeTool(async (_args, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { observedAbort = true; resolve({ content: [] }); }, { once: true });
  }))] });
  const call = tools.call('docx_generation', { title: 'x' }, { allowedTools: ['docx_generation'], signal: signal.signal });
  const rejection = assert.rejects(call, { code: 'aborted' });
  setTimeout(() => signal.abort(), 20); await rejection;
  assert.equal(observedAbort, true); assert.deepEqual(audit.map(e => e.status), ['start', 'error']);
});

test('tools: code handler timeout cooperatively aborts handler and rejects stalled execution', async () => {
  let observedAbort = false;
  const tools = new ToolRegistry({ mcpServers: [], timeoutMs: 30, builtinTools: [codeTool(async (_args, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => {
    observedAbort = true; resolve({ content: [] });
  }, { once: true })))] });
  // Keep the test process alive: registry timeout timers do not hold a service open.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(tools.call('docx_generation', { title: 'x' }, grant('docx_generation')), { code: 'timeout' }); } finally { clearTimeout(keepAlive); }
  assert.equal(observedAbort, true);
});
