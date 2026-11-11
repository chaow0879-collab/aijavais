'use strict';
/* Zero-dependency reading of user-supplied project files.
 * Every upload is untrusted: the declared extension must match the content,
 * ZIP containers are bounded (entries, inflated bytes, ratio, CRC), XML is only
 * tokenised for text (no DTD/entity expansion, no external references), and PDF
 * text comes from the optional system program `pdftotext` (poppler) run without
 * a shell, with a timeout, an output cap and a private temporary directory.
 * Extraction never executes macros, scripts or embedded objects. Images are
 * stored with metadata only: there is no OCR, and the result says so. */
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024, maxZipEntries: 4000, maxEntryBytes: 32 * 1024 * 1024,
  maxInflatedBytes: 96 * 1024 * 1024, maxRatio: 250, maxTextChars: 2000000,
  maxSheetRows: 5000, maxSheetCols: 200, pdfTimeoutMs: 30000, maxPdfPages: 500, maxPdfOutputBytes: 16 * 1024 * 1024,
});
class ExtractError extends Error {
  constructor(code, message) { super(message); this.name = 'ExtractError'; this.code = code; this.status = 422; }
}
const fail = (code, message) => { throw new ExtractError(code, message); };

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'kt', 'swift', 'sh', 'sql', 'ini', 'toml', 'srt', 'tex', 'rtf']);
const OFFICE = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const IMAGE = { png: ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))], jpg: ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff], jpeg: ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff], gif: ['image/gif', b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1'))], webp: ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'] };
const TEXT_MIME = { md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', html: 'text/plain', htm: 'text/plain', xml: 'text/plain' };
const SUPPORTED = ['PDF', 'DOCX', 'XLSX', 'PPTX', 'TXT/MD/CSV/TSV/JSON', '常见代码与配置文本', 'PNG/JPEG/GIF/WEBP（仅元数据，无 OCR）'];

function safeFilename(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '_').slice(-160).trim();
  if (!cleaned || !/\.[a-z0-9]{1,10}$/i.test(cleaned)) fail('invalid_filename', '文件名需要包含扩展名，例如 资料.pdf');
  return cleaned;
}

/* Decide the type from the extension AND verify it against the bytes. */
function detect(filename, buffer) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const zip = buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
  if (OFFICE[ext]) { if (!zip) fail('type_mismatch', '文件内容不是 ' + ext.toUpperCase() + '（缺少 ZIP 容器）'); return { kind: ext, mime: OFFICE[ext] }; }
  if (ext === 'pdf') { if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) fail('type_mismatch', '文件内容不是 PDF'); return { kind: 'pdf', mime: 'application/pdf' }; }
  if (IMAGE[ext]) { if (!IMAGE[ext][1](buffer)) fail('type_mismatch', '文件内容与图片扩展名不符'); return { kind: 'image', mime: IMAGE[ext][0] }; }
  if (TEXT_EXT.has(ext)) {
    if (zip || buffer.includes(0)) fail('type_mismatch', '文本文件中含有二进制内容');
    return { kind: ext === 'csv' || ext === 'tsv' ? 'table' : ext === 'json' ? 'json' : 'text', mime: (TEXT_MIME[ext] || 'text/plain') + (TEXT_MIME[ext] === 'application/json' ? '' : '; charset=utf-8') };
  }
  fail('unsupported_type', '暂不支持该文件类型。支持：' + SUPPORTED.join('、'));
}

/* ---------------- ZIP (read-only, bounded) ---------------- */
function readZip(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('corrupt_file', '文件损坏：找不到 ZIP 目录');
  const count = buffer.readUInt16LE(eocd + 10), cdSize = buffer.readUInt32LE(eocd + 12), cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) fail('unsupported_file', '暂不支持 ZIP64 超大文件');
  if (count > LIMITS.maxZipEntries) fail('zip_limit', '压缩包内文件过多');
  if (cdOffset + cdSize > eocd) fail('corrupt_file', '文件损坏：ZIP 目录越界');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) fail('corrupt_file', '文件损坏：ZIP 目录项无效');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10), crc = buffer.readUInt32LE(p + 16);
    const csize = buffer.readUInt32LE(p + 20), usize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32), local = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    if (flags & 1) fail('encrypted_file', '文件已加密，无法读取；请先解除密码保护');
    if (!entries.has(name)) entries.set(name, { method, crc, csize, usize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let inflated = 0;
  return {
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > LIMITS.maxEntryBytes) fail('zip_limit', '压缩包内单个文件过大');
      if (e.usize > 1024 * 1024 && e.usize / Math.max(1, e.csize) > LIMITS.maxRatio) fail('zip_limit', '压缩比异常，拒绝读取（可能是压缩炸弹）');
      if ((inflated += e.usize) > LIMITS.maxInflatedBytes) fail('zip_limit', '解压后内容过大');
      if (e.local + 30 > buffer.length || buffer.readUInt32LE(e.local) !== 0x04034b50) fail('corrupt_file', '文件损坏：本地文件头无效');
      const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
      const data = buffer.subarray(start, start + e.csize);
      if (data.length !== e.csize) fail('corrupt_file', '文件损坏：数据被截断');
      let out;
      if (e.method === 0) out = Buffer.from(data);
      else if (e.method === 8) {
        try { out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) }); }
        catch { fail('corrupt_file', '文件损坏：无法解压 ' + name); }
      } else fail('unsupported_file', '不支持的压缩方式');
      if (out.length !== e.usize || zlib.crc32(out) !== e.crc) fail('corrupt_file', '文件损坏：校验和不一致');
      return out;
    },
    text(name) { const b = this.read(name); return b === null ? null : b.toString('utf8'); },
  };
}

/* ---------------- XML tokenising (text only) ---------------- */
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENT[e.toLowerCase()] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}
function* tokens(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('unsupported_file', '文件中的 XML 包含 DTD，拒绝读取');
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2]) yield { tag: m[2], close: !!m[1], self: !!m[4], attrs: m[3] };
    else if (m[5] !== undefined) yield { text: m[5] };
    else if (m[6] !== undefined) yield { text: decode(m[6]) };
  }
}
const attr = (attrs, name) => { const m = new RegExp('(?:^|\\s)' + name.replace(/[.:]/g, '\\$&') + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(attrs || ''); return m ? decode(m[2] ?? m[3]) : null; };
function rels(zip, file) {
  const out = new Map(), xml = zip.text(file);
  if (!xml) return out;
  for (const t of tokens(xml)) if (t.tag === 'Relationship' && !t.close) out.set(attr(t.attrs, 'Id'), { target: attr(t.attrs, 'Target') || '', type: attr(t.attrs, 'Type') || '', external: attr(t.attrs, 'TargetMode') === 'External' });
  return out;
}
const resolvePart = (base, target) => target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(base), target));

/* ---------------- DOCX ---------------- */
function docxText(zip) {
  const xml = zip.text('word/document.xml');
  if (xml === null) fail('corrupt_file', 'DOCX 缺少正文 word/document.xml');
  const headingOf = new Map(), listStyles = new Set();
  const styles = zip.text('word/styles.xml');
  if (styles) {
    let id = null;
    for (const t of tokens(styles)) {
      if (t.tag === 'w:style' && !t.close) id = attr(t.attrs, 'w:styleId');
      else if (id && (t.tag === 'w:name' || t.tag === 'w:outlineLvl')) {
        const v = attr(t.attrs, 'w:val') || '';
        const level = t.tag === 'w:outlineLvl' ? Number(v) + 1 : /^(heading|标题)\s*(\d)$/i.test(v) ? Number(/\d/.exec(v)[0]) : /^title$/i.test(v) ? 1 : 0;
        if (level >= 1 && level <= 9 && !headingOf.has(id)) headingOf.set(id, level);
        if (t.tag === 'w:name' && /^list (bullet|number)|^列表/i.test(v)) listStyles.add(id);
      } else if (t.tag === 'w:style' && t.close) id = null;
    }
  }
  const lines = [], headings = [];
  let para = null, style = null, list = false, tableDepth = 0, cell = [], row = [], inText = false;
  for (const t of tokens(xml)) {
    if (t.text !== undefined) { if (para !== null && inText) para += t.text; continue; }
    switch (t.tag) {
      case 'w:p': if (!t.close && !t.self) { para = ''; style = null; list = false; } else if (t.close && para !== null) {
        const level = headingOf.get(style) || (/^(heading|标题)\s*(\d)$/i.test(style || '') ? Number(/\d/.exec(style)[0]) : 0);
        const text = para.replace(/[ \t]+$/g, '');
        if (tableDepth) { if (text) cell.push(text); }
        else if (text) { if (level) headings.push({ level, title: text, line: lines.length }); lines.push(level ? '#'.repeat(level) + ' ' + text : list || listStyles.has(style) ? '- ' + text : text); }
        para = null;
      } break;
      case 'w:pStyle': style = attr(t.attrs, 'w:val'); break;
      case 'w:numPr': list = true; break;
      case 'w:t': inText = !t.close && !t.self; break;
      case 'w:tab': if (para !== null && !t.close) para += '\t'; break;
      case 'w:br': case 'w:cr': if (para !== null && !t.close) para += '\n'; break;
      case 'w:tbl': tableDepth += t.close ? -1 : t.self ? 0 : 1; if (t.close && !tableDepth) lines.push(''); break;
      case 'w:tc': if (t.close) { row.push(cell.join(' / ').replace(/\|/g, '\\|')); cell = []; } break;
      case 'w:tr': if (t.close) { if (tableDepth === 1) lines.push('| ' + row.join(' | ') + ' |'); row = []; } break;
      default: break;
    }
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), meta: { paragraphs: lines.length, headings: headings.slice(0, 200) } };
}

/* ---------------- XLSX ---------------- */
const colIndex = ref => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] || 'A') n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = i => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const UNCOMPUTED = Symbol('uncomputed formula');
/* Raw sheet values: [{ name, hidden, maxCol, rows: Map<rowNumber, Array<string|{formula}>> }]. */
function xlsxSheets(zip) {
  const wb = zip.text('xl/workbook.xml');
  if (wb === null) fail('corrupt_file', 'XLSX 缺少 xl/workbook.xml');
  const wbRels = rels(zip, 'xl/_rels/workbook.xml.rels');
  const shared = [];
  const ss = zip.text('xl/sharedStrings.xml');
  if (ss) {
    let cur = null, inT = false, phonetic = 0;
    for (const t of tokens(ss)) {
      if (t.text !== undefined) { if (cur !== null && inT && !phonetic) cur += t.text; continue; }
      if (t.tag === 'si') { if (!t.close) cur = ''; else { shared.push(cur); cur = null; } }
      else if (t.tag === 'rPh') phonetic += t.close ? -1 : t.self ? 0 : 1;
      else if (t.tag === 't') inT = !t.close && !t.self;
    }
  }
  const sheets = [];
  for (const t of tokens(wb)) if (t.tag === 'sheet' && !t.close) sheets.push({ name: attr(t.attrs, 'name') || 'Sheet', rid: attr(t.attrs, 'r:id'), state: attr(t.attrs, 'state') });
  const out = [];
  for (const s of sheets) {
    const rel = wbRels.get(s.rid);
    if (!rel || rel.external) continue;
    const xml = zip.text(resolvePart('xl/workbook.xml', rel.target));
    if (xml === null) continue;
    const rows = new Map();
    let cell = null, field = null, maxCol = -1;
    for (const t of tokens(xml)) {
      if (t.text !== undefined) { if (cell && field) cell[field] += t.text; continue; }
      if (t.tag === 'c' && !t.close) cell = t.self ? null : { ref: attr(t.attrs, 'r') || '', type: attr(t.attrs, 't') || 'n', v: '', f: '', is: '' };
      else if (t.tag === 'c' && t.close && cell) {
        const r = Number(/\d+$/.exec(cell.ref)?.[0]), c = colIndex(cell.ref);
        let value = cell.type === 's' ? (shared[Number(cell.v)] ?? '') : cell.type === 'inlineStr' ? cell.is : cell.type === 'b' ? (cell.v === '1' ? 'TRUE' : 'FALSE') : cell.v;
        if (value === '' && cell.f) value = { [UNCOMPUTED]: true, formula: cell.f };
        if (r > 0 && value !== '') {
          if (rows.size >= LIMITS.maxSheetRows && !rows.has(r)) fail('sheet_limit', `工作表「${s.name}」超过 ${LIMITS.maxSheetRows} 行，请拆分后再上传`);
          if (c < LIMITS.maxSheetCols) { if (!rows.has(r)) rows.set(r, []); rows.get(r)[c] = typeof value === 'string' ? value.replace(/[\t\r\n]+/g, ' ') : value; maxCol = Math.max(maxCol, c); }
        }
        cell = null;
      } else if (cell && ['v', 'f', 't'].includes(t.tag)) field = !t.close && !t.self ? (t.tag === 't' ? 'is' : t.tag) : null;
    }
    out.push({ name: s.name, hidden: !!(s.state && s.state !== 'visible'), maxCol, rows });
  }
  return out;
}
const cellText = v => v && typeof v === 'object' && v[UNCOMPUTED] ? '=' + v.formula + '（公式，文件中无计算结果）' : (v ?? '');
function xlsxText(zip) {
  const parts = [], meta = { sheets: [] };
  for (const s of xlsxSheets(zip)) {
    const order = [...s.rows.keys()].sort((a, b) => a - b);
    const header = ['行', ...Array.from({ length: s.maxCol + 1 }, (_, i) => colName(i))].join('\t');
    const body = order.map(r => [r, ...Array.from({ length: s.maxCol + 1 }, (_, i) => cellText(s.rows.get(r)[i]))].join('\t'));
    parts.push(`## 工作表：${s.name}${s.hidden ? '（隐藏）' : ''}（${order.length} 行 × ${s.maxCol + 1} 列）\n${header}\n${body.join('\n')}`);
    meta.sheets.push({ name: s.name, rows: order.length, cols: s.maxCol + 1, hidden: s.hidden });
  }
  return { text: parts.join('\n\n'), meta };
}
/* Dense rows for analysis tools: uncomputed formulas become null and are counted. */
function readSpreadsheet(buffer, { sheet } = {}) {
  const sheets = xlsxSheets(readZip(buffer));
  const chosen = sheet === undefined ? sheets.find(s => !s.hidden) || sheets[0] : sheets.find(s => s.name === sheet);
  if (!chosen) fail('sheet_missing', sheet === undefined ? '表格中没有工作表' : `没有名为「${sheet}」的工作表；可选：${sheets.map(s => s.name).join('、')}`);
  let uncomputed = 0;
  const order = [...chosen.rows.keys()].sort((a, b) => a - b);
  const rows = order.map(r => Array.from({ length: chosen.maxCol + 1 }, (_, i) => { const v = chosen.rows.get(r)[i]; if (v && typeof v === 'object') { uncomputed++; return null; } return v ?? ''; }));
  return { sheet: chosen.name, sheets: sheets.map(s => s.name), rows, uncomputedFormulas: uncomputed };
}

/* ---------------- PPTX ---------------- */
function slideParagraphs(xml) {
  const out = [];
  let para = null, inT = false;
  for (const t of tokens(xml)) {
    if (t.text !== undefined) { if (para !== null && inT) para += t.text; continue; }
    if (t.tag === 'a:p') { if (!t.close && !t.self) para = ''; else if (t.close && para !== null) { if (para.trim()) out.push(para.trim()); para = null; } }
    else if (t.tag === 'a:t') inT = !t.close && !t.self;
    else if (t.tag === 'a:br' && para !== null) para += '\n';
  }
  return out;
}
function pptxText(zip) {
  const pres = zip.text('ppt/presentation.xml');
  if (pres === null) fail('corrupt_file', 'PPTX 缺少 ppt/presentation.xml');
  const presRels = rels(zip, 'ppt/_rels/presentation.xml.rels');
  const ids = [];
  for (const t of tokens(pres)) if (t.tag === 'p:sldId' && !t.close) ids.push(attr(t.attrs, 'r:id'));
  const parts = [], meta = { slides: 0 };
  ids.forEach((rid, i) => {
    const rel = presRels.get(rid);
    if (!rel || rel.external) return;
    const file = resolvePart('ppt/presentation.xml', rel.target), xml = zip.text(file);
    if (xml === null) return;
    const paras = slideParagraphs(xml);
    const slideRels = rels(zip, path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels'));
    const notesRel = [...slideRels.values()].find(r => /\/notesSlide$/.test(r.type) && !r.external);
    const notesXml = notesRel ? zip.text(resolvePart(file, notesRel.target)) : null;
    const notes = notesXml ? slideParagraphs(notesXml).filter(p => !/^\d+$/.test(p)) : [];
    meta.slides++;
    parts.push(`## 第 ${i + 1} 页${paras[0] ? '：' + paras[0] : ''}\n${paras.slice(1).join('\n')}${notes.length ? '\n（备注）' + notes.join(' ') : ''}`.trim());
  });
  return { text: parts.join('\n\n'), meta };
}

/* ---------------- PDF via optional poppler ---------------- */
let pdfToolCache;
function findExecutable(name) {
  for (const dir of String(process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const full = path.join(dir, name);
    try { fs.accessSync(full, fs.constants.X_OK); if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
  }
  return null;
}
function pdfTool() {
  if (pdfToolCache === undefined) pdfToolCache = process.env.AIJ_PDFTOTEXT === '0' ? null : findExecutable('pdftotext');
  return pdfToolCache;
}
function runBounded(file, args, { timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const chunks = []; let bytes = 0, done = false;
    const finish = (err, out) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (err) { child.kill('SIGKILL'); reject(err); } else resolve(out); };
    const timer = setTimeout(() => finish(new ExtractError('extract_timeout', 'PDF 解析超时')), timeoutMs);
    const onAbort = () => finish(new ExtractError('aborted', '已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', c => { bytes += c.length; if (bytes > maxBytes) finish(new ExtractError('text_limit', 'PDF 文本超过上限')); else chunks.push(c); });
    child.on('error', () => finish(new ExtractError('tool_failed', 'PDF 解析程序无法启动')));
    child.on('close', code => code === 0 ? finish(null, Buffer.concat(chunks)) : finish(new ExtractError('corrupt_file', 'PDF 无法解析（可能已加密或损坏）')));
  });
}
async function pdfText(buffer, { signal } = {}) {
  const tool = pdfTool();
  if (!tool) return { status: 'tool_unavailable', text: '', meta: {}, extractor: null, note: '服务器未安装 pdftotext（poppler-utils），PDF 已保存但无法读取文字。' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-pdf-'));
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'input.pdf');
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    const out = await runBounded(tool, ['-enc', 'UTF-8', '-q', '-l', String(LIMITS.maxPdfPages), file, '-'], { timeoutMs: LIMITS.pdfTimeoutMs, maxBytes: LIMITS.maxPdfOutputBytes, signal });
    const pages = out.toString('utf8').split('\f');
    if (pages.length && !pages.at(-1).trim()) pages.pop();
    const text = pages.map((p, i) => `## 第 ${i + 1} 页\n${p.replace(/[ \t]+\n/g, '\n').trim()}`).join('\n\n');
    const hasText = pages.some(p => p.trim());
    return { status: hasText ? 'ok' : 'no_text', text: hasText ? text : '', meta: { pages: pages.length }, extractor: 'pdftotext', note: hasText ? '' : 'PDF 中没有可提取的文字（可能是扫描件；当前没有 OCR）。' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* Main entry: returns { filename, kind, mime, status, text, meta, extractor, note }.
 * status: ok | no_text | tool_unavailable | metadata_only. Throws ExtractError for invalid input. */
async function extractFile(filename, buffer, { signal } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('empty_file', '文件为空');
  if (buffer.length > LIMITS.maxFileBytes) fail('file_limit', `单个文件不能超过 ${LIMITS.maxFileBytes / 1024 / 1024} MB`);
  filename = safeFilename(filename);
  const { kind, mime } = detect(filename, buffer);
  let result;
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    const zip = readZip(buffer);
    const r = kind === 'docx' ? docxText(zip) : kind === 'xlsx' ? xlsxText(zip) : pptxText(zip);
    result = { ...r, status: r.text.trim() ? 'ok' : 'no_text', extractor: 'builtin-ooxml', note: r.text.trim() ? '' : '文件中没有可提取的文字。' };
  } else if (kind === 'pdf') result = await pdfText(buffer, { signal });
  else if (kind === 'image') result = { status: 'metadata_only', text: '', meta: {}, extractor: null, note: '图片仅保存，不识别图中文字（当前没有 OCR 或看图工具）。' };
  else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('encoding', '文本文件不是 UTF-8 编码；请另存为 UTF-8 后上传'); }
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (kind === 'json') { try { JSON.parse(text); } catch { fail('invalid_json', 'JSON 文件格式不正确'); } }
    result = { status: text.trim() ? 'ok' : 'no_text', text, meta: { lines: text.split('\n').length }, extractor: 'utf8', note: '' };
  }
  if (result.text.length > LIMITS.maxTextChars) fail('text_limit', `提取出的文字超过 ${LIMITS.maxTextChars} 字，请拆分文件后上传`);
  return { filename, kind, mime, ...result, chars: result.text.length };
}

/* Character-window reading so large files are consumed in bounded slices. */
function sliceText(text, { offset = 0, limit = 8000 } = {}) {
  const o = Math.max(0, Math.floor(Number(offset) || 0)), l = Math.max(100, Math.min(50000, Math.floor(Number(limit) || 8000)));
  const part = text.slice(o, o + l);
  return { offset: o, length: part.length, total: text.length, nextOffset: o + part.length < text.length ? o + part.length : null, text: part };
}

module.exports = { extractFile, sliceText, safeFilename, readZip, readSpreadsheet, pdfAvailable: () => !!pdfTool(), ExtractError, EXTRACT_LIMITS: LIMITS, SUPPORTED_TYPES: SUPPORTED };
