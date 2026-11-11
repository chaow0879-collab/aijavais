'use strict';
const crypto = require('node:crypto');
// Called only after the existing session, display-role and same-origin gates.
const { ProjectStore, ProjectError } = require('./project-store');
const { ProjectEngine } = require('./project-engine');
const { ToolRegistry, loadMcpServers } = require('./tools-v2');
const { SkillRegistry } = require('./skills-v2');
const { createDeliverable } = require('./deliverables');
const { extractFile, sliceText, EXTRACT_LIMITS, SUPPORTED_TYPES, pdfAvailable } = require('./file-extract');
const { createPlanner } = require('./planner');
const SEC = require('./security');
const CAP = require('./capabilities');
const DC = require('./delivery-check');

function createV2Api({ dir, models, teams, callModel, emit, audit = () => {}, system = () => ({ node: process.version }) }) {
  const store = new ProjectStore({ dir });
  const runContext = context => ensure(store.getRun(context?.runId), 'Tool run');
  const builtinTools = ['docx', 'xlsx', 'pptx'].map(format => ({
    toolId: format + '_generation', name: format.toUpperCase() + ' 真实文件生成',
    description: '在当前运行内生成真实 ' + format.toUpperCase() + ' 文件并保存字节与校验值；默认使用上一步实际输出。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200000 }, title: { type: 'string', maxLength: 160 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const run = runContext(context); if (signal?.aborted) throw new ProjectError('Cancelled');
      const text = args.text === undefined ? context.input : args.text;
      if (typeof text !== 'string' || !text.trim()) throw new ProjectError('Document tool needs actual input text');
      const file = createDeliverable(format, { text, title: args.title || store.getProject(run.projectId)?.name });
      if (signal?.aborted) throw new ProjectError('Cancelled');
      const a = store.putArtifact(run.runId, { buffer: file.buffer, filename: file.filename, mime: file.mime, kind: 'file', producer: format + '_generation', executionMode: 'builtin' });
      return { content: [{ type: 'text', text: 'File generated: ' + a.filename }], structuredContent: { artifactId: a.artifactId, filename: a.filename, bytes: a.bytes, sha256: a.sha256, mime: a.mime } };
    }
  }));
  builtinTools.push({ toolId: 'file_read', risk: 'read', name: '读取本运行的文本成果', description: '按成果ID读取本运行已有的文本/JSON文件；不是任意主机路径或 PDF/Word 附件读取器。',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string', maxLength: 80 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const run = runContext(context); if (signal?.aborted) throw new ProjectError('Cancelled');
      const metadata = args.artifactId ? { artifactId: args.artifactId } : store.listArtifacts(run.runId).filter(a => a.kind === 'role-output').at(-1);
      const a = metadata && store.getArtifact(run.runId, metadata.artifactId);
      if (!a || (!a.mime.startsWith('text/') && a.mime !== 'application/json')) throw new ProjectError('Text artifact not found in this run');
      if (a.buffer.length > 200000) throw new ProjectError('Text artifact exceeds tool output limit');
      return { content: [{ type: 'text', text: a.buffer.toString('utf8') }], structuredContent: { artifactId: a.artifactId, sha256: a.sha256, bytes: a.bytes } };
    }
  });
  builtinTools.push({ toolId: 'project_file_read', risk: 'read', name: '读取项目资料', description: '按资料文件ID分段读取本项目已上传文件（PDF/Word/Excel/PPT/文本）中提取的文字；只能读取当前项目的资料。',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string', maxLength: 40 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 100, maximum: 50000 } }, required: ['fileId'], additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const projectId = context?.projectId;
      if (typeof projectId !== 'string') throw new ProjectError('project_file_read needs a project context');
      if (signal?.aborted) throw new ProjectError('Cancelled');
      const f = store.getProjectFile(projectId, args.fileId, { text: true });
      if (!f) throw new ProjectError('Material file not found in this project');
      if (f.extraction.status !== 'ok') throw new ProjectError('File text is not readable: ' + (f.extraction.note || f.extraction.status));
      const part = sliceText(f.text, args);
      return { content: [{ type: 'text', text: part.text }], structuredContent: { fileId: f.fileId, filename: f.filename, sha256: f.sha256, offset: part.offset, length: part.length, total: part.total, nextOffset: part.nextOffset } };
    }
  });
  const DA = require('./data-analysis');
  const tableFrom = (args, context) => {
    if (args.fileId) {
      const f = store.getProjectFile(context?.projectId, args.fileId, { content: true });
      if (!f) throw new ProjectError('Table file not found in this project');
      if (f.kind === 'xlsx') { const r = require('./file-extract').readSpreadsheet(f.buffer, { sheet: args.sheet }); return { rows: r.rows, source: { fileId: f.fileId, filename: f.filename, sha256: f.sha256, sheet: r.sheet, uncomputedFormulas: r.uncomputedFormulas } }; }
      if (f.kind === 'table' || f.mime.startsWith('text/')) return { rows: DA.parseCsv(f.buffer.toString('utf8')), source: { fileId: f.fileId, filename: f.filename, sha256: f.sha256 } };
      throw new ProjectError('Only CSV/TSV/XLSX files can be analysed');
    }
    if (typeof context?.input === 'string' && context.input.trim()) return { rows: DA.parseCsv(context.input.replace(/^```\w*\n|\n```\s*$/g, '')), source: { from: 'previous step output' } };
    throw new ProjectError('data_analysis needs fileId (CSV/TSV/XLSX project file) or a CSV previous output');
  };
  builtinTools.push({ toolId: 'data_analysis', name: '数据计算与分析', description: '对项目中的 CSV/TSV/Excel 表格做确定性计算：描述统计、分组汇总、排序取前 N、筛选。结果由程序计算，可作为证据；可另存为 Excel/CSV。',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string', maxLength: 40 }, sheet: { type: 'string', maxLength: 100 }, headerRow: { type: 'boolean' }, operations: { type: 'array', maxItems: 10, items: { type: 'object' } }, saveAs: { type: 'string', enum: ['xlsx', 'csv'] } }, required: ['operations'], additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const { rows, source } = tableFrom(args, context);
      const t = DA.table(rows, { headerRow: args.headerRow !== false });
      const results = DA.analyze(t, args.operations);
      if (signal?.aborted) throw new ProjectError('Cancelled');
      let artifact = null;
      if (args.saveAs && context?.runId) {
        const sheetRows = results.filter(r => r.columns).flatMap((r, i) => [...(i ? [[]] : []), [r.op + (r.by ? '：' + r.by : r.column ? '：' + r.column : '')], r.columns, ...r.rows]);
        const file = createDeliverable(args.saveAs, { title: '数据分析结果', text: '', rows: sheetRows });
        artifact = store.putArtifact(context.runId, { buffer: file.buffer, filename: file.filename, mime: file.mime, kind: 'file', producer: 'data_analysis', executionMode: 'builtin' });
      }
      const text = `数据来源：${source.filename || source.from}${source.sheet ? ' / ' + source.sheet : ''}（${t.rows.length} 行，列：${t.columns.join('、')}）${source.uncomputedFormulas ? `\n注意：${source.uncomputedFormulas} 个公式单元格在文件中没有计算结果，已按空值处理。` : ''}\n\n` + results.map(r => `### ${r.op}\n${DA.markdown(r)}`).join('\n\n');
      return { content: [{ type: 'text', text }], structuredContent: { source, columns: t.columns, rowCount: t.rows.length, results, ...(artifact ? { artifactId: artifact.artifactId, filename: artifact.filename, sha256: artifact.sha256 } : {}) } };
    } });
  builtinTools.push({ toolId: 'chart_generation', name: '图表生成（SVG）', description: '根据给定数据生成柱状图、折线图或饼图（SVG 矢量图片），保存为本运行的成果文件。数据必须明确给出，不会编造。',
    inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['bar', 'line', 'pie'] }, title: { type: 'string', maxLength: 120 }, labels: { type: 'array', maxItems: 200 }, series: { type: 'array', maxItems: 8, items: { type: 'object' } }, filename: { type: 'string', maxLength: 100 } }, required: ['labels', 'series'], additionalProperties: false },
    handler: async (args, { context }) => {
      const svg = DA.svgChart(args);
      const filename = (String(args.filename || args.title || 'chart').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'chart') + '.svg';
      const a = context?.runId ? store.putArtifact(context.runId, { buffer: svg, filename, mime: 'image/svg+xml', kind: 'file', producer: 'chart_generation', executionMode: 'builtin' }) : null;
      return { content: [{ type: 'text', text: a ? 'Chart generated: ' + a.filename : svg.toString('utf8') }], structuredContent: { bytes: svg.length, ...(a ? { artifactId: a.artifactId, filename: a.filename, sha256: a.sha256 } : {}) } };
    } });
  const OR = require('./office-render');
  const officeSource = (args, context, exts) => {
    let f = null;
    if (args.fileId) f = store.getProjectFile(context?.projectId, args.fileId, { content: true });
    else if (context?.runId) {
      const metas = store.listArtifacts(context.runId).filter(a => a.kind === 'file' && exts.includes(String(a.filename).split('.').pop().toLowerCase()));
      const meta = args.artifactId ? metas.find(a => a.artifactId === args.artifactId) : metas.at(-1);
      f = meta && store.getArtifact(context.runId, meta.artifactId);
    }
    if (!f) throw new ProjectError('No ' + exts.join('/').toUpperCase() + ' file found: give fileId (project file) or artifactId (this run)');
    return { buffer: f.buffer, filename: f.filename, ext: String(f.filename).split('.').pop().toLowerCase(), id: f.artifactId || f.fileId };
  };
  const saveRunFile = (context, buffer, filename, mime, producer) => context?.runId ? store.putArtifact(context.runId, { buffer, filename, mime, kind: 'file', producer, executionMode: 'builtin' }) : null;
  builtinTools.push({ toolId: 'document_convert', name: 'Office 转 PDF（LibreOffice）', description: '把本运行生成的或项目上传的 Word/Excel/PPT 用 LibreOffice 转换为真实 PDF 并保存。需要服务器安装 LibreOffice。',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string', maxLength: 80 }, fileId: { type: 'string', maxLength: 40 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const src = officeSource(args, context, ['docx', 'xlsx', 'pptx']);
      const pdf = await OR.convertToPdf(src.buffer, src.ext, { signal });
      const a = saveRunFile(context, pdf, src.filename.replace(/\.\w+$/, '') + '.pdf', 'application/pdf', 'document_convert');
      return { content: [{ type: 'text', text: 'PDF generated from ' + src.filename + (a ? ': ' + a.filename : '') }], structuredContent: { source: src.id, bytes: pdf.length, ...(a ? { artifactId: a.artifactId, filename: a.filename, sha256: a.sha256 } : {}) } };
    } });
  builtinTools.push({ toolId: 'document_render', name: '文件渲染检查', description: '把 Word/Excel/PPT/PDF 真实渲染为页面图片（PNG，保存为成果），并检查页数和空白页。Office 需要 LibreOffice，渲染需要 poppler-utils。',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string', maxLength: 80 }, fileId: { type: 'string', maxLength: 40 }, maxPages: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const src = officeSource(args, context, ['docx', 'xlsx', 'pptx', 'pdf']);
      const pdf = src.ext === 'pdf' ? src.buffer : await OR.convertToPdf(src.buffer, src.ext, { signal });
      const pages = await OR.renderPdf(pdf, { maxPages: args.maxPages || 10, signal });
      const saved = pages.map(p => saveRunFile(context, p.png, src.filename.replace(/\.\w+$/, '') + `-第${p.page}页.png`, 'image/png', 'document_render'));
      const blank = pages.filter(p => p.blank).map(p => p.page);
      const text = `已渲染 ${src.filename} 的 ${pages.length} 页` + (blank.length ? `；疑似空白页：第 ${blank.join('、')} 页` : '；未发现空白页') + '。版式是否美观仍需人工查看页面图片。';
      return { content: [{ type: 'text', text }], structuredContent: { source: src.id, pages: pages.map((p, i) => ({ page: p.page, blank: p.blank, inkRatio: p.inkRatio, ...(saved[i] ? { artifactId: saved[i].artifactId } : {}) })), blankPages: blank } };
    } });
  const mcpConfig = store.getSetting('mcp_config', { disabled: [], http: [] });
  const mcpTokens = () => store.getSetting('mcp_tokens', {});
  const CX = require('./code-exec');
  const OUT_MIME = { csv: 'text/csv; charset=utf-8', json: 'application/json', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', html: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', png: 'image/png' };
  builtinTools.push({ toolId: 'code_execution', risk: 'exec', name: '受控代码执行（JavaScript）', description: '在无网络、文件访问仅限私有临时目录、禁止子进程的受控环境运行 JavaScript，返回真实退出码与输出；写入 out/ 的文件保存为成果。默认关闭，需管理员开启并每次授权。',
    inputSchema: { type: 'object', properties: { code: { type: 'string', maxLength: 200000 }, files: { type: 'object' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, required: ['code'], additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const r = await CX.runJavaScript(args, { signal });
      const saved = r.outputs.filter(o => o.buffer && context?.runId).map(o => store.putArtifact(context.runId, { buffer: o.buffer, filename: o.path.replace(/\//g, '_'), mime: OUT_MIME[o.path.split('.').pop().toLowerCase()] || 'application/octet-stream', kind: 'file', producer: 'code_execution', executionMode: 'builtin' }));
      const text = `退出码：${r.exitCode}${r.timedOut ? '（超时被终止）' : ''}，用时 ${r.durationMs} ms\n--- 标准输出 ---\n${r.stdout || '（无）'}\n--- 标准错误 ---\n${r.stderr || '（无）'}${r.truncated ? '\n（输出过长，已按上限截断并标记）' : ''}`;
      return { content: [{ type: 'text', text }], structuredContent: { exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated, durationMs: r.durationMs, isolation: r.isolation, outputs: r.outputs.map((o, i) => ({ path: o.path, bytes: o.bytes, ...(o.skipped ? { skipped: o.skipped } : {}), ...(saved[i] ? { artifactId: saved[i].artifactId } : {}) })) } };
    } });
  const tools = new ToolRegistry({ mcpServers: loadMcpServers(), httpServers: mcpConfig.http, disabledServers: mcpConfig.disabled, policy: models.policy, tokenFor: id => mcpTokens()[id] || '', builtinTools, audit: detail => audit('tool', detail) });
  const saveMcp = () => store.setSetting('mcp_config', { disabled: [...tools.disabled], http: tools.servers.filter(s => s.transport === 'http').map(s => ({ id: s.id, url: s.url, name: s.name })) });
  const mcpCatalog = require('../catalog/mcp-servers.v1.json');
  const MCP_HINT = { mcp_unreachable: '无法连接：检查地址是否正确、服务器能否访问该网址，以及地址是否被出站安全策略允许。', mcp_auth: '服务拒绝了凭据：检查访问令牌是否正确或过期。', timeout: '响应超时：服务可能繁忙或程序卡住，稍后重试。', mcp_closed: '连接已断开：程序可能启动失败或已退出；检查服务器上的可执行文件路径与权限。', mcp_protocol: '对方不是标准 MCP 服务，或版本不兼容。', mcp_error: '服务返回错误；查看运行日志中的原因。', disabled: '已停用。', output_limit: '返回内容过大。' };
  const skills = new SkillRegistry({ tools, initial: store.getSetting('skills', null) ?? undefined, save: list => store.setSetting('skills', list) });
  const engine = new ProjectEngine({ store, models, teams, callModel, tools, skills, emit });
  // One planner (lib/planner): rules are the fallback, the AI draft only enhances, universal = one-sentence workflow.
  const planner = createPlanner({ store, engine, models, tools, skills, callModel, audit });
  const { drafts, universal } = planner;
  const ensure = (value, name) => { if (!value) throw new ProjectError(name + ' not found', 'not_found', 404); return value; };
  const object = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectError('Expected a JSON object');
    return value;
  };
  const planFrom = input => planner.rulePlan(input);
  function fromPlan(result) {
    const plan = result.plan;
    return { name: plan.projectTypeName || '立项项目', description: plan.description, plan,
      roles: plan.roles.map(r => ({ roleId: r.id, name: r.name, duty: r.duty, boundary: r.duty, standard: r.standard, requiredCapabilities: r.capabilities, connectionId: r.modelConnectionId })),
      steps: plan.steps.map(s => ({ stepId: s.id, roleId: s.roleId, title: s.title, prompt: s.quality + '\n交付：' + s.deliverable })),
      standards: plan.quantification.map(q => q.label + '：' + q.selectedText),
      // Real registry IDs where a usable implementation exists; unresolved IDs stay so validation blocks honestly.
      requiredToolIds: (result.toolCheck || []).map(t => t.toolId || t.intakeId),
      deliverables: [...new Set(plan.steps.map(s => s.deliverable))], maxReworks: 2 };
  }
  function runView(runId) {
    const run = ensure(engine.getRun(runId), 'Run');
    return { ...run, messages: store.getMessages(runId), events: store.getEvents(runId),
      artifacts: store.listArtifacts(runId).map(a => ({ ...a, downloadUrl: '/api/v2/runs/' + runId + '/artifacts/' + a.artifactId + '/download' })),
      usageLedger: store.getUsage(runId) };
  }
  // #17 delivery checks: the run's final textual output (same source as export).
  function finalTextOf(run) {
    const final = run.finalArtifactId && store.getArtifact(run.runId, run.finalArtifactId);
    return final ? final.buffer.toString('utf8') : [...store.getSteps(run.runId)].reverse().find(s => typeof s.output === 'string' && s.output)?.output;
  }
  function latestDeliveryArtifact(runId, filename) {
    return [...store.listArtifacts(runId)].reverse().find(a => a.producer === 'delivery_check' && a.filename === filename) || null;
  }
  let lastMcp = [];
  const confirmations = new Map();
  const argsHash = a => crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex');
  const ACCOUNTING_NOTE = '只读异常账本：reserved/dispatching 可能仍在处理中；中断、用量未知或未完整记账的调用需要人工核对。费用 null 表示未知，估算上界不等于厂商账单。不要为补记账重新生成，平台不会自动重发。';
  const exceptionLimit = value => Math.max(1, Math.min(1000, Math.floor(Number(value) || 100)));
  const RISK_TEXT = { internal_write: ['会在 AIJAVAIS 中生成并保存文件。'], exec: ['会在受控环境中运行代码。'], external: ['这是外部 MCP 工具：可能修改外部数据、发送消息、创建资源或产生费用，平台无法核实其影响。', '工具自称的“只读”等标注未经平台验证。'] };
  async function handle(req, res, url, { readBody, json, user }) {
    if (!url.pathname.startsWith('/api/v2/')) return false;
    const p = url.pathname.slice('/api/v2'.length), m = req.method;
    const body = async () => object(await readBody(req, 2 << 20));
    let match;
    try {
      if (p === '/health' && m === 'GET') { json(res, 200, { version: '2.0.0', schemaVersion: store.schemaVersion, storage: 'sqlite', activeRuns: store.activeRunCount() }); return true; }
      if(p==='/universal/plan'&&m==='POST'){json(res,200,universal.plan(await body()));return true;}
      if(p==='/universal/projects'&&m==='POST'){json(res,201,{project:universal.create(await body(),user.userId)});return true;}
      if((match=p.match(/^\/universal\/projects\/([\w-]+)\/runs$/))&&m==='POST'){json(res,202,{run:universal.start(match[1],await body(),user.userId)});return true;}
      if((match=p.match(/^\/universal\/runs\/([\w-]+)(?:\/(events|workbench|criteria|deliver|accept|rework|cancel))?$/))){
        const [,id,action]=match;
        if(!action&&m==='GET'){json(res,200,{run:universal.view(id)});return true;}
        if(action==='workbench'&&m==='GET'){json(res,200,universal.workbench(id,{after:url.searchParams.get('after'),limit:url.searchParams.get('limit')}));return true;}
        if(action==='criteria'&&m==='POST'){json(res,201,{artifact:universal.criteria(id,await body(),user.userId)});return true;}
        if(action==='events'&&m==='GET'){const events=universal.events(id,{after:url.searchParams.get('after'),limit:url.searchParams.get('limit')});json(res,200,{schema:'aijavais.work-event/v1',events,cursor:events.at(-1)?.sequence||Number(url.searchParams.get('after'))||0,readOnly:true});return true;}
        if(action==='deliver'&&m==='POST'){json(res,201,{artifact:universal.deliver(id,await body(),user.userId)});return true;}
        if(action==='accept'&&m==='POST'){json(res,200,{run:universal.accept(id,await body())});return true;}
        if(action==='rework'&&m==='POST'){json(res,202,{run:universal.rework(id,await body(),user.userId)});return true;}
        if(action==='cancel'&&m==='POST'){json(res,200,{run:engine.cancel(id)});return true;}
      }
      if (p === '/tools' && m === 'GET') { json(res, 200, { tools: tools.list() }); return true; }
      if (p === '/tools/discover' && m === 'POST') { const d = await tools.discover(); lastMcp = d.servers; json(res, 200, d); return true; }
      if (p === '/mcp' && m === 'GET') {
        const states = new Map(lastMcp.map(x => [x.serverId, x]));
        json(res, 200, { catalog: mcpCatalog.servers, catalogNote: mcpCatalog.note, configFile: !!process.env.AIJ_MCP_SERVERS_FILE,
          servers: tools.serverList().map(sv => ({ ...sv, lastTest: states.get(sv.serverId) ? { ...states.get(sv.serverId), hint: MCP_HINT[states.get(sv.serverId).code] || '' } : null })),
          logs: tools.logs.slice(-100).reverse() }); return true;
      }
      if (p === '/mcp/servers' && m === 'POST') {
        const b = await body();
        if (b.token !== undefined && (typeof b.token !== 'string' || b.token.length > 4096 || /[\r\n]/.test(b.token))) throw new ProjectError('Invalid access token');
        const server = tools.addHttpServer({ id: b.id, url: b.url, name: b.name });
        if (b.token) store.setSetting('mcp_tokens', { ...mcpTokens(), [server.id]: b.token });
        saveMcp(); audit('mcp_server_added', { serverId: server.id, transport: 'http', host: new URL(server.url).host });
        json(res, 201, { server: tools.serverList().find(x => x.serverId === server.id) }); return true;
      }
      if ((match = p.match(/^\/mcp\/servers\/([\w-]+)(?:\/(enable|disable|test))?$/))) {
        const [, serverId, action] = match;
        if (action === 'enable' || action === 'disable') { tools.setEnabled(serverId, action === 'enable'); saveMcp(); audit('mcp_server_' + action + 'd', { serverId }); json(res, 200, { servers: tools.serverList() }); return true; }
        if (action === 'test' && m === 'POST') {
          const d = await tools.discover({ serverId });
          lastMcp = [...lastMcp.filter(x => x.serverId !== serverId), ...d.servers];
          const st = d.servers[0] || { serverId, available: false, code: 'mcp_missing', error: 'MCP server is not configured' };
          json(res, 200, { state: { ...st, hint: MCP_HINT[st.code] || '' }, tools: d.tools.filter(t => t.serverId === serverId) }); return true;
        }
        if (!action && m === 'DELETE') {
          tools.removeHttpServer(serverId);
          const tk = mcpTokens(); delete tk[serverId]; store.setSetting('mcp_tokens', tk);
          lastMcp = lastMcp.filter(x => x.serverId !== serverId); saveMcp(); audit('mcp_server_removed', { serverId });
          json(res, 200, { ok: true }); return true;
        }
      }
      if (p === '/usage/system/exceptions' && m === 'GET') {
        // The authenticated subject is authoritative; query parameters cannot select another owner.
        const limit = exceptionLimit(url.searchParams.get('limit'));
        const exceptions = store.listSystemUsageExceptions({ ownerId: user.userId, limit });
        json(res, 200, { exceptions, returned: exceptions.length, limit, readOnly: true, note: ACCOUNTING_NOTE }); return true;
      }
      if (p === '/usage/system' && m === 'GET') { json(res, 200, { usage: store.listSystemUsage({ limit: url.searchParams.get('limit') }), note: '项目运行以外的模型调用（连接测试、团队草案）。费用为 null 表示未知，不是 0；reserved 表示待结算或中断后需核对。' }); return true; }
      if (p === '/capabilities' && m === 'GET') { json(res, 200, CAP.listCapabilities({ tools: tools.list(), skills: skills.list(), mcp: { servers: lastMcp } })); return true; }
      if (p === '/readiness' && m === 'GET') {
        const scenarios = String(url.searchParams.get('scenarios') || 'basic').split(',').slice(0, 10);
        const result = CAP.readiness({ system: system(req), models: models.list(), tools: tools.list(), skills: skills.list(), mcp: { servers: lastMcp, configured: tools.servers.length }, store }, scenarios);
        const exceptions = store.listSystemUsageExceptions({ ownerId: user.userId, limit: 100 });
        result.accounting = { exceptions, returned: exceptions.length, limit: 100, readOnly: true, exceptionsUrl: '/api/v2/usage/system/exceptions', note: ACCOUNTING_NOTE };
        if (exceptions.length) {
          const warning = { id: 'system-usage-exceptions', label: '系统调用账本需要关注', status: 'warn', level: 'recommended',
            detail: `最近 ${exceptions.length} 条待结算或费用待核对记录（本页最多显示100条）。未知费用不会按0计入。`,
            howTo: '查看下方只读异常账本，记录请求ID、模型、UTC时间与预留上界，由负责人对照厂商账单；不要重新生成补记账。' };
          result.items.push(warning); result.missing.recommended.push({ id: warning.id, label: warning.label, detail: warning.detail, howTo: warning.howTo });
        }
        json(res, 200, result); return true;
      }
      if (p === '/tools/call/prepare' && m === 'POST') {
        const b = await body();
        const tool = tools.list().find(t => t.toolId === b.toolId);
        if (!tool) throw new ProjectError('Tool is not registered', 'tool_missing', 404);
        const confirmationId = crypto.randomBytes(18).toString('hex');
        for (const [k, v] of confirmations) if (v.expires < Date.now()) confirmations.delete(k);
        if (confirmations.size >= 100) confirmations.delete(confirmations.keys().next().value);
        confirmations.set(confirmationId, { toolId: tool.toolId, argsHash: argsHash(b.args || {}), expires: Date.now() + 120000 });
        json(res, 200, { confirmationId, expiresInSeconds: 120, risk: tool.risk, warnings: RISK_TEXT[tool.risk] || [], annotations: tool.annotations || null }); return true;
      }
      if (p === '/tools/call' && m === 'POST') {
        const b = await body();
        const tool = tools.list().find(t => t.toolId === b.toolId);
        if (!tool) throw new ProjectError('Tool is not registered', 'tool_missing', 404);
        // The grant is decided here, never taken from the browser: read-only tools run directly;
        // anything with side effects needs a fresh, single-use confirmation bound to the exact tool and arguments.
        if (tool.risk !== 'read') {
          const c = confirmations.get(String(b.confirmationId || ''));
          confirmations.delete(String(b.confirmationId || ''));
          if (!c || c.expires < Date.now() || c.toolId !== tool.toolId || c.argsHash !== argsHash(b.args || {})) {
            json(res, 428, { error: '该工具可能产生实际影响，需先确认本次调用（确认只对相同工具和参数有效、2 分钟内一次）', code: 'confirmation_required', risk: tool.risk, warnings: RISK_TEXT[tool.risk] || [] }); return true;
          }
        }
        // Read-only tools still need the explicit per-request grant they always required; others are granted by the confirmation.
        b.allowedTools = tool.risk === 'read' ? (Array.isArray(b.allowedTools) && b.allowedTools.includes(tool.toolId) ? [tool.toolId] : []) : [tool.toolId];
        const context = { userId: user.userId, ...(typeof b.projectId === 'string' && store.getProject(b.projectId) ? { projectId: b.projectId } : {}) };
        const result = await tools.call(b.toolId, b.args || {}, { allowedTools: b.allowedTools || [], context });
        audit('tool_manual', { toolId: b.toolId, executionMode: result.executionMode });
        json(res, 200, { result }); return true;
      }
      if (p === '/skills' && m === 'GET') { json(res, 200, { skills: skills.list() }); return true; }
      if (p === '/skills' && m === 'POST') { json(res, 200, { skill: skills.upsert(await body()) }); return true; }
      if ((match = p.match(/^\/projects\/([\w-]+)\/files$/))) {
        const projectId = match[1];
        ensure(store.getProject(projectId), 'Project');
        if (m === 'GET') { json(res, 200, { files: store.listProjectFiles(projectId), limits: { ...EXTRACT_LIMITS, pdfText: pdfAvailable() }, supported: SUPPORTED_TYPES }); return true; }
        if (m === 'POST') {
          // JSON + base64 keeps the existing same-origin JSON gate; ~11 MB body for an 8 MB file.
          const b = object(await readBody(req, Math.ceil(EXTRACT_LIMITS.maxFileBytes * 4 / 3) + 4096));
          if (typeof b.filename !== 'string' || typeof b.contentBase64 !== 'string') throw new ProjectError('Upload needs filename and contentBase64');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.contentBase64)) throw new ProjectError('contentBase64 is not valid base64', 'invalid_upload');
          const buffer = Buffer.from(b.contentBase64, 'base64');
          const extraction = await extractFile(b.filename, buffer);
          const file = store.putProjectFile(projectId, { buffer, filename: extraction.filename, mime: extraction.mime, kind: extraction.kind, extraction });
          audit('project_file_uploaded', { projectId, fileId: file.fileId, kind: file.kind, bytes: file.bytes, status: file.extraction.status });
          json(res, 201, { file }); return true;
        }
      }
      if ((match = p.match(/^\/projects\/([\w-]+)\/files\/([\w-]+)(\/download)?$/))) {
        const [, projectId, fileId, download] = match;
        const f = ensure(store.getProjectFile(projectId, fileId, { content: !!download, text: !download }), 'File');
        if (download && m === 'GET') {
          res.writeHead(200, { 'content-type': f.mime, 'content-length': f.buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(f.filename), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(f.buffer); return true;
        }
        if (!download && m === 'GET') { const { text, ...meta } = f; json(res, 200, { file: meta, text: sliceText(text, { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') }) }); return true; }
        if (!download && m === 'DELETE') { store.deleteProjectFile(projectId, fileId); audit('project_file_deleted', { projectId, fileId }); json(res, 200, { ok: true }); return true; }
      }
      if ((match = p.match(/^\/skills\/([\w.-]+)$/)) && m === 'DELETE') { skills.remove(match[1]); json(res, 200, { ok: true }); return true; }
      if (p === '/intake/plan' && m === 'POST') { json(res, 200, planFrom(await body())); return true; }
      if (p === '/intake/ai-draft/estimate' && m === 'POST') { json(res, 200, drafts.estimate(await body())); return true; }
      // Read-only capacity view: counts only, no prompts, owners or ledger contents.
      if (p === '/intake/ai-draft/status' && m === 'GET') { json(res, 200, { ...drafts.stats(), readOnly: true,
        note: 'activeSlots 按底层模型调用真实结束才释放；outstandingAfterResponse 表示用户请求已结束但供应商调用仍未确认结束（费用未知，可能仍计费）。' }); return true; }
      if (p === '/intake/ai-draft/cancel' && m === 'POST') {
        const b = await body(), cancelled = drafts.cancel(user.userId, b.requestId);
        json(res, cancelled ? 202 : 404, { ok: cancelled, cancelled }); return true;
      }
      if (p === '/intake/ai-draft' && m === 'POST') {
        const input = await body(), controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); };
        res.once('close', disconnect);
        try { const result = await drafts.generate(input, { ownerId: user.userId, signal: controller.signal }); json(res, result.status, result.body); }
        finally { res.removeListener('close', disconnect); }
        return true;
      }
      if (p === '/intake/projects' && m === 'POST') {
        const result = planFrom(await body());
        const project = engine.create(fromPlan(result), { ownerId: user.userId });
        json(res, 201, { project, plan: result.plan, warnings: result.warnings }); return true;
      }
      if (p === '/projects' && m === 'GET') { json(res, 200, { projects: store.listProjects() }); return true; }
      if (p === '/projects' && m === 'POST') { json(res, 201, { project: engine.create(await body(), { ownerId: user.userId }) }); return true; }
      if ((match = p.match(/^\/projects\/([\w-]+)(?:\/(validate|runs))?$/))) {
        const projectId = match[1], action = match[2];
        const project = ensure(store.getProject(projectId), 'Project');
        if (!action && m === 'GET') { json(res, 200, { project, runs: store.listRuns(projectId) }); return true; }
        if (!action && m === 'PUT') {
          const b = await body();
          // Validate via the same schema as creation; only the store updates version/owner.
          json(res, 200, { project: engine.update(projectId, b, { expectedVersion: b.expectedVersion ?? b.version }) }); return true;
        }
        if (!action && m === 'DELETE') { store.deleteProject(projectId); json(res, 200, { ok: true }); return true; }
        if (action === 'validate' && m === 'POST') { json(res, 200, engine.validate(projectId)); return true; }
        if (action === 'runs' && m === 'POST') { json(res, 202, { run: await engine.start(projectId, await body()) }); return true; }
      }
      if ((match = p.match(/^\/runs\/([\w-]+)\/delivery-check$/))) {
        const runId = match[1], run = ensure(engine.getRun(runId), 'Run');
        if (m === 'GET') {
          const a = latestDeliveryArtifact(runId, 'delivery-manifest.json');
          if (!a) throw new ProjectError('No delivery check has been run for this run', 'not_found', 404);
          json(res, 200, { manifest: JSON.parse(store.getArtifact(runId, a.artifactId).buffer.toString('utf8')) }); return true;
        }
        if (m === 'POST') {
          if (run.status === 'running' || run.executionActive) throw new ProjectError('Wait until execution and billing settle before checking deliverables', 'run_active', 409);
          const b = await body();
          if (b.smokeTest !== undefined && typeof b.smokeTest !== 'boolean') throw new ProjectError('smokeTest must be a boolean');
          const artifacts = store.listArtifacts(runId).filter(a => a.producer !== 'delivery_check').map(meta => ({ meta, buffer: store.getArtifact(runId, meta.artifactId).buffer }));
          // Generated code runs only if the administrator enabled the isolated executor AND the user asked now.
          const result = await DC.checkRun({ run, finalText: finalTextOf(run), artifacts, exec: CX, smokeTest: b.smokeTest === true, reviewStatus: run.review?.decision || run.status });
          const stored = [];
          for (const f of result.newFiles) {
            const a = store.putArtifact(runId, { buffer: f.buffer, mime: f.mime, filename: f.filename, kind: 'file', format: f.format, producer: f.producer });
            stored.push({ artifactId: a.artifactId, filename: a.filename, sha256: a.sha256, bytes: a.bytes, downloadUrl: '/api/v2/runs/' + runId + '/artifacts/' + a.artifactId + '/download' });
          }
          const { newFiles, ...manifest } = result; manifest.generatedArtifacts = stored; void newFiles;
          const saved = store.putArtifact(runId, { buffer: Buffer.from(JSON.stringify(manifest, null, 2)), mime: 'application/json; charset=utf-8', filename: 'delivery-manifest.json', kind: 'file', format: 'json', producer: 'delivery_check' });
          store.appendEvent(runId, { eventType: 'delivery_checked', executionMode: 'builtin', artifactId: saved.artifactId, kinds: manifest.kinds, summary: manifest.summary });
          audit('delivery_checked', { runId, kinds: manifest.kinds, smokeTest: b.smokeTest === true, usableVerified: manifest.summary.usableVerified });
          json(res, 200, { manifest: { ...manifest, manifestArtifactId: saved.artifactId } }); return true;
        }
      }
      if ((match = p.match(/^\/runs\/([\w-]+)(?:\/(cancel|review|export))?$/))) {
        const runId = match[1], action = match[2];
        const run = ensure(engine.getRun(runId), 'Run');
        if (!action && m === 'GET') { json(res, 200, { run: runView(runId) }); return true; }
        if (action === 'cancel' && m === 'POST') { json(res, 200, { run: await engine.cancel(runId) }); return true; }
        if (action === 'review' && m === 'POST') { const b = await body(); json(res, 200, { run: await engine.review(runId, { ...b, feedback: b.feedback || b.comment || '' }) }); return true; }
        if (action === 'export' && m === 'POST') {
          const b = await body();
          if (run.status === 'running' || run.executionActive) throw new ProjectError('Wait until execution and billing settle before exporting', 'run_active', 409);
          const steps = store.getSteps(runId);
          const final = run.finalArtifactId && store.getArtifact(runId, run.finalArtifactId);
          const text = final ? final.buffer.toString('utf8') : [...steps].reverse().find(s => typeof s.output === 'string' && s.output)?.output;
          if (typeof text !== 'string' || !text.trim()) throw new ProjectError('No completed textual output to export', 'no_output', 409);
          const project = store.getProject(run.projectId);
          let structured = {};
          try {
            const parsed = JSON.parse(text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              for (const k of ['sections', 'rows', 'slides', 'files', 'claims', 'evidence', 'assumptions']) if (Array.isArray(parsed[k])) structured[k] = parsed[k];
              for (const k of ['orgChart', 'software']) if (parsed[k] && typeof parsed[k] === 'object' && !Array.isArray(parsed[k])) structured[k] = parsed[k];
            }
          } catch { /* Ordinary text is a valid office-document input. */ }
          if (['zip', 'code'].includes(b.format) && !Array.isArray(b.files || structured.files)) throw new ProjectError('Code ZIP requires actual structured files: model output JSON {"files":[{"path":"...","content":"..."}]}', 'files_required', 409);
          // #17: verified org chart / evidence chain / software manifest become linked report sections.
          const svg = latestDeliveryArtifact(runId, 'org-chart.svg');
          structured = DC.augmentExport(b.format || 'md', structured, { orgSvg: svg && { artifactId: svg.artifactId, filename: svg.filename, sha256: svg.sha256 } });
          const file = createDeliverable(b.format || 'md', { ...structured, ...b, title: project?.name || 'AIJAVAIS', text });
          const a = store.putArtifact(runId, { buffer: file.buffer, mime: file.mime, filename: file.filename, kind: 'file', format: file.extension, reviewStatus: run.status });
          store.appendEvent(runId, { eventType: 'file_generated', executionMode: 'builtin', artifactId: a.artifactId, sha256: a.sha256, bytes: a.bytes });
          audit('file_generated', { runId, artifactId: a.artifactId, format: file.extension, bytes: a.bytes });
          res.writeHead(200, { 'content-type': file.mime, 'content-length': file.buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename), 'cache-control': 'no-store', 'x-artifact-id': a.artifactId });
          res.end(file.buffer); return true;
        }
      }
      if ((match = p.match(/^\/runs\/([\w-]+)\/artifacts\/([\w-]+)\/download$/)) && m === 'GET') {
        ensure(store.getRun(match[1]), 'Run'); const a = ensure(store.getArtifact(match[1], match[2]), 'Artifact');
        res.writeHead(200, { 'content-type': a.mime, 'content-length': a.buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(a.filename), 'cache-control': 'no-store' });
        res.end(a.buffer); return true;
      }
      json(res, 404, { error: 'Unknown V2 endpoint' });
    } catch (e) {
      const status = e.status || (typeof e.code === 'number' ? e.code : 400);
      json(res, status >= 400 && status <= 599 ? status : 400, { error: e.message || 'V2 operation failed', code: typeof e.code === 'string' ? e.code : 'invalid', ...(p.startsWith('/intake/ai-draft') ? { ok: false, fallback: 'manual',
        ...(['duplicate_request', 'idempotency_key_reused'].includes(e.code) ? { requestState: e.requestState, ledgerId: e.ledgerId,
          retryWarning: '此请求ID已有持久记录，未重新调用模型；请查看异常账本，勿重新生成补记账。' } : {}) } : {}) });
    }
    return true;
  }
  return { handle, store, engine, tools, skills, async close() { await planner.close(); await engine.close?.(); await tools.close(); store.close(); } };
}
module.exports = { createV2Api };
