# AUD-B8c evidence (reviewed e6859a84ad1bb550ecfc1de1e3147dc93f23b8af, branch claude/dev/b8-followup)
Local only (Node 22, 127.0.0.1 MOCK, no paid calls). `node b8c.cjs <checkout>`.
- monthly cap: omitted/null/""/"  " -> 400 cap_required; "abc"/-1/1e9 -> 400 invalid_cap; 0 and "3" -> 201.
- user-visible data (model "SECRET-MODEL-NAME", display "SECRET-DISPLAY", price CNY 1.23/4.56): /api/v2/me, /api/v2/runs/:id and /api/v2/projects/:id still contain modelId, price, connectionId and the base URL origin (me/run also displayName); /api/v2/tasks contains none. Hiding is UI-only (b212d7f touches public/workspace-simple.js only).
- /admin.html?x=<script>... as user -> 403 text/html constant page, input not reflected. Garbage cookie on /workspace.html -> 302 /login.html?...&expired=1 (fixed message, no account information).
- Regression (audit/c159024 + audit/8108696 scripts rerun): parallel [202,402]; old-run rework counted (spent 1.88), new run 402, 1 provider call; back end 403, owner forced, server prices, tools 403, untested/disabled 409 with 0 calls, isolation 404, delete-with-runs 409, over cap 402.
- tests: b8 7/7; tests/all.test.js 313/313; R57 guard []. lib/project-store.js, v2-api.js, access.js, permissions.js, auth.js, budget.js, project-engine.js untouched by the diff.
