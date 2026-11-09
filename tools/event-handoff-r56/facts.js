'use strict';
// R56 read-only fact extraction from a GitHub snapshot. Only trusted, structured report blocks
// count; issue/PR free text never becomes a command, approval or prompt. The report block format is
// the existing scheduler `[AGENT_REPORT_V1] … [/AGENT_REPORT_V1]` (tools/agent-scheduler/state.parse)
// and reviewer proofs use the existing R46/agent-executor proof shape {key_id,payload,signature}
// (Ed25519 over canonical(payload)). No new signature format is introduced here.
const crypto = require('node:crypto');
const { parse } = require('../agent-scheduler/state');
const C = require('../auto-handoff-r46/contract');
const SHA = /^[a-f0-9]{40}$/;
const ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const NEGATIVE = new Set(['REJECT', 'REJECTED', 'FAIL', 'FAILED', 'BLOCKED', 'REVOKED', 'WITHDRAWN', 'CANCELLED']);
const ACCEPT = { audit: ['ACCEPT', 'ACCEPT_WITH_FOLLOWUP'], qa: ['PASS'] };
const fail = code => { throw Object.assign(new Error(code), { code }); };

function trustedBy(pipeline, role, c) {
  const list = pipeline.actors && pipeline.actors[role];
  return Array.isArray(list) && list.includes(c.user && c.user.login) && ASSOC.has(c.author_association) && c.pull_request !== true;
}
function ordered(list) {
  const keyed = list.map((c, i) => ({ c, i, t: Date.parse(c && c.created_at) }));
  if (keyed.some(k => !Number.isFinite(k.t))) fail('UNKNOWN_COMMENT_ORDER');
  return keyed.sort((a, b) => a.t - b.t || (Number(a.c.id) || 0) - (Number(b.c.id) || 0) || a.i - b.i).map(k => k.c);
}
function block(c) {
  const b = parse(c && c.body, 'AGENT_REPORT_V1');
  if (!b) return null;
  for (const k of ['head_sha', 'reviewed_sha']) if (typeof b[k] === 'string') b[k] = b[k].replace(/`/g, '').trim();
  for (const k of ['status', 'verdict']) if (typeof b[k] === 'string') b[k] = b[k].trim().toUpperCase();
  return b;
}
// Snapshot sanity: complete, fresh, right repository. Anything else is UNKNOWN (never "nothing to do").
function check(snapshot, pipeline, now) {
  if (!snapshot || snapshot.complete !== true || !Number.isFinite(snapshot.checked_at) || now - snapshot.checked_at > pipeline.max_snapshot_age_ms || snapshot.checked_at > now + 30000) fail('UNKNOWN_INCOMPLETE_OR_STALE_SOURCE');
  if (!snapshot.repository || snapshot.repository.full_name !== pipeline.repo || snapshot.repository.id !== pipeline.repository_id) fail('UNKNOWN_SOURCE_REPOSITORY');
  if (!snapshot.issues || typeof snapshot.issues !== 'object' || !Array.isArray(snapshot.runs) || !snapshot.refs) fail('UNKNOWN_SOURCE_FIELDS');
}
function verifyProof(pipeline, role, b, item, candidate, now) {
  const p = b.proof;
  if (!C.plain(p) || typeof p.key_id !== 'string' || typeof p.signature !== 'string' || !C.plain(p.payload)) return 'PROOF_MISSING';
  const key = pipeline.reviewer_keys && pipeline.reviewer_keys[role] && pipeline.reviewer_keys[role][p.key_id];
  if (!key) return 'REVIEWER_KEY_NOT_REGISTERED';
  const x = p.payload;
  if (!C.keys(x, 'role verdict reviewed_sha work_item issue expires_at') || x.role !== role || x.verdict !== b.verdict || x.reviewed_sha !== candidate || x.work_item !== item.id || x.issue !== item.issue) return 'PROOF_BINDING';
  if (!Number.isSafeInteger(x.expires_at) || x.expires_at <= now || x.expires_at - now > pipeline.review_ttl_ms) return 'PROOF_EXPIRED';
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(C.canonical(x)), key, Buffer.from(p.signature, 'base64')); } catch { ok = false; }
  return ok ? null : 'PROOF_SIGNATURE';
}
const der = pem => crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('hex');

function read(snapshot, pipeline, item, now) {
  check(snapshot, pipeline, now);
  const issue = n => ordered(((snapshot.issues[String(n)] || {}).comments || []).filter(c => c && c.pull_request !== true));
  const work = issue(item.issue);
  // Candidate: the LATEST trusted structured report of the candidate role on the work item issue.
  const reports = work.filter(c => trustedBy(pipeline, item.candidate_from, c)).map(c => ({ c, b: block(c) })).filter(x => x.b && typeof x.b.status === 'string');
  const latest = reports[reports.length - 1] || null;
  const candidate = latest && latest.b.status === 'READY_FOR_REVIEW' && SHA.test(latest.b.head_sha || '') ? latest.b.head_sha : null;
  const withdrawn = latest && latest.b.status !== 'READY_FOR_REVIEW' ? latest.b.status : null;
  // Owner revocation is privilege-reducing and needs no signature.
  const revoked = work.filter(c => trustedBy(pipeline, 'owner', c)).map(block).some(b => b && NEGATIVE.has(b.status || '') && (!b.head_sha || b.head_sha === candidate));
  const reviews = {};
  for (const role of ['audit', 'qa']) {
    const list = issue(pipeline.review_issues[role]).filter(c => trustedBy(pipeline, role, c)).map(c => ({ c, b: block(c) }))
      .filter(x => x.b && (x.b.work_item === item.id || Number(x.b.issue) === item.issue));
    const forSha = list.filter(x => !x.b.reviewed_sha || x.b.reviewed_sha === candidate);
    const negative = forSha.filter(x => NEGATIVE.has(x.b.verdict || '') || NEGATIVE.has(x.b.status || ''));
    const positive = candidate ? forSha.filter(x => ACCEPT[role].includes(x.b.verdict) && x.b.reviewed_sha === candidate) : [];
    const verified = positive.map(x => ({ ...x, problem: verifyProof(pipeline, role, x.b, item, candidate, now) }));
    const good = verified.filter(x => !x.problem);
    reviews[role] = { negative: negative.map(x => x.c.html_url), accepted: good.length ? { ref: good[good.length - 1].c.html_url, login: good[good.length - 1].c.user.login, key: pipeline.reviewer_keys[role][good[good.length - 1].b.proof.key_id] } : null,
      problems: verified.filter(x => x.problem).map(x => ({ ref: x.c.html_url, problem: x.problem })), registered_keys: Object.keys((pipeline.reviewer_keys || {})[role] || {}).length };
  }
  // Independence: reviewers are distinct people with distinct keys and never authors of the work.
  const authors = new Set(['developer', 'integrator'].flatMap(r => pipeline.actors[r] || []));
  let independence = null;
  const a = reviews.audit.accepted, q = reviews.qa.accepted;
  if (a && q) {
    if (a.login === q.login) independence = 'SAME_REVIEWER_FOR_AUDIT_AND_QA';
    else if (authors.has(a.login) || authors.has(q.login)) independence = 'REVIEWER_IS_AUTHOR';
    else { try { if (der(a.key) === der(q.key)) independence = 'SAME_KEY_FOR_AUDIT_AND_QA'; } catch { independence = 'REVIEWER_KEY_INVALID'; } }
  }
  const ci = snapshot.runs.filter(r => r && r.head_sha === candidate && r.head_branch === item.branch && pipeline.ci.events.includes(r.event) && r.head_repository && r.head_repository.full_name === pipeline.repo && r.head_repository.fork !== true && pipeline.ci.workflows.includes(r.name));
  return { candidate, candidate_ref: latest ? latest.c.html_url : null, withdrawn, revoked, branch_sha: snapshot.refs[item.branch] || null, reviews, independence, ci: ciGate(ci, pipeline, snapshot.runs_complete) };
}

// AUD-R57-01 / AUD-BC72-01..02: for every required workflow, EVERY run of the candidate SHA (at its latest
// attempt) must be completed/success with all required jobs successful. A re-run of an older run that
// fails or is still pending blocks even when a newer run id succeeded. Missing identity or completeness
// fields are UNKNOWN and block. Normal matrices whose same-name jobs all succeed still pass.
const num = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
function latestAttempts(runs) {
  if (runs.some(r => num(r.id) === null || num(r.run_attempt) === null)) return { problem: 'CI_UNKNOWN_ORDER' };
  if (runs.some(r => num(r.workflow_id) === null)) return { problem: 'CI_WORKFLOW_IDENTITY_UNKNOWN' };
  if (new Set(runs.map(r => r.workflow_id)).size > 1) return { problem: 'CI_WORKFLOW_IDENTITY_AMBIGUOUS' };
  const byId = new Map();
  for (const r of runs) {
    const prev = byId.get(r.id);
    if (prev && prev.run_attempt === r.run_attempt) return { problem: 'CI_DUPLICATE_RUN_ATTEMPT' };
    if (!prev || r.run_attempt > prev.run_attempt) byId.set(r.id, r);
  }
  return { runs: [...byId.values()].sort((a, b) => a.id - b.id) };
}
function runGreen(r, required) {
  if (r.status !== 'completed' || r.conclusion !== 'success') return 'CI_RUN_' + String(r.status === 'completed' ? r.conclusion : r.status || 'unknown').toUpperCase();
  if (r.jobs_complete !== true) return 'CI_JOBS_INCOMPLETE';
  const jobs = Array.isArray(r.jobs) ? r.jobs : [];
  for (const j of required) {
    const same = jobs.filter(x => x && x.name === j);
    if (!same.length) return 'CI_REQUIRED_JOB_MISSING';
    if (same.some(x => x.conclusion !== 'success' || x.status !== 'completed')) return 'CI_REQUIRED_JOB_NOT_SUCCESS';
  }
  return null;
}
function ciGate(ci, pipeline, complete = true) {
  const workflows = pipeline.ci.workflows || [];
  if (!ci.length) return { runs: 0, green: null, failed: false };
  if (!workflows.length || !Array.isArray(pipeline.ci.required_jobs) || !pipeline.ci.required_jobs.length) return { runs: ci.length, green: null, failed: true, problem: 'CI_POLICY_EMPTY' };
  if (complete !== true) return { runs: ci.length, green: null, failed: true, problem: 'CI_RUN_LIST_INCOMPLETE' };
  let last = null;
  for (const w of workflows) {
    const runs = ci.filter(r => r.name === w);
    if (!runs.length) return { runs: ci.length, green: null, failed: false, problem: 'CI_REQUIRED_WORKFLOW_MISSING' };
    const sel = latestAttempts(runs);
    if (sel.problem) return { runs: ci.length, green: null, failed: true, problem: sel.problem };
    for (const r of sel.runs) {
      const problem = runGreen(r, pipeline.ci.required_jobs);
      if (problem) return { runs: ci.length, green: null, failed: true, problem, run: r.html_url };
    }
    last = sel.runs[sel.runs.length - 1];
  }
  return { runs: ci.length, green: last.html_url, failed: false };
}
module.exports = { read, ciGate, block, verifyProof, trustedBy, NEGATIVE, ACCEPT, SHA };
