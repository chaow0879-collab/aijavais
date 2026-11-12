'use strict';
const path = require('path'), http = require('http'), fs = require('fs'), R = process.argv[2];
const H = require(path.join(R, 'tests/helpers.js'));
const { DatabaseSync } = require('node:sqlite');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const S = await H.boot({}); const dir = S.dir; const out = {};
  const A = (m, u, b) => S.call(m, u, b);
  try {
    for (const n of ['ra', 'rb']) await A('POST', '/api/v2/users', { username: n, password: 'Aud1t-pass-' + n + '-xyz', monthlyCapCny: 50 });
    const login = async name => H.cookieFrom(await H.call(S.port, 'POST', '/api/auth/user-login', { username: name, password: 'Aud1t-pass-' + name + '-xyz' }, { cookie: false }));
    const ra = await login('ra'), rb = await login('rb');
    const U = (c, m, u, b) => H.call(S.port, m, u, b, { cookie: c });
    const draft = { name: '新任务（正在准备资料）', description: '还没开始的新任务，正在上传资料。', roles: [{ roleId: 'drafter', name: '起草员', duty: 'x' }], steps: [{ stepId: 'draft', roleId: 'drafter', title: 'x' }] };
    // A: slow-body draft race: open 25 requests, send headers + half body, wait, then finish all
    const body = Buffer.from(JSON.stringify(draft)), origin = `http://127.0.0.1:${S.port}`;
    const reqs = Array.from({ length: 25 }, () => new Promise(res => {
      const q = http.request({ host: '127.0.0.1', port: S.port, method: 'POST', path: '/api/v2/projects', headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': body.length, cookie: ra, origin } }, r => { let t = ''; r.on('data', c => t += c); r.on('end', () => res(r.statusCode)); });
      q.write(body.subarray(0, 10)); setTimeout(() => q.end(body.subarray(10)), 700); }));
    const st = await Promise.all(reqs);
    const d1 = new DatabaseSync(path.join(dir, 'projects.sqlite'), { readOnly: true });
    out.slow_body_drafts = { created: st.filter(s => s === 201).length, rejected429: st.filter(s => s === 429).length, inDb: Number(d1.prepare("SELECT count(*) n FROM projects WHERE owner_id=(SELECT id FROM users WHERE username='ra')").get().n), cap: 20 };
    d1.close();
    // B: storage: fill rb to 248 MB with PNGs over 5 drafts, then 6 concurrent 7 MB PDFs (remaining 8 MB -> at most 1)
    const png = Buffer.alloc(8 * 1024 * 1024 - 64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); const pngB64 = png.toString('base64');
    const projs = []; for (let i = 0; i < 7; i++) projs.push((await U(rb, 'POST', '/api/v2/projects', draft)).json.project.projectId);
    let filled = 0, k = 0;
    while (filled + png.length <= 248 * 1024 * 1024) { const r = await U(rb, 'POST', `/api/v2/projects/${projs[Math.floor(k / 7)]}/files`, { filename: `f${k}.png`, contentBase64: pngB64 }); if (r.status !== 201) { out.fill_err = r.status + ':' + (r.json.code || ''); break; } filled += png.length; k++; }
    out.filled_mb = +(filled / 1048576).toFixed(1);
    const pdf = Buffer.concat([fs.readFileSync(path.join(__dirname, 'b9files/pdf.bin')), Buffer.alloc(7 * 1024 * 1024, 0x20)]), pb = pdf.toString('base64');
    const conc = await Promise.all(Array.from({ length: 6 }, (_, i) => U(rb, 'POST', `/api/v2/projects/${projs[5 + (i % 2)]}/files`, { filename: `c${i}.pdf`, contentBase64: pb })));
    const d2 = new DatabaseSync(path.join(dir, 'projects.sqlite'), { readOnly: true });
    const tot = Number(d2.prepare("SELECT SUM(length(f.content)) b FROM project_files f JOIN projects p ON p.id=f.project_id WHERE p.owner_id=(SELECT id FROM users WHERE username='rb')").get().b); d2.close();
    out.storage_concurrent_pdf = { statuses: conc.map(r => r.status + ':' + (r.json.code || '')), totalMB: +(tot / 1048576).toFixed(1), capMB: 256 };
  } catch (e) { out.error = e.stack; } finally { await S.stop(); }
  console.log(JSON.stringify(out, null, 1));
})();
