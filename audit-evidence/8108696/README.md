# AUD-B8b evidence (reviewed 8108696f22637d284b688af2548603707fa03d57)
Same scripts as audit/c159024-20261112, rerun unchanged on 8108696 (local Node 22, 127.0.0.1 MOCK, no paid calls).
- b8q.cjs (cap CNY 2): old run (created_at moved 40 days back) reworked at USD 0.25 -> 200, /me spent 1.88 (was 0 on c159024); new run USD 0.25 -> 402 (was 202); provider calls started 1 (was 2). Parallel starts still [202, 402].
  Note: the field "approved_total_cny_this_month" in the script output is a fixed constant, not a measurement.
- b8.cjs: back end 403 (POST /api/event 401), owner forced, server prices, tools/ext tools/smoke 403, untested/disabled 409 with 0 calls, isolation 404, delete with runs 409, over cap 402 - identical to c159024.
- tests: B8 + migration/backup 23/23; tests/all.test.js 313/313; reverting lib/project-store.js + lib/users.js to c159024 -> 2 of the new tests FAIL; R57 guard [].
