'use strict';
const path = require('path'), http = require('http'), R = process.argv[2], H = require(path.join(R, 'tests/helpers.js'));
const { DatabaseSync } = require('node:sqlite');
(async () => {
  let calls = 0, delay = 0;
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { calls++; setTimeout(() => { s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MOCK 成果内容足够长以通过检查。'.repeat(2) } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'); }, delay); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } }); const out = {};
  try {
    const c = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', modelId: 'cheap', displayName: 'cheap', pricingMode: 'unknown', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } });
    const cid = c.json.connection.connectionId; await S.call('POST', '/api/models/' + cid + '/test', { approvePaid: true });
    for (const n of ['qa', 'qb']) await S.call('POST', '/api/v2/users', { username: n, password: 'Aud1t-pass-' + n + '-xyz', monthlyCapCny: 2 });
    const login = async n => H.cookieFrom(await H.call(S.port, 'POST', '/api/auth/user-login', { username: n, password: 'Aud1t-pass-' + n + '-xyz' }, { cookie: false }));
    const ca = await login('qa'), cb = await login('qb');
    const U = (ck, m, u, b) => H.call(S.port, m, u, b, { cookie: ck });
    const proj = { name: 'P', description: 'd', roles: [{ roleId: 'w', name: 'W', duty: 'x', connectionId: cid }], steps: [{ stepId: 's', roleId: 'w', title: 'T', prompt: 'p' }] };
    const newP = async ck => (await U(ck, 'POST', '/api/v2/projects', proj)).json.project.projectId;
    const settle = async (ck, id) => { for (let i = 0; i < 200; i++) { const x = (await U(ck, 'GET', '/api/v2/runs/' + id)).json.run; if (x && !x.executionActive && x.status !== 'running') return x; await new Promise(z => setTimeout(z, 50)); } };
    const appr = usd => ({ approvePaid: true, maxCost: usd, maxTokens: 20000, maxOutputTokens: 100 });
    // A: parallel starts while runs stay active (mock delays 3 s): cap ¥2, each ¥1.5
    delay = 3000;
    const [p1, p2] = [await newP(cb), await newP(cb)];
    const [q1, q2] = await Promise.all([U(cb, 'POST', '/api/v2/projects/' + p1 + '/runs', appr(0.2)), U(cb, 'POST', '/api/v2/projects/' + p2 + '/runs', appr(0.2))]);
    out.parallel_active = { statuses: [q1.status, q2.status], month: (await U(cb, 'GET', '/api/v2/me')).json.me.month };
    delay = 0;
    // B: old-run rework bypass for qa (cap ¥2)
    const pa = await newP(ca); const r = (await U(ca, 'POST', '/api/v2/projects/' + pa + '/runs', appr(0.2))).json.run; const ra = await settle(ca, r.runId);
    out.runA_status = ra.status;
    const db = new DatabaseSync(path.join(S.dir, 'projects.sqlite')); db.prepare('UPDATE runs SET created_at=? WHERE id=?').run(Date.now() - 40 * 86400e3, r.runId); db.close();
    out.month_after_moving_runA = (await U(ca, 'GET', '/api/v2/me')).json.me.month;
    delay = 3000;
    const c0 = calls;
    const rw = await U(ca, 'POST', '/api/v2/runs/' + r.runId + '/review', { decision: 'rework', feedback: '再改', ...appr(0.25), expectedRound: ra.round });
    const afterRw = (await U(ca, 'GET', '/api/v2/me')).json.me.month;
    const pa2 = await newP(ca); const big = await U(ca, 'POST', '/api/v2/projects/' + pa2 + '/runs', appr(0.25));
    const afterNew = (await U(ca, 'GET', '/api/v2/me')).json.me.month;
    await new Promise(z => setTimeout(z, 300));
    const runNow = (await U(ca, 'GET', '/api/v2/runs/' + r.runId)).json.run;
    out.old_run_rework_first = { cap_cny: 2, rework_status: rw.status, rework_round_maxCost_usd: runNow.approval && runNow.approval.maxCost, rework_run_status: runNow.status,
      month_after_rework: afterRw, new_run_status: big.status, month_after_new_run: afterNew, provider_calls_started: calls - c0,
      approved_total_cny_this_month: +((0.25 + 0.25) * 7.5).toFixed(3) };
    // C: same thing but runA stays in this month (control)
    await new Promise(z => setTimeout(z, 3500));
  } finally { await S.stop(); mock.close(); }
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
