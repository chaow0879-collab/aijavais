'use strict';
const path = require('path'), R = process.argv[2], S = require(path.join(R, 'lib/slides.js')), DL = require(path.join(R, 'lib/deliverables.js'));
const zlib = require('zlib'), out = {};
const make = (opts) => { try { const f = DL.createDeliverable('pptx', opts); return { ok: true, bytes: f.buffer?.length ?? f.bytes ?? null, f }; } catch (e) { return { ok: false, err: String(e.message).slice(0, 80) }; } };
// 1 timing: adversarial long lines (200 KB)
const t = (label, fn) => { const s = process.hrtime.bigint(); let r; try { r = fn(); } catch (e) { r = 'ERR ' + e.message.slice(0, 60); } out['time_' + label] = Number(process.hrtime.bigint() - s) / 1e6; return r; };
const N = 200000;
t('pagemark_spaces', () => S.buildDeck({ title: 't', text: '第1页' + ' '.repeat(N) + 'x\n第2页 a' }));
t('pagemark_stars', () => S.buildDeck({ title: 't', text: '第1页' + '**'.repeat(N / 2) + '\n第2页' }));
t('clean_star', () => S.clean('a*' + 'b'.repeat(N) + ' *'.repeat(1000)));
t('clean_stars_only', () => S.clean('*'.repeat(N)));
t('field_line', () => S.buildDeck({ title: 't', text: '第1页\n' + '- **标题' + ' '.repeat(N) + '\n第2页\nx' }));
t('many_pages', () => S.buildDeck({ title: 't', text: Array.from({ length: 20000 }, (_, i) => '第' + (i + 1) + '页：x\n- a').join('\n') }));
t('many_pages_pageCount30', () => S.buildDeck({ title: 't', text: Array.from({ length: 20000 }, (_, i) => '第' + (i + 1) + '页：x\n- a').join('\n'), pageCount: 30 }));
t('bullets_10k_pageCount5', () => make({ title: 't', text: '第1页 封面\n第2页 x\n' + Array.from({ length: 10000 }, (_, i) => '- 点' + i).join('\n'), goal: '做5页' }));
// 2 injection
const inj = '</a:t></a:r></a:p><p:pic r:embed="rId9"/><a:t>]]>&lt;"\' <!ENTITY x SYSTEM "file:///etc/passwd">';
const r1 = make({ title: '注入' + inj, text: '第1页：封面\n标题：' + inj + '\n第2页：' + inj + '\n- ' + inj + '\n视觉建议：' + inj, goal: '5页' });
const r2 = make({ title: 't', text: 'x', slides: [{ layout: 'cards', title: inj, cards: [{ title: inj, text: inj }, { title: 'b', text: 'c' }] }, { layout: '../../evil', title: 'x', bullets: ['y'] }] });
const r3 = make({ title: 't', text: 'x', slides: [{ layout: 'bullets', title: 'x', bullets: ['ok'] }], theme: '"><evil' });
const r4 = make({ title: 't', text: '第1页\n- a\u0001b\n第2页\n- c' });
const r5 = make({ title: 't', text: 'x', slides: [{ layout: 'bullets', title: 'a\u0000', bullets: ['b'] }] });
const r6 = make({ title: '=cmd|\'/c calc\'!A1', text: '第1页\n- =HYPERLINK("http://evil")\n第2页\n- @SUM(1)' });
const xmlOf = f => { if (!f || !f.ok) return null; const b = f.f.buffer || f.f.content || f.f.data; return b ? b.toString('latin1') : null; };
for (const [k, r] of Object.entries({ r1, r2, r3, r4, r5, r6 })) {
  const raw = xmlOf(r);
  out[k] = { ok: r.ok, err: r.err || null, keys: r.ok ? Object.keys(r.f) : null, has_raw_tag: raw ? /<p:pic|<!ENTITY|file:\/\/\/etc/.test(raw) : null, has_external_rel: raw ? /TargetMode="External"/.test(raw) : null };
}
out.pageCount = { five: S.pageCountFrom('做一个5页PPT'), cn: S.pageCountFrom('五页幻灯片'), big: S.pageCountFrom('做99页'), page_word: S.pageCountFrom('页面设计') };
console.log(JSON.stringify(out, null, 0));
