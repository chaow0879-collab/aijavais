'use strict';
// #14 package 3 / #9 P2-03: one end-to-end cost-fact matrix through the REAL
// server (server.js, HTTP, auth/CSRF gates, SQLite). Only the model provider is
// a local MOCK; no vendor is called and no real money is involved. Each row
// cross-checks the HTTP body, the SQLite ledger row and the MOCK call count.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers');
const sample = require('./fixtures/ai-draft.cjs');

async function fixture(t) {
  const state = { mode: 'ok', calls: 0, held: [] };
  const provider = http.createServer((req, res) => {
    let input = ''; req.on('data', c => { input += c; }); req.on('end', () => {
      const body = JSON.parse(input), draft = body.messages.at(-1).content.startsWith('Design a team');
      if (draft) state.calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (draft && state.mode === 'hang') { state.held.push(res); res.write(': pending\n\n'); return; }
      const content = !draft ? '好' : state.mode === 'invalid' ? 'MOCK not JSON' : JSON.stringify(sample());
      const usage = draft && state.mode === 'no_usage' ? '' : 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + '\n\n';
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n' + usage + 'data: [DONE]\n\n');
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const port = provider.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + port } });
  t.after(async () => { await app.stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); });
  const add = async (pricingMode, name) => {
    const r = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-' + name, displayName: name, baseUrl: `http://127.0.0.1:${port}/v1`, pricingMode, capabilities: ['reasoning', 'writing'] });
    const id = r.json.connection.connectionId; assert.equal((await app.call('POST', '/api/models/' + id + '/test', {})).json.ok, true); return id;
  };
  const paid = await add('paid_api', 'paid'), local = await add('local', 'local');
  const input = (requestId, extra = {}) => ({ description: '为跨领域新项目设计适合的岗位和步骤，随后人工编辑确认。', connectionId: paid, approvePaid: true, maxTokens: 32000, maxCost: 1,
    price: { inputPerMillion: 2, outputPerMillion: 4 }, requestId, ...extra });
  const ledger = async () => (await app.call('GET', '/api/v2/usage/system')).json.usage.filter(u => u.kind === 'intake_draft');
  const row = async requestId => (await ledger()).find(u => u.requestId === requestId);
  const db = () => new DatabaseSync(path.join(app.dir, 'projects.sqlite'));
  return { app, state, paid, local, input, ledger, row, db };
}

test('cost facts: HTTP status x body x SQLite ledger x MOCK calls stay consistent across every branch (real server)', async t => {
  const f = await fixture(t), S = f.app, matrix = [];
  const record = async (label, response, requestId, expect) => {
    const r = requestId ? await f.row(requestId) : undefined;
    const entry = { label, status: response.status, code: response.json?.code ?? null, bodyCost: response.json?.usage?.cost ?? (response.json?.usage ? null : 'n/a'),
      bodyFact: response.json?.usage?.billingFact ?? null, rowStatus: r?.status ?? null, rowCost: r ? r.cost ?? null : 'no-row', rowFact: r?.billingFact ?? null, calls: f.state.calls };
    matrix.push(entry);
    for (const [k, v] of Object.entries(expect)) assert.deepEqual(entry[k], v, label + ' ' + k + ' ' + JSON.stringify(entry));
    return entry;
  };
  // 401 / 403: gates before anything else.
  await record('401 no session', await S.call('POST', '/api/v2/intake/ai-draft', f.input('auth-1'), { cookie: false }), 'auth-1', { status: 401, rowCost: 'no-row', calls: 0 });
  await record('403 foreign origin', await S.call('POST', '/api/v2/intake/ai-draft', f.input('auth-2'), { headers: { origin: 'https://untrusted.invalid' } }), 'auth-2', { status: 403, rowCost: 'no-row', calls: 0 });
  // Approval/budget refusals: no request, no ledger row.
  await record('402 unapproved paid', await S.call('POST', '/api/v2/intake/ai-draft', f.input('pre-1', { approvePaid: false })), 'pre-1', { status: 402, code: 'paid_approval_required', rowCost: 'no-row', calls: 0 });
  await record('402 token cap', await S.call('POST', '/api/v2/intake/ai-draft', f.input('pre-2', { maxTokens: 1 })), 'pre-2', { status: 402, code: 'token_budget_exceeded', rowCost: 'no-row', calls: 0 });
  await record('402 zero price', await S.call('POST', '/api/v2/intake/ai-draft', f.input('pre-3', { price: { inputPerMillion: 0, outputPerMillion: 0 } })), 'pre-3', { status: 402, code: 'price_required', rowCost: 'no-row', calls: 0 });
  // Estimate is a bound, not a call and not a bill.
  const est = await S.call('POST', '/api/v2/intake/ai-draft/estimate', f.input('est', { approvePaid: false }));
  assert.equal(est.status, 200); assert.equal(est.json.requestSent, false); assert.ok(est.json.costBound > 0); assert.match(est.json.note, /不是实际账单/); assert.equal(f.state.calls, 0);
  matrix.push({ label: 'estimate (bound only)', status: 200, costBound: est.json.costBound, calls: 0 });
  // Model unavailable.
  assert.equal((await S.call('POST', '/api/models/' + f.paid + '/disable', {})).status, 200);
  await record('409 disabled model', await S.call('POST', '/api/v2/intake/ai-draft', f.input('na-1')), 'na-1', { status: 409, code: 'model_not_ready', rowCost: 'no-row', calls: 0 });
  assert.equal((await S.call('POST', '/api/models/' + f.paid + '/enable', {})).status, 200);
  assert.equal((await S.call('POST', '/api/models/' + f.paid + '/test', {})).json.ok, true);
  // Paid success: user-rate estimate, never a reconciled vendor bill.
  const ok = await S.call('POST', '/api/v2/intake/ai-draft', f.input('paid-ok'));
  await record('200 paid, provider usage x user rates', ok, 'paid-ok', { status: 200, bodyCost: 0.0001, bodyFact: 'user_rate_estimate', rowStatus: 'completed', rowCost: 0.0001, rowFact: 'user_rate_estimate', calls: 1 });
  assert.equal(ok.json.usage.vendorInvoiceReconciled, false); assert.match(ok.json.usage.billingFactText, /未与厂商账单核对/);
  // Local verified loopback target.
  await record('200 local free', await S.call('POST', '/api/v2/intake/ai-draft', f.input('local-ok', { connectionId: f.local, approvePaid: undefined, price: undefined })), 'local-ok',
    { status: 200, bodyCost: 0, bodyFact: 'local_free_zero', rowCost: 0, rowFact: 'local_free_zero', calls: 2 });
  // Provider returned no usage: unknown, never 0; conservative budget kept.
  f.state.mode = 'no_usage';
  const unknown = await S.call('POST', '/api/v2/intake/ai-draft', f.input('no-usage'));
  await record('200 draft, usage unknown', unknown, 'no-usage', { status: 200, bodyCost: null, bodyFact: 'sent_usage_unknown', rowCost: null, rowFact: 'sent_usage_unknown', calls: 3 });
  assert.ok(unknown.json.usage.budgetCost > 0);
  // Invalid model JSON: billed with known usage, manual fallback, nothing saved.
  f.state.mode = 'invalid';
  await record('422 invalid draft (billed)', await S.call('POST', '/api/v2/intake/ai-draft', f.input('invalid')), 'invalid', { status: 422, code: 'invalid_draft', bodyCost: 0.0001, bodyFact: 'user_rate_estimate', rowStatus: 'failed', rowCost: 0.0001, calls: 4 });
  f.state.mode = 'ok';
  // Same ID: same payload / different payload, plus a concurrent burst.
  await record('409 duplicate same payload', await S.call('POST', '/api/v2/intake/ai-draft', f.input('paid-ok')), null, { status: 409, code: 'duplicate_request', calls: 4 });
  await record('409 same ID different payload', await S.call('POST', '/api/v2/intake/ai-draft', f.input('paid-ok', { maxCost: 2 })), null, { status: 409, code: 'idempotency_key_reused', calls: 4 });
  const burst = await Promise.all(Array.from({ length: 5 }, () => S.call('POST', '/api/v2/intake/ai-draft', f.input('burst'))));
  assert.deepEqual(burst.map(r => r.status).sort(), [200, 409, 409, 409, 409]); assert.equal(f.state.calls, 5, 'one dispatch for five concurrent identical clicks');
  matrix.push({ label: 'concurrent x5 same ID', statuses: burst.map(r => r.status).sort(), calls: f.state.calls });
  // Ledger settlement failure after a successful call: HTTP 202, cost unknown, reservation kept, no retry.
  const d = f.db();
  d.exec("CREATE TRIGGER deny_settle BEFORE UPDATE OF state ON model_requests WHEN NEW.state IN ('completed','failed') BEGIN SELECT RAISE(ABORT,'MOCK settlement disk failure'); END;");
  const unsettled = await S.call('POST', '/api/v2/intake/ai-draft', f.input('unsettled'));
  d.exec('DROP TRIGGER deny_settle');
  await record('202 draft ok, ledger unrecorded', unsettled, 'unsettled', { status: 202, code: 'usage_unsettled', bodyCost: null, bodyFact: 'sent_ledger_unrecorded_unknown', rowStatus: 'reserved', calls: 6 });
  assert.equal(unsettled.json.financiallyComplete, false); assert.ok(unsettled.json.usage.unbookedComputedCost > 0);
  // Ledger unavailable before dispatch: 503, nothing sent.
  d.exec("CREATE TRIGGER deny_claim BEFORE INSERT ON model_requests BEGIN SELECT RAISE(ABORT,'MOCK disk full'); END;");
  await record('503 ledger unavailable', await S.call('POST', '/api/v2/intake/ai-draft', f.input('no-ledger')), 'no-ledger', { status: 503, code: 'usage_ledger_unavailable', rowCost: 'no-row', calls: 6 });
  d.exec('DROP TRIGGER deny_claim'); d.close();
  // Capacity: three held calls, fourth refused without a row; cancel = provider really stops (cooperative), cost unknown.
  f.state.mode = 'hang';
  const held = ['hold-1', 'hold-2', 'hold-3'].map(id => S.call('POST', '/api/v2/intake/ai-draft', f.input(id)));
  for (let i = 0; i < 200 && f.state.held.length < 3; i++) await H.sleep(5);
  await record('429 capacity', await S.call('POST', '/api/v2/intake/ai-draft', f.input('hold-4')), 'hold-4', { status: 429, code: 'draft_busy', rowCost: 'no-row', calls: 9 });
  for (const id of ['hold-1', 'hold-2', 'hold-3']) await S.call('POST', '/api/v2/intake/ai-draft/cancel', { requestId: id });
  for (const [i, r] of (await Promise.all(held)).entries()) await record('409 cancelled after dispatch #' + (i + 1), r, 'hold-' + (i + 1), { status: 409, code: 'cancelled', bodyCost: null, bodyFact: 'sent_usage_unknown', rowStatus: 'failed', rowCost: null, calls: 9 });
  f.state.mode = 'ok';
  // Nothing was ever saved or started; exception view is read-only and labels bounds as non-bills.
  assert.equal((await S.call('GET', '/api/v2/projects')).json.projects.length, 0);
  const exceptions = (await S.call('GET', '/api/v2/usage/system/exceptions')).json;
  assert.equal(exceptions.readOnly, true); assert.ok(exceptions.exceptions.every(e => /不等于厂商账单/.test(e.note)));
  assert.ok(exceptions.exceptions.some(e => e.requestId === 'unsettled' && e.cost === null));
  // Every remote row that was sent is either a user-rate estimate or explicitly unknown; none is a silent 0.
  for (const u of await f.ledger()) {
    if (u.connectionId === f.paid && u.requestSent) assert.ok(u.cost === null || u.cost > 0, JSON.stringify(u));
    if (u.status !== 'reserved') assert.equal(u.vendorInvoiceReconciled, false);
  }
  t.diagnostic(JSON.stringify(matrix));
  console.log('COST-FACT MATRIX ' + JSON.stringify(matrix));
});
