/* AIJAVAIS Universal Team Draft v1 (R44) | offline, explainable rules; no API calls, no side effects.
 * Turns the user's OWN goal, expected outputs, audience, success criteria, constraints and risks into
 * an editable draft of roles, duties, boundaries, steps, review roles and delivery checks.
 * It is industry-agnostic on purpose: rules key on output forms, kinds of work and risk domains,
 * never on a fixed list of industries. Everything it produces is a suggestion marked not_verified. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIJUniversalTeam = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const text = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
  const lines = (x, maxLines, maxLen) => text(x, 4000).split(/\r?\n|[；;]/).map(s => s.replace(/^[\s\-*•·\d.、)）]+/, '').trim()).filter(Boolean).slice(0, maxLines).map(s => s.slice(0, maxLen));

  // ---- Output forms the user can pick explicitly (or that are detected from their words) ----
  const OUTPUTS = {
    document:   { label: '报告/文档', re: /报告|文档|方案|手册|说明书|白皮书|指南|制度|word|docx|章程|规范文本/i, tools: ['docx_generation'], role: ['writer', '文档撰写与排版员', '把专业内容整理成结构清晰、可编辑的文档', '目录、摘要、结论与依据齐全，可直接编辑', 'writing'] },
    spreadsheet:{ label: '表格/测算表', re: /表格|excel|xlsx|台账|测算表|清单表|数据表|价目表|报价单|一览表|统计表/i, tools: ['xlsx_generation'], role: ['sheet', '表格建模员', '建立可复核的表格结构、公式与校验', '公式可追溯、无来历不明的硬编码数字、含说明页', 'data_analysis'] },
    slides:     { label: '演示文稿', re: /ppt|幻灯片|演示稿|演示文稿|路演|汇报稿|课件/i, tools: ['pptx_generation'], role: ['slides', '演示文稿设计员', '把结论组织成面向听众的演示页面', '每页一个核心信息、可编辑、数据图表注明来源', 'writing'] },
    software:   { label: '软件/程序', re: /软件|程序|代码|网站|\bapp\b|小程序|接口开发|系统开发|插件|自动化工具|python|javascript/i, tools: ['repository_access', 'code_execution'], role: ['engineer', '软件实现工程师', '按确认的需求实现可运行的程序并附运行说明', '可运行、附自动化测试与运行说明，测试真实通过', 'coding'] },
    visual:     { label: '视觉/设计稿', re: /海报|图片|视觉|设计稿|logo|插画|包装设计|配图|版式/i, tools: ['image_generation'], role: ['visual', '视觉设计员', '形成与目标和对象一致的视觉方案', '尺寸/格式明确，文字可读，素材来源与授权说明清楚', 'vision'] },
    schedule:   { label: '计划/排期', re: /计划表|排期|日程|路线图|时间表|里程碑|行程|甘特/i, tools: ['xlsx_generation'], role: ['planner', '计划编制员', '把工作拆成有时间、负责人和依赖关系的计划', '每项任务有负责人、起止时间、依赖与风险缓冲', 'reasoning'] },
    curriculum: { label: '课程/培训材料', re: /课程|教案|培训|教学|讲义|练习册|工作坊/i, tools: ['docx_generation'], role: ['instructor', '课程与学习活动设计员', '设计学习目标、活动与评估方式', '学习目标可衡量、活动与时长匹配、含评估方法', 'writing'] },
    media:      { label: '文案/视频脚本', re: /文案|视频|短视频|直播|播客|脚本|推文|公众号|宣传语/i, tools: ['docx_generation'], role: ['editor', '内容脚本编辑', '撰写面向对象的文案或分镜脚本', '语气符合对象、事实可核查、无夸大与违规用语', 'writing'] }
  };
  // ---- Kinds of work found in the goal (industry-agnostic) ----
  const ACTIVITIES = {
    sources: { label: '资料调研与核实', re: /调研|研究|市场|竞品|文献|政策|资料|趋势|对比|标杆|现状|行情/, tools: ['web_search'], role: ['researcher', '资料与事实核查员', '收集并核对与目标相关的公开资料、政策与事实', '每条事实性结论附来源与日期，无法核实的标注“未核实”', 'research'] },
    data: { label: '数据整理分析', re: /数据|统计|指标|样本|问卷|销量|客流|转化率|分析|监测|选品/, tools: ['spreadsheet', 'chart_generation'], role: ['analyst', '数据整理与分析员', '整理数据口径、清洗并分析，给出可复核的结论', '写明数据来源、口径、样本量与局限，图表可复算', 'data_analysis'] },
    money: { label: '成本与预算', re: /预算|成本|报价|费用|定价|收益|利润|资金|投入产出|回本|经费/, tools: ['calculation', 'xlsx_generation'], role: ['costing', '成本与预算测算员', '列出假设并测算成本、预算或收益', '假设、单位与计算过程完整列出，可由他人复算', 'data_analysis'] },
    logistics: { label: '资源与执行安排', re: /物流|采购|供应|库存|场地|活动|会务|运输|排班|设备|物料|人手|招募/, tools: [], role: ['coordinator', '资源与执行协调员', '梳理执行所需的人、物、场地与时间安排', '资源清单、责任人与备选方案明确，冲突已标出', 'reasoning'] },
    stakeholder: { label: '对象沟通', re: /客户|用户|居民|会员|家长|患者|游客|访客|志愿者|社区|宣传|推广|顾客|学员|观众|粉丝|村民|农户|业主|乘客|市民|员工|读者|听众|买家|带货|家庭/, tools: [], role: ['experience', '对象沟通与体验设计员', '从使用对象角度设计沟通方式、触点与反馈渠道', '表达适合对象的理解水平，含收集反馈的方式', 'writing'] },
    process: { label: '流程规范', re: /流程|作业指导|sop|操作规范|质检|检查清单|标准化|交接/i, tools: [], role: ['process', '流程与操作规范编写员', '把工作方法整理为可执行、可检查的流程', '每步有输入、输出、负责人与检查点，可被新人照做', 'reasoning'] }
  };
  // ---- Risk domains: require a human professional; the platform never certifies them ----
  const RISKS = {
    medical:     { label: '医疗健康', re: /医疗|医药|药品|药物|诊断|治疗|患者|临床|处方|保健品|心理咨询|护理|康复|疫苗/, boundary: '不得给出诊断、处方或治疗结论；只整理信息并提示由执业医务人员审查' },
    legal:       { label: '法律合规', re: /法律|合同|诉讼|法规|合规|许可证|资质|知识产权|劳动法|备案|监管|规定|条例|规章/, boundary: '不得出具法律意见；法规与条款引用须标注待执业律师/合规人员确认' },
    finance:     { label: '金融财税', re: /投资|证券|贷款|保险|理财|税务|审计|基金|融资|股权|信贷/, boundary: '不得给出个性化投资、税务或信贷建议；数字须注明来源与假设' },
    safety:      { label: '人身/生产安全', re: /安全|食品|化学|危险品|电气|施工|消防|结构|特种设备|辐射|农药|兽药|检疫|高空|有毒|急救/, boundary: '不得替代持证工程/安全人员签字；安全相关参数必须引用适用标准并人工复核' },
    minors:      { label: '未成年人', re: /儿童|未成年|幼儿|小学生|中学生|托育/, boundary: '涉及未成年人的内容须由监护人或机构审核，不收集不必要的个人信息' },
    privacy:     { label: '个人信息', re: /个人信息|隐私|身份证|病历|人脸|定位数据|手机号|住址/, boundary: '只使用最小必要的个人信息，草案中不得写入真实身份信息' },
    environment: { label: '环境影响', re: /环保|排放|污染|环评|废水|废气|固废|碳排|无害化/, boundary: '环境结论须依据适用标准与监测数据，由专业人员确认' }
  };
  const EXTERNAL = /对外|客户|公开|发布|上线|正式|投标|报送|上报|销售|商用|量产|开业|直播|带货|电商/;
  const RISK_FIELD = { id: 'risk', label: '任务风险等级', options: [{ value: 'low', text: '低：内部草稿/探索' }, { value: 'medium', text: '中：重要内部使用或面向少量对象' }, { value: 'high', text: '高：对外、涉及安全/健康/资金/法律或重大决策' }], help: '高风险任务会增加独立复核和人工专家审查' };
  const RIGOR_FIELD = { id: 'rigor', label: '审核严谨程度', options: [{ value: 'lean', text: '精简：单人完成后自查' }, { value: 'normal', text: '标准：独立复核一次' }, { value: 'strict', text: '严格：多重复核并保留证据' }], help: '越严格越慢，但更适合正式或高风险用途' };
  const LIMITS = { domain: 60, field: 2000, criteria: 12, criterionLen: 200, outputs: 8, maxRoles: 12 };

  function sanitize(u) {
    u = u && typeof u === 'object' && !Array.isArray(u) ? u : {};
    const outputs = Array.isArray(u.outputs) ? [...new Set(u.outputs.map(String).filter(k => Object.hasOwn(OUTPUTS, k)))].slice(0, LIMITS.outputs) : [];
    return { domain: text(u.domain, LIMITS.domain), outputs, successCriteria: lines(u.successCriteria, LIMITS.criteria, LIMITS.criterionLen),
      constraints: text(u.constraints, LIMITS.field), risks: text(u.risks, LIMITS.field), deadline: text(u.deadline, 100), budgetNote: text(u.budgetNote, 200) };
  }
  // Pure analysis: what the user's own words say about outputs, work and risk. No guessing of an industry.
  function analyze(input) {
    input = input || {};
    const u = sanitize(input.universal);
    const audience = text(input.audience, 200);
    const corpus = [input.description, input.context, input.deliveryExpectation, audience, u.domain, u.constraints, u.risks, u.successCriteria.join(' ')].map(x => text(x, 20000)).join('\n');
    const detectedOutputs = Object.keys(OUTPUTS).filter(k => OUTPUTS[k].re.test(corpus));
    const outputs = u.outputs.length ? u.outputs : detectedOutputs;
    const activities = Object.keys(ACTIVITIES).filter(k => ACTIVITIES[k].re.test(corpus));
    const riskDomains = Object.keys(RISKS).filter(k => RISKS[k].re.test(corpus));
    const external = EXTERNAL.test(corpus);
    const risk = riskDomains.length ? 'high' : external ? 'medium' : 'low';
    const rigor = risk === 'high' ? 'strict' : risk === 'medium' ? 'normal' : 'lean';
    const clarifications = [];
    const ask = (id, question, blocking) => clarifications.push({ id, question, blocking });
    if (!u.domain) ask('domain', '这项工作属于什么领域或行业？用你自己的话写（例如“社区养老服务”），系统不会套用其他行业的模板。', true);
    if (!outputs.length) ask('outputs', '最终要交付什么形式的成果？（文档、表格、演示、程序、设计稿、计划、课程、文案……）', true);
    if (!u.successCriteria.length) ask('successCriteria', '怎样算做好了？请写 1–3 条可检查的成功标准。', true);
    if (!audience) ask('audience', '成果给谁使用或审阅？对象不同，语言和深度也不同。', false);
    if (!u.constraints) ask('constraints', '有没有必须遵守的规范、标准、地区、时间或资源限制？', false);
    if (riskDomains.length) ask('jurisdiction', '检测到' + riskDomains.map(k => RISKS[k].label).join('、') + '相关内容：请说明适用的地区、标准或规范，并安排具备资质的人工专家审查。', false);
    if (!activities.length && outputs.length <= 1 && text(input.description, 20000).length < 30) ask('detail', '目标描述较简略：请补充背景、关键步骤或已知难点，以便拆分岗位。', false);
    return { universal: u, audience, outputs, detectedOutputs, outputsSource: u.outputs.length ? 'user' : 'detected', activities, riskDomains, external, risk, rigor, clarifications,
      status: clarifications.some(c => c.blocking) ? 'needs_clarification' : 'draft_ready_for_edit' };
  }
  function buildTemplate(input) {
    const a = analyze(input);
    const u = a.universal;
    const domain = u.domain || '（领域待确认）';
    const who = a.audience || '使用对象';
    const goal = text(input && input.description, 80);
    const riskBoundaries = a.riskDomains.map(k => RISKS[k].boundary);
    const generalBoundary = '只基于用户提供的信息和可核实来源工作；不确定的内容标注“待确认”，不得虚构数据、来源或已完成的工作';
    const roles = [], steps = [];
    const add = (key, name, duty, boundary, standard, capability, required, step) => {
      roles.push({ id: 'u-' + key, name, duty, boundary, standard, capabilities: capability ? [capability] : [], required });
      steps.push({ id: 'u-step-' + key, roleId: 'u-' + key, order: step.order, title: step.title, deliverable: step.deliverable, quality: step.quality || standard, tools: step.tools || [] });
    };
    const hasFiles = /已有|现有|附件|资料|数据表|材料|文件/.test(text(input && input.referenceNotes, 2000) + text(input && input.context, 2000));
    add('scope', '需求与范围协调员', '与用户确认' + domain + '目标“' + goal + '”的范围、对象、成功标准和限制，并记录未决问题', generalBoundary,
      '范围说明书列出目标、对象、交付形式、成功标准与待澄清问题清单', 'reasoning', true,
      { order: 10, title: '澄清目标与范围', deliverable: '范围说明书与待澄清问题清单', tools: hasFiles ? ['file_read'] : [] });
    for (const k of a.activities) {
      const [key, name, duty, standard, cap] = ACTIVITIES[k].role;
      const label = k === 'stakeholder' ? who + '沟通与体验设计员' : name;
      const order = { sources: 20, data: 30, money: 50, logistics: 60, stakeholder: 70, process: 80 }[k];
      add(key, label, duty + '（面向' + domain + '）', generalBoundary, standard, cap, true,
        { order, title: { sources: '收集与核对资料', data: '整理与分析数据', money: '测算成本与预算', logistics: '安排资源与执行', stakeholder: '设计对象沟通与反馈', process: '编写流程与操作规范' }[k],
          deliverable: { sources: '带来源与核实状态的资料摘要', data: '数据说明与分析结论（含图表）', money: '假设清单与测算表', logistics: '资源清单与执行安排', stakeholder: '沟通方案与反馈收集方式', process: '可执行流程与检查点' }[k],
          tools: ACTIVITIES[k].tools });
    }
    add('lead', domain + '专业内容负责人', '围绕用户目标形成' + domain + '的核心专业内容，并整合各岗位成果',
      [generalBoundary, ...riskBoundaries].join('；'), '核心内容覆盖全部成功标准，引用与假设可追溯，未经验证处明确标注', 'reasoning', true,
      { order: 40, title: '形成核心专业内容', deliverable: domain + '核心内容初稿', tools: [] });
    for (const k of a.outputs) {
      const [key, name, duty, standard, cap] = OUTPUTS[k].role;
      add(key, name, duty + '（对象：' + who + '）', generalBoundary, standard, cap, true,
        { order: 90, title: '制作' + OUTPUTS[k].label, deliverable: OUTPUTS[k].label + '成品（可编辑）', tools: OUTPUTS[k].tools });
      if (k === 'software') add('tester', '测试工程师', '为程序设计并运行自动化测试，记录真实结果', generalBoundary + '；只报告真实运行过的测试', '测试覆盖主要功能与异常输入，结果可复现', 'coding', false,
        { order: 95, title: '测试程序', deliverable: '测试代码与真实测试报告', tools: ['code_execution'] });
    }
    if (a.riskDomains.length) {
      const labels = a.riskDomains.map(k => RISKS[k].label).join('、');
      add('risk', '合规与风险审查员（' + labels + '，非持证专家）', '逐项检查' + labels + '相关风险，列出必须由人工专家确认的内容', riskBoundaries.join('；'),
        '风险清单逐项标注依据与“需人工专家确认”，不出具专业结论', 'reasoning', true,
        { order: 100, title: '风险与合规检查', deliverable: '风险清单与人工专家审查要点', tools: [] });
    }
    add('review', '独立质量复核员', '对照成功标准与交付检查项独立复核全部成果，退回不合格项', generalBoundary + '；复核意见须指向具体问题',
      '逐条对照交付检查项给出通过/不通过与理由', 'reasoning', false,
      { order: 110, title: '独立复核与返工', deliverable: '复核记录与返工清单', tools: [] });
    // Bounded team size: keep the earliest-priority roles, tell the user to split the work.
    // Scope, lead, risk and review roles are always kept; other roles fill the remaining seats in order.
    const fixed = new Set(['u-scope', 'u-lead', 'u-risk', 'u-review']);
    const others = roles.filter(r => !fixed.has(r.id));
    const room = LIMITS.maxRoles - roles.filter(r => fixed.has(r.id)).length;
    const overflow = others.length > room;
    const keep = new Set([...roles.filter(r => fixed.has(r.id)), ...others.slice(0, room)].map(r => r.id));
    const finalRoles = roles.filter(r => keep.has(r.id));
    const finalSteps = steps.filter(s => keep.has(s.roleId)).sort((x, y) => x.order - y.order).map(({ order, ...s }) => s); // eslint-disable-line no-unused-vars
    const checks = [
      ...u.successCriteria.map((t, i) => ({ id: 'user-' + (i + 1), text: t, source: 'user', verification: 'not_verified' })),
      ...a.outputs.map(k => ({ id: 'out-' + k, text: OUTPUTS[k].role[3], source: 'rule', verification: 'not_verified' })),
      ...a.activities.map(k => ({ id: 'act-' + k, text: ACTIVITIES[k].role[3], source: 'rule', verification: 'not_verified' })),
      ...(a.riskDomains.length ? [{ id: 'risk-human', text: '涉及' + a.riskDomains.map(k => RISKS[k].label).join('、') + '的内容已由具备资质的人工专家审查并签字', source: 'rule', verification: 'not_verified' }] : []),
      { id: 'honesty', text: '未虚构数据、来源、工具调用或已完成工作；未核实处已标注', source: 'rule', verification: 'not_verified' }
    ];
    const reviewStep = finalSteps.find(s => s.id === 'u-step-review');
    if (reviewStep) reviewStep.quality = '逐条核对：' + checks.map(c => c.text).join('；').slice(0, 380);
    const humanCheckpoints = a.riskDomains.map(k => ({ domain: k, label: RISKS[k].label, requirement: '对外使用前须由具备资质的' + RISKS[k].label + '专业人员人工审查（平台与 AI 均不具备该认证）' }));
    if (overflow) a.clarifications.push({ id: 'scope-size', question: '目标涉及的工作类型较多，团队已限制为 ' + LIMITS.maxRoles + ' 个岗位；建议拆分为多个项目。', blocking: false });
    const withDefault = (f, v) => ({ ...f, defaultValue: v });
    return {
      id: 'universal', name: '通用编队：' + domain, summary: '根据你的目标、成果形式、对象与风险生成的可编辑团队草案（离线规则，未调用模型）', keywords: [],
      roles: finalRoles, steps: finalSteps, quantFields: [withDefault(RISK_FIELD, a.risk), withDefault(RIGOR_FIELD, a.rigor)],
      disclaimer: '本团队草案由离线规则根据你的输入生成，未调用 AI 模型，也未经任何领域专家或资质认证' + (a.riskDomains.length ? '；涉及' + a.riskDomains.map(k => RISKS[k].label).join('、') + '的内容必须由人工专家审查' : ''),
      universal: { generator: 'offline_rules_v1', status: a.status, verification: 'not_verified', domain: u.domain, audience: a.audience,
        outputs: a.outputs, outputsSource: a.outputsSource, activities: a.activities, riskDomains: a.riskDomains, suggestedRisk: a.risk, suggestedRigor: a.rigor,
        clarifications: a.clarifications, deliveryChecks: checks, humanCheckpoints, input: u }
    };
  }
  const OUTPUT_OPTIONS = Object.keys(OUTPUTS).map(k => ({ value: k, text: OUTPUTS[k].label }));
  const labels = obj => Object.fromEntries(Object.keys(obj).map(k => [k, obj[k].label]));
  return { analyze, buildTemplate, sanitize, OUTPUT_OPTIONS, LIMITS, LABELS: { outputs: labels(OUTPUTS), activities: labels(ACTIVITIES), risks: labels(RISKS) } };
});
