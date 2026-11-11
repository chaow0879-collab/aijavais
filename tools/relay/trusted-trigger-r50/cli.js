#!/usr/bin/env node
'use strict';
// node tools/trusted-trigger-r50/cli.js readiness
// Prints why a real trigger/sign/run cannot happen here. No server, timer, signer or network.
const policy = require('./config.json');
const { LIVE_SIGNING_ENABLED } = require('./broker');
function readiness(env = process.env) {
  const blockers = [];
  if (policy.enabled !== true) blockers.push('R50_DISABLED_BY_DEFAULT');
  if (!LIVE_SIGNING_ENABLED) blockers.push('LIVE_SIGNING_DISABLED');
  if (!policy.trusted_callers.length) blockers.push('NO_TRUSTED_CALLER');
  if (!Object.keys(policy.approver_keys).length) blockers.push('NO_APPROVER_KEY');
  blockers.push('BLOCKED_SIGNER_NOT_CONFIGURED');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) blockers.push('BLOCKED_IDENTITY_PROVIDER');
  if (policy.installation_id === null) blockers.push('NO_GITHUB_APP_INSTALLATION');
  blockers.push('REAL_SCHEDULE_NOT_ENABLED', 'REAL_WEBHOOK_NOT_INSTALLED', 'R49_INDEPENDENT_GATES_PENDING');
  return { state: 'BLOCKED', blockers, actual_agent_launches: 0, real_schedule: 'NOT_ENABLED', real_webhook: 'NOT_INSTALLED', secrets_read: false };
}
if (require.main === module) { const a = process.argv.slice(2); if (a.length !== 1 || a[0] !== 'readiness') { console.log(JSON.stringify({ state: 'BLOCKED', reason: 'USAGE: readiness' })); process.exitCode = 2; } else console.log(JSON.stringify(readiness(), null, 2)); }
module.exports = { readiness };
