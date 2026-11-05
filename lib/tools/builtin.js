'use strict';
/*
 * 内置工具（真实执行，不是提示词）。所有文件类工具只在当前任务的成果库 / 工作区内操作。
 *   成果：artifact.list / read / diff / write_text / import_file / export_file
 *   Word：docx.create / docx.revise / docx.replace_text      Excel：xlsx.create / xlsx.update_cells
 *   PPT：pptx.create / pptx.revise                           PDF：pdf.create / pdf.convert / pdf.merge
 *   检查：doc.render_check（LibreOffice 渲染 + 版式检查）     数据：data.analyze
 *   网络：web.fetch / web.search                              工作区：workspace.list / read_file / write_file
 *   执行：code.run（高风险）/ test.run（高风险）/ git.run     图片：image.info
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SB = require('./sandbox');
const O = require('./office');
const SEC = require('../security');
const SSE = require('../sse');
const EX = require('../extract');

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
const int = (d, extra = {}) => ({ type: 'integer', description: d, ...extra });
const ART = str('成果 ID（art_ 开头）', { pattern: '^art_[a-f0-9]{12}$' });
const by = ctx => ({ type: 'agent', id: ctx.instanceId || null, roleId: ctx.roleId || null, via: ctx.toolId });
const artInfo = a => ({ artifactId: a.artifactId, name: a.name, version: a.currentVersion, kind: a.kind, size: a.version ? a.version.size : undefined });
const fmtArt = a => `${a.name}（${a.artifactId}，v${a.currentVersion}${a.version ? '，' + a.version.size + ' 字节' : ''}）`;

function workspaceOf(deps, ctx) {
  if (!ctx.taskId) throw new Error('缺少任务上下文');
  const dir = path.join(deps.dataDir, 'workspaces', ctx.taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function wsPath(root, rel, { write = false } = {}) {
  const p = SB.resolveIn(root, rel);
  const relN = path.relative(root, p).replace(/\\/g, '/');
  if (write && (relN === '.git' || relN.startsWith('.git/'))) throw new Error('不允许直接写入 .git 目录');
  return p;
}
function htmlToText(html) {
  let h = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, '');
  const title = ((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  h = h.replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, '')} [${href}]`)
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|section|article|header|footer|blockquote)>/gi, '\n').replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  h = h.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ent[e.toLowerCase()] ?? m));
  return { title, text: h.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== '')).join('\n').trim() };
}

function registerBuiltinTools(reg, deps) {
  const A = deps.artifacts;
  const lo = async () => ((await O.libreOfficeAvailable()) ? { ok: true } : { ok: false, reason: '需要 LibreOffice（Docker 镜像已内置；本机请安装 LibreOffice）' });
  const has = cmd => async () => ((await SB.which(cmd)) ? { ok: true } : { ok: false, reason: `需要安装 ${cmd}` });
  const getArt = (ctx, id) => { const a = A.get(ctx.taskId, id); if (!a) throw new Error(`成果 ${id} 不存在或不属于当前任务`); return a; };

  /* ---------------- 成果 ---------------- */
  reg.register({ id: 'artifact.list', title: '列出任务文件', category: 'artifact', risk: 'read', description: '列出当前任务的全部成果文件（名称、ID、版本、类型、审核状态）。', inputSchema: S({}),
    run: async (a, ctx) => {
      const list = A.list(ctx.taskId);
      return { content: list.length ? list.map(x => `- ${x.name}（${x.artifactId}）v${x.currentVersion} ${x.kind} 审核：${x.reviewStatus}${x.deliverable ? ' [交付物]' : ''}`).join('\n') : '当前任务还没有任何文件。', data: list };
    } });
  reg.register({ id: 'artifact.read', title: '读取文件内容', category: 'artifact', risk: 'read', description: '按需读取成果文件内容：可指定页（幻灯片 / 工作表 / PDF 页）或字符偏移与长度。不要一次读取整份大文件。',
    inputSchema: S({ artifactId: ART, version: int('版本，默认最新', { minimum: 1 }), page: int('第几页 / 第几张幻灯片 / 第几个工作表', { minimum: 1 }), offset: int('字符偏移', { minimum: 0 }), limit: int('读取字符数（100–20000）', { minimum: 100, maximum: 20000 }) }, ['artifactId']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      const r = await A.readText(ctx.taskId, a.artifactId, { version: a.version, page: a.page, offset: a.offset, limit: a.limit || 8000 });
      if (r.error) return { content: r.error, isError: true };
      const head = `文件：${meta.name}（v${a.version || meta.currentVersion}，${r.kind}${r.pages ? `，共 ${r.pages} 页` : ''}）${r.page ? ` 第 ${r.page} 页${r.title ? '：' + r.title : ''}` : ''}\n字符 ${r.offset}–${r.offset + r.length} / ${r.total}${r.nextOffset != null ? `（未读完，继续读取用 offset=${r.nextOffset}）` : ''}\n---\n`;
      return { content: head + (r.text || '（无可提取的文字）'), data: { kind: r.kind, pages: r.pages, total: r.total, nextOffset: r.nextOffset } };
    } });
  reg.register({ id: 'artifact.diff', title: '比较文件版本', category: 'artifact', risk: 'read', description: '比较同一文件两个版本的文字差异（统一 diff 格式）。',
    inputSchema: S({ artifactId: ART, from: int('旧版本', { minimum: 1 }), to: int('新版本', { minimum: 1 }) }, ['artifactId']),
    run: async (a, ctx) => { getArt(ctx, a.artifactId); const d = await A.diff(ctx.taskId, a.artifactId, a.from, a.to); return { content: `v${d.from} → v${d.to}：新增 ${d.added} 行，删除 ${d.removed} 行\n${d.unified}`, data: d }; } });
  reg.register({ id: 'artifact.write_text', title: '写文本文件', category: 'artifact', risk: 'write', description: '新建文本 / Markdown / 代码 / JSON / CSV 文件，或给已有文件写入新版本（传 artifactId）。',
    inputSchema: S({ name: str('文件名（含扩展名，如 方案.md、main.py）'), content: str('完整文件内容'), artifactId: ART, note: str('修改说明'), deliverable: { type: 'boolean', description: '是否为交付给用户的成果' } }, ['content']),
    run: async (a, ctx) => {
      if (a.artifactId) { const r = A.addVersion(ctx.taskId, a.artifactId, { text: a.content, createdBy: by(ctx), note: a.note || '修订', stepId: ctx.stepId }); return { content: '已写入新版本：' + fmtArt(r), artifacts: [artInfo(r)] }; }
      if (!a.name) return { content: '新建文件需要 name', isError: true };
      if (!EX.isTextKind(EX.kindOf(a.name))) return { content: '这个工具只写文本类文件；Word / Excel / PPT 请用对应工具', isError: true };
      const r = A.create(ctx.taskId, { name: a.name, text: a.content, createdBy: by(ctx), stepId: ctx.stepId, note: a.note, deliverable: !!a.deliverable });
      return { content: '已创建：' + fmtArt(r), artifacts: [artInfo(r)] };
    } });
  reg.register({ id: 'artifact.import_file', title: '工作区文件存为成果', category: 'artifact', risk: 'write', description: '把工作区里的文件（代码、测试报告等）保存为任务成果，或作为已有成果的新版本。',
    inputSchema: S({ path: str('工作区内的相对路径'), artifactId: ART, name: str('成果名称（默认用文件名）'), note: str('说明'), deliverable: { type: 'boolean' } }, ['path']),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx); const p = wsPath(root, a.path);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { content: '工作区里没有这个文件：' + a.path, isError: true };
      const buf = fs.readFileSync(p);
      const r = a.artifactId ? A.addVersion(ctx.taskId, a.artifactId, { buffer: buf, createdBy: by(ctx), note: a.note || '从工作区更新', stepId: ctx.stepId })
        : A.create(ctx.taskId, { name: a.name || path.basename(p), buffer: buf, createdBy: by(ctx), stepId: ctx.stepId, note: a.note || '来自工作区 ' + a.path, deliverable: !!a.deliverable });
      return { content: '已保存为成果：' + fmtArt(r), artifacts: [artInfo(r)] };
    } });
  reg.register({ id: 'artifact.export_file', title: '成果放入工作区', category: 'artifact', risk: 'write', description: '把成果文件复制到工作区（供代码执行、测试、Git 使用）。',
    inputSchema: S({ artifactId: ART, path: str('工作区内的目标相对路径'), version: int('版本', { minimum: 1 }) }, ['artifactId', 'path']),
    run: async (a, ctx) => {
      getArt(ctx, a.artifactId);
      const root = workspaceOf(deps, ctx); const p = wsPath(root, a.path, { write: true });
      const { buffer, version } = A.read(ctx.taskId, a.artifactId, a.version);
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buffer);
      return { content: `已复制 ${version.name} v${version.version} 到工作区 ${a.path}（${buffer.length} 字节）` };
    } });

  /* ---------------- Word ---------------- */
  const blockSchema = { type: 'array', description: '结构化内容块：heading{text,level} / paragraph{text} / bullets{items} / numbered{items} / table{columns,rows} / quote{text} / pagebreak', items: { type: 'object', properties: { type: { type: 'string', enum: ['heading', 'paragraph', 'bullets', 'numbered', 'table', 'quote', 'pagebreak'] } }, required: ['type'] } };
  const docProps = { title: str('文档标题'), subtitle: str('副标题'), markdown: str('正文（Markdown：# 标题、- 列表、1. 编号、| 表格 |、**粗体**、> 引用、--- 分页）'), blocks: blockSchema };
  reg.register({ id: 'docx.create', title: '创建 Word 文档', category: 'office', risk: 'write', description: '生成真实可编辑的 Word（.docx）文件：标题层级、列表、表格、页码、中文字体由平台统一排版。',
    inputSchema: S({ name: str('文件名，如 组织结构方案.docx', { pattern: '\\.docx$' }), ...docProps, deliverable: { type: 'boolean' } }, ['name']),
    run: async (a, ctx) => {
      if (!a.markdown && !(a.blocks && a.blocks.length)) return { content: '需要 markdown 或 blocks 内容', isError: true };
      const spec = { title: a.title, subtitle: a.subtitle, markdown: a.markdown, blocks: a.blocks };
      const r = await O.buildDocx(spec);
      const art = A.create(ctx.taskId, { name: a.name, buffer: r.buffer, createdBy: by(ctx), stepId: ctx.stepId, source: { tool: 'docx', spec }, deliverable: !!a.deliverable });
      return { content: `已生成 Word：${fmtArt(art)}；标题 ${r.stats.headings} 个、表格 ${r.stats.tables} 个、内容块 ${r.stats.blocks} 个`, artifacts: [artInfo(art)], data: r.stats };
    } });
  reg.register({ id: 'docx.revise', title: '修订 Word 文档', category: 'office', risk: 'write', description: '按修改后的完整内容重新生成同一份 Word 文档的新版本（保留历史版本，可对比差异）。',
    inputSchema: S({ artifactId: ART, ...docProps, note: str('修改说明（例如：按审核意见第 2、3 条修改）') }, ['artifactId']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      if (meta.kind !== 'docx') return { content: '这不是 Word 文件', isError: true };
      const prev = (A.getSource(ctx.taskId, a.artifactId) || {}).spec || {};
      const spec = { title: a.title ?? prev.title, subtitle: a.subtitle ?? prev.subtitle, markdown: a.markdown ?? (a.blocks ? undefined : prev.markdown), blocks: a.blocks ?? (a.markdown ? undefined : prev.blocks) };
      if (!spec.markdown && !(spec.blocks && spec.blocks.length)) return { content: '没有可用的内容：请提供修改后的完整 markdown 或 blocks（上传的原稿请用 docx.replace_text）', isError: true };
      const r = await O.buildDocx(spec);
      const art = A.addVersion(ctx.taskId, a.artifactId, { buffer: r.buffer, createdBy: by(ctx), note: a.note || '修订', stepId: ctx.stepId, source: { tool: 'docx', spec } });
      return { content: `已生成新版本：${fmtArt(art)}`, artifacts: [artInfo(art)], data: r.stats };
    } });
  reg.register({ id: 'docx.replace_text', title: 'Word 查找替换', category: 'office', risk: 'write', description: '在已有 Word 文件（包括用户上传的原稿）中查找替换文字，生成新版本并报告每处替换次数。',
    inputSchema: S({ artifactId: ART, replacements: { type: 'array', minItems: 1, maxItems: 50, items: S({ find: str('原文字', { minLength: 1 }), replace: str('替换为') }, ['find', 'replace']) }, note: str('修改说明') }, ['artifactId', 'replacements']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      if (meta.kind !== 'docx') return { content: '这不是 Word 文件', isError: true };
      const { buffer } = A.read(ctx.taskId, a.artifactId);
      const r = await O.docxReplace(buffer, a.replacements);
      const total = r.counts.reduce((x, y) => x + y, 0);
      if (!total) return { content: '没有找到任何要替换的文字（可能被分成了不同格式片段），未生成新版本。替换次数：' + r.counts.join(', '), isError: true };
      const art = A.addVersion(ctx.taskId, a.artifactId, { buffer: r.buffer, createdBy: by(ctx), note: a.note || '查找替换', stepId: ctx.stepId });
      return { content: `已生成新版本：${fmtArt(art)}；替换次数：${a.replacements.map((x, i) => `「${x.find}」${r.counts[i]} 处`).join('，')}`, artifacts: [artInfo(art)] };
    } });

  /* ---------------- Excel ---------------- */
  const sheetSchema = { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { name: str('工作表名'), columns: { type: 'array', items: {} }, rows: { type: 'array', items: {} }, totals: { type: 'object' }, freeze: { type: 'boolean' }, autoFilter: { type: 'boolean' } }, required: ['name', 'rows'] }, description: '工作表：columns 为表头（字符串或 {header,width,numFmt}），rows 为二维数组；以 = 开头的字符串是公式（如 =B2*C2）；totals {label, sumColumns:[列号]} 自动合计' };
  reg.register({ id: 'xlsx.create', title: '创建 Excel 表格', category: 'office', risk: 'write', description: '生成真实可编辑的 Excel（.xlsx）：表头样式、冻结、筛选、公式、合计。',
    inputSchema: S({ name: str('文件名，如 编制测算.xlsx', { pattern: '\\.xlsx$' }), sheets: sheetSchema, deliverable: { type: 'boolean' } }, ['name', 'sheets']),
    run: async (a, ctx) => {
      const r = await O.buildXlsx({ sheets: a.sheets });
      const art = A.create(ctx.taskId, { name: a.name, buffer: r.buffer, createdBy: by(ctx), stepId: ctx.stepId, source: { tool: 'xlsx', spec: { sheets: a.sheets } }, deliverable: !!a.deliverable });
      return { content: `已生成 Excel：${fmtArt(art)}；工作表 ${r.stats.sheets} 个、数据行 ${r.stats.rows} 行、公式 ${r.stats.formulas} 个`, artifacts: [artInfo(art)], data: r.stats };
    } });
  reg.register({ id: 'xlsx.update_cells', title: '修改 Excel 单元格', category: 'office', risk: 'write', description: '修改已有 Excel 文件中的单元格（值或公式），生成新版本。',
    inputSchema: S({ artifactId: ART, updates: { type: 'array', minItems: 1, maxItems: 500, items: S({ sheet: { description: '工作表名或序号' }, cell: str('单元格，如 B3'), value: { description: '值；以 = 开头为公式' } }, ['cell', 'value']) }, note: str('说明') }, ['artifactId', 'updates']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      if (meta.kind !== 'xlsx') return { content: '这不是 Excel 文件', isError: true };
      const { buffer } = A.read(ctx.taskId, a.artifactId);
      const r = await O.xlsxUpdate(buffer, a.updates);
      const art = A.addVersion(ctx.taskId, a.artifactId, { buffer: r.buffer, createdBy: by(ctx), note: a.note || `修改 ${r.updated} 个单元格`, stepId: ctx.stepId });
      return { content: `已更新 ${r.updated} 个单元格：${fmtArt(art)}`, artifacts: [artInfo(art)] };
    } });

  /* ---------------- PPT ---------------- */
  const slideSchema = { type: 'object', description: '幻灯片：layout = title / section / bullets / two_column / table / chart / kpi / process / org_chart；字段见说明', properties: { layout: { type: 'string', enum: ['title', 'section', 'bullets', 'two_column', 'table', 'chart', 'kpi', 'process', 'org_chart'] }, title: { type: 'string' } } };
  const deckDoc = '版式：title{title,subtitle,date}；section{number,title,subtitle}；bullets{title,bullets:[文字或{text,level}],notes}；two_column{title,left{heading,bullets},right{heading,bullets}}；table{title,columns,rows}；chart{title,chart{type:column|bar|line|pie|doughnut|area,categories,series:[{name,values}]},caption}；kpi{title,items:[{label,value,note}]}；process{title,steps:[{title,text}]}；org_chart{title,nodes:[{id,label,parent,note}]}。每页都可加 notes（讲者备注）。';
  reg.register({ id: 'pptx.create', title: '创建 PPT', category: 'office', risk: 'write', description: '生成真实可编辑的 PowerPoint（.pptx）：统一版式、原生可编辑图表、表格、流程图、组织结构图、讲者备注，并返回可能溢出的页面。' + deckDoc,
    inputSchema: S({ name: str('文件名，如 汇报.pptx', { pattern: '\\.pptx$' }), title: str('演示文稿标题'), footer: str('页脚文字'), theme: { type: 'object', description: '{primary, accent, font}（颜色为 6 位十六进制）' }, slides: { type: 'array', minItems: 1, maxItems: 60, items: slideSchema }, deliverable: { type: 'boolean' } }, ['name', 'slides']),
    run: async (a, ctx) => {
      const spec = { title: a.title, footer: a.footer, theme: a.theme, slides: a.slides };
      const r = await O.buildPptx(spec);
      const art = A.create(ctx.taskId, { name: a.name, buffer: r.buffer, createdBy: by(ctx), stepId: ctx.stepId, source: { tool: 'pptx', spec }, deliverable: !!a.deliverable });
      return { content: `已生成 PPT：${fmtArt(art)}；共 ${r.stats.slides} 页${r.stats.warnings.length ? '\n版式提示：\n' + r.stats.warnings.map(w => '- ' + w.issue).join('\n') : '；未发现明显溢出'}`, artifacts: [artInfo(art)], data: r.stats };
    } });
  reg.register({ id: 'pptx.revise', title: '修订 PPT', category: 'office', risk: 'write', description: '修改已有 PPT 并生成新版本：可整体替换 slides，或按序号替换 / 插入 / 删除个别页面，也可改主题。' + deckDoc,
    inputSchema: S({ artifactId: ART, slides: { type: 'array', items: slideSchema }, replace: { type: 'array', items: S({ index: int('第几页（从 1 开始）', { minimum: 1 }), slide: slideSchema }, ['index', 'slide']) }, insert: { type: 'array', items: S({ after: int('插在第几页之后（0 表示最前）', { minimum: 0 }), slide: slideSchema }, ['after', 'slide']) }, remove: { type: 'array', items: { type: 'integer', minimum: 1 } }, theme: { type: 'object' }, title: str('标题'), footer: str('页脚'), note: str('修改说明') }, ['artifactId']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      if (meta.kind !== 'pptx') return { content: '这不是 PPT 文件', isError: true };
      const src = A.getSource(ctx.taskId, a.artifactId);
      if (!src || src.tool !== 'pptx') return { content: '这份 PPT 不是由平台生成的，缺少结构化来源，无法按页修订；请用 pptx.create 重新生成', isError: true };
      const spec = structuredClone(src.spec);
      if (a.slides) spec.slides = a.slides;
      for (const r of a.replace || []) { if (r.index > spec.slides.length) return { content: `没有第 ${r.index} 页`, isError: true }; spec.slides[r.index - 1] = r.slide; }
      for (const idx of [...(a.remove || [])].sort((x, y) => y - x)) spec.slides.splice(idx - 1, 1);
      for (const ins of [...(a.insert || [])].sort((x, y) => y.after - x.after)) spec.slides.splice(Math.min(ins.after, spec.slides.length), 0, ins.slide);
      if (a.theme) spec.theme = { ...(spec.theme || {}), ...a.theme };
      if (a.title !== undefined) spec.title = a.title;
      if (a.footer !== undefined) spec.footer = a.footer;
      const r = await O.buildPptx(spec);
      const art = A.addVersion(ctx.taskId, a.artifactId, { buffer: r.buffer, createdBy: by(ctx), note: a.note || '修订', stepId: ctx.stepId, source: { tool: 'pptx', spec } });
      return { content: `已生成新版本：${fmtArt(art)}；共 ${r.stats.slides} 页${r.stats.warnings.length ? '\n版式提示：\n' + r.stats.warnings.map(w => '- ' + w.issue).join('\n') : ''}`, artifacts: [artInfo(art)], data: r.stats };
    } });

  /* ---------------- PDF ---------------- */
  reg.register({ id: 'pdf.create', title: '创建 PDF', category: 'office', risk: 'write', description: '把 Markdown 内容排版成 PDF（先生成 Word 再用 LibreOffice 转换，中文排版与 Word 一致）。', available: lo, timeoutMs: 180000,
    inputSchema: S({ name: str('文件名，如 报告.pdf', { pattern: '\\.pdf$' }), title: str('标题'), markdown: str('正文 Markdown'), deliverable: { type: 'boolean' } }, ['name', 'markdown']),
    run: async (a, ctx) => {
      const d = await O.buildDocx({ title: a.title, markdown: a.markdown });
      const pdf = await O.convertToPdf(d.buffer, 'docx', { signal: ctx.signal });
      const art = A.create(ctx.taskId, { name: a.name, buffer: pdf, createdBy: by(ctx), stepId: ctx.stepId, source: { tool: 'pdf', spec: { title: a.title, markdown: a.markdown } }, deliverable: !!a.deliverable });
      return { content: '已生成 PDF：' + fmtArt(art), artifacts: [artInfo(art)] };
    } });
  reg.register({ id: 'pdf.convert', title: '转换为 PDF', category: 'office', risk: 'write', description: '把 Word / Excel / PPT 成果转换为 PDF（LibreOffice），作为新成果保存。', available: lo, timeoutMs: 180000,
    inputSchema: S({ artifactId: ART, version: int('版本', { minimum: 1 }), deliverable: { type: 'boolean' } }, ['artifactId']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      if (!['docx', 'xlsx', 'pptx'].includes(meta.kind)) return { content: '只能转换 Word / Excel / PPT', isError: true };
      const { buffer, version } = A.read(ctx.taskId, a.artifactId, a.version);
      const pdf = await O.convertToPdf(buffer, meta.kind, { signal: ctx.signal });
      const art = A.create(ctx.taskId, { name: meta.name.replace(/\.\w+$/, '') + '.pdf', buffer: pdf, createdBy: by(ctx), stepId: ctx.stepId, note: `由 ${meta.name} v${version.version} 转换`, deliverable: !!a.deliverable });
      return { content: '已转换：' + fmtArt(art), artifacts: [artInfo(art)] };
    } });
  reg.register({ id: 'pdf.merge', title: '合并 PDF', category: 'office', risk: 'write', description: '把多个 PDF 成果按顺序合并成一个。',
    inputSchema: S({ artifactIds: { type: 'array', minItems: 2, maxItems: 30, items: ART }, name: str('合并后的文件名', { pattern: '\\.pdf$' }), deliverable: { type: 'boolean' } }, ['artifactIds', 'name']),
    run: async (a, ctx) => {
      const { PDFDocument } = require('pdf-lib');
      const out = await PDFDocument.create();
      for (const id of a.artifactIds) {
        const meta = getArt(ctx, id);
        if (meta.kind !== 'pdf') return { content: `${meta.name} 不是 PDF`, isError: true };
        const src = await PDFDocument.load(A.read(ctx.taskId, id).buffer);
        for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
      }
      const art = A.create(ctx.taskId, { name: a.name, buffer: Buffer.from(await out.save()), createdBy: by(ctx), stepId: ctx.stepId, deliverable: !!a.deliverable });
      return { content: `已合并 ${a.artifactIds.length} 个文件，共 ${out.getPageCount()} 页：${fmtArt(art)}`, artifacts: [artInfo(art)] };
    } });

  /* ---------------- 渲染检查 ---------------- */
  reg.register({ id: 'doc.render_check', title: '渲染检查', category: 'quality', risk: 'read', timeoutMs: 240000,
    description: '把 Word / PPT / Excel / PDF 真实渲染成页面图片并检查：页数、空白页、可能溢出的版面（PPT）。渲染图保存为成果，供审核与质量检查查看。',
    available: async () => ((await SB.which('pdftoppm')) ? { ok: true } : { ok: false, reason: '需要 poppler 的 pdftoppm' }),
    inputSchema: S({ artifactId: ART, version: int('版本', { minimum: 1 }), maxPages: int('最多渲染页数（默认 20）', { minimum: 1, maximum: 60 }) }, ['artifactId']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      if (!['docx', 'xlsx', 'pptx', 'pdf'].includes(meta.kind)) return { content: '只能检查 Word / Excel / PPT / PDF', isError: true };
      const { buffer, version } = A.read(ctx.taskId, a.artifactId, a.version);
      if (meta.kind !== 'pdf' && !(await O.libreOfficeAvailable())) return { content: '需要 LibreOffice 才能渲染 Office 文件', isError: true };
      const pdf = meta.kind === 'pdf' ? buffer : await O.convertToPdf(buffer, meta.kind, { signal: ctx.signal });
      const pages = await O.renderPdfPages(pdf, { maxPages: a.maxPages || 20, dpi: 60, signal: ctx.signal });
      const issues = [];
      const imgs = [];
      pages.forEach((png, i) => {
        const sz = O.pngSize(png) || { width: 0, height: 0 };
        if (O.looksBlank(png, sz.width, sz.height)) issues.push(`第 ${i + 1} 页几乎空白`);
        const art = A.create(ctx.taskId, { name: `${meta.name.replace(/\.\w+$/, '')}-v${version.version}-第${i + 1}页.png`, buffer: png, createdBy: by(ctx), stepId: ctx.stepId, note: '渲染检查' });
        imgs.push(artInfo(art));
      });
      const src = A.getSource(ctx.taskId, a.artifactId, version.version);
      if (src && src.tool === 'pptx') {
        const re = await O.buildPptx(src.spec); // 重新计算版式提示（与生成时同一套规则）
        for (const w of re.stats.warnings) issues.push(w.issue);
        if (re.stats.slides !== pages.length && pages.length < (a.maxPages || 20)) issues.push(`渲染页数 ${pages.length} 与幻灯片数 ${re.stats.slides} 不一致`);
      }
      const report = { artifactId: a.artifactId, version: version.version, kind: meta.kind, pages: pages.length, issues, images: imgs.map(x => x.artifactId), checkedAt: Date.now() };
      return { content: `渲染完成：${meta.name} v${version.version} 共渲染 ${pages.length} 页。\n${issues.length ? '发现问题：\n' + issues.map(x => '- ' + x).join('\n') : '未发现空白页或溢出提示。'}\n渲染图：${imgs.map(x => x.artifactId).join(', ')}`, artifacts: imgs, data: report };
    } });

  /* ---------------- 数据分析 ---------------- */
  reg.register({ id: 'data.analyze', title: '数据分析', category: 'data', risk: 'read',
    description: '对 CSV / Excel 成果做统计分析：describe（各列计数 / 缺失 / 唯一值 / 均值 / 最小 / 最大 / 中位数）、group（分组汇总 sum/mean/count/min/max）、top（排序取前 N）。可把结果另存为 Excel。',
    inputSchema: S({ artifactId: ART, sheet: str('Excel 工作表名（默认第一个）'), operations: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { type: { type: 'string', enum: ['describe', 'group', 'top'] }, by: { type: 'string' }, metrics: { type: 'array' }, col: { type: 'string' }, n: { type: 'integer' }, desc: { type: 'boolean' } }, required: ['type'] } }, saveAs: str('把结果另存为 Excel 的文件名（可选）', { pattern: '\\.xlsx$' }) }, ['artifactId', 'operations']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId);
      const { buffer } = A.read(ctx.taskId, a.artifactId);
      let header = [], rows = [];
      if (meta.kind === 'table' || /\.(csv|tsv)$/i.test(meta.name)) {
        const Papa = require('papaparse');
        const p = Papa.parse(buffer.toString('utf8').replace(/^﻿/, ''), { skipEmptyLines: true, delimiter: /\.tsv$/i.test(meta.name) ? '\t' : '' });
        [header, ...rows] = p.data;
      } else if (meta.kind === 'xlsx') {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
        const ws = a.sheet ? wb.getWorksheet(a.sheet) : wb.worksheets[0];
        if (!ws) return { content: '工作表不存在', isError: true };
        ws.eachRow({ includeEmpty: false }, row => { const v = []; row.eachCell({ includeEmpty: true }, c => { let x = c.value; if (x && typeof x === 'object') x = x.result ?? x.text ?? (x.richText ? x.richText.map(t => t.text).join('') : ''); v.push(x); }); (header.length ? rows : header).push(...(header.length ? [v] : v)); });
      } else return { content: '只支持 CSV / TSV / Excel', isError: true };
      header = header.map((h, i) => String(h ?? `列${i + 1}`).trim() || `列${i + 1}`);
      const col = name => { const i = header.indexOf(name); if (i < 0) throw new Error(`没有列「${name}」，现有列：${header.join('、')}`); return i; };
      const num = v => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,，%\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
      const results = []; const tables = [];
      for (const op of a.operations) {
        if (op.type === 'describe') {
          const t = header.map((h, i) => {
            const vals = rows.map(r => r[i]); const nums = vals.map(num).filter(x => x !== null).sort((x, y) => x - y);
            const filled = vals.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
            const o = { 列: h, 非空: filled.length, 缺失: vals.length - filled.length, 唯一值: new Set(filled.map(String)).size };
            if (nums.length >= Math.max(1, filled.length * 0.8)) Object.assign(o, { 均值: +(nums.reduce((s, x) => s + x, 0) / nums.length).toFixed(4), 最小: nums[0], 最大: nums[nums.length - 1], 中位数: nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2, 合计: +nums.reduce((s, x) => s + x, 0).toFixed(4) });
            return o;
          });
          results.push({ op: 'describe', rows: rows.length, table: t }); tables.push({ name: '描述统计', table: t });
        } else if (op.type === 'group') {
          const bi = col(op.by); const metrics = (op.metrics || [{ col: header.find((_, i) => i !== bi), agg: 'count' }]).map(m => ({ ...m, i: col(m.col), agg: m.agg || 'sum' }));
          const g = new Map();
          for (const r of rows) { const k = String(r[bi] ?? '（空）'); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
          const t = [...g.entries()].map(([k, rs]) => {
            const o = { [op.by]: k };
            for (const m of metrics) { const ns = rs.map(r => num(r[m.i])).filter(x => x !== null); o[`${m.col}_${m.agg}`] = m.agg === 'count' ? rs.length : !ns.length ? null : m.agg === 'mean' ? +(ns.reduce((s, x) => s + x, 0) / ns.length).toFixed(4) : m.agg === 'min' ? Math.min(...ns) : m.agg === 'max' ? Math.max(...ns) : +ns.reduce((s, x) => s + x, 0).toFixed(4); }
            return o;
          });
          results.push({ op: 'group', by: op.by, table: t }); tables.push({ name: `按${op.by}汇总`, table: t });
        } else if (op.type === 'top') {
          const ci = col(op.col); const n = Math.max(1, Math.min(100, op.n || 10));
          const t = rows.filter(r => num(r[ci]) !== null).sort((x, y) => (op.desc === false ? 1 : -1) * (num(x[ci]) - num(y[ci]))).slice(0, n).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
          results.push({ op: 'top', col: op.col, table: t }); tables.push({ name: `${op.col}前${n}`, table: t });
        }
      }
      const arts = [];
      if (a.saveAs && tables.length) {
        const r = await O.buildXlsx({ sheets: tables.map(t => ({ name: t.name, columns: Object.keys(t.table[0] || { 无数据: '' }), rows: t.table.map(o => Object.values(o)) })) });
        const art = A.create(ctx.taskId, { name: a.saveAs, buffer: r.buffer, createdBy: by(ctx), stepId: ctx.stepId, note: '数据分析结果' });
        arts.push(artInfo(art));
      }
      const show = t => { const keys = Object.keys(t[0] || {}); return [keys.join('\t'), ...t.slice(0, 50).map(o => keys.map(k => o[k] ?? '').join('\t'))].join('\n') + (t.length > 50 ? `\n…共 ${t.length} 行` : ''); };
      return { content: `数据：${meta.name}，${rows.length} 行 × ${header.length} 列（${header.join('、')}）\n\n` + results.map(r => `【${r.op}${r.by ? ' ' + r.by : ''}${r.col ? ' ' + r.col : ''}】\n${show(r.table)}`).join('\n\n') + (arts.length ? `\n\n结果已保存：${arts[0].name}（${arts[0].artifactId}）` : ''), data: results, artifacts: arts };
    } });

  /* ---------------- 网络 ---------------- */
  reg.register({ id: 'web.fetch', title: '读取网页', category: 'web', risk: 'network', timeoutMs: 40000,
    description: '读取公开网页（https）的正文文字，并把快照保存为成果（含网址、时间、哈希），作为引用依据。支持分页读取长网页。只能访问公网地址。',
    inputSchema: S({ url: str('https 网址'), offset: int('字符偏移', { minimum: 0 }), limit: int('读取字符数', { minimum: 500, maximum: 20000 }), saveSnapshot: { type: 'boolean', description: '是否保存快照为成果（默认是）' } }, ['url']),
    run: async (a, ctx) => {
      let url = a.url, res, hops = 0;
      for (;;) {
        res = await SEC.pinnedFetch(url, { method: 'GET', headers: { 'user-agent': 'AIJAVAIS/2.0 (research tool)', accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' }, signal: ctx.signal, maxBytes: 3 << 20, returnRedirects: true }, deps.policy);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc || ++hops > 5) throw new Error('重定向过多或缺少目标地址');
          url = new URL(loc, url).toString(); // 下一跳同样经过完整的 SSRF 校验
          continue;
        }
        break;
      }
      const raw = await SSE.readLimitedText(res, 3 << 20);
      if (!res.ok) return { content: `HTTP ${res.status}：${raw.replace(/\s+/g, ' ').slice(0, 300)}`, isError: true };
      const ct = res.headers.get('content-type') || '';
      const { title, text } = /html/i.test(ct) || /<html/i.test(raw.slice(0, 500)) ? htmlToText(raw) : { title: '', text: raw };
      const sha = crypto.createHash('sha256').update(text).digest('hex');
      const arts = [];
      if (a.saveSnapshot !== false) {
        const host = new URL(url).hostname;
        const art = A.create(ctx.taskId, { name: `来源-${host}-${sha.slice(0, 8)}.md`, text: `# ${title || host}\n\n- 网址：${url}\n- 读取时间：${new Date().toISOString()}\n- 内容 SHA-256：${sha}\n\n---\n\n${text}`, createdBy: by(ctx), stepId: ctx.stepId, note: '网页快照（引用依据）', source: { tool: 'web.fetch', url, fetchedAt: Date.now(), sha256: sha } });
        arts.push(artInfo(art));
      }
      const part = EX.slice(text, { offset: a.offset, limit: a.limit || 8000 });
      return { content: `网页：${title || '(无标题)'}\n网址：${url}${hops ? `（经 ${hops} 次跳转）` : ''}\n${arts.length ? `快照成果：${arts[0].artifactId}\n` : ''}字符 ${part.offset}–${part.offset + part.length} / ${part.total}${part.nextOffset != null ? `（继续读取用 offset=${part.nextOffset}）` : ''}\n---\n${part.text}`, artifacts: arts, data: { url, title, sha256: sha, total: part.total } };
    } });
  reg.register({ id: 'web.search', title: '网页检索', category: 'web', risk: 'network', timeoutMs: 30000,
    description: '用已配置的检索服务（Brave / Tavily / SearXNG）检索网页，返回标题、网址与摘要。只返回检索服务真实给出的结果。',
    available: async () => { const c = deps.webSearch(); return c && c.provider ? { ok: true } : { ok: false, reason: '尚未配置检索服务（设置 → 网页检索：Brave / Tavily API Key 或自建 SearXNG 地址）' }; },
    inputSchema: S({ query: str('检索词', { minLength: 1, maxLength: 300 }), count: int('结果数（1–10）', { minimum: 1, maximum: 10 }) }, ['query']),
    run: async (a, ctx) => {
      const c = deps.webSearch(); const n = a.count || 6;
      let results = [];
      const getJson = async (url, opts) => { const r = await SEC.pinnedFetch(url, { ...opts, signal: ctx.signal, maxBytes: 2 << 20 }, deps.policy); const t = await SSE.readLimitedText(r, 2 << 20); if (!r.ok) throw new Error(`检索服务返回 HTTP ${r.status}：${SEC.scrubSecrets(t.slice(0, 200), [c.apiKey])}`); return JSON.parse(t); };
      if (c.provider === 'brave') {
        const j = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(a.query)}&count=${n}`, { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': c.apiKey } });
        results = ((j.web && j.web.results) || []).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
      } else if (c.provider === 'tavily') {
        const j = await getJson('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: c.apiKey, query: a.query, max_results: n }) });
        results = (j.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
      } else if (c.provider === 'searxng') {
        const j = await getJson(`${String(c.baseUrl).replace(/\/+$/, '')}/search?q=${encodeURIComponent(a.query)}&format=json`, { method: 'GET', headers: { accept: 'application/json' } });
        results = (j.results || []).slice(0, n).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
      } else throw new Error('未知检索服务：' + c.provider);
      results = results.slice(0, n).map(r => ({ title: String(r.title || '').replace(/<[^>]+>/g, ''), url: String(r.url || ''), snippet: String(r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 300) }));
      return { content: results.length ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n') + '\n（摘要来自检索服务；引用前请用 web.fetch 读取原文核实）' : '没有检索到结果。', data: results };
    } });

  /* ---------------- 工作区 ---------------- */
  reg.register({ id: 'workspace.list', title: '列出工作区', category: 'workspace', risk: 'read', description: '列出当前任务工作区（代码、测试等临时文件）中的文件。',
    inputSchema: S({ path: str('子目录（默认根目录）') }),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx); const base = a.path ? wsPath(root, a.path) : root;
      if (!fs.existsSync(base)) return { content: '目录不存在', isError: true };
      const out = [];
      const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === 'node_modules' || out.length > 500) continue; const p = path.join(d, e.name); const rel = path.relative(root, p).replace(/\\/g, '/'); if (e.isDirectory()) { out.push(rel + '/'); if (depth < 6) walk(p, depth + 1); } else if (e.isFile()) out.push(`${rel}（${fs.statSync(p).size} 字节）`); } };
      walk(base, 0);
      return { content: out.length ? out.join('\n') : '（空）', data: out };
    } });
  reg.register({ id: 'workspace.read_file', title: '读取工作区文件', category: 'workspace', risk: 'read', description: '读取工作区里的文本文件（可分段）。',
    inputSchema: S({ path: str('相对路径'), offset: int('字符偏移', { minimum: 0 }), limit: int('字符数', { minimum: 100, maximum: 20000 }) }, ['path']),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx); const p = wsPath(root, a.path);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { content: '文件不存在：' + a.path, isError: true };
      const part = EX.slice(fs.readFileSync(p, 'utf8'), { offset: a.offset, limit: a.limit || 8000 });
      return { content: `${a.path} 字符 ${part.offset}–${part.offset + part.length} / ${part.total}${part.nextOffset != null ? `（继续 offset=${part.nextOffset}）` : ''}\n---\n${part.text}` };
    } });
  reg.register({ id: 'workspace.write_file', title: '写入工作区文件', category: 'workspace', risk: 'write', description: '在工作区写入文本文件（代码、配置、测试用例等）。不能写入 .git 目录。',
    inputSchema: S({ path: str('相对路径，如 src/app.js'), content: str('完整文件内容', { maxLength: 2000000 }) }, ['path', 'content']),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx); const p = wsPath(root, a.path, { write: true });
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a.content);
      return { content: `已写入 ${a.path}（${Buffer.byteLength(a.content)} 字节）` };
    } });

  /* ---------------- 执行 ---------------- */
  reg.register({ id: 'code.run', title: '执行代码', category: 'exec', risk: 'exec', timeoutMs: 130000,
    description: '在任务工作区运行 JavaScript（Node）或 Python 代码，返回退出码与输出。有超时与内存限制；工作区内的文件可读写。高风险工具，默认需要用户批准。',
    available: async () => ({ ok: true }),
    inputSchema: S({ language: { type: 'string', enum: ['javascript', 'python'] }, code: str('代码', { maxLength: 200000 }), timeoutSec: int('超时秒数（默认 30，最多 120）', { minimum: 1, maximum: 120 }), stdin: str('标准输入') }, ['language', 'code']),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx);
      const bin = a.language === 'python' ? (await SB.which('python3')) || (await SB.which('python')) : process.execPath;
      if (!bin) return { content: '本机没有 Python', isError: true };
      const file = `.aij-run-${Date.now().toString(36)}.${a.language === 'python' ? 'py' : 'js'}`;
      fs.writeFileSync(path.join(root, file), a.code);
      const r = await SB.run(bin, [file], { cwd: root, timeoutMs: (a.timeoutSec || 30) * 1000, input: a.stdin, signal: ctx.signal });
      try { fs.unlinkSync(path.join(root, file)); } catch { /* 忽略 */ }
      const status = r.timedOut ? '超时被终止' : r.cancelled ? '已取消' : `退出码 ${r.code}`;
      return { content: `${status}（${r.ms} ms）\n--- 标准输出 ---\n${r.stdout || '（无）'}\n--- 标准错误 ---\n${r.stderr || '（无）'}${r.truncated ? '\n（输出过长已截断）' : ''}`, isError: r.code !== 0, data: { exitCode: r.code, timedOut: r.timedOut, ms: r.ms } };
    } });
  reg.register({ id: 'test.run', title: '运行测试', category: 'exec', risk: 'exec', timeoutMs: 330000,
    description: '在工作区运行自动化测试（node --test / npm test / pytest / unittest），解析通过与失败数量并生成测试报告成果。测试结果是质量检查的客观证据。',
    inputSchema: S({ runner: { type: 'string', enum: ['node', 'npm', 'pytest', 'unittest'] }, path: str('测试目录或文件（相对路径，默认整个工作区）'), timeoutSec: int('超时秒数（默认 120，最多 300）', { minimum: 5, maximum: 300 }) }, ['runner']),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx);
      const target = a.path ? path.relative(root, wsPath(root, a.path)).replace(/\\/g, '/') : null;
      let bin, args;
      if (a.runner === 'node') {
        bin = process.execPath;
        // node --test 不会展开目录：目录用通配符，文件直接传，未指定则用默认发现规则
        const isDir = target && fs.statSync(path.join(root, target)).isDirectory();
        args = ['--test', ...(target ? (isDir ? [`${target}/**/*.js`, `${target}/**/*.mjs`, `${target}/**/*.cjs`] : [target]) : [])];
      }
      else if (a.runner === 'npm') { bin = (await SB.which('npm')); args = ['test', '--silent']; if (!fs.existsSync(path.join(root, 'package.json'))) return { content: '工作区没有 package.json', isError: true }; }
      else { bin = (await SB.which('python3')) || (await SB.which('python')); args = a.runner === 'pytest' ? ['-m', 'pytest', '-q', ...(target ? [target] : [])] : ['-m', 'unittest', 'discover', '-s', target || '.', '-v']; }
      if (!bin) return { content: '缺少测试运行环境：' + a.runner, isError: true };
      const r = await SB.run(bin, args, { cwd: root, timeoutMs: (a.timeoutSec || 120) * 1000, signal: ctx.signal, maxOutput: 200 * 1024 });
      const all = r.stdout + '\n' + r.stderr;
      let passed = null, failed = null;
      let m;
      if ((m = all.match(/^# pass (\d+)/m))) { passed = +m[1]; failed = +((all.match(/^# fail (\d+)/m) || [0, 0])[1]); }
      else if ((m = all.match(/ℹ pass (\d+)/))) { passed = +m[1]; failed = +((all.match(/ℹ fail (\d+)/) || [0, 0])[1]); }
      else if (/(\d+) passed/.test(all) || /(\d+) failed/.test(all)) { passed = +((all.match(/(\d+) passed/) || [0, 0])[1]); failed = +((all.match(/(\d+) failed/) || [0, 0])[1]) + +((all.match(/(\d+) errors?/) || [0, 0])[1]); }
      else if ((m = all.match(/Ran (\d+) tests?/))) { const fm = all.match(/FAILED \((?:failures=(\d+))?(?:, )?(?:errors=(\d+))?\)/); failed = fm ? (+(fm[1] || 0) + +(fm[2] || 0)) : 0; passed = +m[1] - failed; }
      const ok = r.code === 0 && !r.timedOut && (failed === null || failed === 0) && (passed === null || passed > 0);
      const report = `# 测试报告\n\n- 运行方式：${a.runner}${target ? ' ' + target : ''}\n- 结果：${ok ? '通过' : '未通过'}\n- 通过：${passed ?? '未知'}；失败：${failed ?? '未知'}；退出码：${r.code}${r.timedOut ? '（超时）' : ''}\n- 耗时：${r.ms} ms\n- 时间：${new Date().toISOString()}\n\n## 输出\n\n\`\`\`\n${all.slice(-30000)}\n\`\`\`\n`;
      const art = A.create(ctx.taskId, { name: `测试报告-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`, text: report, createdBy: by(ctx), stepId: ctx.stepId, note: '自动化测试报告', source: { tool: 'test.run', runner: a.runner, passed, failed, exitCode: r.code, ok } });
      return { content: `测试${ok ? '通过' : '未通过'}：通过 ${passed ?? '未知'}，失败 ${failed ?? '未知'}，退出码 ${r.code}${r.timedOut ? '（超时）' : ''}\n报告：${art.artifactId}\n--- 输出（末尾）---\n${all.slice(-4000)}`, isError: !ok, artifacts: [artInfo(art)], data: { ok, passed, failed, exitCode: r.code, reportArtifactId: art.artifactId } };
    } });
  reg.register({ id: 'git.run', title: 'Git 版本控制', category: 'exec', risk: 'write', available: has('git'),
    description: '在工作区执行受限的 Git 操作：init / status / add / commit / diff / log（禁用钩子，不能执行任意 Git 参数）。',
    inputSchema: S({ command: { type: 'string', enum: ['init', 'status', 'add', 'commit', 'diff', 'log'] }, paths: { type: 'array', items: { type: 'string' }, maxItems: 200 }, message: str('提交说明（commit 时必填）', { maxLength: 500 }) }, ['command']),
    run: async (a, ctx) => {
      const root = workspaceOf(deps, ctx);
      const base = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=AIJAVAIS', '-c', 'user.email=ai@aijavais.local', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
      const paths = (a.paths || []).map(p => path.relative(root, wsPath(root, p)).replace(/\\/g, '/'));
      const argv = { init: ['init', '-q'], status: ['status', '--porcelain=v1', '-b'], add: ['add', '--', ...(paths.length ? paths : ['.'])], commit: ['commit', '-q', '-m', String(a.message || '')], diff: ['diff', '--stat', 'HEAD', '--'], log: ['log', '--oneline', '-n', '30'] }[a.command];
      if (a.command === 'commit' && !a.message) return { content: '提交需要说明 message', isError: true };
      const r = await SB.run('git', [...base, ...argv], { cwd: root, timeoutMs: 60000, signal: ctx.signal });
      let extra = '';
      if (a.command === 'diff' && r.code === 0) { const d = await SB.run('git', [...base, 'diff', 'HEAD'], { cwd: root, timeoutMs: 60000 }); extra = '\n' + d.stdout.slice(0, 8000); }
      if (a.command === 'commit' && r.code === 0) { const h = await SB.run('git', [...base, 'rev-parse', '--short', 'HEAD'], { cwd: root, timeoutMs: 10000 }); extra = '\n提交：' + h.stdout.trim(); }
      return { content: `git ${a.command}：退出码 ${r.code}\n${(r.stdout + r.stderr).trim() || '（无输出）'}${extra}`, isError: r.code !== 0, data: { exitCode: r.code } };
    } });

  /* ---------------- 图片 ---------------- */
  reg.register({ id: 'image.info', title: '图片信息', category: 'image', risk: 'read', description: '读取图片成果的格式与尺寸（PNG / JPEG / GIF）。平台目前不提供图片生成（需要接入图像模型）。',
    inputSchema: S({ artifactId: ART }, ['artifactId']),
    run: async (a, ctx) => {
      const meta = getArt(ctx, a.artifactId); const { buffer: b } = A.read(ctx.taskId, a.artifactId);
      let info = null;
      if (b.readUInt32BE(0) === 0x89504e47) info = { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      else if (b[0] === 0x47 && b[1] === 0x49) info = { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      else if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i < b.length) { if (b[i] !== 0xff) break; const mk = b[i + 1], len = b.readUInt16BE(i + 2); if (mk >= 0xc0 && mk <= 0xc3) { info = { format: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }; break; } i += 2 + len; } }
      return info ? { content: `${meta.name}：${info.format} ${info.width}×${info.height}，${b.length} 字节`, data: info } : { content: '无法识别的图片格式', isError: true };
    } });
}

module.exports = { registerBuiltinTools, htmlToText, workspaceOf };
