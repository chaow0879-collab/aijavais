'use strict';
// B5-1 / B5-2: "my tasks" home, admin-only task summary, root redirect, and the price ceiling fallback.
// Local model fixture only; no paid provider is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const PRICES = require('../lib/prices');
const Plan = require('../public/smart-plan.js');

/* ---------------- B5-2 price fallback (pure) ---------------- */
test('B5-2: official catalog prices for the main models; unknown model of a known platform gets an estimated ceiling >= the highest known price', () => {
  const official = PRICES.resolve({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' });
  assert.deepEqual([official.currency, official.inputPerMillion, official.outputPerMillion, official.basis], ['CNY', 9, 27, undefined]);
  assert.deepEqual([PRICES.resolve({ providerId: 'dashscope', modelId: 'qwen3.8-max' }).inputPerMillion, PRICES.resolve({ providerId: 'dashscope', modelId: 'qwen3.8-max' }).outputPerMillion], [12, 36]);
  for (const providerId of ['deepseek', 'dashscope']) {
    const known = PRICES.CATALOG.prices.filter(p => p.providerId === providerId);
    const est = PRICES.resolve({ providerId, modelId: 'brand-new-model-x' });
    assert.equal(est.basis, 'estimated_ceiling', providerId);
    assert.ok(est.inputPerMillion >= Math.max(...known.map(p => p.inputPerMillion)) && est.outputPerMillion >= Math.max(...known.map(p => p.outputPerMillion)), providerId + ': estimate >= highest known');
    assert.equal(est.inputPerMillion, Math.max(...known.map(p => p.inputPerMillion)) * 2);
  }
  // a platform without any registered price stays unknown and is never called
  for (const providerId of ['moonshot', 'custom', 'openai-compatible', undefined]) assert.equal(PRICES.resolve({ providerId, modelId: 'm' }), null, String(providerId));
  // an administrator-entered price still wins
  assert.equal(PRICES.resolve({ providerId: 'deepseek', modelId: 'x', price: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 } }).source, 'admin');
});

const conn = (connectionId, providerId, providerName, modelId) => ({ connectionId, providerId, providerName, modelId, enabled: true, status: 'available', pricingMode: 'unknown',
  baseUrl: providerId === 'dashscope' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://api.deepseek.com', price: PRICES.resolve({ providerId, modelId }) });
test('B5-2: only deepseek-v4-pro + qwen3.8-max -> simple mode plans directly with a RMB confirmation; new models of known platforms are priced with an honest note', () => {
  const p = Plan.plan({ models: [conn('a', 'deepseek', 'DeepSeek', 'deepseek-v4-pro'), conn('b', 'dashscope', '通义千问', 'qwen3.8-max')], goal: '起草一个任职资格体系的PPT，5页', output: 'ppt', capCny: 5 });
  assert.equal(p.ok, true, JSON.stringify(p.problems));
  assert.match(p.confirmText, /^预计花费约 ¥\d+\.\d{2}，最多不超过 ¥\d+\.\d{2}，超过会自动停下。$/);
  assert.deepEqual(Object.keys(p.approval.prices).sort(), ['a', 'b']); assert.equal(p.approval.approvePaid, true);
  assert.ok(Math.abs(p.approval.prices.a.outputPerMillion - 27 / Plan.FX) < 1e-9, 'official CNY price converted at FX 7.5');
  assert.equal(p.estimatedNote, '', 'official prices need no estimate note');
  const q = Plan.plan({ models: [conn('c', 'deepseek', 'DeepSeek', 'deepseek-v9-preview'), conn('d', 'dashscope', '通义千问', 'qwen3.8-plus')], goal: '写一份方案', capCny: 5 });
  assert.equal(q.ok, true, JSON.stringify(q.problems));
  assert.match(q.estimatedNote, /按偏高的估计价计算，实际花费通常更低/);
  assert.ok(q.approval.prices.c.outputPerMillion >= 27 / Plan.FX && q.approval.prices.d.outputPerMillion >= 36 / Plan.FX, 'estimate is never below the known highest price');
});
test('B5-2: unregistered platforms are still refused, named, and the user is never sent to edit unit prices; no self-contradicting advice', () => {
  const r = Plan.plan({ models: [{ connectionId: 'm', providerId: 'moonshot', providerName: '月之暗面', modelId: 'kimi-k9', enabled: true, status: 'available', pricingMode: 'unknown', price: null }], goal: '写一份方案' });
  assert.equal(r.ok, false); assert.equal(r.problems[0].code, 'no_priced_model');
  assert.match(r.problems[0].text, /月之暗面 · kimi-k9/);
  assert.doesNotMatch(r.problems[0].text, /管理中心|编辑|单价|改用/);
  assert.equal(r.problems[0].fix, undefined, 'no button that sends the user to the admin center');
  const rw = Plan.rework({ models: [], snapshot: { roles: [{ roleId: 'reviewer', connectionId: 'gone' }] }, feedback: '改一下' });
  assert.equal(rw.ok, false); assert.doesNotMatch(rw.problems[0].text, /管理中心/); assert.equal(rw.problems[0].fix, undefined);
});

/* ---------------- B5-1 server: task summary + root redirect ---------------- */
async function fixture(t) {
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const slow = /slow/.test(b);
    const send = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '本地模型的成果文字，足够长足够长足够长足够长。' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); };
    if (slow) setTimeout(send, 1500); else send();
  }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const add = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing'] });
  assert.equal(add.status, 200, add.text); const id = add.json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + id + '/test', {})).json.ok, true);
  return { S, id };
}
const project = (id, name, prompt = '写') => ({ name, description: name + '：写一段文字', roles: [{ roleId: 'w', name: '写手', duty: '写', standard: '可读', connectionId: id }],
  steps: [{ stepId: 's1', roleId: 'w', title: '写出初稿', prompt }, { stepId: 's2', roleId: 'w', title: '定稿', prompt }] });

test('B5-1: GET /api/v2/tasks groups tasks in plain facts; admin only; drafts and finished runs; no model text leaks', async t => {
  const { S, id } = await fixture(t);
  const empty = (await S.call('GET', '/api/v2/tasks')).json;
  assert.deepEqual(empty.counts, { running: 0, review: 0, stopped: 0, done: 0, draft: 0 }); assert.equal(empty.maxConcurrent, 3);
  const draft = (await S.call('POST', '/api/v2/projects', project(id, '草稿任务'))).json.project;
  const done = (await S.call('POST', '/api/v2/projects', project(id, '做完的任务'))).json.project;
  const run = (await S.call('POST', '/api/v2/projects/' + done.projectId + '/runs', { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0, allowedTools: [] }));
  assert.equal(run.status, 202, run.text);
  let summary;
  for (let i = 0; i < 100; i++) { summary = (await S.call('GET', '/api/v2/tasks')).json; if (summary.tasks.find(x => x.projectId === done.projectId).group !== 'running') break; await H.sleep(50); }
  const d = summary.tasks.find(x => x.projectId === draft.projectId), f = summary.tasks.find(x => x.projectId === done.projectId);
  assert.deepEqual([d.group, d.runId, d.stepsTotal], ['draft', null, 2]);
  assert.ok(['review', 'done'].includes(f.group), f.group); assert.equal(f.runId, run.json.run.runId); assert.equal(f.stepsDone, 2); assert.equal(f.stepsTotal, 2); assert.equal(f.downloadable, true);
  assert.equal(summary.counts.draft, 1); assert.equal(summary.counts[f.group], 1);
  assert.ok(!JSON.stringify(summary).includes('本地模型的成果文字'), 'summary never carries model output');
  // admin only: anonymous and read-only display sessions get nothing
  assert.equal((await H.call(S.port, 'GET', '/api/v2/tasks', undefined, { cookie: false })).status, 401);
  const link = (await S.call('POST', '/api/auth/display-link', { label: '大屏', hours: 1 })).json;
  const dc = H.cookieFrom(await H.call(S.port, 'GET', link.path, undefined, { cookie: false }));
  assert.equal((await H.call(S.port, 'GET', '/api/v2/tasks', undefined, { cookie: dc })).status, 403, 'display session cannot list tasks');
  // root: administrator -> my tasks; display session -> the HALOFLUX screen, unchanged
  const root = await S.call('GET', '/');
  assert.equal(root.status, 302); assert.equal(root.headers.location, '/workspace.html');
  const shown = await H.call(S.port, 'GET', '/', undefined, { cookie: dc });
  assert.equal(shown.status, 200); assert.match(shown.text, /HALOFLUX|<canvas|panel/i);
  assert.ok(!shown.text.includes('做完的任务'), 'display screen HTML has no task plaintext');
  const anon = await H.call(S.port, 'GET', '/', undefined, { cookie: false });
  assert.equal(anon.status, 302); assert.match(anon.headers.location, /^\/login\.html/);
  assert.equal((await S.call('GET', '/panel.html')).status, 200, 'the screen stays reachable for the administrator');
});
