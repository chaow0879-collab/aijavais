'use strict';
// B5-F2 A–E: PPT deck from strict slide JSON, or from the model's page script; exact page count;
// no Markdown or designer notes on slides; every layout rendered. Fixture: tests/fixtures/ppt/owner-5-pages-script.md
// is built from the owner's online report (same problems: "第N页", 标题/要点 fields, **视觉建议**, ---, #).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../lib/slides');
const { createDeliverable } = require('../lib/deliverables');
const GOAL = '做一个任职资格体系的概念介绍，5页，最美观达成';
const SCRIPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'ppt', 'owner-5-pages-script.md'), 'utf8');
function slidesText(buffer) {
  // read slide XML straight out of the STORE zip: text runs only
  const out = []; let at = 0;
  while ((at = buffer.indexOf(Buffer.from('ppt/slides/slide'), at)) !== -1) {
    const nameEnd = buffer.indexOf(Buffer.from('.xml'), at); const name = buffer.subarray(at, nameEnd + 4).toString();
    at = nameEnd; if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const start = buffer.indexOf(Buffer.from('<p:sld '), at), end = buffer.indexOf(Buffer.from('</p:sld>'), start);
    if (start < 0 || end < 0) continue;
    out.push({ name, text: [...buffer.subarray(start, end).toString().matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join('\n') });
  }
  const seen = new Map(); for (const s of out) seen.set(s.name, s.text);
  return [...seen.entries()].sort((a, b) => Number(a[0].match(/\d+/)[0]) - Number(b[0].match(/\d+/)[0])).map(([, t]) => t);
}

test('B5-F2 B/C/E: the owner-style 5-page script -> exactly 5 slides titled as planned, no Markdown, no 视觉建议', () => {
  const deck = S.buildDeck({ title: '任职资格体系概念介绍', text: SCRIPT, pageCount: S.pageCountFrom(GOAL) });
  assert.equal(S.pageCountFrom(GOAL), 5);
  assert.deepEqual(deck.slides.map(s => s.title), ['任职资格体系：让成长有标准、有路径', '什么是任职资格体系', '体系的三大构成', '如何落地实施', '总结']);
  assert.deepEqual(deck.slides.map(s => s.layout), ['cover', 'cards', 'cards', 'timeline', 'summary']);
  assert.match(deck.slides[0].notes, /深蓝渐变背景/, 'designer notes kept as notes, not on the slide');
  const texts = slidesText(createDeliverable('pptx', { title: '任职资格体系概念介绍', text: SCRIPT, goal: GOAL }).buffer);
  assert.equal(texts.length, 5, 'exactly the 5 pages the user asked for (cover included)');
  for (const t of texts) {
    assert.doesNotMatch(t, /[#*`|]|^\s*-\s|---|视觉建议|设计建议|备注|第\s*\d+\s*页/m, t);
    assert.ok(!t.includes(GOAL), 'the raw request is never a slide title');
  }
  assert.match(texts[0], /任职资格体系：让成长有标准、有路径[\s\S]*概念介绍 · 人力资源部/);
  assert.match(texts[3], /第一步[\s\S]*梳理岗位族与职业通道/);
  assert.match(texts[4], /下一步往哪走/);
});

test('B5-F2 A: strict slide JSON drives the layouts; an invalid JSON falls back to parsing; exact page count when asked', () => {
  const json = { slides: [{ layout: 'cover', title: '年度规划', subtitle: '战略汇报' }, { layout: 'two-column', title: '现状与目标', left: { title: '现状', bullets: ['系统分散'] }, right: { title: '目标', bullets: ['统一平台'] } },
    { layout: 'cards', title: '三项举措', cards: [{ title: '平台', text: '统一数据' }, { title: '流程', text: '自动化' }, { title: '人才', text: '梯队建设' }] },
    { layout: 'timeline', title: '路线图', steps: [{ title: '一季度', text: '选型' }, { title: '二季度', text: '试点' }, { title: '三季度', text: '推广' }] },
    { layout: 'bullets', title: '风险', bullets: ['预算', '人手'] }, { layout: 'summary', title: '总结', quote: '数据驱动每个决策' }] };
  const d = S.buildDeck({ title: 'x', slides: json.slides });
  assert.equal(d.source, 'json'); assert.deepEqual(d.slides.map(s => s.layout), ['cover', 'two-column', 'cards', 'timeline', 'bullets', 'summary']);
  assert.equal(S.buildDeck({ title: 'x', slides: json.slides, pageCount: 4 }).slides.length, 4, 'never more than the requested pages');
  for (const bad of [{ layout: 'hero', title: 'x' }, { layout: 'cards', title: 'x', cards: [{ title: 'only one' }] }, { layout: 'two-column', title: 'x', left: { bullets: ['a'] } }, { layout: 'bullets', title: '' }])
    assert.equal(S.strictDeck([json.slides[0], bad]), null, JSON.stringify(bad));
  const fallback = S.buildDeck({ title: '报告', text: JSON.stringify({ slides: [{ layout: 'hero', title: '封面' }, { layout: 'oops', title: '要点页', bullets: ['第一点', '第二点'] }] }) });
  assert.equal(fallback.source, 'text'); assert.ok(fallback.slides.some(s => s.title === '要点页'), 'invalid JSON -> fallback B reads its titles and points');
  const buf = createDeliverable('pptx', { title: '年度规划', text: '', slides: json.slides, goal: '做 6 页' }).buffer;
  const texts = slidesText(buf); assert.equal(texts.length, 6);
  assert.match(texts[1], /现状[\s\S]*系统分散[\s\S]*目标[\s\S]*统一平台/); assert.match(texts[2], /平台[\s\S]*统一数据/); assert.match(texts[5], /数据驱动每个决策/);
  const xml = buf.toString('latin1');
  assert.match(xml, /prst="roundRect"/, 'cards/panels are rounded'); assert.match(xml, /prst="ellipse"/, 'timeline and card badges');
  assert.match(buf.toString(), /<a:ea typeface="微软雅黑"\/>/); assert.match(buf.toString(), /<a:font script="Hans" typeface="微软雅黑"\/>/, 'East Asian font fallback in the theme');
  const dark = createDeliverable('pptx', { title: '年度规划', slides: json.slides, theme: 'dark' }).buffer.toString();
  assert.match(dark, /<a:srgbClr val="0F1C2E"\/>/, 'dark theme available; light business theme is the default');
  assert.doesNotMatch(buf.toString(), /<a:srgbClr val="0F1C2E"\/>/);
});

test('B5-F2 B: Markdown and designer notes never reach a slide, without a page count long lists split at 6', () => {
  const text = '# 方案\n\n## 背景\n- **要点一**：说明\n- 要点二\n\n---\n\n## 计划\n' + Array.from({ length: 9 }, (_, i) => `${i + 1}. 第${i + 1}项工作安排`).join('\n') + '\n\n**视觉建议：** 用插画\n**配色：** 蓝白';
  const deck = S.buildDeck({ title: '方案', text });
  assert.equal(deck.slides[0].layout, 'cover');
  for (const s of deck.slides) for (const t of [s.title, s.subtitle, ...(s.bullets || [])]) assert.doesNotMatch(String(t || ''), /[#*`]|视觉建议|插画|蓝白/, String(t));
  assert.ok(deck.slides.filter(s => s.layout === 'bullets').every(s => s.bullets.length <= 6));
  assert.ok(deck.slides.some(s => /（续）$/.test(s.title)), 'continued slide when more than 6 points');
});

test('AUD-6BBD-01: hostile 200 000-character lines are parsed in well under a second (no regex backtracking blow-up)', () => {
  const N = 200000;
  const cases = { spaces: '第1页：' + ' '.repeat(N) + '!', mark: 'Slide 1 ' + ' '.repeat(N) + 'x', hashes: '##### ' + ' '.repeat(N) + '#x', field: '标题：' + ' \t'.repeat(N / 2) + 'x',
    pipes: '|' + ' |'.repeat(N / 2) + 'x', rule: '- '.repeat(N / 2) + 'x', stars: '**'.repeat(N / 2) + 'x', single: '*' + 'a'.repeat(N), plain: 'a'.repeat(N),
    manyLines: Array.from({ length: 2000 }, () => '第1页：' + ' '.repeat(98) + '!').join('\n') };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    const deck = S.buildDeck({ title: 'x', text });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, name + ' took ' + ms.toFixed(0) + ' ms'); assert.ok(deck.slides.length >= 1);
    const t1 = process.hrtime.bigint(); createDeliverable('pptx', { title: 'x', text }); assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 2000, name + ' export');
  }
  // the normal owner fixture is unchanged by the length caps
  assert.deepEqual(S.buildDeck({ title: 't', text: SCRIPT, pageCount: 5 }).slides.map(s => s.title), ['任职资格体系：让成长有标准、有路径', '什么是任职资格体系', '体系的三大构成', '如何落地实施', '总结']);
});
