# AUD-B5F1 evidence (reviewed f100668694bbf54e5b3631f75deb66529cce705a)

Local run only (Node 22, full clone, MOCK/127.0.0.1, no paid calls):

- `node audit-evidence/f100668/b5probe.cjs <checkout-of-f100668>`: session-kind probe for `/api/v2/tasks`, `/`, `/panel.html`, and resolution of the estimated price ceiling.
  Result: tasks admin 200 / anon 401 / display 403; `/` admin 302->/workspace.html, anon 302->login, display 200 (panel); `/panel.html` display 200, anon 302->login.
  Ceiling: deepseek unlisted -> CNY 18/54, dashscope qwen3.8-plus -> CNY 24/72 (`basis: estimated_ceiling`), unknown platform -> null.
- Mutations on `tests/b5-home.test.js` (4 tests): remove root redirect -> 1 FAIL; CEILING_FACTOR 0.5 -> 2 FAIL; CEILING_FACTOR 1 -> 1 FAIL; unknown platform given a price -> 1 FAIL.
- `node --test tests/all.test.js` -> 297/297/0/0; R57 sources guard violations [] (logic outside the table unchanged).
