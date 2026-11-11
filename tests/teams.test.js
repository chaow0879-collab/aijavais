'use strict';
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
const { TeamRegistry } = require('../lib/teams');
const { recommend } = require('../lib/matcher');
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'providers.v1.json'), 'utf8'));
const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'team-templates.v1.json'), 'utf8'));

function setup() {
  const models = new ModelRegistry({ catalog: CATALOG, policy: SEC.policyFromEnv({ LOCAL_MODEL_TARGETS: 'localhost:11434' }), env: {} });
  const add = (o) => models.add({ providerId: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-x-12345678', modelId: 'm', ...o }).connection.connectionId;
  const paid = add({ displayName: '付费强模型', pricingMode: 'paid_api', capabilities: ['reasoning', 'coding', 'writing', 'chinese'] });
  const free = models.add({ providerId: 'ollama', modelId: 'local', displayName: '本地模型', capabilities: ['coding', 'chinese'] }).connection.connectionId;
  const unknown = add({ displayName: '费用未知模型', capabilities: ['writing', 'chinese'] });
  const teams = new TeamRegistry({ templates: TEMPLATES, capTags: Object.keys(CATALOG.capabilities), hasConnection: id => models.has(id) });
  return { models, teams, paid, free, unknown };
}

test('模板：版本化数据、岗位齐全、30 类目录、不绑定任何具体模型', () => {
  assert.equal(TEMPLATES.version, 1);
  assert.equal(TEMPLATES.categories.length, 30);
  const ready = TEMPLATES.categories.filter(c => c.status === 'ready').map(c => c.templateId);
  assert.deepEqual(ready.sort(), TEMPLATES.templates.map(t => t.templateId).sort(), '标为 ready 的类别都有完整模板');
  for (const t of TEMPLATES.templates) {
    for (const k of ['roles', 'workflow', 'deliverables', 'tools', 'humanReviewNodes', 'suggestedCombination']) assert.ok(k in t, t.templateId + ' 缺 ' + k);
    for (const r of t.roles) {
      assert.ok(r.roleId && r.name && r.duty && Array.isArray(r.requiredCapabilities));
      assert.ok(r.requiredCapabilities.every(c => c in CATALOG.capabilities), t.templateId + '/' + r.roleId);
      assert.ok(!('primaryConnectionId' in r), '模板不绑定模型');
    }
  }
  assert.ok(!/claude|chatgpt|openai|anthropic|gemini|deepseek|kimi/i.test(JSON.stringify(TEMPLATES.templates)), '模板里没有品牌名');
});

test('建团队：从模板 + 分配模型；一个模型承担多个岗位；岗位校验；更换模型团队不变', () => {
  const { models, teams, paid, free } = setup();
  const r = teams.fromTemplate('software-development', { name: '我的开发团队', assignments: { architect: { primaryConnectionId: paid }, developer: { primaryConnectionId: paid, fallbackConnectionIds: [free] }, reviewer: { primaryConnectionId: paid } } }, 'u1');
  assert.ok(r.ok, r.error);
  const t = r.team;
  assert.match(t.teamId, /^team_[a-f0-9]{6}$/);
  assert.deepEqual([t.templateId, t.templateVersion, t.ownerId], ['software-development', 1, 'u1']);
  assert.deepEqual(t.budgetPolicy, { mode: 'free_first', allowPaidApi: false, monthlyPaidApiBudget: 0, requireApprovalForPaidApi: true }, '默认不自动付费');
  assert.equal(teams.refs(paid).length, 3, '同一个模型承担 3 个岗位');
  const v = teams.validate(t.teamId, models);
  assert.ok(v.issues.some(i => /同一个模型/.test(i.text)));
  // 换模型：只改岗位分配
  const a = teams.assign(t.teamId, 'reviewer', { primaryConnectionId: free });
  assert.ok(a.ok); assert.equal(a.team.teamId, t.teamId); assert.equal(a.team.roles.find(x => x.roleId === 'reviewer').primaryConnectionId, free);
  // 校验
  assert.match(teams.add({ name: 'x', roles: [{ roleId: 'a', primaryConnectionId: 'ghost' }] }).error, /不存在/);
  assert.match(teams.add({ name: 'x', roles: [{ roleId: 'a' }, { roleId: 'a' }] }).error, /重复/);
  assert.match(teams.add({ name: 'x', roles: [{ roleId: 'bad id!' }] }).error, /不合法/);
  assert.match(teams.add({ name: 'x', roles: [{ roleId: 'a', requiredCapabilities: ['magic'] }] }).error, /未知/);
  assert.match(teams.add({ name: '', roles: [{ roleId: 'a' }] }).error, /名称/);
  assert.match(teams.add({ name: 'x', roles: [{ roleId: 'a' }], budgetPolicy: { mode: 'yolo' } }).error, /mode/);
  assert.match(teams.fromTemplate('finance', {}).error, /尚未提供/, 'planned 类别还没有模板');
});

test('岗位选模型：备用模型接替；免费优先；付费 / 费用未知需本次确认；都不可用时明确提示', () => {
  const { models, teams, paid, free, unknown } = setup();
  const t = teams.add({ name: 'T', roles: [{ roleId: 'w', name: '撰写', primaryConnectionId: paid, fallbackConnectionIds: [free] }, { roleId: 'u', name: '审校', primaryConnectionId: unknown }] }).team;
  let r = teams.resolveRole(t, 'w', models);
  assert.ok(r.ok); assert.equal(r.connectionId, free, 'free_first：免费的备用模型优先'); assert.equal(r.usedFallback, true);
  const q = teams.get(teams.update(t.teamId, { budgetPolicy: { mode: 'quality_first' } }).team.teamId);
  r = teams.resolveRole(q, 'w', models);
  assert.equal(r.ok, false); assert.equal(r.code, 'paid_approval_required', 'quality_first 选主模型，但付费需确认');
  r = teams.resolveRole(q, 'w', models, { approvePaid: true });
  assert.ok(r.ok); assert.equal(r.connectionId, paid);
  r = teams.resolveRole(q, 'u', models);
  assert.equal(r.code, 'paid_approval_required', '费用未知按可能付费处理');
  const allow = teams.get(teams.update(t.teamId, { budgetPolicy: { allowPaidApi: true } }).team.teamId);
  assert.ok(teams.resolveRole(allow, 'u', models).ok, '团队允许付费时无需每次确认');
  // 主模型停用 → 备用接替；全部不可用 → 明确提示
  models.setEnabled(paid, false);
  r = teams.resolveRole(allow, 'w', models);
  assert.equal(r.connectionId, free); assert.deepEqual(r.skipped, [{ connectionId: paid, reason: '已停用' }]);
  models.setEnabled(free, false);
  r = teams.resolveRole(allow, 'w', models);
  assert.equal(r.code, 'role_no_available_model'); assert.match(r.error, /撰写/);
});

test('模型删除对团队：引用查询、替换、移除后岗位待分配', () => {
  const { teams, paid, free, unknown } = setup();
  const t = teams.add({ name: 'T', roles: [{ roleId: 'a', primaryConnectionId: paid, fallbackConnectionIds: [free] }, { roleId: 'b', primaryConnectionId: free, fallbackConnectionIds: [paid] }] }).team;
  assert.deepEqual(teams.refs(paid).map(x => [x.roleId, x.slot]), [['a', 'primary'], ['b', 'fallback']]);
  assert.equal(teams.replaceConnection(paid, unknown), 2);
  const after = teams.get(t.teamId);
  assert.equal(after.roles[0].primaryConnectionId, unknown); assert.deepEqual(after.roles[1].fallbackConnectionIds, [unknown]);
  teams.replaceConnection(free, null);
  const g = teams.get(t.teamId);
  assert.equal(g.roles[1].primaryConnectionId, null, '主模型被删 → 待分配'); assert.deepEqual(g.roles[0].fallbackConnectionIds, []);
});

test('能力匹配推荐：说明理由 / 适合岗位 / 不足 / 搭配 / 是否付费；不推荐停用的；不编造未知信息', () => {
  const { models, paid, free, unknown } = setup();
  models.recordTest(paid, { ok: true, ms: 10 });
  models.setEnabled(unknown, false);
  const tpl = TEMPLATES.templates.find(t => t.templateId === 'software-development');
  const rec = recommend({ requiredCapabilities: ['reasoning', 'coding'], connections: models.list(), budget: { mode: 'free_first' }, capNames: CATALOG.capabilities, roles: tpl.roles });
  assert.deepEqual(rec.map(r => r.connectionId), [paid, free], '停用的不推荐；能力匹配且测试通过的排前');
  const top = rec[0];
  assert.ok(top.why.some(w => /推理分析、编程/.test(w) && /未经平台验证/.test(w)));
  assert.ok(top.why.includes('最近一次连接测试成功'));
  assert.deepEqual(top.suitedRoles, ['系统架构师', '程序开发工程师', '代码审核员']);
  assert.equal(top.payment, 'yes');
  assert.ok(top.shortcomings.some(s => /未知/.test(s)), '上下文长度等标为未知');
  assert.equal(top.pairWith.connectionId, free);
  const loc = rec[1];
  assert.equal(loc.payment, 'no'); assert.ok(loc.shortcomings.some(s => /推理分析/.test(s)) && loc.shortcomings.some(s => /尚未做连接测试/.test(s)));
});

/* ---------------- 集成 ---------------- */
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = H.call;
function mockProvider() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      seen.push({ model: j.model, system: j.messages[0].content, prompt: j.messages[j.messages.length - 1].content });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: j.model + ' 的输出' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, seen })));
}
async function boot(mockPort) {
  return H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mockPort } });
}
async function waitRun(S, id) {
  for (let t = 0; t < 6000; t += 100) { const r = (await call(S.port, 'GET', '/api/runs/' + id)).json; if (r.status !== 'running') return r; await sleep(100); }
  throw new Error('任务未结束');
}

test('按团队运行：岗位名进入事件与消息；同一模型多岗位；付费确认；备用接替；删除被引用模型；团队失效提示；历史保留', async t => {
  const m = await mockProvider();
  const S = await boot(m.port);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${m.port}/v1`;
  const add = async (name, model, pricingMode) => (await call(S.port, 'POST', '/api/models', { providerId: 'custom', baseUrl: base, apiKey: 'k-12345678', modelId: model, displayName: name, pricingMode, capabilities: ['writing', 'chinese', 'reasoning'] })).json.connection.connectionId;
  const W = await add('写作模型', 'model-w', 'free_tier'), R = await add('审校模型', 'model-r', 'paid_api'), F = await add('备用模型', 'model-f', 'local');

  // 从模板建团队
  const mk = await call(S.port, 'POST', '/api/teams', { templateId: 'word-document', name: '公文小组', assignments: { writer: { primaryConnectionId: W }, editor: { primaryConnectionId: R } } });
  assert.equal(mk.status, 200, mk.text);
  const teamId = mk.json.team.teamId;
  assert.ok(mk.json.health.issues.some(i => /付费 API/.test(i.text)), '健康检查提示付费岗位');
  assert.equal((await call(S.port, 'GET', '/api/team-templates')).json.categories.length, 30);

  // 付费岗位：未确认 → 402，不发起任何调用
  const before = m.seen.length;
  const need = await call(S.port, 'POST', '/api/run', { task: '写一份通知', teamId, mode: 'full' });
  assert.equal(need.status, 402); assert.equal(need.json.code, 'paid_approval_required'); assert.equal(m.seen.length, before, '未确认前不产生任何调用');
  // 确认后运行：岗位 ID / 名称进入事件与消息，模型由团队决定
  const ok = await call(S.port, 'POST', '/api/run', { task: '写一份通知', teamId, mode: 'full', approvePaid: true });
  const run = await waitRun(S, ok.json.runId);
  assert.equal(run.status, 'done', run.error);
  assert.deepEqual(run.agents.map(a => [a.roleId, a.roleName, a.connectionId]), [['writer', '文档撰写', W], ['editor', '审校编辑', R]]);
  assert.deepEqual(run.team.assignments.map(a => [a.roleId, a.connectionId, a.paid]), [['writer', W, false], ['editor', R, true]]);
  assert.equal(run.team.paidApproved, true);
  assert.deepEqual(run.events.filter(e => e.eventType === 'handoff').map(e => e.roleId), ['writer', 'editor']);
  assert.deepEqual(m.seen.slice(before).map(x => x.model), ['model-w', 'model-r', 'model-w']);

  // 同一个模型承担两个岗位
  await call(S.port, 'PUT', `/api/teams/${teamId}/roles/editor`, { primaryConnectionId: W });
  const same = await waitRun(S, (await call(S.port, 'POST', '/api/run', { task: '同模型两岗位', teamId, mode: 'full' })).json.runId);
  assert.equal(same.status, 'done', same.error);
  assert.ok(same.agents.every(a => a.connectionId === W)); assert.notEqual(same.agents[0].instanceId, same.agents[1].instanceId);
  assert.equal((await call(S.port, 'GET', `/api/runs/${same.id}/messages`)).json.messages.length, 4);

  // 主模型停用 → 备用模型接替
  await call(S.port, 'PUT', `/api/teams/${teamId}/roles/writer`, { fallbackConnectionIds: [F] });
  await call(S.port, 'POST', `/api/models/${W}/disable`);
  await call(S.port, 'PUT', `/api/teams/${teamId}/roles/editor`, { primaryConnectionId: F });
  const fb = await waitRun(S, (await call(S.port, 'POST', '/api/run', { task: '备用接替', teamId, mode: 'review' })).json.runId);
  assert.equal(fb.status, 'done', fb.error);
  assert.equal(fb.team.assignments[0].connectionId, F); assert.equal(fb.team.assignments[0].usedFallback, true);
  await call(S.port, 'POST', `/api/models/${W}/enable`);

  // 删除被团队引用的模型：需要替代或确认待分配
  const blocked = await call(S.port, 'DELETE', `/api/models/${F}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.json.impact.teams.length, 2);
  const del = await call(S.port, 'DELETE', `/api/models/${F}?replacement=${R}`);
  assert.equal(del.status, 200, del.text); assert.equal(del.json.teamRolesUpdated, 2);
  const tm = (await call(S.port, 'GET', `/api/teams/${teamId}`)).json.team;
  assert.equal(tm.roles.find(r => r.roleId === 'editor').primaryConnectionId, R);
  assert.deepEqual(tm.roles.find(r => r.roleId === 'writer').fallbackConnectionIds, [R]);
  // 移除后岗位待分配 → 团队健康检查报错，运行给出明确提示
  assert.equal((await call(S.port, 'DELETE', `/api/models/${R}?detach=1`)).status, 200);
  const health = (await call(S.port, 'GET', `/api/teams/${teamId}/validate`)).json;
  assert.equal(health.ok, false); assert.ok(health.issues.some(i => /审校编辑.*还没有分配模型/.test(i.text)));
  const broken = await call(S.port, 'POST', '/api/run', { task: 'x', teamId, mode: 'review' });
  assert.equal(broken.status, 400); assert.equal(broken.json.code, 'role_unassigned');
  // 历史任务保留执行时的模型与岗位
  const hist = (await call(S.port, 'GET', '/api/runs/' + run.id)).json;
  assert.equal(hist.agents[1].connectionLabel, '审校模型'); assert.equal(hist.team.teamName, '公文小组');
  // 推荐接口
  const rec = (await call(S.port, 'POST', '/api/recommend', { teamId, roleId: 'editor' })).json;
  assert.ok(Array.isArray(rec.recommendations) && rec.recommendations[0].why && rec.note);
});
