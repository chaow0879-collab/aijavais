'use strict';
/* B5-F2 PPT: a real slide deck instead of "model text cut every N lines".
 *  A. strict JSON: { slides: [{ layout, title, subtitle, bullets, left, right, cards, steps, quote, notes }] }
 *  B. fallback: parse the model's Markdown-ish script by "第N页 / ## 第N页 / Slide N" sections and
 *     "标题：/副标题：/要点：" fields; 视觉建议/设计建议/配图/备注/讲稿 go to notes, never onto a slide;
 *     every Markdown marker (#, *, -, `, |, ---) is removed.
 *  C. page count: when the user asked for N pages the deck has exactly N slides (cover included) whenever
 *     the source has at least N pages of content; never cut by line count.
 *  D. layouts: cover / bullets / two-column / cards / timeline / summary, light (default) or dark theme,
 *     Microsoft YaHei with the East Asian font 微软雅黑. Pure functions; no I/O. */
const LAYOUTS = Object.freeze(['cover', 'bullets', 'two-column', 'cards', 'timeline', 'summary']);
const MAX_BULLETS = 6;
const NOTE_LABEL = /^(视觉建议|视觉设计|视觉|设计建议|设计说明|配图建议|配图|图片建议|插图|版式建议|版式|布局建议|布局|排版|动画建议|动画|配色|备注|讲稿|演讲备注|讲者备注|演讲稿|旁白|注释)$/;
const FIELD = /^\s*(?:[-*+•]\s*)?(?:\*\*|__)?\s*(标题|主标题|页面标题|副标题|小标题|要点|核心要点|内容|正文|核心观点|核心信息|金句|结语|总结语|视觉建议|视觉设计|视觉|设计建议|设计说明|配图建议|配图|图片建议|插图|版式建议|版式|布局建议|布局|排版|动画建议|动画|配色|备注|讲稿|演讲备注|讲者备注|演讲稿|旁白|注释)\s*(?:\*\*|__)?\s*[：:]\s*(?:\*\*|__)?\s*(.*)$/;
// AUD-6BBD-01: every pattern below is linear (no "\s*(.*?)\s*$" tails); trailing marks are trimmed in code,
// and lines are capped at MAX_LINE characters / the whole script at MAX_TEXT before any regex runs.
const MAX_LINE = 2000, MAX_TEXT = 200000;
const PAGE_MARK = /^\s{0,8}(?:#{1,6}\s{0,8})?(?:\*\*|__)?\s{0,8}(?:【\s{0,8})?(?:第\s{0,4}([0-9一二三四五六七八九十百]{1,4})\s{0,4}(?:页|张)(?:\s{0,4}幻灯片)?|(?:幻灯片|slide|page|p)\s{0,4}([0-9]{1,4}))\s{0,4}(?:】)?\s{0,4}(?:[：:．.、\-—–|]\s{0,4})?(.*)$/i;
const trimMarks = s => { let a = 0, b = s.length; const skip = c => c === '|' || c === '*' || c === '_' || c === ' ' || c === '\t' || c === '\u3000';
  while (a < b && skip(s[a])) a++; while (b > a && skip(s[b - 1])) b--; return s.slice(a, b); };
/* split over-long lines into MAX_LINE chunks (nothing is dropped below MAX_TEXT) */
function safeLines(text) {
  const out = [];
  for (const line of String(text || '').slice(0, MAX_TEXT).split(/\r?\n/)) { if (line.length <= MAX_LINE) out.push(line); else for (let i = 0; i < line.length; i += MAX_LINE) out.push(line.slice(i, i + MAX_LINE)); }
  return out;
}
const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  return CN[s] || null;
}
/* "做一个……5页" / "五页PPT" / "10 张幻灯片" -> 5 / 5 / 10 (1..30), else null */
function pageCountFrom(text) {
  const m = /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:页|张)(?!面)/.exec(String(text || ''));
  const n = m ? cnNumber(m[1]) : null;
  return n && n >= 1 && n <= 30 ? n : null;
}
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2').replace(/~~(.+?)~~/g, '$1').replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+•·▪●○◦]|\d+[.)、]|[（(]\d+[)）])\s+/, '')
    .replace(/\*\*|__|`|#{2,}/g, '').replace(/\|/g, ' · ').replace(/\s+/g, ' ').replace(/^(?: · )+/, '').replace(/(?: · )+$/, '').trim();
}
const str = (v, max) => { const s = clean(String(v == null ? '' : v).slice(0, Math.max(max * 4, MAX_LINE))); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const list = (v, maxItems, maxLen) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : []).map(x => str(typeof x === 'object' && x ? (x.text || x.title || '') : x, maxLen)).filter(Boolean).slice(0, maxItems);

/* ---------------- A. strict JSON ---------------- */
function strictDeck(input) {
  const slides = Array.isArray(input) ? input : input && Array.isArray(input.slides) ? input.slides : null;
  if (!slides || !slides.length || slides.length > 100) return null;
  const out = [];
  for (const s of slides) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const layout = s.layout == null ? 'bullets' : String(s.layout).toLowerCase().replace(/[_\s]+/g, '-');
    if (!LAYOUTS.includes(layout)) return null;
    const title = str(s.title, 80);
    if (!title) return null;
    const slide = { layout, title, subtitle: str(s.subtitle, 120), bullets: list(s.bullets ?? s.points ?? s.body ?? s.text, 30, 220), notes: list(s.notes, 30, 400).join('\n') };
    if (layout === 'two-column') {
      const side = v => v && typeof v === 'object' && !Array.isArray(v) ? { title: str(v.title || v.heading, 40), bullets: list(v.bullets ?? v.points, 8, 160) } : null;
      slide.left = side(s.left); slide.right = side(s.right);
      if (!slide.left || !slide.right || !slide.left.bullets.length || !slide.right.bullets.length) return null;
    }
    if (layout === 'cards') {
      slide.cards = (Array.isArray(s.cards) ? s.cards : []).map(c => c && typeof c === 'object' ? { title: str(c.title || c.heading, 30), text: str(c.text || c.body || c.desc || c.description, 140) } : null).filter(c => c && c.title).slice(0, 4);
      if (slide.cards.length < 2) return null;
    }
    if (layout === 'timeline') {
      slide.steps = (Array.isArray(s.steps) ? s.steps : Array.isArray(s.cards) ? s.cards : []).map(c => typeof c === 'string' ? { title: str(c, 30), text: '' } : c && typeof c === 'object' ? { title: str(c.title || c.heading || c.name, 30), text: str(c.text || c.body || c.desc, 90) } : null).filter(c => c && c.title).slice(0, 6);
      if (slide.steps.length < 2) return null;
    }
    if (layout === 'summary') slide.quote = str(s.quote || s.subtitle || slide.bullets[0] || '', 120);
    if (layout === 'bullets' && !slide.bullets.length && !slide.subtitle) return null;
    out.push(slide);
  }
  return { slides: out, source: 'json' };
}

/* ---------------- B. fallback parse of the model's script ---------------- */
function sectionsOf(text) {
  const lines = safeLines(text);
  const marks = lines.map((l, i) => ({ i, m: l.length <= 120 ? PAGE_MARK.exec(l) : null })).filter(x => x.m && x.m[0].trim().length <= 70).map(x => (x.m[3] = trimMarks(x.m[3] || ''), x));
  if (marks.length >= 2) {
    const pre = lines.slice(0, marks[0].i);
    return { pre, sections: marks.map((x, k) => ({ heading: x.m[3] || '', body: lines.slice(x.i + 1, k + 1 < marks.length ? marks[k + 1].i : lines.length) })) };
  }
  const heads = lines.map((l, i) => ({ i, m: /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l) })).filter(x => x.m);
  if (heads.length >= 2) {
    const counts = {}; for (const h of heads) counts[h.m[1].length] = (counts[h.m[1].length] || 0) + 1;
    const levels = Object.keys(counts).map(Number).sort((a, b) => a - b), level = levels.find(l => counts[l] >= 2) || levels[0];
    const at = heads.filter(h => h.m[1].length === level);
    return { pre: lines.slice(0, at[0].i), sections: at.map((x, k) => ({ heading: x.m[2], body: lines.slice(x.i + 1, k + 1 < at.length ? at[k + 1].i : lines.length) })) };
  }
  return { pre: [], sections: [{ heading: '', body: lines }] };
}
function parseSection(sec) {
  const s = { heading: clean(sec.heading), title: '', subtitle: '', quote: '', items: [], groups: [], notes: [] };
  let mode = 'items', group = null, fence = false;
  for (const raw of sec.body) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (!raw.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw) || /^\s*\|?\s*:?-{2,}/.test(raw)) continue;
    const f = FIELD.exec(raw);
    if (f) {
      const label = f[1], value = clean(f[2]);
      if (NOTE_LABEL.test(label)) { mode = 'notes'; if (value) s.notes.push(value); continue; }
      mode = 'items';
      if (/^(标题|主标题|页面标题)$/.test(label)) { if (value) s.title = value; continue; }
      if (/^(副标题|小标题)$/.test(label)) { if (value) s.subtitle = value; continue; }
      if (/^(金句|结语|总结语)$/.test(label)) { if (value) s.quote = value; continue; }
      if (value) (group ? group.items : s.items).push({ text: value, level: 1 });
      continue;
    }
    // a bold line that only names a note section, e.g. "**视觉建议**" or "视觉建议："
    const bare = clean(raw).replace(/[：:]$/, '');
    if (NOTE_LABEL.test(bare)) { mode = 'notes'; continue; }
    if (mode === 'notes') { const t = clean(raw); if (t) s.notes.push(t); continue; }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (h) { group = { title: clean(h[1]), items: [] }; s.groups.push(group); continue; }
    const t = clean(raw); if (!t || fence && !t) continue;
    const level = /^(\s{2,}|\t)/.test(raw) ? 2 : 1;
    (group ? group.items : s.items).push({ text: t, level });
  }
  return s;
}
const ORDINAL = /^(?:第[一二三四五六七八九十0-9]+(?:步|阶段|级|层)|阶段[一二三四五六七八九十0-9]|步骤[一二三四五六七八九十0-9]|step\s*\d|[①②③④⑤⑥])/i;
function inferSlide(s, index, total, deckTitle) {
  const items = s.items.filter(x => x.level === 1).map(x => x.text);
  let title = s.title || s.heading.replace(/^(封面|标题页|首页)$/, '') || '';
  if (index === 0 && (/封面|标题页|首页/.test(s.heading) || !s.heading && total > 1)) {
    return { layout: 'cover', title: str(title || deckTitle, 80), subtitle: str(s.subtitle || items[0] || '', 120), bullets: [], notes: s.notes.join('\n') };
  }
  title = str(title || deckTitle, 80);
  const base = { title, subtitle: str(s.subtitle, 120), notes: s.notes.join('\n') };
  if (s.groups.length === 2 && s.groups.every(g => g.items.length)) {
    return { ...base, layout: 'two-column', bullets: [], left: { title: str(s.groups[0].title, 40), bullets: s.groups[0].items.map(x => str(x.text, 160)).slice(0, 8) }, right: { title: str(s.groups[1].title, 40), bullets: s.groups[1].items.map(x => str(x.text, 160)).slice(0, 8) } };
  }
  const all = [...items, ...s.groups.flatMap(g => [g.title, ...g.items.map(x => x.text)])].filter(Boolean);
  if (index === total - 1 && total > 2 && /总结|结语|小结|谢谢|致谢|结束|展望|Q\s*&\s*A|行动/.test(title)) {
    return { ...base, layout: 'summary', quote: str(s.quote || s.subtitle || all[0] || title, 120), bullets: (s.quote || s.subtitle ? all : all.slice(1)).map(x => str(x, 160)).slice(0, 4) };
  }
  if (all.length >= 3 && all.length <= 6 && all.filter(x => ORDINAL.test(x) || /→/.test(x)).length >= Math.min(3, all.length)) {
    return { ...base, layout: 'timeline', bullets: [], steps: all.map(x => { const [a, ...b] = x.split(/[：:]/); return { title: str(b.length ? a : x, 30), text: str(b.join('：'), 90) }; }) };
  }
  const pairs = all.map(x => /^([^：:]{2,14})[：:]\s*(.+)$/.exec(x));
  if (all.length >= 3 && all.length <= 4 && pairs.every(Boolean)) {
    return { ...base, layout: 'cards', bullets: [], cards: pairs.map(m => ({ title: str(m[1], 30), text: str(m[2], 140) })) };
  }
  return { ...base, layout: 'bullets', bullets: all.map(x => str(x, 220)) }; // never drop points: fitPages splits at 6
}
function fallbackDeck(text, deckTitle, extra = []) {
  const { pre, sections } = sectionsOf(text);
  const parsed = sections.map(parseSection);
  // a leading "# 主标题" before the first page becomes the cover title when the first page has none
  const preTitle = pre.map(l => /^\s{0,3}#{1,6}\s+(.*)$/.exec(l)).filter(Boolean).map(m => clean(m[1]))[0];
  if (preTitle && parsed[0] && !parsed[0].title) parsed[0].title = preTitle;
  let slides = parsed.map((s, i) => inferSlide(s, i, parsed.length, deckTitle)).filter(s => s.layout !== 'bullets' || s.bullets.length || s.subtitle);
  // structured sections (title + text) each become their own slide after the script
  for (const sec of extra) { const p = parseSection({ heading: sec.heading, body: safeLines(sec.text) }); const sl = inferSlide(p, 1, 0, deckTitle); if (sl.layout !== 'bullets' || sl.bullets.length) slides.push(sl); }
  if (!slides.length || slides[0].layout !== 'cover') slides.unshift({ layout: 'cover', title: str(deckTitle, 80), subtitle: str(preTitle && preTitle !== deckTitle ? preTitle : '', 120), bullets: [], notes: '' });
  return { slides, source: 'text' };
}

/* ---------------- C. page count ---------------- */
function fitPages(deck, pageCount) {
  let slides = deck.slides;
  if (pageCount) {
    if (slides.length > pageCount) slides = slides.slice(0, pageCount); // the model planned the pages: keep its first N
    return { ...deck, slides, pageCount };
  }
  // no count asked: never more than 6 bullets on a slide
  const out = [];
  for (const s of slides) {
    if (s.layout !== 'bullets' || s.bullets.length <= MAX_BULLETS) { out.push(s); continue; }
    for (let i = 0; i < s.bullets.length; i += MAX_BULLETS) out.push({ ...s, title: i ? s.title + '（续）' : s.title, bullets: s.bullets.slice(i, i + MAX_BULLETS) });
  }
  return { ...deck, slides: out.slice(0, 100) };
}
/* options.slides (JSON) -> strict, else lenient {title, bullets} slides from older callers, else text */
function buildDeck({ title, text = '', sections = [], slides, pageCount, theme } = {}) {
  const arr = Array.isArray(slides) ? slides : slides && Array.isArray(slides.slides) ? slides.slides : null;
  // strict A only when the producer used the layout contract; older {title, bullets} callers take the legacy path
  let deck = arr && arr.some(s => s && typeof s === 'object' && s.layout != null) ? strictDeck(arr) : null;
  if (!deck && slides !== undefined && Array.isArray(slides) && slides.length) {
    // legacy structured input ({ title, bullets, body }) keeps working; a cover is added in front
    deck = { slides: [{ layout: 'cover', title: str(title, 80), subtitle: '', bullets: [] }, ...slides.filter(s => s && typeof s === 'object').map(s => ({ layout: 'bullets', title: str(s.title, 80) || str(title, 80), subtitle: '', bullets: [...list(s.body ?? s.text, 12, 220), ...list(s.bullets, 30, 220)] }))], source: 'legacy' };
  }
  if (!deck) {
    let source = String(text || '');
    // a JSON answer that failed strict validation: read its titles and points, never show braces
    try { const j = JSON.parse(source.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')); if (j && Array.isArray(j.slides)) source = j.slides.map((s, i) => `第${i + 1}页：${s && s.title || ''}\n${[...(s && Array.isArray(s.bullets) ? s.bullets : [])].map(b => '- ' + b).join('\n')}`).join('\n'); } catch { /* text */ }
    deck = fallbackDeck(source, title, sections);
  }
  if (deck.slides[0] && deck.slides[0].layout === 'cover' && !deck.slides[0].title) deck.slides[0].title = str(title, 80);
  return { ...fitPages(deck, pageCount), theme: theme === 'dark' ? 'dark' : 'light', title: str(title, 80) };
}

/* ---------------- D. rendering ---------------- */
const THEMES = {
  light: { bg: 'FFFFFF', ink: '1F2937', title: '1F3864', accent: '2E75B6', accent2: 'F2A541', soft: 'F1F5FA', card: 'FFFFFF', muted: '6B7280', rule: 'E3E8EF', band: '1F3864', bandInk: 'FFFFFF', bandSoft: 'A9C4E8' },
  dark: { bg: '0F1C2E', ink: 'E6EDF5', title: 'FFFFFF', accent: '4FB3FF', accent2: 'F2A541', soft: '18293F', card: '1B2E46', muted: '9FB0C3', rule: '2A3F58', band: '0A1424', bandInk: 'FFFFFF', bandSoft: '7FA7D6' },
};
const W = 12192000, H = 6858000, M = 685800;
function render(deck, esc) {
  const T = THEMES[deck.theme] || THEMES.light, total = deck.slides.length;
  let nid = 1;
  const run = (text, { sz = 1800, b = false, color = T.ink } = {}) => `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${sz}"${b ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="微软雅黑"/><a:cs typeface="Microsoft YaHei"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
  const para = (text, o = {}) => {
    const bullet = o.bullet ? `<a:buClr><a:srgbClr val="${o.bulletColor || T.accent}"/></a:buClr><a:buSzPct val="100000"/><a:buFont typeface="Arial"/><a:buChar char="${o.bullet}"/>` : '<a:buNone/>';
    const indent = o.bullet ? ` marL="${o.marL || 342900}" indent="-${o.indent || 285750}"` : '';
    return `<a:p><a:pPr algn="${o.align || 'l'}"${indent}><a:lnSpc><a:spcPct val="${o.lnSpc || 115000}"/></a:lnSpc><a:spcBef><a:spcPts val="${o.spcBef ?? 600}"/></a:spcBef>${bullet}</a:pPr>${run(text, o)}<a:endParaRPr lang="zh-CN" sz="${o.sz || 1800}"/></a:p>`;
  };
  const shape = (x, y, w, h, { geom = 'rect', fill = null, line = null, paras = null, anchor = 't', inset = 0, autofit = false, name = 'Shape' } = {}) => {
    const id = ++nid;
    const sp = `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>'}${line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>'}</p:spPr>`;
    const tx = paras ? `<p:txBody><a:bodyPr wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" anchor="${anchor}">${autofit ? '<a:normAutofit/>' : ''}</a:bodyPr><a:lstStyle/>${paras.join('')}</p:txBody>` : '';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id}"/><p:cNvSpPr${paras && !fill && !line ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>${sp}${tx}</p:sp>`;
  };
  const header = (s) => shape(M, 420000, W - 2 * M, 760000, { paras: [para(s.title, { sz: 2800, b: true, color: T.title, spcBef: 0, lnSpc: 100000 })], anchor: 'b', name: 'Title' })
    + shape(M, 1240000, 640000, 54864, { fill: T.accent, name: 'Accent' })
    + (s.subtitle ? shape(M, 1340000, W - 2 * M, 420000, { paras: [para(s.subtitle, { sz: 1500, color: T.muted, spcBef: 0 })], name: 'Subtitle' }) : '');
  const footer = (i) => shape(M, 6330000, W - 2 * M, 9144, { fill: T.rule, name: 'Rule' })
    + shape(M, 6390000, 8000000, 300000, { paras: [para(deck.title, { sz: 1000, color: T.muted, spcBef: 0 })], name: 'Footer' })
    + shape(W - M - 1500000, 6390000, 1500000, 300000, { paras: [para(`${i + 1} / ${total}`, { sz: 1000, color: T.muted, spcBef: 0, align: 'r' })], name: 'Page' });
  const top = s => s.subtitle ? 1900000 : 1560000;
  const bulletParas = (items, sz = 2000) => items.map(t => para(t, { sz, bullet: '●', bulletColor: T.accent, spcBef: 900, marL: 365760, indent: 274320 }));
  const body = {
    cover: s => shape(0, 0, 4300000, H, { fill: T.band, name: 'Band' }) + shape(4300000, 0, 120000, H, { fill: T.accent, name: 'Accent' })
      + shape(M, 560000, 3200000, 400000, { paras: [para('AIJAVAIS', { sz: 1400, b: true, color: T.bandSoft, spcBef: 0 })], name: 'Brand' })
      + shape(M, H - 1100000, 3200000, 400000, { paras: [para(deck.date, { sz: 1400, color: T.bandSoft, spcBef: 0 })], name: 'Date' })
      + shape(4950000, 1700000, W - 4950000 - M, 2100000, { paras: [para(s.title, { sz: 4000, b: true, color: T.title, spcBef: 0, lnSpc: 105000 })], anchor: 'b', autofit: true, name: 'Title' })
      + shape(4950000, 3950000, 900000, 64008, { fill: T.accent2, name: 'Accent' })
      + (s.subtitle ? shape(4950000, 4150000, W - 4950000 - M, 1200000, { paras: [para(s.subtitle, { sz: 2000, color: T.muted, spcBef: 0 })], autofit: true, name: 'Subtitle' }) : ''),
    bullets: s => header(s) + shape(M, top(s) + 120000, W - 2 * M, 6150000 - top(s) - 120000, { paras: bulletParas(s.bullets, s.bullets.length > MAX_BULLETS ? 1800 : s.bullets.length <= 4 ? 2400 : 2200).map(x => x.replace('<a:spcPts val="900"/>', '<a:spcPts val="1400"/>')), autofit: true, name: 'Body' }),
    'two-column': s => {
      const y = top(s) + 160000, rows = Math.max(s.left.bullets.length, s.right.bullets.length), h = Math.min(6100000 - y, 1150000 + rows * 640000), w = (W - 2 * M - 300000) / 2;
      return header(s) + [s.left, s.right].map((c, k) => { const x = M + k * (w + 300000);
        return shape(x, y, w, h, { geom: 'roundRect', fill: T.soft, name: 'Panel' }) + shape(x, y, w, 80000, { fill: k ? T.accent2 : T.accent, name: 'Strip' })
          + shape(x + 320000, y + 300000, w - 640000, h - 450000, { paras: [para(c.title || (k ? '右' : '左'), { sz: 2400, b: true, color: k ? T.title : T.accent, spcBef: 0 }), ...c.bullets.map(t => para(t, { sz: 1900, bullet: '●', bulletColor: k ? T.accent2 : T.accent, spcBef: 1200, marL: 320040, indent: 251460 }))], autofit: true, name: 'Column' }); }).join('');
    },
    cards: s => {
      const n = s.cards.length, gap = 300000, avail = 6050000 - top(s), h = Math.min(avail - 200000, 3400000), y = top(s) + (avail - h) / 2, w = (W - 2 * M - gap * (n - 1)) / n;
      return header(s) + s.cards.map((c, k) => { const x = M + k * (w + gap);
        return shape(x, y, w, h, { geom: 'roundRect', fill: T.soft, name: 'Card' }) + shape(x, y + 300000, 70000, 700000, { fill: k % 2 ? T.accent2 : T.accent, name: 'Mark' }) + shape(x + 320000, y + 320000, 640000, 640000, { geom: 'ellipse', fill: k % 2 ? T.accent2 : T.accent, paras: [para(String(k + 1), { sz: 2000, b: true, color: 'FFFFFF', align: 'ctr', spcBef: 0 })], anchor: 'ctr', name: 'Badge' })
          + shape(x + 320000, y + 1160000, w - 640000, h - 1360000, { paras: [para(c.title, { sz: 2400, b: true, color: T.title, spcBef: 0 }), ...(c.text ? [para(c.text, { sz: 1800, color: T.ink, spcBef: 1000, lnSpc: 130000 })] : [])], autofit: true, name: 'CardText' }); }).join('');
    },
    timeline: s => {
      const n = s.steps.length, lineY = top(s) + (6050000 - top(s)) * 0.36, step = (W - 2 * M) / n;
      return header(s) + shape(M + step / 2, lineY - 19050, step * (n - 1), 38100, { fill: T.rule, name: 'Line' }) + s.steps.map((c, k) => { const cx = M + step * k + step / 2;
        return shape(cx - 330000, lineY - 330000, 660000, 660000, { geom: 'ellipse', fill: k === n - 1 ? T.accent2 : T.accent, paras: [para(String(k + 1), { sz: 2000, b: true, color: 'FFFFFF', align: 'ctr', spcBef: 0 })], anchor: 'ctr', name: 'Step' })
          + shape(cx - step / 2 + 100000, lineY + 520000, step - 200000, 2200000, { paras: [para(c.title, { sz: 2200, b: true, color: T.title, align: 'ctr', spcBef: 0 }), ...(c.text ? [para(c.text, { sz: 1700, color: T.ink, align: 'ctr', spcBef: 900, lnSpc: 125000 })] : [])], autofit: true, name: 'StepText' }); }).join('');
    },
    summary: s => shape(0, 0, W, H, { fill: T.band, name: 'Band' }) + shape(M, 900000, 640000, 54864, { fill: T.accent2, name: 'Accent' })
      + shape(M, 1000000, W - 2 * M, 600000, { paras: [para(s.title, { sz: 2200, b: true, color: T.bandSoft, spcBef: 0 })], name: 'Title' })
      + shape(M, 1800000, W - 2 * M, 2100000, { paras: [para(s.quote || s.title, { sz: 3600, b: true, color: T.bandInk, spcBef: 0, lnSpc: 110000 })], anchor: 'ctr', autofit: true, name: 'Quote' })
      + (s.bullets.length ? shape(M, 4150000, W - 2 * M, 1900000, { paras: s.bullets.slice(0, 4).map(t => para(t, { sz: 2000, color: T.bandSoft, bullet: '●', bulletColor: T.accent2, spcBef: 900 })), autofit: true, name: 'Points' }) : ''),
  };
  return deck.slides.map((s, i) => {
    nid = 1;
    const dark = s.layout === 'summary' || s.layout === 'cover' && deck.theme === 'dark';
    const bg = s.layout === 'summary' ? T.band : T.bg;
    const shapes = (body[s.layout] || body.bullets)(s) + (s.layout === 'cover' || s.layout === 'summary' ? '' : footer(i));
    return { xml: shapes, bg, dark };
  });
}
/* QA-F2-1: a deck with no real content (only a cover, or an apology in place of pages) is not a deliverable */
const APOLOGY = /抱歉|对不起|无法(?:完成|生成|提供|满足)|作为(?:一个)?\s*(?:AI|人工智能|语言模型)|I'?m sorry|I cannot|I can'?t|unable to/i;
function assess(deck, text = '') {
  const content = deck.slides.filter(s => s.layout !== 'cover');
  const filled = content.filter(s => (s.bullets && s.bullets.length) || (s.cards && s.cards.length) || (s.steps && s.steps.length) || (s.left && s.right) || s.quote);
  if (!filled.length) return { usable: false, reason: '只有封面，没有内容页' };
  if (deck.source !== 'json' && filled.length < 2 && APOLOGY.test(String(text).slice(0, 4000))) return { usable: false, reason: '模型没有给出演示稿内容（回复的是道歉或说明）' };
  return { usable: true, reason: '' };
}
module.exports = { assess, LAYOUTS, MAX_BULLETS, pageCountFrom, clean, strictDeck, fallbackDeck, fitPages, buildDeck, render, THEMES };
