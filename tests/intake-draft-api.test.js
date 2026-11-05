'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const sample = require('./fixtures/ai-draft.cjs');
async function fixture(t) {
  const calls = []; let hang = false;
  const provider = http.createServer((req, res) => {
    let input = ''; req.on('data', c => input += c); req.on('end', () => {
      const body = JSON.parse(input), prompt = body.messages.at(-1).content;
      const draft = prompt.startsWith('Design a team');
      if (draft) calls.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (draft && hang) { res.write(': pending\n\n'); return; }
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: draft ? JSON.stringify(sample()) : '好' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + provider.address().port } });
  t.after(async () => { await app.stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); });
  const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-draft', displayName: 'Local draft fixture',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, pricingMode: 'paid_api', capabilities: ['reasoning', 'writing'] });
  const connectionId = added.json.connection.connectionId;
  assert.equal((await app.call('POST', '/api/models/' + connectionId + '/test', {})).json.ok, true);
  return { app, calls, connectionId, setHang: () => { hang = true; },
    input: { description: '为跨领域新项目设计适合的岗位和步骤，随后人工编辑确认。', connectionId, approvePaid: true, maxTokens: 32000, maxCost: 1, price: { inputPerMillion: 2, outputPerMillion: 4 } } };
}
test('draft HTTP: admin/CSRF gates, free estimate, consent, actual mock call and manual edited save', async t => {
  const f = await fixture(t), S = f.app;
  assert.equal((await S.call('POST', '/api/v2/intake/ai-draft', f.input, { cookie: false })).status, 401);
  assert.equal((await S.call('POST', '/api/v2/intake/ai-draft', f.input, { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  const estimate = await S.call('POST', '/api/v2/intake/ai-draft/estimate', { ...f.input, approvePaid: false });
  assert.equal(estimate.status, 200); assert.equal(estimate.json.requestSent, false); assert.ok(estimate.json.costBound > 0);
  const denied = await S.call('POST', '/api/v2/intake/ai-draft', { ...f.input, approvePaid: false }); assert.equal(denied.status, 402); assert.equal(f.calls.length, 0);
  assert.equal((await S.call('POST', '/api/v2/intake/ai-draft', { ...f.input, maxTokens: 1 })).status, 402); assert.equal(f.calls.length, 0);
  const r = await S.call('POST', '/api/v2/intake/ai-draft', f.input); assert.equal(r.status, 200, r.text); assert.equal(r.json.usageRecorded, true); assert.equal(f.calls.length, 1);
  assert.equal((await S.call('GET', '/api/v2/projects')).json.projects.length, 0, 'proposal never auto-saves');
  const usage = (await S.call('GET', '/api/v2/usage/system')).json.usage.filter(x => x.kind === 'intake_draft');
  assert.equal(usage.length, 1); assert.equal(usage[0].status, 'completed'); assert.equal(usage[0].tokens, 30); assert.equal(usage[0].cost, 0.0001);
  const edited = r.json.draft; edited.name = '人工编辑后的名称'; edited.roles[0].name = '人工编辑后的岗位'; edited.roles[0].connectionId = f.connectionId;
  const saved = await S.call('POST', '/api/v2/projects', edited); assert.equal(saved.status, 201, saved.text);
  const project = (await S.call('GET', '/api/v2/projects/' + saved.json.project.projectId)).json;
  assert.equal(project.project.name, edited.name); assert.equal(project.project.roles[0].name, edited.roles[0].name); assert.ok(project.project.planning.humanDecisions.length);
  assert.deepEqual(project.runs, []); assert.equal(f.calls.length, 1, 'saving never calls a model');
});
test('draft HTTP: explicit cancel aborts an in-flight local protocol call and records failure once', async t => {
  const f = await fixture(t); f.setHang();
  const requestId = 'http-user-cancel';
  const pending = f.app.call('POST', '/api/v2/intake/ai-draft', { ...f.input, requestId });
  for (let i = 0; i < 100 && !f.calls.length; i++) await H.sleep(5);
  assert.equal(f.calls.length, 1);
  const cancel = await f.app.call('POST', '/api/v2/intake/ai-draft/cancel', { requestId }); assert.equal(cancel.status, 202);
  const result = await pending; assert.equal(result.json.code, 'cancelled'); assert.equal(result.json.fallback, 'manual'); assert.equal(result.json.usage.cost, null);
  const ledger = (await f.app.call('GET', '/api/v2/usage/system')).json.usage.filter(x => x.kind === 'intake_draft');
  assert.equal(ledger.length, 1); assert.equal(ledger[0].status, 'failed'); assert.equal(ledger[0].cost, null);
  assert.equal((await f.app.call('GET', '/api/v2/projects')).json.projects.length, 0);
});
