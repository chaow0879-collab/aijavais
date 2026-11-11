# B5-F2 evidence (generated from claude/dev/b5-f2 @ 6bbd5b5)

- `ppt-owner-fixture-before-sheet.png`: the previous exporter (main 1dba695) on `tests/fixtures/ppt/owner-5-pages-script.md`
  (6 dark slides, request text as every title, `#`/`**`/`---`/视觉建议 on the slides).
- `ppt-owner-fixture-after-sheet.png`, `hi-owner-fallback-1..5.png`, `owner-fallback.pptx`: same script, new exporter
  (fallback B, page count 5 from "5页"): cover / cards / cards / timeline / summary.
- `ppt-json-layouts-*-sheet.png`, `hi-json-layouts-1..5.png`, `json-layouts.pptx`: strict slide JSON (A) with
  cover / two-column / bullets / timeline / summary, light (default) and dark themes.
- Rendering: LibreOffice `soffice --headless --convert-to pdf` then `pdftoppm`; Chinese glyphs come from the
  machine's fallback font (WenQuanYi) because Microsoft YaHei is not installed here; on Windows/Office the
  deck uses 微软雅黑.
- `F-home-before.png` / `F-home-after.png`, `G-topbar-before.png` / `G-topbar-after.png`: my-tasks home with the
  live card, and the top-bar ＋ 新建任务 before (solid green block) and after (right side, outline).
All local MOCK models; no paid call.
