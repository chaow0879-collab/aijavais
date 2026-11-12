'use strict';
/* B8 前后台分离：real server.js + SQLite + a LOCAL MOCK model (no paid API, no real money).
 * - users get 403 on every back-end page and interface; admin features unchanged
 * - users never see each other's projects / runs / files / artifacts
 * - the monthly CNY cap is enforced on the server (start and rework), conservatively for runs still executing */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');

const PASS = 'user-password-123';
function mockModel() {
  let hold = false; const held = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const send = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: j.max_tokens <= 32 ? '好' : '这是一份完整的测试成果，内容足够长，可以通过最少字数检查。' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); };
      if (hold && j.max_tokens > 32) held.push(send); else send();
    });
  });
  return { server, hold: v => { hold = v; }, release: () => { while (held.length) held.shift()(); } };
}
const project = (name, connectionId) => ({ name, description: name, roles: [{ roleId: 'w', name: '写手', duty: '写', standard: '可读', connectionId }],
  steps: [{ stepId: 's1', roleId: 'w', title: '写出初稿', prompt: '写' }] });
const waitRun = async (call, runId, done = r => !['running', 'queued'].includes(r.status) && !r.executionActive) => {
  for (let i = 0; i < 100; i++) { const r = (await call('GET', '/api/v2/runs/' + runId)).json.run; if (r && done(r)) return r; await new Promise(x => setTimeout(x, 50)); }
  throw new Error('run did not settle');
};

test('B8: two account types, 403 on the back end, per-user isolation, monthly CNY cap', async t => {
  const M = mockModel();
  await new Promise(r => M.server.listen(0, '127.0.0.1', r)); t.after(() => M.server.close());
  const mp = M.server.address().port;
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } }); t.after(S.stop);
  const admin = S.call;

  /* ---- admin: models (one free local, one priced "paid" mock at ¥1 per million tokens) and two users ---- */
  const local = (await admin('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing'] })).json.connection.connectionId;
  assert.equal((await admin('POST', '/api/models/' + local + '/test', {})).json.ok, true);
  const paidAdd = await admin('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } });
  assert.equal(paidAdd.status, 200, paidAdd.text); const paid = paidAdd.json.connection.connectionId;
  assert.equal((await admin('POST', '/api/models/' + paid + '/test', { approvePaid: true })).json.ok, true);
  const untested = (await admin('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'never-tested', pricingMode: 'local', capabilities: ['writing'] })).json.connection.connectionId;
  const mkUser = async (username, cap) => { const r = await admin('POST', '/api/v2/users', { username, password: PASS, monthlyCapCny: cap }); assert.equal(r.status, 201, r.text); return r.json.user; };
  const alice = await mkUser('alice', 1), bob = await mkUser('bob', 10);
  assert.equal(JSON.stringify((await admin('GET', '/api/v2/users')).json).includes('salt'), false, 'password records never leave the server');
  assert.equal((await admin('POST', '/api/v2/users', { username: 'Alice', password: PASS, monthlyCapCny: 1 })).status, 409);

  /* ---- separate logins ---- */
  const anon = (m, u, b) => S.call(m, u, b, { cookie: false });
  assert.equal((await anon('POST', '/api/auth/user-login', { username: 'alice', password: 'wrong-password-1' })).status, 401);
  assert.equal((await anon('POST', '/api/auth/user-login', { username: 'admin', password: H.TEST_PASSWORD })).status, 401, 'the admin password is not a user login');
  const login = async name => { const r = await anon('POST', '/api/auth/user-login', { username: name, password: PASS }); assert.equal(r.status, 200, r.text); return r.headers['set-cookie'][0].split(';')[0]; };
  const aCookie = await login('alice'), bCookie = await login('bob');
  assert.match((await anon('POST', '/api/auth/user-login', { username: 'alice', password: PASS })).headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const A = (m, u, b) => S.call(m, u, b, { cookie: aCookie }), B = (m, u, b) => S.call(m, u, b, { cookie: bCookie });
  assert.deepEqual([(await A('GET', '/api/auth/status')).json.kind, (await A('GET', '/api/auth/status')).json.username], ['user', 'alice']);

  /* ---- 403 matrix: every back-end page and interface ---- */
  for (const u of ['/admin.html', '/admin', '/capabilities.html', '/project-intake.html', '/capabilities.js', '/project-intake/app.js', '/haloflux-workbench-r52/index.html']) {
    assert.equal((await A('GET', u)).status, 403, 'page ' + u);
  }
  const page403 = await A('GET', '/admin.html'), js403 = await A('GET', '/capabilities.js');
  assert.match(page403.headers['content-type'], /text\/html/); assert.match(page403.text, /href="\/workspace\.html"[^>]*>回到我的任务/, 'P3-2: readable 403 page with a way back');
  assert.match(js403.headers['content-type'], /text\/plain/, 'scripts keep a plain 403');
  for (const u of ['/workspace.html', '/panel.html', '/topbar.js', '/role.js', '/workspace-simple.js', '/smart-plan.js']) assert.equal((await A('GET', u)).status, 200, 'front ' + u);
  assert.equal((await A('GET', '/')).headers.location, '/workspace.html');
  const backend = [['GET', '/api/config'], ['GET', '/api/catalog'], ['GET', '/api/models'], ['POST', '/api/models'], ['POST', '/api/models/batch'], ['POST', '/api/models/discover'], ['POST', '/api/models/probe'],
    ['GET', '/api/models/' + paid], ['POST', '/api/models/' + paid + '/test'], ['DELETE', '/api/models/' + paid], ['POST', '/api/providers/' + paid + '/test'], ['POST', '/api/settings'],
    ['GET', '/api/teams'], ['POST', '/api/teams'], ['GET', '/api/team-templates'], ['POST', '/api/recommend'], ['GET', '/api/ingest-tokens'], ['POST', '/api/ingest-tokens'],
    ['GET', '/api/auth/sessions'], ['POST', '/api/auth/password'], ['POST', '/api/auth/logout-all'], ['POST', '/api/auth/display-link'], ['POST', '/api/demo'], ['POST', '/api/run'], ['GET', '/api/runs'],
    ['GET', '/api/v2/users'], ['POST', '/api/v2/users'], ['POST', '/api/v2/users/' + bob.userId], ['POST', '/api/v2/users/' + bob.userId + '/password'],
    ['GET', '/api/v2/health'], ['GET', '/api/v2/tools'], ['POST', '/api/v2/tools/discover'], ['POST', '/api/v2/tools/call'], ['POST', '/api/v2/tools/call/prepare'], ['GET', '/api/v2/skills'], ['POST', '/api/v2/skills'],
    ['GET', '/api/v2/mcp'], ['POST', '/api/v2/mcp/servers'], ['GET', '/api/v2/capabilities'], ['GET', '/api/v2/readiness'], ['GET', '/api/v2/usage/system'], ['GET', '/api/v2/usage/system/exceptions'],
    ['POST', '/api/v2/intake/plan'], ['POST', '/api/v2/intake/projects'], ['POST', '/api/v2/intake/ai-draft'], ['POST', '/api/v2/intake/ai-draft/estimate'], ['GET', '/api/v2/intake/ai-draft/status'],
    ['POST', '/api/v2/universal/plan'], ['POST', '/api/v2/universal/projects'], ['GET', '/api/v2/no-such-endpoint']];
  for (const [m, u] of backend) {
    const r = await A(m, u, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, m + ' ' + u + ' -> ' + r.status);
    assert.match(r.json.error, /管理后台/);
  }
  assert.equal((await A('GET', '/api/state')).json.providers.length, 0, 'live state for a user is anonymous-level (no model list)');
  const sse = await H.sse(S.port, 300, { cookie: aCookie });
  assert.equal(sse.status, 200);
  assert.ok(sse.evs.every(e => e.taskId === undefined && e.runId === undefined && e.task === undefined), 'no task titles or IDs in the user live stream');

  /* ---- front: what a user may read ---- */
  const me = (await A('GET', '/api/v2/me')).json;
  assert.equal(me.me.kind, 'user'); assert.equal(me.me.month.capCny, 1);
  assert.deepEqual(me.models.map(x => x.connectionId).sort(), [local, paid].sort(), 'only models the administrator has tested');
  assert.ok(!me.models.some(x => x.connectionId === untested));
  assert.ok(me.models.every(x => !('keyHint' in x) && !('hasKey' in x) && !('envKey' in x) && !('notes' in x)), 'no credential fields');
  assert.ok(me.settings.simpleRunCapCny > 0);
  assert.equal((await A('GET', '/api/v2/tasks')).json.me.kind, 'user');
  assert.equal((await admin('GET', '/api/v2/tasks')).json.me.kind, 'admin');

  /* ---- isolation ---- */
  const ap = (await A('POST', '/api/v2/projects', project('alice-task', local))).json.project;
  const ar = await A('POST', '/api/v2/projects/' + ap.projectId + '/runs', {});
  assert.equal(ar.status, 202, ar.text);
  const arun = await waitRun(A, ar.json.run.runId);
  const art = (await A('GET', '/api/v2/runs/' + arun.runId)).json.run.artifacts[0];
  assert.ok(art, 'alice has a real artifact');
  assert.equal((await A('GET', art.downloadUrl)).status, 200);
  assert.deepEqual((await B('GET', '/api/v2/projects')).json.projects, []);
  assert.deepEqual((await B('GET', '/api/v2/tasks')).json.tasks, []);
  for (const [m, u] of [['GET', '/api/v2/projects/' + ap.projectId], ['PUT', '/api/v2/projects/' + ap.projectId], ['DELETE', '/api/v2/projects/' + ap.projectId], ['POST', '/api/v2/projects/' + ap.projectId + '/runs'],
    ['POST', '/api/v2/projects/' + ap.projectId + '/validate'], ['GET', '/api/v2/projects/' + ap.projectId + '/files'], ['GET', '/api/v2/runs/' + arun.runId], ['GET', '/api/v2/runs/' + arun.runId + '/deck'],
    ['POST', '/api/v2/runs/' + arun.runId + '/cancel'], ['POST', '/api/v2/runs/' + arun.runId + '/review'], ['POST', '/api/v2/runs/' + arun.runId + '/export'], ['GET', '/api/v2/runs/' + arun.runId + '/delivery-check'],
    ['GET', art.downloadUrl]]) {
    const r = await B(m, u, m === 'GET' ? undefined : {});
    assert.equal(r.status, 404, 'bob ' + m + ' ' + u + ' -> ' + r.status);
  }
  assert.equal((await A('GET', '/api/v2/projects')).json.projects.length, 1);
  assert.equal((await admin('GET', '/api/v2/projects')).json.projects.length, 1, 'the administrator still sees everything');
  assert.equal((await admin('GET', '/api/v2/runs/' + arun.runId)).status, 200);
  assert.equal((await A('DELETE', '/api/v2/projects/' + ap.projectId)).status, 409, 'a run project keeps its spend: user cannot delete it');
  assert.equal((await A('POST', '/api/v2/projects/' + ap.projectId + '/runs', { allowedTools: ['builtin:text-stats'] })).status, 403, 'users cannot grant tools');

  /* ---- monthly cap (alice ¥1). The engine ledger is USD; the page converts at 7.5 ---- */
  const pp = (await A('POST', '/api/v2/projects', project('alice-paid', paid))).json.project;
  const usd = cny => cny / 7.5;
  const over = await A('POST', '/api/v2/projects/' + pp.projectId + '/runs', { approvePaid: true, maxCost: usd(2), maxTokens: 20000, prices: { [paid]: { inputPerMillion: 0.0000001, outputPerMillion: 0.0000001, currency: 'USD' } } });
  assert.equal(over.status, 402); assert.equal(over.json.code, 'monthly_quota_insufficient'); assert.match(over.json.error, /^本月额度只剩 ¥1\.00，这次最多要花 ¥2\.00/);
  M.hold(true);
  const ok = await A('POST', '/api/v2/projects/' + pp.projectId + '/runs', { approvePaid: true, maxCost: usd(0.9), maxTokens: 20000, prices: { [paid]: { inputPerMillion: 0.0000001, outputPerMillion: 0.0000001, currency: 'USD' } } });
  assert.equal(ok.status, 202, ok.text);
  const held = (await A('GET', '/api/v2/runs/' + ok.json.run.runId)).json.run;
  assert.equal(held.approval.prices[paid].inputPerMillion, 1 / 7.5, 'server prices replace the rates the user sent');
  assert.equal((await A('GET', '/api/v2/me')).json.me.month.spentCny, 0.9, 'a run still executing counts its whole approved ceiling');
  const second = await A('POST', '/api/v2/projects/' + pp.projectId + '/runs', { approvePaid: true, maxCost: usd(0.2), maxTokens: 20000 });
  assert.equal(second.status, 402); assert.match(second.json.error, /^本月额度只剩 ¥0\.10/);
  M.release(); M.hold(false);
  const done = await waitRun(A, ok.json.run.runId);
  assert.ok(done.usage.cost > 0, 'the priced mock recorded a (mock) cost');
  const spent = (await A('GET', '/api/v2/me')).json.me.month.spentCny;
  assert.ok(spent > 0 && spent < 0.9, 'after it settles only the recorded cost stays: ' + spent);
  const u1 = (await admin('GET', '/api/v2/users')).json.users.find(u => u.userId === alice.userId);
  assert.equal(u1.month.spentCny, spent, 'admin sees the same month spend');
  await admin('POST', '/api/v2/users/' + alice.userId, { monthlyCapCny: spent }); // the administrator lowers the cap to exactly what was spent
  const refused = await A('POST', '/api/v2/projects/' + pp.projectId + '/runs', { approvePaid: true, maxCost: usd(0.01), maxTokens: 20000 });
  assert.equal(refused.status, 402); assert.equal(refused.json.error, '本月额度已用完，请联系管理员');
  const rework = await A('POST', '/api/v2/runs/' + done.runId + '/review', { decision: 'rework', feedback: '再改改', approvePaid: true, maxCost: usd(0.01), maxTokens: 20000 });
  assert.equal(rework.status, 402, 'rework is a new paid round: same cap'); assert.equal(rework.json.error, '本月额度已用完，请联系管理员');
  assert.equal((await B('POST', '/api/v2/projects/' + (await B('POST', '/api/v2/projects', project('bob-paid', paid))).json.project.projectId + '/runs', { approvePaid: true, maxCost: usd(0.5), maxTokens: 20000 })).status, 202, 'bob has his own quota');

  /* ---- disable / reset password revoke sessions at once; admin features keep working ---- */
  assert.equal((await admin('POST', '/api/v2/users/' + bob.userId, { enabled: false })).json.user.enabled, false);
  assert.equal((await B('GET', '/api/v2/projects')).status, 401, 'disabled user is logged out');
  assert.equal((await B('GET', '/workspace.html')).headers.location, '/login.html?next=%2Fworkspace.html&expired=1', 'P3-4: the login page is told why');
  assert.equal((await anon('GET', '/workspace.html')).headers.location, '/login.html?next=%2Fworkspace.html', 'no cookie: plain redirect');
  assert.equal((await anon('POST', '/api/auth/user-login', { username: 'bob', password: PASS })).status, 401);
  await admin('POST', '/api/v2/users/' + alice.userId + '/password', { password: 'new-password-456' });
  assert.equal((await A('GET', '/api/v2/me')).status, 401, 'password reset ends the old session');
  assert.equal((await anon('POST', '/api/auth/user-login', { username: 'alice', password: 'new-password-456' })).status, 200);
  for (const [m, u] of [['GET', '/api/config'], ['GET', '/api/models'], ['GET', '/api/v2/tools'], ['GET', '/api/v2/capabilities'], ['GET', '/api/auth/sessions'], ['GET', '/admin.html'], ['GET', '/capabilities.html']]) {
    assert.equal((await admin(m, u)).status, 200, 'admin ' + m + ' ' + u);
  }
});

test('B8 AUD-C159-01: reworking last month\'s run counts in this month; a concurrent rework + new run cannot pass the cap together', async t => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const { monthStart } = require('../lib/users');
  const M = mockModel();
  await new Promise(r => M.server.listen(0, '127.0.0.1', r)); t.after(() => M.server.close());
  const mp = M.server.address().port;
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } }); t.after(S.stop);
  const admin = S.call;
  const paid = (await admin('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'priced-writer', pricingMode: 'paid_api', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } })).json.connection.connectionId;
  assert.equal((await admin('POST', '/api/models/' + paid + '/test', { approvePaid: true })).json.ok, true);
  const carol = (await admin('POST', '/api/v2/users', { username: 'carol', password: PASS, monthlyCapCny: 2 })).json.user;
  const ck = (await S.call('POST', '/api/auth/user-login', { username: 'carol', password: PASS }, { cookie: false })).headers['set-cookie'][0].split(';')[0];
  const C = (m, u, b) => S.call(m, u, b, { cookie: ck });
  const usd = cny => cny / 7.5, body = cny => ({ approvePaid: true, maxCost: usd(cny), maxTokens: 20000 });
  const p = (await C('POST', '/api/v2/projects', { ...project('carol-paid', paid), maxReworks: 2 })).json.project;
  const first = await C('POST', '/api/v2/projects/' + p.projectId + '/runs', body(1.6));
  assert.equal(first.status, 202, first.text);
  const old = await waitRun(C, first.json.run.runId);
  assert.equal(old.status, 'review_required');
  // the run and its billing happened last month
  const lastMonth = monthStart(Date.now()) - 10 * 86400e3;
  const db = new DatabaseSync(path.join(S.dir, 'projects.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare("UPDATE runs SET created_at=?, doc=json_set(doc,'$.createdAt',?) WHERE id=?").run(lastMonth, lastMonth, old.runId);
  db.prepare("UPDATE usage_ledger SET created_at=?, doc=json_set(doc,'$.createdAt',?) WHERE run_id=?").run(lastMonth, lastMonth, old.runId);
  db.close();
  assert.equal((await C('GET', '/api/v2/me')).json.me.month.spentCny, 0, 'last month\'s billing is not this month\'s');
  // audit counterexample, concurrent: rework ¥1.875 on the old run + a new run ¥1.875 under a ¥2 cap
  M.hold(true);
  const [rw, nr] = await Promise.all([
    C('POST', '/api/v2/runs/' + old.runId + '/review', { decision: 'rework', feedback: '再改改', ...body(1.875) }),
    C('POST', '/api/v2/projects/' + p.projectId + '/runs', body(1.875))]);
  assert.deepEqual([rw.status, nr.status].map(s => s === 402 ? 402 : 'ok').sort(), [402, 'ok'].sort(), 'exactly one of them passes: ' + rw.status + '/' + nr.status);
  const refused = rw.status === 402 ? rw : nr;
  assert.equal(refused.json.code, 'monthly_quota_insufficient'); assert.match(refused.json.error, /^本月额度只剩 ¥0\.12/);
  assert.equal((await C('GET', '/api/v2/me')).json.me.month.spentCny, 1.88, 'the running round counts its whole approved ceiling this month');
  if (rw.status !== 402) {
    // the rework is running: a new run is refused too
    const again = await C('POST', '/api/v2/projects/' + p.projectId + '/runs', body(0.2));
    assert.equal(again.status, 402); assert.match(again.json.error, /^本月额度只剩 ¥0\.12/);
  } else {
    // the new run is running: the rework is refused on its own as well
    const again = await C('POST', '/api/v2/runs/' + old.runId + '/review', { decision: 'rework', feedback: '再改改', ...body(0.2) });
    assert.equal(again.status, 402); assert.match(again.json.error, /^本月额度只剩 ¥0\.12/);
  }
  M.release(); M.hold(false);
  const settled = await waitRun(C, (rw.status !== 402 ? rw.json.run : nr.json.run).runId);
  const spent = (await C('GET', '/api/v2/me')).json.me.month.spentCny;
  assert.ok(spent > 0 && spent < 1.88, 'after it settles only the cost recorded this month stays: ' + spent);
  assert.equal((await admin('GET', '/api/v2/users')).json.users.find(u => u.userId === carol.userId).month.spentCny, spent);
  void settled;
});
