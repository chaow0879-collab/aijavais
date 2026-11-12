# AUD-B8 evidence (reviewed c159024e1fc7ef3024dbbd2a45f5c510b6674e54, branch claude/dev/b8-split)
Local only (Node 22, full clone, 127.0.0.1 MOCK provider, no paid calls). `node <script> <checkout-of-c159024>`.

b8.cjs (isolation / prices / tools / models):
- user -> GET/POST /api/models, /api/settings, /api/models/discover, /api/auth/display-link, /api/auth/sessions, /api/v2/users, /api/v2/tools, /api/v2/skills, /api/v2/usage/system/exceptions, /admin.html, /capabilities.js, /project-intake.html: all 403; POST /api/event 401.
- POST /api/v2/projects with ownerId of another user -> owner forced to the caller.
- run with prices {0.000001} -> run.approval.prices = server price (CNY 100000/M / 7.5 = USD 13333.33/M).
- allowedTools / approveExternalTools / delivery-check smokeTest -> 403. /me lists only the tested+enabled model; untested or disabled connection -> 409, 0 provider calls.
- user B on user A's project/run/deck/cancel/put/delete -> 404; B's lists empty. Delete of a project with runs -> 409.

b8q.cjs (monthly cap, cap CNY 2, cheap model, MOCK delayed 3 s so runs stay active):
- two parallel starts of CNY 1.5 each -> [202, 402] (serialised per user).
- BYPASS: a review_required run whose created_at is moved to last month (SQLite UPDATE) -> /me shows spent 0; rework of that run approved at USD 0.25 (CNY 1.875) -> 200, /me still spent 0; then a new run at USD 0.25 -> 202. Two active rounds approved CNY 3.75 in one month against a CNY 2 cap; 2 provider calls started.

Other: future schema (user_version 6) refused ("Database schema is newer than this application"); B8 + migration/backup tests 21/21; tests/all.test.js 311/311; R57 guard []; display session: /api/v2/tasks 403, / and /panel.html 200.
