#!/usr/bin/env node
'use strict';
// R56 CLI. `readiness` lists what blocks a real unattended hand-off. `next` is the per-role wrapper:
// an agent runner asks "is there work for my role?" and gets the structured ticket (inputs are refs
// and SHAs, never pasted prompts) or the exact reason it must wait. `tick` is what the disabled
// workflow template would call; in this source it always reports BLOCKED_ACTUAL_RUNNER_IDENTITY.
const fs = require('node:fs');
const path = require('node:path');
const M = require('./machine');
const B = require('./bridge');
const G = require('./github');
const pipelineDefault = require('./pipeline.json');

function readiness(pipeline = pipelineDefault) {
  const blockers = [];
  if (pipeline.enabled !== true) blockers.push('R56_DISABLED_BY_DEFAULT');
  if (!B.LIVE_HANDOFF_ENABLED) blockers.push('R56_LIVE_HANDOFF_DISABLED');
  if (!G.LIVE_TRANSPORT_ENABLED) blockers.push('R56_LIVE_GITHUB_TRANSPORT_DISABLED');
  if (!pipeline.work_items.length) blockers.push('NO_WORK_ITEMS');
  for (const role of ['developer', 'integrator', 'audit', 'qa', 'owner', 'bridge']) if (!(pipeline.actors[role] || []).length) blockers.push('NO_TRUSTED_ACTOR_' + role.toUpperCase());
  for (const role of ['audit', 'qa']) if (!Object.keys(pipeline.reviewer_keys[role] || {}).length) blockers.push('NO_REVIEWER_KEY_' + role.toUpperCase());
  if (!pipeline.ci.workflows.length || !pipeline.ci.required_jobs.length) blockers.push('NO_CI_POLICY');
  blockers.push(...B.blockedLive().blockers);
  return { state: 'BLOCKED', blockers: [...new Set(blockers)], actual_agent_launches: 0, real_schedule: 'NOT_ENABLED', real_webhook: 'NOT_INSTALLED', E4: 'NOT_RUN', E5: 'NOT_RUN',
    owner_activation_once: ['GitHub App installation + webhook secret (R50)', 'default-branch workflow from templates/*.disabled with OIDC (R50/R56)', 'KMS/HSM broker signer (R50)', 'reviewer public keys for #2/#4', 'protected state ref for R46 CAS', 'official CLI runner identity + provider-enforced cost cap (R51/R57)', 'final independent audit + QA of the integrated SHA', 'explicit owner GO'] };
}
function next({ role, pipeline, snapshot, ledger, now = Date.now(), item: itemId }) {
  const items = pipeline.work_items.filter(i => !itemId || i.id === itemId);
  const out = [];
  for (const item of items) {
    const d = M.decide({ snapshot, pipeline, item, jobs: ledger && ledger.jobs || null, now });
    const mine = d.ticket && d.ticket.role === role;
    out.push({ work_item: item.id, state: d.state, reason: d.reason, for_role: mine ? role : (d.ticket ? d.ticket.role : null), ticket: mine ? d.ticket : null, todo: (d.todo || []).filter(t => t.role === role || role === 'owner') });
  }
  return { role, results: out, launches: 0, note: '只返回结构化工单与等待原因；领取与执行仍经 R50/R51/R46 授权链。' };
}
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = n => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
  const json = f => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
  let r;
  if (cmd === 'readiness') r = readiness();
  else if (cmd === 'next') r = next({ role: arg('role'), item: arg('item'), pipeline: arg('pipeline') ? json(arg('pipeline')) : pipelineDefault, snapshot: json(arg('snapshot')), ledger: arg('ledger') ? json(arg('ledger')) : null, now: arg('now') ? Number(arg('now')) : Date.now() });
  else if (cmd === 'tick') r = B.blockedLive();
  else { console.error('usage: cli.js readiness | next --role <role> --snapshot <file> [--ledger <file>] [--pipeline <file>] | tick'); process.exitCode = 2; }
  if (r) { console.log(JSON.stringify(r, null, 2)); if (cmd !== 'next' && r.state === 'BLOCKED') process.exitCode = 0; }
}
module.exports = { readiness, next };
