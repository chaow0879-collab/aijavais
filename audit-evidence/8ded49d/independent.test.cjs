'use strict';
// Independent-CodeAudit AUD-B7: reviewed SHA 8ded49d3f82256d8305dfddb68859c5464caab59 (diff fe6c48a..8ded49d).
// MOCK / pure / 127.0.0.1 only. No real provider call, no Secrets. REVIEWED_ROOT = exact checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const R = path.resolve(process.env.REVIEWED_ROOT || process.cwd());
const req = p => require(path.join(R, p));
const OUT = process.env.AUDIT_OUT, obs = {};
const note = (k, v) => { obs[k] = v; if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify(obs, null, 2)); } };
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: R, encoding: 'utf8' }).trim();
const BASE = 'fe6c48a117c82eecfd9d3e59ecc68cf27dbeb1b3';
// git grep exits 1 when nothing matches: that is an empty result, not an error (auditor-script fix after local pre-run).
const ggrep = args => { const r = spawnSync('git', ['grep', ...args], { cwd: R, encoding: 'utf8' }); if (r.status > 1) throw Error(r.stderr); return r.stdout.trim(); };
test('provenance: REVIEWED_ROOT is exactly 8ded49d', () => { note('head', HEAD); assert.equal(HEAD, '8ded49d3f82256d8305dfddb68859c5464caab59'); });
const Plan = req('public/smart-plan.js'), RS = req('lib/reasoning.js'), B = req('lib/budget.js'), PR = req('lib/prices.js');

/* ---------- 1. budget gate (simple mode) ---------- */
const mk = (id, providerId, modelId, price) => ({ connectionId: id, providerId, providerName: providerId, modelId, enabled: true, status: 'available', pricingMode: 'unknown',
  baseUrl: providerId === 'dashscope' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://api.deepseek.com', price });
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
test('C01 randomized: maxCost*FX <= maxCny <= cap; only priced models chosen; USD prices consistent with FX; unknown-only pool refused', () => {
  let plans = 0, refused = 0;
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rnd() * 5), pool = [];
    for (let k = 0; k < n; k++) {
      const known = rnd() > 0.25, cur = rnd() > 0.5 ? 'CNY' : 'USD';
      pool.push(mk('m' + k, rnd() > 0.5 ? 'dashscope' : 'deepseek', ['x-flash', 'x-max', 'x-pro', 'x-turbo'][k % 4] + k, known ? { currency: cur, inputPerMillion: +(rnd() * 50).toFixed(3) || 0.01, outputPerMillion: +(rnd() * 200).toFixed(3) || 0.02 } : null));
    }
    const cap = Math.max(0.1, +(rnd() * 20).toFixed(1)), choice = rnd() > 0.5 ? 'quality' : 'saving';
    const p = Plan.plan({ models: pool, goal: '写一份方案'.repeat(1 + Math.floor(rnd() * 30)), capCny: cap, choice });
    if (!p.ok) { refused++; if (pool.every(m => !m.price)) assert.ok(p.problems.some(x => x.code === 'no_priced_model'), JSON.stringify(p.problems)); continue; }
    plans++;
    const a = p.approval;
    assert.ok(a.maxCost * Plan.FX <= p.chosen.maxCny + 1e-9 && p.chosen.maxCny <= cap + 1e-9, JSON.stringify({ maxCost: a.maxCost, maxCny: p.chosen.maxCny, cap }));
    for (const r of p.roles) {
      assert.ok(r.model.price, 'unknown-price model chosen: ' + r.model.connectionId);
      const u = a.prices[r.model.connectionId], f = r.model.price.currency === 'USD' ? 1 : 1 / Plan.FX;
      assert.ok(u && Math.abs(u.inputPerMillion - r.model.price.inputPerMillion * f) < 1e-9 && Math.abs(u.outputPerMillion - r.model.price.outputPerMillion * f) < 1e-9, JSON.stringify({ u, p: r.model.price }));
    }
    assert.equal(a.approvePaid, true); assert.deepEqual(a.allowedTools, []); assert.equal(a.approveExternalTools, false);
  }
  note('C01', { plans, refused, FX: Plan.FX }); assert.ok(plans > 1000);
});
test('C02 no silent downgrade: over-cap default choice is quality; saving only when explicitly chosen', () => {
  const POOL = [mk('a', 'deepseek', 'deepseek-flash', { currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2 }), mk('d', 'dashscope', 'qwen3.8-max', { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 })];
  const def = Plan.plan({ models: POOL, goal: '写一份方案', capCny: 0.1 }), q = Plan.plan({ models: POOL, goal: '写一份方案', capCny: 0.1, choice: 'quality' });
  note('C02', { overCap: def.chosen.overCap, def: def.summary, quality: q.summary, saving: def.options.saving && def.options.saving.summary });
  assert.equal(def.summary, q.summary); assert.equal(def.chosen.kind, 'quality');
});
function engineApproval(p, pool) {
  return B.authorizeModels({ connections: p.roles.map(r => { const m = pool.find(x => x.connectionId === r.model.connectionId); return { connectionId: m.connectionId, baseUrl: m.baseUrl, modelId: m.modelId, protocol: 'openai', pricingMode: 'unknown' }; }), input: p.approval });
}
test('C03 engine enforces the converted cap: repeated reservations stop (throw) before maxCost is exceeded', () => {
  const pool = [mk('d', 'dashscope', 'qwen3.8-max', { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 })];
  const res = {};
  for (const capCny of [0.5, 5]) {
    const p = Plan.plan({ models: pool, goal: '写一份方案', capCny }); assert.ok(p.ok);
    const approval = engineApproval(p, pool); let usage = B.initialUsage(), n = 0, err = null;
    try { for (; n < 1000; n++) { const r = B.reserveCall({ approval, usage, connection: { connectionId: 'd', ...approval.targets.d }, system: 's', prompt: 'p' }); usage = B.settleCall({ usage: r.usage, connectionId: 'd', roleId: 'x', reservation: r.reservation, result: { failed: true, usageUnknown: true, tokens: 0 }, failed: true }).usage; } } catch (e) { err = e.code || e.message; }
    res['cap_' + capCny] = { maxCny: p.chosen.maxCny, overCap: p.chosen.overCap, maxCost: approval.maxCost, reservations_before_stop: n, stop: err, settled_usd_upper_bound: +usage.cost.toFixed(6) };
    assert.ok(err && usage.cost <= approval.maxCost + 1e-9, JSON.stringify({ err, cost: usage.cost, max: approval.maxCost }));
  }
  note('C03', res);
});
test('C04 engine refuses a remote model with no price even if approvePaid=true (unknown price never called)', () => {
  let code = null;
  try { const a = B.authorizeModels({ connections: [{ connectionId: 'u', baseUrl: 'https://api.deepseek.com', modelId: 'm', protocol: 'openai', pricingMode: 'unknown' }], input: { approvePaid: true, maxCost: 1, prices: {} } });
    B.reserveCall({ approval: a, usage: B.initialUsage(), connection: { connectionId: 'u', ...a.targets.u }, system: 's', prompt: 'p' }); } catch (e) { code = e.code || e.message; }
  note('C04', code); assert.ok(code, 'unknown-price remote model was reservable');
});
test('C05 UI "追加继续" is a disabled placeholder with no handler', () => {
  const html = fs.readFileSync(path.join(R, 'public/workspace.html'), 'utf8'), js = fs.readFileSync(path.join(R, 'public/workspace-simple.js'), 'utf8');
  const btn = /<button id="s-stop-more"[^>]*>/.exec(html)[0];
  note('C05', { btn, handler_refs: (js.match(/s-stop-more/g) || []).length }); assert.match(btn, /\sdisabled[\s>]/); assert.equal((js.match(/s-stop-more/g) || []).length, 0);
});

/* ---------- 2. AUD-FE6C-01/02 closure ---------- */
test('R01 DashScope invariant (all hosts x cap 1..8192): max_tokens == cap (full answer), thinking_budget == floor(cap/2), reserve == cap + thinking', () => {
  let n = 0;
  for (const h of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'ws1.dashscope.aliyuncs.com']) for (let cap = 1; cap <= 8192; cap++) {
    const u = 'https://' + h + '/compatible-mode/v1', body = { model: 'qwen-max', max_tokens: cap }; RS.shapeOpenAIBody(u, body, cap); n++;
    assert.equal(body.max_tokens, cap); const think = Math.floor(cap / 2);
    if (think < 1) assert.equal(body.enable_thinking, false); else assert.equal(body.thinking_budget, think);
    assert.equal(RS.outputBound(u, cap), cap + think);
  }
  for (const u of ['https://api.deepseek.com', 'http://127.0.0.1:1/v1']) assert.equal(RS.outputBound(u, 600), 600);
  note('R01', { checked: n });
});
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-b7-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--no-hardlinks', R, dir]); execFileSync('git', ['checkout', '-q', '--detach', HEAD], { cwd: dir }); return dir;
}
function tap(cwd, file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', file], { cwd, encoding: 'utf8', timeout: 300000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const n = k => +(new RegExp('^# ' + k + ' (\\d+)$', 'm').exec(r.stdout) || [])[1];
  return { exit: r.status, tests: n('tests'), pass: n('pass'), fail: n('fail'), failed: (r.stdout.match(/^not ok \d+ - .*$/mg) || []).map(s => s.replace(/^not ok \d+ - /, '').slice(0, 90)) };
}
const rep = (f, a, b) => { const s = fs.readFileSync(f, 'utf8'); assert.ok(s.includes(a), 'anchor: ' + a.slice(0, 60)); fs.writeFileSync(f, s.replace(a, b)); };
const RT = 'tests/reasoning.test.js';
test('R02 unmutated tests/reasoning.test.js all PASS', t => { const d = sandbox(t), r = tap(d, RT); note('R02', r); assert.equal(r.fail, 0); assert.ok(r.tests >= 7); });
test('R03 mutation (AUD-FE6C-01 gap): delete server.js wiring REASONING.shapeOpenAIBody(...) -> TLS-tunnel E2E must FAIL', t => {
  const d = sandbox(t); rep(path.join(d, 'server.js'), 'REASONING.shapeOpenAIBody(base, body, body.max_tokens);', '/* audit mutation */');
  const r = tap(d, RT); note('R03', r); assert.ok(r.failed.some(n => /AUD-FE6C-01/.test(n)), JSON.stringify(r));
});
test('R04 mutation: reservation ignores thinking (outputBound -> maxOutputTokens) -> a reservation test must FAIL', t => {
  const d = sandbox(t); rep(path.join(d, 'lib/budget.js'), 'REASONING.outputBound(connection.baseUrl, approval.maxOutputTokens)', 'approval.maxOutputTokens');
  const r = tap(d, RT); note('R04', r); assert.ok(r.fail >= 1, JSON.stringify(r));
});
test('R05 mutation (AUD-FE6C-02 regression): halve the answer again (max_tokens = cap - think) -> a test must FAIL', t => {
  const d = sandbox(t); rep(path.join(d, 'lib/reasoning.js'), 'body.thinking_budget = think;', 'body.thinking_budget = think; body.max_tokens = cap - think;');
  const r = tap(d, RT); note('R05', r); assert.ok(r.fail >= 1, JSON.stringify(r));
});
test('R06 no test-only hook left in production code (9389854 AIJ_TEST_REASONING_HOSTS / configure removed in ceacbc3)', () => {
  const hits = ggrep(['-n', '-E', 'AIJ_TEST_REASONING|testHosts|REASONING\\.configure|function configure', HEAD, '--', 'lib', 'server.js', 'public']);
  note('R06', hits); assert.equal(hits, '');
});

/* ---------- 3. batch add / discover: auth, rollback, no key leak; prices ---------- */
test('K01 /api/models/batch: admin + same-origin only; all-or-nothing; key never echoed or stored outside credentials.json', async t => {
  const H = req('tests/helpers.js'), SECRET = 'sk-AUDIT-B7-' + 'x'.repeat(24);
  const mock = http.createServer((q, s) => { s.writeHead(404); s.end(); }); await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const base = 'http://127.0.0.1:' + mock.address().port + '/v1', body = { providerId: 'ollama', baseUrl: base, apiKey: SECRET, models: [{ modelId: 'aud-a' }, { modelId: 'aud-b' }] };
  const unauth = await S.call('POST', '/api/models/batch', body, { cookie: false });
  const xsite = await S.call('POST', '/api/models/batch', body, { headers: { origin: 'http://evil.example' } });
  const before = (await S.call('GET', '/api/models')).json.models.length;
  const bad = await S.call('POST', '/api/models/batch', { ...body, models: [{ modelId: 'aud-c' }, { modelId: 'aud-d', capabilities: ['no-such-cap'] }] });
  const dup = await S.call('POST', '/api/models/batch', { ...body, models: [{ modelId: 'aud-e' }, { modelId: 'aud-e' }] });
  const afterBad = (await S.call('GET', '/api/models')).json.models.length;
  const ok = await S.call('POST', '/api/models/batch', body);
  const list = await S.call('GET', '/api/models');
  const src = ok.json.connections[0].connectionId;
  const cross = await S.call('POST', '/api/models/batch', { providerId: 'deepseek', keyFromConnectionId: src, models: [{ modelId: 'aud-f' }] });
  const leakFiles = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (fs.readFileSync(p).includes(SECRET)) leakFiles.push(path.relative(S.dir, p)); } }; walk(S.dir);
  const res = { unauth: unauth.status, xsite: xsite.status, bad: bad.status, dup: dup.status, rollback_count_unchanged: before === afterBad, ok: ok.status,
    key_in_batch_response: ok.text.includes(SECRET), key_in_list: list.text.includes(SECRET), cross_provider_key_reuse: cross.status, files_with_key: leakFiles };
  note('K01', res);
  assert.equal(res.unauth, 401); assert.equal(res.xsite, 403); assert.equal(res.bad, 400); assert.equal(res.dup, 400); assert.ok(res.rollback_count_unchanged);
  assert.equal(res.ok, 200); assert.equal(res.key_in_batch_response, false); assert.equal(res.key_in_list, false); assert.equal(res.cross_provider_key_reuse, 400);
  assert.deepEqual(leakFiles.filter(f => !/credentials\.json$/.test(f)), []);
});
test('K02 admin price validation and precedence (admin > catalog > null)', () => {
  const bad = [{ currency: 'EUR', inputPerMillion: 1, outputPerMillion: 1 }, { currency: 'CNY', inputPerMillion: -1, outputPerMillion: 1 }, { currency: 'CNY', inputPerMillion: 0, outputPerMillion: 0 },
    { currency: 'USD', inputPerMillion: NaN, outputPerMillion: 1 }, { currency: 'USD', inputPerMillion: '1', outputPerMillion: 1 }, [], 'x', { currency: 'USD', inputPerMillion: 1e6, outputPerMillion: 1 }];
  const res = bad.map(p => PR.invalid(p));
  const cat = PR.resolve({ providerId: 'deepseek', modelId: 'deepseek-flash' }), adm = PR.resolve({ providerId: 'deepseek', modelId: 'deepseek-flash', price: { currency: 'CNY', inputPerMillion: 9, outputPerMillion: 9 } }), unk = PR.resolve({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' });
  note('K02', { invalid_messages: res, catalog: cat, admin: adm, unknown: unk });
  assert.ok(res.every(Boolean)); assert.equal(cat.source, 'catalog'); assert.equal(adm.source, 'admin'); assert.equal(unk, null);
});
test('K03 catalog entries carry sources/basis/verified; deepseek-flash is flagged secondary-only', () => {
  const C = PR.CATALOG, e = C.prices.map(p => ({ id: p.providerId + ':' + p.modelIds.join(','), cur: p.currency, sources: p.sources.length, verified: p.verified }));
  note('K03', { checkedAt: C.checkedAt, entries: e });
  assert.ok(C.prices.every(p => p.sources.length && p.basis && p.verified)); assert.match(C.prices.find(p => p.providerId === 'deepseek').verified, /secondary/);
});
/* ---------- 5. O4 a61756a ---------- */
test('O4 a61756a: exactly the two remaining exit handlers became close; nothing else changed in those tests', () => {
  const d = execFileSync('git', ['show', 'a61756a', '--', 'tests/access.test.js', 'tests/agent-scheduler/scheduler.test.js'], { cwd: R, encoding: 'utf8' }).split('\n').filter(l => /^[-+][^-+]/.test(l));
  const norm = l => l.slice(1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\/\/ 'close'.*$/, '').replace(/\.on\('close'/g, ".on('exit'");
  const minus = d.filter(l => l[0] === '-').map(norm), plus = d.filter(l => l[0] === '+').map(norm);
  const left = ggrep(['-n', "on('exit'", HEAD, '--', 'tests/access.test.js', 'tests/agent-scheduler/scheduler.test.js']);
  note('O4', { changed: d.length, equal_modulo_event: JSON.stringify(minus) === JSON.stringify(plus), remaining_exit: left });
  assert.equal(d.length, 4); assert.deepEqual(minus, plus); assert.equal(left, '');
});
