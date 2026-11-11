'use strict';
const path = require('path'), R = process.argv[2], S = require(path.join(R, 'lib/slides.js')), DL = require(path.join(R, 'lib/deliverables.js')), P = require(path.join(R, 'public/smart-plan.js'));
const out = {}, N = 200000;
const t = (k, fn) => { const s = process.hrtime.bigint(); let r; try { r = fn(); } catch (e) { r = 'ERR ' + e.message.slice(0, 50); } out['ms_' + k] = +(Number(process.hrtime.bigint() - s) / 1e6).toFixed(1); return r; };
t('pagemark_spaces', () => S.buildDeck({ title: 't', text: '第1页' + ' '.repeat(N) + 'x\n第2页 a' }));
t('field_spaces', () => S.buildDeck({ title: 't', text: '第1页\n- **标题' + ' '.repeat(N) + '\n第2页\nx' }));
t('field_colon', () => S.buildDeck({ title: 't', text: '第1页\n标题：' + '：'.repeat(N) + '\n第2页\nx' }));
t('clean_stars', () => S.buildDeck({ title: 't', text: '第1页\n- ' + 'a*'.repeat(N / 2) + '\n第2页\n- ' + '*'.repeat(N) }));
t('pipes', () => S.buildDeck({ title: 't', text: '第1页\n|' + ' |'.repeat(N / 2) + '\n第2页\nx' }));
t('hashes', () => S.buildDeck({ title: 't', text: '#'.repeat(N) + '\n' + '# '.repeat(N / 2) }));
t('many_short_lines', () => S.buildDeck({ title: 't', text: Array.from({ length: 100000 }, (_, i) => i % 50 ? '- **要点' + i + '**：' + ' '.repeat(30) : '第' + (i / 50 + 1) + '页').join('\n') }));
t('export_200k_line', () => DL.createDeliverable('pptx', { title: 't', text: '第1页 封面\n第2页 内容\n- ' + 'x '.repeat(N / 2) + '\n- y', goal: '' }));
t('strict_json_long', () => DL.createDeliverable('pptx', { title: 't', text: 'x', slides: [{ layout: 'bullets', title: ' '.repeat(N) + 'a', bullets: [' '.repeat(N) + 'b'] }] }));
// content kept: chunked long line
const d = S.buildDeck({ title: 't', text: '第1页 封面\n第2页 内容\n- ' + 'AB'.repeat(5000) });
out.chunk_total_chars = d.slides.flatMap(s => s.bullets || []).join('').replace(/[…\s]/g, '').length;
// page mark only on short lines
out.mark_on_long_line_ignored = S.buildDeck({ title: 't', text: 'x'.repeat(130) + ' 第3页\n第1页 a\n- p\n第2页 b\n- q' }).slides.length;
// 422 empty shell
const cov = (() => { try { DL.createDeliverable('pptx', { title: 't', text: '抱歉，我无法生成这个演示稿。' }); return 'created'; } catch (e) { return (e.code || '') + ' ' + (e.status || ''); } })();
out.apology = cov;
// budget floor property
const mk = (id, pid, mid, price) => ({ connectionId: id, providerId: pid, providerName: pid, modelId: mid, enabled: true, status: 'available', pricingMode: 'unknown', baseUrl: 'https://api.deepseek.com', price });
const pool = [mk('a', 'deepseek', 'deepseek-flash', { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 }), mk('b', 'dashscope', 'qwen3.8-max', { currency: 'CNY', inputPerMillion: 12, outputPerMillion: 36 })];
let above = 0, cap = 0, checked = 0;
for (let i = 1; i <= 2000; i++) { const b = i / 137; const p = P.plan({ models: pool, goal: '写一份方案', capCny: 5, budgetCny: b }); if (!p.ok) continue; checked++; if (p.chosen.maxCny > b + 1e-9) above++; if (p.approval.maxCost * P.FX > Math.min(5, b) + 1e-9) cap++; }
out.budget = { checked, maxCny_above_typed: above, usd_above_typed_or_cap: cap };
out.budget_invalid = ['0', '-1', 'abc', '0.001', ' '].map(v => { const p = P.plan({ models: pool, goal: '写', capCny: 5, budgetCny: v }); return v + ':' + (p.ok ? 'ok maxCny=' + p.chosen.maxCny : p.problems.map(x => x.code).join(',')); });
const lo = P.plan({ models: pool, goal: '写一份方案', capCny: 5, budgetCny: '0.01' }); out.budget_belowMin = { ok: lo.ok, belowMin: lo.belowMin, minCny: lo.minCny };
console.log(JSON.stringify(out));
