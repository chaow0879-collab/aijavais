'use strict';
// Bounded one-shot composition, never a background scheduler or another Runner.
const O = require('../first-pilot-r51/official-port');
const R51 = require('../first-pilot-r51/r50-bridge');
const { Ledger } = require('../auto-handoff-r46/state');
const E = require('../first-pilot-r51/entry');
const Receipts = require('./receipts');
const result = (state, reason, more = {}) => ({ state, reason, evidence: 'E3_FAKE_ONLY',
  actual_agent_launches: 0, real_schedule: 'NOT_ENABLED', real_state_ref_write: 'NOT_RUN', ...more });
const fake = input => Object.getOwnPropertyDescriptor(input || {}, 'mode')?.value === 'fake';
const readReviews = (input, collected) => typeof input.readReviews === 'function'
  ? E.boundedBackend({ read: () => input.readReviews(collected) }, 1000).read() : null;
// AUD-R57-02: a durable HALT (or any change to the settled job) that lands while receipts/reviews
// are being collected must win over a DONE result. Re-read the authoritative R46 ledger after the
// last await; anything uncertain yields next_allowed=false and keeps ledger/cost/tombstone as-is.
async function stillSettled(base, now) {
  const { digest } = require('../auto-handoff-r46/contract');
  try {
    const state = await new Ledger(base.backend, base.config).read(now), job = state.document.jobs[base.envelope.idempotency_key];
    if (state.document.halted) return 'PERSISTENT_HALT';
    if (job?.state !== 'SUCCEEDED' || job.envelope_hash !== digest(base.envelope) || !job.outcome?.cost_known) return 'COMPLETED_WORK_CHANGED';
    return null;
  } catch { return 'LEDGER_RECHECK_UNVERIFIED'; }
}
async function parentGate(input, now) {
  const base = input.packet.base, e = base.envelope;
  if (!e.after) return true;
  const p = input.parentEnvelope;
  const { digest } = require('../auto-handoff-r46/contract');
  const state = await new Ledger(base.backend, base.config).read(now), job = state.document.jobs[e.after];
  if (!p || p.idempotency_key !== e.after || job?.envelope_hash !== digest(p) || job.state !== 'SUCCEEDED' ||
      !job.outcome?.cost_known || state.document.halted) return false;
  const c = await Receipts.collect({ envelope: p, outcome: job.outcome, read: input.readGitHub, policy: input.collectionPolicy });
  if (!c.receipt || !input.readReviews) return false;
  return Receipts.reviews(await readReviews(input, c), c, input.collectionPolicy, now).state === 'DONE';
}
async function runOnce(input = {}) {
  // Never enumerate the context, fetch credentials, call a transport or spawn a
  // process for a live/default request, even when it has convincing fake proofs.
  if (!fake(input)) return { ...O.blocked(), workflow_state: 'WAIT_TRUSTED_RUNNER', real_agent_wake: 'NOT_VERIFIED' };
  let execution;
  try {
    const packet = input.packet, base = packet.base;
    const C = require('../auto-handoff-r46/contract'), policy = E.publicClone(input.collectionPolicy), policyHash = C.digest(policy);
    if (base.authorization?.manifest?.r57_collection_policy_digest !== policyHash ||
        C.canonical(policy.trusted_keys) !== C.canonical(base.config.trusted_keys) ||
        C.canonical(policy.allowed_issues) !== C.canonical(base.config.allowed_issues) ||
        C.canonical(policy.allowed_branches) !== C.canonical(base.config.allowed_branches)) {
      return result('BLOCKED', 'COLLECTION_POLICY_NOT_AUTHORIZED');
    }
    const bound = { ...input, collectionPolicy: policy };
    const authorityCheck = async now => C.digest(E.publicClone(input.collectionPolicy)) === policyHash && await parentGate(bound, now) &&
      (typeof input.authorityCheck !== 'function' || await E.boundedBackend({ read: () => input.authorityCheck(now) }, 1000).read() === true);
    if (input.signal?.aborted) return result('BLOCKED', 'CANCELLED_BEFORE_DISPATCH');
    if (!await authorityCheck(packet.now ?? Date.now())) return result('BLOCKED', 'WAIT_PARENT_INDEPENDENT_REVIEWS');
    execution = await R51.handleTrusted({ ...packet, signal: input.signal, authorityCheck });
    if (!execution.r50 || execution.r50.work_key !== require('../auto-handoff-r46/contract').pilotWorkKey(base.envelope)) {
      return result('BLOCKED', execution.reason || 'UNTRUSTED_TRIGGER', { execution, next_allowed: false });
    }
    if (execution.state !== 'SUCCEEDED') return result(execution.state, execution.reason || execution.stop_reason, { execution, next_allowed: false });
    const state = await new Ledger(base.backend, base.config).read(packet.now ?? Date.now());
    const job = state.document.jobs[base.envelope.idempotency_key];
    if (state.document.halted) return result('BLOCKED', 'PERSISTENT_HALT', { execution });
    if (!job) return result(execution.state, execution.reason, { execution });
    const history = ['READY', ...state.document.audit.filter(a => a.key === base.envelope.idempotency_key).map(a =>
      a.type === 'DISPATCHING' ? 'RUNNING' : a.type === 'SUCCEEDED' ? 'CI_PENDING' : a.type)];
    if (job.state !== 'SUCCEEDED' || !job.outcome?.cost_known) return result(job.state, job.reason || 'WAIT_DURABLE_EXECUTION', { execution, history, reservation: job.reservation, replay: 'NEVER' });
    const collected = await Receipts.collect({ envelope: base.envelope, outcome: job.outcome,
      read: input.readGitHub, policy });
    if (!collected.receipt) return result(collected.state, collected.reason, { execution, history, next_allowed: false });
    const proofs = await readReviews(input, collected);
    if (!await authorityCheck(packet.now ?? Date.now())) return result('BLOCKED', 'COLLECTION_AUTHORITY_CHANGED', { execution, next_allowed: false });
    const gate = Receipts.reviews(proofs, collected, policy, packet.now ?? Date.now());
    if (gate.state === 'DONE') {
      const changed = await stillSettled(base, packet.now ?? Date.now());
      if (changed) return result('BLOCKED', changed, { execution, history: [...history, 'REVIEW_PENDING', 'BLOCKED'], collected, next_allowed: false });
    }
    return result(gate.state, gate.reason || null, { execution, history: [...history, 'REVIEW_PENDING', ...(gate.state === 'DONE' ? ['QA_PENDING', 'REWORK_OR_NEXT', 'DONE'] : [gate.state])], collected, ...gate });
  } catch (error) {
    // Collection uncertainty never settles/releases/reclaims execution. A later
    // event/tick can re-read evidence; R46's existing tombstone prevents spawning.
    const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'COLLECT_OR_GATE_UNVERIFIED';
    return result('BLOCKED', code, { execution, next_allowed: false, retry: 'READ_ONLY_RECHECK_NEVER_REDISPATCH' });
  }
}
async function runChain(input = {}) {
  if (!fake(input)) return runOnce(input);
  if (!Array.isArray(input.stages) || input.stages.length < 1 || input.stages.length > 4) return result('BLOCKED', 'BOUNDED_CHAIN_REQUIRED');
  const stages = [];
  let previous = null;
  let parentEnvelope = null;
  for (const item of input.stages) {
    const e = item.packet?.base?.envelope;
    if (!e || e.after !== previous) return result('BLOCKED', 'PARENT_CHAIN_BINDING', { stages });
    const outcome = await runOnce({ ...item, parentEnvelope, mode: 'fake', signal: input.signal });
    stages.push(outcome);
    if (outcome.state !== 'DONE' || outcome.next_allowed !== true) return result(outcome.state, outcome.reason, { stages, next_allowed: false });
    previous = e.idempotency_key;
    parentEnvelope = e;
  }
  return result('DONE', null, { stages, manual_prompt_transfers: 0, real_agent_wake: 'NOT_VERIFIED', next_allowed: false });
}
async function collectCompleted(input = {}) {
  if (!fake(input)) return runOnce(input);
  try {
    const C = require('../auto-handoff-r46/contract'), base = input.packet.base;
    const policy = E.publicClone(input.collectionPolicy);
    if (base.authorization?.manifest?.r57_collection_policy_digest !== C.digest(policy) ||
        C.canonical(policy.trusted_keys) !== C.canonical(base.config.trusted_keys)) return result('BLOCKED', 'COLLECTION_POLICY_NOT_AUTHORIZED');
    const state = await new Ledger(base.backend, base.config).read(Date.now()), job = state.document.jobs[base.envelope.idempotency_key];
    if (state.document.halted || job?.state !== 'SUCCEEDED' || job.envelope_hash !== C.digest(base.envelope) || !job.outcome?.cost_known) return result('BLOCKED', 'COMPLETED_WORK_UNVERIFIED');
    const collected = await Receipts.collect({ envelope: base.envelope, outcome: job.outcome, read: input.readGitHub, policy });
    if (!collected.receipt) return result(collected.state, collected.reason, { next_allowed: false });
    const gate = Receipts.reviews(await readReviews(input, collected), collected, policy, Date.now());
    if (gate.state === 'DONE') {
      const changed = await stillSettled(base, Date.now());
      if (changed) return result('BLOCKED', changed, { collected, next_allowed: false });
    }
    return result(gate.state, gate.reason || null, { collected, ...gate });
  } catch (error) { return result('BLOCKED', /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'COMPLETED_COLLECTION_UNVERIFIED', { next_allowed: false }); }
}
module.exports = { runOnce, runChain, collectCompleted };
