'use strict';
const path = require('path'), http = require('http'), fs = require('fs'), R = process.argv[2];
const H = require(path.join(R, 'tests/helpers.js'));
const { DatabaseSync } = require('node:sqlite');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let hold = false, held = [];
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { const send = () => { s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '足够长的成果文字。'.repeat(4) } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'); };
    if (hold) held.push(send); else send(); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const env = { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port };
  let S = await H.boot({ env }); const dir = S.dir; const out = {};
  const A = (m, u, b) => S.call(m, u, b);
  try {
    const base = 'http://127.0.0.1:' + mock.address().port + '/v1';
    const local = (await A('POST', '/api/models', { providerId: 'ollama', baseUrl: base, modelId: 'loc', displayName: 'loc', pricingMode: 'local', capabilities: ['writing'] })).json.connection.connectionId;
    await A('POST', '/api/models/' + local + '/test', {});
    const paid = (await A('POST', '/api/models', { providerId: 'ollama', baseUrl: base, modelId: 'pd', displayName: 'pd', pricingMode: 'unknown', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 } })).json.connection.connectionId;
    await A('POST', '/api/models/' + paid + '/test', { approvePaid: true });
    const mkUser = async (name, cap) => (await A('POST', '/api/v2/users', { username: name, password: 'Aud1t-pass-' + name + '-xyz', monthlyCapCny: cap })).json.user;
    for (const n of ['da', 'db', 'dc', 'dd']) await mkUser(n, 50);
    const login = async (name, port = S.port) => H.cookieFrom(await H.call(port, 'POST', '/api/auth/user-login', { username: name, password: 'Aud1t-pass-' + name + '-xyz' }, { cookie: false }));
    let ck = {}; for (const n of ['da', 'db', 'dc', 'dd']) ck[n] = await login(n);
    const U = (c, m, u, b) => H.call(S.port, m, u, b, { cookie: c });
    const draft = (desc = '还没开始的新任务，正在上传资料。') => ({ name: '新任务（正在准备资料）', description: desc, roles: [{ roleId: 'drafter', name: '起草员', duty: 'x' }], steps: [{ stepId: 'draft', roleId: 'drafter', title: 'x' }], materials: { mode: 'all' } });
    // 1. draft limit: sequential and concurrent
    const seq = []; for (let i = 0; i < 21; i++) seq.push((await U(ck.da, 'POST', '/api/v2/projects', draft())).status);
    out.draft_seq = { created: seq.filter(s => s === 201).length, last: seq.at(-1) };
    const par = await Promise.all(Array.from({ length: 30 }, () => U(ck.db, 'POST', '/api/v2/projects', draft())));
    out.draft_concurrent30 = { created: par.filter(r => r.status === 201).length, rejected: par.filter(r => r.status === 429).length };
    // 2. storage limit: fill user dc with PNGs to ~ 248 MB, then 6 concurrent 8 MB PDFs (pdftotext is async)
    const png = Buffer.alloc(8 * 1024 * 1024 - 64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const pngB64 = png.toString('base64');
    const projs = []; for (let i = 0; i < 4; i++) projs.push((await U(ck.dc, 'POST', '/api/v2/projects', draft())).json.project.projectId);
    let filled = 0, k = 0;
    while (filled + png.length <= 248 * 1024 * 1024) { const p = projs[Math.floor(k / 7)]; const r = await U(ck.dc, 'POST', `/api/v2/projects/${p}/files`, { filename: `f${k}.png`, contentBase64: pngB64 }); if (r.status !== 201) { out.fill_err = r.status + ':' + (r.json.code || ''); break; } filled += png.length; k++; }
    out.filled_mb = +(filled / 1048576).toFixed(1);
    const pdfHead = fs.readFileSync(path.join(__dirname, 'b9files/pdf.bin'));
    const pdf = Buffer.concat([pdfHead, Buffer.alloc(7 * 1024 * 1024, 0x20)]);
    const p5 = (await U(ck.dc, 'POST', '/api/v2/projects', draft())).json.project.projectId;
    const p6 = (await U(ck.dc, 'POST', '/api/v2/projects', draft())).json.project.projectId;
    const conc = await Promise.all(Array.from({ length: 6 }, (_, i) => U(ck.dc, 'POST', `/api/v2/projects/${i < 3 ? p5 : p6}/files`, { filename: `c${i}.pdf`, contentBase64: pdf.toString('base64') })));
    const after = (() => { const d = new DatabaseSync(path.join(dir, 'projects.sqlite'), { readOnly: true }); try { return Number(d.prepare("SELECT SUM(length(f.content)) b FROM project_files f JOIN projects p ON p.id=f.project_id WHERE p.owner_id=(SELECT id FROM users WHERE username='dc')").get().b); } finally { d.close(); } })();
    out.storage_concurrent = { pdfMB: +(pdf.length / 1048576).toFixed(2), statuses: conc.map(r => r.status + ':' + (r.json.code || '')), totalMB: +(after / 1048576).toFixed(1), capMB: 256 };
    const seqTry = await U(ck.dc, 'POST', `/api/v2/projects/${p6}/files`, { filename: 'x.pdf', contentBase64: pdf.toString('base64') });
    out.storage_seq_after = seqTry.status + ':' + (seqTry.json.code || '');
    // 3. expiry boundaries
    const mk = async (c, body) => (await U(c, 'POST', '/api/v2/projects', body)).json.project.projectId;
    const ids = {};
    ids.userDraftOld = await mk(ck.dd, draft());
    ids.userDraftOldButRecentFile = await mk(ck.dd, draft());
    ids.userCustomOld = await mk(ck.dd, { ...draft('用户自己写的说明'), name: '我的' });
    ids.userRunOld = await mk(ck.dd, { name: 'R', description: 'r', roles: [{ roleId: 'w', name: 'W', duty: 'x', connectionId: local }], steps: [{ stepId: 's', roleId: 'w', title: 'T', prompt: 'p' }] });
    const run = await U(ck.dd, 'POST', `/api/v2/projects/${ids.userRunOld}/runs`, { maxTokens: 20000, maxOutputTokens: 100 });
    out.run_start = run.status;
    ids.userDraftRecent = await mk(ck.dd, draft());
    ids.adminCustomOld = (await A('POST', '/api/v2/projects', { ...draft('管理员自配项目'), name: 'admin' })).json.project.projectId;
    ids.adminPlaceholderOld = (await A('POST', '/api/v2/projects', draft())).json.project.projectId;
    await U(ck.dd, 'POST', `/api/v2/projects/${ids.userDraftOld}/files`, { filename: 'a.txt', contentBase64: Buffer.from('old').toString('base64') });
    await sleep(800);
    await S.kill();
    const old = Date.now() - 40 * 86400e3;
    { const w = new DatabaseSync(path.join(dir, 'projects.sqlite'));
      for (const k of ['userDraftOld', 'userDraftOldButRecentFile', 'userCustomOld', 'userRunOld', 'adminCustomOld', 'adminPlaceholderOld']) { w.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(old, ids[k]); w.prepare('UPDATE project_files SET created_at=? WHERE project_id=?').run(old, ids[k]); }
      w.prepare("INSERT INTO project_files SELECT 'recentf', ?, ?, sha256, metadata, content, text FROM project_files WHERE project_id=?").run(ids.userDraftOldButRecentFile, Date.now(), ids.userDraftOld);
      w.close(); }
    S = await H.boot({ env, dir });
    const d = new DatabaseSync(path.join(dir, 'projects.sqlite'), { readOnly: true });
    out.expiry = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, d.prepare('SELECT 1 FROM projects WHERE id=?').get(id) ? 'kept' : 'deleted']));
    out.orphan_files = Number(d.prepare('SELECT count(*) n FROM project_files WHERE project_id NOT IN (SELECT id FROM projects)').get().n);
    d.close();
    // restart again: idempotent
    await S.kill(); S = await H.boot({ env, dir }); out.second_restart_ok = (await S.call('GET', '/api/v2/tasks')).status;
    // 4. exceptions view: user clarify call left unknown
    ck = {}; for (const n of ['da']) ck[n] = await login(n);
    hold = true;
    const ac = new AbortController();
    const pa = fetch(`http://127.0.0.1:${S.port}/api/v2/intake/clarify`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json', cookie: ck.da, origin: `http://127.0.0.1:${S.port}` },
      body: JSON.stringify({ goal: '秘密需求内容-ABC 写一份方案', output: 'Word', connectionId: paid, approvePaid: true, maxCost: 0.05 }) }).catch(e => e.name);
    await sleep(600); ac.abort(); await pa; await sleep(300); hold = false; held.splice(0).forEach(f => f());
    const ex = await S.call('GET', '/api/v2/usage/system/exceptions');
    out.exceptions_admin = { status: ex.status, n: ex.json.returned, rows: (ex.json.exceptions || []).map(e => ({ ownerKind: e.ownerKind, username: e.username, purpose: e.purpose, cost: e.cost, keys: Object.keys(e).join(',') })), leaksPrompt: JSON.stringify(ex.json).includes('秘密需求内容') };
    out.exceptions_user = (await H.call(S.port, 'GET', '/api/v2/usage/system/exceptions', undefined, { cookie: ck.da })).status;
    const rd = await S.call('GET', '/api/v2/readiness');
    out.readiness = { n: rd.json.accounting && rd.json.accounting.returned, warn: JSON.stringify(rd.json).includes('system-usage-exceptions'), leaks: JSON.stringify(rd.json).includes('秘密需求内容') };
    out.readiness_user = (await H.call(S.port, 'GET', '/api/v2/readiness', undefined, { cookie: ck.da })).status;
  } catch (e) { out.error = e.stack; } finally { await S.stop(); mock.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
