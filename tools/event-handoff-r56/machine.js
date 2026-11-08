'use strict';
// R56 hand-off state machine: a PURE decision over (trusted GitHub facts, the existing R46 ledger).
// It never dispatches, never writes and never re-orders work: R46 stays the only authority for
// claims, leases, tombstones and stage chaining (`after`). Order of checks is privilege-reducing:
// anything that withdraws, revokes, rejects or moves the candidate wins over any approval.
const C = require('../auto-handoff-r46/contract');
const Facts = require('./facts');
const TICKET = 'aijavais.event-handoff.ticket/v1';

function taskId(item, stage, sha) { return (item.task_prefix + '-' + stage.stage + '-' + sha.slice(0, 12)).slice(0, 80); }
function identity(item, stage, sha, pipeline) {
  return C.identity({ repo: pipeline.repo, issue: item.issue, task_id: taskId(item, stage, sha), source_sha: sha, role: stage.role, phase: stage.phase });
}
function validItem(item) {
  return item && typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,40}$/.test(item.id) && Number.isSafeInteger(item.issue) && typeof item.branch === 'string' && item.branch !== 'main'
    && /^[a-z0-9][a-z0-9._-]{0,20}$/.test(item.task_prefix || '') && ['developer', 'integrator'].includes(item.candidate_from) && Array.isArray(item.stages) && item.stages.length >= 1 && item.stages.length <= 8
    && item.stages.every(s => s && /^[a-z][a-z0-9_-]{0,30}$/.test(s.stage) && ({ integrator: 'integration', audit: 'audit', qa: 'qa' })[s.role] === s.phase && ['codex', 'claude'].includes(s.kind))
    && new Set(item.stages.map(s => s.stage)).size === item.stages.length;
}

// jobs: R46 ledger document.jobs (keyed by idempotency key) or null when unreadable.
function decide({ snapshot, pipeline, item, jobs, now }) {
  const out = (state, reason, extra) => ({ state, reason, dispatch: false, work_item: item && item.id, evidence: 'DECISION_ONLY', ...extra });
  if (!validItem(item)) return out('BLOCKED_INVALID_WORK_ITEM', 'WORK_ITEM_SCHEMA');
  let f;
  try { f = Facts.read(snapshot, pipeline, item, now); } catch (e) { return out('UNKNOWN_SOURCE', e.code || 'SOURCE_UNREADABLE'); }
  const base = { candidate_sha: f.candidate, candidate_ref: f.candidate_ref };
  if (f.withdrawn) return out('BLOCKED_CANDIDATE_WITHDRAWN', 'LATEST_REPORT_' + f.withdrawn, base);
  if (!f.candidate) return out('WAIT_CANDIDATE', 'NO_TRUSTED_READY_REPORT', { ...base, todo: [{ role: item.candidate_from, action: 'post a trusted READY_FOR_REVIEW report with the exact head_sha' }] });
  if (f.revoked) return out('BLOCKED_REVOKED', 'OWNER_REVOKED', base);
  if (f.branch_sha !== f.candidate) return out('BLOCKED_SHA_MOVED', 'BRANCH_HEAD_DIFFERS_FROM_CANDIDATE', { ...base, branch_sha: f.branch_sha });
  const rejected = [...f.reviews.audit.negative, ...f.reviews.qa.negative];
  if (rejected.length) return out('BLOCKED_REJECTED', 'INDEPENDENT_REVIEW_NEGATIVE', { ...base, refs: rejected });
  if (!f.ci.green) return out('WAIT_CI', f.ci.failed ? 'CI_NOT_GREEN_FOR_CANDIDATE' : 'NO_CI_FOR_CANDIDATE', { ...base, todo: [{ role: 'ci', action: 'same-SHA required jobs must succeed' }] });
  const todo = [];
  for (const role of ['audit', 'qa']) {
    const r = f.reviews[role];
    if (!r.accepted) todo.push({ role, action: r.registered_keys ? 'post a signed same-SHA verdict' : 'register an independent reviewer key (owner) and post a signed verdict', problems: r.problems });
  }
  if (todo.length) return out('WAIT_AUTHORIZED_REVIEWER', 'MISSING_SIGNED_INDEPENDENT_VERDICT', { ...base, todo, ci_ref: f.ci.green });
  if (f.independence) return out('BLOCKED_REVIEW_INDEPENDENCE', f.independence, base);
  if (!jobs || typeof jobs !== 'object') return out('UNKNOWN_LEDGER', 'R46_LEDGER_UNREADABLE', base);
  // Stage chain: each stage is one R46 job; `after` is the previous stage's idempotency key.
  let after = null;
  const stages = [];
  for (const [index, stage] of item.stages.entries()) {
    const key = identity(item, stage, f.candidate, pipeline), job = jobs[key];
    stages.push({ stage: stage.stage, key, state: job ? job.state : 'NOT_CLAIMED' });
    if (!job) {
      const ticket = { schema: TICKET, work_item: item.id, stage: stage.stage, index, repo: pipeline.repo, issue: item.issue, branch: item.branch, source_sha: f.candidate,
        task_id: taskId(item, stage, f.candidate), role: stage.role, phase: stage.phase, kind: stage.kind, after, idempotency_key: key,
        audit_ref: f.reviews.audit.accepted.ref, qa_ref: f.reviews.qa.accepted.ref, inputs: { candidate_ref: f.candidate_ref, ci_ref: f.ci.green, previous_stage_keys: stages.slice(0, -1).map(s => s.key) } };
      return { ...out('READY_STAGE', null, { ...base, stages }), dispatch: true, ticket };
    }
    if (job.state === 'SUCCEEDED') { after = key; continue; }
    // An expired lease is uncertainty, never a retry: R46 recover() records it as UNKNOWN/EXPIRED_NO_REPLAY.
    if (['CLAIMED', 'DISPATCHING'].includes(job.state) && Number.isSafeInteger(job.lease_until) && now >= job.lease_until) return out('BLOCKED_STAGE_UNKNOWN', 'LEASE_EXPIRED_NO_REPLAY', { ...base, stages, recover: true });
    if (['CLAIMED', 'DISPATCHING'].includes(job.state)) return out('WAIT_STAGE_RUNNING', job.state, { ...base, stages });
    if (job.state === 'UNKNOWN') return out('BLOCKED_STAGE_UNKNOWN', job.reason || 'UNKNOWN_NO_REPLAY', { ...base, stages, todo: [{ role: 'owner', action: 'inspect the uncertain stage; the platform never re-dispatches it' }] });
    return out('BLOCKED_STAGE_' + job.state, job.reason || job.state, { ...base, stages });
  }
  return out('HANDOFF_COMPLETE', null, { ...base, stages });
}
module.exports = { decide, identity, taskId, validItem, TICKET };
