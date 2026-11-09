'use strict';
// Independently reproduce the "E3_FAKE real server" workbench test that the author CI skips via
// --test-skip-pattern, (1) unmodified in the integrated reviewed tree, and (2) in a throw-away copy whose
// ONLY change is the historical R52 shutdown assertion (lines asserting "no run_cancelled event" and the
// derived v2-status event), replaced by the integrated semantics. Reviewed source is never modified.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync, spawnSync } = require('node:child_process');
const R = path.resolve(process.env.REVIEWED_ROOT), OUT = process.env.AUDIT_OUT || '.';
const T = 'tests/haloflux-workbench-r52/workbench.test.js';
const tap = r => ({ exit: r.status, tests: +(/# tests (\d+)/.exec(r.stdout) || [])[1], pass: +(/# pass (\d+)/.exec(r.stdout) || [])[1], fail: +(/# fail (\d+)/.exec(r.stdout) || [])[1], skipped: +(/# skipped (\d+)/.exec(r.stdout) || [])[1], errors: (r.stdout.match(/^\s+error: .*$/mg) || []).slice(0, 5) });
const runIn = (cwd, extra = []) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...extra, T], { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 16 << 20 });
const res = {};
res.original_only_e3 = tap(runIn(R, ['--test-name-pattern=E3_FAKE real server']));
res.original_full_file = tap(runIn(R));
res.author_ci_skip = tap(runIn(R, ['--test-skip-pattern=scope:|E3_FAKE real server:']));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-e3-'));
execFileSync('git', ['clone', '-q', '--no-hardlinks', R, dir]); execFileSync('git', ['checkout', '-q', '--detach', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: R, encoding: 'utf8' }).trim()], { cwd: dir });
const f = path.join(dir, T); let src = fs.readFileSync(f, 'utf8');
const a = "assert.ok(!shut.events.some(e => e.eventType === 'run_cancelled'), 'server recorded no cancel event');";
const b = /  const ds = C\.fromV2Run\(shut\);[\s\S]*?evidence\.e3\.faults = [^\n]*\n/;
if (!src.includes(a) || !b.test(src)) throw Error('PATCH_ANCHOR_NOT_FOUND');
src = src.replace(a, "assert.ok(shut.events.some(e => e.eventType === 'run_cancelled'), 'AUDIT: integrated server records shutdown run_cancelled');")
  .replace(b, "  { const jd = J.createProjector({}); jd.ingest(C.fromV2Run(shut).events); assert.equal(jd.state().phase, 'cancelled'); assert.equal(jd.state().busy, false); }\n");
fs.writeFileSync(f, src);
res.audit_patched_integrated_semantics = tap(runIn(dir, ['--test-name-pattern=E3_FAKE real server']));
res.patch_diff = execFileSync('git', ['diff', '--stat'], { cwd: dir, encoding: 'utf8' });
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'e3-real-server.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
