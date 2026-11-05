'use strict';
/* 运行时集成测试：并发计数、外部事件真实性、token 隔离、失败与重启持久化。使用本地模拟供应商，不需要任何 API Key。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function call(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
/* 模拟 OpenAI 兼容供应商。behavior(prompt) → { delay, usage:boolean, status, hang } */
function mockProvider(behavior = () => ({})) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      const prompt = j.messages[j.messages.length - 1].content;
      const o = behavior(prompt) || {};
      if (o.status) { res.writeHead(o.status, { 'content-type': 'application/json' }); return res.end('{"error":"boom"}'); }
      if (o.endless) { res.writeHead(200, { 'content-type': 'text/event-stream' }); const iv = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(500) } }] })}\n\n`), 5); res.on('close', () => clearInterval(iv)); return; }
      if (o.multiline) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":\ndata: {"content":"多行事件正常"}}]}\n\n: 心跳\n\ndata: [DONE]\n\n'); return res.end();
      }
      if (o.hang) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); return; }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: o.text || '模拟回复' } }] })}\n\n`);
        if (o.usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      }, o.delay || 0);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
async function boot(localPorts, dir, extraEnv = {}) {
  const port = await freePort();
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-rt-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, LOCAL_MODEL_TARGETS: localPorts.map(p => '127.0.0.1:' + p).join(','), ...extraEnv };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ADMIN_TOKEN']) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await call(port, 'GET', '/api/state')).status === 200) break; } catch { /* 等待 */ } await sleep(100); }
  return { port, dir, child, kill: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}
const addProvider = async (S, label, mockPort) => (await call(S.port, 'POST', '/api/providers', { label, type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-test-' + label + '-abcdefgh', model: 'm' })).json.provider.id;
const state = async S => (await call(S.port, 'GET', '/api/state')).json;
const agentOf = (st, id) => st.agents.find(a => a.id === id);
async function waitRun(S, id, ms = 8000) {
  for (let t = 0; t < ms; t += 100) { const r = (await call(S.port, 'GET', '/api/runs/' + id)).json; if (r.status !== 'running') return r; await sleep(100); }
  throw new Error('任务未在预期时间内结束');
}

test('并发：同一供应商同时跑多个任务，状态按调用实例统计，互不覆盖；token 真实值与估算值分开', async t => {
  const m = await mockProvider(prompt => (prompt.includes('慢') ? { delay: 900, usage: true } : { delay: 100, usage: false }));
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const pid = await addProvider(S, 'P', m.port);
  const slow = (await call(S.port, 'POST', '/api/run', { task: '慢任务', a: pid, mode: 'single' })).json.runId;
  const fast = (await call(S.port, 'POST', '/api/run', { task: '快任务', a: pid, mode: 'single' })).json.runId;
  await sleep(450); // 快任务已结束，慢任务仍在飞
  assert.equal((await call(S.port, 'GET', '/api/runs/' + fast)).json.status, 'done');
  let st = await state(S);
  assert.equal(agentOf(st, pid).status, 'working', '仍有一个调用在进行，不能被先结束的任务置为 idle');
  const slowRun = await waitRun(S, slow);
  assert.equal(slowRun.status, 'done');
  await sleep(100);
  st = await state(S);
  assert.equal(agentOf(st, pid).status, 'idle');
  assert.equal(st.totals.calls, 2);
  assert.equal(st.totals.tokens, 30, '只有厂商返回的用量计入真实 tokens');
  assert.ok(st.totals.estimatedTokens > 0, '没有 usage 的调用只计入估算值');
  assert.equal(agentOf(st, pid).tokens, 30);
  assert.ok(agentOf(st, pid).estimatedTokens > 0);
  assert.equal(st.totals.errors, 0);
});

test('外部事件不能冒充真实模型调用，也不进入真实统计；clientEventId 去重', async t => {
  const m = await mockProvider();
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const pid = await addProvider(S, 'Real', m.port);
  const post = b => call(S.port, 'POST', '/api/event', b);
  assert.equal((await post({ agent: pid, status: 'start' })).status, 400, '外部事件不能使用供应商 ID');
  assert.equal((await post({ agent: 'demo-claude', status: 'start' })).status, 400, '外部事件不能使用 demo- 前缀');
  assert.equal((await post({ agent: 'hook-a', eventType: 'model_stream', status: 'done' })).status, 400, 'status 与 eventType 冲突');
  const a = await post({ agent: 'hook-a', status: 'start', clientEventId: 'c-1' });
  assert.equal(a.status, 200);
  const dup = await post({ agent: 'hook-a', status: 'start', clientEventId: 'c-1' });
  assert.equal(dup.json.duplicate, true); assert.equal(dup.json.eventId, a.json.eventId);
  assert.equal((await post({ agent: 'hook-a', status: 'start', clientEventId: '../bad' })).status, 400);
  await post({ agent: 'hook-a', status: 'done', tokens: 500 });
  const st = await state(S);
  assert.equal(st.totals.calls, 0, '外部上报不计入真实调用数');
  assert.equal(st.totals.tokens, 0, '外部上报不计入真实 tokens');
  assert.equal(st.totals.reportedEvents, 2, '重复事件只计一次');
  const ag = agentOf(st, 'hook-a');
  assert.equal(ag.source, 'external'); assert.equal(ag.verification, 'reported'); assert.equal(ag.calls, 1);
  // 演示：不进入真实统计
  await call(S.port, 'POST', '/api/demo', { seconds: 6 });
  await sleep(700);
  const st2 = await state(S);
  assert.equal(st2.totals.calls, 0); assert.equal(st2.totals.tokens, 0); assert.ok(st2.totals.simulatedEvents > 0);
  assert.equal(agentOf(st2, 'demo-claude').verification, 'simulated');
});

test('失败路径：供应商报错 → model_error + 任务 error + 立即落盘；脱敏', async t => {
  const m = await mockProvider(() => ({ status: 500 }));
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const pid = await addProvider(S, 'Bad', m.port);
  const id = (await call(S.port, 'POST', '/api/run', { task: '会失败', a: pid, mode: 'single' })).json.runId;
  const run = await waitRun(S, id);
  assert.equal(run.status, 'error'); assert.match(run.error, /HTTP 500/);
  assert.ok(run.endedAt);
  assert.ok(!JSON.stringify(run).includes('sk-test-Bad-abcdefgh'));
  const types = run.events.map(e => e.eventType);
  assert.deepEqual(types.filter(x => x !== 'model_stream'), ['task_start', 'model_start', 'model_error', 'task_error']);
  const me = run.events.find(e => e.eventType === 'model_error');
  assert.equal(me.status, 'error'); assert.equal(me.source, 'server'); assert.equal(me.verification, 'observed'); assert.ok(me.spanId && me.runId === run.runId);
  const st = await state(S);
  assert.equal(st.totals.errors, 1); assert.equal(agentOf(st, pid).status, 'error');
  // 任务结束后立即落盘，无需等待防抖定时器
  const disk = JSON.parse(fs.readFileSync(path.join(S.dir, 'tasks.json'), 'utf8'));
  assert.equal(disk.find(x => x.id === id).status, 'error');
});

test('重启：运行中的任务在停止时标记为 interrupted 并落盘，重启后可查询', async t => {
  const m = await mockProvider(() => ({ hang: true }));
  let S = await boot([m.port]);
  t.after(async () => { try { await S.kill(); } catch { /* 已退出 */ } m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const pid = await addProvider(S, 'Hang', m.port);
  const id = (await call(S.port, 'POST', '/api/run', { task: '会挂住', a: pid, mode: 'single' })).json.runId;
  await sleep(400);
  assert.equal((await call(S.port, 'GET', '/api/runs/' + id)).json.status, 'running');
  await S.kill();
  const disk = JSON.parse(fs.readFileSync(path.join(S.dir, 'tasks.json'), 'utf8'));
  assert.equal(disk.find(x => x.id === id).status, 'interrupted');
  S = await boot([m.port], S.dir);
  const r = (await call(S.port, 'GET', '/api/runs/' + id)).json;
  assert.equal(r.status, 'interrupted'); assert.ok(r.error);
});

test('A→B→A 经消息总线：消息状态、线程、回复关系、投递驱动 handoff、任务间隔离', async t => {
  const seen = [];
  const m = await mockProvider(prompt => { seen.push(prompt); return { text: prompt.includes('待审核输出') ? '审核意见X' : '草稿Y', usage: true }; });
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const a = await addProvider(S, 'A', m.port), b = await addProvider(S, 'B', m.port);
  const id = (await call(S.port, 'POST', '/api/run', { task: '协作任务一', a, b, mode: 'full' })).json.runId;
  const id2 = (await call(S.port, 'POST', '/api/run', { task: '协作任务二', a, b, mode: 'single' })).json.runId;
  const run = await waitRun(S, id); await waitRun(S, id2);
  assert.equal(run.status, 'done');
  assert.ok(seen.some(p => p.includes('待审核输出') && p.includes('草稿Y')), 'B 收到的是 A 的草稿');
  assert.ok(seen.some(p => p.includes('审核意见') && p.includes('审核意见X')), 'A 修订时收到 B 的审核意见');

  const { json: bm } = await call(S.port, 'GET', `/api/runs/${id}/messages`);
  assert.deepEqual(bm.messages.map(x => [x.from === a ? 'A' : x.from === b ? 'B' : x.from, x.type, x.status]),
    [['user', 'request', 'consumed'], ['A', 'proposal', 'consumed'], ['B', 'review', 'consumed'], ['A', 'revision', 'consumed']]);
  assert.equal(new Set(bm.messages.map(x => x.threadId)).size, 1, '同一线程');
  assert.equal(bm.messages[2].replyTo, bm.messages[1].messageId);
  assert.ok(bm.messages.every(x => x.taskId === id && x.runId === run.runId));
  assert.equal(bm.stats.state, 'completed');
  // 另一个任务的消息互不可见
  const other = (await call(S.port, 'GET', `/api/runs/${id2}/messages`)).json;
  assert.equal(other.messages.length, 2);
  assert.ok(other.messages.every(x => x.taskId === id2));
  assert.equal((await call(S.port, 'GET', '/api/runs/nope/messages')).status, 404);

  // handoff 事件由消息投递驱动，并带 messageId
  const handoffs = run.events.filter(e => e.eventType === 'handoff');
  assert.equal(handoffs.length, 2);
  const mids = new Set(bm.messages.map(x => x.messageId));
  assert.ok(handoffs.every(h => mids.has(h.metadata.messageId) && h.source === 'server'));
  assert.deepEqual(handoffs.map(h => h.metadata.messageType), ['proposal', 'review']);
  assert.equal(run.messageStats.total, 4); assert.ok(!fs.readFileSync(path.join(S.dir, 'tasks.json'), 'utf8').includes('threadId'), '消息信封不落盘（只保存统计）');
});

test('消息总线：失败时在途消息标记 failed、任务终止后不再接收；同一供应商自审走直连 handoff', async t => {
  let n = 0;
  const m = await mockProvider(() => (++n === 2 ? { status: 500 } : { text: '内容', usage: true }));
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const a = await addProvider(S, 'A', m.port), b = await addProvider(S, 'B', m.port);
  const id = (await call(S.port, 'POST', '/api/run', { task: '审核会失败', a, b, mode: 'full' })).json.runId;
  const run = await waitRun(S, id);
  assert.equal(run.status, 'error');
  const bm = (await call(S.port, 'GET', `/api/runs/${id}/messages`)).json;
  assert.equal(bm.stats.state, 'failed');
  const proposal = bm.messages.find(x => x.type === 'proposal');
  assert.ok(['consumed', 'failed'].includes(proposal.status));
  assert.ok(!bm.messages.some(x => x.type === 'review' || x.type === 'revision'), '失败后不再产生后续消息');

  const id2 = (await call(S.port, 'POST', '/api/run', { task: '自审', a, b: a, mode: 'review' })).json.runId;
  const r2 = await waitRun(S, id2);
  assert.equal(r2.status, 'done');
  assert.equal(r2.events.filter(e => e.eventType === 'handoff').length, 1);
  assert.equal((await call(S.port, 'GET', `/api/runs/${id2}/messages`)).json.messages.length, 0, '同一供应商不走消息总线');
});

test('超时 / 流量上限 / 多行 SSE / 客户端断开：失败路径不泄漏状态', async t => {
  const m = await mockProvider(p => (p.includes('挂住') ? { hang: true } : p.includes('无限') ? { endless: true } : p.includes('多行') ? { multiline: true } : {}));
  const S = await boot([m.port], undefined, { AIJ_TEST_TIMEOUT_MS: '700', AIJ_TEST_MAX_CALL_BYTES: '6000' });
  t.after(async () => { await S.kill(); m.srv.close(); m.srv.closeAllConnections(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const pid = await addProvider(S, 'T', m.port);
  const run = async task => waitRun(S, (await call(S.port, 'POST', '/api/run', { task, a: pid, mode: 'single' })).json.runId, 6000);

  const hung = await run('挂住的请求');
  assert.equal(hung.status, 'error'); assert.match(hung.error, /超时/);
  assert.ok(hung.events.some(e => e.eventType === 'model_error'));
  const big = await run('无限输出');
  assert.equal(big.status, 'error'); assert.match(big.error, /上限/);
  const ml = await run('多行事件');
  assert.equal(ml.status, 'done', ml.error);
  assert.equal(ml.steps[0].text, '多行事件正常', '多行 data 合并后正确解析');

  await sleep(100);
  const st = await state(S);
  assert.equal(agentOf(st, pid).active, undefined, '快照不暴露内部字段');
  assert.equal(agentOf(st, pid).status, 'idle', '失败后不残留 working');
  assert.equal(st.totals.errors, 2);

  // 客户端中途断开 SSE 不影响服务
  await new Promise(r => { const rq = http.get({ host: '127.0.0.1', port: S.port, path: '/api/events' }, res => { res.once('data', () => { rq.destroy(); r(); }); }); });
  assert.equal((await call(S.port, 'POST', '/api/event', { agent: 'after-disconnect', status: 'info' })).status, 200);
  assert.equal((await call(S.port, 'GET', '/api/state')).status, 200);
});
