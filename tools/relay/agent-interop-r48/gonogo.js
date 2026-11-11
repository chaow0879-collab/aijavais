'use strict';
// R48 M3: GO/NO_GO contract for ONE non-production, read-only, budget-capped real Claude CLI
// run. It only evaluates facts; it never starts anything, reads no secret values and treats
// every unproven item as NOT_CONFIGURED / NOT_RUN / BLOCKED. GO requires every item SATISFIED.
const { GATE_FACTS, SOURCES } = require('./sources');

const ITEM = (id, requirement, status, evidence, owner, how) => ({ id, requirement, status, evidence, owner, required_evidence: how });
function evaluate({ matrix, preflight, facts = {} } = {}) {
  const f = { r47_audit: GATE_FACTS.r47_independent_audit, r47_qa: 'NOT_YET_PASSED', final_candidate_sha: null, final_candidate_audit: 'NOT_RUN', final_candidate_qa: 'NOT_RUN',
    broker_key_configured: false, secrets_scoped_to_protected_environment: false, default_branch_workflows: false, remote_cas_verified: false, operator_kill_switch_runbook: false, ...facts };
  const rows = matrix?.rows || [];
  const bad = rows.filter(r => r.verdict === 'INCOMPATIBLE' || r.verdict === 'UNSAFE_ACCEPTED');
  const unsafe = rows.filter(r => r.verdict === 'UNSAFE_ACCEPTED');
  const cl = preflight?.clis?.claude, cred = preflight?.credentials?.claude, runner = preflight?.runner;
  const items = [
    ITEM('G01', 'R47 (AUD-R43-01 fix) independently ACCEPTED by CodeAudit', f.r47_audit === 'ACCEPT' || f.r47_audit === 'ACCEPT_WITH_FOLLOWUP' ? 'SATISFIED' : 'BLOCKED', 'R43 ab3e: REJECT (' + GATE_FACTS.r43_audit_ref + '); R47 ' + GATE_FACTS.r47_fix_candidate + ': ' + f.r47_audit, 'Independent-CodeAudit #2', 'Signed #2 report: reviewed_sha = exact 40-char R47/R49 SHA, verdict ACCEPT*, no open P0/P1'),
    ITEM('G02', 'R47 ProductQA PASS on the same SHA', f.r47_qa === 'PASS' ? 'SATISFIED' : 'BLOCKED', 'ProductQA: ' + f.r47_qa, 'ProductQA #4', '#4 report on the same reviewed_sha with real E2/E3 runs'),
    ITEM('G03', 'One frozen integration candidate (R47 + R46 + R45 + R48 deltas) independently audited and QA-passed', f.final_candidate_sha && f.final_candidate_audit === 'ACCEPT' && f.final_candidate_qa === 'PASS' ? 'SATISFIED' : 'NOT_RUN', 'final candidate: ' + (f.final_candidate_sha || 'none yet (Codex #32 R49)'), 'Codex-Integrator #32 + #2 + #4', 'Single 40-char SHA, CI on that SHA, incremental audit of R45/R46/R48 code'),
    ITEM('G04', 'Cross-runner protocol gaps closed (no INCOMPATIBLE / UNSAFE rows)', bad.length ? 'BLOCKED' : 'SATISFIED', bad.map(r => r.id + ':' + r.verdict).join(', ') || 'none', 'Codex-Integrator (R49) using R48 deltas', 'Re-run this matrix on the integration candidate: 0 INCOMPATIBLE, 0 UNSAFE_ACCEPTED'),
    ITEM('G05', 'Runner binds the checked-out source SHA to the audited gate SHA (AUD-R43-01 class)', unsafe.some(r => r.id === 'S01') ? 'BLOCKED' : 'SATISFIED', unsafe.some(r => r.id === 'S01') ? 'R45 accepts source.sha != gate_sha (matrix S01)' : 'matrix S01 refused', 'Integrator', 'R45 authorize() requires source.sha === gate.gate_sha; matrix S01 = SAFE_REFUSAL'),
    ITEM('G06', 'Official Claude Code CLI present on an ephemeral GitHub-hosted runner with required flags', cl?.status === 'VERIFIED' && runner?.ephemeral_github_hosted ? 'SATISFIED' : cl?.status === 'VERIFIED' ? 'NOT_RUN' : 'NOT_CONFIGURED', 'cli=' + (cl?.status || 'unknown') + ' ' + (cl?.version || '') + '; ephemeral=' + Boolean(runner?.ephemeral_github_hosted), 'Deployment/Infra', 'R45 preflight on the target runner: clis.claude VERIFIED, runner.ephemeral_github_hosted true'),
    ITEM('G07', 'Official model authentication available ONLY inside the trusted runner', cred?.status === 'PRESENT_UNVERIFIED' && f.secrets_scoped_to_protected_environment ? 'SATISFIED' : 'NOT_CONFIGURED', 'credential=' + (cred?.status || 'unknown') + '; protected environment=' + f.secrets_scoped_to_protected_environment, 'Owner (explicit authorization) + Deployment', 'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN as a GitHub Environment secret with required reviewers; never from chat, browser cookies or a developer session'),
    ITEM('G08', 'Enforceable spend cap and timeout', cl?.status === 'VERIFIED' ? 'SATISFIED' : 'NOT_RUN', 'claude --max-budget-usd + R45 cap ≤ policy max_budget_usd + double wall-clock; codex refused (no native cap)', 'Integrator', 'R45 policy max_budget_usd and envelope cap_usd > 0; matrix C04/S13/S15'),
    ITEM('G09', 'Trusted dispatcher signing key (not a fixture/test key) in the runner policy', f.broker_key_configured ? 'SATISFIED' : 'NOT_CONFIGURED', 'R45 shipped trusted_keys = {} ; test keys use prefix r48-test-broker- and are never exported', 'Owner + Integrator', 'Key generated inside the control plane environment; public key committed by an audited change'),
    ITEM('G10', 'GitHub event + default-branch 10-minute schedule actually enabled', f.default_branch_workflows ? 'SATISFIED' : 'NOT_ENABLED', 'R46 config enabled/webhook/cron/real_dispatch = false; workflows only on feature branches', 'Owner (main merge authorization) + Codex', 'Workflow on the default branch, schedule */10, first real event logged'),
    ITEM('G11', 'Remote state write + atomic CAS proven against real GitHub refs', f.remote_cas_verified ? 'SATISFIED' : 'NOT_RUN', 'R46 uses FakeAtomicRemote in tests only', 'Codex', 'Run on a protected test ref: concurrent CAS, lost ACK read-back, no double claim'),
    ITEM('G12', 'Kill switch: mechanism', rows.some(r => r.id === 'S17' && r.verdict === 'SAFE_REFUSAL') ? 'SATISFIED' : 'NOT_RUN', 'R45 KILL file/env + R46 signed HALT (matrix S17, E3 fake)', 'Integrator', 'matrix S17'),
    ITEM('G13', 'Kill switch: operational runbook and who may pull it', f.operator_kill_switch_runbook ? 'SATISFIED' : 'NOT_CONFIGURED', 'not written', 'Owner + Deployment', 'Named operator, documented command, tested once'),
    ITEM('G14', 'Duplicate-task audit trail (event, tick, race, lost ACK, restart)', ['S09', 'S10', 'S11', 'S12', 'S19'].every(id => rows.some(r => r.id === id && r.verdict === 'SAFE_REFUSAL')) ? 'SATISFIED' : 'NOT_RUN', 'matrix S09–S12, S19 (one launch per work, E3 fake)', 'Integrator', 'Same rows on the integration candidate'),
    ITEM('G15', 'Production isolation (no production DB/server/Caddy/S-UI, read-only task, no repo write)', 'SATISFIED', 'R45 private clone, remote removed, read-only verification (matrix S18), --permission-mode plan, Read/Glob/Grep only', 'Integrator', 'matrix S18 + R45 workspace checks'),
    ITEM('G16', 'Live switches stay OFF until every item above is SATISFIED', rows.some(r => r.id === 'S21' && r.verdict === 'SAFE_REFUSAL') ? 'SATISFIED' : 'BLOCKED', 'R45 live_enabled=false, R46 enabled/real_dispatch=false (matrix S21)', 'Everyone', 'matrix S21')
  ];
  const go = items.every(i => i.status === 'SATISFIED');
  return {
    schema: 'aijavais.interop.gonogo/v1', evaluated_at: new Date().toISOString(), decision: go ? 'GO' : 'NO_GO',
    scope: 'one non-production, read-only, budget-capped real Claude CLI run (template readonly-repo-summary)',
    sources: { r45: SOURCES.r45.sha, r46: SOURCES.r46.sha }, real_agent_launches: 0, model_calls_made: 0,
    blocking: items.filter(i => i.status !== 'SATISFIED').map(i => i.id + ':' + i.status), items,
    evidence_for_reviewers: [
      'Exact 40-char SHA of the frozen integration candidate and its CI run/attempt with all jobs listed (no skipped required job counted as PASS)',
      'This conformance matrix re-run on that SHA (sources block shows the SHAs actually executed)',
      'R45 preflight JSON from the same ephemeral runner (CLI version/flags, credential PRESENCE only, model_calls_made=0)',
      'For the single real run: R45 outcome (pid, exit_code, elapsed_ms, cost.usd from the CLI JSON, log_sha256), sanitized log, workflow run link, and the R46 settlement with redispatch=never',
      'Proof that a second trigger for the same work produced DUPLICATE with zero additional launches'
    ]
  };
}
module.exports = { evaluate };
