'use strict';
/* Deterministic table analysis and SVG charts. Numbers are computed by code,
 * not by a model, so results can be used as evidence. Only explicit
 * operations run; there is no formula or expression evaluation. */
const LIMITS = Object.freeze({ maxRows: 50000, maxCols: 200, maxGroups: 1000, maxOps: 10, maxChartPoints: 200, maxSeries: 8 });
class AnalysisError extends Error { constructor(code, message) { super(message); this.code = code; this.status = 422; } }
const fail = (code, message) => { throw new AnalysisError(code, message); };

function parseCsv(text, delimiter) {
  text = String(text).replace(/^﻿/, '');
  if (!delimiter) { const first = text.slice(0, text.indexOf('\n') + 1 || undefined); delimiter = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ','; }
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch; continue; }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; if (rows.length > LIMITS.maxRows + 1) fail('table_limit', `表格超过 ${LIMITS.maxRows} 行`); }
    else field += ch;
  }
  if (quoted) fail('invalid_csv', 'CSV 中有未闭合的引号');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const NUM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/,(?=\d{3}(\D|$))/g, '');
  if (NUM.test(s)) return Number(s);
  if (/^[+-]?\d+(?:\.\d+)?%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  return null;
}
function table(rows, { headerRow = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) fail('empty_table', '表格没有数据');
  const width = Math.min(LIMITS.maxCols, Math.max(...rows.map(r => r.length)));
  const header = headerRow ? rows[0].slice(0, width).map((h, i) => String(h ?? '').trim() || `列${i + 1}`) : Array.from({ length: width }, (_, i) => `列${i + 1}`);
  const seen = new Map(); const columns = header.map(h => { const n = (seen.get(h) || 0) + 1; seen.set(h, n); return n > 1 ? `${h}_${n}` : h; });
  const data = (headerRow ? rows.slice(1) : rows).map(r => columns.map((_, i) => r[i] ?? ''));
  if (data.length > LIMITS.maxRows) fail('table_limit', `表格超过 ${LIMITS.maxRows} 行`);
  return { columns, rows: data };
}
const col = (t, name) => { const i = t.columns.indexOf(name); if (i < 0) fail('column_missing', `没有列「${name}」；可选：${t.columns.join('、')}`); return i; };
const round = x => x === null || x === undefined ? null : Math.round(x * 1e10) / 1e10;
function stats(values) {
  const nums = values.map(toNumber).filter(v => v !== null).sort((a, b) => a - b);
  const n = nums.length, sum = nums.reduce((a, b) => a + b, 0), mean = n ? sum / n : null;
  const median = n ? (n % 2 ? nums[(n - 1) / 2] : (nums[n / 2 - 1] + nums[n / 2]) / 2) : null;
  const sd = n > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  return { count: values.length, numeric: n, missing: values.filter(v => String(v ?? '').trim() === '').length, sum: round(sum), mean: round(mean), median: round(median), min: n ? nums[0] : null, max: n ? nums[n - 1] : null, stdev: round(sd) };
}
const AGG = {
  sum: v => round(v.map(toNumber).filter(x => x !== null).reduce((a, b) => a + b, 0)),
  mean: v => { const n = v.map(toNumber).filter(x => x !== null); return n.length ? round(n.reduce((a, b) => a + b, 0) / n.length) : null; },
  count: v => v.length, min: v => { const n = v.map(toNumber).filter(x => x !== null); return n.length ? Math.min(...n) : null; },
  max: v => { const n = v.map(toNumber).filter(x => x !== null); return n.length ? Math.max(...n) : null; },
};
/* operations: [{op:'describe', columns?}, {op:'group', by, aggregates:[{column, fn}]}, {op:'top', column, n?, order?}, {op:'filter', column, equals}] */
function analyze(t, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > LIMITS.maxOps) fail('invalid_operations', `需要 1–${LIMITS.maxOps} 个分析操作`);
  let current = t; const results = [];
  for (const op of operations) {
    if (!op || typeof op !== 'object') fail('invalid_operations', '分析操作格式不正确');
    if (op.op === 'describe') {
      const names = op.columns || current.columns;
      const rows = names.map(name => ({ column: name, ...stats(current.rows.map(r => r[col(current, name)])) }));
      results.push({ op: 'describe', columns: ['column', 'count', 'numeric', 'missing', 'sum', 'mean', 'median', 'min', 'max', 'stdev'], rows: rows.map(r => [r.column, r.count, r.numeric, r.missing, r.sum, r.mean, r.median, r.min, r.max, r.stdev]) });
    } else if (op.op === 'group') {
      const by = col(current, op.by), aggs = op.aggregates || [{ column: op.by, fn: 'count' }];
      if (!Array.isArray(aggs) || !aggs.length || aggs.length > 20) fail('invalid_operations', 'aggregates 需要 1–20 项');
      for (const a of aggs) if (!AGG[a.fn]) fail('invalid_operations', `不支持的汇总方式 ${a.fn}；可选 sum/mean/count/min/max`);
      const groups = new Map();
      for (const r of current.rows) { const k = String(r[by]); if (!groups.has(k)) { if (groups.size >= LIMITS.maxGroups) fail('table_limit', '分组过多'); groups.set(k, []); } groups.get(k).push(r); }
      results.push({ op: 'group', by: op.by, columns: [op.by, ...aggs.map(a => `${a.column}·${a.fn}`)], rows: [...groups].map(([k, rs]) => [k, ...aggs.map(a => AGG[a.fn](rs.map(r => r[col(current, a.column)])))]) });
    } else if (op.op === 'top') {
      const i = col(current, op.column), n = Math.max(1, Math.min(1000, Math.floor(Number(op.n) || 10))), asc = op.order === 'asc';
      const sorted = current.rows.filter(r => toNumber(r[i]) !== null).sort((a, b) => asc ? toNumber(a[i]) - toNumber(b[i]) : toNumber(b[i]) - toNumber(a[i]));
      results.push({ op: 'top', column: op.column, columns: current.columns, rows: sorted.slice(0, n) });
    } else if (op.op === 'filter') {
      const i = col(current, op.column);
      current = { columns: current.columns, rows: current.rows.filter(r => String(r[i]) === String(op.equals)) };
      results.push({ op: 'filter', column: op.column, equals: String(op.equals), matched: current.rows.length });
    } else fail('invalid_operations', `不支持的操作 ${op.op}；可选 describe/group/top/filter`);
  }
  return results;
}
function markdown(result) {
  if (!result.columns) return `筛选 ${result.column} = ${result.equals}：${result.matched} 行`;
  const esc = v => String(v ?? '').replace(/\|/g, '\\|');
  return ['| ' + result.columns.map(esc).join(' | ') + ' |', '|' + result.columns.map(() => ' --- ').join('|') + '|', ...result.rows.slice(0, 200).map(r => '| ' + r.map(esc).join(' | ') + ' |')].join('\n');
}

/* ---------------- SVG charts (bar / line / pie) ---------------- */
const PALETTE = ['#2a7de1', '#e8833a', '#3aa776', '#c94f6d', '#8a63d2', '#c9a227', '#2bb5c4', '#7f8c8d'];
const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
function svgChart({ type = 'bar', title = '', labels, series }) {
  if (!['bar', 'line', 'pie'].includes(type)) fail('invalid_chart', '图表类型只能是 bar / line / pie');
  if (!Array.isArray(labels) || !labels.length || labels.length > LIMITS.maxChartPoints) fail('invalid_chart', `需要 1–${LIMITS.maxChartPoints} 个类别`);
  if (!Array.isArray(series) || !series.length || series.length > LIMITS.maxSeries) fail('invalid_chart', `需要 1–${LIMITS.maxSeries} 组数据`);
  const data = series.map(s => { const values = (s.values || []).map(toNumber); if (values.length !== labels.length || values.some(v => v === null)) fail('invalid_chart', `数据组「${s.name || ''}」必须为每个类别提供数字`); return { name: String(s.name || ''), values }; });
  if (type === 'pie' && (data.length !== 1 || data[0].values.some(v => v < 0))) fail('invalid_chart', '饼图只能有一组非负数据');
  const W = 800, H = 480, L = 70, R = 30, T = 60, B = 90;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">`, `<rect width="${W}" height="${H}" fill="#ffffff"/>`, `<text x="${W / 2}" y="34" text-anchor="middle" font-size="20" fill="#1f2d3d">${xml(title)}</text>`];
  if (type === 'pie') {
    const total = data[0].values.reduce((a, b) => a + b, 0) || 1; let a0 = -Math.PI / 2; const cx = 300, cy = 270, r = 170;
    data[0].values.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
      out.push(v / total >= 0.9999 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PALETTE[i % 8]}"/>` : `<path d="M ${cx} ${cy} L ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)} Z" fill="${PALETTE[i % 8]}" stroke="#fff"/>`);
      out.push(`<rect x="520" y="${110 + i * 26}" width="14" height="14" fill="${PALETTE[i % 8]}"/><text x="542" y="${122 + i * 26}" font-size="13" fill="#1f2d3d">${xml(labels[i])}：${round(v)}（${(v / total * 100).toFixed(1)}%）</text>`);
      a0 = a1;
    });
  } else {
    const all = data.flatMap(d => d.values), max = Math.max(0, ...all), min = Math.min(0, ...all), span = max - min || 1;
    const y = v => T + (H - T - B) * (1 - (v - min) / span), plotW = W - L - R, step = plotW / labels.length;
    for (let g = 0; g <= 5; g++) { const v = min + span * g / 5; out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e3e8ee"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6b7b">${round(v)}</text>`); }
    labels.forEach((lab, i) => out.push(`<text x="${(L + step * (i + 0.5)).toFixed(1)}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="#1f2d3d">${xml(String(lab).slice(0, 16))}</text>`));
    data.forEach((d, s) => {
      const color = PALETTE[s % 8];
      if (type === 'bar') { const bw = step * 0.8 / data.length; d.values.forEach((v, i) => { const x = L + step * i + step * 0.1 + bw * s, y0 = y(Math.max(0, v)), h = Math.abs(y(v) - y(0)); out.push(`<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>${xml(labels[i])}：${round(v)}</title></rect>`); }); }
      else out.push(`<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${d.values.map((v, i) => `${(L + step * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>` + d.values.map((v, i) => `<circle cx="${(L + step * (i + 0.5)).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${color}"/>`).join(''));
      out.push(`<rect x="${L + s * 150}" y="${H - 34}" width="14" height="14" fill="${color}"/><text x="${L + 20 + s * 150}" y="${H - 22}" font-size="13" fill="#1f2d3d">${xml(d.name.slice(0, 14))}</text>`);
    });
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#8795a1"/>`);
  }
  out.push('</svg>');
  return Buffer.from(out.join('\n'), 'utf8');
}

module.exports = { parseCsv, table, analyze, markdown, svgChart, toNumber, stats, AnalysisError, ANALYSIS_LIMITS: LIMITS };
