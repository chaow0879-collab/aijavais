'use strict';
const path = require('path'), http = require('http'), R = process.argv[2], H = require(path.join(R, 'tests/helpers.js'));
(async () => {
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { s.writeHead(200, { 'content-type': 'text/event-stream' }); s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MOCK 成果内容足够长以通过检查。'.repeat(2) } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } }); const out = {};
  try {
    const c = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', modelId: 'SECRET-MODEL-NAME', displayName: 'SECRET-DISPLAY', pricingMode: 'unknown', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 1.23, outputPerMillion: 4.56 } });
    const cid = c.json.connection.connectionId; await S.call('POST', '/api/models/' + cid + '/test', { approvePaid: true });
    const caps = {};
    for (const v of [undefined, null, '', '  ', 'abc', -1, 0, 1e9, '3']) { const r = await S.call('POST', '/api/v2/users', { username: 'u' + Math.random().toString(36).slice(2, 8), password: 'Aud1t-pass-xyz-123', ...(v === undefined ? {} : { monthlyCapCny: v }) }); caps[JSON.stringify(v) ?? 'omitted'] = r.status + (r.json.code ? ':' + r.json.code : ''); }
    out.cap_validation = caps;
    await S.call('POST', '/api/v2/users', { username: 'leak', password: 'Aud1t-pass-xyz-123', monthlyCapCny: 5 });
    const ck = H.cookieFrom(await H.call(S.port, 'POST', '/api/auth/user-login', { username: 'leak', password: 'Aud1t-pass-xyz-123' }, { cookie: false }));
    const U = (m, u, b) => H.call(S.port, m, u, b, { cookie: ck });
    const me = await U('GET', '/api/v2/me');
    const p = (await U('POST', '/api/v2/projects', { name: 'P', description: 'd', roles: [{ roleId: 'w', name: 'W', duty: 'x', connectionId: cid }], steps: [{ stepId: 's', roleId: 'w', title: 'T', prompt: 'p' }] })).json.project;
    const r = (await U('POST', '/api/v2/projects/' + p.projectId + '/runs', { approvePaid: true, maxCost: 0.05, maxTokens: 20000, maxOutputTokens: 100 })).json.run;
    for (let i = 0; i < 100; i++) { const x = (await U('GET', '/api/v2/runs/' + r.runId)).json.run; if (!x.executionActive && x.status !== 'running') break; await new Promise(z => setTimeout(z, 50)); }
    const run = await U('GET', '/api/v2/runs/' + r.runId), tasks = await U('GET', '/api/v2/tasks'), proj = await U('GET', '/api/v2/projects/' + p.projectId);
    const scan = t => ({ modelId: t.includes('SECRET-MODEL-NAME'), displayName: t.includes('SECRET-DISPLAY'), price_1_23: /1\.23|0\.164/.test(t), connectionId: t.includes(cid), baseUrl_port: t.includes(':' + mock.address().port) });
    out.leak = { me: scan(me.text), run: scan(run.text), tasks: scan(tasks.text), project: scan(proj.text) };
    const f = await U('GET', '/admin.html?x=<script>alert(1)</script>'); out.forbidden = { status: f.status, type: f.headers['content-type'], reflects: f.text.includes('<script>alert') };
    const e = await H.call(S.port, 'GET', '/workspace.html', undefined, { cookie: 'aij_session=deadbeef' }); out.expired_redirect = e.status + ' ' + e.headers.location;
  } finally { await S.stop(); mock.close(); }
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
