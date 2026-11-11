# AUD-B5F2b evidence (reviewed 6bbd5b569e8615f9e3a32ee5740c23545579e0a4)
Local only (Node 22, full clone, no network, no paid calls). `node <script> <checkout> [out.pptx]`.
- pptprobe.cjs: timing + injection. Quadratic regex: "第1页"+N spaces+"x" -> N=10k 167 ms, 20k 611 ms, 50k 4.1 s, 200k 64 s; "- **标题"+200k spaces 16 s.
- inj.cjs: XML/entity/pic injection in title, page text, bullets and notes -> all parts well-formed (minidom), no raw <p:pic>/<!ENTITY>/External rel, text escaped, notes never on a slide; control chars rejected.
- Mutations on tests/slides.test.js + tests/deliverables.test.js (13 tests): no escape -> 2 FAIL; notes on slide -> 2 FAIL; no page cut -> 1 FAIL; no layout whitelist -> 1 FAIL.
- tests/all.test.js 302/302/0/0; R57 sources guard violations [].
- Author CI 43055748141 attempt1 browser job: 13x "Temporary failure resolving 'azure.archive.ubuntu.com'" -> playwright browser missing -> all browser steps failed (infrastructure, not code).
