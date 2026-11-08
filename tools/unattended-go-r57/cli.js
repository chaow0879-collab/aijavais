#!/usr/bin/env node
'use strict';
const O = require('../first-pilot-r51/official-port');
const matrix = require('./OWNER_GO_MATRIX.json');
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--plan' && ['claude','codex'].includes(args[1])) {
  console.log(JSON.stringify({ cli: args[1], args: require('../agent-pilot-r45/runner').command(args[1], '<approved-readonly-repo-summary>', 0.1),
    mode: 'READONLY_PLAN_NOT_EXECUTION', official_auth: 'NOT_VERIFIED', provider_usd_single_and_total_cap: 'NOT_VERIFIED',
    provider_token_cap: 'NOT_VERIFIED', model_calls: 0, r50_approval_protocol: args[1] === 'claude' ? 'EXISTING_READONLY' : 'NOT_SUPPORTED_BY_CURRENT_R50_APPROVAL' }, null, 2));
} else if (args.length === 2 && args[0] === '--matrix' && /^[a-f0-9]{40}$/.test(args[1])) {
  console.log(JSON.stringify({ ...matrix, candidate_sha: args[1], authoritative_go: false }, null, 2));
} else if (args.length === 0) {
  console.log(JSON.stringify({ ...O.blocked(), workflow_state: 'WAIT_TRUSTED_RUNNER', REAL_AGENT_WAKE: 'NOT_VERIFIED' }, null, 2));
} else {
  console.error('Usage: cli.js [--matrix <40-character-frozen-sha>|--plan claude|--plan codex]; no live launch option exists');
  process.exitCode = 2;
}
