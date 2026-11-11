'use strict';
// Frozen relay provenance check split out of tests/haloflux-workbench-r52/workbench.test.js (C1).
// It asserts the R52 author branch scope against the R44 base and only holds on the frozen ref claude/relay-r57-final.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..', '..', '..', '..');
test('scope: R52 only writes Claude-owned paths; R44 base paths elsewhere are byte-identical', () => {
  let changed;
  try { changed = execFileSync('git', ['diff', '--name-only', '4c198c430806836bb289cd5da57b7fad44c7b0dc', '--', '.'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean); }
  catch (e) { return assert.fail('git history with the R44 base is required: ' + e.message); }
  let untracked = [];
  try { untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { untracked = []; }
  const allowed = [/^public\/project-intake\.html$/, /^public\/project-intake\//, /^public\/haloflux-workbench-r52\//, /^tests\/claude-universal-intake\.test\.js$/, /^tests\/ui\/claude-universal-intake\.e2e\.js$/,
    /^tests\/haloflux-workbench-r52\//, /^docs\/UNIVERSAL-WORKBENCH-R52\.md$/, /^\.github\/workflows\/claude-r52-workbench\.yml$/,
    // R54 (#37) Claude-owned additions on the same frontend lane.
    /^tests\/haloflux-workbench-r54\//, /^docs\/UNIVERSAL-WORKBENCH-R54\.md$/, /^\.github\/workflows\/claude-r54-workbench\.yml$/];
  for (const f of [...changed, ...untracked]) assert.ok(allowed.some(re => re.test(f)), 'R52 must not write ' + f);
  for (const f of ['server.js', 'lib', 'public/panel.html', 'public/workspace.js', 'tools']) assert.ok(!changed.some(c => c === f || c.startsWith(f + '/')), f + ' untouched');
});
