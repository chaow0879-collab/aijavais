'use strict';
// R45 runner with REAL child processes, a REAL private git workspace and a marked fake CLI
// (never the official CLI, never a model): evidence E3_FAKE. actual_agent_launches stays 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runOnce, command } = require('../../agent-pilot-r45/runner');
const C = require('../../agent-pilot-r45/contract');
const H = require('./helpers.cjs');

const fake = (t, mode, over = {}, extra = {}) => {
  const dir = H.tmp(t), cli = H.fakeCli(dir, mode);
  const state = path.join(dir, 'state');
  return { dir, cli, state, run: (env = H.envelope(over), o = {}) => runOnce(env, { policy: H.policy(), stateDir: state, sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: cli.file, ...extra, ...o }) };
};
const valid = o => assert.deepEqual(C.outcomeErrors(o), [], JSON.stringify(o));
const alive = require('../../agent-pilot-r45/journal').isAlive; // zombie-aware

test('default mode is DRY_RUN: nothing is cloned or started and the prompt is not exposed', async t => {
  const dir = H.tmp(t);
  const o = await runOnce(H.envelope(), { policy: H.policy(), stateDir: path.join(dir, 's') });
  valid(o); assert.equal(o.state, 'DRY_RUN'); assert.equal(o.agent_launch.process_launches, 0); assert.equal(o.agent_launch.actual_agent_launches, 0);
  assert.ok(o.agent_launch.planned_args.includes('<template:readonly-repo-summary>'));
  assert.ok(['--permission-mode', 'plan', '--allowedTools', 'Read,Glob,Grep', '--no-session-persistence', '--max-budget-usd', '0.1'].every(a => o.agent_launch.planned_args.includes(a)));
  assert.equal(o.evidence.level, 'E2');
});

test('fake CLI success: one real subprocess on the exact SHA, sanitized log, known cost, no real agent launch', async t => {
  const f = fake(t, 'success');
  const o = await f.run();
  valid(o);
  assert.equal(o.state, 'SUCCESS'); assert.equal(o.retry, 'none'); assert.equal(o.source_sha, H.HEAD);
  assert.ok(Number.isSafeInteger(o.process.pid) && o.process.pid > 0); assert.equal(o.process.exit_code, 0);
  assert.equal(o.process.wrapper, fs.existsSync('/usr/bin/timeout') ? 'coreutils-timeout' : null);
  assert.deepEqual(o.cost, { known: true, usd: 0.0123, cap_usd: 0.1 });
  assert.deepEqual([o.agent_launch.mode, o.agent_launch.real_agent_launch, o.agent_launch.actual_agent_launches, o.agent_launch.process_launches], ['fake', false, 0, 1]);
  assert.equal(o.evidence.level, 'E3_FAKE_CLI'); assert.match(o.evidence.log_sha256, /^[a-f0-9]{64}$/);
  assert.equal(o.evidence.result_excerpt, 'FAKE: repository summary');
  assert.equal(f.cli.launches(), 1);
  const args = JSON.parse(fs.readFileSync(f.cli.counter, 'utf8').trim()).args;
  assert.deepEqual(args, command('claude', require('../../agent-pilot-r45/templates.json')['readonly-repo-summary'], 0.1), 'exact official-CLI argument shape');
  assert.equal(fs.readdirSync(f.state).filter(n => n.startsWith('log-')).length, 1);
  assert.equal(fs.statSync(path.join(f.state, fs.readdirSync(f.state).find(n => n.startsWith('log-')))).mode & 0o077, 0, 'log is private');
});

test('child environment is allow-listed: no host session, proxy or GitHub tokens; private HOME', async t => {
  const f = fake(t, 'env');
  const o = await f.run(H.envelope(), { env: { ...process.env, GITHUB_TOKEN: 'ghp_shouldnotleak', ANTHROPIC_API_KEY: 'sk-ant-fake-not-passed-in-fake-mode' } });
  assert.equal(o.state, 'SUCCESS');
  const log = fs.readFileSync(path.join(f.state, o.evidence.log_file), 'utf8');
  const names = JSON.parse(JSON.parse(log.split('\n').find(l => l.startsWith('{"type"'))).result).names;
  assert.deepEqual(names.filter(n => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'CI', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'PWD', 'SHLVL', '_'].includes(n)), []);
  assert.doesNotMatch(log, /ghp_shouldnotleak|sk-ant-fake/);
});

test('secrets printed by a CLI are redacted from the stored log', async t => {
  const f = fake(t, 'leak');
  const o = await f.run();
  const log = fs.readFileSync(path.join(f.state, o.evidence.log_file), 'utf8');
  assert.doesNotMatch(log, /THISISAFAKESECRETVALUE|ghp_abcdefghij|Bearer abc\.def/);
  assert.match(log, /\[REDACTED\]/);
});

for (const [mode, state, reason, retry] of [
  ['fail', 'FAILED', 'NONZERO_EXIT', 'manual_only'], ['unauth', 'FAILED', 'AUTH_FAILED', 'never'], ['denied', 'FAILED', 'ACCESS_DENIED', 'never'],
  ['iserror', 'FAILED', 'CLI_REPORTED_ERROR', 'manual_only'], ['overcost', 'FAILED', 'COST_CAP_EXCEEDED', 'never'], ['write', 'FAILED', 'READONLY_VIOLATION', 'never'],
  ['bigout', 'FAILED', 'OUTPUT_LIMIT', 'manual_only']])
  test(`fake CLI ${mode} → ${state}/${reason}, retry ${retry}, launched once, cost not invented`, async t => {
    const f = fake(t, mode);
    const o = await f.run();
    valid(o); assert.equal(o.state, state); assert.equal(o.reason, reason); assert.equal(o.retry, retry);
    assert.equal(o.agent_launch.process_launches, 1); assert.equal(o.agent_launch.actual_agent_launches, 0);
    if (['fail', 'unauth', 'denied', 'bigout'].includes(mode)) assert.deepEqual([o.cost.known, o.cost.usd], [false, null], 'unknown cost stays null');
    // Never relaunched afterwards.
    const again = await f.run(H.envelope());
    assert.equal(again.state, 'DUPLICATE'); assert.equal(f.cli.launches(), 1);
  });

test('timeout kills the whole process group (CLI and its children); never retried automatically', async t => {
  const f = fake(t, 'hang');
  const started = Date.now();
  const o = await f.run(H.envelope({ task: { max_runtime_ms: 1500 } }));
  valid(o); assert.equal(o.state, 'TIMEOUT'); assert.equal(o.retry, 'manual_only');
  assert.ok(Date.now() - started < 15000);
  const pids = JSON.parse(fs.readFileSync(path.join(f.dir, 'hang-pids.json'), 'utf8'));
  await new Promise(r => setTimeout(r, 500));
  assert.ok(pids.every(p => !alive(p)), 'no orphaned CLI or grandchild');
});

test('cancellation stops the run and is recorded as CANCELLED', async t => {
  const f = fake(t, 'hang');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 700);
  const o = await f.run(H.envelope({ task: { max_runtime_ms: 20000 } }), { signal: ac.signal });
  valid(o); assert.equal(o.state, 'CANCELLED'); assert.equal(o.retry, 'manual_only');
});

test('CLI missing → BLOCKED with zero process launches', async t => {
  const dir = H.tmp(t), missing = path.join(dir, 'bin', 'claude');
  const o = await runOnce(H.envelope(), { policy: H.policy(), stateDir: path.join(dir, 's'), sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: missing });
  valid(o); assert.equal(o.state, 'BLOCKED'); assert.match(o.reason, /CLI_NOT_FOUND|SPAWN_FAILED/); assert.equal(o.agent_launch.process_launches, 0);
});

test('fake mode refuses unmarked executables (cannot be used to run the real CLI)', async t => {
  const dir = H.tmp(t), exe = path.join(dir, 'claude');
  fs.writeFileSync(exe, '#!/bin/sh\necho real\n', { mode: 0o700 });
  const o = await runOnce(H.envelope(), { policy: H.policy(), stateDir: path.join(dir, 's'), sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: exe });
  assert.equal(o.state, 'REJECTED'); assert.equal(o.reason, 'FAKE_CLI_NOT_MARKED');
  assert.equal((await runOnce(H.envelope(), { policy: H.policy({ allow_fake_cli: false }), stateDir: path.join(dir, 's2'), sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: exe })).reason, 'FAKE_CLI_NOT_ALLOWED');
});

test('wrong / unknown source SHA → BLOCKED WRONG_SHA before any launch', async t => {
  const f = fake(t, 'success');
  const unknown = 'e'.repeat(40);
  const o = await f.run(H.envelope({ source: { sha: unknown }, gate: { gate_sha: unknown, audit: { reviewed_sha: unknown }, qa: { reviewed_sha: unknown } } }), { policy: H.policy({ pinned_gate_sha: unknown }) });
  valid(o); assert.equal(o.state, 'BLOCKED'); assert.equal(o.reason, 'WRONG_SHA'); assert.equal(o.retry, 'never'); assert.equal(f.cli.launches(), 0);
});

test('duplicate task id: same envelope twice, or same work from event and fallback tick → one launch', async t => {
  const f = fake(t, 'success');
  const e = H.envelope();
  assert.equal((await f.run(e)).state, 'SUCCESS');
  const dup = await f.run(e); valid(dup); assert.equal(dup.state, 'DUPLICATE'); assert.equal(dup.retry, 'none'); assert.ok(dup.evidence.previous_run_id);
  const tick = await f.run(H.envelope({ dispatch_id: 'dsp-tick-x', trigger: { kind: 'fallback_tick', event_id: 'tick-1' } }));
  assert.equal(tick.state, 'DUPLICATE');
  assert.equal(f.cli.launches(), 1);
});

test('one dispatch id may not be reused for different work', async t => {
  const f = fake(t, 'success');
  assert.equal((await f.run(H.envelope({ dispatch_id: 'dsp-fixed-1' }))).state, 'SUCCESS');
  const o = await f.run(H.envelope({ dispatch_id: 'dsp-fixed-1', task: { template: 'readonly-head-check' } }));
  assert.equal(o.state, 'REJECTED'); assert.equal(o.reason, 'DISPATCH_ID_CONFLICT'); assert.equal(f.cli.launches(), 1);
});

test('restart after a crash: an unfinished claim is never relaunched (HUMAN_REVIEW_REQUIRED)', async t => {
  const f = fake(t, 'success');
  const e = H.envelope();
  const { Journal } = require('../../agent-pilot-r45/journal');
  const j = new Journal(f.state); j.bindDispatch(e.dispatch_id, C.dedupeKey(e));
  fs.writeFileSync(j.file('claim', C.dedupeKey(e)), JSON.stringify({ run_id: 'crashed', pid: 2147483646 }), { mode: 0o600 });
  fs.writeFileSync(j.file('state', C.dedupeKey(e)), JSON.stringify({ state: 'RUNNING', at: new Date().toISOString() }), { mode: 0o600 });
  const o = await f.run(e);
  valid(o); assert.equal(o.state, 'HUMAN_REVIEW_REQUIRED'); assert.equal(o.retry, 'manual_only'); assert.equal(f.cli.launches(), 0);
});

test('kill switch (env or KILL file) blocks before and after claim', async t => {
  const f = fake(t, 'success');
  assert.equal((await f.run(H.envelope(), { env: { ...process.env, AIJ_PILOT_KILL: '1' } })).reason, 'KILL_SWITCH');
  fs.mkdirSync(f.state, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(f.state, 'KILL'), '');
  assert.equal((await f.run(H.envelope())).reason, 'KILL_SWITCH');
  assert.equal(f.cli.launches(), 0);
});

test('four racing runner processes on one envelope start the CLI exactly once', async t => {
  const f = fake(t, 'success');
  const envFile = path.join(f.dir, 'envelope.json'), polFile = path.join(f.dir, 'policy.json');
  fs.writeFileSync(envFile, JSON.stringify(H.envelope())); fs.writeFileSync(polFile, JSON.stringify({ trusted_keys: H.trusted, allow_fake_cli: true, pinned_gate_sha: H.GATE }));
  const cli = path.join(H.ROOT, 'tools/relay/agent-pilot-r45/cli.js');
  const one = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [cli, 'run', '--envelope', envFile, '--state-dir', f.state, '--policy', polFile, '--source-repo', H.ROOT, '--fake-cli', f.cli.file], { env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    let out = ''; c.stdout.on('data', d => out += d); c.on('error', reject); c.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(Error(out)); } });
  });
  const rs = await Promise.all([one(), one(), one(), one()]);
  assert.equal(rs.filter(r => r.state === 'SUCCESS').length, 1, JSON.stringify(rs.map(r => [r.state, r.reason])));
  assert.ok(rs.every(r => ['SUCCESS', 'DUPLICATE', 'HUMAN_REVIEW_REQUIRED'].includes(r.state)));
  assert.equal(f.cli.launches(), 1);
});

test('live mode refusals: off by default, needs --live + AIJ_PILOT_LIVE=1 + verified CLI + credentials + ephemeral runner', async t => {
  const dir = H.tmp(t);
  const run = (policyOver, opts) => runOnce(H.envelope(), { policy: H.policy(policyOver), stateDir: path.join(dir, 's' + Math.random()), sourceRepo: H.ROOT, mode: 'live', ...opts });
  const pf = (over) => ({ clis: { claude: { status: 'VERIFIED', path: '/nonexistent/claude', version: '9 (Claude Code)' } }, credentials: { claude: { status: 'PRESENT_UNVERIFIED' } }, runner: { ephemeral_github_hosted: true }, ...over });
  const envOn = { ...process.env, AIJ_PILOT_LIVE: '1' };
  assert.equal((await run({}, { live: true, env: envOn })).reason, 'LIVE_NOT_ENABLED', 'shipped config keeps live off');
  assert.equal((await run({ live_enabled: true }, { live: false, env: envOn })).reason, 'LIVE_NOT_ENABLED');
  assert.equal((await run({ live_enabled: true }, { live: true, env: { ...process.env, AIJ_PILOT_LIVE: '' } })).reason, 'LIVE_NOT_ENABLED');
  assert.equal((await run({ live_enabled: true }, { live: true, env: envOn, preflight: pf({ clis: { claude: { status: 'NOT_RUN', reason: 'CLI_NOT_INSTALLED' } } }) })).reason, 'CLI_CLI_NOT_INSTALLED');
  assert.equal((await run({ live_enabled: true }, { live: true, env: envOn, preflight: pf({ credentials: { claude: { status: 'NOT_CONFIGURED' } } }) })).reason, 'CREDENTIALS_NOT_CONFIGURED');
  assert.equal((await run({ live_enabled: true }, { live: true, env: envOn, preflight: pf({ runner: { ephemeral_github_hosted: false } }) })).reason, 'NOT_EPHEMERAL_RUNNER');
  // All conditions satisfied but the "official" binary is absent: still no agent launch counted.
  const o = await run({ live_enabled: true }, { live: true, env: envOn, preflight: pf() });
  valid(o); assert.equal(o.state, 'BLOCKED'); assert.equal(o.agent_launch.actual_agent_launches, 0);
});

test('unknown template id is refused; envelopes cannot carry prompts', async t => {
  const o = await runOnce(H.envelope({ task: { template: '_comment' } }), { policy: H.policy(), stateDir: path.join(H.tmp(t), 's') });
  assert.equal(o.state, 'REJECTED'); assert.equal(o.reason, 'UNKNOWN_TEMPLATE');
});
