'use strict';
/*
 * 办公文件生成与编辑（真实、可编辑的 DOCX / XLSX / PPTX；PDF 经 LibreOffice 由 DOCX 转换）。
 * 模型只需给出结构化内容（或 Markdown），版式由这里统一负责：中文字体、标题层级、表格样式、页码、
 * 幻灯片网格、原生可编辑图表、组织结构图等。每个文件同时保存“结构化来源”，修订时在来源上修改后重新生成。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const SB = require('./sandbox');

/* ---------------- Markdown → 块 ---------------- */
function markdownToBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [], list = null, table = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'paragraph', text: para.join('') }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  const flushTable = () => {
    if (table) {
      const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
      if (rows.length) blocks.push({ type: 'table', columns: rows[0], rows: rows.slice(1) });
      table = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); (table = table || []).push(line); continue; }
    flushTable();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushPara(); flushList(); blocks.push({ type: 'heading', level: m[1].length, text: m[2].trim() }); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ type: 'pagebreak' }); continue; }
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.type !== 'bullets') { flushList(); list = { type: 'bullets', items: [] }; } list.items.push({ text: m[2], level: Math.min(3, Math.floor(m[1].length / 2)) }); continue; }
    if ((m = /^(\s*)\d+[.)、]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.type !== 'numbered') { flushList(); list = { type: 'numbered', items: [] }; } list.items.push({ text: m[2], level: Math.min(3, Math.floor(m[1].length / 2)) }); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); blocks.push({ type: 'quote', text: m[1] }); continue; }
    flushList(); para.push((para.length ? '' : '') + line.trim());
  }
  flushPara(); flushList(); flushTable();
  return blocks;
}
/* **粗体** 与普通文本拆分 */
function inlineRuns(text) {
  const parts = []; const re = /\*\*([^*]+)\*\*/g; let last = 0, m;
  while ((m = re.exec(text))) { if (m.index > last) parts.push({ text: text.slice(last, m.index) }); parts.push({ text: m[1], bold: true }); last = m.index + m[0].length; }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length ? parts : [{ text: '' }];
}

/* ---------------- DOCX ---------------- */
async function buildDocx(spec) {
  const D = require('docx');
  const font = { ascii: spec.fontLatin || 'Calibri', hAnsi: spec.fontLatin || 'Calibri', eastAsia: spec.font || 'Microsoft YaHei', cs: spec.fontLatin || 'Calibri' };
  const blocks = Array.isArray(spec.blocks) && spec.blocks.length ? spec.blocks : markdownToBlocks(spec.markdown || '');
  const children = [];
  if (spec.title) children.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: spec.title })] }));
  if (spec.subtitle) children.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { after: 300 }, children: [new D.TextRun({ text: spec.subtitle, color: '666666' })] }));
  const HL = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];
  const runs = t => inlineRuns(String(t ?? '')).map(p => new D.TextRun({ text: p.text, bold: p.bold }));
  let numberedRef = 0;
  for (const b of blocks) {
    const type = b.type;
    if (type === 'heading') children.push(new D.Paragraph({ heading: HL[Math.min(6, Math.max(1, b.level || 1)) - 1], children: runs(b.text) }));
    else if (type === 'paragraph') children.push(new D.Paragraph({ spacing: { after: 120, line: 360 }, children: runs(b.text) }));
    else if (type === 'quote') children.push(new D.Paragraph({ indent: { left: 720 }, children: [new D.TextRun({ text: String(b.text || ''), italics: true, color: '555555' })] }));
    else if (type === 'bullets' || type === 'numbered') {
      const ref = type === 'numbered' ? 'num-' + (++numberedRef) : null;
      for (const it of b.items || []) {
        const item = typeof it === 'string' ? { text: it, level: 0 } : it;
        children.push(new D.Paragraph(type === 'bullets'
          ? { bullet: { level: item.level || 0 }, children: runs(item.text) }
          : { numbering: { reference: 'numbered', level: item.level || 0, instance: numberedRef }, children: runs(item.text) }));
      }
    } else if (type === 'table') {
      const cols = (b.columns || []).map(String);
      const n = Math.max(cols.length, ...(b.rows || []).map(r => r.length), 1);
      const widths = Array.isArray(b.widths) && b.widths.length === n ? b.widths : Array(n).fill(Math.floor(100 / n));
      const cell = (t, head, w) => new D.TableCell({
        width: { size: w, type: D.WidthType.PERCENTAGE },
        shading: head ? { fill: '1F4E79', type: D.ShadingType.CLEAR, color: 'auto' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: String(t ?? '').split('\n').map(line => new D.Paragraph({ children: [new D.TextRun({ text: line, bold: head, color: head ? 'FFFFFF' : undefined })] })),
      });
      const rows = [];
      if (cols.length) rows.push(new D.TableRow({ tableHeader: true, children: Array.from({ length: n }, (_, i) => cell(cols[i] || '', true, widths[i])) }));
      for (const r of b.rows || []) rows.push(new D.TableRow({ children: Array.from({ length: n }, (_, i) => cell(r[i] ?? '', false, widths[i])) }));
      children.push(new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows }));
      children.push(new D.Paragraph({ text: '' }));
    } else if (type === 'pagebreak') children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
  }
  const levels = [0, 1, 2, 3].map(l => ({ level: l, format: D.LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } }));
  const doc = new D.Document({
    creator: spec.author || 'AIJAVAIS', title: spec.title || '', description: spec.description || '',
    styles: {
      default: { document: { run: { font, size: 22 } }, heading1: { run: { font, size: 32, bold: true, color: '1F4E79' } }, heading2: { run: { font, size: 28, bold: true, color: '1F4E79' } }, heading3: { run: { font, size: 24, bold: true } }, title: { run: { font, size: 44, bold: true, color: '1F4E79' } } },
    },
    numbering: { config: [{ reference: 'numbered', levels }] },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1300, right: 1300 } } },
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ['第 ', D.PageNumber.CURRENT, ' 页 / 共 ', D.PageNumber.TOTAL_PAGES, ' 页'], size: 18, color: '888888' })] })] }) },
      children: children.length ? children : [new D.Paragraph('')],
    }],
  });
  return { buffer: await D.Packer.toBuffer(doc), stats: { blocks: blocks.length, headings: blocks.filter(b => b.type === 'heading').length, tables: blocks.filter(b => b.type === 'table').length } };
}

/* 在现有 DOCX 中查找替换（适合编辑上传的原稿；跨格式片段的文字可能匹配不到，会如实报告次数） */
async function docxReplace(buffer, replacements) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f));
  const counts = replacements.map(() => 0);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const f of parts) {
    let xml = await zip.file(f).async('string');
    replacements.forEach((r, i) => {
      const from = esc(r.find), to = esc(r.replace);
      xml = xml.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (all, a, t, c) => { if (!t.includes(from)) return all; counts[i] += t.split(from).length - 1; return a + t.split(from).join(to) + c; });
    });
    zip.file(f, xml);
  }
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), counts };
}

/* ---------------- XLSX ---------------- */
async function buildXlsx(spec) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIJAVAIS';
  const stats = { sheets: 0, rows: 0, formulas: 0 };
  for (const sh of spec.sheets || []) {
    const ws = wb.addWorksheet(String(sh.name || 'Sheet' + (stats.sheets + 1)).slice(0, 31).replace(/[\\/?*[\]:]/g, '_'));
    stats.sheets++;
    const cols = (sh.columns || []).map(c => (typeof c === 'string' ? { header: c } : c));
    if (cols.length) ws.columns = cols.map(c => ({ header: String(c.header || ''), key: c.key || undefined, width: c.width || Math.max(10, Math.min(50, String(c.header || '').length * 2 + 4)), style: c.numFmt ? { numFmt: c.numFmt } : undefined }));
    for (const r of sh.rows || []) {
      const vals = Array.isArray(r) ? r : cols.map(c => r[c.key || c.header]);
      const row = ws.addRow(vals.map(v => {
        if (typeof v === 'string' && v.startsWith('=')) { stats.formulas++; return { formula: v.slice(1) }; }
        return v;
      }));
      row.eachCell(c => { c.border = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } }; c.alignment = { vertical: 'middle', wrapText: true }; });
      stats.rows++;
    }
    if (sh.totals && Array.isArray(sh.totals.sumColumns) && ws.rowCount > 1) {
      const last = ws.rowCount;
      const tr = ws.addRow([]);
      tr.getCell(1).value = sh.totals.label || '合计';
      for (const ci of sh.totals.sumColumns) { const L = ws.getColumn(ci).letter; tr.getCell(ci).value = { formula: `SUM(${L}2:${L}${last})` }; stats.formulas++; }
      tr.font = { bold: true };
    }
    if (cols.length) {
      const h = ws.getRow(1);
      h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
      h.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      h.height = 22;
      if (sh.freeze !== false) ws.views = [{ state: 'frozen', ySplit: 1 }];
      if (sh.autoFilter !== false && ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }
  }
  if (!stats.sheets) wb.addWorksheet('Sheet1');
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), stats };
}
/* 修改现有 XLSX 的单元格：[{ sheet, cell: 'B3', value }] */
async function xlsxUpdate(buffer, updates) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let n = 0;
  for (const u of updates) {
    const ws = typeof u.sheet === 'number' ? wb.worksheets[u.sheet - 1] : wb.getWorksheet(String(u.sheet || '')) || wb.worksheets[0];
    if (!ws) throw new Error('工作表不存在：' + u.sheet);
    if (!/^[A-Z]{1,3}\d{1,7}$/.test(String(u.cell))) throw new Error('单元格地址不合法：' + u.cell);
    ws.getCell(u.cell).value = typeof u.value === 'string' && u.value.startsWith('=') ? { formula: u.value.slice(1) } : u.value;
    n++;
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), updated: n };
}

/* ---------------- PPTX ---------------- */
const W = 13.333, H = 7.5; // 16:9（英寸）
/* 估算文字在给定宽度、字号下占的行数（中文按 1 个全角宽、英文按 0.55 个） */
function estimateLines(text, widthIn, fontPt) {
  const perLine = Math.max(1, (widthIn * 72) / fontPt);
  let lines = 0;
  for (const seg of String(text || '').split('\n')) {
    let w = 0; for (const ch of seg) w += /[\u0000-ÿ]/.test(ch) ? 0.55 : 1;
    lines += Math.max(1, Math.ceil(w / perLine));
  }
  return lines;
}
function fitFont(items, widthIn, heightIn, start = 22, min = 12) {
  for (let f = start; f >= min; f--) {
    const lines = items.reduce((s, t) => s + estimateLines(t, widthIn - 0.4, f), 0);
    if (lines * f * 1.35 / 72 <= heightIn) return { font: f, overflow: false };
  }
  return { font: min, overflow: true };
}

async function buildPptx(spec) {
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  p.author = spec.author || 'AIJAVAIS'; p.title = spec.title || '';
  const th = { primary: '1F4E79', accent: 'F2A900', text: '222222', muted: '6B7280', bg: 'FFFFFF', font: 'Microsoft YaHei', ...(spec.theme || {}) };
  const strip = c => String(c || '').replace(/^#/, '').toUpperCase();
  const C = Object.fromEntries(Object.entries(th).map(([k, v]) => [k, k === 'font' ? v : strip(v)]));
  const warnings = [];
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  const total = slides.length;
  const titleBar = (s, title, i) => {
    s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.12, fill: { color: C.primary }, line: { color: C.primary } });
    s.addText(String(title || ''), { x: 0.6, y: 0.35, w: W - 1.2, h: 0.8, fontFace: C.font, fontSize: 28, bold: true, color: C.primary, valign: 'middle' });
    s.addShape(p.ShapeType.line, { x: 0.6, y: 1.2, w: 1.2, h: 0, line: { color: C.accent, width: 3 } });
    s.addText(`${i + 1} / ${total}`, { x: W - 1.6, y: H - 0.45, w: 1.1, h: 0.3, fontFace: C.font, fontSize: 10, color: C.muted, align: 'right' });
    if (spec.footer) s.addText(String(spec.footer), { x: 0.6, y: H - 0.45, w: 6, h: 0.3, fontFace: C.font, fontSize: 10, color: C.muted });
  };
  const bulletArr = (items, font) => (items || []).map(it => {
    const o = typeof it === 'string' ? { text: it, level: 0 } : it;
    return { text: String(o.text || ''), options: { bullet: { indent: 18 }, indentLevel: Math.min(3, o.level || 0), fontSize: Math.max(10, font - 2 * (o.level || 0)), color: C.text, paraSpaceAfter: 6, breakLine: true } };
  });
  slides.forEach((sd, i) => {
    const s = p.addSlide();
    s.background = { color: C.bg };
    const layout = sd.layout || (sd.chart ? 'chart' : sd.table ? 'table' : sd.bullets ? 'bullets' : 'bullets');
    if (layout === 'title') {
      s.background = { color: C.primary };
      s.addText(String(sd.title || spec.title || ''), { x: 0.8, y: 2.3, w: W - 1.6, h: 1.4, fontFace: C.font, fontSize: 40, bold: true, color: 'FFFFFF' });
      if (sd.subtitle) s.addText(String(sd.subtitle), { x: 0.8, y: 3.8, w: W - 1.6, h: 0.8, fontFace: C.font, fontSize: 20, color: 'DDE6F0' });
      s.addShape(p.ShapeType.line, { x: 0.8, y: 3.75, w: 2, h: 0, line: { color: C.accent, width: 4 } });
      if (sd.date || spec.date) s.addText(String(sd.date || spec.date), { x: 0.8, y: 6.3, w: 6, h: 0.4, fontFace: C.font, fontSize: 14, color: 'DDE6F0' });
    } else if (layout === 'section') {
      s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 4.2, h: H, fill: { color: C.primary }, line: { color: C.primary } });
      s.addText(String(sd.number || ''), { x: 0.5, y: 2.6, w: 3.2, h: 1.5, fontFace: C.font, fontSize: 60, bold: true, color: C.accent });
      s.addText(String(sd.title || ''), { x: 4.8, y: 2.8, w: W - 5.4, h: 1.2, fontFace: C.font, fontSize: 34, bold: true, color: C.primary });
      if (sd.subtitle) s.addText(String(sd.subtitle), { x: 4.8, y: 4.0, w: W - 5.4, h: 0.8, fontFace: C.font, fontSize: 18, color: C.muted });
    } else if (layout === 'two_column') {
      titleBar(s, sd.title, i);
      const colW = (W - 1.6) / 2;
      [['left', 0.6], ['right', 0.6 + colW + 0.4]].forEach(([k, x]) => {
        const c = sd[k] || {};
        if (c.heading) s.addText(String(c.heading), { x, y: 1.45, w: colW - 0.2, h: 0.5, fontFace: C.font, fontSize: 18, bold: true, color: C.primary });
        const items = (c.bullets || []).map(b => (typeof b === 'string' ? b : b.text));
        const ft = fitFont(items, colW, 4.6, 18);
        if (ft.overflow || ft.font < 12) warnings.push({ slide: i + 1, issue: `第 ${i + 1} 页${k === 'left' ? '左' : '右'}栏文字可能溢出，建议拆页或精简` });
        s.addText(bulletArr(c.bullets, ft.font), { x, y: 2.0, w: colW - 0.2, h: 4.8, fontFace: C.font, valign: 'top' });
      });
    } else if (layout === 'table') {
      titleBar(s, sd.title, i);
      const cols = (sd.columns || (sd.table && sd.table.columns) || []).map(String);
      const rows = sd.rows || (sd.table && sd.table.rows) || [];
      const fs_ = rows.length > 10 ? 10 : rows.length > 6 ? 12 : 14;
      if (rows.length > 14) warnings.push({ slide: i + 1, issue: `第 ${i + 1} 页表格 ${rows.length} 行，超过一页建议容量（14 行）` });
      const data = [cols.map(c => ({ text: c, options: { bold: true, color: 'FFFFFF', fill: { color: C.primary } } })), ...rows.map((r, ri) => r.map(v => ({ text: String(v ?? ''), options: { fill: { color: ri % 2 ? 'F3F6FA' : 'FFFFFF' } } })))];
      if (cols.length) s.addTable(data, { x: 0.6, y: 1.5, w: W - 1.2, fontFace: C.font, fontSize: fs_, color: C.text, border: { type: 'solid', pt: 0.5, color: 'D0D7E2' }, autoPage: false });
    } else if (layout === 'chart') {
      titleBar(s, sd.title, i);
      const ch = sd.chart || {};
      const type = { bar: p.ChartType.bar, column: p.ChartType.bar, line: p.ChartType.line, pie: p.ChartType.pie, doughnut: p.ChartType.doughnut, area: p.ChartType.area }[ch.type || 'column'] || p.ChartType.bar;
      const data = (ch.series || []).map(se => ({ name: String(se.name || ''), labels: (ch.categories || []).map(String), values: (se.values || []).map(Number) }));
      if (!data.length || data.some(d => d.values.some(v => !Number.isFinite(v)))) warnings.push({ slide: i + 1, issue: `第 ${i + 1} 页图表数据缺失或不是数字` });
      s.addChart(type, data.length ? data : [{ name: '无数据', labels: ['—'], values: [0] }], {
        x: 0.8, y: 1.5, w: sd.caption ? 8.2 : W - 1.6, h: 5.2, barDir: ch.type === 'bar' ? 'bar' : 'col', showLegend: data.length > 1 || type === p.ChartType.pie, legendPos: 'b',
        showValue: !!ch.showValues, chartColors: [C.primary, C.accent, '5B9BD5', '70AD47', 'A5A5A5', 'ED7D31'], catAxisLabelFontFace: C.font, valAxisLabelFontFace: C.font, legendFontFace: C.font, dataLabelFontSize: 10,
      });
      if (sd.caption) s.addText(String(sd.caption), { x: 9.3, y: 1.8, w: 3.4, h: 4.5, fontFace: C.font, fontSize: 14, color: C.text, valign: 'top' });
    } else if (layout === 'kpi') {
      titleBar(s, sd.title, i);
      const items = (sd.items || []).slice(0, 6);
      const n = Math.max(1, items.length), gap = 0.3, w = (W - 1.2 - gap * (n - 1)) / n;
      items.forEach((it, k) => {
        const x = 0.6 + k * (w + gap);
        s.addShape(p.ShapeType.roundRect, { x, y: 2.0, w, h: 3.2, fill: { color: 'F3F6FA' }, line: { color: 'D0D7E2' }, rectRadius: 0.1 });
        s.addText(String(it.value ?? ''), { x, y: 2.3, w, h: 1.3, fontFace: C.font, fontSize: 36, bold: true, color: C.primary, align: 'center' });
        s.addText(String(it.label ?? ''), { x, y: 3.6, w, h: 0.6, fontFace: C.font, fontSize: 16, color: C.text, align: 'center' });
        if (it.note) s.addText(String(it.note), { x: x + 0.15, y: 4.2, w: w - 0.3, h: 0.9, fontFace: C.font, fontSize: 12, color: C.muted, align: 'center' });
      });
    } else if (layout === 'process') {
      titleBar(s, sd.title, i);
      const st = (sd.steps || []).slice(0, 6);
      const n = Math.max(1, st.length), w = (W - 1.2) / n;
      st.forEach((it, k) => {
        const x = 0.6 + k * w;
        s.addShape(p.ShapeType.chevron, { x, y: 2.0, w: w - 0.1, h: 1.0, fill: { color: k % 2 ? C.accent : C.primary }, line: { color: 'FFFFFF' } });
        s.addText(String(it.title || ''), { x: x + 0.2, y: 2.0, w: w - 0.5, h: 1.0, fontFace: C.font, fontSize: 15, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
        s.addText(String(it.text || ''), { x: x + 0.05, y: 3.2, w: w - 0.2, h: 3.4, fontFace: C.font, fontSize: 12, color: C.text, valign: 'top' });
      });
    } else if (layout === 'org_chart') {
      titleBar(s, sd.title, i);
      drawOrgChart(p, s, sd.nodes || [], C, warnings, i);
    } else {
      titleBar(s, sd.title, i);
      const items = (sd.bullets || []).map(b => (typeof b === 'string' ? b : b.text));
      const area = sd.image ? W - 6.6 : W - 1.2;
      const ft = fitFont(items, area, 5.2, 22);
      if (ft.overflow || ft.font < 14 || items.length > 10) warnings.push({ slide: i + 1, issue: `第 ${i + 1} 页文字可能溢出或过密（${items.length} 条，字号需降到 ${ft.font} 号${ft.overflow ? '仍放不下' : ''}），建议拆页或精简` });
      s.addText(bulletArr(sd.bullets, ft.font), { x: 0.6, y: 1.5, w: area, h: 5.4, fontFace: C.font, valign: 'top' });
    }
    if (sd.notes) s.addNotes(String(sd.notes));
  });
  if (!total) p.addSlide().addText('（空白演示文稿）', { x: 1, y: 3, w: 8, h: 1 });
  return { buffer: Buffer.from(await p.write({ outputType: 'nodebuffer' })), stats: { slides: total, warnings } };
}

/* 组织结构图：按层级自上而下排布，方框 + 连线（PowerPoint 中可直接编辑） */
function drawOrgChart(p, s, nodes, C, warnings, si) {
  const byId = new Map(nodes.map(n => [String(n.id), { ...n, id: String(n.id), children: [] }]));
  const roots = [];
  for (const n of byId.values()) { const par = n.parent != null && byId.get(String(n.parent)); if (par) par.children.push(n); else roots.push(n); }
  const levels = [];
  const walk = (n, d) => { (levels[d] = levels[d] || []).push(n); n.depth = d; n.children.forEach(c => walk(c, d + 1)); };
  roots.forEach(r => walk(r, 0));
  if (levels.length > 4 || levels.some(l => l.length > 8)) warnings.push({ slide: si + 1, issue: `第 ${si + 1} 页组织结构层级或同级部门过多，建议拆分为多页` });
  const top = 1.5, bottom = 7.0, lh = (bottom - top) / Math.max(1, levels.length);
  levels.forEach((lv, d) => {
    const n = lv.length, bw = Math.min(2.4, (W - 1.2) / n - 0.2), bh = Math.min(0.9, lh - 0.4);
    lv.forEach((node, k) => {
      const cx = 0.6 + ((W - 1.2) / n) * (k + 0.5);
      node.box = { x: cx - bw / 2, y: top + d * lh, w: bw, h: bh, cx, cy: top + d * lh };
      s.addShape(p.ShapeType.roundRect, { x: node.box.x, y: node.box.y, w: bw, h: bh, fill: { color: d === 0 ? C.primary : d === 1 ? 'DCE6F2' : 'F3F6FA' }, line: { color: C.primary, width: 1 }, rectRadius: 0.08 });
      s.addText([{ text: String(node.label || node.id), options: { bold: true, fontSize: n > 6 ? 10 : 12, color: d === 0 ? 'FFFFFF' : C.text, breakLine: !!node.note } }, ...(node.note ? [{ text: String(node.note), options: { fontSize: 9, color: d === 0 ? 'DDE6F0' : C.muted } }] : [])],
        { x: node.box.x, y: node.box.y, w: bw, h: bh, fontFace: C.font, align: 'center', valign: 'middle' });
    });
  });
  for (const n of byId.values()) for (const c of n.children) {
    const y1 = n.box.y + n.box.h, y2 = c.box.y, ym = (y1 + y2) / 2;
    s.addShape(p.ShapeType.line, { x: n.box.cx, y: y1, w: 0, h: ym - y1, line: { color: '8899AA', width: 1 } });
    s.addShape(p.ShapeType.line, { x: Math.min(n.box.cx, c.box.cx), y: ym, w: Math.abs(c.box.cx - n.box.cx), h: 0, line: { color: '8899AA', width: 1 } });
    s.addShape(p.ShapeType.line, { x: c.box.cx, y: ym, w: 0, h: y2 - ym, line: { color: '8899AA', width: 1 } });
  }
}

/* ---------------- LibreOffice 转换与渲染 ---------------- */
async function libreOfficeAvailable() { return !!(await SB.which('soffice') || await SB.which('libreoffice')); }
/* 任意 Office 文件 → PDF（每次使用独立的配置目录，避免并发冲突） */
async function convertToPdf(buffer, ext, { timeoutMs = 120000, signal } = {}) {
  const bin = (await SB.which('soffice')) || (await SB.which('libreoffice'));
  if (!bin) throw new Error('需要 LibreOffice 才能转换 / 渲染文档（Docker 镜像已内置；本机请安装 LibreOffice）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-lo-'));
  try {
    const src = path.join(dir, 'in.' + ext);
    fs.writeFileSync(src, buffer);
    const profile = 'file://' + path.join(dir, 'profile').replace(/\\/g, '/');
    const r = await SB.run(bin, ['-env:UserInstallation=' + profile, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, src], { cwd: dir, timeoutMs, memoryMb: 2048, signal, env: SB.safeEnv(dir) });
    const out = path.join(dir, 'in.pdf');
    if (!fs.existsSync(out)) throw new Error('LibreOffice 转换失败：' + (r.stderr || r.stdout || ('退出码 ' + r.code)).slice(0, 300));
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
/* PDF → PNG 页面图（需要 pdftoppm） */
async function renderPdfPages(pdfBuffer, { maxPages = 12, dpi = 60, signal } = {}) {
  const bin = await SB.which('pdftoppm');
  if (!bin) throw new Error('需要 poppler 的 pdftoppm 才能把页面渲染成图片');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-pp-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdfBuffer);
    const r = await SB.run(bin, ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), 'in.pdf', 'page'], { cwd: dir, timeoutMs: 120000, signal });
    if (r.code !== 0) throw new Error('页面渲染失败：' + r.stderr.slice(0, 200));
    return fs.readdirSync(dir).filter(f => /^page-\d+\.png$/.test(f)).sort((a, b) => +a.match(/(\d+)/)[1] - +b.match(/(\d+)/)[1]).map(f => fs.readFileSync(path.join(dir, f)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const pngSize = b => (b && b.length > 24 && b.readUInt32BE(0) === 0x89504e47 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null);
/* 渲染页的空白程度（白色像素比例的粗略估计，不解码 PNG：用压缩后大小近似，极小 = 几乎空白） */
const looksBlank = (png, w, h) => png.length < Math.max(1500, (w * h) / 400);

module.exports = { markdownToBlocks, buildDocx, docxReplace, buildXlsx, xlsxUpdate, buildPptx, estimateLines, convertToPdf, renderPdfPages, libreOfficeAvailable, pngSize, looksBlank, newId: () => crypto.randomBytes(4).toString('hex') };
