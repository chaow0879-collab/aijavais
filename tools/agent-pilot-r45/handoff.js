'use strict';
// Seam for the Codex R46 control plane (GitHub event + 10-minute fallback, remote claim/CAS).
// R46 hands over a signed envelope; it receives one machine-readable result to settle its
// remote claim. No R46 source is imported here and none of R45 is imported by R46.
const C = require('./contract');
const { runOnce } = require('./runner');

const TERMINAL_RETRY = { SUCCESS: 'none', DUPLICATE: 'none', DRY_RUN: 'none' };
function toControlPlaneResult(outcome) {
  const errors = C.outcomeErrors(outcome);
  if (errors.length) throw Error('INVALID_OUTCOME:' + errors.join(','));
  return {
    schema: 'aijavais.pilot.settlement/v1', dedupe_key: outcome.dedupe_key, dispatch_id: outcome.dispatch_id, run_id: outcome.run_id,
    state: outcome.state, reason: outcome.reason, terminal: true,
    // The control plane must never auto-redispatch anything except a clean success/duplicate (nothing to redo).
    redispatch: 'never', retry: TERMINAL_RETRY[outcome.state] || outcome.retry,
    source_sha: outcome.source_sha, gate_sha: outcome.gate_sha, exit_code: outcome.process ? outcome.process.exit_code : null,
    cost_known: outcome.cost.known, cost_usd: outcome.cost.usd, cost_cap_usd: outcome.cost.cap_usd,
    real_agent_launch: outcome.agent_launch.real_agent_launch, actual_agent_launches: outcome.agent_launch.actual_agent_launches,
    evidence_level: outcome.evidence.level, log_sha256: outcome.evidence.log_sha256, ci_ref: outcome.evidence.ci_ref, previous_run_id: outcome.evidence.previous_run_id || null
  };
}
async function acceptDispatch(decision, opts) {
  if (!decision || typeof decision !== 'object' || !decision.envelope) throw Error('INVALID_DECISION');
  const outcome = await runOnce(decision.envelope, opts);
  return { outcome, settlement: toControlPlaneResult(outcome) };
}
module.exports = { acceptDispatch, toControlPlaneResult };
