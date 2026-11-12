'use strict';
const path = require('path'), http = require('http'), R = process.argv[2];
const H = require(path.join(R, 'tests/helpers.js')), Plan = require(path.join(R, 'public/smart-plan.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let n = 0, big = false, hold = false, held = []; const prompts = [];
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { n++; const k = n; let j = {}; try { j = JSON.parse(b); } catch {}
    prompts.push((j.messages || []).map(m => m.content).join('\n'));
    const send = () => { const text = (big ? '长'.repeat(20000) : '') + `版本内容-${k}-` + '足够长的成果文字。'.repeat(4);
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) + '\n\ndata: [DONE]\n\n'); };
    if (hold) held.push(send); else send(); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } }); const out = {};
  const A = (m, u, b) => S.call(m, u, b);
  try {
    const base = 'http://127.0.0.1:' + mock.address().port + '/v1';
    const c = await A('POST', '/api/models', { providerId: 'ollama', baseUrl: base, modelId: 'deepseek-v4-flash', displayName: 'p', pricingMode: 'unknown', capabilities: ['writing', 'reasoning'], price: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 } });
    const cid = c.json.connection.connectionId; await A('POST', '/api/models/' + cid + '/test', { approvePaid: true });
    const mkUser = async (name, cap) => (await A('POST', '/api/v2/users', { username: name, password: 'Aud1t-pass-' + name + '-xyz', monthlyCapCny: cap })).json.user;
    await mkUser('va', 50); await mkUser('vb', 50);
    const login = async name => H.cookieFrom(await H.call(S.port, 'POST', '/api/auth/user-login', { username: name, password: 'Aud1t-pass-' + name + '-xyz' }, { cookie: false }));
    const ca = await login('va'), cb = await login('vb');
    const U = (ck, m, u, b) => H.call(S.port, m, u, b, { cookie: ck });
    const models = (await U(ca, 'GET', '/api/v2/me')).json.models;
    const settle = async (ck, id) => { for (let i = 0; i < 300; i++) { const x = (await U(ck, 'GET', '/api/v2/runs/' + id)).json.run; if (x && !x.executionActive && x.status !== 'running') return x; await sleep(40); } };
    const start = async ck => { const p = Plan.plan({ models, goal: '写一份周末促销方案', capCny: 50 }); const pr = (await U(ck, 'POST', '/api/v2/projects', p.project)).json.project;
      const r = await U(ck, 'POST', `/api/v2/projects/${pr.projectId}/runs`, p.approval); return { snap: pr, run: await settle(ck, r.json.run.runId) }; };
    const { snap, run } = await start(ca); const runId = run.runId; out.first = { status: run.status, maxReworks: run.maxReworks };
    const { run: runB } = await start(cb);
    const ver = async ck => (await U(ck, 'GET', `/api/v2/runs/${runId}/versions`, undefined));
    const v1 = (await ver(ca)).json;
    const rw = (said, prevChars) => { const r = Plan.rework({ models, snapshot: snap, feedback: said, capCny: 50, previousChars: prevChars }); r.approval.feedback = Plan.reviseFeedback({ message: said }); r.approval.message = said; return r.approval; };
    // 1 rework without fresh approval fields
    let c0 = n; const noAppr = await U(ca, 'POST', `/api/v2/runs/${runId}/review`, { decision: 'rework', feedback: '只改第 3 页', revise: true, message: '只改第 3 页' });
    out.no_approval = { status: noAppr.status, code: noAppr.json.code, calls: n - c0 };
    const lowerPrice = await U(ca, 'POST', `/api/v2/runs/${runId}/review`, { ...rw('改标题', v1.versions[0].text.length), approvePaid: false });
    out.approvePaid_false = { status: lowerPrice.status, code: lowerPrice.json.code, calls: n - c0 };
    // 2 concurrent reworks
    hold = true; c0 = n;
    const two = await Promise.all([U(ca, 'POST', `/api/v2/runs/${runId}/review`, rw('只改第 3 页的标题', v1.versions[0].text.length)), U(ca, 'POST', `/api/v2/runs/${runId}/review`, rw('删除第 2 页', v1.versions[0].text.length))]);
    await sleep(300); out.concurrent = { statuses: two.map(r => r.status + ':' + (r.json.code || r.json.run?.status)), callsWhileHeld: n - c0 };
    hold = false; held.splice(0).forEach(f => f());
    let r2 = await settle(ca, runId);
    const revPrompt = prompts[prompts.length - 1];
    out.round2 = { status: r2.status, round: r2.round, prevInPrompt: revPrompt.includes(v1.versions[0].text) && revPrompt.includes('Revise THIS version'), messageInPrompt: revPrompt.includes('只改第 3 页的标题'), scope: revPrompt.includes('修改范围：只改第 3 页') };
    // 3 budget: previous version large; approval sized without it
    big = true; c0 = n;
    // make a big current version: one more normal rework to get a big final
    const r3 = await U(ca, 'POST', `/api/v2/runs/${runId}/review`, rw('结尾更有力', (await ver(ca)).json.versions.at(-1).text.length)); r2 = await settle(ca, runId); big = false;
    const cur = (await ver(ca)).json; const bigLen = cur.versions.at(-1).text.length;
    c0 = n; const under = await U(ca, 'POST', `/api/v2/runs/${runId}/review`, rw('改开头', 0)); const ru = await settle(ca, runId);
    out.underestimate = { start: under.status, status: ru.status, err: JSON.stringify(ru.error || '').slice(0, 90), calls: n - c0, bigLen, round: ru.round };
    // 4 versions + limit
    const vs = (await ver(ca)).json;
    out.versions = { n: vs.versions.length, round: vs.round, maxReworks: vs.maxReworks, left: vs.reworksLeft, msgs: vs.versions.map(v => v.message && v.message.slice(0, 20)), current: vs.versions.map(v => v.current), distinct: new Set(vs.versions.map(v => v.text)).size };
    c0 = n; const lim = await U(ca, 'POST', `/api/v2/runs/${runId}/review`, rw('再改一次', bigLen));
    out.after_failed = { status: lim.status, code: lim.json.code || lim.json.run?.status, calls: n - c0 };
    // 5 export old version
    const old = vs.versions[0]; const ex = await U(ca, 'POST', `/api/v2/runs/${runId}/export`, { format: 'md', artifactId: old.artifactId });
    const mk = t => (/版本内容-\d+-/.exec(t) || [])[0]; out.export_old = { status: ex.status, oldMarker: mk(old.text), curMarker: mk(vs.versions.at(-1).text), exportHasOld: (ex.text || '').includes(mk(old.text)), exportHasCur: (ex.text || '').includes(mk(vs.versions.at(-1).text)) }; const exc = await U(ca, 'POST', `/api/v2/runs/${runId}/export`, { format: 'md' }); out.export_default = { hasCur: (exc.text || '').includes(mk(vs.versions.at(-1).text)), hasOld: (exc.text || '').includes(mk(old.text)) };
    const artsA = (await U(ca, 'GET', `/api/v2/runs/${runId}`)).json.run;
    const stepArt = (artsA.artifacts || []).find(a => a.kind !== 'final-draft');
    out.export_nonfinal = stepArt ? (await U(ca, 'POST', `/api/v2/runs/${runId}/export`, { format: 'md', artifactId: stepArt.artifactId })).status : 'no-step-artifact-listed';
    out.export_badtype = (await U(ca, 'POST', `/api/v2/runs/${runId}/export`, { format: 'md', artifactId: 123 })).status;
    // 6 IDOR
    out.idor = { b_versions_of_a: (await ver(cb)).status, b_export_a_run: (await U(cb, 'POST', `/api/v2/runs/${runId}/export`, { format: 'md', artifactId: old.artifactId })).status,
      b_own_run_with_a_artifact: (await U(cb, 'POST', `/api/v2/runs/${runB.runId}/export`, { format: 'md', artifactId: old.artifactId })).status,
      b_review_a: (await U(cb, 'POST', `/api/v2/runs/${runId}/review`, rw('x', 0))).status };
    const link = (await A('POST', '/api/auth/display-link', { label: '大屏', hours: 1 })).json;
    const dc = H.cookieFrom(await H.call(S.port, 'GET', link.path, undefined, { cookie: false }));
    const st = await H.call(S.port, 'GET', '/api/state', undefined, { cookie: dc });
    out.display = { versions: (await H.call(S.port, 'GET', `/api/v2/runs/${runId}/versions`, undefined, { cookie: dc })).status, anon: (await H.call(S.port, 'GET', `/api/v2/runs/${runId}/versions`, undefined, { cookie: false })).status, state_leak: st.text.includes('只改第 3 页的标题') || st.text.includes('版本内容-') };
    // 7 message bounds
    out.msg_long = (await U(cb, 'POST', `/api/v2/runs/${runB.runId}/review`, { ...rw('x', 0), message: 'm'.repeat(2001) })).status;
  } catch (e) { out.error = e.stack; } finally { await S.stop(); mock.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
