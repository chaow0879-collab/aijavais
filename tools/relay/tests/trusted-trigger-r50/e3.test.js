'use strict';
// M4/M5: E3_FAKE joint drill against the REAL R49/R46/R45 modules: webhook over real Node
// HTTP and 10-minute ticks (fake clock) -> R49 prepare -> R50 broker -> R49 execute
// (R46 CAS claim -> signed R45 runner -> marked Fake CLI subprocess -> settle). Real child
// processes and the real HTTP/SQLite CAS service are used where marked. No model, no
// GitHub write, no schedule: actual_agent_launches must stay 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { serve } = require('../../trusted-trigger-r50/server');
const { verifyOidc } = require('../../trusted-trigger-r50/oidc');
const { handle, tickRecord } = require('../../trusted-trigger-r50/pipeline');
const { Broker, TestSigner } = require('../../trusted-trigger-r50/broker');
const { TriggerStore } = require('../../trusted-trigger-r50/store');
const R = require('../../auto-handoff-r46/reconcile');
const T = require('../../auto-handoff-r46/triggers');
const { service, temp } = require('../auto-handoff-r46/helpers.cjs');
const X = require('./helpers.cjs');
const evidence = {};
const MIN = 60000;

async function webhook(t, ctx, approval) {
  const s = await serve({ secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, clock: () => ctx.f.now,
    onTrigger: record => handle({ record, base: ctx.f, broker: ctx.broker, approval, now: ctx.f.now }) });
  t.after(() => new Promise(r => s.server.close(r)));
  const d = X.delivery(ctx.f);
  const r = await fetch(s.url, { method: 'POST', headers: d.headers, body: d.body });
  return { status: r.status, ...(await r.json()) };
}
// Move the fake clock: refresh the synthetic snapshot and R46 authorization for that time.
function at(ctx, now) { ctx.f.now = now; ctx.f.snapshot.checked_at = now; ctx.f.sign(); }
async function tick(ctx, approval, now) {
  at(ctx, now);
  const record = tickRecord(verifyOidc(X.oidcToken({}, { now }), { jwks: X.JWKS, policy: X.r50Policy(), now }), now, ctx.f.config);
  return handle({ record, base: ctx.f, broker: ctx.broker, approval, now });
}
const jobs = async ctx => Object.values((await ctx.f.backend.read()).document.jobs);

test('event over real HTTP starts the work once; three 10-minute ticks for the same work never start it again', async t => {
  const ctx = X.base(t), a = X.approval(ctx.f), t0 = ctx.f.now;
  const e = await webhook(t, ctx, a);
  assert.equal(e.status, 202); assert.equal(e.state, 'ACCEPTED');
  assert.equal(e.result.state, 'SUCCEEDED', JSON.stringify(e.result)); assert.equal(e.result.actual_agent_launches, 0); assert.equal(e.result.r50.trigger, 'github_webhook');
  assert.equal(ctx.f.cli.launches(), 1);
  const ticks = [];
  for (const k of [1, 2, 3]) ticks.push(await tick(ctx, a, t0 + k * 10 * MIN));
  assert.deepEqual(ticks.map(r => [r.state, r.reason, r.runner_calls]), [1, 2, 3].map(() => ['SUCCEEDED', 'DUPLICATE_NO_REPLAY', 0]));
  assert.ok(ticks.every(r => r.r50.work_key === e.result.r50.work_key && r.r50.trigger === 'fallback_tick'));
  assert.equal(ctx.f.cli.launches(), 1); assert.equal((await jobs(ctx)).length, 1);
  const log = ctx.store.auditLog();
  assert.equal(log.filter(x => x.kind === 'envelope_signed').length, 4, 'one signature per trigger, all for the same work');
  assert.ok(log.filter(x => x.kind === 'execute_result').every(x => x.detail.candidate_sha === X.H.HEAD), 'evidence bound to the exact candidate');
  evidence.event_then_ticks = { first: e.result.state, ticks: ticks.map(r => r.reason), fake_cli_launches: ctx.f.cli.launches(), r46_jobs: 1, actual_agent_launches: 0 };
});

test('separate OS processes: webhook receiver and fallback tick race on one CAS service → one start', async t => {
  const ctx = X.base(t, 'success', { seed: crypto.randomBytes(32) });
  const dir = temp(t), s = await service(t, path.join(dir, 'cas.sqlite'));
  const seedFile = path.join(dir, 'signer.seed');
  const seed = crypto.randomBytes(32); fs.writeFileSync(seedFile, seed.toString('hex'), { mode: 0o600 });
  const signer = new TestSigner({ testOnly: true, seed });
  ctx.f.policy = X.H.policy({ allowed_issues: [32], pinned_gate_sha: X.H.HEAD, trusted_keys: { [signer.keyId]: { pem: signer.publicPem, roles: ['dispatcher'] } } });
  const a = X.approval(ctx.f);
  const baseFields = {}; for (const k of ['candidate_sha', 'config', 'envelope', 'authorization', 'snapshot', 'policy', 'refs', 'stateDir', 'sourceRepo', 'fakeExecutable']) baseFields[k] = ctx.f[k];
  const input = { base: baseFields, cas: s.url, store: path.join(ctx.dir, 'shared.sqlite'), seed: seedFile, r50: X.r50Policy(), approval: a, now: ctx.f.now, secret: X.SECRET, r46config: X.r46cfg(ctx.f), jwks: X.JWKS, oidc: X.oidcToken({}, { now: ctx.f.now }) };
  const file = path.join(dir, 'input.json'); fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
  const spawnWorker = mode => { const c = spawn(process.execPath, [path.join(__dirname, 'worker.cjs'), mode, file], { env: { PATH: process.env.PATH, ...(process.env.RUNNER_TEMP ? { RUNNER_TEMP: process.env.RUNNER_TEMP } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; c.stdout.on('data', b => out += b); return { c, out: () => out }; };
  const ev = spawnWorker('event');
  for (let i = 0; i < 200 && !ev.out().includes('\n'); i++) await new Promise(r => setTimeout(r, 10));
  const { url } = JSON.parse(ev.out().split('\n')[0]);
  const d = X.delivery(ctx.f);
  const tk = spawnWorker('tick');
  const [post] = await Promise.all([fetch(url, { method: 'POST', headers: d.headers, body: d.body }).then(r => r.json()), once(tk.c, 'close'), once(ev.c, 'close')]);
  const tickResult = JSON.parse(tk.out().trim());
  const states = [post.result.state, tickResult.state];
  assert.equal(ctx.f.cli.launches(), 1, JSON.stringify({ post, tickResult }));
  assert.equal(states.filter(x => x === 'SUCCEEDED').length >= 1, true);
  assert.ok([post.result.runner_calls, tickResult.runner_calls].filter(n => n === 1).length === 1, 'exactly one process crossed the R45 seam');
  assert.equal(Object.keys((await s.backend.read()).document.jobs).length, 1);
  assert.ok([post.result.actual_agent_launches, tickResult.actual_agent_launches].every(n => n === 0));
  evidence.cross_process_race = { event: post.result.state + '/' + (post.result.reason || ''), tick: tickResult.state + '/' + (tickResult.reason || ''), fake_cli_launches: ctx.f.cli.launches(), r46_jobs: 1 };
});

test('lost ACK on the claim commit: zero starts now and on every later trigger (no blind replay)', async t => {
  const ctx = X.base(t), s = await service(t, path.join(temp(t), 'cas.sqlite')); ctx.f.backend = s.backend;
  const a = X.approval(ctx.f);
  await s.fault('lost-ack');
  const first = await webhook(t, ctx, a);
  assert.notEqual(first.result.state, 'SUCCEEDED');
  const later = await tick(ctx, a, ctx.f.now + 10 * MIN);
  assert.notEqual(later.state, 'SUCCEEDED'); assert.equal(ctx.f.cli.launches(), 0);
  assert.equal(Object.keys((await s.backend.read()).document.jobs).length, 1, 'the committed claim is kept as evidence');
  evidence.lost_ack = { first: first.result.state + '/' + first.result.reason, later: later.state + '/' + later.reason, launches: 0 };
});

test('SIGKILL of the webhook receiver mid-run: restart and ticks never relaunch; recovery marks UNKNOWN with reserve kept', async t => {
  const ctx = X.base(t, 'hang', { runtime: 3000 });
  const dir = temp(t), s = await service(t, path.join(dir, 'cas.sqlite'));
  const seed = crypto.randomBytes(32), seedFile = path.join(dir, 'signer.seed'); fs.writeFileSync(seedFile, seed.toString('hex'), { mode: 0o600 });
  const signer = new TestSigner({ testOnly: true, seed });
  ctx.f.policy = X.H.policy({ allowed_issues: [32], pinned_gate_sha: X.H.HEAD, trusted_keys: { [signer.keyId]: { pem: signer.publicPem, roles: ['dispatcher'] } } });
  const a = X.approval(ctx.f);
  const baseFields = {}; for (const k of ['candidate_sha', 'config', 'envelope', 'authorization', 'snapshot', 'policy', 'refs', 'stateDir', 'sourceRepo', 'fakeExecutable']) baseFields[k] = ctx.f[k];
  const file = path.join(dir, 'input.json');
  fs.writeFileSync(file, JSON.stringify({ base: baseFields, cas: s.url, store: path.join(ctx.dir, 'shared.sqlite'), seed: seedFile, r50: X.r50Policy(), approval: a, now: ctx.f.now, secret: X.SECRET, r46config: X.r46cfg(ctx.f), jwks: X.JWKS, oidc: X.oidcToken({}, { now: ctx.f.now }) }), { mode: 0o600, flag: 'wx' });
  const c = spawn(process.execPath, [path.join(__dirname, 'worker.cjs'), 'event', file], { env: { PATH: process.env.PATH, ...(process.env.RUNNER_TEMP ? { RUNNER_TEMP: process.env.RUNNER_TEMP } : {}) }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; c.stdout.on('data', b => out += b);
  for (let i = 0; i < 200 && !out.includes('\n'); i++) await new Promise(r => setTimeout(r, 10));
  const d = X.delivery(ctx.f);
  fetch(JSON.parse(out.split('\n')[0]).url, { method: 'POST', headers: d.headers, body: d.body }).catch(() => {});
  for (let i = 0; i < 300 && ctx.f.cli.launches() === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.f.cli.launches(), 1, 'the fake CLI was started before the kill');
  c.kill('SIGKILL'); const [, sig] = await once(c, 'close'); assert.equal(sig, 'SIGKILL');
  const local = { ...ctx, f: Object.assign(ctx.f, { backend: s.backend, policy: ctx.f.policy }), broker: new Broker({ signer, policy: X.r50Policy(), store: new TriggerStore(path.join(ctx.dir, 'shared.sqlite')) }) };
  // The next tick is past the R46 lease: R46 itself converts the orphaned DISPATCHING job to
  // UNKNOWN/EXPIRED_NO_REPLAY instead of starting anything; the cost reservation is kept.
  const after = await tick(local, a, ctx.f.now + 10 * MIN);
  assert.deepEqual([after.state, after.reason], ['UNKNOWN', 'EXPIRED_NO_REPLAY']); assert.equal(after.runner_calls || 0, 0);
  const recovered = Object.values((await s.backend.read()).document.jobs)[0];
  assert.deepEqual([recovered.state, recovered.reason, recovered.reservation, recovered.outcome], ['UNKNOWN', 'EXPIRED_NO_REPLAY', 0.1, null]);
  const again = await tick(local, a, ctx.f.now + 10 * MIN);
  assert.notEqual(again.state, 'SUCCEEDED');
  await new Promise(r => setTimeout(r, 3500)); // the hung fake CLI is bounded by coreutils timeout even though its supervisor was killed
  assert.equal(ctx.f.cli.launches(), 1);
  local.broker.store.close();
  evidence.sigkill = { after_restart: after.state + '/' + after.reason, then: again.state + '/' + again.reason, reservation_kept: recovered.reservation, launches: 1 };
});

test('revocation, new independent REJECT, R46 signed HALT and the R50 kill switch all block before any start', async t => {
  const results = {};
  { const ctx = X.base(t), a = X.approval(ctx.f); ctx.store.revoke(a.approval_id, 'owner withdrew', ctx.f.now); const r = await webhook(t, ctx, a); results.revoked = r.result.reason; assert.equal(r.result.reason, 'APPROVAL_REVOKED'); assert.equal(ctx.f.cli.launches(), 0); assert.equal((await jobs(ctx)).length, 0); }
  { const ctx = X.base(t), a = X.approval(ctx.f); ctx.f.snapshot.issues[2].comments[0].body = ctx.f.snapshot.issues[2].comments[0].body.replace('verdict: ACCEPT', 'verdict: REJECT'); ctx.f.sign(); const r = await webhook(t, ctx, a); results.audit_reject = r.result.reason; assert.equal(r.result.state, 'BLOCKED'); assert.equal(ctx.f.cli.launches(), 0); }
  { const ctx = X.base(t), a = X.approval(ctx.f); ctx.f.snapshot.issues[4].comments[0].body = ctx.f.snapshot.issues[4].comments[0].body.replace('verdict: PASS', 'verdict: FAIL'); ctx.f.sign(); const r = await webhook(t, ctx, a); results.qa_fail = r.result.reason; assert.equal(r.result.state, 'BLOCKED'); assert.equal(ctx.f.cli.launches(), 0); }
  { const ctx = X.base(t), a = X.approval(ctx.f); ctx.f.operation = 'HALT'; ctx.f.sign(); assert.equal((await R.halt(ctx.f.input())).state, 'HALTED'); ctx.f.operation = 'RECONCILE'; ctx.f.sign(); const r = await webhook(t, ctx, a); results.halt = r.result.state + '/' + r.result.reason; assert.notEqual(r.result.state, 'SUCCEEDED'); assert.equal(ctx.f.cli.launches(), 0); }
  { const ctx = X.base(t), a = X.approval(ctx.f), kill = path.join(ctx.dir, 'KILL'); fs.writeFileSync(kill, ''); const d = X.delivery(ctx.f);
    const s = await serve({ secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, clock: () => ctx.f.now, onTrigger: record => handle({ record, base: ctx.f, broker: ctx.broker, approval: a, now: ctx.f.now, killFile: kill }) });
    t.after(() => new Promise(r => s.server.close(r)));
    const r = await (await fetch(s.url, { method: 'POST', headers: d.headers, body: d.body })).json(); results.kill_switch = r.result.reason; assert.equal(r.result.reason, 'KILL_SWITCH'); assert.equal(ctx.f.cli.launches(), 0); }
  evidence.revocation_and_stops = results;
});

test('GitHub/CAS 403, 429, 5xx and timeouts: no claim, no start, nothing leaked', async t => {
  for (const status of [403, 429, 500, 'timeout']) {
    const ctx = X.base(t), a = X.approval(ctx.f);
    ctx.f.backend = { read: async () => { if (status === 'timeout') { await new Promise(r => setTimeout(r, 50)); throw Object.assign(Error('timeout Bearer SECRET_SENTINEL'), { name: 'TimeoutError' }); } throw Object.assign(Error('Bearer SECRET_SENTINEL'), { status }); }, compareAndSwap: async () => { throw Error('unreachable'); } };
    const r = await webhook(t, ctx, a);
    assert.equal(r.result.state, 'BLOCKED', String(status)); assert.equal(ctx.f.cli.launches(), 0);
    assert.doesNotMatch(JSON.stringify(r), /SECRET_SENTINEL/);
  }
});

test('clock rollback and unknown cost: no second start, uncertainty is kept', async t => {
  { const ctx = X.base(t), a = X.approval(ctx.f), t0 = ctx.f.now;
    assert.equal((await webhook(t, ctx, a)).result.state, 'SUCCEEDED');
    const back = await tick(ctx, a, t0 - 2 * MIN);
    assert.notEqual(back.state, 'SUCCEEDED'); assert.equal(ctx.f.cli.launches(), 1);
    evidence.clock_rollback = back.state + '/' + back.reason; }
  { const ctx = X.base(t, 'nocost'), a = X.approval(ctx.f);
    const first = await webhook(t, ctx, a);
    assert.equal(first.result.state, 'UNKNOWN'); assert.equal(first.result.outcome.cost_known, false); assert.equal(first.result.outcome.cost, null);
    const again = await tick(ctx, a, ctx.f.now + 10 * MIN);
    assert.notEqual(again.state, 'SUCCEEDED'); assert.equal(ctx.f.cli.launches(), 1);
    evidence.unknown_cost = { first: first.result.state, again: again.state + '/' + again.reason }; }
});

test('missing pieces fail closed: no broker, no approval, tick without identity provider, unverified caller', async t => {
  const ctx = X.base(t), a = X.approval(ctx.f);
  const s = await serve({ secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, clock: () => ctx.f.now, onTrigger: record => handle({ record, base: ctx.f, broker: null, approval: a, now: ctx.f.now }) });
  t.after(() => new Promise(r => s.server.close(r)));
  const d = X.delivery(ctx.f);
  const nb = await (await fetch(s.url, { method: 'POST', headers: d.headers, body: d.body })).json();
  assert.equal(nb.result.reason, 'BLOCKED_TRUSTED_SIGNATURE_BROKER');
  assert.equal((await handle({ record: { kind: 'github_webhook', trigger: T.tick(ctx.f.now, ctx.f.config) }, base: ctx.f, broker: ctx.broker, approval: a, now: ctx.f.now })).reason, 'CALLER_NOT_TRUSTED');
  assert.equal((await handle({ record: null, base: ctx.f, broker: ctx.broker, approval: a, now: ctx.f.now })).reason, 'UNTRUSTED_TRIGGER');
  assert.equal(tickRecord({ kind: 'github_actions_oidc' }, ctx.f.now, ctx.f.config), null, 'a plain object is not an OIDC identity');
  assert.throws(() => verifyOidc(X.oidcToken({}, { now: ctx.f.now }), { jwks: null, policy: X.r50Policy(), now: ctx.f.now }), e => e.code === 'BLOCKED_IDENTITY_PROVIDER');
  const missingApproval = await handle({ record: require('../../trusted-trigger-r50/intake').verifyDelivery(X.delivery(ctx.f), { secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, now: ctx.f.now }), base: ctx.f, broker: ctx.broker, approval: null, now: ctx.f.now });
  assert.equal(missingApproval.reason, 'APPROVAL_MALFORMED');
  assert.equal(ctx.f.cli.launches(), 0); assert.equal((await jobs(ctx)).length, 0);
  const ready = require('../../trusted-trigger-r50/cli').readiness({});
  assert.equal(ready.state, 'BLOCKED'); assert.equal(ready.actual_agent_launches, 0);
  for (const b of ['BLOCKED_SIGNER_NOT_CONFIGURED', 'BLOCKED_IDENTITY_PROVIDER', 'REAL_SCHEDULE_NOT_ENABLED', 'NO_APPROVER_KEY']) assert.ok(ready.blockers.includes(b), b);
});

test('workflows: this branch never schedules, never takes events, never reads secrets; the default-branch sample stays disabled', () => {
  const root = path.resolve(__dirname, '../../../..');
  const own = fs.readFileSync(path.join(root, '.github/workflows/claude-r50-trusted-trigger.yml'), 'utf8');
  assert.doesNotMatch(own, /schedule:|issue_comment:|workflow_run:|pull_request_target|secrets\.|id-token:\s*write/);
  assert.match(own, /contents: read/);
  const tpl = path.join(root, 'tools/relay/trusted-trigger-r50/templates/default-branch-trigger.yml.disabled');
  assert.ok(fs.existsSync(tpl)); assert.ok(!fs.readdirSync(path.join(root, '.github/workflows')).some(n => /^r50-trusted-trigger\.ya?ml$/.test(n)), 'sample is not installed as a workflow');
  if (process.env.R50_OUT) { fs.mkdirSync(process.env.R50_OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.R50_OUT, 'r50-e3-evidence.json'), JSON.stringify({ head_sha: X.H.HEAD, evidence: 'E3_FAKE (real HTTP, real processes, real SQLite CAS, marked fake CLI, synthetic keys)', actual_agent_launches: 0, real_schedule: 'NOT_ENABLED', real_webhook: 'NOT_INSTALLED', scenarios: evidence }, null, 2) + '\n'); }
});
