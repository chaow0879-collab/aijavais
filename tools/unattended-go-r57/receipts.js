'use strict';
// Read-only collection and projection. R46 remains the only dispatch ledger;
// R45 remains the only process journal. No new signer or persistence protocol.
const C = require('../auto-handoff-r46/contract');
const P = require('../agent-pilot-r45/contract');
const { publicClone } = require('../first-pilot-r51/entry');
const { verifyReadiness } = require('../agent-executor/cli-runner');
const fail = code => { throw Object.assign(Error(code), { code }); };
async function readBounded(read, route) {
  let timer;
  try {
    const response = await Promise.race([Promise.resolve().then(() => read('GET', route)), new Promise((_, no) => {
      timer = setTimeout(() => no(Object.assign(Error('COLLECT_TIMEOUT'), { code: 'COLLECT_TIMEOUT' })), 1000);
    })]);
    if (response?.status !== 200) fail(response?.status === 429 ? 'COLLECT_RATE_LIMITED' : 'COLLECT_UNAVAILABLE');
    const data = publicClone(response.data);
    if (Buffer.byteLength(C.canonical(data)) > 1048576) fail('COLLECT_RESPONSE_LIMIT');
    return data;
  } finally { clearTimeout(timer); }
}
async function collect({ envelope: e, outcome: o, read, policy }) {
  if (typeof read !== 'function') return { state: 'CI_PENDING', reason: 'WAIT_TRUSTED_RECEIPT_READER' };
  if (!o || o.fixed_sha !== e.source_sha || !o.cost_known || o.state !== 'SUCCESS') fail('COLLECT_OUTCOME_BINDING');
  const prefix = '/repos/' + C.REPO;
  const branch = await readBounded(read, prefix + '/git/ref/heads/' + e.branch);
  if (branch.ref !== 'refs/heads/' + e.branch || branch.object?.sha !== e.source_sha) fail('COLLECT_REF_MOVED');
  const commit = await readBounded(read, prefix + '/commits/' + e.source_sha);
  if (commit.sha !== e.source_sha || !C.SHA.test(commit.commit?.tree?.sha || '')) fail('COLLECT_COMMIT_BINDING');
  const runId = new RegExp('^https://github.com/' + C.REPO + '/actions/runs/([1-9][0-9]*)$').exec(o.ci_ref)?.[1];
  const commentId = new RegExp('^https://github.com/' + C.REPO + '/issues/' + e.issue + '#issuecomment-([1-9][0-9]*)$').exec(o.report_ref)?.[1];
  if (!runId || !commentId) fail('COLLECT_REFERENCE_BINDING');
  const ci = await readBounded(read, prefix + '/actions/runs/' + runId);
  if (String(ci.id) !== runId || ci.head_sha !== e.source_sha || ci.head_branch !== e.branch ||
      ci.repository?.full_name !== C.REPO || ci.head_repository?.full_name !== C.REPO || ci.head_repository?.fork !== false ||
      !['push', 'workflow_dispatch'].includes(ci.event) || !policy.workflow_paths?.includes(ci.path) ||
      ci.html_url !== o.ci_ref || !Number.isSafeInteger(ci.run_attempt) || ci.run_attempt < 1) fail('COLLECT_CI_BINDING');
  if (ci.status !== 'completed') return { state: 'CI_PENDING', reason: 'WAIT_FIXED_SHA_CI' };
  if (ci.conclusion !== 'success') return { state: 'REWORK_OR_NEXT', reason: 'CI_REJECTED', next_allowed: false };
  const comment = await readBounded(read, prefix + '/issues/comments/' + commentId);
  if (String(comment.id) !== commentId || comment.html_url !== o.report_ref ||
      comment.issue_url !== 'https://api.github.com' + prefix + '/issues/' + e.issue ||
      !policy.developer_logins?.includes(comment.user?.login) || typeof comment.body !== 'string') fail('COLLECT_REPORT_IDENTITY');
  let report;
  try { report = JSON.parse(comment.body); } catch { fail('COLLECT_STRUCTURED_REPORT_REQUIRED'); }
  if (P.outcomeErrors(report).length || report.state !== 'SUCCESS' || report.run_id !== o.run_id ||
      report.source_sha !== e.source_sha || report.dispatch_id !== e.dispatch_id ||
      report.cost.known !== true || report.cost.usd !== o.cost || report.agent_launch.mode !== 'fake' ||
      report.agent_launch.process_launches !== 1 || report.agent_launch.actual_agent_launches !== 0 ||
      report.agent_launch.cli !== e.kind || report.gate_sha !== e.source_sha ||
      (report.evidence.ci_ref !== null && report.evidence.ci_ref !== o.ci_ref) ||
      !C.HASH.test(report.evidence.log_sha256 || '')) fail('COLLECT_REPORT_BINDING');
  const receipt = { repo: C.REPO, issue: e.issue, branch: e.branch, work_key: C.pilotWorkKey(e), task_id: e.task_id,
    source_sha: e.source_sha, work_sha: commit.sha, tree_sha: commit.commit.tree.sha, run_id: o.run_id,
    ci: { id: ci.id, attempt: ci.run_attempt, sha: ci.head_sha, path: ci.path, conclusion: ci.conclusion },
    report_ref: o.report_ref, report_digest: C.digest(report), developer: comment.user.login,
    log_sha256: report.evidence.log_sha256, evidence: 'E3_FAKE', real_agent_launches: 0 };
  return { state: 'REVIEW_PENDING', receipt, digest: C.digest(receipt) };
}
function reviews(bundle, collected, config, now) {
  if (!bundle) return { state: 'REVIEW_PENDING', reason: 'WAIT_AUTHORIZED_REVIEWER' };
  const b = publicClone(bundle), m = b.manifest;
  if (!m || m.control_operation !== 'COLLECT' || m.fake_only !== true || m.evidence !== 'E2_E3_FAKE' ||
      m.sha !== collected.receipt.work_sha || m.fixed_gate_sha !== collected.receipt.work_sha ||
      m.r57_receipt_digest !== collected.digest || m.repo !== C.REPO || m.issue !== collected.receipt.issue ||
      m.branch !== collected.receipt.branch || C.canonical(m.allowed_issues) !== C.canonical(config.allowed_issues) ||
      C.canonical(m.allowed_branches) !== C.canonical(config.allowed_branches) ||
      !config.allowed_issues.includes(m.issue) || !config.allowed_branches.includes(m.branch)) fail('COLLECT_REVIEW_BINDING');
  const a = b.proofs?.v1_audit, q = b.proofs?.v2_audit;
  if (!a) return { state: 'REVIEW_PENDING', reason: 'WAIT_AUTHORIZED_REVIEWER' };
  // A negative signed gate is never converted into an approval or a new task.
  // Missing/invalid signatures are also blocking; no automatic retry of work.
  if (!q) return { state: 'REVIEW_PENDING', reason: 'WAIT_AUTHORIZED_REVIEWER' };
  verifyReadiness(m, b.proofs, config.trusted_keys);
  for (const [role, p] of Object.entries(b.proofs)) {
    if (!['v1_audit', 'v2_audit', 'operator'].includes(role) || p.payload.reviewed_sha !== collected.receipt.work_sha) fail('COLLECT_REVIEW_SHA');
    if (p.payload.expires_at <= now) fail('COLLECT_REVIEW_EXPIRED');
  }
  if (a.payload.reviewer_login === q.payload.reviewer_login ||
      !config.reviewers?.audit?.includes(a.payload.reviewer_login) ||
      !config.reviewers?.qa?.includes(q.payload.reviewer_login) ||
      [a.payload.reviewer_login, q.payload.reviewer_login].includes(collected.receipt.developer)) fail('COLLECT_INDEPENDENT_IDENTITIES');
  if (q.payload.product_verdict === 'PENDING') return { state: 'QA_PENDING', reason: 'WAIT_AUTHORIZED_REVIEWER' };
  if (q.payload.product_verdict !== 'PASS') fail('COLLECT_QA_NOT_PASS');
  return { state: 'DONE', next_allowed: true, review_evidence: 'SYNTHETIC_ONLY_NOT_REAL_ACCEPT', receipt_digest: collected.digest };
}
module.exports = { collect, reviews, readBounded };
