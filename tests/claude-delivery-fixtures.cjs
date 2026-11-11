'use strict';
// #17 synthetic deliverable fixtures for the three industries. Everything here is
// SYNTHETIC test data written for this repository: it is not real customer data,
// a real organization, or real research findings.

// A: software development - a real, minimal, runnable CommonJS ledger module.
const software = () => ({
  sections: [{ heading: '交付说明', text: '记账工具最小实现：记录收支、按月汇总，附可执行测试。' }],
  files: [
    { path: 'README.md', content: '# 记账工具（合成示例）\n\n运行测试：node test/ledger.test.js\n入口：src/ledger.js\n' },
    { path: 'package.json', content: JSON.stringify({ name: 'ledger-sample', version: '0.1.0', private: true, main: 'src/ledger.js' }, null, 2) },
    { path: 'src/ledger.js', content: "'use strict';\nfunction add(entries, entry) {\n  if (!entry || !Number.isFinite(entry.amount) || !/^\\d{4}-\\d{2}$/.test(entry.month)) throw new Error('invalid entry');\n  return [...entries, { ...entry }];\n}\nfunction summary(entries) {\n  const out = {};\n  for (const e of entries) out[e.month] = Math.round(((out[e.month] || 0) + e.amount) * 100) / 100;\n  return out;\n}\nmodule.exports = { add, summary };\nif (require.main === module) console.log(JSON.stringify(summary(add([], { month: '2026-11', amount: 12.5 }))));\n" },
    { path: 'test/ledger.test.js', content: "'use strict';\nconst assert = require('node:assert/strict');\nconst { add, summary } = require('../src/ledger.js');\nlet e = add([], { month: '2026-10', amount: 100 });\ne = add(e, { month: '2026-10', amount: -20.5 });\ne = add(e, { month: '2026-11', amount: 7 });\nassert.deepEqual(summary(e), { '2026-10': 79.5, '2026-11': 7 });\nassert.throws(() => add(e, { month: 'bad', amount: 1 }));\nconsole.log('LEDGER SMOKE OK');\n" },
  ],
  software: { entry: 'src/ledger.js', test: 'test/ledger.test.js', install: '无需安装第三方依赖（Node.js 24+）', run: 'node src/ledger.js', testCommand: 'node test/ledger.test.js', expectOutput: 'LEDGER SMOKE OK' },
});
const placeholderSoftware = () => ({ files: [{ path: 'README.md', content: '# demo' }, { path: 'src/app.js', content: '// MOCK PLACEHOLDER: real implementation not generated\nmodule.exports = {};\n' }], software: { entry: 'src/app.js', test: 'src/app.js', run: 'node src/app.js' } });

// B: enterprise organization design for a synthetic 120-person manufacturer.
const organization = () => ({
  sections: [{ heading: '组织优化建议', text: '缩短审批链至两级；明确质量放行职责；设跨部门协调人。' }],
  orgChart: { title: '合成制造企业组织结构（建议稿）', nodes: [
    { id: 'gm', name: '总经理', title: '总经理', duties: ['经营目标', '重大决策审批'], boundary: '不直接干预质量放行' },
    { id: 'ops', name: '运营总监', title: '运营', parentId: 'gm', duties: ['生产与计划'], boundary: '不得批准质量例外' },
    { id: 'qa', name: '质量经理', title: '质量', parentId: 'gm', duties: ['检验放行', '质量体系'], boundary: '放行独立于生产进度' },
    { id: 'hr', name: '人力资源经理', title: '人事', parentId: 'gm', duties: ['岗位与编制'], boundary: '不得单独决定裁员' },
    { id: 'prod', name: '生产主管', title: '生产', parentId: 'ops', duties: ['排产执行'], boundary: '按计划执行，变更需运营批准' },
    { id: 'plan', name: '计划专员', title: '计划', parentId: 'ops', duties: ['需求与排产计划'], boundary: '无采购审批权' },
    { id: 'insp', name: '检验组长', title: '检验', parentId: 'qa', duties: ['来料与成品检验'], boundary: '可暂停不合格批次' },
    { id: 'coord', name: '跨部门协调人', title: '协调', parentId: 'gm', duties: ['跨部门问题跟踪'], boundary: '无审批权，只协调' },
  ] },
  rows: [['事项', '负责人', '状态'], ['缩短审批链', '运营总监', '待审批'], ['质量放行', '质量经理', '待审批']],
  slides: [{ title: '组织优化摘要', bullets: ['审批链两级', '质量放行独立', '设协调人'] }],
});

// C: cross-domain research with an explicit evidence chain.
const research = () => ({
  sections: [{ heading: '研究报告框架', text: '社区老年人数字服务可及性：问题、方法、伦理与初步结论（合成数据）。' }],
  claims: [
    { id: 'C1', text: '合成样本中，75岁以上组使用线上办事的比例低于65–74岁组。', evidenceIds: ['E1'], assumptionIds: ['A1'] },
    { id: 'C2', text: '社区志愿者陪同可能降低首次使用障碍。', evidenceIds: ['E2'], confidence: '中' },
    { id: 'C3', text: '某地2025年老年人口占比为21.3%。', evidenceIds: ['E3'] },
    { id: 'C4', text: '适老化改造能显著提升满意度。', evidenceIds: [] },
  ],
  evidence: [
    { id: 'E1', kind: 'synthetic', citation: '本仓库合成问卷数据集（n=200，随机生成）' },
    { id: 'E2', kind: 'source', citation: '某社区服务案例报告（待人工核实）', url: 'https://example.org/report' },
    { id: 'E3', kind: 'data', citation: '统计年鉴（模型给出，未核实）', verification: 'verified' },
  ],
  assumptions: [{ id: 'A1', text: '合成样本年龄分布近似真实社区' }],
});
module.exports = { software, placeholderSoftware, organization, research };
