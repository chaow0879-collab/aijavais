'use strict';
// Runs Codex's OWN R53 suites (tests/universal-workflow-r53, read-only at 397b46c) inside the overlay
// that carries the R54 frontend files. R53's backend imports public/haloflux-workbench-r52/contract.js
// and its interop tests use the projector, so this proves the R54 changes keep that contract intact.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { materialize } = require('./overlay.cjs');
const o = materialize();
const files = fs.readdirSync(path.join(o.dir, 'tests', 'universal-workflow-r53')).filter(n => n.endsWith('.test.js')).map(n => path.join('tests', 'universal-workflow-r53', n));
console.log('R53 base', o.r53, '| overlay changes vs R53:', JSON.stringify(o.changedVsR53));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: o.dir, encoding: 'utf8', timeout: 600000, env: { ...process.env } });
const out = (r.stdout || '') + (r.stderr || '');
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(k => [k, Number((out.match(new RegExp('ℹ ' + k + ' (\\d+)')) || [])[1])]));
console.log('R53 suites with R54 frontend:', JSON.stringify(counts));
if (process.env.R54_OUT) fs.writeFileSync(path.join(process.env.R54_OUT, 'r53-compat.json'), JSON.stringify({ r53: o.r53, changedVsR53: o.changedVsR53, counts, status: r.status }, null, 2));
if (r.status !== 0 || !counts.tests || counts.fail) { console.error(out.split('\n').filter(l => /✖|Error|expected|actual/.test(l)).slice(0, 40).join('\n')); process.exitCode = 1; }
