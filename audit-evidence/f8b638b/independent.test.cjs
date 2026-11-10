'use strict';
// Independent-CodeAudit AUD-B7R1: reviewed SHA f8b638b9e6776d4f93b5840f2c3b3b7e7f6f0a3c (diff 8ded49d..f8b638b).
// MOCK on 127.0.0.1 only (treated as a PAID target via pricingMode 'unknown' + admin price). No real provider, no Secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const R = path.resolve(process.env.REVIEWED_ROOT || process.cwd());
const req = p => require(path.join(R, p));
const OUT = process.env.AUDIT_OUT, obs = {};
const note = (k, v) => { obs[k] = v; if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify(obs, null, 2)); } };
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: R, encoding: 'utf8' }).trim();
const BASE = '8ded49d3f82256d8305dfddb68859c5464caab59';
test('provenance: REVIEWED_ROOT is exactly f8b638b', () => { note('head', HEAD); assert.equal(HEAD, 'f8b638b9e6776d4f93b5840f2c3b3b7e7f6f0a3c'); });
const Plan = req('public/smart-plan.js');

/* ---------- ① rework: pure ---------- */
const mk = (id, providerId, price, extra = {}) => ({ connectionId: id, providerId, providerName: providerId, modelId: id + '-m', enabled: true, status: 'available', pricingMode: 'unknown',
  baseUrl: providerId === 'dashscope' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://api.deepseek.com', price, ...extra });
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
test('W01 randomized SmartPlan.rework: fresh approval each call; maxCost*FX <= maxCny <= cap; prices for every snapshot role; refuses unknown price / missing model / empty feedback', () => {
  let ok = 0, refused = 0;
  for (let i = 0; i < 2000; i++) {
    const cur = () => (rnd() > 0.5 ? 'CNY' : 'USD');
    const a = mk('a', rnd() > 0.5 ? 'dashscope' : 'deepseek', { currency: cur(), inputPerMillion: +(rnd() * 40).toFixed(3) + 0.01, outputPerMillion: +(rnd() * 160).toFixed(3) + 0.01 });
    const b = mk('b', rnd() > 0.5 ? 'dashscope' : 'deepseek', rnd() > 0.15 ? { currency: cur(), inputPerMillion: +(rnd() * 40).toFixed(3) + 0.01, outputPerMillion: +(rnd() * 160).toFixed(3) + 0.01 } : null);
    const models = rnd() > 0.1 ? [a, b] : [a];
    const snapshot = { description: '目标'.repeat(1 + Math.floor(rnd() * 200)), roles: [{ roleId: 'drafter', name: '起草', connectionId: 'a' }, { roleId: 'reviewer', name: '审核', connectionId: 'b' }] };
    const cap = Math.max(0.1, +(rnd() * 10).toFixed(1)), feedback = rnd() > 0.05 ? '改得更具体' : '  ';
    const r = Plan.rework({ models, snapshot, feedback, capCny: cap }), r2 = Plan.rework({ models, snapshot, feedback, capCny: cap });
    const shouldRefuse = !feedback.trim() || models.length < 2 || !b.price;
    if (!r.ok) { refused++; assert.ok(shouldRefuse, JSON.stringify(r.problems)); continue; }
    assert.ok(!shouldRefuse); ok++;
    const ap = r.approval;
    assert.notEqual(ap, r2.approval); // a new object every time, nothing cached between rounds
    assert.equal(ap.decision, 'rework'); assert.equal(ap.fromStepId, 'review'); assert.equal(ap.feedback, '改得更具体');
    assert.ok(ap.maxCost * Plan.FX <= r.chosen.maxCny + 1e-9 && r.chosen.maxCny <= cap + 1e-9, JSON.stringify({ m: ap.maxCost, c: r.chosen.maxCny, cap }));
    assert.deepEqual(Object.keys(ap.prices).sort(), ['a', 'b']); assert.equal(ap.approvePaid, true); assert.deepEqual(ap.allowedTools, []); assert.equal(ap.approveExternalTools, false);
  }
  note('W01', { ok, refused }); assert.ok(ok > 1000 && refused > 50);
});

/* ---------- ① rework: through the REAL engine (unchanged lib) ---------- */
async function world(t) {
  const H = req('tests/helpers.js'); let calls = 0;
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { calls++;
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MOCK 成果内容，足够长以通过最小长度检查。'.repeat(2) } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30 } }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  // pricingMode 'unknown' on a 127.0.0.1 target: the engine must treat it as PAID (needs approvePaid + a price).
  const c = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', modelId: 'paid-mock', displayName: 'paid-mock', pricingMode: 'unknown', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 } });
  assert.equal(c.status, 200, c.text); const id = c.json.connection.connectionId;
  const models = (await S.call('GET', '/api/models')).json.models;
  const p = Plan.plan({ models, goal: '写一份周末促销方案', capCny: 5 }); assert.ok(p.ok, JSON.stringify(p.problems));
  const proj = await S.call('POST', '/api/v2/projects', p.project); assert.equal(proj.status, 201, proj.text);
  let run = await S.call('POST', '/api/v2/projects/' + proj.json.project.projectId + '/runs', p.approval);
  let tested = null;
  if (run.status === 409) { // same as the simple-mode UI: verify the connection first (1 MOCK call), then start
    tested = await S.call('POST', '/api/providers/' + encodeURIComponent(id) + '/test', { approvePaid: true });
    run = await S.call('POST', '/api/v2/projects/' + proj.json.project.projectId + '/runs', p.approval);
  }
  note('world_start', { first_start_409_reason: tested ? 'connection not yet verified' : null, test_ok: tested && tested.json && tested.json.ok });
  assert.equal(run.status, 202, run.text);
  const runId = run.json.run.runId;
  const settle = async () => { for (let i = 0; i < 200; i++) { const r = (await S.call('GET', '/api/v2/runs/' + runId)).json.run; if (!r.executionActive && r.status !== 'running') return r; await new Promise(z => setTimeout(z, 50)); } throw Error('not settled'); };
  const first = await settle(); assert.equal(first.status, 'review_required', JSON.stringify(first.steps));
  return { S, id, runId, settle, calls: () => calls, first, models: (await S.call('GET', '/api/models')).json.models };
}
test('W02 engine: rework WITHOUT a fresh approval (decision+feedback only) makes 0 provider calls (no inheritance)', async t => {
  const w = await world(t), before = w.calls();
  const r = await w.S.call('POST', '/api/v2/runs/' + w.runId + '/review', { decision: 'rework', feedback: '再具体一点', fromStepId: 'review' });
  let after = null; try { after = await w.settle(); } catch { after = (await w.S.call('GET', '/api/v2/runs/' + w.runId)).json.run; }
  const res = { http: r.status, error: r.json && (r.json.error || r.json.code), run_status: after.status, step_error: (after.steps || []).map(s => s.error).filter(Boolean)[0] || null, provider_calls_added: w.calls() - before, first_run_calls: before };
  note('W02', res);
  assert.equal(res.provider_calls_added, 0, 'paid call made with an inherited approval: ' + JSON.stringify(res));
});
test('W03 engine: rework with SmartPlan.rework fresh approval -> only the review step re-runs (exactly 1 provider call), round+1, ledger within maxCost', async t => {
  const w = await world(t), before = w.calls();
  const rw = Plan.rework({ models: w.models, snapshot: w.first.projectSnapshot, feedback: '再具体一点', capCny: 5 }); assert.ok(rw.ok, JSON.stringify(rw.problems));
  const r = await w.S.call('POST', '/api/v2/runs/' + w.runId + '/review', rw.approval);
  const after = await w.settle();
  const roundCost = after.usage.cost - (after.usage.roundStartCost || 0);
  const res = { http: r.status, run_status: after.status, round: after.round, provider_calls_added: w.calls() - before, maxCost: rw.approval.maxCost, round_cost: roundCost, approval_round_maxCost: after.approval && after.approval.maxCost };
  note('W03', res);
  assert.ok(r.status < 300, r.text); assert.equal(res.provider_calls_added, 1); assert.equal(after.round, w.first.round + 1); assert.ok(roundCost <= rw.approval.maxCost + 1e-9);
  assert.equal(res.approval_round_maxCost, rw.approval.maxCost);
});
test('W04 engine: rework approval with approvePaid but WITHOUT prices -> 0 provider calls', async t => {
  const w = await world(t), before = w.calls();
  const rw = Plan.rework({ models: w.models, snapshot: w.first.projectSnapshot, feedback: '再具体一点', capCny: 5 });
  const r = await w.S.call('POST', '/api/v2/runs/' + w.runId + '/review', { ...rw.approval, prices: {} });
  let after; try { after = await w.settle(); } catch { after = (await w.S.call('GET', '/api/v2/runs/' + w.runId)).json.run; }
  note('W04', { http: r.status, error: r.json && (r.json.error || r.json.code), run_status: after.status, provider_calls_added: w.calls() - before });
  assert.equal(w.calls() - before, 0);
});

/* ---------- ② expert form RMB <-> USD sync (workspace.js) ---------- */
test('F01 RMB->USD (what is submitted) never exceeds the RMB the user typed; USD->RMB display deviates < ¥0.005', () => {
  const src = fs.readFileSync(path.join(R, 'public/workspace.js'), 'utf8');
  const cny2usd = /\$\('max-cost'\)\.value=String\(Math\.floor\(y\/FXR\*100\)\/100\)/.test(src), usd2cny = /\$\('max-cost-cny'\)\.value=String\(Math\.round\(u\*FXR\*100\)\/100\)/.test(src);
  const submits = (src.match(/maxCost=Number\(\$\('max-cost'\)\.value\)/g) || []).length; // the form submits the USD field only; the RMB field is input/display
  const html = fs.readFileSync(path.join(R, 'public/workspace.html'), 'utf8'), init = ['max-cost-cny', 'max-cost'].map(id => (new RegExp('id="' + id + '"[^>]*value="([^"]*)"').exec(html) || [])[1]);
  const writers = (src.match(/\$\('max-cost'\)\.value=/g) || []).length;
  const FX = Plan.FX; let worstUp = 0, worstDisp = 0;
  for (let y = 0; y <= 1000; y += 0.01) { const u = Math.floor(y / FX * 100) / 100; worstUp = Math.max(worstUp, u * FX - y); }
  for (let c = 0; c <= 100000; c++) { const u = c / 1000, shown = Math.round(u * FX * 100) / 100; worstDisp = Math.max(worstDisp, Math.abs(shown - u * FX)); }
  note('F01', { initial_values_cny_usd: init, usd_field_writers: writers, cny2usd_floor: cny2usd, usd2cny_round: usd2cny, submit_refs_max_cost: submits, max_usd_cap_over_typed_rmb: worstUp, max_display_deviation_rmb: +worstDisp.toFixed(6) });
  assert.ok(cny2usd && usd2cny); assert.equal(submits, 1); assert.deepEqual(init, ['0', '0']); assert.ok(worstUp <= 1e-9); assert.ok(worstDisp < 0.005 + 1e-9);
});

/* ---------- ③ HALOFLUX panel: text only ---------- */
test('P01 panel.html diff changes only strings / markup text, not event, redaction or data-flow code', () => {
  const d = execFileSync('git', ['diff', '-U0', BASE, HEAD, '--', 'public/panel.html'], { cwd: R, encoding: 'utf8' }).split('\n').filter(l => /^[-+][^-+]/.test(l));
  const strip = l => l.slice(1).replace(/'[^']*'|"[^"]*"|`[^`]*`/g, 'S').replace(/>[^<]*</g, '><').replace(/\s+/g, '');
  const minus = d.filter(l => l[0] === '-').map(strip), plus = d.filter(l => l[0] === '+').map(strip);
  const code = l => l.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, 'S'); // string literals are UI text, not code
  const onlyPlus = plus.filter(x => !minus.includes(x)), risky = d.filter(l => /fetch\(|EventSource|redact|mask|sanitiz|JSON\.parse|innerHTML|addEventListener|\.data\b/.test(code(l)));
  note('P01', { changed: d.length, structural_lines_without_counterpart: onlyPlus.length, examples: onlyPlus.slice(0, 6).map(x => x.slice(0, 120)), risky: risky.map(x => x.slice(0, 140)) });
  assert.deepEqual(risky, []);
});
/* ---------- catalog: text only ---------- */
test('C01 catalog/providers.v1.json: only name/pricingNote text changed; baseUrl/envKey/protocol/pricingMode identical', () => {
  const o = JSON.parse(execFileSync('git', ['show', BASE + ':catalog/providers.v1.json'], { cwd: R, encoding: 'utf8' })), n = JSON.parse(fs.readFileSync(path.join(R, 'catalog/providers.v1.json'), 'utf8'));
  const strip = x => JSON.stringify({ ...x, providers: x.providers.map(({ pricingNote, name, ...p }) => p) });
  const changedFields = new Set(); n.providers.forEach((p, i) => { for (const k of Object.keys(p)) if (JSON.stringify(p[k]) !== JSON.stringify(o.providers[i][k])) changedFields.add(k); });
  note('C01', { changed_fields: [...changedFields] }); assert.equal(strip(n), strip(o));
});
/* ---------- ④ no masking sleep ---------- */
test('S01 no 800 ms wait added/removed anywhere in 8ded49d..f8b638b; remaining e2e waits are pre-existing 300 ms (after an explicit condition) and 4500 ms panel render', () => {
  const log = execFileSync('git', ['log', '-p', '--format=COMMIT %h', BASE + '..' + HEAD], { cwd: R, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(l => /^[-+]/.test(l) && /(waitForTimeout|setTimeout|sleep)\s*\(\s*800\b|\b800\s*\)/.test(l));
  const waits = (fs.readFileSync(path.join(R, 'tests/ui/b7-usability.e2e.js'), 'utf8').match(/waitForTimeout\(\d+\)/g) || []);
  note('S01', { lines_with_800ms: log, e2e_waits: waits }); assert.deepEqual(log, []);
});
