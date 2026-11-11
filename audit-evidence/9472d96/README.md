# AUD-B5F3 evidence (reviewed 9472d96c8121273eda5091dfad8aaa2b826ae1f0)
Local only (Node 22, full clone, 127.0.0.1 MOCK, no paid calls).
- f2c.cjs rerun: all 200k-char hostile lines <= 39 ms, export 38 ms, apology -> pptx_unusable 422.
- Sentence paging: one paragraph of 2000 sentences -> 668 slides in 7 ms (no 100-page cap on this path; PPTX export then throws "幻灯片数量必须在1–100页之间"); with pageCount 5 -> exactly 5 slides + notice; pageCount 1e9 -> bounded by sentences; 200k-char paragraph is chunked into >2 items and not treated as unstructured (18 slides, 4 ms).
- deck.cjs: /api/v2/runs/:id/deck admin 200 / anon 401 / display 403 / unknown 404; no note or text leak.
- tests: slides+deliverables+b5-home 23/23; tests/all.test.js 306/306; sources guard [] (logic unchanged). adjust()/go() untouched by the diff.
