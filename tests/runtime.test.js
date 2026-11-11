'use strict';
/* 运行时集成测试：并发计数、外部事件真实性、token 隔离、失败与重启持久化。使用本地模拟供应商，不需要任何 API Key。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = H.call;
/* 模拟 OpenAI 兼容供应商。behavior(prompt) → { delay, usage:boolean, status, hang } */
function mockProvider(behavior = () => ({})) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      const prompt = j.messages[j.messages.length - 1].content;
      const o = behavior(prompt) || {};
      if (o.status) { res.writeHead(o.status, { 'content-type': 'application/json' }); return res.end('{"error":"boom"}'); }
      if (o.endless) { res.writeHead(200, { 'content-type': 'text/event-stream' }); const iv = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(500) } }] })}\n\n`), 5); res.on('close', () => clearInterval(iv)); return; }
      if (o.multiline) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":\ndata: {"content":"多行事件正常"}}]}\n\n: 心跳\n\ndata: [DONE]\n\n'); return res.end();
      }
      if (o.partialDrop) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分输出'.repeat(20) } }] })}\n\n`); return setTimeout(() => res.destroy(), 50); }
      if (o.zeroUsage) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`); return res.end(); }
      if (o.hang) { o.onReq && o.onReq(req, res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); return; }
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
  return H.boot({ dir, env: { LOCAL_MODEL_TARGETS: localPorts.map(p => '127.0.0.1:' + p).join(','), ...extraEnv } });
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

test('A→B→A 经消息总线：岗位实例、线程、回复关系、投递驱动 handoff、任务间隔离', async t => {
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

  // 岗位实例：每个岗位独立的 agentInstanceId，并记录执行时的模型连接
  assert.deepEqual(run.agents.map(x => [x.roleId, x.connectionId]), [['drafter', a], ['reviewer', b]]);
  const role = Object.fromEntries(run.agents.map(x => [x.instanceId, x.roleId]));
  const { json: bm } = await call(S.port, 'GET', `/api/runs/${id}/messages`);
  assert.deepEqual(bm.messages.map(x => [role[x.from] || x.from, x.type, x.status]),
    [['user', 'request', 'consumed'], ['drafter', 'proposal', 'consumed'], ['reviewer', 'review', 'consumed'], ['drafter', 'revision', 'consumed']]);
  assert.equal(new Set(bm.messages.map(x => x.threadId)).size, 1, '同一线程');
  assert.equal(bm.messages[2].replyTo, bm.messages[1].messageId);
  assert.ok(bm.messages.every(x => x.taskId === id && x.runId === run.runId));
  assert.equal(bm.stats.state, 'completed');
  assert.ok(run.steps.every(st => st.agentInstanceId && st.roleId && st.connectionId && st.model), '步骤记录岗位实例与模型');
  // 另一个任务的消息互不可见
  const other = (await call(S.port, 'GET', `/api/runs/${id2}/messages`)).json;
  assert.equal(other.messages.length, 2);
  assert.ok(other.messages.every(x => x.taskId === id2));
  assert.equal((await call(S.port, 'GET', '/api/runs/nope/messages')).status, 404);

  // handoff 事件由消息投递驱动：agentId 是模型连接，agentInstanceId / roleId 区分岗位
  const handoffs = run.events.filter(e => e.eventType === 'handoff');
  assert.equal(handoffs.length, 2);
  const mids = new Set(bm.messages.map(x => x.messageId));
  assert.ok(handoffs.every(h => mids.has(h.metadata.messageId) && h.source === 'server'));
  assert.deepEqual(handoffs.map(h => [h.agentId, h.to, h.roleId, h.metadata.toRoleId]), [[a, b, 'drafter', 'reviewer'], [b, a, 'reviewer', 'drafter']]);
  assert.ok(run.events.filter(e => e.eventType === 'model_start').every(e => e.agentInstanceId && e.roleId));
  assert.equal(run.messageStats.total, 4);
  assert.ok(!fs.readFileSync(path.join(S.dir, 'tasks.json'), 'utf8').includes('threadId'), '消息信封不落盘（只保存统计）');
});

test('同一个模型连接承担起草与审核两个岗位：照样走消息总线；失败时在途消息标记 failed', async t => {
  let n = 0;
  const m = await mockProvider(p => (p.includes('会失败') && ++n === 2 ? { status: 500 } : { text: p.includes('待审核输出') ? '审核意见Z' : '草稿W', usage: true }));
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const a = await addProvider(S, 'Solo', m.port);
  const id = (await call(S.port, 'POST', '/api/run', { task: '一个模型两个岗位', a, b: a, mode: 'full' })).json.runId;
  const run = await waitRun(S, id);
  assert.equal(run.status, 'done', run.error);
  assert.equal(run.agents.length, 2);
  assert.notEqual(run.agents[0].instanceId, run.agents[1].instanceId, '同一模型的两个岗位是两个独立实例');
  assert.ok(run.agents.every(x => x.connectionId === a));
  const bm = (await call(S.port, 'GET', `/api/runs/${id}/messages`)).json;
  assert.equal(bm.messages.length, 4, '同模型多岗位同样经过消息总线');
  assert.equal(bm.messages[1].from, run.agents[0].instanceId); assert.equal(bm.messages[1].to, run.agents[1].instanceId);
  const h = run.events.filter(e => e.eventType === 'handoff');
  assert.equal(h.length, 2); assert.ok(h.every(x => x.agentId === a && x.to === a));
  assert.deepEqual(h.map(x => x.roleId), ['drafter', 'reviewer']);

  const b = await addProvider(S, 'B2', m.port);
  const fid = (await call(S.port, 'POST', '/api/run', { task: '审核会失败', a, b, mode: 'full' })).json.runId;
  const fr = await waitRun(S, fid);
  assert.equal(fr.status, 'error'); assert.equal(fr.errorCode, 'model_error');
  const fm = (await call(S.port, 'GET', `/api/runs/${fid}/messages`)).json;
  assert.equal(fm.stats.state, 'failed');
  assert.ok(['consumed', 'failed'].includes(fm.messages.find(x => x.type === 'proposal').status));
  assert.ok(!fm.messages.some(x => x.type === 'review' || x.type === 'revision'), '失败后不再产生后续消息');
});

test('长内容不截断：长输入 / 长草稿 / 长审核意见经成果引用完整传递；超上限明确拒绝', async t => {
  const longDraft = '草'.repeat(30000) + '【草稿结尾标记】';
  const longReview = '审'.repeat(25000) + '【审核结尾标记】';
  const prompts = [];
  const m = await mockProvider(p => { prompts.push(p); return { text: p.includes('审核意见】') ? '终稿' : p.includes('待审核输出') ? longReview : longDraft, usage: true }; });
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const a = await addProvider(S, 'LA', m.port), b = await addProvider(S, 'LB', m.port);
  const longTask = '任'.repeat(50000) + '【任务结尾标记】';
  const id = (await call(S.port, 'POST', '/api/run', { task: longTask, a, b, mode: 'full' })).json.runId;
  const run = await waitRun(S, id, 15000);
  assert.equal(run.status, 'done', run.error);
  assert.ok(prompts[0].endsWith('【任务结尾标记】') && prompts[0].length === longTask.length, '起草方收到完整的长输入');
  assert.ok(prompts[1].includes('【草稿结尾标记】') && prompts[1].includes('草'.repeat(30000)), '审核方收到完整的长草稿');
  assert.ok(prompts[2].includes('【审核结尾标记】') && prompts[2].includes('审'.repeat(25000)), '修订方收到完整的长审核意见');
  const bm = (await call(S.port, 'GET', `/api/runs/${id}/messages`)).json;
  const withRef = bm.messages.filter(x => x.artifactRefs.length);
  assert.deepEqual(withRef.map(x => x.type), ['request', 'proposal', 'review'], '超长消息全部改走成果引用');
  assert.ok(withRef.every(x => x.content.text.length < 3000 && x.metadata.fullTextArtifact === x.artifactRefs[0].artifactId));
  const arts = (await call(S.port, 'GET', `/api/runs/${id}/artifacts`)).json.artifacts;
  assert.equal(arts.length, 3); assert.ok(arts.every(x => !('text' in x)), '列表不含正文');
  const full = (await call(S.port, 'GET', `/api/runs/${id}/artifacts/${withRef[1].artifactRefs[0].artifactId}`)).json;
  assert.equal(full.text, longDraft);
  assert.equal((await call(S.port, 'GET', `/api/runs/${id}/artifacts/art_000000000000`)).status, 404);
  // 超过输入上限：直接拒绝，不截断
  const tooLong = await call(S.port, 'POST', '/api/run', { task: 'x'.repeat(200001), a, mode: 'single' });
  assert.equal(tooLong.status, 400); assert.match(tooLong.json.error, /不会自动截断/);
});

test('模型停用 / 删除：不接新任务；运行中任务在下一步前明确停止；其它模型不受影响；历史保留', async t => {
  const m = await mockProvider(p => (p.includes('慢') && !p.includes('待审核输出') ? { delay: 700, usage: true } : { usage: true }));
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const a = await addProvider(S, 'Keep', m.port), b = await addProvider(S, 'Gone', m.port), c = await addProvider(S, 'Off', m.port);
  // 停用的模型不接新任务
  await call(S.port, 'POST', '/api/providers', { id: c, label: 'Off', type: 'openai', baseUrl: `http://127.0.0.1:${m.port}/v1`, model: 'm', enabled: false });
  const r1 = await call(S.port, 'POST', '/api/run', { task: 'x', a: c, mode: 'single' });
  assert.equal(r1.status, 400); assert.equal(r1.json.code, 'connection_disabled');
  assert.equal((await call(S.port, 'POST', '/api/run', { task: 'x', a: 'no-such', mode: 'single' })).json.code, 'connection_missing');
  // 运行中删除审核模型：起草照常完成，在审核前明确停止
  const id = (await call(S.port, 'POST', '/api/run', { task: '慢任务', a, b, mode: 'review' })).json.runId;
  await sleep(200);
  assert.equal((await call(S.port, 'DELETE', '/api/providers/' + b)).status, 200);
  const run = await waitRun(S, id);
  assert.equal(run.status, 'error'); assert.equal(run.errorCode, 'connection_missing');
  assert.match(run.error, /Gone.*交叉审核/);
  assert.equal(run.steps.length, 1); assert.equal(run.steps[0].status, 'done', '已开始的调用按开始时的配置完成');
  assert.equal(run.agents[1].connectionId, b, '历史任务保留原执行模型信息');
  assert.equal(run.agents[1].connectionLabel, 'Gone');
  // 其它模型继续工作
  const ok = await waitRun(S, (await call(S.port, 'POST', '/api/run', { task: '正常', a, mode: 'single' })).json.runId);
  assert.equal(ok.status, 'done');
});

test('外部事件不能写入平台内部任务；外部任务归属首个上报主体', async t => {
  const m = await mockProvider(() => ({ usage: true }));
  const S = await boot([m.port]);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const a = await addProvider(S, 'In', m.port);
  const id = (await call(S.port, 'POST', '/api/run', { task: '内部任务', a, mode: 'single' })).json.runId;
  const before = await waitRun(S, id);
  const r = await call(S.port, 'POST', '/api/event', { agent: 'hook-z', taskId: id, eventType: 'task_done', task: '伪造完成' });
  assert.equal(r.status, 403); assert.match(r.json.error, /无权/);
  const after = (await call(S.port, 'GET', '/api/runs/' + id)).json;
  assert.equal(after.events.length, before.events.length, '内部任务记录未被写入');
  assert.equal(after.status, before.status);
  // 外部自己的任务：可以写，任务标记为 external / reported
  assert.equal((await call(S.port, 'POST', '/api/event', { agent: 'hook-z', taskId: 'ext-task-1', status: 'start', task: '外部任务' })).status, 200);
  const ext = (await call(S.port, 'GET', '/api/runs/ext-task-1')).json;
  assert.equal(ext.kind, 'external'); assert.equal(ext.verification, 'reported'); assert.equal(ext.events.length, 1);
  assert.equal((await call(S.port, 'POST', '/api/event', { agent: 'hook-z', taskId: '../x', status: 'info' })).status, 400);
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
  await new Promise(r => { const rq = http.get({ host: '127.0.0.1', port: S.port, path: '/api/events', headers: H.authHeaders(S.port) }, res => { res.once('data', () => { rq.destroy(); r(); }); }); });
  assert.equal((await call(S.port, 'POST', '/api/event', { agent: 'after-disconnect', status: 'info' })).status, 200);
  assert.equal((await call(S.port, 'GET', '/api/state')).status, 200);
});

test('流式取消与费用：响应体挂起时超时真正断开连接；SSE 断线不影响后台调用；零用量与失败用量', async t => {
  const closed = [];
  const m = await mockProvider(p => {
    if (p.includes('挂住')) return { hang: true, onReq: (req, res) => { const t0 = Date.now(); res.on('close', () => closed.push(Date.now() - t0)); } };
    if (p.includes('零用量')) return { zeroUsage: true };
    if (p.includes('中途断开')) return { partialDrop: true };
    return { delay: 400, usage: true };
  });
  const S = await boot([m.port], undefined, { AIJ_TEST_TIMEOUT_MS: '1000' });
  t.after(async () => { await S.kill(); m.srv.closeAllConnections(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const pid = await addProvider(S, 'C', m.port);
  const run = async task => waitRun(S, (await call(S.port, 'POST', '/api/run', { task, a: pid, mode: 'single' })).json.runId, 6000);

  // 1) 已收到响应头、响应体一直不来：超时后上游连接被真正关闭（不是只在本地放弃）
  const hung = await run('挂住');
  assert.equal(hung.status, 'error'); assert.match(hung.error, /超时/);
  await sleep(200);
  assert.equal(closed.length, 1, '上游连接已被关闭'); assert.ok(closed[0] >= 900 && closed[0] < 2500, '在超时附近关闭：' + closed[0]);

  // 2) SSE 客户端中途断开，不影响后台模型调用
  const id = (await call(S.port, 'POST', '/api/run', { task: '后台慢任务', a: pid, mode: 'single' })).json.runId;
  await new Promise(r => { const rq = http.get({ host: '127.0.0.1', port: S.port, path: '/api/events', headers: H.authHeaders(S.port) }, res => res.once('data', () => { rq.destroy(); r(); })); });
  const bg = await waitRun(S, id);
  assert.equal(bg.status, 'done'); assert.equal(bg.steps[0].estimated, false);

  // 3) 厂商明确返回 0：事件保留 input:0 / output:0，来源 provider，不当作估算
  const z = await run('零用量');
  const zd = z.events.find(e => e.eventType === 'model_done');
  assert.deepEqual(zd.tokenUsage, { input: 0, output: 0, total: 0, source: 'provider', estimated: false });

  // 4) 中途断开：失败事件带估算用量，计入 estimatedTokens 而不是真实 tokens
  const before = await state(S);
  const d = await run('中途断开');
  assert.equal(d.status, 'error');
  const de = d.events.find(e => e.eventType === 'model_error');
  assert.equal(de.tokenUsage.source, 'estimated'); assert.ok(de.tokenUsage.total > 0);
  const after = await state(S);
  assert.equal(after.totals.tokens, before.totals.tokens, '估算值不进入真实 tokens');
  assert.equal(after.totals.estimatedTokens - before.totals.estimatedTokens, de.tokenUsage.total);
  // 挂住的那次没有任何输出：失败事件不附用量（未知）
  assert.equal(hung.events.find(e => e.eventType === 'model_error').tokenUsage, undefined);
});
