'use strict';
// R48 cross-branch conformance matrix. Every row EXECUTES the frozen R45 and/or R46 code
// loaded from the read-only assembled trees (no copies edited, no source analysis passed
// off as a run). Verdicts:
//   COMPATIBLE            the two sides agree as delivered
//   COMPATIBLE_WITH_DELTA they agree once the listed minimal delta is applied (test-only bridge)
//   INCOMPATIBLE          they do not interoperate as delivered (delta proposed)
//   SAFE_REFUSAL          an unsafe input was refused, as required
//   UNSAFE_ACCEPTED       an input that must be refused was accepted (a finding)
//   HARNESS_ERROR         the scenario was not actually exercised (never counted as a pass)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assemble, cleanup, SOURCES, GATE_FACTS } = require('./sources');
const { TestBroker, toR45, toR46 } = require('./bridge');

const REFS = { log_ref: 'https://github.com/chaow0879-collab/aijavais/actions/runs/1', ci_ref: 'https://github.com/chaow0879-collab/aijavais/actions/runs/1', report_ref: 'https://github.com/chaow0879-collab/aijavais/issues/30#issuecomment-1' };
const code = fn => { try { const v = fn(); return { ok: true, value: v }; } catch (e) { return { ok: false, error: e.code || e.message }; } };
const acode = async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.code || e.message }; } };

function load(m) {
  const r45 = p => require(path.join(m.sources.r45.dir, 'tools/agent-pilot-r45', p));
  const r46 = p => require(path.join(m.sources.r46.dir, p));
  return {
    m, P45: r45('contract.js'), POL: r45('policy.js'), RUN: r45('runner.js'), PRE: r45('preflight.js'), r45cli: path.join(m.sources.r45.dir, 'tools/agent-pilot-r45/cli.js'),
    B: r46('tools/auto-handoff-r46/pilot-contract'), C46: r46('tools/auto-handoff-r46/contract'), T: r46('tools/auto-handoff-r46/triggers'),
    REC: r46('tools/auto-handoff-r46/reconcile'), F: r46('tests/auto-handoff-r46/fixtures.cjs'), R46CFG: r46('tools/auto-handoff-r46/config.json'),
    R45CFG: r45('config.json')
  };
}
// One R46-prepared Fake frame. Budget/kind/verdict overrides model what a real control plane would send.
function r46Frame(L, { kind = 'claude', budget = 0.1, audit = 'ACCEPT', qa = 'PASS', trigger = 'tick' } = {}) {
  const f = L.F.fixture({ kind });
  f.config.max_cost = budget; f.config.max_daily_cost = Math.max(budget, f.config.max_daily_cost); f.envelope.limits.max_cost = budget;
  if (audit !== 'ACCEPT') f.snapshot.issues[2].comments[0].body = f.snapshot.issues[2].comments[0].body.replace('verdict: ACCEPT', 'verdict: ' + audit);
  if (qa !== 'PASS') f.snapshot.issues[4].comments[0].body = f.snapshot.issues[4].comments[0].body.replace('verdict: PASS', 'verdict: ' + qa);
  f.sign();
  const t = trigger === 'tick' ? L.T.tick(f.now, f.config) : L.T.webhook(L.F.webhook(f), f.config, f.now);
  return { f, prepare: () => L.B.prepare({ ...f.input(), trigger: t }) };
}
function workdir() { const d = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'r48-run-')); fs.chmodSync(d, 0o700); return d; }
function fakeCli(dir, mode) {
  const counter = path.join(dir, 'launches.jsonl'), file = path.join(dir, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\n# AIJAVAIS_FAKE_CLI (R48)\nexec "' + process.execPath + '" "' + path.join(__dirname, 'fixtures/fake-cli.cjs') + '" ' + mode + ' "' + counter + '" "$@"\n', { mode: 0o700 });
  return { file, launches: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0) };
}

async function runMatrix({ repo = process.cwd(), keep = false } = {}) {
  const m = assemble(repo);
  const L = load(m);
  const rows = [];
  const row = (id, area, check, verdict, actual, extra = {}) => rows.push({ id, area, check, verdict, actual, method: 'executed', ...extra });
  const broker = new TestBroker({ testOnly: true });
  const policy = (over = {}) => L.POL.loadPolicy({ trusted_keys: broker.trustEntry(), allowed_issues: [30], allow_fake_cli: true, pinned_gate_sha: GATE_FACTS.r43_candidate, ...over });
  const dirs = [];
  const run45 = async (envelope, mode, opts = {}) => {
    const d = opts.dir || workdir(); if (!opts.dir) dirs.push(d);
    const cli = opts.cli || fakeCli(d, mode);
    const o = await L.RUN.runOnce(envelope, { policy: opts.policy || policy(), stateDir: path.join(d, 'state'), sourceRepo: repo, mode: 'fake', fakeExecutable: cli.file, ...opts.run });
    return { o, cli, d };
  };
  try {
    // ---------------- C: protocol compatibility as delivered ----------------
    const tickFrame = r46Frame(L).prepare(), eventFrame = r46Frame(L, { trigger: 'event' }).prepare();
    const tickSigned = toR45(tickFrame, { broker, canonical: L.P45.canonical }).envelope;
    row('C01', 'identity', 'R46 dedupe_key == R45 dedupeKey (event and tick)', L.P45.dedupeKey(tickSigned) === tickFrame.dedupe_key && tickFrame.dedupe_key === eventFrame.dedupe_key ? 'COMPATIBLE' : 'INCOMPATIBLE', { r46: tickFrame.dedupe_key.slice(0, 16), r45: L.P45.dedupeKey(tickSigned).slice(0, 16), event_equals_tick: tickFrame.dedupe_key === eventFrame.dedupe_key });
    row('C02', 'identity', 'R46 envelope_digest == R45 envelopeDigest', L.P45.envelopeDigest(tickSigned) === tickFrame.envelope_digest ? 'COMPATIBLE' : 'INCOMPATIBLE', {});
    row('C03', 'envelope', 'R45 shape of the R46 frame', L.P45.shapeErrors(tickFrame.unsigned_envelope).join() === 'SIGNATURE' ? 'INCOMPATIBLE' : 'COMPATIBLE', { r45_shape_errors: L.P45.shapeErrors(tickFrame.unsigned_envelope), bridge: toR45(tickFrame).status },
      { delta: 'A trusted dispatcher broker (independently audited, key outside fixtures) must sign the R46 frame after the gates pass; R46 deliberately emits NOT_SIGNED. Without it: BLOCKED_TRUSTED_SIGNATURE_BROKER.' });
    const frozenBudget = r46Frame(L, { budget: L.R46CFG.max_cost }).prepare();
    const fb = L.POL.authorize(toR45(frozenBudget, { broker, canonical: L.P45.canonical }).envelope, policy());
    row('C04', 'cost', 'R46 frozen config max_cost=' + L.R46CFG.max_cost + ' accepted by R45', fb === null ? 'COMPATIBLE' : 'INCOMPATIBLE', { r45: fb, r46_frame_cap_usd: frozenBudget.unsigned_envelope.cost.cap_usd },
      { delta: 'A real run needs a positive, enforceable cap: R46 config max_cost/max_daily_cost > 0 and ≤ R45 policy max_budget_usd. R45 correctly refuses cap 0 (it cannot enforce "no spend").' });
    const codexFrame = r46Frame(L, { kind: 'codex' }).prepare();
    const ck = L.POL.authorize(toR45(codexFrame, { broker, canonical: L.P45.canonical }).envelope, policy());
    row('C05', 'cost', 'R46 default fixture kind=codex accepted by R45', ck === null ? 'COMPATIBLE' : 'INCOMPATIBLE', { r45: ck }, { delta: 'First pilot must use kind=claude (native --max-budget-usd). Codex stays refused until an account-level spend limit is attested.' });
    const di = L.POL.authorize(tickSigned, L.POL.loadPolicy({ trusted_keys: broker.trustEntry(), allow_fake_cli: true }));
    row('C06', 'scope', 'R46 issue ' + tickSigned.issue + ' under R45 shipped allowed_issues ' + JSON.stringify(L.R45CFG.allowed_issues), di === null ? 'COMPATIBLE' : 'INCOMPATIBLE', { r45: di }, { delta: 'Integration config: R45 allowed_issues must list the control-plane issue used by R46 envelopes.' });
    // normalize() needs the very R46 envelope that produced the frame: keep a matched pair.
    const pair = r46Frame(L); const pairFrame = pair.prepare(); const pairSigned = toR45(pairFrame, { broker, canonical: L.P45.canonical }).envelope;
    const pairRun = await run45(pairSigned, 'success');
    const directPair = code(() => L.B.normalize(pairRun.o, pairFrame, pair.f.envelope, REFS));
    row('C07', 'outcome', 'real R45 SUCCESS outcome accepted by R46 normalize() as delivered', directPair.ok ? 'COMPATIBLE' : 'INCOMPATIBLE', { r45_state: pairRun.o.state, r45_level: pairRun.o.evidence.level, r45_process_keys: Object.keys(pairRun.o.process || {}), r46: directPair.error || 'OK' },
      { delta: 'R46 normalize() reads process.exit and evidence.level "E3_FAKE"; R45 emits process.exit_code and "E3_FAKE_CLI". R46 own tests use a hand-built outcome, not R45 output.' });
    const mapped = toR46(pairRun.o);
    const viaDelta = code(() => L.B.normalize(mapped.outcome, pairFrame, pair.f.envelope, REFS));
    row('C08', 'outcome', 'same outcome after the two-field test mapping', viaDelta.ok ? 'COMPATIBLE_WITH_DELTA' : 'INCOMPATIBLE', viaDelta.ok ? { state: viaDelta.value.state, exit_code: viaDelta.value.exit_code, cost_known: viaDelta.value.cost_known, cost: viaDelta.value.cost, actual_agent_launches: viaDelta.value.actual_agent_launches } : { r46: viaDelta.error });
    const dup = await run45(pairSigned, 'success', { dir: pairRun.d, cli: pairRun.cli });
    const dupMap = toR46(dup.o), dupDirect = code(() => L.B.normalize(dup.o, pairFrame, pair.f.envelope, REFS));
    row('C09', 'outcome', 'R45 DUPLICATE (redelivered work) understood by R46', 'INCOMPATIBLE', { r45: dup.o.state, launches: pairRun.cli.launches(), r46_direct: dupDirect.error, bridge: dupMap.status },
      { delta: 'R46 has no state for R45 DUPLICATE/DRY_RUN; it must treat DUPLICATE as RUNNER_WORK_ALREADY_RECORDED (read-only recheck, never redispatch) and keep previous_run_id.' });
    const foreign = await L.REC.reconcile({ ...pair.f.input(), runner: { run: async () => ({}) } });
    row('C10', 'control-loop', 'R46 reconcile() can drive an R45 runner', foreign.reason === 'FAKE_RUNNER_REQUIRED' ? 'INCOMPATIBLE' : 'COMPATIBLE', { r46: foreign.state + '/' + foreign.reason },
      { delta: 'R46 reconcile() only accepts its own FakeR45Runner; the R45 seam (prepare/normalize) is not wired into the control loop. Integrator must add one audited runner seam: claim → prepare → broker sign → R45 runOnce → toR46 delta → normalize → settle.' });
    for (const [mode, expectState] of [['unauth', 'FAILED'], ['fail', 'FAILED'], ['nocost', 'SUCCESS']]) {
      const p = r46Frame(L); const fr = p.prepare(); const r = await run45(toR45(fr, { broker, canonical: L.P45.canonical }).envelope, mode);
      const n = code(() => L.B.normalize(toR46(r.o).outcome, fr, p.f.envelope, REFS));
      row('C11-' + mode, 'outcome', 'R45 ' + r.o.state + '/' + r.o.reason + ' → R46 (with delta)', n.ok && n.value.state === expectState && n.value.retry === 'NEVER' ? 'COMPATIBLE_WITH_DELTA' : 'INCOMPATIBLE', n.ok ? { r46_state: n.value.state, retry: n.value.retry, cost_known: n.value.cost_known, cost: n.value.cost } : { r46: n.error });
    }
    const real = { ...pairRun.o, agent_launch: { ...pairRun.o.agent_launch, real_agent_launch: true, actual_agent_launches: 1 }, evidence: { ...pairRun.o.evidence, level: 'E4_CANDIDATE_REQUIRES_INDEPENDENT_VERIFICATION' } };
    const rb = code(() => toR46(real)), rn = code(() => L.B.normalize(real, pairFrame, pair.f.envelope, REFS));
    row('C12', 'evidence', 'a live/E4 outcome is never relabelled as Fake by either side', !rb.ok && !rn.ok ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { bridge: rb.error, r46: rn.error });
    const r47 = code(() => L.C46.validateEnvelope({ ...pair.f.envelope, source_sha: GATE_FACTS.r47_fix_candidate }, { ...pair.f.config, source_sha: GATE_FACTS.r47_fix_candidate }, pair.f.now));
    row('C13', 'gate-binding', 'R46 can address the R47 fix candidate ' + GATE_FACTS.r47_fix_candidate.slice(0, 8), r47.ok ? 'COMPATIBLE' : 'INCOMPATIBLE', { r46: r47.error, r46_pinned_source: L.C46.SOURCE },
      { delta: 'R46 hard-pins SOURCE to the REJECTED R43 candidate ab3e079. After R47 is independently ACCEPTED the integrator must re-pin to the accepted SHA (code change + audit), never relax the pin.' });

    // ---------------- S: safety must survive the bridge ----------------
    const pinned = policy();
    const swap = broker.sign({ ...tickSigned, source: { ...tickSigned.source, sha: 'd'.repeat(40) } }, L.P45.canonical);
    const sw = L.POL.authorize(swap, pinned);
    row('S01', 'AUD-R43-01', 'R45: source.sha ≠ audited gate_sha (same trusted signer, gate pinned)', sw === null ? 'UNSAFE_ACCEPTED' : 'SAFE_REFUSAL', { r45: sw === null ? 'AUTHORIZED' : sw },
      { severity: 'P1_CANDIDATE_BLOCKS_GO', delta: 'R45 authorize() checks audit.reviewed_sha == gate.gate_sha but never source.sha == gate.gate_sha, so a trusted signer could have the CLI read an unaudited SHA. R46 always emits gate_sha = source_sha, so requiring equality in R45 costs nothing. Fix in the integration candidate before any GO (R48 may not edit frozen R45).' });
    const gateMoved = broker.sign({ ...tickSigned, gate: { ...tickSigned.gate, gate_sha: 'e'.repeat(40), audit: { ...tickSigned.gate.audit, reviewed_sha: 'e'.repeat(40) }, qa: { ...tickSigned.gate.qa, reviewed_sha: 'e'.repeat(40) } }, source: { ...tickSigned.source, sha: 'e'.repeat(40) } }, L.P45.canonical);
    row('S02', 'AUD-R43-01', 'R45: re-signed frame moved to another (unaudited) candidate', L.POL.authorize(gateMoved, pinned) === 'GATE_SHA_NOT_PINNED' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r45: L.POL.authorize(gateMoved, pinned) });
    const r46wrong = code(() => L.C46.validateEnvelope({ ...pair.f.envelope, source_sha: 'f'.repeat(40) }, pair.f.config, pair.f.now));
    row('S03', 'AUD-R43-01', 'R46: envelope for an unpinned SHA', r46wrong.ok ? 'UNSAFE_ACCEPTED' : 'SAFE_REFUSAL', { r46: r46wrong.error });
    const rejectReal = code(() => r46Frame(L, { audit: 'REJECT' }).prepare());
    row('S04', 'independent-gates', 'R46 prepare() with the real ab3e audit verdict REJECT', rejectReal.ok ? 'UNSAFE_ACCEPTED' : 'SAFE_REFUSAL', { r46: rejectReal.error, fact: GATE_FACTS.r43_audit_ref });
    const rejectSigned = broker.sign({ ...tickSigned, gate: { ...tickSigned.gate, audit: { ...tickSigned.gate.audit, verdict: 'REJECT' } } }, L.P45.canonical);
    row('S05', 'independent-gates', 'R45 with a broker-signed audit REJECT', L.POL.authorize(rejectSigned, pinned) === 'MISSING_OR_FAILED_AUDIT' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r45: L.POL.authorize(rejectSigned, pinned) });
    const qaFail = code(() => r46Frame(L, { qa: 'FAIL' }).prepare());
    const qaSigned = broker.sign({ ...tickSigned, gate: { ...tickSigned.gate, qa: { ...tickSigned.gate.qa, verdict: 'FAIL' } } }, L.P45.canonical);
    row('S06', 'independent-gates', 'QA FAIL refused by R46 and by R45', !qaFail.ok && L.POL.authorize(qaSigned, pinned) === 'MISSING_OR_FAILED_QA' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r46: qaFail.error, r45: L.POL.authorize(qaSigned, pinned) });
    const forged = { ...tickSigned, signature: { ...tickSigned.signature, value: Buffer.alloc(64, 7).toString('base64') } };
    const other = new TestBroker({ testOnly: true });
    row('S07', 'signature', 'forged signature / key not trusted / shipped R45 policy', L.POL.authorize(forged, pinned) === 'BAD_SIGNATURE' && L.POL.authorize(other.sign(tickFrame.unsigned_envelope, L.P45.canonical), pinned) === 'UNTRUSTED_KEY' && L.POL.authorize(tickSigned, L.POL.loadPolicy()) === 'UNTRUSTED_KEY' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED',
      { forged: L.POL.authorize(forged, pinned), other_key: L.POL.authorize(other.sign(tickFrame.unsigned_envelope, L.P45.canonical), pinned), shipped_policy: L.POL.authorize(tickSigned, L.POL.loadPolicy()) });
    const f0 = r46Frame(L).f, wh = over => code(() => L.T.webhook(Object.assign(L.F.webhook(f0, over.payload || {}), over.meta || {}), f0.config, f0.now));
    const fork = wh({ payload: { repository: { full_name: L.C46.REPO, id: f0.config.repository_id, fork: true } } });
    const stranger = wh({ payload: { sender: { login: 'stranger' } } });
    const pr = wh({ payload: { action: 'completed', workflow_run: { conclusion: 'success', event: 'pull_request', head_repository: { full_name: L.C46.REPO, fork: false }, head_sha: f0.config.source_sha, head_branch: 'integrate/r43-unified-product-autoexec' } }, meta: { event: 'workflow_run' } });
    const badSig = code(() => { const w = L.F.webhook(f0); return L.T.webhook({ ...w, signature: 'sha256=' + '0'.repeat(64) }, f0.config, f0.now); });
    row('S08', 'trigger', 'fork / unknown sender / PR workflow_run / bad HMAC events', [fork, stranger, pr, badSig].every(x => !x.ok) ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { fork: fork.error, stranger: stranger.error, pull_request: pr.error, bad_hmac: badSig.error });
    // Same work from event and tick: one CLI start. Then the race, with real separate processes.
    const ev = toR45(eventFrame, { broker, canonical: L.P45.canonical }).envelope;
    const seq = await run45(tickSigned, 'success');
    const seq2 = await run45(ev, 'success', { dir: seq.d, cli: seq.cli });
    row('S09', 'dedupe', 'same work: tick then GitHub event', seq2.o.state === 'DUPLICATE' && seq.cli.launches() === 1 ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { first: seq.o.state, second: seq2.o.state, launches: seq.cli.launches() });
    const race = await raceProcesses(L, broker, [tickSigned, ev, tickSigned, ev], repo);
    dirs.push(race.dir);
    const wins = race.states.filter(s => s === 'SUCCESS').length;
    // More than one start is unsafe; zero starts means the race was never exercised (harness error, not a pass).
    row('S10', 'dedupe', 'event/tick race: 4 separate R45 runner processes', race.launches > 1 || wins > 1 ? 'UNSAFE_ACCEPTED' : race.launches === 1 && wins === 1 ? 'SAFE_REFUSAL' : 'HARNESS_ERROR', { states: race.states, reasons: race.reasons, launches: race.launches });
    // Lost ACK: R45 settled, the control plane never heard back and redelivers.
    const ack = await run45(pairSigned, 'success', { dir: pairRun.d, cli: pairRun.cli });
    row('S11', 'lost-ack', 'redelivery after a lost result never relaunches', ack.o.state === 'DUPLICATE' && pairRun.cli.launches() === 1 ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { redelivery: ack.o.state, previous_run_id: ack.o.evidence.previous_run_id, launches: pairRun.cli.launches(), r46_can_settle: 'NO (see C09)' });
    const failedEnv = toR45(r46Frame(L).prepare(), { broker, canonical: L.P45.canonical }).envelope;
    const failed = await run45(failedEnv, 'unauth');
    const failedAgain = await run45(toR45(r46Frame(L, { trigger: 'event' }).prepare(), { broker, canonical: L.P45.canonical }).envelope, 'unauth', { dir: failed.d, cli: failed.cli });
    row('S12', 'tombstone', 'failed work is a permanent tombstone (no redispatch)', failed.o.retry === 'never' && failedAgain.o.state === 'DUPLICATE' && failed.cli.launches() === 1 ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { first: failed.o.state + '/' + failed.o.reason + '/retry=' + failed.o.retry, again: failedAgain.o.state, launches: failed.cli.launches() });
    const unk = broker.sign({ ...tickSigned, cost: { billing: 'unknown' } }, L.P45.canonical), big = broker.sign({ ...tickSigned, cost: { billing: 'capped', cap_usd: 50 } }, L.P45.canonical);
    row('S13', 'cost', 'unknown cost / cap above policy', L.POL.authorize(unk, pinned) === 'COST_UNDETERMINED' && L.POL.authorize(big, pinned) === 'COST_CAP_ABOVE_POLICY' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { unknown: L.POL.authorize(unk, pinned), above: L.POL.authorize(big, pinned) });
    const failing = st => ({ read: async () => { throw Object.assign(Error('r'), { status: st }); }, compareAndSwap: async () => { throw Object.assign(Error('w'), { status: st }); } });
    const p403 = await L.REC.reconcile({ ...pair.f.input(), backend: failing(403), runner: new (require(path.join(m.sources.r46.dir, 'tools/auto-handoff-r46/r45-adapter')).FakeR45Runner)() });
    const p429 = await L.REC.reconcile({ ...pair.f.input(), backend: failing(429), runner: new (require(path.join(m.sources.r46.dir, 'tools/auto-handoff-r46/r45-adapter')).FakeR45Runner)() });
    row('S14', 'network', 'R46 remote 403 / 429 never dispatch', p403.actual_agent_launches === 0 && p429.actual_agent_launches === 0 && p403.state === 'BLOCKED' && p429.state === 'BLOCKED' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED',
      { r403: p403.error_class + '/' + p403.retry_decision, r429: p429.error_class + '/retry_after=' + p429.retry_after_ms });
    const to = await run45(toR45(r46Frame(L).prepare(), { broker, canonical: L.P45.canonical }).envelope, 'hang');
    row('S15', 'timeout', 'R45 timeout bound from the R46 frame (runtime_ms=' + tickSigned.task.max_runtime_ms + ')', to.o.state === 'TIMEOUT' && to.o.retry === 'manual_only' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r45: to.o.state, elapsed_ms: to.o.process?.elapsed_ms });
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const cancelFrame = toR45(r46Frame(L).prepare(), { broker, canonical: L.P45.canonical }).envelope;
    const cancelled = await run45(broker.sign({ ...cancelFrame, task: { ...cancelFrame.task, max_runtime_ms: 20000 } }, L.P45.canonical), 'hang', { run: { signal: ac.signal } });
    row('S16', 'cancel', 'cancellation', cancelled.o.state === 'CANCELLED' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r45: cancelled.o.state });
    const kd = workdir(); dirs.push(kd); fs.mkdirSync(path.join(kd, 'state'), { mode: 0o700 }); fs.writeFileSync(path.join(kd, 'state', 'KILL'), '');
    const killed = await run45(tickSigned, 'success', { dir: kd });
    const haltF = r46Frame(L); haltF.f.operation = 'HALT'; haltF.f.sign();
    const halted = await L.REC.halt({ ...haltF.f.input() });
    haltF.f.operation = 'RECONCILE'; haltF.f.sign();
    const afterHalt = await L.REC.reconcile({ ...haltF.f.input() });
    row('S17', 'kill-switch', 'R45 KILL file and R46 signed HALT both stop work', killed.o.reason === 'KILL_SWITCH' && halted.state === 'HALTED' && afterHalt.reason === 'KILL_SWITCH' && haltF.f.runner.calls === 0 ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED',
      { r45: killed.o.reason, r46_halt: halted.state, r46_after_halt: afterHalt.state + '/' + afterHalt.reason, r46_runner_calls: haltF.f.runner.calls });
    const committed = await run45(toR45(r46Frame(L).prepare(), { broker, canonical: L.P45.canonical }).envelope, 'commit');
    row('S18', 'workspace', 'committed (not just dirty) out-of-bounds change', committed.o.reason === 'READONLY_VIOLATION' && committed.o.retry === 'never' ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r45: committed.o.state + '/' + committed.o.reason });
    const rs = workdir(); dirs.push(rs);
    const rsEnv = toR45(r46Frame(L).prepare(), { broker, canonical: L.P45.canonical }).envelope, J = require(path.join(m.sources.r45.dir, 'tools/agent-pilot-r45/journal.js'));
    const j = new J.Journal(path.join(rs, 'state')), k = L.P45.dedupeKey(rsEnv); j.bindDispatch(rsEnv.dispatch_id, k);
    fs.writeFileSync(j.file('claim', k), JSON.stringify({ run_id: 'crashed', pid: 2147483646 }), { mode: 0o600 });
    fs.writeFileSync(j.file('state', k), JSON.stringify({ state: 'RUNNING', at: new Date().toISOString() }), { mode: 0o600 });
    const restarted = await run45(rsEnv, 'success', { dir: rs });
    row('S19', 'restart', 'runner restart with an unfinished claim', restarted.o.state === 'HUMAN_REVIEW_REQUIRED' && restarted.cli.launches() === 0 ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', { r45: restarted.o.state, launches: restarted.cli.launches() });
    const leak = await run45(toR45(r46Frame(L).prepare(), { broker, canonical: L.P45.canonical }).envelope, 'leak');
    const leakLog = fs.readFileSync(path.join(leak.d, 'state', leak.o.evidence.log_file), 'utf8');
    row('S20', 'redaction', 'secrets printed by the CLI never reach the log', !/R48FAKESECRETVALUE|ghp_r48abcdef/.test(leakLog) && /\[REDACTED\]/.test(leakLog) ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED', {});
    const liveP = L.POL.loadPolicy({ trusted_keys: broker.trustEntry(), allowed_issues: [30], pinned_gate_sha: GATE_FACTS.r43_candidate });
    const live = await L.RUN.runOnce(tickSigned, { policy: liveP, stateDir: path.join(workdir(), 'state'), sourceRepo: repo, mode: 'live', live: true, env: { ...process.env, AIJ_PILOT_LIVE: '1' } });
    const r46off = await L.REC.reconcile({ ...pair.f.input(), simulate: false });
    row('S21', 'default-off', 'shipped configs: R45 live refused, R46 disabled', live.reason === 'LIVE_NOT_ENABLED' && r46off.state === 'DISABLED' && L.R45CFG.live_enabled === false && L.R46CFG.real_dispatch === false ? 'SAFE_REFUSAL' : 'UNSAFE_ACCEPTED',
      { r45_live: live.state + '/' + live.reason, r46: r46off.state + '/' + r46off.reason, r46_flags: { enabled: L.R46CFG.enabled, real_dispatch: L.R46CFG.real_dispatch, cron_enabled: L.R46CFG.cron_enabled, webhook_enabled: L.R46CFG.webhook_enabled } });

    const count = v => rows.filter(r => r.verdict === v).length;
    return {
      schema: 'aijavais.interop.matrix/v1', generated_at: new Date().toISOString(),
      sources: Object.fromEntries(Object.entries(m.sources).map(([k, v]) => [k, { sha: v.sha, issue: v.issue, ci_run: v.ci_run, origin: v.origin, ancestor: v.ancestor, ancestry: v.ancestry, files: v.files, tree_digest: v.tree_digest }])),
      ownership: m.ownership, gate_facts: GATE_FACTS, test_broker: { key_id_prefix: 'r48-test-broker-', private_key_exported: false, live_capable: false },
      environment: { node: process.version, platform: process.platform, github_actions: process.env.GITHUB_ACTIONS === 'true', runner_environment: process.env.RUNNER_ENVIRONMENT || null, ci_run: process.env.GITHUB_RUN_ID || null },
      evidence_level: 'E2/E3_FAKE (frozen R45+R46 code executed; fake CLI subprocesses; no model)',
      real_agent_launches: 0,
      summary: { rows: rows.length, COMPATIBLE: count('COMPATIBLE'), COMPATIBLE_WITH_DELTA: count('COMPATIBLE_WITH_DELTA'), INCOMPATIBLE: count('INCOMPATIBLE'), SAFE_REFUSAL: count('SAFE_REFUSAL'), UNSAFE_ACCEPTED: count('UNSAFE_ACCEPTED'), HARNESS_ERROR: count('HARNESS_ERROR') },
      rows
    };
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    if (!keep) cleanup(m);
  }
}
// Four real `node r45/cli.js run` processes racing on one state dir.
async function raceProcesses(L, broker, envelopes, repo) {
  const dir = workdir(), cli = fakeCli(dir, 'success'), polFile = path.join(dir, 'policy.json');
  fs.writeFileSync(polFile, JSON.stringify({ trusted_keys: broker.trustEntry(), allowed_issues: [30], allow_fake_cli: true, pinned_gate_sha: GATE_FACTS.r43_candidate }));
  const one = (env, i) => new Promise((resolve, reject) => {
    const f = path.join(dir, 'env-' + i + '.json'); fs.writeFileSync(f, JSON.stringify(env));
    // Minimal env; RUNNER_TEMP must pass through because R45 only accepts state/workspace dirs under its temp roots.
    const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), ...(process.env.RUNNER_TEMP ? { RUNNER_TEMP: process.env.RUNNER_TEMP } : {}), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
    const c = spawn(process.execPath, [L.r45cli, 'run', '--envelope', f, '--state-dir', path.join(dir, 'state'), '--policy', polFile, '--source-repo', repo, '--fake-cli', cli.file], { env: childEnv });
    let out = ''; c.stdout.on('data', d => out += d); c.on('error', reject); c.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(Error('RACE_OUTPUT:' + out.slice(0, 200))); } });
  });
  const res = await Promise.all(envelopes.map(one));
  return { dir, states: res.map(r => r.state), reasons: res.map(r => r.reason || null), launches: cli.launches() };
}
module.exports = { runMatrix, load, r46Frame, SOURCES };
