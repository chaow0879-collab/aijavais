'use strict';
const path = require('path'), http = require('http'), R = process.argv[2], H = require(path.join(R, 'tests/helpers.js'));
(async () => {
  const body = '第1页 封面\n标题：测试\n第2页 内容\n- 要点一\n- 要点二\n视觉建议：SECRET-NOTE-XYZ\n第3页 总结\n- 结束';
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { s.writeHead(200, { 'content-type': 'text/event-stream' }); s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: body } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } }); const out = {};
  try {
    const c = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', modelId: 'm', displayName: 'm', pricingMode: 'local', capabilities: ['writing'] });
    const id = c.json.connection.connectionId; await S.call('POST', '/api/models/' + id + '/test', {});
    const p = await S.call('POST', '/api/v2/projects', { name: 'Deck', description: '做一个3页PPT', roles: [{ roleId: 'w', name: 'W', duty: 'x', connectionId: id }], steps: [{ stepId: 's', roleId: 'w', title: 'T', prompt: 'p' }] });
    const r = await S.call('POST', '/api/v2/projects/' + p.json.project.projectId + '/runs', { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0 });
    if (!r.json.run) throw Error('start ' + r.status + ' ' + r.text.slice(0, 200)); const runId = r.json.run.runId;
    for (let i = 0; i < 100; i++) { const x = (await S.call('GET', '/api/v2/runs/' + runId)).json.run; if (!x.executionActive && x.status !== 'running') break; await new Promise(z => setTimeout(z, 50)); }
    const link = (await S.call('POST', '/api/auth/display-link', { label: 'a', hours: 1 })).json, dr = await H.call(S.port, 'GET', link.path, undefined, { cookie: false }), dc = H.cookieFrom(dr);
    const u = '/api/v2/runs/' + runId + '/deck';
    const a = await S.call('GET', u), anon = await H.call(S.port, 'GET', u, undefined, { cookie: false }), disp = await H.call(S.port, 'GET', u, undefined, { cookie: dc });
    const nf = await S.call('GET', '/api/v2/runs/nope/deck');
    out.status = { admin: a.status, anon: anon.status, display: disp.status, unknown_run: nf.status };
    out.admin_body = { usable: a.json.usable, pageCount: a.json.pageCount, slides: a.json.slides.map(s => s.layout + ':' + s.title), note_leak: a.text.includes('SECRET-NOTE-XYZ'), keys: Object.keys(a.json.slides[0] || {}) };
    out.display_leak = disp.text.includes('要点一') || disp.text.includes('SECRET'); out.anon_leak = anon.text.includes('要点一');
  } finally { await S.stop(); mock.close(); }
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
