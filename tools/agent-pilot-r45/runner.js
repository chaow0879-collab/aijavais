'use strict';
// One envelope -> at most one bounded, read-only CLI process -> one outcome.
// Modes: dry_run (default; nothing is started), fake (tests only, policy.allow_fake_cli),
// live (official CLI; needs audited policy.live_enabled, --live, AIJ_PILOT_LIVE=1, verified
// CLI, configured credentials and an ephemeral GitHub-hosted runner). Refusals never retry.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./contract');
const P = require('./policy');
const { Journal } = require('./journal');
const W = require('./workspace');
const S = require('./supervisor');
const { preflight, CREDENTIAL_ENV } = require('./preflight');
const TEMPLATES = require('./templates.json');

function command(kind, prompt, capUsd) {
  if (kind === 'claude') return ['-p', prompt, '--output-format', 'json', '--max-budget-usd', String(capUsd), '--permission-mode', 'plan',
    '--allowedTools', 'Read,Glob,Grep', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch', '--no-session-persistence', '--strict-mcp-config', '--bare'];
  return ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--json', prompt];
}
const AUTH = /invalid api key|unauthori[sz]ed|authentication|not logged in|\/login|401\b|credential/i;
const DENIED = /\b403\b|forbidden|access denied|permission denied|not allowed to use/i;
const BUDGET = /budget|spend limit|max-budget/i;
function parseCost(kind, stdout) {
  if (kind === 'claude') {
    try { const j = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)); return { json: j, usd: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null }; } catch { return { json: null, usd: null }; }
  }
  return { json: null, usd: null }; // codex --json reports tokens, not money: cost stays unknown
}

async function runOnce(envelope, opts = {}) {
  const policy = opts.policy || P.loadPolicy();
  const env = opts.env || process.env;
  const mode = opts.mode || 'dry_run';
  const runId = crypto.randomUUID();
  const base = { run_id: runId, dispatch_id: envelope?.dispatch_id || null };
  const done = (fields, journal) => { const o = C.makeOutcome({ ...base, ...fields }); journal?.audit({ run_id: runId, state: o.state, reason: o.reason, dedupe_key: o.dedupe_key }); return o; };
  const stateDir = opts.stateDir;
  const journal = stateDir ? new Journal(stateDir) : null;
  const killed = () => env.AIJ_PILOT_KILL === '1' || (stateDir && fs.existsSync(path.join(stateDir, 'KILL')));
  if (killed()) return done({ state: 'BLOCKED', reason: 'KILL_SWITCH', retry: 'manual_only' }, journal);
  if (!['dry_run', 'fake', 'live'].includes(mode)) return done({ state: 'REJECTED', reason: 'UNKNOWN_MODE' }, journal);
  const denied = P.authorize(envelope, policy, opts.now || Date.now());
  if (denied) return done({ state: 'REJECTED', reason: denied, retry: 'never' }, journal);
  const prompt = Object.hasOwn(TEMPLATES, envelope.task.template) && envelope.task.template !== '_comment' ? TEMPLATES[envelope.task.template] : null;
  if (!prompt) return done({ state: 'REJECTED', reason: 'UNKNOWN_TEMPLATE' }, journal);
  const key = C.dedupeKey(envelope), digest = C.envelopeDigest(envelope);
  const ids = { dedupe_key: key, envelope_digest: digest, source_sha: envelope.source.sha, gate_sha: envelope.gate.gate_sha };
  const cap = envelope.cost.cap_usd, kind = envelope.task.cli;
  const args = command(kind, prompt, cap);
  const costBase = { known: false, usd: null, cap_usd: cap };
  if (mode === 'dry_run') return done({ ...ids, state: 'DRY_RUN', reason: 'DRY_RUN_DEFAULT', retry: 'none', cost: costBase,
    agent_launch: { mode, real_agent_launch: false, actual_agent_launches: 0, process_launches: 0, cli: kind, cli_version: null, planned_args: args.map(a => a === prompt ? '<template:' + envelope.task.template + '>' : a) } }, journal);
  if (!journal) return done({ ...ids, state: 'BLOCKED', reason: 'STATE_DIR_REQUIRED', retry: 'manual_only' });

  let executable, version;
  if (mode === 'fake') {
    if (policy.allow_fake_cli !== true || !opts.fakeExecutable) return done({ ...ids, state: 'BLOCKED', reason: 'FAKE_CLI_NOT_ALLOWED' }, journal);
    // Fake mode must never become a side door to a real CLI: only marked test programs run here.
    let head = '';
    try { const fd = fs.openSync(opts.fakeExecutable, 'r'); const buf = Buffer.alloc(4096); head = buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)).toString('utf8'); fs.closeSync(fd); } catch { /* missing: handled by spawn as CLI_NOT_FOUND */ }
    if (head && !head.includes('AIJAVAIS_FAKE_CLI')) return done({ ...ids, state: 'REJECTED', reason: 'FAKE_CLI_NOT_MARKED' }, journal);
    executable = opts.fakeExecutable; version = 'fake';
  } else {
    if (policy.live_enabled !== true || opts.live !== true || env.AIJ_PILOT_LIVE !== '1') return done({ ...ids, state: 'BLOCKED', reason: 'LIVE_NOT_ENABLED', retry: 'manual_only' }, journal);
    const pf = opts.preflight || preflight({ env });
    if (pf.clis[kind].status !== 'VERIFIED') return done({ ...ids, state: 'BLOCKED', reason: 'CLI_' + (pf.clis[kind].reason || 'UNAVAILABLE'), retry: 'manual_only' }, journal);
    if (pf.credentials[kind].status !== 'PRESENT_UNVERIFIED') return done({ ...ids, state: 'BLOCKED', reason: 'CREDENTIALS_NOT_CONFIGURED', retry: 'manual_only' }, journal);
    if (!pf.runner.ephemeral_github_hosted && policy.allow_local_live !== true) return done({ ...ids, state: 'BLOCKED', reason: 'NOT_EPHEMERAL_RUNNER', retry: 'manual_only' }, journal);
    executable = pf.clis[kind].path; version = pf.clis[kind].version;
  }
  const bound = journal.bindDispatch(envelope.dispatch_id, key);
  if (bound) return done({ ...ids, state: 'REJECTED', reason: bound }, journal);
  const claim = journal.claim(key, runId);
  if (!claim.won) return done({ ...ids, state: claim.state === 'DUPLICATE' ? 'DUPLICATE' : claim.state === 'IN_PROGRESS' ? 'DUPLICATE' : 'HUMAN_REVIEW_REQUIRED',
    reason: claim.state, retry: claim.state === 'HUMAN_REVIEW_REQUIRED' ? 'manual_only' : 'none', evidence: { previous_run_id: claim.previous?.run_id || null } }, journal);

  const settle = fields => { const o = done({ ...ids, ...fields }); journal.settle(key, o); journal.audit({ run_id: runId, state: o.state, reason: o.reason, dedupe_key: key }); return o; };
  if (killed()) return settle({ state: 'BLOCKED', reason: 'KILL_SWITCH', retry: 'manual_only' });
  let ws;
  try { ws = W.prepare(opts.sourceRepo || process.cwd(), envelope.source.sha); }
  catch (e) { return settle({ state: 'BLOCKED', reason: e.message, retry: 'never' }); }
  const secrets = [];
  const childEnv = { PATH: [path.dirname(executable), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: ws.home, TMPDIR: ws.tmp, LANG: 'C.UTF-8', CI: '1',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (mode === 'live') for (const name of CREDENTIAL_ENV[kind]) if (typeof env[name] === 'string' && env[name]) { childEnv[name] = env[name]; secrets.push(env[name]); }
  try {
    // Privilege-reducing hook from the trusted in-process pilot composition.
    // Recheck after clone/preflight, immediately before any process can start.
    if (opts.beforeLaunchCheck) {
      let allowed = false;
      try { allowed = await opts.beforeLaunchCheck() === true; } catch { /* fail closed, no raw error */ }
      if (!allowed) return settle({ state: 'BLOCKED', reason: 'PRE_LAUNCH_GATE_REVOKED', retry: 'never', cost: costBase });
    }
    if (opts.signal?.aborted || killed()) return settle({ state: 'BLOCKED', reason: 'CANCELLED_OR_KILLED_BEFORE_LAUNCH', retry: 'never', cost: costBase });
    journal.transition(key, 'RUNNING');
    const r = await S.run({ executable, args, cwd: ws.dir, env: childEnv, timeoutMs: envelope.task.max_runtime_ms, maxOutputBytes: policy.max_output_bytes, secrets, signal: opts.signal });
    const launched = r.pid !== null && r.reason !== 'SPAWN_FAILED' && r.reason !== 'CLI_NOT_FOUND';
    const cost = parseCost(kind, r.stdout);
    const text = r.stdout + '\n' + r.stderr;
    let state, reason = r.reason, retry = 'manual_only';
    if (r.reason === 'TIMEOUT') state = 'TIMEOUT';
    else if (r.reason === 'CANCELLED') state = 'CANCELLED';
    else if (r.reason === 'SPAWN_FAILED' || r.reason === 'CLI_NOT_FOUND') state = 'BLOCKED';
    else if (r.reason) state = 'FAILED';
    else if (r.exit_code !== 0) { state = 'FAILED'; reason = AUTH.test(text) ? 'AUTH_FAILED' : DENIED.test(text) ? 'ACCESS_DENIED' : BUDGET.test(text) ? 'BUDGET_EXCEEDED' : 'NONZERO_EXIT'; if (['AUTH_FAILED', 'ACCESS_DENIED'].includes(reason)) retry = 'never'; }
    else if (kind === 'claude' && (!cost.json || cost.json.is_error === true)) { state = 'FAILED'; reason = cost.json ? 'CLI_REPORTED_ERROR' : 'UNPARSEABLE_OUTPUT'; }
    else { state = 'SUCCESS'; retry = 'none'; }
    if (cost.usd !== null && cost.usd > cap) { state = 'FAILED'; reason = 'COST_CAP_EXCEEDED'; retry = 'never'; }
    const violation = W.verifyUnchanged(ws);
    if (violation) { state = 'FAILED'; reason = violation; retry = 'never'; }
    else if (r.exit_code !== 0 && /EACCES|EROFS/.test(text) && text.includes(ws.dir + path.sep)) { state='FAILED';reason='READONLY_VIOLATION';retry='never'; }
    const log = journal.saveLog(runId, ['# sanitized log (secrets redacted; raw output not persisted elsewhere)', '## stdout', r.stdout.slice(0, 65536), '## stderr', r.stderr.slice(0, 65536)].join('\n'));
    const real = mode === 'live' && launched;
    return settle({ state, reason, retry,
      process: { pid: r.pid, wrapper: r.wrapper, exit_code: r.exit_code, signal: r.signal, elapsed_ms: r.elapsed_ms, started_by: 'aijavais-agent-pilot-r45 (' + (env.GITHUB_ACTIONS === 'true' ? 'github-actions run ' + (env.GITHUB_RUN_ID || '?') : 'local process ' + process.pid) + ')',
        command_class: kind + (kind === 'claude' ? ':print-json-readonly-plan' : ':exec-json-readonly-sandbox'), runtime_limit_ms: envelope.task.max_runtime_ms },
      cost: { known: cost.usd !== null, usd: cost.usd, cap_usd: cap },
      agent_launch: { mode, real_agent_launch: real, actual_agent_launches: real ? 1 : 0, process_launches: launched ? 1 : 0, cli: kind, cli_version: version },
      evidence: { level: mode === 'live' ? 'E4_CANDIDATE_REQUIRES_INDEPENDENT_VERIFICATION' : 'E3_FAKE_CLI', ...log, result_excerpt: state === 'SUCCESS' && cost.json && typeof cost.json.result === 'string' ? cost.json.result.slice(0, 300) : null } });
  } catch (e) {
    return settle({ state: 'HUMAN_REVIEW_REQUIRED', reason: 'RUNNER_ERROR:' + String(e.message).slice(0, 80), retry: 'manual_only' });
  } finally { W.cleanup(ws); }
}
module.exports = { runOnce, command };
