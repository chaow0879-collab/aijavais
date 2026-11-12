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

/* ---------------- 登录与会话（lib/auth.js） ---------------- */
const { AuthStore, passwordProblem } = require('../lib/auth');
const H = require('./helpers');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aij-auth-'));
const codeIn = dir => /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8'))[1];

test('首次设置：只有拿到服务器本机设置码的人才能设置；密码只存 scrypt 哈希；设置码只能用一次', async () => {
  const dir = tmp();
  const a = new AuthStore({ dir });
  assert.equal(a.isSetup(), false);
  const code = a.ensureSetupCode();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(fs.statSync(path.join(dir, 'setup-code.txt')).mode & 0o777, 0o600);
  assert.equal(a.ensureSetupCode(), null, '已有设置码时不重复生成');
  assert.equal((await a.setup('AAAA-BBBB-CCCC', 'good-password-123')).code, 401);
  assert.equal((await a.setup(code, 'short')).code, 400);
  assert.ok((await a.setup(code.toLowerCase().replace(/-/g, ' '), 'good-password-123')).ok, '设置码不区分大小写与分隔符');
  assert.equal(a.isSetup(), true);
  assert.ok(!fs.existsSync(path.join(dir, 'setup-code.txt')), '用过的设置码文件被删除');
  assert.equal((await a.setup(code, 'another-password-1')).code, 409, '不能再次设置');
  const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes('good-password-123'), '不保存明文');
  const pw = JSON.parse(raw).password;
  assert.deepEqual([pw.algo, pw.N, pw.r, pw.p, pw.salt.length, pw.hash.length], ['scrypt', 32768, 8, 1, 32, 128]);
  assert.equal(await a.verifyPassword('good-password-123'), true);
  assert.equal(await a.verifyPassword('good-password-124'), false);
  assert.equal(passwordProblem('aaaaaaaaaaaa'), '密码不能是同一个字符重复');
  assert.match(passwordProblem('1234567890abc'), /简单/);
});

test('会话：空闲超时、绝对过期、退出、撤销、改密码撤销其它会话；只存令牌哈希', async () => {
  let now = 1_000_000;
  const dir = tmp();
  const a = new AuthStore({ dir, now: () => now, options: { idleMs: 60e3, absoluteMs: 3600e3 } });
  await a.setup(a.ensureSetupCode(), 'good-password-123');
  const s1 = a.createSession('admin', { ip: '1.2.3.4' });
  assert.ok(!fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8').includes(s1.token), '会话文件里没有令牌明文');
  assert.equal(a.getSession(s1.token).kind, 'admin');
  now += 59e3; assert.ok(a.getSession(s1.token), '活动会刷新空闲计时');
  now += 59e3; assert.ok(a.getSession(s1.token));
  now += 61e3; assert.equal(a.getSession(s1.token), null, '空闲超过 60 秒失效');
  const s2 = a.createSession('admin'); const s3 = a.createSession('admin');
  for (let i = 0; i < 80; i++) { now += 50e3; a.getSession(s2.token); }
  assert.equal(a.getSession(s2.token), null, '超过绝对有效期失效（即使一直在用）');
  const s4 = a.createSession('admin');
  assert.equal((await a.changePassword('wrong-password-1', 'new-password-123', s4.session.sid)).code, 401);
  const r = await a.changePassword('good-password-123', 'new-password-123', s4.session.sid);
  assert.ok(r.ok);
  assert.ok(a.getSession(s4.token), '当前会话保留'); assert.equal(a.getSession(s3.token), null, '其它会话被撤销');
  assert.equal(await a.verifyPassword('good-password-123'), false);
  assert.ok(a.revoke(s4.session.sid)); assert.equal(a.getSession(s4.token), null);
  assert.equal(a.getSession('x'.repeat(200)), null);
  // 大屏观看链接：一次性、10 分钟内有效、得到只读会话
  const l = a.createDisplayLink({ label: '会议室', hours: 2 });
  const d = a.redeemDisplayLink(l.token);
  assert.equal(d.session.kind, 'display'); assert.equal(a.redeemDisplayLink(l.token), null, '只能用一次');
  const l2 = a.createDisplayLink({}); now += 11 * 60e3;
  assert.equal(a.redeemDisplayLink(l2.token), null, '过期');
  const audit = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  for (const ev of ['setup_done', 'login', 'password_changed', 'session_revoked', 'display_session_created']) assert.ok(audit.includes('"' + ev + '"'), ev);
});

test('本地恢复：工具清除密码与全部会话，运行中的服务自动感知（不必重启）', async () => {
  const dir = tmp();
  const srv = new AuthStore({ dir });
  await srv.setup(srv.ensureSetupCode(), 'good-password-123');
  const s = srv.createSession('admin');
  const out = require('child_process').spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'tools', 'reset-password.js'), '--yes'], { env: { ...process.env, AIJ_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out.stdout)[1];
  assert.equal(srv.isSetup(), false, '服务端立即看到密码已清除');
  assert.equal(srv.getSession(s.token), null, '旧会话全部失效');
  assert.ok((await srv.setup(code, 'brand-new-pass-1')).ok);
  const noConfirm = require('child_process').spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'tools', 'reset-password.js')], { env: { ...process.env, AIJ_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(noConfirm.status, 1, '不加 --yes 不执行');
});

test('主体识别：只认会话与上报凭证；localhost Host 头不再有任何特权', async () => {
  const dir = tmp();
  const store = new AuthStore({ dir });
  await store.setup(store.ensureSetupCode(), 'good-password-123');
  const ing = ACC.newIngestToken();
  const mk = o => ACC.createAccess({ auth: store, ingestTokens: () => [{ name: 'hooks', hash: ing.hash, agents: ['hook-a'] }], trustProxy: false, localIngest: false, ...o });
  const req = (addr, host, headers = {}) => ({ socket: { remoteAddress: addr }, headers: { host, ...headers } });
  const acc = mk();
  assert.equal(acc.identify(req('127.0.0.1', 'localhost:8787')).kind, 'none', '本机 + localhost 也必须登录');
  const admin = store.createSession('admin'), disp = store.createSession('display');
  assert.deepEqual([acc.identify(req('10.0.0.2', 'h', { cookie: 'aij_session=' + admin.token })).kind, acc.identify(req('10.0.0.2', 'h', { cookie: 'aij_session=' + admin.token })).level], ['admin', 2]);
  assert.deepEqual([acc.identify(req('10.0.0.2', 'h', { cookie: 'aij_session=' + disp.token })).kind, acc.identify(req('10.0.0.2', 'h', { cookie: 'aij_session=' + disp.token })).level], ['display', 1]);
  const i = acc.identify(req('10.0.0.2', 'h', { 'x-ingest-token': ing.token }));
  assert.deepEqual([i.kind, i.id, i.agents], ['ingest', 'ingest:hooks', ['hook-a']]);
  assert.equal(acc.identify(req('10.0.0.2', 'h', { 'x-ingest-token': admin.token })).invalid, true, '会话令牌不能当上报凭证用');
  assert.equal(acc.identify(req('10.0.0.2', 'h', { cookie: 'aij_session=' + ing.token })).kind, 'none', '上报凭证不能当会话用');
  assert.equal(acc.identify(req('10.0.0.2', 'h', { cookie: 'aij_session=expired' })).invalid, false, '过期 / 撤销的会话不计入暴力破解');
  assert.equal(mk({ localIngest: true }).identify(req('127.0.0.1', 'x')).kind, 'local', '显式开启后本机回环可上报');
  assert.equal(mk({ localIngest: true, trustProxy: true }).identify(req('127.0.0.1', 'x')).kind, 'none', '反向代理后不允许（所有请求都来自回环）');
});

/* ---------------- 集成：服务端真实拦截 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('未登录：所有页面跳登录页，所有工作数据接口 401，SSE 不可订阅；只有登录页和登录接口公开', async t => {
  const S = await H.boot({ login: false });
  t.after(S.stop);
  const anon = (m, u, b, o = {}) => H.call(S.port, m, u, b, { cookie: false, ...o });
  for (const u of ['/', '/panel.html', '/workspace.html']) {
    const r = await anon('GET', u);
    assert.equal(r.status, 302, u); assert.match(r.headers.location, /^\/login\.html\?next=/);
  }
  // B8: back-end pages send the visitor to the separate admin login page
  for (const u of ['/admin.html', '/admin', '/capabilities.html', '/project-intake.html']) {
    const r = await anon('GET', u);
    assert.equal(r.status, 302, u); assert.match(r.headers.location, /^\/admin-login\.html\?next=/);
  }
  assert.equal((await anon('GET', '/admin-login.html')).status, 200);
  assert.equal((await anon('GET', '/admin/login')).headers.location, '/admin-login.html');
  assert.equal((await anon('GET', '/audio/sw421k.mp3')).status, 401);
  assert.equal((await anon('GET', '/login.html')).status, 200);
  for (const [m, u] of [['GET', '/api/state'], ['GET', '/api/config'], ['GET', '/api/models'], ['GET', '/api/runs'], ['GET', '/api/teams'], ['POST', '/api/run'], ['GET', '/api/runs/abc/artifacts'], ['POST', '/api/models/discover'], ['GET', '/api/ingest-tokens'], ['POST', '/api/demo'], ['POST', '/api/event']]) {
    assert.equal((await anon(m, u, m === 'POST' ? {} : undefined)).status, 401, m + ' ' + u);
  }
  assert.equal((await H.sse(S.port, 300, { cookie: false })).status, 401);
  assert.equal((await anon('GET', '/api/state', undefined, { host: '127.0.0.1' })).status, 401, '无 localhost 绕过');
  const st = (await anon('GET', '/api/auth/status')).json;
  assert.deepEqual([st.setup, st.loggedIn], [false, false]);
  assert.equal((await anon('POST', '/api/auth/login', { password: 'x' })).status, 409, '未设置密码时不能登录');
  // 安全响应头
  const r = await anon('GET', '/login.html');
  assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('登录流程：设置码 → 设置密码 → HttpOnly 会话；退出、撤销、改密码立即生效；SSE 在撤销后断开', async t => {
  const S = await H.boot({ login: false });
  t.after(S.stop);
  const anon = (m, u, b) => H.call(S.port, m, u, b, { cookie: false });
  assert.equal((await anon('POST', '/api/auth/setup', { code: 'AAAA-BBBB-CCCC', password: 'good-password-123' })).status, 401);
  const code = codeIn(S.dir);
  assert.equal((await anon('POST', '/api/auth/setup', { code, password: 'weak' })).status, 400);
  const ok = await anon('POST', '/api/auth/setup', { code, password: 'good-password-123' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'][0], /^aij_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const c1 = H.cookieFrom(ok);
  assert.equal((await anon('POST', '/api/auth/setup', { code, password: 'good-password-123' })).status, 409);
  assert.equal((await H.call(S.port, 'GET', '/api/config', undefined, { cookie: c1 })).status, 200);
  assert.equal((await H.call(S.port, 'GET', '/admin.html', undefined, { cookie: c1 })).status, 200);
  assert.equal((await anon('POST', '/api/auth/login', { password: 'wrong-password' })).status, 401);
  const c2 = H.cookieFrom(await anon('POST', '/api/auth/login', { password: 'good-password-123' }));
  // 会话列表与撤销
  const list = (await H.call(S.port, 'GET', '/api/auth/sessions', undefined, { cookie: c1 })).json;
  assert.equal(list.sessions.length, 2);
  const other = list.sessions.find(x => x.sid !== list.current);
  const stream = H.sse(S.port, 1500, { cookie: c2 });
  await sleep(300);
  assert.equal((await H.call(S.port, 'DELETE', '/api/auth/sessions/' + other.sid, undefined, { cookie: c1 })).status, 200);
  const sres = await stream;
  assert.equal(sres.status, 200);
  assert.equal((await H.call(S.port, 'GET', '/api/state', undefined, { cookie: c2 })).status, 401, '被撤销的会话立即失效');
  // 改密码：撤销其它会话，旧密码失效
  const c3 = H.cookieFrom(await anon('POST', '/api/auth/login', { password: 'good-password-123' }));
  assert.equal((await H.call(S.port, 'POST', '/api/auth/password', { current: 'nope-nope-nope', next: 'new-password-456' }, { cookie: c1 })).status, 401);
  const ch = await H.call(S.port, 'POST', '/api/auth/password', { current: 'good-password-123', next: 'new-password-456' }, { cookie: c1 });
  assert.equal(ch.status, 200); assert.equal(ch.json.revoked, 1);
  assert.equal((await H.call(S.port, 'GET', '/api/state', undefined, { cookie: c3 })).status, 401);
  assert.equal((await anon('POST', '/api/auth/login', { password: 'good-password-123' })).status, 401);
  assert.equal((await anon('POST', '/api/auth/login', { password: 'new-password-456' })).status, 200);
  // 退出
  const out = await H.call(S.port, 'POST', '/api/auth/logout', undefined, { cookie: c1 });
  assert.equal(out.status, 200); assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await H.call(S.port, 'GET', '/api/state', undefined, { cookie: c1 })).status, 401);
  // 会话持久化：重启后仍有效
  const c4 = H.cookieFrom(await anon('POST', '/api/auth/login', { password: 'new-password-456' }));
  await S.kill();
  const S2 = await H.boot({ dir: S.dir, login: false });
  t.after(S2.stop);
  assert.equal((await H.call(S2.port, 'GET', '/api/config', undefined, { cookie: c4 })).status, 200, '重启后会话仍有效（服务端持久化，只存哈希）');
  assert.ok(fs.readFileSync(path.join(S.dir, 'audit.log'), 'utf8').includes('"login_failed"'));
});

test('登录限流：同一 IP 连续失败后锁定（即使随后输入正确密码）', async t => {
  const S = await H.boot();
  t.after(S.stop);
  const anon = (m, u, b) => H.call(S.port, m, u, b, { cookie: false });
  for (let i = 0; i < 5; i++) assert.equal((await anon('POST', '/api/auth/login', { password: 'wrong-' + i + '-xxxxx' })).status, 401);
  assert.equal((await anon('POST', '/api/auth/login', { password: H.TEST_PASSWORD })).status, 429);
  assert.equal((await H.call(S.port, 'GET', '/api/config')).status, 200, '已登录的会话不受影响');
});

test('大屏观看链接：一次性、只读、可撤销；不能访问工作台数据', async t => {
  const S = await H.boot();
  t.after(S.stop);
  const link = (await S.call('POST', '/api/auth/display-link', { label: '会议室', hours: 4 })).json;
  assert.match(link.path, /^\/\?display=[\w-]+$/);
  const r = await H.call(S.port, 'GET', link.path, undefined, { cookie: false });
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/');
  const dc = H.cookieFrom(r);
  assert.equal((await H.call(S.port, 'GET', link.path, undefined, { cookie: false })).status, 401, '链接只能用一次');
  assert.equal((await H.call(S.port, 'GET', '/', undefined, { cookie: dc })).status, 200, '可以看大屏');
  assert.equal((await H.call(S.port, 'GET', '/audio/sw421k.mp3', undefined, { cookie: dc })).status, 200);
  assert.equal((await H.call(S.port, 'GET', '/admin.html', undefined, { cookie: dc })).status, 302, '不能进管理中心');
  for (const u of ['/api/config', '/api/models', '/api/runs', '/api/auth/sessions']) assert.equal((await H.call(S.port, 'GET', u, undefined, { cookie: dc })).status, 403, u);
  await S.call('POST', '/api/event', { agent: 'hook-z', status: 'start', task: '任务名', text: '模型原文' });
  const ev = await H.sse(S.port, 400, { cookie: dc });
  assert.equal(ev.status, 200);
  const st = (await H.call(S.port, 'GET', '/api/state', undefined, { cookie: dc })).json;
  assert.equal(st.agents.find(a => a.id === 'hook-z').task, '任务名', '观看级别可看任务名');
  const sid = (await S.call('GET', '/api/auth/sessions')).json.sessions.find(x => x.kind === 'display').sid;
  await S.call('DELETE', '/api/auth/sessions/' + sid);
  assert.equal((await H.call(S.port, 'GET', '/api/state', undefined, { cookie: dc })).status, 401, '撤销后立即失效');
});

test('上报凭证与登录会话严格分离；凭证可创建 / 吊销；上报限流', async t => {
  const S = await H.boot({ env: { INGEST_TOKEN: 'env-ingest-token-123456', INGEST_AGENTS: 'hook-a' } });
  t.after(S.stop);
  const ING = { 'x-ingest-token': 'env-ingest-token-123456' };
  const ing = (m, u, b) => H.call(S.port, m, u, b, { cookie: false, headers: ING });
  assert.equal((await ing('POST', '/api/event', { agent: 'hook-a', status: 'start' })).status, 200);
  assert.equal((await ing('POST', '/api/event', { agent: 'hook-x', status: 'start' })).status, 403, '只能用允许的 agentId');
  for (const u of ['/api/state', '/api/events', '/api/config', '/api/models']) assert.equal((await ing('GET', u)).status, 403, u);
  assert.equal((await H.call(S.port, 'GET', '/', undefined, { cookie: false, headers: ING })).status, 302, '上报凭证不能看大屏');
  const c = await S.call('POST', '/api/ingest-tokens', { name: 'office-pc', agents: ['office-ai'] });
  assert.equal(c.status, 200);
  assert.ok(!fs.readFileSync(path.join(S.dir, 'config.json'), 'utf8').includes(c.json.token));
  const T2 = { 'x-ingest-token': c.json.token };
  const rs = await Promise.all(Array.from({ length: 240 }, (_, i) => H.call(S.port, 'POST', '/api/event', { agent: 'office-ai', status: 'stream', clientEventId: 'e' + i }, { cookie: false, headers: T2 })));
  assert.ok(rs.some(r => r.status === 429), '超过突发上限后限流');
  assert.equal((await S.call('DELETE', '/api/ingest-tokens/office-pc')).status, 200);
  assert.equal((await H.call(S.port, 'POST', '/api/event', { agent: 'office-ai', status: 'info' }, { cookie: false, headers: T2 })).status, 401);
  for (let i = 0; i < 8; i++) await H.call(S.port, 'POST', '/api/event', { agent: 'a', status: 'info' }, { cookie: false, headers: { 'x-ingest-token': 'guess-' + i } });
  assert.equal((await ing('POST', '/api/event', { agent: 'hook-a', status: 'info' })).status, 429, '无效凭证过多后锁定该 IP');
});

test('跨站防护：外站 Origin 拒绝；非 JSON 请求体拒绝', async t => {
  const S = await H.boot();
  t.after(S.stop);
  assert.equal((await S.call('POST', '/api/settings', { showText: true }, { headers: { origin: 'https://evil.example' } })).status, 403);
  const r = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: S.port, method: 'POST', path: '/api/settings', headers: { host: 'localhost', cookie: S.cookie, 'content-type': 'text/plain', 'content-length': 2 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.end('{}');
  });
  assert.equal(r, 415);
});

test('部署安全检查：生产模式必须 HTTPS；非本机地址默认拒绝明文监听', async t => {
  const run = env => new Promise(resolve => {
    const ch = require('child_process').spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: '0', AIJ_DATA_DIR: tmp(), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { ch.kill(); resolve({ code: 'running', err }); }, 3000);
    ch.on('close', code => { clearTimeout(timer); resolve({ code, err }); }); // 'close' waits for stderr to drain
  });
  const a = await run({ AIJ_ENV: 'production', HOST: '127.0.0.1' });
  assert.equal(a.code, 1); assert.match(a.err, /必须启用 HTTPS/);
  const b = await run({ HOST: '0.0.0.0' });
  assert.equal(b.code, 1); assert.match(b.err, /拒绝在非本机地址/);
  // 反向代理后的生产模式：HTTP 请求被拒，HTTPS（X-Forwarded-Proto）可用，Cookie 带 Secure，有 HSTS
  const S = await H.boot({ env: { AIJ_ENV: 'production', TRUST_PROXY: '1' }, login: false });
  t.after(S.stop);
  assert.equal((await H.call(S.port, 'GET', '/login.html', undefined, { cookie: false })).status, 403);
  const P = { 'x-forwarded-proto': 'https' };
  const page = await H.call(S.port, 'GET', '/login.html', undefined, { cookie: false, headers: P });
  assert.equal(page.status, 200); assert.match(page.headers['strict-transport-security'], /max-age=/);
  const ok = await H.call(S.port, 'POST', '/api/auth/setup', { code: codeIn(S.dir), password: 'good-password-123' }, { cookie: false, headers: P });
  assert.equal(ok.status, 200); assert.match(ok.headers['set-cookie'][0], /; Secure$/);
});
