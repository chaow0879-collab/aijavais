# AUD-C1a evidence: claude/dev/c1-consolidate-v2 @ 0c184e9 (base e6859a8)

- Product code diff (lib/ server.js public/ catalog/ package.json .github/): none.
- CLAUDE.md / README.md / tools/backup-inventory.js: identical to base after normalising `docs/*.md` link targets.
- Doc merge, line containment (heading level and link target normalised): 9 removed docs, 448 non-empty lines; 446 found verbatim.
  The 2 others differ only in link target (FEATURE-STATUS "详见…", AI-DRAFT "状态机及迁移见…").
  Pre-existing lines of target docs: 7 changed, all link-target only, except one TESTING.md line that gains an additive C1 note.
- npm test local (Node 22.23.4, exact SHA): 372 tests / 372 pass / 0 fail / 0 skip.
  Baseline was 313, plus the 10 newly required suites run standalone (59) = 372. No duplicate requires.
  tests/ diff: only tests/all.test.js (+7).
- CI 43223599405 (head 0c184e9, success; jobs handoff/automation/browser/container/tests).
  npm test: 372 tests, 370 pass, 2 env skips (code-exec namespace, M1 isolate), both pre-existing tests.
- R57 source guard on the exact SHA: violations=[]. The sources.js diff touches only the POST_R57 table lines.
