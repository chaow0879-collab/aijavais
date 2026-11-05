'use strict';
/* Capability center: one plain-language catalogue of what AIJAVAIS can actually do.
 * Every entry is classified by HOW it is provided, and its status is computed
 * from the running server (registered tools, installed system programs, MCP
 * discovery), never from documentation claims:
 *   builtin   – code shipped in AIJAVAIS and executed by the server
 *   mcp       – tools discovered from an MCP server configured by the operator
 *   skill     – a versioned prompt/tool/check recipe (not a tool by itself)
 *   external  – needs a third-party service / API key (may cost money)
 *   planned   – not implemented yet; shown so users are never misled
 * A tool installed in a developer's own coding assistant is NOT an AIJAVAIS
 * runtime tool and is never listed here. */
const fs = require('node:fs');
const path = require('node:path');

function findExecutable(name) {
  for (const dir of String(process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    try { const full = path.join(dir, name); fs.accessSync(full, fs.constants.X_OK); if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
  }
  return null;
}
const programs = () => ({ pdftotext: process.env.AIJ_PDFTOTEXT === '0' ? null : findExecutable('pdftotext'), soffice: findExecutable('soffice') || findExecutable('libreoffice'), pdftoppm: findExecutable('pdftoppm') });

/* intakeIds: tool IDs used by project templates; toolIds: registry tools that implement it. */
const CATALOG = [
  { id: 'file-upload-read', name: '上传并读取资料文件', category: '文件处理', kind: 'builtin', intakeIds: ['file_read', 'docx_read'], toolIds: ['project_file_read', 'file_read'], free: true, needsApiKey: false, permissions: ['读取本项目上传的文件'],
    description: '在工作台上传 Word、Excel、PPT、文本/CSV/JSON、代码文件，平台提取文字交给 AI 岗位；可分段读取。', howTo: '无需配置。在工作台「项目资料」上传文件即可。' },
  { id: 'pdf-read', name: '读取 PDF 文字', category: '文件处理', kind: 'builtin', intakeIds: ['pdf_read'], toolIds: ['project_file_read'], requires: ['pdftotext'], free: true, needsApiKey: false, permissions: ['读取本项目上传的文件'],
    description: '提取 PDF 中的文字（按页）。扫描件没有文字层，当前无法识别。', howTo: '服务器需要安装 poppler-utils（Docker 镜像已内置；其他服务器执行 `apt install poppler-utils`）。', alternative: '把 PDF 另存为 Word 或文本后上传。' },
  { id: 'docx-generate', name: '生成 Word 文档', category: '办公文档', kind: 'builtin', intakeIds: ['docx_generation'], toolIds: ['docx_generation'], free: true, needsApiKey: false, permissions: ['在当前运行内保存文件'], description: '把岗位成果生成为真实可编辑的 .docx 文件。', howTo: '无需配置。' },
  { id: 'xlsx-generate', name: '生成 Excel 表格', category: '办公文档', kind: 'builtin', intakeIds: ['xlsx_generation', 'spreadsheet'], toolIds: ['xlsx_generation'], free: true, needsApiKey: false, permissions: ['在当前运行内保存文件'], description: '生成真实 .xlsx（数字/文本单元格；不会把公式样文本当公式执行）。读取 Excel 见「上传并读取资料文件」。', howTo: '无需配置。' },
  { id: 'pptx-generate', name: '生成 PPT 演示稿', category: '办公文档', kind: 'builtin', intakeIds: ['pptx_generation'], toolIds: ['pptx_generation'], free: true, needsApiKey: false, permissions: ['在当前运行内保存文件'], description: '生成真实 .pptx（标题页与要点页，自动分页）。', howTo: '无需配置。' },
  { id: 'export-files', name: '导出 CSV / Markdown / JSON / 代码压缩包', category: '办公文档', kind: 'builtin', intakeIds: [], toolIds: [], free: true, needsApiKey: false, permissions: [], description: '在「执行与交付」把最终成果导出为多种真实文件。代码压缩包只打包模型给出的文件，不运行代码。', howTo: '无需配置。', alwaysAvailable: true },
  { id: 'text-check', name: '文本统计与 JSON 检查', category: '质量检查', kind: 'builtin', intakeIds: [], toolIds: ['builtin:text-stats', 'builtin:json-validate'], free: true, needsApiKey: false, permissions: [], description: '实际统计字数、行数，检查 JSON 结构是否完整。', howTo: '无需配置。' },
  { id: 'calculation', name: '数据计算与分析', category: '数据分析', kind: 'builtin', intakeIds: ['calculation'], toolIds: ['data_analysis'], free: true, needsApiKey: false, permissions: ['读取本项目上传的表格'],
    description: '对上传的 CSV/TSV/Excel 做描述统计、分组汇总、排序与筛选；数字由程序计算，可另存为 Excel/CSV。不执行表格中的公式。', howTo: '无需配置。上传表格后，在流程步骤的工具中添加 data_analysis 并在执行授权中勾选。' },
  { id: 'charts', name: '图表制作（柱状/折线/饼图）', category: '数据分析', kind: 'builtin', intakeIds: ['chart_generation'], toolIds: ['chart_generation'], free: true, needsApiKey: false, permissions: ['在当前运行内保存文件'],
    description: '根据明确给出的数据生成 SVG 矢量图表，可下载后插入文档。暂不能直接嵌入 Word/PPT。', howTo: '无需配置。' },
  { id: 'diagrams', name: '流程图与结构示意图', category: '数据分析', kind: 'planned', intakeIds: ['diagram_generation'], toolIds: [], free: true, needsApiKey: false, permissions: [], description: '生成流程图、结构图等示意图片。', howTo: '开发中。', alternative: '由岗位输出层级/步骤清单，在 Office 的 SmartArt 中绘制。' },
  { id: 'office-render', name: 'Office 渲染预览与格式转换', category: '办公文档', kind: 'planned', intakeIds: ['slide_render', 'document_render'], toolIds: [], requires: ['soffice'], free: true, needsApiKey: false, permissions: ['在服务器运行 LibreOffice'], description: '把 Word/PPT 渲染成页面图片检查版式，或转换为 PDF。', howTo: '开发中；需要服务器安装 LibreOffice。', alternative: '下载文件后在本机 Office 中检查版式。' },
  { id: 'code-execution', name: '受控代码执行', category: '代码', kind: 'planned', intakeIds: ['code_execution', 'repository_access'], toolIds: [], free: true, needsApiKey: false, permissions: ['在隔离环境运行代码（高风险）'], description: '运行代码和自动化测试并返回真实结果。', howTo: '开发中；需要隔离的运行环境，默认关闭，每次运行单独授权。', alternative: '导出代码压缩包，在自己的电脑上运行测试。' },
  { id: 'web-search', name: '联网检索与网页读取', category: '联网', kind: 'external', intakeIds: ['web_search'], toolIds: [], free: false, needsApiKey: true, permissions: ['访问互联网'], description: '检索网页并保存来源快照作为引用依据。检索服务通常需要第三方 API Key，可能收费。', howTo: '尚未接入。可通过 MCP 管理中心接入经审核的检索类 MCP Server。', alternative: '把需要引用的网页另存为 PDF/文本后上传为项目资料。' },
  { id: 'image-read', name: '识别图片内容', category: '图像', kind: 'planned', intakeIds: ['image_read'], toolIds: [], free: false, needsApiKey: true, permissions: [], description: '让具备看图能力的模型读取图片。', howTo: '尚未实现：当前上传的图片只保存，不发送给模型。', alternative: '把图片中的关键信息整理成文字后上传。' },
  { id: 'image-generation', name: '生成图片', category: '图像', kind: 'external', intakeIds: ['image_generation'], toolIds: [], free: false, needsApiKey: true, permissions: ['调用第三方图像服务'], description: '调用图像生成服务制作配图。', howTo: '尚未接入。', alternative: '由岗位输出图片需求说明，再交给设计工具或设计人员。' },
];

function capabilityStatus(entry, { registered, progs }) {
  const missingPrograms = (entry.requires || []).filter(p => !progs[p]);
  if (entry.kind === 'planned' || (entry.kind === 'external' && !entry.toolIds.some(t => registered.has(t)))) return { status: 'not_implemented', missingPrograms };
  const toolsOk = entry.alwaysAvailable || entry.toolIds.some(t => registered.has(t));
  if (!toolsOk) return { status: 'needs_setup', missingPrograms };
  if (missingPrograms.length) return { status: 'needs_setup', missingPrograms };
  return { status: 'available', missingPrograms };
}

/* Full view for the capability center page. */
function listCapabilities({ tools = [], skills = [], mcp = { servers: [] } } = {}) {
  const registered = new Set(tools.map(t => t.toolId));
  const progs = programs();
  const entries = CATALOG.map(e => ({ ...e, ...capabilityStatus(e, { registered, progs }) }));
  const mcpTools = tools.filter(t => t.executionMode === 'mcp').map(t => ({ id: t.toolId, name: t.name, category: 'MCP 工具', kind: 'mcp', serverId: t.serverId, description: t.description, status: t.available ? 'available' : 'needs_setup', free: null, needsApiKey: null, permissions: ['由 MCP Server 决定；以服务账户权限运行'], howTo: '在 MCP 管理中心启用并测试。' }));
  const skillEntries = skills.map(s => ({ id: 'skill:' + s.skillId, name: s.name, category: 'Skills 工作流程', kind: 'skill', version: s.version, description: s.description || '', status: 'available',
    usesTools: s.steps.filter(x => x.type === 'tool').map(x => x.toolId), note: 'Skill 是提示词/检查/工具调用的组合配方，本身不是工具；其中引用的工具需单独可用并获授权。' }));
  return { capabilities: [...entries, ...mcpTools, ...skillEntries], programs: Object.fromEntries(Object.entries(progs).map(([k, v]) => [k, !!v])), mcpServers: mcp.servers || [] };
}

/* Map project-template tool IDs to real registry IDs and report gaps honestly. */
function resolveIntakeTools(intakeIds, { tools = [] } = {}) {
  const registered = new Set(tools.map(t => t.toolId));
  const progs = programs();
  return [...new Set(intakeIds)].map(id => {
    if (registered.has(id)) {
      const e = CATALOG.find(c => c.toolIds.includes(id));
      const st = e ? capabilityStatus(e, { registered, progs }) : { status: 'available', missingPrograms: [] };
      return { intakeId: id, toolId: id, status: st.status, capability: e?.name || id, missingPrograms: st.missingPrograms, howTo: e?.howTo, alternative: e?.alternative };
    }
    const e = CATALOG.find(c => c.intakeIds.includes(id));
    if (!e) return { intakeId: id, toolId: null, status: 'unknown', capability: id, howTo: '平台目录中没有这项能力；请通过 MCP 管理中心接入，或移除该工具要求。' };
    const st = capabilityStatus(e, { registered, progs });
    const toolId = e.toolIds.find(t => registered.has(t)) || null;
    return { intakeId: id, toolId: st.status === 'available' ? toolId : null, status: st.status, capability: e.name, kind: e.kind, free: e.free, needsApiKey: e.needsApiKey, missingPrograms: st.missingPrograms, howTo: e.howTo, alternative: e.alternative };
  });
}

/* ---------------- System readiness ---------------- */
const SCENARIOS = {
  basic: '用 AI 团队完成文档、方案、分析等工作',
  files: '读取上传的 PDF/Word/Excel/PPT 资料',
  tools: '使用外部工具（MCP）',
  public: '通过互联网多人访问（正式部署）',
};
function readiness({ system, models = [], tools = [], skills = [], mcp = { servers: [], configured: 0 }, store }, scenarios = ['basic']) {
  const want = new Set(scenarios.filter(s => SCENARIOS[s]));
  if (!want.size) want.add('basic');
  const progs = programs();
  const level = (needed, otherwise = 'optional') => needed ? 'required' : otherwise;
  const items = [];
  const add = (id, label, ok, lvl, detail, howTo, extra = {}) => items.push({ id, label, status: ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'missing', level: lvl, detail, howTo: ok === true ? '' : howTo, ...extra });
  const nodeMajor = Number(/^v(\d+)/.exec(system.node)?.[1]);
  add('runtime', 'Node.js 运行环境', nodeMajor >= 24, 'required', `当前 ${system.node}`, '安装 Node.js 24 或更高版本后重新启动。');
  add('database', '数据库存储', !!store?.schemaVersion, 'required', `SQLite 结构版本 ${store?.schemaVersion ?? '未知'}`, '检查数据目录是否可写；查看服务器日志。');
  add('admin', '管理员登录', system.adminSetup === true, 'required', system.adminSetup ? '已设置管理员密码' : '尚未设置', '用服务器上 data/setup-code.txt 中的一次性设置码在登录页设置密码。');
  const usable = models.filter(m => m.enabled && m.ready);
  const tested = usable.filter(m => m.status === 'available');
  add('models', 'AI 模型连接', tested.length > 0 ? true : usable.length ? 'warn' : false, 'required', `${models.length} 个连接，${usable.length} 个已配置，${tested.length} 个连接测试通过`,
    usable.length ? '在管理中心「模型」对模型点击「测试」。远程模型测试可能收费，需你确认。' : '在管理中心「模型」添加至少一个模型：选择服务商、粘贴 API Key、填写模型名，然后测试。没有 Key 时可接入本机 Ollama 等本地模型。');
  const keyless = usable.filter(m => !m.hasKey && !m.envReady && m.pricingMode !== 'local');
  add('api-keys', 'API Key 配置', keyless.length === 0 ? (usable.length ? true : 'warn') : false, 'required', keyless.length ? `${keyless.length} 个远程模型缺少 Key` : usable.length ? '已配置的模型都有 Key 或为本地模型' : '尚无模型',
    'API Key 在服务商官网的 API 管理页面创建（网页版/App 会员不包含 API 额度），在管理中心模型设置中粘贴保存。Key 不会再完整显示。');
  const remote = usable.some(m => m.pricingMode !== 'local');
  add('network', '网络出站', remote ? (system.proxy || system.dnsOk !== false ? true : 'warn') : true, level(remote && want.has('basic'), 'recommended'),
    system.proxy ? `通过 HTTPS 代理出站${system.proxyDnsDelegate ? '（代理负责 DNS）' : ''}` : '直接出站（严格 DNS 校验）',
    '若模型测试报“DNS/连接失败”，检查服务器能否访问模型服务商；企业网络需配置 HTTPS_PROXY。');
  const builtinCount = tools.filter(t => t.executionMode === 'builtin').length;
  add('builtin-tools', '内置工具', builtinCount > 0, 'required', `${builtinCount} 个内置工具可用（Word/Excel/PPT 生成、资料读取、文本检查等）`, '内置工具随程序提供；如为 0 请查看服务器日志。');
  add('file-processing', '文件处理环境（PDF）', progs.pdftotext ? true : 'warn', level(want.has('files'), 'recommended'),
    progs.pdftotext ? '已安装 pdftotext，可读取 PDF 文字' : '未安装 pdftotext：PDF 可上传但无法读取文字（Word/Excel/PPT/文本不受影响）', '在服务器安装 poppler-utils（Docker 镜像已内置）。');
  add('office-render', 'Office 渲染（LibreOffice）', progs.soffice ? true : 'warn', 'optional', progs.soffice ? '已安装（渲染预览工具开发中）' : '未安装；不影响生成 Word/Excel/PPT', '需要版式渲染检查时安装 LibreOffice。');
  const mcpOk = (mcp.servers || []).filter(s => s.available).length;
  add('mcp', 'MCP 外部工具', mcp.configured ? (mcpOk ? true : 'warn') : 'warn', level(want.has('tools'), 'optional'),
    mcp.configured ? `已配置 ${mcp.configured} 个 MCP Server，${mcpOk} 个最近连接成功` : '未配置（基础功能不需要 MCP）', '在「能力中心 → MCP 管理」查看目录与连接向导；只有服务器管理员能添加需要在服务器上运行的程序。');
  add('skills', 'Skills 工作流程', skills.length > 0 ? true : 'warn', 'optional', `${skills.length} 个 Skill`, '可在工作台「工具与 Skills」中添加。Skill 是提示词与检查的组合，不是工具。');
  add('backup', '备份', true, level(want.has('public'), 'recommended'), '可用 `npm run db:backup -- /私有目录/备份.sqlite` 做在线一致备份；完整恢复还需备份整个数据目录。',
    '', { status: 'warn', howTo: '定期在服务器执行数据库备份，并把整个数据目录复制到私有位置。平台无法确认你是否已经备份。' });
  const httpsOk = system.https === true;
  add('https', 'HTTPS 安全访问', httpsOk ? true : system.local ? 'warn' : false, level(want.has('public'), 'recommended'),
    httpsOk ? '当前通过 HTTPS 访问' : system.local ? '本机访问（未使用 HTTPS）' : '当前未使用 HTTPS',
    '公网访问必须使用 HTTPS：已有 HTTPS 入口时，为第二代增加一个子域名反向代理到本程序端口，并设置 AIJ_ENV=production、TRUST_PROXY=1。');
  add('budget', '费用与预算', true, 'required', '默认不调用收费或免费资格未验证的远程模型；每次运行需单独批准并填写价格、Token 与金额上限。', '',
    { status: remote ? 'warn' : 'ok', howTo: remote ? '运行使用远程模型的项目前，在工作台填写该模型的 USD 单价、Token 上限和金额上限并勾选批准。估算不等于服务商账单。' : '' });
  const groups = { required: [], recommended: [], optional: [] };
  for (const i of items) if (i.status !== 'ok') groups[i.level].push({ id: i.id, label: i.label, detail: i.detail, howTo: i.howTo });
  return { scenarios: [...want], scenarioNames: SCENARIOS, items, missing: groups, ready: groups.required.length === 0, generatedAt: Date.now() };
}

module.exports = { listCapabilities, resolveIntakeTools, readiness, CAPABILITY_CATALOG: CATALOG, SCENARIOS };
