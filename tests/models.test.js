'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SEC = require('../lib/security');
const { ModelRegistry, diagnose } = require('../lib/models');
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'providers.v1.json'), 'utf8'));

const reg = (env = {}) => new ModelRegistry({ catalog: CATALOG, policy: SEC.policyFromEnv(env), env });

/* ---------------- 单元 ---------------- */
test('简易添加：选服务商 + 粘贴 Key + 模型名，其余按目录补齐；凭证与注册信息分离', () => {
  const r = reg();
  const a = r.add({ providerId: 'anthropic', modelId: 'some-model', apiKey: 'sk-ant-abcdefgh1234' });
  assert.ok(a.ok, a.error);
  const c = a.connection;
  assert.match(c.connectionId, /^mc_[a-f0-9]{6}$/);
  assert.deepEqual([c.protocol, c.baseUrl, c.pricingMode, c.hasKey, c.keyHint, c.status], ['anthropic', 'https://api.anthropic.com', 'paid_api', true, '••••1234', 'untested']);
  assert.ok(!JSON.stringify(r.list()).includes('sk-ant-abcdefgh1234'), '列表不含密钥');
  const ser = r.serialize();
  assert.ok(!JSON.stringify(ser.models).includes('sk-ant'), 'models.json 不含密钥');
  assert.equal(ser.credentials[c.connectionId].apiKey, 'sk-ant-abcdefgh1234');
  assert.equal(r.runtime(c.connectionId).apiKey, 'sk-ant-abcdefgh1234', '运行时对象含凭证（仅服务端内部使用）');
  assert.equal(r.getCapabilities(c.connectionId).verified.length, 0, '未测试前没有已验证能力');
});

test('校验：未知服务商 / 能力 / 计费方式；官方环境变量只能用于官方主机；换主机必须重填 Key', () => {
  const r = reg();
  assert.match(r.add({ providerId: 'nope', modelId: 'm' }).error, /未知的服务商/);
  assert.match(r.add({ providerId: 'openai', modelId: 'm', capabilities: ['telepathy'] }).error, /未知的能力标签/);
  assert.match(r.add({ providerId: 'openai', modelId: 'm', pricingMode: 'cheap' }).error, /pricingMode/);
  assert.match(r.add({ providerId: 'custom', modelId: 'm', baseUrl: 'https://gw.example.com/v1', envKey: 'OPENAI_API_KEY' }).error, /只能用于/);
  assert.match(r.add({ providerId: 'custom', modelId: 'm', baseUrl: 'http://10.0.0.1/v1', apiKey: 'k' }).error, /https|LOCAL_MODEL_TARGETS/);
  const a = r.add({ providerId: 'custom', modelId: 'm', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-gw-12345678', displayName: '网关' }).connection;
  assert.match(r.update(a.connectionId, { baseUrl: 'https://other.example.com/v1' }).error, /重新填写 API Key/);
  r.recordTest(a.connectionId, { ok: true, ms: 5 });
  assert.equal(r.view(r.get(a.connectionId)).status, 'available');
  assert.ok(r.update(a.connectionId, { modelId: 'm2' }).ok);
  assert.equal(r.view(r.get(a.connectionId)).status, 'untested', '换模型后旧测试结果作废');
  assert.equal(r.update('nope', {}).code, 404);
});

test('迁移旧版 providers：保留原 id（大屏 agentId 不变）、按地址识别服务商、凭证单独存放', () => {
  const r = reg();
  const n = r.migrateLegacy([
    { id: 'claude', label: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'x', apiKey: 'sk-old-1234567', envKey: '', enabled: true },
    { id: 'gw', label: 'GW', type: 'openai', baseUrl: 'https://gw.example.com/v1', model: 'y', apiKey: '', envKey: 'PATH', enabled: false },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(r.list().map(c => [c.connectionId, c.providerId, c.enabled]), [['claude', 'anthropic', true], ['gw', 'custom', false]]);
  assert.equal(r.serialize().credentials.gw.envKey, '', '不合规 envKey 被清空');
  assert.equal(r.migrateLegacy([{ id: 'claude', model: 'z' }]), 0, '重复迁移不覆盖');
});

test('本地模型无需 Key；诊断提示面向普通用户', () => {
  const r = reg({ LOCAL_MODEL_TARGETS: 'localhost:11434' });
  const a = r.add({ providerId: 'ollama', modelId: 'local-model' });
  assert.ok(a.ok, a.error); assert.equal(a.connection.ready, true); assert.equal(a.connection.pricingMode, 'local');
  assert.match(reg().add({ providerId: 'ollama', modelId: 'x' }).error, /LOCAL_MODEL_TARGETS/, '未声明本地目标时拒绝');
  assert.match(diagnose('HTTP 401：invalid x-api-key'), /API Key 无效/);
  assert.match(diagnose('HTTP 404：model not found'), /模型名/);
  assert.match(diagnose('HTTP 429：quota'), /额度/);
  assert.match(diagnose('请求超时'), /超时/);
  assert.match(diagnose('Base URL 被拒绝：主机 x 解析到不允许的地址'), /安全策略/);
});

test('目录数据：服务商定义完整，价格未核实的不得标为免费', () => {
  for (const p of CATALOG.providers) {
    assert.ok(p.providerId && p.name && ['anthropic', 'openai'].includes(p.protocol), p.providerId);
    assert.ok(['paid_api', 'free_tier', 'local', 'unknown'].includes(p.pricingMode));
    assert.ok(p.pricingMode !== 'free_tier', '目录里不预设“免费”，免费额度需验证后由用户标记');
    if (p.baseUrl && p.providerId !== 'ollama') assert.match(p.baseUrl, /^https:\/\//);
    if (p.envKey) assert.ok(SEC.envKeyHostOk(p.envKey, new URL(p.baseUrl).hostname), p.providerId + ' 的 envKey 与主机绑定');
  }
});

/* ---------------- 集成 ---------------- */
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function call(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
/* 模拟 OpenAI 兼容服务商：/models 返回模型列表；Bearer bad-key 返回 401；prompt 含“慢”则延迟 */
function mockProvider() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
      if (req.headers.authorization === 'Bearer bad-key') { res.writeHead(401); return res.end('{"error":{"message":"invalid api key"}}'); }
      if (req.method === 'GET' && req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: '../bad id' }] })); }
      const j = JSON.parse(b || '{}');
      const prompt = j.messages[j.messages.length - 1].content;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
        res.end();
      }, prompt.includes('慢') ? 700 : 0);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
async function boot(mockPort, dir, preConfig) {
  const port = await freePort();
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-mdl-'));
  if (preConfig) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(preConfig));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, LOCAL_MODEL_TARGETS: mockPort ? '127.0.0.1:' + mockPort : '' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ADMIN_TOKEN', 'CLAUDE_MODEL']) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await call(port, 'GET', '/api/state')).status === 200) break; } catch { /* 等待 */ } await sleep(100); }
  return { port, dir, kill: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}
async function waitRun(S, id, ms = 6000) {
  for (let t = 0; t < ms; t += 100) { const r = (await call(S.port, 'GET', '/api/runs/' + id)).json; if (r.status !== 'running') return r; await sleep(100); }
  throw new Error('任务未结束');
}

test('零模型启动；简易接入（获取模型列表 → 测试 → 保存）；第一个模型自动成为默认；诊断', async t => {
  const m = await mockProvider();
  const S = await boot(m.port);
  t.after(async () => { await S.kill(); m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  // 零模型：平台正常，任务给出明确提示
  assert.deepEqual((await call(S.port, 'GET', '/api/models')).json.models, []);
  const none = await call(S.port, 'POST', '/api/run', { task: 'x', mode: 'single' });
  assert.equal(none.status, 400); assert.equal(none.json.code, 'connection_missing');
  // 获取模型列表（本次粘贴的 Key 不保存），非法模型名被过滤
  const base = `http://127.0.0.1:${m.port}/v1`;
  const d = await call(S.port, 'POST', '/api/models/discover', { providerId: 'custom', baseUrl: base, apiKey: 'good-key' });
  assert.deepEqual(d.json.models, ['model-a', 'model-b']);
  const bad = await call(S.port, 'POST', '/api/models/discover', { providerId: 'custom', baseUrl: base, apiKey: 'bad-key' });
  assert.equal(bad.json.ok, false); assert.match(bad.json.hint, /API Key 无效/);
  // 保存
  const add = await call(S.port, 'POST', '/api/models', { providerId: 'custom', baseUrl: base, apiKey: 'good-key', modelId: 'model-a', displayName: '主力模型', capabilities: ['coding', 'chinese'] });
  assert.equal(add.status, 200, add.text);
  const id = add.json.connection.connectionId;
  assert.equal((await call(S.port, 'GET', '/api/models')).json.defaultConnectionId, id, '第一个模型自动成为默认');
  // 测试：记录结果
  const tr = await call(S.port, 'POST', `/api/models/${id}/test`);
  assert.equal(tr.json.ok, true); assert.equal(tr.json.connection.status, 'available');
  assert.deepEqual((await call(S.port, 'GET', `/api/models/${id}/capabilities`)).json.verified, ['chat']);
  // 不指定模型也能运行（用默认模型）
  const run = await waitRun(S, (await call(S.port, 'POST', '/api/run', { task: '用默认模型', mode: 'single' })).json.runId);
  assert.equal(run.status, 'done'); assert.equal(run.agents[0].connectionId, id);
  // Key 失效 → 测试失败并给出提示
  await call(S.port, 'PUT', `/api/models/${id}`, { apiKey: 'bad-key' });
  const tf = await call(S.port, 'POST', `/api/models/${id}/test`);
  assert.equal(tf.json.ok, false); assert.match(tf.json.hint, /API Key 无效/); assert.equal(tf.json.connection.status, 'error');
  // 任何接口都不返回密钥明文
  for (const u of ['/api/models', '/api/config', `/api/models/${id}`]) assert.ok(!(await call(S.port, 'GET', u)).text.includes('bad-key'), u);
  assert.equal(fs.statSync(path.join(S.dir, 'credentials.json')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(S.dir, 'models.json'), 'utf8').includes('bad-key'));
});

test('停用 / 启用 / 删除：影响预览；删除默认模型改用替代；删除活跃模型需确认且不影响其它模型；系统可重启', async t => {
  const m = await mockProvider();
  let S = await boot(m.port);
  t.after(async () => { try { await S.kill(); } catch { /* 已退出 */ } m.srv.close(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${m.port}/v1`;
  const add = async name => (await call(S.port, 'POST', '/api/models', { providerId: 'custom', baseUrl: base, apiKey: 'good-key', modelId: 'model-a', displayName: name })).json.connection.connectionId;
  const A = await add('模型甲'), B = await add('模型乙'), C = await add('模型丙');
  // 停用：不接任务；启用后恢复
  await call(S.port, 'POST', `/api/models/${B}/disable`);
  assert.equal((await call(S.port, 'POST', '/api/run', { task: 'x', a: B, mode: 'single' })).json.code, 'connection_disabled');
  await call(S.port, 'POST', `/api/models/${B}/enable`);
  assert.equal((await waitRun(S, (await call(S.port, 'POST', '/api/run', { task: 'x', a: B, mode: 'single' })).json.runId)).status, 'done');
  // 删除默认模型：影响预览列出“是默认模型”，用替代模型删除后默认切换
  const imp = (await call(S.port, 'GET', `/api/models/${A}/impact`)).json;
  assert.equal(imp.isDefault, true); assert.ok(imp.blockers.some(x => /默认/.test(x))); assert.ok(imp.alternatives.some(x => x.connectionId === C));
  const del = await call(S.port, 'DELETE', `/api/models/${A}?replacement=${C}`);
  assert.equal(del.status, 200, del.text); assert.equal(del.json.defaultConnectionId, C);
  assert.equal((await call(S.port, 'DELETE', `/api/models/${B}?replacement=${B}`)).status, 400);
  // 删除活跃模型：运行中需要 force；删除后其它模型照常工作
  const rid = (await call(S.port, 'POST', '/api/run', { task: '慢任务', a: C, b: B, mode: 'review' })).json.runId;
  await sleep(200);
  const blocked = await call(S.port, 'DELETE', `/api/models/${B}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.json.impact.runningTasks[0].id, rid);
  assert.equal((await call(S.port, 'DELETE', `/api/models/${B}?force=1`)).status, 200);
  const r = await waitRun(S, rid);
  assert.equal(r.status, 'error'); assert.equal(r.errorCode, 'connection_missing');
  assert.equal(r.agents[1].connectionLabel, '模型乙', '历史任务保留被删模型的信息');
  assert.equal((await waitRun(S, (await call(S.port, 'POST', '/api/run', { task: 'y', mode: 'single' })).json.runId)).status, 'done', '其它模型照常工作');
  // 重启后状态一致
  await S.kill();
  S = await boot(m.port, S.dir);
  const after = (await call(S.port, 'GET', '/api/models')).json;
  assert.deepEqual(after.models.map(x => x.displayName), ['模型丙']); assert.equal(after.defaultConnectionId, C);
  assert.equal((await call(S.port, 'GET', '/api/runs/' + rid)).json.agents[1].connectionLabel, '模型乙');
  // 删除最后一个模型：系统仍可启动，任务给出明确提示
  assert.equal((await call(S.port, 'DELETE', `/api/models/${C}`)).status, 200);
  await S.kill();
  S = await boot(m.port, S.dir);
  assert.equal((await call(S.port, 'GET', '/api/state')).status, 200);
  assert.equal((await call(S.port, 'POST', '/api/run', { task: 'z', mode: 'single' })).json.code, 'connection_missing');
});

test('旧配置迁移：config.json 里的 providers 自动迁移为模型连接，密钥移入 credentials.json', async t => {
  const S = await boot(0, null, { token: 'tok-abcdef123456', settings: {}, providers: [{ id: 'claude', label: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'sk-legacy-12345678', envKey: '', enabled: true }] });
  t.after(async () => { await S.kill(); fs.rmSync(S.dir, { recursive: true, force: true }); });
  const list = (await call(S.port, 'GET', '/api/models')).json.models;
  assert.deepEqual(list.map(c => [c.connectionId, c.providerId, c.hasKey]), [['claude', 'anthropic', true]]);
  const conf = JSON.parse(fs.readFileSync(path.join(S.dir, 'config.json'), 'utf8'));
  assert.ok(!('providers' in conf), '旧字段已移除'); assert.equal(conf.token, 'tok-abcdef123456', '令牌保留');
  assert.ok(!fs.readFileSync(path.join(S.dir, 'config.json'), 'utf8').includes('sk-legacy'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(S.dir, 'credentials.json'), 'utf8')).claude.apiKey, 'sk-legacy-12345678');
});
