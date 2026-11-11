'use strict';
// C1: one entry for every product browser suite (needs Playwright + Chromium; see docs/TESTING.md).
// Runs each suite in its own process, in order, and fails if any suite fails. No paid model is called.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const SUITES = [
  'tests/ui/admin.e2e.js', 'tests/ui/workspace.e2e.js', 'tests/ui/intake-draft.e2e.js', 'tests/ui/b7-usability.e2e.js',
  'tests/ui/industry.e2e.js', 'tests/ui/claude-delivery.e2e.js', 'tests/ui/claude-universal-intake.e2e.js',
  'tests/haloflux-workbench-r54/workbench-live.e2e.js'
];
const only = process.argv.slice(2);
const results = [];
for (const s of SUITES.filter(x => !only.length || only.some(o => x.includes(o)))) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [s], { cwd: ROOT, stdio: 'inherit', env: process.env });
  results.push({ suite: s, status: r.status === 0 ? 'PASS' : 'FAIL', code: r.status, seconds: Math.round((Date.now() - t0) / 1000) });
}
console.log('\nBROWSER SUITES'); for (const r of results) console.log(r.status, r.suite, r.seconds + 's');
process.exit(results.length && results.every(r => r.status === 'PASS') ? 0 : 1);
