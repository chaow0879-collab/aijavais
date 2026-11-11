'use strict';
// Composition only: R46 owns durable CAS/leases; R45 owns one-shot processes.
// No signing key, credential lookup, transport or additional scheduler lives here.
const R46 = require('../auto-handoff-r46/reconcile');
const C = require('../auto-handoff-r46/contract');
const G = require('../auto-handoff-r46/gates');
const B = require('../auto-handoff-r46/pilot-contract');
const P = require('../agent-pilot-r45/contract');
const A = require('../agent-pilot-r45/policy');
const { SignedFakeR45Runner } = require('../auto-handoff-r46/r45-adapter');
const report = (state, reason, more = {}) => ({state, reason, actual_agent_launches:0, real_dispatch:false, cost:'NOT_VERIFIED', E4:'NOT_RUN', E5:'NOT_RUN', schedule:'NOT_ENABLED', ...more});
const SHA = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);

function readiness(facts = {}) {
  const blockers = [];
  const sha = facts.candidate_sha;
  if (!SHA(sha) || ['ab3e07979f67924e795426737e26c5c4d84b8501','6363e8d10595a566a1ba266cb70017711cc806be'].includes(sha)) blockers.push('BLOCKED_CANDIDATE');
  for (const role of ['r47_audit','r47_qa','final_audit','final_qa']) {
    const g = facts[role], expected = role.endsWith('audit') ? ['ACCEPT','ACCEPT_WITH_FOLLOWUP'] : ['PASS'];
    const target = role.startsWith('r47_') ? '3c37035befab9e411724686ff22e44333174e217' : sha;
    if (!g || g.reviewed_sha !== target || !expected.includes(g.verdict) || !C.safeRef(g.ref)) blockers.push('BLOCKED_' + role.toUpperCase());
  }
  if (facts.trusted_signature_broker_verified !== true) blockers.push('BLOCKED_TRUSTED_SIGNATURE_BROKER');
  if (facts.official_credentials_verified !== true || facts.enforceable_budget_verified !== true) blockers.push('BLOCKED_CREDENTIALS_OR_BUDGET');
  for (const key of ['final_ci_verified','state_ref_cas_verified','ephemeral_isolation_verified','stop_verified','explicit_go_verified']) if (facts[key] !== true) blockers.push('BLOCKED_' + key.toUpperCase());
  // Boolean evidence summaries are planning inputs, never executable grants.
  blockers.push('LIVE_BUILD_DISABLED');
  return report('BLOCKED', blockers[0], {blockers, input_is_authorization:false});
}

function prepare(input) {
  G.policy(input.config);
  // Both candidate and review SHA must flow through V1/V2 readiness and R45,
  // rather than turning an old source's accepted evidence into a new grant.
  if (!SHA(input.envelope?.source_sha) || input.candidate_sha !== input.envelope.source_sha || input.config.source_sha !== input.candidate_sha || input.snapshot?.refs?.[input.envelope.branch] !== input.candidate_sha) C.reject('CANDIDATE_SHA_MISMATCH');
  G.verify(input.envelope,input.authorization,input.snapshot,input.config,input.now);
  return B.prepare(input);
}

async function execute(input = {}) {
  if (input.simulate !== true) return readiness(input.facts);
  try {
    // Freeze user-owned structures before the first asynchronous CAS wait.
    const copied = {};
    for (const key of ['candidate_sha','config','envelope','authorization','snapshot','now','signed','policy','refs']) copied[key] = structuredClone(input[key]);
    const bound = {...input, ...copied};
    const prepared = prepare(bound);
    if (!bound.signed) return report('BLOCKED','BLOCKED_TRUSTED_SIGNATURE_BROKER');
    if (P.canonical(P.unsigned(bound.signed)) !== P.canonical(prepared.unsigned_envelope) || A.authorize(bound.signed,bound.policy,bound.now)) return report('BLOCKED','BLOCKED_TRUSTED_SIGNATURE_BROKER');
    const runner = new SignedFakeR45Runner({...bound,prepared});
    const result = await R46.reconcile({...bound,runner});
    return {...result, runner_calls:runner.calls, previous_run_id:runner.previousRunId, integration:'R46_CAS_TO_R45_SIGNED_FAKE_CLI', schedule:'NOT_ENABLED', E4:'NOT_RUN', E5:'NOT_RUN'};
  } catch {
    // Never forward untrusted error text, signatures, prompt or credentials.
    return report('BLOCKED','INTEGRATION_CONTRACT_OR_GATE_REJECTED');
  }
}
module.exports = {readiness,prepare,execute};
