'use strict';
const path = require('path'), http = require('http'), fs = require('fs'), R = process.argv[2], H = require(path.join(R, 'tests/helpers.js'));
const { DatabaseSync } = require('node:sqlite');
(async () => {
  let calls = 0;
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { calls++; s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MOCK 成果内容足够长以通过检查。'.repeat(2) } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } }); const out = {};
  const A = (m, u, b) => S.call(m, u, b);
  try {
    const base = 'http://127.0.0.1:' + mock.address().port + '/v1';
    const mkConn = async (id, test, price) => { const c = await A('POST', '/api/models', { providerId: 'ollama', baseUrl: base, modelId: id, displayName: id, pricingMode: 'unknown', capabilities: ['writing'], price }); const cid = c.json.connection.connectionId; if (test) await A('POST', '/api/models/' + cid + '/test', { approvePaid: true }); return cid; };
    const paid = await mkConn('paid', true, { currency: 'CNY', inputPerMillion: 100000, outputPerMillion: 100000 }); // expensive: ¥0.1 per 1000 tokens
    const untested = await mkConn('untested', false, { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 });
    const disabled = await mkConn('disabled', true, { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 });
    await A('PUT', '/api/models/' + disabled, { enabled: false }); await A('POST', '/api/models/' + disabled, { enabled: false });
    const mkUser = async (name, cap) => (await A('POST', '/api/v2/users', { username: name, password: 'Aud1t-pass-' + name + '-xyz', monthlyCapCny: cap })).json.user;
    const ua = await mkUser('auda', 2), ub = await mkUser('audb', 2);
    const login = async name => { const r = await H.call(S.port, 'POST', '/api/auth/user-login', { username: name, password: 'Aud1t-pass-' + name + '-xyz' }, { cookie: false }); return H.cookieFrom(r); };
    const ca = await login('auda'), cb = await login('audb');
    const U = (ck, m, u, b, h) => H.call(S.port, m, u, b, { cookie: ck, ...(h ? { headers: h } : {}) });
    // 6: back end 403 for users
    const be = {};
    for (const [m, u, b] of [['GET', '/api/models'], ['GET', '/api/settings'], ['POST', '/api/models', { providerId: 'ollama' }], ['POST', '/api/auth/display-link', { label: 'x', hours: 1 }], ['GET', '/api/auth/sessions'], ['GET', '/api/v2/users'], ['POST', '/api/v2/users', { username: 'zz', password: 'x' }], ['GET', '/api/v2/tools'], ['GET', '/api/v2/skills'], ['GET', '/api/v2/usage/system/exceptions'], ['POST', '/api/models/discover', {}], ['GET', '/admin.html'], ['GET', '/capabilities.js'], ['GET', '/project-intake.html'], ['POST', '/api/event', { agent: 'x' }]])
      be[m + ' ' + u] = (await U(ca, m, u, b)).status;
    out.backend_for_user = be;
    out.user_pages = { workspace: (await U(ca, 'GET', '/workspace.html')).status, panel: (await U(ca, 'GET', '/panel.html')).status, root: (await U(ca, 'GET', '/')).status };
    // project for A
    const proj = conn => ({ name: 'P', description: 'd', roles: [{ roleId: 'w', name: 'W', duty: 'x', connectionId: conn }], steps: [{ stepId: 's', roleId: 'w', title: 'T', prompt: 'p' }] });
    const pa = (await U(ca, 'POST', '/api/v2/projects', { ...proj(paid), ownerId: ub.userId })).json.project;
    out.owner_forced = pa.ownerId === ua.userId;
    // 1: user prices overwritten
    const before = calls;
    const r1 = await U(ca, 'POST', '/api/v2/projects/' + pa.projectId + '/runs', { approvePaid: true, maxCost: 0.02, maxTokens: 20000, maxOutputTokens: 100, prices: { [paid]: { inputPerMillion: 0.000001, outputPerMillion: 0.000001 } } });
    const runA = r1.json.run;
    const settle = async (ck, id) => { for (let i = 0; i < 100; i++) { const x = (await U(ck, 'GET', '/api/v2/runs/' + id)).json.run; if (x && !x.executionActive && x.status !== 'running') return x; await new Promise(z => setTimeout(z, 50)); } };
    const ra = runA ? await settle(ca, runA.runId) : null;
    out.price_override = { start: r1.status, used_price: ra && ra.approval && ra.approval.prices && ra.approval.prices[paid], status: ra && ra.status, cost_usd: ra && ra.usage && ra.usage.cost };
    // 2: tools / code
    out.tools = (await U(ca, 'POST', '/api/v2/projects/' + pa.projectId + '/runs', { approvePaid: true, maxCost: 0.01, maxOutputTokens: 100, allowedTools: ['code.run'] })).status;
    out.ext_tools = (await U(ca, 'POST', '/api/v2/projects/' + pa.projectId + '/runs', { approvePaid: true, maxCost: 0.01, maxOutputTokens: 100, approveExternalTools: true })).status;
    out.smoke = runA ? (await U(ca, 'POST', '/api/v2/runs/' + runA.runId + '/delivery-check', { smokeTest: true })).status : null;
    // 3: untested / disabled model
    const me = (await U(ca, 'GET', '/api/v2/me')).json;
    out.me_models = me.models.map(m => m.modelId);
    for (const [k, c] of [['untested', untested], ['disabled', disabled]]) { const p = (await U(ca, 'POST', '/api/v2/projects', proj(c))).json.project; const c0 = calls; const r = await U(ca, 'POST', '/api/v2/projects/' + p.projectId + '/runs', { approvePaid: true, maxCost: 0.01, maxOutputTokens: 100 }); out['run_' + k] = { status: r.status, err: (r.json.error || '').slice(0, 60), new_calls: calls - c0 }; }
    // 5 isolation
    const iso = {};
    iso.project = (await U(cb, 'GET', '/api/v2/projects/' + pa.projectId)).status;
    iso.put = (await U(cb, 'PUT', '/api/v2/projects/' + pa.projectId, { name: 'x' })).status;
    iso.del = (await U(cb, 'DELETE', '/api/v2/projects/' + pa.projectId)).status;
    if (runA) { iso.run = (await U(cb, 'GET', '/api/v2/runs/' + runA.runId)).status; iso.deck = (await U(cb, 'GET', '/api/v2/runs/' + runA.runId + '/deck')).status; iso.cancel = (await U(cb, 'POST', '/api/v2/runs/' + runA.runId + '/cancel', {})).status;
      const arts = ra.artifacts || []; if (arts[0]) iso.artifact = (await U(cb, 'GET', '/api/v2/runs/' + runA.runId + '/artifacts/' + arts[0].artifactId + '/download')).status; }
    iso.list_b = (await U(cb, 'GET', '/api/v2/projects')).json.projects.length;
    iso.tasks_b = (await U(cb, 'GET', '/api/v2/tasks')).json.tasks.length;
    out.isolation = iso;
    // 4 delete with runs
    out.delete_with_runs = (await U(ca, 'DELETE', '/api/v2/projects/' + pa.projectId)).status;
    // 5 quota: B cap 2 -> two parallel starts at 1.5 each (USD 0.2 = ¥1.5)
    const pb1 = (await U(cb, 'POST', '/api/v2/projects', proj(paid))).json.project, pb2 = (await U(cb, 'POST', '/api/v2/projects', proj(paid))).json.project;
    const appr = { approvePaid: true, maxCost: 0.2, maxTokens: 20000, maxOutputTokens: 100 };
    const [q1, q2] = await Promise.all([U(cb, 'POST', '/api/v2/projects/' + pb1.projectId + '/runs', appr), U(cb, 'POST', '/api/v2/projects/' + pb2.projectId + '/runs', appr)]);
    out.parallel_quota = [q1.status, q2.status];
    const over = await U(cb, 'POST', '/api/v2/projects/' + pb2.projectId + '/runs', { ...appr, maxCost: 10 });
    out.over_cap = over.status;
    // 5b old-run rework bypass: A's runA (review_required) is moved to last month in SQLite; A then spends the whole cap this month; then reworks runA
    if (runA && ra.status === 'review_required') {
      const dbFile = path.join(S.dir, 'projects.sqlite'), db = new DatabaseSync(dbFile);
      const old = Date.now() - 40 * 86400e3; db.prepare('UPDATE runs SET created_at=? WHERE id=?').run(old, runA.runId); db.close();
      const pa2 = (await U(ca, 'POST', '/api/v2/projects', proj(paid))).json.project;
      const meBefore = (await U(ca, 'GET', '/api/v2/me')).json.me.month;
      const big = await U(ca, 'POST', '/api/v2/projects/' + pa2.projectId + '/runs', { approvePaid: true, maxCost: 0.25, maxTokens: 20000, maxOutputTokens: 100 }); // ¥1.875 of ¥2
      const mid = (await U(ca, 'GET', '/api/v2/me')).json.me.month;
      const c0 = calls;
      const rw = await U(ca, 'POST', '/api/v2/runs/' + runA.runId + '/review', { decision: 'rework', feedback: '再改', approvePaid: true, maxCost: 0.25, maxTokens: 20000, maxOutputTokens: 100 });
      const after = (await U(ca, 'GET', '/api/v2/me')).json.me.month;
      out.old_run_rework = { cap: 2, month_before: meBefore, new_run: big.status, month_after_new_run: mid, rework_status: rw.status, rework_err: (rw.json && rw.json.error || '').slice(0, 60), month_after_rework: after, provider_calls_added_by_rework: calls - c0 };
    } else out.old_run_rework = 'runA not review_required: ' + (ra && ra.status);
  } finally { await S.stop(); mock.close(); }
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
