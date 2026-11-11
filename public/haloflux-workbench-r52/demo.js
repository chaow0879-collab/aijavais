/* AIJAVAIS R52 DEMO script | builds a clearly labelled DEMO event sequence from the CURRENT plan
 * so a user can preview what HALOFLUX will show. Every event carries evidence "DEMO" and
 * source "demo"; the UI shows the DEMO badge and never counts these as work or cost. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./contract.js'));
  else root.R52Demo = factory(root.R52Contract);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  function demoEvents(plan, startAt) {
    const t0 = Number.isFinite(startAt) ? startAt : 0;
    const work = 'demo-' + String(plan && plan.plan_id || 'plan').replace(/[^\w.-]/g, '').slice(0, 40);
    const out = [];
    const push = (type, extra) => { const seq = out.length + 1; out.push({ schema: C.EVENT_SCHEMA, event_id: work + '-' + seq, work_id: work, task_id: work, seq, type, at: t0 + seq * 1000,
      parent_event_id: seq > 1 ? work + '-' + (seq - 1) : null, source: 'demo', evidence: 'DEMO', detail: '演示事件（不是真实工作）', ...extra }); };
    push('task_created', {});
    const steps = (plan && plan.steps || []).slice(0, 6);
    for (const s of steps) {
      push('work_started', { role_id: s.role_id, step_id: s.step_id });
      push('completed', { role_id: s.role_id, step_id: s.step_id });
    }
    if (steps.length) push('peer_review', { role_id: steps[steps.length - 1].role_id });
    return out;
  }
  return { demoEvents };
});
