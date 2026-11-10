'use strict';
// B1/E4 regressions for reasoning ("thinking") models. MOCK provider only: no real model, no Secrets.
// Real-provider facts these tests encode were measured on 2026-11-10 (see lib/reasoning.js header):
// DashScope max_tokens excludes thinking (uncapped unless thinking_budget is sent); DeepSeek max_tokens
// includes reasoning and can end with finish_reason "length" and an empty answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const R = require('../lib/reasoning');
const BUDGET = require('../lib/budget');

test('reasoning: DashScope keeps the full answer cap, adds thinking_budget, and the budget reserves both (AUD-FE6C-02)', () => {
  for (const host of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'ws1.dashscope.aliyuncs.com']) {
    for (const cap of [2, 600, 2048, 8192]) {
      const url = `https://${host}/compatible-mode/v1`, body = { model: 'qwen3.8-flash', max_tokens: cap };
      assert.equal(R.shapeOpenAIBody(url, body, cap), 'dashscope-thinking-budget');
      assert.equal(body.max_tokens, cap, 'answer cap is never reduced (non-thinking models keep the full cap)');
      assert.equal(body.thinking_budget, Math.floor(cap / 2));
      assert.equal(R.outputBound(url, cap), cap + Math.floor(cap / 2), 'reservation covers answer + thinking');
    }
  }
  const tiny = { max_tokens: 1 };
  R.shapeOpenAIBody('https://dashscope.aliyuncs.com/compatible-mode/v1', tiny, 1);
  assert.deepEqual(tiny, { max_tokens: 1, enable_thinking: false }, 'no room to think: thinking is disabled');
  assert.equal(R.outputBound('https://dashscope.aliyuncs.com/compatible-mode/v1', 1), 1);
  assert.equal(R.outputBound('https://api.deepseek.com', 600), 600, 'DeepSeek max_tokens already includes reasoning');
});
test('reasoning: budget reservation uses the profile bound, so a DashScope call costs more to reserve', () => {
  const conn = baseUrl => ({ connectionId: 'c', baseUrl, modelId: 'm', protocol: 'openai', pricingMode: 'unknown' });
  const reserve = baseUrl => {
    const approval = BUDGET.authorizeModels({ connections: [conn(baseUrl)], input: { approvePaid: true, maxCost: 1, maxOutputTokens: 600, prices: { c: { inputPerMillion: 2, outputPerMillion: 8 } } } });
    return BUDGET.reserveCall({ approval, usage: BUDGET.initialUsage(), connection: conn(baseUrl), system: 's', prompt: 'p' }).reservation;
  };
  assert.equal(reserve('https://dashscope.aliyuncs.com/compatible-mode/v1').outputTokensBound, 900);
  assert.equal(reserve('https://api.deepseek.com').outputTokensBound, 600);
});
test('reasoning: other and look-alike hosts are left unchanged', () => {
  for (const url of ['https://api.deepseek.com', 'https://api.openai.com/v1', 'http://127.0.0.1:9/v1', 'https://dashscope.aliyuncs.com.evil.example/v1', 'https://evildashscope.aliyuncs.com/v1', 'not a url']) {
    const body = { model: 'm', max_tokens: 100 };
    assert.equal(R.shapeOpenAIBody(url, body, 100), null, url);
    assert.deepEqual(body, { model: 'm', max_tokens: 100 }, url);
  }
});
test('reasoning: usage parser reads completion_tokens_details.reasoning_tokens only when valid', () => {
  assert.equal(R.reasoningTokens({ completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } }), 60);
  for (const u of [undefined, {}, { completion_tokens_details: {} }, { completion_tokens_details: { reasoning_tokens: -1 } }, { completion_tokens_details: { reasoning_tokens: 1.5 } }, { completion_tokens_details: { reasoning_tokens: '9' } }])
    assert.equal(R.reasoningTokens(u), undefined, JSON.stringify(u));
});
test('reasoning: ledger records reasoning tokens as a subset of output tokens; cost is unchanged', () => {
  const approval = BUDGET.authorizeModels({ connections: [{ connectionId: 'c', baseUrl: 'https://api.deepseek.com', modelId: 'm', protocol: 'openai', pricingMode: 'unknown' }],
    input: { approvePaid: true, maxCost: 1, prices: { c: { inputPerMillion: 2, outputPerMillion: 8 } } } });
  const { reservation, usage } = BUDGET.reserveCall({ approval, usage: BUDGET.initialUsage(), connection: { connectionId: 'c', ...approval.targets.c }, system: 's', prompt: 'p' });
  const settle = result => BUDGET.settleCall({ usage, connectionId: 'c', roleId: 'r', reservation, result });
  const base = { tokens: 130, inTokens: 30, outTokens: 100 };
  const withR = settle({ ...base, reasoningTokens: 60 }), without = settle(base);
  assert.equal(withR.entry.reasoningTokens, 60);
  assert.equal(withR.entry.cost, without.entry.cost, 'reasoning tokens are already billed inside output tokens');
  assert.equal(withR.usage.usedTokens, 130);
  assert.equal(settle({ ...base, reasoningTokens: 101 }).entry.reasoningTokens, undefined, 'more reasoning than output is not trusted');
  assert.equal('reasoningTokens' in without.entry, false);
});

/* ---------------- full HTTP path: real server.js adapter + V2 engine against a MOCK reasoning provider ---------------- */
async function world(t, opts = {}) {
  const requests = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body); requests.push(input);
      const exhaust = input.messages.some(m => String(m.content).includes('EXHAUST_REASONING'));
      const over = /THINK_OVER_(\d+)/.exec(input.messages.map(m => m.content).join(' '));
      const frames = [{ choices: [{ delta: { reasoning_content: 'MOCK hidden reasoning '.repeat(5) } }] }];
      if (!exhaust) frames.push({ choices: [{ delta: { content: 'MOCK visible answer for ' + input.model } }] });
      frames.push({ choices: [{ delta: {}, finish_reason: exhaust ? 'length' : 'stop' }] });
      const completion = over ? Number(over[1]) : exhaust ? input.max_tokens : 45;
      frames.push({ choices: [], usage: { prompt_tokens: 20, completion_tokens: completion, completion_tokens_details: { reasoning_tokens: over ? completion - 15 : exhaust ? input.max_tokens : 30 } } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port, ...(opts.dashscopeProfile ? { AIJ_TEST_REASONING_HOSTS: '127.0.0.1' } : {}) } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const c = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: 'reasoner', displayName: 'reasoner', pricingMode: 'local', capabilities: ['writing'] });
  assert.equal(c.status, 200, c.text); const id = c.json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + id + '/test', {})).json.ok, true, 'connection test passes even though reasoning precedes the answer');
  const run = async prompt => {
    const p = await S.call('POST', '/api/v2/projects', { name: 'Reasoning', description: 'Reasoning model regression',
      roles: [{ roleId: 'writer', name: 'Writer', duty: 'Write', connectionId: id }], steps: [{ stepId: 'w', roleId: 'writer', title: 'Write', prompt }] });
    assert.equal(p.status, 201, p.text);
    const s = await S.call('POST', '/api/v2/projects/' + p.json.project.projectId + '/runs', { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0 });
    assert.equal(s.status, 202, s.text);
    for (let i = 0; i < 100; i++) { const r = (await S.call('GET', '/api/v2/runs/' + s.json.run.runId)).json.run; if (!r.executionActive && r.status !== 'running') return r; await H.sleep(50); }
    throw new Error('run did not settle');
  };
  return { S, requests, run };
}
test('reasoning E2E: answer excludes reasoning text and the ledger records provider reasoning tokens', async t => {
  const w = await world(t), r = await w.run('Write one line.');
  assert.equal(r.status, 'review_required', JSON.stringify(r.steps));
  assert.equal(r.steps[0].output, 'MOCK visible answer for reasoner');
  const e = r.usageLedger.at(-1);
  assert.deepEqual([e.inputTokens, e.outputTokens, e.reasoningTokens, e.tokenSource], [20, 45, 30, 'provider']);
  assert.ok(w.requests.every(q => q.thinking_budget === undefined && q.enable_thinking === undefined), 'non-DashScope hosts get no thinking parameters');
});
test('reasoning E2E: reasoning that exhausts the cap with an empty answer fails explicitly and still settles real usage', async t => {
  const w = await world(t), r = await w.run('EXHAUST_REASONING then answer.');
  assert.equal(r.status, 'failed');
  assert.match(r.steps[0].error, /finish_reason=length/);
  const e = r.usageLedger.at(-1);
  assert.equal(e.failed, true);
  assert.deepEqual([e.inputTokens, e.outputTokens, e.reasoningTokens, e.tokenSource], [20, 100, 100, 'provider']);
});
test('AUD-FE6C-01 E2E: the DashScope profile is wired into the real adapter and the reservation covers thinking', async t => {
  const w = await world(t, { dashscopeProfile: true });
  // cap 100 -> request must carry max_tokens 100 + thinking_budget 50; 140 completion tokens fit the 150 reservation
  const ok = await w.run('Write one line. THINK_OVER_140');
  assert.equal(ok.status, 'review_required', JSON.stringify(ok.steps));
  const q = w.requests.find(r => r.messages.some(m => String(m.content).includes('THINK_OVER_140')));
  assert.equal(q.max_tokens, 100, 'answer keeps the full approved cap');
  assert.equal(q.thinking_budget, 50, 'thinking_budget is sent (fails if the server.js wiring is removed)');
  assert.equal(ok.usageLedger.at(-1).outputTokens, 140);
  // beyond answer + thinking (150) the provider overran the reservation: the workflow stops
  const bad = await w.run('Write one line. THINK_OVER_160');
  assert.equal(bad.status, 'failed');
  assert.match(bad.steps[0].error, /exceeded the conservative reservation/);
});
