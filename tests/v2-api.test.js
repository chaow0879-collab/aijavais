'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const H = require('./helpers');

async function fixture(t) {
  const requests = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body); requests.push(input);
      const text = 'LOCAL MODEL FIXTURE ' + input.model + ' #' + requests.length + ': verified handoff text';
      const send = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
      };
      if (input.model === 'slow-probe') setTimeout(send, 200); else send();
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const env = { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port };
  let S = await H.boot({ env });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const ids = [];
  for (const name of ['writer', 'reviewer']) {
    const r = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: name, displayName: name, pricingMode: 'local', capabilities: ['writing'] });
    assert.equal(r.status, 200, r.text); ids.push(r.json.connection.connectionId);
    assert.equal((await S.call('POST', '/api/models/' + ids.at(-1) + '/test', {})).json.ok, true);
  }
  return { get S() { return S; }, requests, ids, async restart() { const dir = S.dir; await S.kill(); S = await H.boot({ env, dir }); } };
}
const projectInput = ids => ({ name: 'API project', description: 'Create, review and revise a concrete report', standards: ['No invented evidence'],
  roles: [{ roleId: 'writer', name: 'Writer', duty: 'Draft and revise', standard: 'Readable report', connectionId: ids[0] }, { roleId: 'reviewer', name: 'Reviewer', duty: 'Review evidence', standard: 'Specific comments', connectionId: ids[1] }],
  steps: [{ stepId: 'draft', roleId: 'writer', title: 'Draft' },
    { stepId: 'review', roleId: 'reviewer', title: 'Review', toolCalls: [{ toolId: 'docx_generation', args: {} }] },
    { stepId: 'revise', roleId: 'writer', title: 'Revise', toolCalls: [{ toolId: 'file_read', args: {} }] }] });
async function finish(S, runId) {
  for (let i = 0; i < 100; i++) {
    const r = await S.call('GET', '/api/v2/runs/' + runId); assert.equal(r.status, 200, r.text);
    if (!['running', 'queued'].includes(r.json.run.status)) return r.json.run;
    await H.sleep(30);
  }
  throw new Error('Run did not finish');
}
async function bytes(S, method, url, body) {
  const r = await fetch(`http://127.0.0.1:${S.port}${url}`, { method, headers: { cookie: S.cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
}
test('V2 HTTP: durable role communication, optimistic edits, human review and real files survive restart (local model fixture)', async t => {
  const f = await fixture(t), S = f.S;
  assert.equal((await S.call('GET', '/api/v2/projects', undefined, { cookie: false })).status, 401);
  const create = await S.call('POST', '/api/v2/projects', projectInput(f.ids)); assert.equal(create.status, 201, create.text);
  const project = create.json.project, pid = project.projectId;
  const bad = await S.call('PUT', '/api/v2/projects/' + pid, { version: project.version, roles: [null] }); assert.equal(bad.status, 400);
  const update = await S.call('PUT', '/api/v2/projects/' + pid, { ...projectInput(f.ids), version: project.version, name: 'Updated title' }); assert.equal(update.status, 200, update.text);
  assert.equal((await S.call('PUT', '/api/v2/projects/' + pid, { ...projectInput(f.ids), version: project.version })).status, 409);
  assert.equal((await S.call('POST', '/api/v2/projects/' + pid + '/validate', {})).json.ok, true);
  const missingGrant = await S.call('POST', '/api/v2/projects/' + pid + '/runs', { maxTokens: 20000 }); assert.equal(missingGrant.status, 403);
  const launched = await S.call('POST', '/api/v2/projects/' + pid + '/runs', { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0, allowedTools: ['docx_generation', 'file_read'] }); assert.equal(launched.status, 202, launched.text);
  const rid = launched.json.run.runId, run = await finish(S, rid);
  assert.equal(run.status, 'review_required'); assert.equal(run.steps.length, 3);
  assert.equal(f.requests.length, 5); // two connection probes + three executed roles
  assert.match(f.requests[3].messages.at(-1).content, /LOCAL MODEL FIXTURE writer #3/);
  assert.match(f.requests[4].messages.at(-1).content, /LOCAL MODEL FIXTURE reviewer #4/);
  assert.ok(run.messages.length >= 3); assert.ok(run.events.some(e => e.eventType === 'model_done'));
  assert.equal(run.usage.providerTokens, 90); assert.equal(run.usage.cost, 0);
  assert.equal(run.usageLedger.length, 3);
  const toolFile = run.artifacts.find(a => a.producer === 'docx_generation'); assert.ok(toolFile && toolFile.bytes > 500);
  const actualToolFile = await bytes(S, 'GET', `/api/v2/runs/${rid}/artifacts/${toolFile.artifactId}/download`);
  assert.equal(actualToolFile.buffer.subarray(0, 2).toString(), 'PK');
  assert.match(f.requests[4].messages.at(-1).content, /artifactId/);
  const approved = await S.call('POST', '/api/v2/runs/' + rid + '/review', { decision: 'approve', feedback: 'Evidence checked' }); assert.equal(approved.status, 200, approved.text); assert.equal(approved.json.run.status, 'approved');
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const file = await bytes(f.S, 'POST', '/api/v2/runs/' + rid + '/export', { format });
    assert.equal(file.status, 200, file.buffer.toString()); assert.equal(file.buffer.subarray(0, 2).toString(), 'PK'); assert.ok(file.buffer.length > 500);
    const artifactId = file.headers.get('x-artifact-id'); assert.ok(artifactId);
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    if (format === 'docx') {
      await f.restart();
      const fetched = await bytes(f.S, 'GET', `/api/v2/runs/${rid}/artifacts/${artifactId}/download`);
      assert.equal(fetched.status, 200); assert.equal(crypto.createHash('sha256').update(fetched.buffer).digest('hex'), hash);
      assert.equal((await f.S.call('GET', '/api/v2/runs/' + rid)).json.run.status, 'approved');
    }
  }
});

test('V2 guards: tool grants, Skill persistence, conservative intake and legacy remote approval', async t => {
  const f = await fixture(t), S = f.S;
  const toolId = 'builtin:text-stats';
  assert.equal((await S.call('POST', '/api/v2/tools/call', { toolId, args: { text: 'real builtin' } })).status, 400);
  const tool = await S.call('POST', '/api/v2/tools/call', { toolId, args: { text: 'real builtin' }, allowedTools: [toolId] }); assert.equal(tool.status, 200, tool.text); assert.equal(tool.json.result.executionMode, 'builtin');
  const skill = { skillId: 'api-check', name: 'API check', version: '1.0.0', steps: [{ type: 'check', check: 'nonempty' }] };
  assert.equal((await S.call('POST', '/api/v2/skills', skill)).status, 200);
  const request = { templateId: 'ppt-production', description: '请创建一份项目计划演示文稿并注明验收标准。', availableTools: [{ id: 'pptx_generation', available: true, verified: true }, { id: 'slide_render', available: true, verified: true }], availableModels: [{ connectionId: 'fake', ready: true }] };
  const planned = await S.call('POST', '/api/v2/intake/plan', request); assert.equal(planned.status, 200, planned.text); assert.equal(planned.json.plan.readyForAutomatedExecution, false);
  assert.ok(!planned.json.plan.missingTools.includes('pptx_generation'), 'server actually registers the document tool');
  // chart_generation is now a real built-in tool; slide_render is still unimplemented, so a client claim must not register it.
  assert.ok(!planned.json.plan.missingTools.includes('chart_generation'), 'server actually registers the chart tool');
  const spoof = await S.call('POST', '/api/v2/intake/plan', { templateId: 'deep-research', description: '请研究行业趋势并给出带来源的结论。', availableTools: [{ id: 'web_search', available: true, verified: true }] });
  assert.ok(spoof.json.plan.missingTools.includes('web_search'), 'client claims never register a missing search tool');
  assert.equal(spoof.json.toolCheck.find(x => x.intakeId === 'web_search').status, 'not_implemented');
  const malformed = await S.call('POST', '/api/v2/intake/plan', { ...request, selectedRoleIds: 'not-an-array' }); assert.equal(malformed.status, 400);
  const draft = await S.call('POST', '/api/v2/intake/projects', request); assert.equal(draft.status, 201, draft.text);
  const unavailable = await S.call('POST', '/api/v2/projects/' + draft.json.project.projectId + '/runs', {}); assert.ok(unavailable.status >= 400);
  const remote = await S.call('POST', '/api/models', { providerId: 'openai', displayName: 'Never called', modelId: 'not-a-real-model', apiKey: 'no-real-key' });
  const id = remote.json.connection.connectionId, calls = f.requests.length;
  const denied = await S.call('POST', '/api/run', { a: id, task: 'Do not call', mode: 'single', approvePaid: true }); assert.equal(denied.status, 402); assert.equal(denied.json.code, 'use_v2_budgeted_run');
  assert.equal((await S.call('POST', '/api/models/' + id + '/test', {})).status, 402);
  assert.equal((await S.call('POST', '/api/models/probe', { providerId: 'openai', modelId: 'fake', apiKey: 'no-real-key' })).status, 402);
  assert.equal(f.requests.length, calls, 'rejected operations issue no model request');
  await f.restart();
  const stored = await f.S.call('GET', '/api/v2/skills'); assert.ok(stored.json.skills.some(s => s.skillId === 'api-check'));
});

test('A connection edited during an in-flight probe cannot inherit the old target success', async t => {
  const f = await fixture(t), S = f.S, id = f.ids[0];
  await S.call('PUT', '/api/models/' + id, { modelId: 'slow-probe' });
  const before = f.requests.length;
  const pending = S.call('POST', '/api/models/' + id + '/test', {});
  for (let i = 0; i < 100 && f.requests.length === before; i++) await H.sleep(5);
  assert.ok(f.requests.length > before, 'old probe really started');
  await S.call('PUT', '/api/models/' + id, { modelId: 'changed-after-probe' });
  const result = await pending;
  assert.equal(result.json.ok, false); assert.equal(result.json.code, 'connection_changed');
  const connection = (await S.call('GET', '/api/models/' + id)).json.connection;
  assert.equal(connection.modelId, 'changed-after-probe'); assert.equal(connection.lastTest, null); assert.equal(connection.status, 'untested');
});
