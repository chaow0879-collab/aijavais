'use strict';
/* Actual downloadable files, not renamed text. No filesystem writes or external tools.
 * OOXML containers use ZIP STORE with UTF-8 names and CRC32. Content is deliberately
 * limited to text, cells and slides; macros, formulas, remote relationships and HTML
 * are never created. This is document generation, not execution of generated code.
 */
const LIMITS = Object.freeze({ maxInputBytes: 8 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxFiles: 256, maxRows: 10000, maxColumns: 100, maxSlides: 100 });
const TYPES = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', zip: 'application/zip',
});
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safePath(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 240 || /[\\\x00-\x1f\x7f:<>"|?*]/.test(name) || name.startsWith('/') || name.endsWith('/')) throw new Error('不安全的成果文件路径');
  if (name.split('/').some(p => !p || p === '.' || p === '..' || /^[. ]+$/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('不安全的成果文件路径');
  return name;
}
function asText(value, label = 'text') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError(label + ' 必须是字符串');
  // XML 1.0 cannot represent these characters. Reject rather than silently lose data.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error(label + ' 含不支持的控制字符');
  if (Buffer.byteLength(value) > LIMITS.maxInputBytes) throw new Error('成果输入超过大小上限');
  return value;
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function zip(entries) {
  if (!entries.length || entries.length > LIMITS.maxFiles) throw new Error('成果文件数量超过上限或为空');
  const locals = [], centrals = [], seen = new Set();
  let offset = 0, inputBytes = 0;
  for (const entry of entries) {
    const path = safePath(entry.path), identity = path.toLowerCase();
    if (seen.has(identity)) throw new Error('成果文件路径重复');
    seen.add(identity);
    const name = Buffer.from(path), data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(asText(entry.content, path));
    inputBytes += data.length;
    if (inputBytes > LIMITS.maxOutputBytes) throw new Error('成果输出超过大小上限');
    const crc = crc32(data), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8, no compression, deterministic 1980-01-01
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  if (offset + centralSize + end.length > LIMITS.maxOutputBytes) throw new Error('成果输出超过大小上限');
  return Buffer.concat([...locals, ...centrals, end]);
}
function rels(items) {
  return XML + `<Relationships xmlns="${NS_REL}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${OFFICE_REL}${type}" Target="${target}"/>`).join('')}</Relationships>`;
}
function contentTypes(overrides) {
  return XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + overrides.map(([path, type]) => `<Override PartName="/${path}" ContentType="${type}"/>`).join('') + '</Types>';
}
const file = (path, content) => ({ path, content });
function coreProps(title) {
  return file('docProps/core.xml', XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + esc(title) + '</dc:title><dc:creator>AIJAVAIS</dc:creator><cp:lastModifiedBy>AIJAVAIS</cp:lastModifiedBy></cp:coreProperties>');
}
function rootRels(target) {
  return file('_rels/.rels', XML + `<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${OFFICE_REL}officeDocument" Target="${target}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
}
function sectionsOf(options) {
  if (options.sections === undefined) return [];
  if (!Array.isArray(options.sections) || options.sections.length > 1000) throw new Error('sections 必须是最多1000项的数组');
  return options.sections.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('section 格式不正确');
    return { heading: asText(s.heading, `sections[${i}].heading`), text: asText(s.text, `sections[${i}].text`) };
  });
}
function rowsOf(options, text) {
  const rows = options.rows === undefined ? text.split(/\r?\n/).map(x => [x]) : options.rows;
  if (!Array.isArray(rows) || rows.length > LIMITS.maxRows) throw new Error('表格行数超过上限或格式不正确');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length > LIMITS.maxColumns) throw new Error('表格列数超过上限或格式不正确');
    return row.map(v => {
      if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('表格数值必须有限'); return v; }
      if (typeof v === 'boolean' || v === null) return v;
      return asText(v, 'cell');
    });
  });
}
function docx(title, text, sections) {
  const para = (v, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(v)}</w:t></w:r></w:p>`;
  const paragraphs = v => v.split(/\r?\n/).map(x => para(x)).join('');
  const document = XML + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + para(title, 'Title') + paragraphs(text) + sections.map(s => para(s.heading, 'Heading1') + paragraphs(s.text)).join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const styles = XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="等线"/><w:sz w:val="22"/><w:lang w:val="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:b/><w:color w:val="17365D"/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="17365D"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>';
  return zip([rootRels('word/document.xml'), coreProps(title), file('[Content_Types].xml', contentTypes([
    ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ])), file('word/document.xml', document), file('word/styles.xml', styles), file('word/_rels/document.xml.rels', rels([['rId1', 'styles', 'styles.xml']]))]);
}
function columnName(n) { let out = ''; for (n++; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; }
function xlsx(title, rows) {
  const name = [...(title.replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || '成果')].slice(0, 31).join('');
  const cols = Math.max(1, ...rows.map(r => r.length)), end = columnName(cols - 1) + Math.max(1, rows.length);
  const widths = Array.from({ length: cols }, (_, c) => Math.max(12, Math.min(52, Math.max(...rows.map(r => String(r[c] ?? '').length), 8) + 2)));
  const cell = (value, row, col) => {
    const at = `${columnName(col)}${row + 1}`, style = row === 0 ? ' s="1"' : '';
    if (typeof value === 'number') return `<c r="${at}"${style}><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${at}"${style} t="b"><v>${Number(value)}</v></c>`;
    return `<c r="${at}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value ?? '')}</t></is></c>`;
  };
  const sheet = XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:' + end + '"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>' + rows.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, i, c)).join('')}</row>`).join('') + '</sheetData>' + (rows.length > 1 ? `<autoFilter ref="A1:${end}"/>` : '') + '<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>';
  const styles = XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zip([rootRels('xl/workbook.xml'), coreProps(title), file('[Content_Types].xml', contentTypes([
    ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
    ['xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
    ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ])), file('xl/workbook.xml', XML + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL.slice(0, -1)}"><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`), file('xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'styles', 'styles.xml']])), file('xl/worksheets/sheet1.xml', sheet), file('xl/styles.xml', styles)]);
}

const DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRES = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const groupTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const colorMap = '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
function theme() {
  const colors = [['dk1','14243B'],['lt1','FFFFFF'],['dk2','17365D'],['lt2','E8EEF5'],['accent1','38BDF8'],['accent2','34D399'],['accent3','FBBF24'],['accent4','A78BFA'],['accent5','FB7185'],['accent6','94A3B8'],['hlink','0563C1'],['folHlink','954F72']];
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return XML + `<a:theme xmlns:a="${DRAW}" name="AIJAVAIS"><a:themeElements><a:clrScheme name="AIJAVAIS">${colors.map(([id,c]) => `<a:${id}><a:srgbClr val="${c}"/></a:${id}>`).join('')}</a:clrScheme><a:fontScheme name="AIJAVAIS"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="等线"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="等线"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="AIJAVAIS"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350,12700,19050].map(w => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}
function textShape(id, name, x, y, width, height, lines, size, color, bold = false) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>${lines.map(line => `<a:p><a:pPr><a:lnSpc><a:spcPct val="120000"/></a:lnSpc></a:pPr><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="等线"/></a:rPr><a:t>${esc(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`).join('')}</p:txBody></p:sp>`;
}
function wrapLines(text, maxWidth = 76) {
  return text.split(/\r?\n/).flatMap(line => {
    const out = []; let current = '', width = 0;
    for (const ch of line) {
      const w = ch.codePointAt(0) > 255 ? 2 : 1;
      if (width + w > maxWidth) { out.push(current); current = ''; width = 0; }
      current += ch; width += w;
    }
    out.push(current); return out;
  });
}
function slidesOf(options, title, text, sections) {
  let slides;
  if (options.slides !== undefined) {
    if (!Array.isArray(options.slides) || !options.slides.length || options.slides.length > LIMITS.maxSlides) throw new Error('slides 必须是1–100项数组');
    slides = options.slides.map(s => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('slide 格式不正确');
      const bullets = s.bullets === undefined ? [] : s.bullets;
      if (!Array.isArray(bullets) || bullets.length > 1000) throw new Error('bullets 格式不正确');
      return { title: asText(s.title) || title, body: [asText(s.body ?? s.text), ...bullets.map(v => '• ' + asText(v))].filter(Boolean).join('\n') };
    });
  } else slides = [{ title, body: text }, ...sections.map(s => ({ title: s.heading || title, body: s.text }))];
  const pages = [];
  for (const s of slides) {
    const lines = wrapLines(s.body), titles = wrapLines(s.title, 62);
    if (titles.length > 2) throw new Error('幻灯片标题过长，请精简为两行以内');
    for (let i = 0; i < lines.length; i += 10) pages.push({ title: titles, lines: lines.slice(i, i + 10) });
  }
  if (pages.length > LIMITS.maxSlides) throw new Error('分页后的幻灯片数量超过100页上限');
  return pages;
}
function pptx(title, pages) {
  const overrides = [['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'], ['ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'], ['ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'], ['ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'], ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ...pages.map((_, i) => [`ppt/slides/slide${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'])];
  const entries = [rootRels('ppt/presentation.xml'), coreProps(title), file('[Content_Types].xml', contentTypes(overrides)),
    file('ppt/presentation.xml', XML + `<p:presentation xmlns:a="${DRAW}" xmlns:r="${OFFICE_REL.slice(0,-1)}" xmlns:p="${PRES}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`),
    file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...pages.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`])])),
    file('ppt/slideMasters/slideMaster1.xml', XML + `<p:sldMaster xmlns:a="${DRAW}" xmlns:r="${OFFICE_REL.slice(0,-1)}" xmlns:p="${PRES}"><p:cSld name="AIJAVAIS"><p:spTree>${groupTree}</p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`),
    file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])),
    file('ppt/slideLayouts/slideLayout1.xml', XML + `<p:sldLayout xmlns:a="${DRAW}" xmlns:r="${OFFICE_REL.slice(0,-1)}" xmlns:p="${PRES}" type="blank" preserve="1"><p:cSld name="AIJAVAIS Blank"><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])), file('ppt/theme/theme1.xml', theme()),
  ];
  pages.forEach((s, i) => {
    entries.push(file(`ppt/slides/slide${i + 1}.xml`, XML + `<p:sld xmlns:a="${DRAW}" xmlns:r="${OFFICE_REL.slice(0,-1)}" xmlns:p="${PRES}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="14243B"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${groupTree}${textShape(2,'Title',640000,400000,10900000,1200000,s.title,3200,'38BDF8',true)}${textShape(3,'Body',640000,1820000,10900000,4300000,s.lines,2200,'E8EEF5')}${textShape(4,'Footer',640000,6410000,10900000,250000,[`AIJAVAIS   ·   ${i + 1} / ${pages.length}`],1100,'94A3B8')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`));
    entries.push(file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([['rId1','slideLayout','../slideLayouts/slideLayout1.xml']])));
  });
  return zip(entries);
}
function codeFiles(files) {
  const items = Array.isArray(files) ? files : files && typeof files === 'object' ? Object.entries(files).map(([path, content]) => ({ path, content })) : null;
  if (!items || !items.length || items.length > LIMITS.maxFiles) throw new Error('代码交付必须提供1–256个真实文件');
  let size = 0;
  const out = items.map(it => {
    if (!it || typeof it !== 'object') throw new Error('代码文件格式不正确');
    const path = safePath(it.path), content = Buffer.isBuffer(it.content) ? it.content : asText(it.content, 'file.content');
    size += Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
    if (size > LIMITS.maxInputBytes) throw new Error('成果输入超过大小上限');
    return file(path, content);
  });
  return out;
}
function createDeliverable(format, options = {}) {
  format = String(format).toLowerCase(); if (format === 'code') format = 'zip';
  if (!Object.hasOwn(TYPES, format)) throw new Error('不支持的成果格式：' + format);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('成果参数必须是对象');
  const title = asText(options.title, 'title') || 'AIJAVAIS 成果', text = asText(options.text), sections = sectionsOf(options);
  if (title.length > 500) throw new Error('成果标题超过500字符');
  let buffer;
  const sourceSize = Buffer.byteLength(JSON.stringify({ title, text, sections, rows: options.rows, slides: options.slides }));
  if (sourceSize > LIMITS.maxInputBytes) throw new Error('成果输入超过大小上限');
  if (format === 'docx') buffer = docx(title, text, sections);
  else if (format === 'xlsx') buffer = xlsx(title, rowsOf(options, text));
  else if (format === 'pptx') buffer = pptx(title, slidesOf(options, title, text, sections));
  else if (format === 'zip') buffer = zip(codeFiles(options.files));
  else if (format === 'csv') {
    const rows = rowsOf(options, text);
    const encode = value => {
      let v = String(value ?? '');
      if (typeof value === 'string' && (/^[\s]*[=+\-@]/u.test(v) || /^[\t\r\n]/.test(v))) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    };
    buffer = Buffer.from('\uFEFF' + rows.map(r => r.map(encode).join(',')).join('\r\n') + '\r\n');
  } else if (format === 'json') {
    const json = options.data === undefined ? { title, text, sections, ...(options.rows === undefined ? {} : { rows: rowsOf(options, text) }), ...(options.slides === undefined ? {} : { slides: options.slides }) } : options.data;
    const serialized = JSON.stringify(json, null, 2);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > LIMITS.maxInputBytes) throw new Error('JSON成果输入超过大小上限或不可序列化');
    buffer = Buffer.from(serialized);
  } else {
    const heading = format === 'md' ? '# ' : '';
    buffer = Buffer.from(heading + title + '\n\n' + text + sections.map(s => '\n\n' + (format === 'md' ? '## ' : '') + s.heading + '\n\n' + s.text).join('') + '\n');
  }
  if (buffer.length > LIMITS.maxOutputBytes) throw new Error('成果输出超过大小上限');
  let base = options.filename === undefined ? title : asText(options.filename, 'filename');
  base = [...base.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '')].slice(0, 100).join('') || 'deliverable';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = '_' + base;
  return { buffer, mime: TYPES[format], extension: format, filename: `${base}.${format}` };
}
module.exports = { createDeliverable, DELIVERABLE_LIMITS: LIMITS };
