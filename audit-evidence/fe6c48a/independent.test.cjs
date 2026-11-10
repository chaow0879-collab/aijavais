'use strict';
// Independent-CodeAudit, AUD-B1: reviewed SHA fe6c48a117c82eecfd9d3e59ecc68cf27dbeb1b3 (diff 3f659ad..fe6c48a).
// MOCK / pure only: no real provider call, no Secrets, no network beyond 127.0.0.1. REVIEWED_ROOT = exact checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const R = path.resolve(process.env.REVIEWED_ROOT || process.cwd());
const req = p => require(path.join(R, p));
const OUT = process.env.AUDIT_OUT, obs = {};
const note = (k, v) => { obs[k] = v; if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify(obs, null, 2)); } };
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: R, encoding: 'utf8' }).trim();
const BASE = '3f659ad178d967b78602a7fd7df36aa62102bc08', R57 = '049a3376a2d08042fcac1833b324bc87b0137ba1';
test('provenance: REVIEWED_ROOT is exactly fe6c48a', () => { note('head', HEAD); assert.equal(HEAD, 'fe6c48a117c82eecfd9d3e59ecc68cf27dbeb1b3'); });

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-b1-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--no-hardlinks', R, dir]); execFileSync('git', ['checkout', '-q', '--detach', HEAD], { cwd: dir });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=aud', '-c', 'user.email=aud@example.invalid', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { dir, git };
}
function tap(cwd, file, extra = []) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...extra, file], { cwd, encoding: 'utf8', timeout: 300000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const n = k => +(new RegExp('^# ' + k + ' (\\d+)$', 'm').exec(r.stdout) || [])[1];
  return { exit: r.status, tests: n('tests'), pass: n('pass'), fail: n('fail'), failed: (r.stdout.match(/^not ok \d+ - .*$/mg) || []).map(s => s.replace(/^not ok \d+ - /, '')) };
}
const replaceOnce = (f, a, b) => { const s = fs.readFileSync(f, 'utf8'); assert.ok(s.includes(a), 'anchor missing in ' + f + ': ' + a.slice(0, 60)); fs.writeFileSync(f, s.replace(a, b)); };

/* ---------- 1. budget gate not relaxed ---------- */
const RS = req('lib/reasoning.js'), B = req('lib/budget.js');
const DS = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'ws1.dashscope.aliyuncs.com', 'DASHSCOPE.ALIYUNCS.COM', 'dashscope.aliyuncs.com:443'];
test('B01 invariant: every DashScope host x every integer cap 1..20000 -> thinking_budget + max_tokens <= cap, both >=1 or thinking disabled', () => {
  let checked = 0, disabled = 0;
  for (const h of DS) for (let cap = 1; cap <= 20000; cap++) {
    const body = { model: 'qwen3.8-flash', max_tokens: cap }; RS.shapeOpenAIBody('https://' + h + '/compatible-mode/v1', body, cap); checked++;
    if (body.enable_thinking === false) { disabled++; assert.equal(body.max_tokens, cap); assert.equal(body.thinking_budget, undefined); continue; }
    assert.ok(Number.isSafeInteger(body.thinking_budget) && body.thinking_budget >= 1 && body.max_tokens >= 1 && body.thinking_budget + body.max_tokens <= cap, h + ' ' + cap + ' ' + JSON.stringify(body));
  }
  note('B01', { checked, disabled_only_at_cap_1: disabled === DS.length }); assert.equal(disabled, DS.length);
});
test('B02 non-integer / out-of-range caps are never shaped and body is untouched (V2 path always passes an integer 1..8192)', () => {
  const res = {};
  for (const cap of [0, -1, 1.5, '600', NaN, Infinity, null, undefined]) { const body = { max_tokens: 600 }; res[String(cap)] = RS.shapeOpenAIBody('https://dashscope.aliyuncs.com/v1', body, cap); assert.deepEqual(body, { max_tokens: 600 }); }
  const src = fs.readFileSync(path.join(R, 'lib/budget.js'), 'utf8');
  note('B02', { results: res, v2_maxOutputTokens_is_floor_1_8192: /maxOutputTokens: Math\.floor\(number\(input\.maxOutputTokens, 2048, 1, 8192/.test(src) });
  assert.ok(/maxOutputTokens: Math\.floor\(number\(input\.maxOutputTokens, 2048, 1, 8192/.test(src));
});
test('B03 settleCall: cost formula unchanged; reasoning recorded only when usage complete and <= output; overrun still flagged post-hoc', () => {
  const approval = B.authorizeModels({ connections: [{ connectionId: 'c', baseUrl: 'https://api.deepseek.com', modelId: 'm', protocol: 'openai', pricingMode: 'unknown' }],
    input: { approvePaid: true, maxCost: 1, maxOutputTokens: 600, prices: { c: { inputPerMillion: 2, outputPerMillion: 8 } } } });
  const { reservation, usage } = B.reserveCall({ approval, usage: B.initialUsage(), connection: { connectionId: 'c', ...approval.targets.c }, system: 's', prompt: 'p' });
  const st = r => B.settleCall({ usage, connectionId: 'c', roleId: 'r', reservation, result: r });
  const ok = st({ tokens: 130, inTokens: 30, outTokens: 100, reasoningTokens: 60 });
  const partial = st({ tokens: 130, inTokens: 30, outTokens: undefined, usageComplete: false, reasoningTokens: 60 });
  const over = st({ tokens: 30 + 727, inTokens: 30, outTokens: 727, reasoningTokens: 600 }); // the pre-fix DashScope case of run_8769…
  const res = { ok_cost: ok.entry.cost, expected: (30 * 2 + 100 * 8) / 1e6, ok_reasoning: ok.entry.reasoningTokens, partial_reasoning: partial.entry.reasoningTokens, partial_cost_is_bound: partial.entry.cost === reservation.costBound,
    over_overrun: over.overrun, over_cost: over.entry.cost, reservation_costBound: reservation.costBound, tokenBound: reservation.tokenBound };
  note('B03', res);
  assert.ok(Math.abs(ok.entry.cost - res.expected) < 1e-12); assert.equal(ok.entry.reasoningTokens, 60);
  assert.equal(partial.entry.reasoningTokens, undefined); assert.equal(res.partial_cost_is_bound, true);
  assert.equal(over.overrun, true); // detected only AFTER the provider produced the tokens
});
test('B04 diff of lib/budget.js is additive only (one new const, one spread into entry); no reservation/settlement arithmetic changed', () => {
  const d = execFileSync('git', ['diff', '-U0', BASE, HEAD, '--', 'lib/budget.js'], { cwd: R, encoding: 'utf8' }).split('\n').filter(l => /^[-+][^-+]/.test(l));
  const minus = d.filter(l => l[0] === '-').map(l => l.slice(1)), plus = d.filter(l => l[0] === '+').map(l => l.slice(1));
  note('B04', { minus, plus_count: plus.length });
  assert.equal(minus.length, 1); assert.ok(plus.some(l => l.replace(", ...(reasoningTokens !== undefined ? { reasoningTokens } : {})", '') === minus[0]));
});

/* ---------- 2. outbound security / secrets in server.js diff ---------- */
test('S01 server.js diff touches no URL/header/TLS/SSRF/pinnedFetch/key handling; new error text is static', () => {
  const d = execFileSync('git', ['diff', '-U0', BASE, HEAD, '--', 'server.js'], { cwd: R, encoding: 'utf8' }).split('\n').filter(l => /^[-+][^-+]/.test(l)).map(l => l.slice(1));
  const risky = d.filter(l => /pinnedFetch|headers|Authorization|apiKey|providerKey\(|rejectUnauthorized|ALLOWED|SEC\.|url\s*=|POLICY/.test(l));
  // the only SEC./providerKey occurrences allowed are in unchanged-semantics context lines replaced 1:1 (scrubSecrets path untouched)
  note('S01', { changed_lines: d.length, risky });
  assert.deepEqual(risky, []);
});
test('S02 shaping only adds thinking fields to DashScope bodies; look-alike hosts unshaped', () => {
  const res = {};
  for (const u of ['https://dashscope.aliyuncs.com.evil.example/v1', 'https://evildashscope.aliyuncs.com/v1', 'https://dashscope.aliyuncs.com@evil.example/v1', 'http://127.0.0.1/v1', 'https://api.deepseek.com']) {
    const body = { max_tokens: 100 }; res[u] = RS.shapeOpenAIBody(u, body, 100); assert.equal(res[u], null, u); assert.deepEqual(body, { max_tokens: 100 });
  }
  note('S02', res);
});
test('S03 observation (budget residual): DashScope reached through an unlisted host form is NOT shaped -> thinking unbounded again, only caught post-hoc by overrun', () => {
  const res = {};
  for (const u of ['https://dashscope.aliyuncs.com./compatible-mode/v1', 'https://my-gateway.example/dashscope/v1']) { const body = { max_tokens: 600 }; res[u] = RS.shapeOpenAIBody(u, body, 600); }
  note('S03', res); assert.ok(Object.values(res).every(v => v === null));
});
test('S04 P2 probe: profile keys on HOST only -> a DashScope NON-thinking model (qwen-max) also gets its answer cap halved', () => {
  const body = { model: 'qwen-max', max_tokens: 2048 }; RS.shapeOpenAIBody('https://dashscope.aliyuncs.com/compatible-mode/v1', body, 2048);
  note('S04', body); assert.equal(body.max_tokens, 1024); assert.equal(body.thinking_budget, 1024); assert.equal(body.enable_thinking, undefined);
});

/* ---------- 3. regression tests are effective (mutation) ---------- */
const RT = 'tests/reasoning.test.js';
test('T00 unmutated: tests/reasoning.test.js 6/6 PASS', t => { const s = sandbox(t), r = tap(s.dir, RT); note('T00', r); assert.equal(r.tests, 6); assert.equal(r.pass, 6); });
test("T01 author's claim: revert server.js + lib/budget.js to 3f659ad -> some tests FAIL (author: 3 of 6)", t => {
  const s = sandbox(t); s.git('checkout', BASE, '--', 'server.js', 'lib/budget.js'); const r = tap(s.dir, RT); note('T01', r); assert.ok(r.fail >= 1, JSON.stringify(r));
});
test('T02 mutation: remove the empty-answer finish_reason=length error -> exhaustion E2E must FAIL', t => {
  const s = sandbox(t); replaceOnce(path.join(s.dir, 'server.js'), "if (!out.trim() && finish === 'length') throw", "if (false) throw");
  const r = tap(s.dir, RT); note('T02', r); assert.ok(r.failed.some(n => /exhausts the cap/.test(n)), JSON.stringify(r));
});
test('T03 mutation: drop reasoningTokens from the ledger entry -> ledger tests must FAIL', t => {
  const s = sandbox(t); replaceOnce(path.join(s.dir, 'lib/budget.js'), ", ...(reasoningTokens !== undefined ? { reasoningTokens } : {})", '');
  const r = tap(s.dir, RT); note('T03', r); assert.ok(r.fail >= 1, JSON.stringify(r));
});
test('T04 mutation: thinking_budget = cap (sum 1.5x cap) -> pure invariant test must FAIL', t => {
  const s = sandbox(t); replaceOnce(path.join(s.dir, 'lib/reasoning.js'), 'body.thinking_budget = think;', 'body.thinking_budget = cap;');
  const r = tap(s.dir, RT); note('T04', r); assert.ok(r.failed.some(n => /sum to the approved cap/.test(n)), JSON.stringify(r));
});
test('T05 GAP probe: delete the server.js call REASONING.shapeOpenAIBody(...) (the actual DashScope wiring) -> does any test fail?', t => {
  const s = sandbox(t); replaceOnce(path.join(s.dir, 'server.js'), 'REASONING.shapeOpenAIBody(base, body, body.max_tokens);', '/* audit mutation: wiring removed */');
  const r = tap(s.dir, RT), all = tap(s.dir, 'tests/all.test.js'); note('T05', { reasoning: r, npm_test_all: { tests: all.tests, pass: all.pass, fail: all.fail } });
  assert.ok(r.fail >= 1 || all.fail >= 1, 'wiring removal survives every test: ' + JSON.stringify({ r, all: { tests: all.tests, fail: all.fail } }));
});

/* ---------- scope: vendor reference not loaded; R57 provenance delta ---------- */
test('V01 vendor/deepseek-harness (17c9212) is not referenced by any runtime/test JS', () => {
  const hits = execFileSync('git', ['grep', '-l', '-E', "vendor/deepseek-harness|deepseek-harness", HEAD, '--', '*.js', '*.cjs', '*.mjs', '*.json', '*.yml'], { cwd: R, encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter(l => !/sources\.js$/.test(l));
  note('V01', hits); assert.deepEqual(hits, []);
});
test('G01 sources.js delta vs 3f659ad: exactly the 5 B1 entries added, from == R57-base blob, to == HEAD blob; logic unchanged; guard 0 violations', t => {
  const s = sandbox(t), F = 'tools/unattended-go-r57/sources.js';
  fs.writeFileSync(path.join(s.dir, 'tools/unattended-go-r57/sources.old.cjs'), s.git('show', BASE + ':' + F));
  const N = require(path.join(s.dir, F)).POST_R57, O = require(path.join(s.dir, 'tools/unattended-go-r57/sources.old.cjs')).POST_R57;
  const blob = (ref, p) => (s.git('ls-tree', ref, '--', p).split('\t')[0] || null);
  const added = Object.keys(N.changes).filter(k => !(k in O.changes)).sort(), changed = Object.keys(O.changes).filter(k => JSON.stringify(N.changes[k]) !== JSON.stringify(O.changes[k]));
  const check = Object.fromEntries(added.map(k => [k, { from_ok: N.changes[k].from === blob(R57, k), to_ok: N.changes[k].to === blob(HEAD, k) }]));
  const strip = x => x.replace(/const POST_R57=Object\.freeze\([\s\S]*?\n\}\)\}\);\n/, '<TABLE>\n').trimEnd();
  const logic = strip(fs.readFileSync(path.join(s.dir, F), 'utf8')) === strip(s.git('show', BASE + ':' + F));
  const v = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./tools/unattended-go-r57/sources.js').verify().violations))"], { cwd: s.dir, encoding: 'utf8' }));
  note('G01', { added, changed, check, logic, violations: v });
  assert.deepEqual(added, ['lib/budget.js', 'lib/reasoning.js', 'server.js', 'tests/all.test.js', 'tests/reasoning.test.js']);
  assert.deepEqual(changed, []); assert.ok(Object.values(check).every(c => c.from_ok && c.to_ok), JSON.stringify(check)); assert.ok(logic); assert.deepEqual(v, []);
});
