'use strict';
// R52 fixtures: blind unfamiliar / cross-domain goals and R53-shaped event + artifact DTO bundles.
// None of these domains is enumerated anywhere in the product source (checked by the tests).
const EVENT = 'aijavais.workbench.event/v1', ARTIFACT = 'aijavais.workbench.artifact/v1';

const BLIND = [
  { key: 'racing-pigeons', never: '赛鸽', goal: '为赛鸽俱乐部策划秋季500公里竞翔赛的赛程排期表、费用测算表和鸽友报名须知', domain: '赛鸽竞翔俱乐部', success: '排期覆盖集鸽、司放、归巢\n费用表可复算',
    expect: { outputs: ['spreadsheet', 'schedule'], highRisk: false } },
  { key: 'shadow-puppet-class', never: '皮影', goal: '为皮影戏剧团设计面向小学生的皮影制作工作坊课程和课件', domain: '皮影戏传承教育', success: '课程有可衡量的学习目标',
    expect: { outputs: ['curriculum', 'slides'], highRisk: true, risk: ['minors'] } },
  { key: 'ice-sculpture-safety', never: '冰雕', goal: '为冰雕节制定游客安全巡检流程和现场应急广播文案，需要现场搭建围栏', domain: '冰雕艺术节运营', success: '巡检点全部有负责人',
    expect: { outputs: ['media'], activities: ['process'], highRisk: true, risk: ['safety'], cannot: ['physical'] } },
  { key: 'ancient-books', never: '古籍修复', goal: '整理一批古籍修复档案的统计表和修复报告，附修复前后对比海报', domain: '古籍修复档案', success: '每册档案有编号与修复记录',
    expect: { outputs: ['document', 'spreadsheet', 'visual'], highRisk: false } },
  { key: 'dive-first-aid', never: '潜水', goal: '为潜水俱乐部编写减压病急救培训讲义和学员体检问卷', domain: '休闲潜水培训', success: '讲义覆盖识别与转运',
    expect: { outputs: ['curriculum'], highRisk: true, risk: ['medical', 'safety'] } },
  { key: 'wine-cellar-finance', never: '葡萄酒', goal: '为家族葡萄酒窖做三年库存与税务成本测算表，并写给投资人的融资路演PPT', domain: '家族酒窖经营', success: '测算假设全部列出',
    expect: { outputs: ['spreadsheet', 'slides'], highRisk: true, risk: ['finance'] } },
  { key: 'fishing-fleet', never: '渔船', goal: '给沿海渔船队排出海轮班表，整理船员手机号通讯录，并把水产上架到电商', domain: '沿海渔船队', success: '轮班不冲突',
    expect: { outputs: ['schedule'], highRisk: true, risk: ['privacy'], cannot: ['external_action'] } },
  { key: 'beekeeping-video', never: '养蜂', goal: '帮养蜂合作社拍摄短视频带货脚本，并做蜂蜜定价表', domain: '养蜂合作社', success: '定价覆盖成本',
    expect: { outputs: ['spreadsheet', 'media'], highRisk: false, cannot: ['physical'] } }
];

function ev(work, seq, type, extra = {}) {
  return { schema: EVENT, event_id: work + '-e' + seq, work_id: work, task_id: work + '-task', seq, type, at: Date.UTC(2026, 10, 7, 10, 0, seq),
    parent_event_id: seq > 1 ? work + '-e' + (seq - 1) : null, source: 'r53_fixture', evidence: 'E2_FAKE', ...extra };
}
// A full R53-style bundle for one plan: roles a,b,c (ids taken from the plan) with hand-offs, review,
// rework, unknown cost and a delivered (fixture, data: URL) SVG. Order is shuffled and contains
// duplicates, an unrecognized type, a retraction and a deliberately missing seq when `gap` is true.
function bundle(roleIds, { work = 'r53w', gap = false, cancelRole = false, unknownCost = true } = {}) {
  const [a, b, c] = roleIds;
  const list = [
    ev(work, 1, 'task_created'), ev(work, 2, 'approved', { detail: '后端记录：用户批准本轮' }),
    ev(work, 3, 'agent_started', { role_id: a }), ev(work, 4, 'work_started', { role_id: a }),
    ev(work, 5, 'cost_reported', { role_id: a, cost: { usd: 0.012, status: 'settled', ledger_id: 'l1' } }),
    ev(work, 6, 'handoff', { role_id: a, to_role_id: b, artifact_id: 'art-a' }),
    ev(work, 7, 'work_started', { role_id: b }),
    ev(work, 8, 'cost_reported', { role_id: b, cost: unknownCost ? { usd: null, status: 'unknown', ledger_id: 'l2' } : { usd: 0.02, status: 'settled', ledger_id: 'l2' } }),
    ev(work, 9, 'v2.future_signal', { role_id: b, detail: '未来版本的新事件类型' }),
    ev(work, 10, 'peer_review', { role_id: c, detail: '复核 b 的成果' }),
    ev(work, 11, 'rework_requested', { role_id: b, detail: '数据口径不一致' }),
    ev(work, 12, cancelRole ? 'cancelled' : 'work_started', { role_id: b }),
    ev(work, 13, 'blocked', { role_id: c, detail: '缺少人工专家签字' }),
    ev(work, 14, 'retracted', { retracts: work + '-e13', detail: '误报，撤回受阻事件' }),
    ev(work, 15, 'completed', { role_id: b }),
    ev(work, 16, 'delivered', { artifact_id: 'art-final' })
  ];
  const order = [4, 1, 3, 2, 6, 5, 8, 7, 9, 12, 10, 11, 14, 13, 16, 15];
  let shuffled = order.map(i => list[i - 1]);
  shuffled.splice(3, 0, { ...list[1] }); // exact duplicate
  if (gap) shuffled = shuffled.filter(e => e.seq !== 10);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="4" y="24">R52 FIXTURE</text></svg>';
  const artifacts = [
    { schema: ARTIFACT, artifact_id: 'art-final', work_id: work, filename: 'fixture-final.svg', mime: 'image/svg+xml', bytes: Buffer.byteLength(svg),
      download_url: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), origin: 'fixture', evidence: 'E2_FAKE', status: 'produced' }
  ];
  return { schema: 'aijavais.workbench.bundle/v1', note: 'R53 DTO fixture for R52 (E2_FAKE, not real work)', events: shuffled, artifacts };
}
module.exports = { BLIND, bundle, ev, EVENT, ARTIFACT };
