'use strict';
// AUD-BC72-06 re-verification: run the R52 "E3_FAKE real server" workbench test UNMODIFIED in the reviewed
// tree (no auditor patch any more), alone and as part of the full file with only the author-branch `scope:`
// assertion skipped (as the author CI now does). Counts come from TAP; reviewed source is never modified.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const R = path.resolve(process.env.REVIEWED_ROOT), OUT = process.env.AUDIT_OUT || '.';
const T = 'tests/haloflux-workbench-r52/workbench.test.js';
const tap = r => ({ exit: r.status, tests: +(/# tests (\d+)/.exec(r.stdout) || [])[1], pass: +(/# pass (\d+)/.exec(r.stdout) || [])[1], fail: +(/# fail (\d+)/.exec(r.stdout) || [])[1], skipped: +(/# skipped (\d+)/.exec(r.stdout) || [])[1], e3_ok: /^ok \d+ - E3_FAKE real server/m.test(r.stdout), e3_skipped: /^ok \d+ - E3_FAKE real server.*# SKIP/m.test(r.stdout), errors: (r.stdout.match(/^\s+error: .*$/mg) || []).slice(0, 5) });
const runIn = (cwd, extra = []) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...extra, T], { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 16 << 20 });
const res = {};
res.only_e3_unmodified = tap(runIn(R, ['--test-name-pattern=E3_FAKE real server']));
res.full_file_unmodified = tap(runIn(R));
res.author_ci_skip_scope_only = tap(runIn(R, ['--test-skip-pattern=scope:']));
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'e3-real-server.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
const ok = res.only_e3_unmodified.exit === 0 && res.only_e3_unmodified.pass >= 1 && res.only_e3_unmodified.e3_ok && !res.only_e3_unmodified.e3_skipped
  && res.author_ci_skip_scope_only.exit === 0 && res.author_ci_skip_scope_only.fail === 0 && res.author_ci_skip_scope_only.e3_ok;
process.exitCode = ok ? 0 : 1;
