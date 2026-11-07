'use strict';
// event or 10-minute tick -> R49 prepare (R46 gates, exact candidate) -> broker signature ->
// R49 execute (R46 CAS claim -> signed R45 Fake runner -> normalize -> settle).
// Both trigger kinds converge on the SAME R46 work key, so the authoritative CAS ledger,
// not a per-trigger run id, decides whether anything starts. Every refusal fails closed.
const fs = require('node:fs');
const path = require('node:path');
const T = require('../auto-handoff-r46/triggers');
const R49 = require('../first-handoff-r49/control');
const { isMinted } = require('./identity');

const blocked = (reason, more = {}) => ({ state: 'BLOCKED', reason, actual_agent_launches: 0, real_dispatch: false, schedule: 'NOT_ENABLED', E4: 'NOT_RUN', ...more });
// A fallback tick carries the caller identity of the scheduled workflow (OIDC), never its own.
function tickRecord(identity, now, r46config) {
  if (!isMinted(identity) || identity.kind !== 'github_actions_oidc') return null;
  return { kind: 'fallback_tick', trigger: T.tick(now, r46config), identity };
}
async function handle({ record, base, broker, approval, now, signal, killFile }) {
  const killed = process.env.AIJ_R50_KILL === '1' || (killFile && fs.existsSync(killFile));
  if (killed) return blocked('KILL_SWITCH');
  if (!record || !record.trigger) return blocked('UNTRUSTED_TRIGGER');
  const caller = record.kind === 'fallback_tick' ? record.identity : record;
  const bound = { ...base, simulate: true, trigger: record.trigger, now };
  let prepared;
  try { prepared = R49.prepare(bound); } catch (e) { return blocked(e.code || 'PREPARE_REJECTED'); }
  if (!broker) return blocked('BLOCKED_TRUSTED_SIGNATURE_BROKER');
  let signed, receipt;
  try { ({ signed, receipt } = broker.sign({ caller, approval, prepared: { ...prepared, task_id: base.envelope.task_id }, now })); }
  catch (e) { broker.store?.audit('sign_refused', { reason: e.code || 'BROKER_REJECTED', trigger: record.kind }, now); return blocked(e.code || 'BROKER_REJECTED'); }
  // Re-check revocation and the kill switch at the last moment before a claim can be made.
  if (broker.store.revoked(approval.approval_id)) return blocked('APPROVAL_REVOKED');
  if (process.env.AIJ_R50_KILL === '1' || (killFile && fs.existsSync(killFile))) return blocked('KILL_SWITCH');
  const result = await R49.execute({ ...bound, signed, signal });
  broker.store.audit('execute_result', { state: result.state, reason: result.reason || null, trigger: record.kind, work_key: receipt.work_key, candidate_sha: receipt.candidate_sha }, now);
  return { ...result, r50: { trigger: record.kind, approval_id: receipt.approval_id, work_key: receipt.work_key, candidate_sha: receipt.candidate_sha, broker_key_id: receipt.broker_key_id, test_signer: receipt.test_signer } };
}
module.exports = { handle, tickRecord, blocked, killPath: dir => path.join(dir, 'KILL') };
