'use strict';
// The original R52 assertions specify the older V2 contract (single authorization,
// /api/v2/runs, local checks). R54 intentionally prefers R53 when discovery succeeds.
// Exercise its retained fallback by explicitly simulating ONLY discovery's 404;
// all auth, execution, events, SQLite and downloads still use the current backend.
// This does not test or claim to fix fixture replay in the default R53 UI mode.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const evidence = {
  backend_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  mode: 'R54_RETAINED_V2_FALLBACK_WITH_SIMULATED_DISCOVERY_404',
  assertions: 'UNCHANGED_R52_BROWSER_SOURCE', discovery_404_count: 0, real_model_calls: 0
};
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    await context.route('**/api/v2/universal/plan', route => {
      evidence.discovery_404_count++;
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Explicit legacy-server discovery fixture', test_fixture: true }) });
    });
    return context;
  };
  return browser;
};
process.on('exit', () => {
  const out = process.env.UI_SHOTS;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'r55-r52-legacy-provenance.json'), JSON.stringify(evidence, null, 2));
  }
  console.log('R52 legacy discovery fixture provenance:', JSON.stringify(evidence));
});
require(path.join(root, 'tests/haloflux-workbench-r52/workbench.e2e.js'));
