'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ACC = require('../lib/access');
const PERM = require('../lib/permissions');

/* ---------------- 单元 ---------------- */
test('字段允许列表：匿名只保留动画字段，观看者加任务与错误摘要，新增字段默认不外泄', () => {
  const ev = { v: 1, eventId: 'x-1', status: 'start', eventType: 'task_start', agent: 'a', label: 'A', role: '起草', tokens: 5, working: 1,
    task: '机密任务', error: 'boom', text: '模型原文', filePath: '/etc/x', metadata: { k: 1 }, taskId: 't1', newSecretField: 's' };
  const l0 = ACC.redactEvent(ev, 0), l1 = ACC.redactEvent(ev, 1);
  for (const k of ['task', 'error', 'text', 'filePath', 'metadata', 'taskId', 'newSecretField']) assert.ok(!(k in l0), 'L0 不含 ' + k);
  for (const k of ['status', 'agent', 'label', 'role', 'tokens', 'working', 'eventType']) assert.ok(k in l0, 'L0 含 ' + k);
  assert.equal(l1.task, '机密任务'); assert.equal(l1.taskId, 't1');
  for (const k of ['text', 'filePath', 'metadata', 'newSecretField']) assert.ok(!(k in l1), 'L1 不含 ' + k);
  assert.equal(ACC.redactEvent(ev, 2), ev);
  assert.ok(!('task' in ACC.redactAgent({ id: 'a', task: 't', status: 'idle' }, 0)));
});

test('主体识别：本机 / 管理令牌 / 上报凭证 / 观看 Cookie / 无效凭证 / 匿名', () => {
  const ing = ACC.newIngestToken();
  const acc = ACC.createAccess({ adminToken: () => 'admin-token-123456', viewToken: 'view-token-123456', trustProxy: false, ingestTokens: () => [{ name: 'hooks', hash: ing.hash, agents: ['hook-a'] }] });
  const req = (addr, host, headers = {}) => ({ socket: { remoteAddress: addr }, headers: { host, ...headers } });
  assert.equal(acc.identify(req('127.0.0.1', 'localhost:8787')).kind, 'local');
  assert.equal(acc.identify(req('127.0.0.1', 'evil.example')).kind, 'anonymous', '回环 + 非本机 Host（DNS 重绑定）不算本机');
  assert.equal(acc.identify(req('10.0.0.2', 'h', { 'x-admin-token': 'admin-token-123456' })).kind, 'admin');
  const i = acc.identify(req('10.0.0.2', 'h', { 'x-ingest-token': ing.token }));
  assert.deepEqual([i.kind, i.id, i.agents, i.level], ['ingest', 'ingest:hooks', ['hook-a'], 0]);
  assert.equal(acc.identify(req('10.0.0.2', 'h', { cookie: 'a=1; aij_view=view-token-123456' })).level, 1);
  const bad = acc.identify(req('10.0.0.2', 'h', { authorization: 'Bearer nope' }));
  assert.equal(bad.invalid, true); assert.equal(bad.level, 0);
  assert.equal(acc.identify(req('10.0.0.2', 'h')).invalid, false);
  assert.ok(acc.viewTokenOk('view-token-123456')); assert.ok(!acc.viewTokenOk('x'));
});

test('人工团队角色权限：默认拒绝、团队范围、只看自己的', () => {
  const admin = { userId: 'u0', role: 'system_admin' }, ta = { userId: 'u1', role: 'team_admin', teamIds: ['T1'] };
  const mem = { userId: 'u2', role: 'member', teamIds: ['T1'] }, guest = { userId: 'u3', role: 'guest', teamIds: ['T1'] };
  assert.ok(PERM.can(admin, 'model.manage'));
  assert.ok(!PERM.can(ta, 'model.manage'));
  assert.ok(PERM.can(ta, 'team.manage', { teamId: 'T1' })); assert.ok(!PERM.can(ta, 'team.manage', { teamId: 'T2' }));
  assert.ok(PERM.can(mem, 'task.view', { ownerId: 'u2' })); assert.ok(!PERM.can(mem, 'task.view', { ownerId: 'u9' }));
  assert.ok(!PERM.can(guest, 'task.create', { teamId: 'T1' }));
  assert.ok(PERM.can({ userId: 'r', role: 'reviewer', teamIds: ['T1'] }, 'review.approve', { teamId: 'T1' }));
  assert.ok(!PERM.can({ userId: 'x', role: 'nobody' }, 'task.view', { ownerId: 'x' }));
  assert.ok(!PERM.can(admin, 'no.such.action'));
  assert.equal(PERM.userFromPrincipal({ kind: 'local', id: 'local' }).role, 'system_admin');
  assert.equal(PERM.userFromPrincipal({ kind: 'ingest', id: 'ingest:x' }), null, '上报凭证不映射为任何人工角色');
});

/* ---------------- 集成 ---------------- */
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REMOTE = 'aij.example.test'; // 非 localhost 的 Host：服务端按远程访问处理
function call(port, method, url, { body, headers = {}, host = REMOTE } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { host, ...headers }; if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, headers: res.headers, json: j, text: b }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
function sse(port, headers, ms) {
  return new Promise(resolve => {
    const evs = []; let status = 0;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: REMOTE, ...headers } }, res => {
      status = res.statusCode; let buf = ''; res.setEncoding('utf8');
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = buf.slice(0, i).match(/^data: (.*)$/m); buf = buf.slice(i + 2); if (m) try { evs.push(JSON.parse(m[1])); } catch { /* 忽略 */ } } });
    });
    setTimeout(() => { req.destroy(); resolve({ status, evs }); }, ms);
  });
}
async function boot(env = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-acc-'));
  const e = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, ADMIN_TOKEN: 'admin-token-abcdef123456', ...env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VIEW_TOKEN', 'INGEST_TOKEN', 'INGEST_AGENTS', 'ANON_VIEW']) if (!(k in env)) delete e[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: e, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await call(port, 'GET', '/api/state', { host: 'localhost' })).status === 200) break; } catch { /* 等待 */ } await sleep(100); }
  return { port, dir, stop: () => new Promise(r => { child.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); child.kill('SIGTERM'); }) };
}
const ADMIN = { 'x-admin-token': 'admin-token-abcdef123456' };

test('三级可见性：匿名 / 观看者 / 管理员；?view= 换 HttpOnly Cookie；上报凭证只能上报', async t => {
  const S = await boot({ VIEW_TOKEN: 'view-token-abcdef12', INGEST_TOKEN: 'ingest-token-abcdef1234', INGEST_AGENTS: 'hook-a,hook-b' });
  t.after(S.stop);
  const ING = { 'x-ingest-token': 'ingest-token-abcdef1234' };
  // 管理接口：远程匿名 401，管理令牌 200，上报凭证 401
  assert.equal((await call(S.port, 'GET', '/api/config')).status, 401);
  assert.equal((await call(S.port, 'GET', '/api/config', { headers: ADMIN })).status, 200);
  assert.equal((await call(S.port, 'GET', '/api/config', { headers: ING })).status, 401);
  // 上报：凭证允许的 agent 可写；其它 agent 403；匿名 401
  const anonSSE = sse(S.port, {}, 900);
  const viewSSE = sse(S.port, { cookie: 'aij_view=view-token-abcdef12' }, 900);
  const adminSSE = sse(S.port, ADMIN, 900);
  await sleep(200);
  assert.equal((await call(S.port, 'POST', '/api/event', { headers: ING, body: { agent: 'hook-a', status: 'start', task: '机密任务名', text: '原文' } })).status, 200);
  assert.equal((await call(S.port, 'POST', '/api/event', { headers: ING, body: { agent: 'hook-x', status: 'start' } })).status, 403);
  assert.equal((await call(S.port, 'POST', '/api/event', { body: { agent: 'hook-a', status: 'start' } })).status, 401);
  assert.equal((await call(S.port, 'GET', '/api/events', { headers: ING })).status, 403, '上报凭证不能订阅事件流');
  const [an, vw, ad] = await Promise.all([anonSSE, viewSSE, adminSSE]);
  const pickEv = r => r.evs.find(e => e.type === 'event' && e.agent === 'hook-a');
  assert.equal(pickEv(an).status, 'start'); assert.equal(pickEv(an).task, undefined, '匿名看不到任务名');
  assert.equal(pickEv(vw).task, '机密任务名', '观看者看得到任务名');
  assert.equal(pickEv(ad).task, '机密任务名');
  assert.deepEqual(an.evs[0].providers, [], '匿名看不到模型配置');
  // 状态接口同样分级
  assert.equal((await call(S.port, 'GET', '/api/state')).json.agents.find(a => a.id === 'hook-a').task, undefined);
  assert.equal((await call(S.port, 'GET', '/api/state', { headers: { cookie: 'aij_view=view-token-abcdef12' } })).json.agents.find(a => a.id === 'hook-a').task, '机密任务名');
  // ?view= 换 Cookie：303 跳转到去掉令牌的地址，Cookie 为 HttpOnly
  const v = await call(S.port, 'GET', '/?view=view-token-abcdef12&x=1');
  assert.equal(v.status, 303); assert.equal(v.headers.location, '/?x=1');
  assert.match(v.headers['set-cookie'][0], /aij_view=view-token-abcdef12; Path=\/; HttpOnly; SameSite=Strict/);
  assert.equal((await call(S.port, 'GET', '/?view=wrong')).status, 401);
});

test('防爆破与限流：无效凭证锁定 IP；上报限流；上报凭证可由管理员创建与吊销', async t => {
  const S = await boot({ ANON_VIEW: '0' });
  t.after(S.stop);
  assert.equal((await call(S.port, 'GET', '/api/state')).status, 401, 'ANON_VIEW=0 时匿名不能观看');
  // 管理员创建上报凭证（明文只返回一次，配置里只存哈希）
  const c = await call(S.port, 'POST', '/api/ingest-tokens', { headers: ADMIN, body: { name: 'ci-bot', agents: ['ci-bot'] } });
  assert.equal(c.status, 200); assert.match(c.json.token, /^aij_ing_/);
  const conf = fs.readFileSync(path.join(S.dir, 'config.json'), 'utf8');
  assert.ok(!conf.includes(c.json.token), '配置文件不保存凭证明文');
  assert.equal((await call(S.port, 'POST', '/api/ingest-tokens', { headers: ADMIN, body: { name: 'bad name!' } })).status, 400);
  const ING = { 'x-ingest-token': c.json.token };
  assert.equal((await call(S.port, 'POST', '/api/event', { headers: ING, body: { agent: 'ci-bot', status: 'info' } })).status, 200);
  // 限流：突发 200 之后开始 429
  const rs = await Promise.all(Array.from({ length: 260 }, (_, i) => call(S.port, 'POST', '/api/event', { headers: ING, body: { agent: 'ci-bot', status: 'stream', clientEventId: 'e' + i } })));
  assert.ok(rs.some(r => r.status === 429), '超过突发上限后限流');
  assert.ok(rs.filter(r => r.status === 200).length >= 150);
  // 吊销后失效
  assert.equal((await call(S.port, 'DELETE', '/api/ingest-tokens/ci-bot', { headers: ADMIN })).status, 200);
  assert.equal((await call(S.port, 'POST', '/api/event', { headers: ING, body: { agent: 'ci-bot', status: 'info' } })).status, 401);
  // 无效凭证累计 8 次后锁定：之后即使正确的管理令牌也 429（本机访问不受影响）
  for (let i = 0; i < 8; i++) await call(S.port, 'GET', '/api/config', { headers: { 'x-admin-token': 'guess-' + i } });
  assert.equal((await call(S.port, 'GET', '/api/config', { headers: ADMIN })).status, 429);
  assert.equal((await call(S.port, 'GET', '/api/config', { host: 'localhost' })).status, 200, '本机管理不被锁死');
});
