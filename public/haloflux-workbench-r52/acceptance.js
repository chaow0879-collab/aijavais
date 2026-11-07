/* AIJAVAIS R52 deliverables & acceptance view | pure.
 * "已完成" is shown ONLY when a real (non-mock, non-failed) file exists AND the user's acceptance is
 * recorded by the source. Mock/fixture files are always labelled. Per-criterion human marks are
 * local notes of this browser, never server truth, and never turn into acceptance by themselves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.R52Acceptance = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MARKS = ['unverified', 'verified', 'failed'];
  const KIND = { docx: 'Word 文档', xlsx: 'Excel 表格', pptx: '演示文稿', svg: 'SVG 图形', md: 'Markdown 文本', txt: '文本', json: 'JSON 数据', csv: 'CSV 表格', zip: '代码包', pdf: 'PDF' };
  function view({ plan, projection, artifacts, marks } = {}) {
    const phase = projection ? projection.phase : 'idle';
    const files = (Array.isArray(artifacts) ? artifacts : []).map(a => {
      const ext = (a.filename.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
      const mock = a.origin !== 'server_artifact';
      return { ...a, kind: KIND[(ext || '').toLowerCase()] || '文件', mock, label: mock ? (a.origin === 'fixture' ? 'FIXTURE 样例文件' : 'MOCK 成果') : '服务器真实生成的文件', downloadable: !!a.download_url && a.status !== 'failed' };
    });
    const real = files.filter(f => !f.mock && f.status === 'produced');
    const usable = files.filter(f => f.status === 'produced');
    const m = marks && typeof marks === 'object' ? marks : {};
    const checks = (plan && Array.isArray(plan.acceptance) ? plan.acceptance : []).map(c => ({ id: c.id, text: c.text, source: c.source, mark: MARKS.includes(m[c.id]) ? m[c.id] : 'unverified' }));
    const failedChecks = checks.filter(c => c.mark === 'failed');
    let status, headline;
    if (phase === 'cancelled') { status = 'cancelled'; headline = '任务已取消：没有成果被验收。已发生的费用仍以账本为准。'; }
    else if (phase === 'failed') { status = 'failed'; headline = '任务失败：已保留的中间成果仅供检查，不能当作完成。'; }
    else if (phase === 'unknown') { status = 'unknown'; headline = '任务中断，状态未知：平台不会自动重做；请检查后决定是否重新授权运行。'; }
    else if (phase === 'accepted' && real.length) { status = 'accepted'; headline = '已完成：你已验收，并且有服务器真实生成的成果文件。'; }
    else if (phase === 'accepted') { status = 'accepted_without_file'; headline = '已记录验收，但没有服务器真实生成的成果文件，因此不显示为“已完成”。'; }
    else if (phase === 'delivered' && usable.length) { status = 'awaiting_acceptance'; headline = '成果已交付，等待你检查并验收或要求返工。'; }
    else if (phase === 'delivered') { status = 'delivered_without_file'; headline = '流程报告已交付，但还没有可下载的成果文件；可以先导出文件再验收。'; }
    else if (phase === 'rework') { status = 'rework'; headline = '正在返工：上一轮成果保留，可对比。'; }
    else if (['working', 'review', 'approved', 'created', 'blocked'].includes(phase)) { status = 'in_progress'; headline = phase === 'blocked' ? '工作受阻，见下方原因。' : '团队工作中，成果尚未交付。'; }
    else { status = 'none'; headline = '还没有运行，也没有成果。'; }
    return { status, headline, completed: status === 'accepted', files, real_files: real.length, mock_files: files.filter(f => f.mock).length, checks,
      failed_checks: failedChecks.length, unverified_checks: checks.filter(c => c.mark === 'unverified').length,
      marks_note: '逐条“人工已验/未验”只保存在本浏览器，帮助你检查；正式验收以“验收通过”按钮写入服务器的记录为准。',
      can_accept: status === 'awaiting_acceptance' && failedChecks.length === 0,
      can_rework: ['awaiting_acceptance', 'delivered_without_file'].includes(status) };
  }
  // Rework feedback text for the existing review API; step-targeted requests stay explicit about scope.
  function reworkFeedback(plan, stepIds, note) {
    const steps = (plan && plan.steps || []).filter(s => (stepIds || []).includes(s.step_id));
    const text = String(note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 2000);
    if (!text) return { ok: false, reason: '返工需要写明具体要改什么' };
    const scope = steps.length ? '请针对以下步骤返工：' + steps.map(s => '“' + s.title + '”').join('、') + '。' : '';
    return { ok: true, feedback: scope + text, note: '当前后端按整轮重新执行返工，反馈会指明重点步骤。返工是一次新的授权，费用上限需重新确认。' };
  }
  return { view, reworkFeedback, MARKS };
});
