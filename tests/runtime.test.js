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
async function boot(localPorts, dir) {
  const port = await freePort();
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-rt-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, LOCAL_MODEL_TARGETS: localPorts.map(p => '127.0.0.1:' + p).join(',') };
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
