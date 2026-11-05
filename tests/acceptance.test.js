'use strict';
/*
 * 第三阶段验收：零模型、单模型、多模型、删除默认模型、删除活跃模型、添加新供应商、
 * 同一模型承担多个岗位、模型连接失败、团队引用失效、任务历史保留 —— 在同一个服务实例上按顺序验证。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SEC = require('../lib/security');
const { ModelRegistry } = require('../lib/models');

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = H.call;
/* 两个模拟服务商：good 正常（prompt 含“慢”时延迟），bad 一律 401 */
function mock(kind) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
      if (kind === 'bad') { res.writeHead(401); return res.end('{"error":{"message":"invalid api key"}}'); }
      const j = JSON.parse(b || '{}'); const prompt = j.messages[j.messages.length - 1].content;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: j.model + ' ok' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`); res.end();
      }, prompt.includes('慢') ? 800 : 0);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
async function boot(ports, dir) {
  return H.boot({ dir, env: { LOCAL_MODEL_TARGETS: ports.map(p => '127.0.0.1:' + p).join(',') } });
}

test('验收 A–J：模型自由接入、动态替换、团队自由组合，删除任意模型不导致平台故障', async t => {
  const good = await mock('good'), bad = await mock('bad');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-acc3-'));
  let S = await boot([good.port, bad.port], dir);
  t.after(async () => { try { await S.kill(); } catch { /* 已退出 */ } good.srv.close(); bad.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const G = `http://127.0.0.1:${good.port}/v1`, B = `http://127.0.0.1:${bad.port}/v1`;
  const add = async (name, model, base = G, extra = {}) => { const r = await call(S.port, 'POST', '/api/models', { providerId: 'custom', baseUrl: base, apiKey: 'k-12345678', modelId: model, displayName: name, pricingMode: 'local', ...extra }); assert.equal(r.status, 200, r.text); return r.json.connection.connectionId; };
  const run = async body => { const r = await call(S.port, 'POST', '/api/run', body); if (r.status !== 200) return r; for (let i = 0; i < 80; i++) { const x = (await call(S.port, 'GET', '/api/runs/' + r.json.runId)).json; if (x.status !== 'running') return { status: 200, json: x }; await sleep(100); } throw new Error('超时'); };

  // A 零模型：平台可用，运行给出明确提示
  assert.equal((await call(S.port, 'GET', '/api/state')).status, 200);
  assert.equal((await run({ task: 'x', mode: 'single' })).json.code, 'connection_missing');

  // B 单模型：自动成为默认，单模型与“自己审自己”都能跑（经消息总线）
  const M1 = await add('模型一', 'm1');
  assert.equal((await run({ task: '单模型', mode: 'single' })).json.status, 'done');
  const self = (await run({ task: '自审', mode: 'full' })).json;
  assert.equal(self.status, 'done'); assert.equal(self.messageStats.total, 4);

  // C 多模型：不同模型组合
  const M2 = await add('模型二', 'm2'), M3 = await add('模型三', 'm3');
  const multi = (await run({ task: '多模型', a: M2, b: M3, mode: 'full' })).json;
  assert.equal(multi.status, 'done'); assert.deepEqual(multi.agents.map(a => a.connectionId), [M2, M3]);

  // G 同一模型承担多个岗位（团队）
  const team = (await call(S.port, 'POST', '/api/teams', { templateId: 'software-development', name: '开发组',
    assignments: { architect: { primaryConnectionId: M2 }, developer: { primaryConnectionId: M2, fallbackConnectionIds: [M3] }, reviewer: { primaryConnectionId: M2 } } })).json.team;
  const tr = (await run({ task: '团队任务', teamId: team.teamId, mode: 'full' })).json;
  assert.equal(tr.status, 'done', tr.error);
  assert.deepEqual(tr.agents.map(a => [a.roleId, a.connectionId]), [['developer', M2], ['reviewer', M2]]);

  // F 添加新供应商：自定义接口直接接入；目录新增服务商只需改数据文件（见下一个测试）
  const MB = await add('坏连接', 'mb', B);
  // H 模型连接失败：测试给出诊断；任务失败但服务与其它模型不受影响
  const tf = (await call(S.port, 'POST', `/api/models/${MB}/test`)).json;
  assert.equal(tf.ok, false); assert.match(tf.hint, /API Key 无效/);
  const fr = (await run({ task: '会失败', a: MB, mode: 'single' })).json;
  assert.equal(fr.status, 'error'); assert.match(fr.error, /HTTP 401/);
  assert.equal((await run({ task: '照常', a: M3, mode: 'single' })).json.status, 'done');

  // D 删除默认模型（M1）：改用替代，默认切换
  const dd = await call(S.port, 'DELETE', `/api/models/${M1}?replacement=${M3}`);
  assert.equal(dd.status, 200); assert.equal(dd.json.defaultConnectionId, M3);

  // E 删除活跃模型（M2：运行中 + 被团队 3 个岗位引用）
  const slow = call(S.port, 'POST', '/api/run', { task: '慢任务', a: M2, b: M3, mode: 'full' }); // 修订步骤又回到 M2
  const rid = (await slow).json.runId;
  await sleep(250);
  const blocked = await call(S.port, 'DELETE', `/api/models/${M2}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.json.impact.runningTasks.length, 1); assert.equal(blocked.json.impact.teams.length, 3);
  const del = await call(S.port, 'DELETE', `/api/models/${M2}?force=1&detach=1`);
  assert.equal(del.status, 200); assert.equal(del.json.teamRolesUpdated, 3);
  for (let i = 0; i < 40; i++) { const x = (await call(S.port, 'GET', '/api/runs/' + rid)).json; if (x.status !== 'running') { assert.equal(x.errorCode, 'connection_missing'); break; } await sleep(100); }

  // I 团队引用失效：健康检查报错；有备用模型的岗位自动接替；无模型的岗位给出明确提示
  const health = (await call(S.port, 'GET', `/api/teams/${team.teamId}/validate`)).json;
  assert.equal(health.ok, false); assert.ok(health.issues.some(i => /系统架构师|代码审核员/.test(i.text) && /还没有分配模型/.test(i.text)));
  const single = (await run({ task: '备用接替', teamId: team.teamId, mode: 'single' })).json;
  assert.equal(single.status, 'done'); assert.equal(single.team.assignments[0].connectionId, M3, '开发岗位由备用模型接替');
  const broken = await run({ task: 'x', teamId: team.teamId, mode: 'full' });
  assert.equal(broken.status, 400); assert.equal(broken.json.code, 'role_unassigned');

  // J 任务历史保留 + 重启后一致；视觉事件不依赖模型名称（任意 connectionId 都能上大屏）
  await S.kill();
  S = await boot([good.port, bad.port], dir);
  const hist = (await call(S.port, 'GET', '/api/runs/' + multi.id)).json;
  assert.equal(hist.agents[0].connectionLabel, '模型二', '被删模型的历史记录保留');
  assert.deepEqual((await call(S.port, 'GET', '/api/models')).json.models.map(m => m.displayName).sort(), ['坏连接', '模型三']);
  assert.equal((await run({ task: '重启后', mode: 'single' })).json.status, 'done');
  const st = (await call(S.port, 'GET', '/api/state')).json;
  assert.ok(st.agents.some(a => a.id === M3 && a.label === '模型三'), '大屏按 connectionId / 显示名呈现，不依赖品牌');
});

test('新增服务商只需修改目录数据文件，不改任何代码', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'providers.v1.json'), 'utf8'));
  catalog.providers.push({ providerId: 'newvendor', name: '某新服务商', protocol: 'openai', baseUrl: 'https://api.newvendor.example/v1', envKey: '', modelsEndpoint: true, pricingMode: 'unknown', pricingNote: '待验证', simple: true });
  const r = new ModelRegistry({ catalog, policy: SEC.policyFromEnv({}), env: {} });
  const a = r.add({ providerId: 'newvendor', apiKey: 'sk-new-12345678', modelId: 'any-model' });
  assert.ok(a.ok, a.error);
  assert.deepEqual([a.connection.baseUrl, a.connection.protocol, a.connection.providerName], ['https://api.newvendor.example/v1', 'openai', '某新服务商']);
  const src = ['server.js', 'lib/models.js', 'lib/teams.js', 'lib/matcher.js', 'lib/runtime.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.ok(!/providerId\s*===\s*'(anthropic|openai|gemini|deepseek|moonshot)'/.test(src), '调度逻辑里没有按品牌分支');
});
