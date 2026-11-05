'use strict';
/*
 * 文件内容提取（供 AI 按需读取、供界面预览、供差异比较）。
 * 支持：文本 / Markdown / JSON / CSV / 代码、DOCX（mammoth）、XLSX（exceljs）、PPTX（jszip 解析幻灯片 XML）、PDF（unpdf）。
 * 返回统一结构：{ kind, text, pages?: [{ index, title?, text }], meta }。图片等二进制只返回元数据。
 */
const path = require('path');

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bat', 'ps1', 'sql', 'ini', 'toml', 'env', 'gitignore']);
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  zip: 'application/zip', json: 'application/json', csv: 'text/csv', md: 'text/markdown', html: 'text/html', txt: 'text/plain',
};
const extOf = name => path.extname(String(name || '')).slice(1).toLowerCase();
function kindOf(name) {
  const e = extOf(name);
  if (['docx', 'xlsx', 'pptx', 'pdf', 'zip'].includes(e)) return e;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return 'image';
  if (['md', 'markdown'].includes(e)) return 'markdown';
  if (['json'].includes(e)) return 'json';
  if (['csv', 'tsv'].includes(e)) return 'table';
  if (['txt', 'log'].includes(e)) return 'text';
  if (TEXT_EXT.has(e)) return 'code';
  return 'binary';
}
const mimeOf = name => MIME[extOf(name)] || (TEXT_EXT.has(extOf(name)) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
const isTextKind = k => ['markdown', 'json', 'table', 'text', 'code'].includes(k);

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

async function extractDocx(buf) {
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  // 轻量 HTML → 带结构的文本：标题、段落、列表、表格行
  let t = html
    .replace(/<t([dh])[^>]*>([\s\S]*?)<\/t\1>/g, (_, __, cell) => cell.replace(/<\/p>\s*<p[^>]*>/g, ' / ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() + ' | ')
    .replace(/<\/tr>/g, '\n')
    .replace(/<h([1-6])[^>]*>/g, (_, n) => '\n' + '#'.repeat(+n) + ' ').replace(/<\/h[1-6]>/g, '\n')
    .replace(/<li[^>]*>/g, '\n- ').replace(/<\/(p|li|ul|ol)>/g, '\n')
    .replace(/<tr[^>]*>/g, '\n| ').replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '');
  t = decodeXml(t).replace(/\n{3,}/g, '\n\n').trim();
  return { kind: 'docx', text: t, meta: { chars: t.length } };
}

async function extractXlsx(buf, { maxRows = 2000 } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const pages = [];
  wb.eachSheet((ws, i) => {
    const lines = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (lines.length >= maxRows) return;
      const vals = [];
      row.eachCell({ includeEmpty: true }, c => {
        let v = c.value;
        if (v && typeof v === 'object') v = v.result !== undefined ? v.result : v.text !== undefined ? v.text : v.richText ? v.richText.map(x => x.text).join('') : v.formula ? '=' + v.formula : JSON.stringify(v);
        vals.push(v == null ? '' : String(v));
      });
      lines.push(r + '\t' + vals.join('\t'));
    });
    pages.push({ index: i, title: ws.name, text: lines.join('\n'), rows: ws.rowCount, cols: ws.columnCount });
  });
  return { kind: 'xlsx', pages, text: pages.map(p => `## 工作表：${p.title}（${p.rows} 行 × ${p.cols} 列）\n${p.text}`).join('\n\n'), meta: { sheets: pages.length } };
}

async function extractPptx(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]);
  const pages = [];
  for (const f of slides) {
    const xml = await zip.file(f).async('string');
    const paras = xml.split(/<\/a:p>/).map(p => (p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map(x => decodeXml(x.replace(/<\/?a:t>/g, ''))).join('')).filter(Boolean);
    const n = +f.match(/(\d+)\.xml$/)[1];
    const notesFile = `ppt/notesSlides/notesSlide${n}.xml`;
    let notes = '';
    if (zip.file(notesFile)) notes = ((await zip.file(notesFile).async('string')).match(/<a:t>([^<]*)<\/a:t>/g) || []).map(x => decodeXml(x.replace(/<\/?a:t>/g, ''))).join(' ');
    const pics = (xml.match(/<p:pic>/g) || []).length, charts = (xml.match(/c:chart /g) || []).length, tables = (xml.match(/<a:tbl>/g) || []).length;
    pages.push({ index: n, title: paras[0] || '', text: paras.join('\n'), notes, shapes: { pictures: pics, charts, tables } });
  }
  return { kind: 'pptx', pages, text: pages.map(p => `## 第 ${p.index} 页${p.title ? '：' + p.title : ''}\n${p.text}${p.notes ? '\n（备注）' + p.notes : ''}`).join('\n\n'), meta: { slides: pages.length } };
}

async function extractPdf(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t, i) => ({ index: i + 1, text: String(t || '').trim() }));
  return { kind: 'pdf', pages, text: pages.map(p => `## 第 ${p.index} 页\n${p.text}`).join('\n\n'), meta: { pages: totalPages } };
}

/* 主入口：按文件名判断类型 */
async function extract(buf, name) {
  const kind = kindOf(name);
  if (isTextKind(kind)) { const text = buf.toString('utf8'); return { kind, text, meta: { chars: text.length, lines: text.split('\n').length } }; }
  if (kind === 'docx') return extractDocx(buf);
  if (kind === 'xlsx') return extractXlsx(buf);
  if (kind === 'pptx') return extractPptx(buf);
  if (kind === 'pdf') return extractPdf(buf);
  return { kind, text: '', meta: { bytes: buf.length, note: '二进制文件，无法提取文本' } };
}

/* 分页读取：按字符偏移 + 长度（AI 按需读取，避免一次塞入整份文件） */
function slice(text, { offset = 0, limit = 8000 } = {}) {
  const o = Math.max(0, offset | 0), l = Math.max(100, Math.min(50000, limit | 0 || 8000));
  const part = text.slice(o, o + l);
  return { offset: o, length: part.length, total: text.length, nextOffset: o + part.length < text.length ? o + part.length : null, text: part };
}

module.exports = { extract, slice, kindOf, mimeOf, extOf, isTextKind, TEXT_EXT };
