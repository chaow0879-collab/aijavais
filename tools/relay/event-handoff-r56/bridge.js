'use strict';
// R56 event hand-off bridge: ONE reconcile pass per trusted trigger (GitHub event or the 10-minute
// tick). It composes existing parts only:
//   R50 identity (minted webhook record / OIDC tick identity)  -> who woke us
//   R56 facts + machine (pure)                                  -> which stage is next, with what inputs
//   R46 ledger read (CAS document)                              -> durable stage progress, tombstones
//   provision(ticket) -> R50 broker signs / R51 handleTrusted -> R49 -> R46 CAS claim -> R45 one-shot
// No scheduler, queue, database or signature format of its own. Live execution is BLOCKED until an
// audited source change provides an actual runner identity (official CLI + provider cap + owner GO).
const fs = require('node:fs');
const C = require('../auto-handoff-r46/contract');
const { isMinted } = require('../trusted-trigger-r50/identity');
const O = require('../first-pilot-r51/official-port');
const M = require('./machine');
const LIVE_HANDOFF_ENABLED = false;
const base = (state, reason, extra) => ({ state, reason, actual_agent_launches: 0, model_spend: null, E4: 'NOT_RUN', E5: 'NOT_RUN', real_schedule: 'NOT_ENABLED', real_state_ref_write: 'NOT_RUN', ...extra });

function blockedLive() {
  const r = O.blocked();
  return base('BLOCKED', 'BLOCKED_ACTUAL_RUNNER_IDENTITY', { blockers: ['BLOCKED_ACTUAL_RUNNER_IDENTITY', 'R56_LIVE_HANDOFF_DISABLED', ...r.blockers], note: '停止的聊天会话不能被 GitHub 事件唤醒；需要经审计的官方 CLI 运行身份、可强制费用上限和所有者 GO。' });
}
function killed(killFile) { return process.env.AIJ_R56_KILL === '1' || (killFile && fs.existsSync(killFile)); }
// Machine-readable stage report (existing [AGENT_REPORT_V1] block format) — evidence for humans and
// the next decision's audit trail; authority stays in the R46 ledger, never in this text.
function stageReport(d, result) {
  const o = result.outcome || {};
  return ['[AGENT_REPORT_V1]', 'role: R56-Bridge', 'work_item: ' + d.work_item, 'stage: ' + d.ticket.stage, 'status: ' + (result.state === 'SUCCEEDED' ? 'STAGE_SUCCEEDED' : 'STAGE_' + result.state),
    'head_sha: ' + d.ticket.source_sha, 'idempotency_key: ' + d.ticket.idempotency_key, 'after: ' + (d.ticket.after || 'none'), 'reason: ' + (result.reason || 'none'), 'cost_known: ' + (o.cost_known === true),
    'evidence: ' + (result.pilot_mode || 'BLOCKED'), 'actual_agent_launches: 0', '[/AGENT_REPORT_V1]'].join('\n');
}

async function step(input = {}) {
  // Live: compiled guard first; no trigger, credential, snapshot or provision getter is touched.
  if (input.mode !== 'fake') return blockedLive();
  const { pipeline, item, trigger, now = Date.now() } = input;
  if (killed(input.killFile)) return base('BLOCKED', 'KILL_SWITCH');
  // Only an identity minted by R50's verifiers can wake the bridge (HMAC webhook / OIDC tick).
  if (!isMinted(trigger) || !['github_webhook', 'github_actions_oidc'].includes(trigger.kind)) return base('BLOCKED', 'UNTRUSTED_TRIGGER');
  let snapshot, jobs;
  try { snapshot = await input.readSnapshot(); } catch (e) { return base('UNKNOWN', 'SOURCE_UNREADABLE', { detail: e && e.code || null }); }
  try { jobs = (await input.readLedger()).document.jobs; } catch (e) { jobs = null; }
  const d = M.decide({ snapshot, pipeline, item, jobs, now });
  if (!d.dispatch) {
    // Persist lease expiry through R46's own recovery (UNKNOWN / EXPIRED_NO_REPLAY); never re-dispatch.
    if (d.recover && typeof input.recover === 'function') { try { await input.recover(); } catch { /* next tick re-reads */ } }
    return base(d.state, d.reason, { decision: d });
  }
  if (killed(input.killFile)) return base('BLOCKED', 'KILL_SWITCH', { decision: d });
  // Provision = the existing operator-authorized preparation (R49 manifest + R50 approval). The bridge
  // only checks that what was prepared is exactly the stage it decided, before anything is launched.
  let p;
  try { p = await input.provision(d.ticket, trigger); } catch (e) { return base('BLOCKED', 'PROVISION_REFUSED', { decision: d, detail: e && e.code || null }); }
  const e = p && p.envelope, t = d.ticket;
  if (!e || C.identity(e) !== t.idempotency_key || e.after !== t.after || e.source_sha !== t.source_sha || e.branch !== t.branch || e.issue !== t.issue || e.role !== t.role || e.phase !== t.phase || e.kind !== t.kind
    || !e.audit_refs || e.audit_refs.audit !== t.audit_ref || e.audit_refs.qa !== t.qa_ref || typeof p.launch !== 'function') return base('BLOCKED', 'PROVISION_BINDING', { decision: d });
  const result = await p.launch();
  if (result && result.r50 && result.r50.work_key && result.r50.work_key !== C.pilotWorkKey(e)) return base('BLOCKED', 'RESULT_WORK_KEY_MISMATCH', { decision: d });
  const out = base('STAGE_' + (result && result.state || 'UNKNOWN'), result && result.reason || null, { decision: d, stage: t.stage, idempotency_key: t.idempotency_key, outcome: result && result.outcome || null, stop_reason: result && result.stop_reason || null, pilot_mode: result && result.pilot_mode || null });
  if (input.report) { try { await input.report(t.issue, stageReport(d, result || {})); out.reported = true; } catch { out.reported = false; } }
  return out;
}
module.exports = { step, stageReport, blockedLive, LIVE_HANDOFF_ENABLED };
