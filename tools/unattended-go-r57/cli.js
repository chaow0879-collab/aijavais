#!/usr/bin/env node
'use strict';
const O = require('../first-pilot-r51/official-port');
const matrix = require('./OWNER_GO_MATRIX.json');
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--matrix' && /^[a-f0-9]{40}$/.test(args[1])) {
  console.log(JSON.stringify({ ...matrix, candidate_sha: args[1], authoritative_go: false }, null, 2));
} else if (args.length === 0) {
  console.log(JSON.stringify({ ...O.blocked(), workflow_state: 'WAIT_TRUSTED_RUNNER', REAL_AGENT_WAKE: 'NOT_VERIFIED' }, null, 2));
} else {
  console.error('Usage: cli.js [--matrix <40-character-frozen-sha>]; no live launch option exists');
  process.exitCode = 2;
}
