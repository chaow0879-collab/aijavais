'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const sample = require('./fixtures/ai-draft.cjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
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
  t.after(async () => {
    if (app.child.signalCode) { H.cookies.delete(app.port); fs.rmSync(app.dir, { recursive: true, force: true }); }
    else await app.stop();
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
  });
  const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-draft', displayName: 'Local draft fixture',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, pricingMode: 'paid_api', capabilities: ['reasoning', 'writing'] });
  const connectionId = added.json.connection.connectionId;
  assert.equal((await app.call('POST', '/api/models/' + connectionId + '/test', {})).json.ok, true);
  return { app, calls, connectionId, env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + provider.address().port }, setHang: () => { hang = true; },
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

test('durable draft HTTP: concurrent duplicates, changed payload and real server restart cannot resend a successful ID', async t => {
  const f = await fixture(t), input = { ...f.input, requestId: 'http-durable' };
  const results = await Promise.all([f.app.call('POST', '/api/v2/intake/ai-draft', input), f.app.call('POST', '/api/v2/intake/ai-draft', input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(f.calls.length, 1);
  const changed = await f.app.call('POST', '/api/v2/intake/ai-draft', { ...input, description: 'This is a different team design request.' });
  assert.equal(changed.status, 409); assert.equal(changed.json.code, 'idempotency_key_reused'); assert.equal(changed.json.requestState, 'completed'); assert.ok(changed.json.ledgerId);
  await f.app.kill();
  const restarted = await H.boot({ dir: f.app.dir, env: f.env }); t.after(() => restarted.stop());
  const repeated = await restarted.call('POST', '/api/v2/intake/ai-draft', input);
  assert.equal(repeated.status, 409); assert.equal(repeated.json.code, 'duplicate_request'); assert.equal(f.calls.length, 1);
  assert.equal((await restarted.call('GET', '/api/v2/usage/system')).json.usage.filter(x => x.kind === 'intake_draft').length, 1);
  await restarted.kill();
});

test('durable draft HTTP: actual server SIGKILL after Mock dispatch recovers unknown once, never automatically resends', async t => {
  const f = await fixture(t); f.setHang();
  const input = { ...f.input, requestId: 'http-crash-after-dispatch' };
  const pending = f.app.call('POST', '/api/v2/intake/ai-draft', input).catch(error => ({ interrupted: true, code: error.code }));
  for (let i = 0; i < 100 && !f.calls.length; i++) await H.sleep(5);
  assert.equal(f.calls.length, 1);
  const exit = once(f.app.child, 'exit'); f.app.child.kill('SIGKILL'); await exit;
  assert.equal((await pending).interrupted, true);
  const restarted = await H.boot({ dir: f.app.dir, env: f.env });
  try {
    const duplicate = await restarted.call('POST', '/api/v2/intake/ai-draft', input);
    assert.equal(duplicate.status, 409); assert.equal(duplicate.json.requestState, 'interrupted_unknown');
    const exceptions = (await restarted.call('GET', '/api/v2/usage/system/exceptions')).json.exceptions;
    assert.equal(exceptions.length, 1); assert.equal(exceptions[0].requestId, input.requestId);
    assert.equal(exceptions[0].cost, null); assert.ok(exceptions[0].costUpperBound > 0);
    assert.equal(f.calls.length, 1, 'one actual local Mock HTTP request across server crash/restart');
    assert.equal((await restarted.call('GET', '/api/v2/usage/system')).json.usage.filter(x => x.kind === 'intake_draft').length, 1);
  } finally { await restarted.kill(); }
});

test('durable draft HTTP: reservation insert rollback returns503 and sends no Mock request', async t => {
  const f = await fixture(t), db = new DatabaseSync(path.join(f.app.dir, 'projects.sqlite'));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER deny_http_claim BEFORE INSERT ON model_requests BEGIN SELECT RAISE(ABORT,'MOCK disk write failure'); END;");
  const r = await f.app.call('POST', '/api/v2/intake/ai-draft', { ...f.input, requestId: 'http-no-dispatch' });
  assert.equal(r.status, 503); assert.equal(r.json.requestSent, false); assert.equal(r.json.financiallyComplete, true); assert.equal(f.calls.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM model_requests').get().n, 0);
  assert.equal((await f.app.call('GET', '/api/v2/usage/system')).json.usage.filter(x => x.kind === 'intake_draft').length, 0);
});

test('durable exceptions HTTP: authentication, forced owner isolation, safe fields, readiness warning and no reconciliation writes', async t => {
  const f = await fixture(t); f.setHang();
  const pending = f.app.call('POST', '/api/v2/intake/ai-draft', { ...f.input, requestId: 'http-pending' });
  for (let i = 0; i < 100 && !f.calls.length; i++) await H.sleep(5);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.app.call('GET', '/api/v2/usage/system/exceptions', undefined, { cookie: false })).status, 401);
  const db = new DatabaseSync(path.join(f.app.dir, 'projects.sqlite')); t.after(() => db.close());
  const row = db.prepare('SELECT * FROM model_requests').get();
  const foreign = { ledgerId: 'foreign-ledger', kind: 'intake_draft', requestId: 'other-admin-id', ownerId: 'other-admin', status: 'failed', cost: null,
    prompt: 'PRIVATE-PROMPT-MARKER', apiKey: 'PRIVATE-KEY-MARKER', error: 'PRIVATE-ERROR-MARKER' };
  db.prepare('INSERT INTO system_usage VALUES(?,?,?)').run(foreign.ledgerId, Date.now(), JSON.stringify(foreign));
  const poison = db.prepare('SELECT doc FROM system_usage WHERE id=?').get(row.ledger_id);
  db.prepare('UPDATE system_usage SET doc=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(poison.doc), prompt: foreign.prompt, apiKey: foreign.apiKey, error: foreign.error }), row.ledger_id);
  const r = await f.app.call('GET', '/api/v2/usage/system/exceptions?ownerId=other-admin&limit=20');
  assert.equal(r.status, 200); assert.equal(r.json.readOnly, true); assert.equal(r.json.exceptions.length, 1);
  assert.equal(r.json.exceptions[0].requestId, 'http-pending'); assert.equal(r.json.exceptions[0].requestState, 'dispatching');
  assert.equal(r.json.exceptions[0].cost, null); assert.ok(r.json.exceptions[0].costUpperBound > 0);
  assert.doesNotMatch(r.text, /PRIVATE-|other-admin-id|params_hash|baseUrl/);
  const readiness = await f.app.call('GET', '/api/v2/readiness'); assert.equal(readiness.json.accounting.exceptions.length, 1);
  assert.ok(readiness.json.items.some(x => x.id === 'system-usage-exceptions'));
  const before = db.prepare('SELECT doc FROM system_usage ORDER BY id').all();
  assert.equal((await f.app.call('POST', '/api/v2/usage/system/exceptions', { cost: 0 })).status, 404);
  assert.equal((await f.app.call('POST', '/api/v2/usage/system/' + row.ledger_id + '/reconcile', { cost: 0 })).status, 404);
  assert.deepEqual(db.prepare('SELECT doc FROM system_usage ORDER BY id').all(), before);
  await f.app.call('POST', '/api/v2/intake/ai-draft/cancel', { requestId: 'http-pending' });
  assert.equal((await pending).json.code, 'cancelled'); assert.equal(f.calls.length, 1);
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
