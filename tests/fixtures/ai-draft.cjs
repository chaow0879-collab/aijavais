'use strict';
// Deliberately a local MOCK response, never a real vendor or executed tool.
module.exports = function draft() {
  return { goal: '为一个全新的跨领域需求设计可审核的团队和工作成果',
    roles: [
      { roleId: 'planner', name: '方案设计者', duty: '分析目标并制定方案', boundary: '不得自行批准费用或成果', standard: '每项结论对应证据', requiredCapabilities: ['reasoning'] },
      { roleId: 'reviewer', name: '独立审核者', duty: '审核方案和交接证据', boundary: '不得代替用户作最终决定', standard: '列出问题和修改建议', requiredCapabilities: ['writing'] }
    ], steps: [
      { stepId: 'design', roleId: 'planner', title: '完成方案', prompt: '制定可执行且有证据的方案', deliverable: '方案草稿', quality: '覆盖全部目标', handoff: 'previous' },
      { stepId: 'review', roleId: 'reviewer', title: '审核方案', prompt: '核对前序输出和目标', deliverable: '审核清单', quality: '问题有证据', handoff: 'all' }
    ], deliverables: ['方案草稿', '审核清单'], acceptance: ['结论可核查', '用户最终确认'],
    tools: ['builtin:text-stats'], skills: ['unknown-planning-skill'], humanDecisions: ['确认项目范围和最终验收'] };
};
