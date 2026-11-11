# tools/relay — frozen relay line (R43–R57)

Moved here in C1 (2026-11-11). This is the GitHub-based multi-AI relay machinery (agent executor and
scheduler, pilots, handoff, trusted trigger, unattended GO gate and the R57 source guard). It is **frozen**:
no new features, only proven blocking defects are fixed (CLAUDE.md: stop expanding Runner/scheduler).

- Frozen reference: branch `claude/relay-r57-final` = `7e0987d` (the last commit before the move; the proxy
  refused a tag push, so a branch holds the ref). Relay workflows under `.github/workflows/` are manual
  (`workflow_dispatch`) only and are meant to be dispatched at that ref.
- In this tree the relay unit/E3 suites still run from their new location: `npm run test:relay`.
  Provenance checks that compare paths or blobs to historical commits (R57 `sources.js`, frozen R52/R56
  runners, R48 source runner, author-branch `scope:` tests) only hold on the frozen ref.
- The R57 source guard (`unattended-go-r57/sources.js`) no longer governs product code. Product changes
  are gated by `.github/workflows/product.yml` (`npm test` + `npm run test:product:ui`).
- `tests/` here holds the relay tests; product tests stay in the repository `tests/` folder.
- Product code (`server.js`, `lib/`, `public/`) must not require anything under `tools/relay/`.
