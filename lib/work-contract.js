/* AIJAVAIS R52 workbench contract | pure, offline, no side effects.
 * Defines the local JSON DTOs the R52 front end consumes (plan / event / artifact) and an adapter
 * from the EXISTING read-only V2 run view (GET /api/v2/runs/:id) to those DTOs. The R53 backend
 * (Codex) may emit the same event DTO directly; nothing here decides business state on its own:
 * the UI only projects what the source recorded. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.R52Contract = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PLAN_SCHEMA = 'aijavais.workbench.plan/v1';
  const EVENT_SCHEMA = 'aijavais.workbench.event/v1';
  const ARTIFACT_SCHEMA = 'aijavais.workbench.artifact/v1';
  // Evidence levels. Only E4/E5 can ever mean a real provider / a real human outcome.
  const EVIDENCE = ['DEMO', 'FIXTURE', 'E2_FAKE', 'E3_FAKE', 'SERVER_RECORDED', 'E4', 'E5'];
  // Event vocabulary: the R53 (#36) names plus the projection states R52 (#35) must show.
  const TYPES = {
    task_created:     { scope: 'task', label: '任务已创建' },
    approved:         { scope: 'task', label: '已获后端授权' },
    agent_started:    { scope: 'role', state: 'started', label: '岗位启动' },
    work_started:     { scope: 'role', state: 'working', label: '开始工作' },
    tool_used:        { scope: 'role', state: 'working', label: '调用工具' },
    handoff:          { scope: 'role', state: 'handoff', label: '交接' },
    peer_review:      { scope: 'role', state: 'review', label: '同伴审核' },
    rework_requested: { scope: 'any',  state: 'rework', label: '要求返工' },
    blocked:          { scope: 'any',  state: 'blocked', label: '受阻' },
    completed:        { scope: 'role', state: 'completed', label: '完成' },
    delivered:        { scope: 'task', label: '成果已交付，待验收' },
    accepted:         { scope: 'task', label: '用户已验收' },
    cancelled:        { scope: 'any',  state: 'cancelled', label: '已取消' },
    failed:           { scope: 'any',  state: 'failed', label: '失败' },
    interrupted:      { scope: 'any',  state: 'unknown', label: '中断（状态未知）' },
    cost_reported:    { scope: 'any',  label: '费用记录' },
    retracted:        { scope: 'any',  label: '撤回事件' }
  };
  const COST_STATUS = ['settled', 'upper_bound', 'reserved', 'unknown', 'local_zero'];
  const ID = /^[A-Za-z0-9._:-]{1,120}$/;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const text = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
  const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const toMs = at => { const n = typeof at === 'number' ? at : Date.parse(at); return Number.isFinite(n) ? n : null; };

  function normalizeCost(c) {
    if (c == null) return null;
    if (!isObj(c)) return { usd: null, status: 'unknown' };
    const status = COST_STATUS.includes(c.status) ? c.status : 'unknown';
    const usd = typeof c.usd === 'number' && Number.isFinite(c.usd) && c.usd >= 0 && status !== 'unknown' ? c.usd : null;
    return { usd, status: usd === null && status !== 'unknown' ? 'unknown' : status, ledger_id: c.ledger_id && ID.test(c.ledger_id) ? c.ledger_id : null };
  }
  // Returns { ok, event?, error? }. Unknown types are NOT errors: they are kept, flagged and never change state.
  function validateEvent(e) {
    if (!isObj(e)) return { ok: false, error: 'not_an_object' };
    if (e.schema !== EVENT_SCHEMA) return { ok: false, error: 'bad_schema' };
    for (const k of ['event_id', 'work_id']) if (typeof e[k] !== 'string' || !ID.test(e[k])) return { ok: false, error: 'bad_' + k };
    if (!Number.isSafeInteger(e.seq) || e.seq < 1) return { ok: false, error: 'bad_seq' };
    if (typeof e.type !== 'string' || !/^[a-z0-9_:.-]{1,60}$/.test(e.type)) return { ok: false, error: 'bad_type' };
    for (const k of ['task_id', 'parent_event_id', 'role_id', 'step_id', 'artifact_id', 'retracts', 'to_role_id'])
      if (e[k] != null && (typeof e[k] !== 'string' || !ID.test(e[k]))) return { ok: false, error: 'bad_' + k };
    const at = toMs(e.at);
    if (at === null) return { ok: false, error: 'bad_at' };
    const evidence = EVIDENCE.includes(e.evidence) ? e.evidence : null;
    if (!evidence) return { ok: false, error: 'bad_evidence' };
    if (e.type === 'retracted' && !e.retracts) return { ok: false, error: 'retract_without_target' };
    const event = { schema: EVENT_SCHEMA, event_id: e.event_id, work_id: e.work_id, task_id: e.task_id || null, seq: e.seq, parent_event_id: e.parent_event_id || null,
      type: e.type, recognized: own(TYPES, e.type), role_id: e.role_id || null, to_role_id: e.to_role_id || null, step_id: e.step_id || null,
      artifact_id: e.artifact_id || null, retracts: e.retracts || null, at, source: text(e.source, 40) || 'unknown', evidence,
      cost: normalizeCost(e.cost), detail: text(e.detail, 500) };
    return { ok: true, event };
  }
  // Stable digest used for idempotency: same event_id + different content is a conflict, not an update.
  function digest(ev) {
    const keys = ['event_id', 'work_id', 'task_id', 'seq', 'parent_event_id', 'type', 'role_id', 'to_role_id', 'step_id', 'artifact_id', 'retracts', 'at', 'evidence', 'detail'];
    return JSON.stringify(keys.map(k => ev[k] === undefined ? null : ev[k]).concat([ev.cost ? [ev.cost.usd, ev.cost.status, ev.cost.ledger_id] : null]));
  }
  function validateArtifact(a) {
    if (!isObj(a) || a.schema !== ARTIFACT_SCHEMA) return { ok: false, error: 'bad_schema' };
    if (typeof a.artifact_id !== 'string' || !ID.test(a.artifact_id)) return { ok: false, error: 'bad_artifact_id' };
    const filename = text(a.filename, 200);
    if (!filename || /[\\/]/.test(filename)) return { ok: false, error: 'bad_filename' };
    const url = typeof a.download_url === 'string' && /^\/api\/v2\/runs\/[\w-]+\/artifacts\/[\w-]+\/download$/.test(a.download_url) ? a.download_url
      : (typeof a.download_url === 'string' && /^data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+$/.test(a.download_url) && a.download_url.length < 200000 ? a.download_url : null);
    const origin = ['server_artifact', 'mock', 'fixture'].includes(a.origin) ? a.origin : 'mock';
    return { ok: true, artifact: { schema: ARTIFACT_SCHEMA, artifact_id: a.artifact_id, work_id: text(a.work_id, 120), filename, mime: text(a.mime, 100) || 'application/octet-stream',
      bytes: Number.isSafeInteger(a.bytes) && a.bytes >= 0 ? a.bytes : null, sha256: /^[a-f0-9]{64}$/.test(a.sha256 || '') ? a.sha256 : null,
      download_url: url, origin, producer: text(a.producer, 60), role_id: a.role_id && ID.test(a.role_id) ? a.role_id : null,
      evidence: EVIDENCE.includes(a.evidence) ? a.evidence : 'FIXTURE', status: ['produced', 'failed', 'superseded'].includes(a.status) ? a.status : 'produced' } };
  }

  /* ---------- Adapter: existing V2 run view -> event/artifact DTOs (read-only) ---------- */
  const V2_MAP = { run_started: 'approved', step_started: 'work_started', tool_completed: 'tool_used', skill_completed: 'tool_used', review_required: 'delivered',
    rework_started: 'rework_requested', run_approved: 'accepted', run_failed: 'failed', run_cancelled: 'cancelled', run_interrupted: 'interrupted' };
  function ledgerCost(entry) {
    if (!isObj(entry) || entry.cost === null || entry.cost === undefined || !Number.isFinite(entry.cost)) return { usd: null, status: 'unknown' };
    if (entry.costSource === 'conservative_reservation' || (entry.costSource === 'restart_unknown' && entry.cost > 0)) return { usd: entry.cost, status: 'upper_bound' };
    if (!entry.prices && entry.cost === 0) return { usd: 0, status: 'local_zero' };
    return { usd: entry.cost, status: 'settled' };
  }
  function fromV2Run(run) {
    if (!isObj(run) || typeof run.runId !== 'string' || !/^[\w-]{1,80}$/.test(run.runId)) return { ok: false, error: 'bad_run' };
    const work = 'v2:' + run.runId;
    const src = (Array.isArray(run.events) ? run.events : []).filter(e => isObj(e) && Number.isSafeInteger(e.seq)).sort((a, b) => a.seq - b.seq);
    const events = [];
    const lastByStep = new Map();
    let seq = 0;
    const push = e => events.push({ schema: EVENT_SCHEMA, work_id: work, task_id: work, source: 'v2_run_events', evidence: 'SERVER_RECORDED', ...e, seq: ++seq });
    for (const e of src) {
      const sourceId = 'v2:' + run.runId + ':' + e.seq;
      let type = V2_MAP[e.eventType];
      if (e.eventType === 'step_done') type = e.status === 'done' ? 'completed' : 'failed';
      if (!type) type = 'v2.' + String(e.eventType || 'unknown').replace(/[^a-z0-9_]/gi, '_').slice(0, 50);
      const parent = e.stepId && lastByStep.get(e.stepId) || (events.length ? events[events.length - 1].event_id : null);
      push({ event_id: sourceId, type, parent_event_id: parent, role_id: e.roleId && ID.test(e.roleId) ? e.roleId : null, step_id: e.stepId && ID.test(e.stepId) ? e.stepId : null,
        artifact_id: e.artifactId && ID.test(e.artifactId) ? e.artifactId : null, at: Number.isFinite(e.createdAt) ? e.createdAt : 0,
        detail: [e.round ? '第 ' + e.round + ' 轮' : '', e.toolId ? '工具 ' + text(e.toolId, 60) : '', e.errorCode ? '错误码 ' + text(e.errorCode, 60) : '', e.status && e.eventType === 'step_done' ? '步骤状态 ' + text(e.status, 30) : ''].filter(Boolean).join('；') });
      if (e.stepId) lastByStep.set(e.stepId, sourceId);
    }
    // The run status is also a server record. When it moved without a matching event (e.g. a graceful
    // shutdown marks running runs cancelled without an event), add ONE explicitly derived event.
    const STATUS = { cancelled: 'cancelled', failed: 'failed', interrupted: 'interrupted', approved: 'accepted', review_required: 'delivered' };
    const want = STATUS[run.status];
    const lastTask = [...events].reverse().find(e => ['approved', 'delivered', 'accepted', 'cancelled', 'failed', 'interrupted', 'rework_requested'].includes(e.type) && !e.role_id);
    if (want && (!lastTask || lastTask.type !== want)) push({ event_id: 'v2-status:' + run.runId + ':' + run.status + ':' + events.length, type: want, parent_event_id: events.length ? events[events.length - 1].event_id : null,
      at: Number.isFinite(run.endedAt) ? run.endedAt : Number.isFinite(run.interruptedAt) ? run.interruptedAt : 0, detail: '由服务器运行状态“' + text(run.status, 30) + '”推导：服务器未记录对应事件' + (run.error ? '；' + text(run.error, 120) : ''), derived: true });
    for (const entry of Array.isArray(run.usageLedger) ? run.usageLedger : []) {
      if (!isObj(entry)) continue;
      const lid = typeof entry.ledgerId === 'string' && ID.test(entry.ledgerId) ? entry.ledgerId : null;
      if (!lid) continue;
      push({ event_id: 'v2-ledger:' + lid, type: 'cost_reported', parent_event_id: null, role_id: entry.roleId && ID.test(entry.roleId) ? entry.roleId : null,
        at: Number.isFinite(entry.createdAt) ? entry.createdAt : 0, cost: { ...ledgerCost(entry), ledger_id: lid }, detail: entry.failed ? '失败调用的保守计费' : '' });
    }
    // Run-level usage that is unknown must stay unknown even when no ledger row exists yet.
    const usage = isObj(run.usage) ? run.usage : {};
    const unknownRunCost = usage.cost === null || (Number.isFinite(usage.reservedCost) && usage.reservedCost > 0 && !['running', 'queued'].includes(run.status));
    const artifacts = (Array.isArray(run.artifacts) ? run.artifacts : []).map(a => validateArtifact({ schema: ARTIFACT_SCHEMA, artifact_id: a.artifactId, work_id: work,
      filename: a.filename, mime: a.mime, bytes: a.bytes, sha256: a.sha256, download_url: a.downloadUrl, origin: 'server_artifact', producer: a.producer, role_id: a.roleId,
      evidence: 'SERVER_RECORDED' })).filter(r => r.ok).map(r => r.artifact);
    return { ok: true, work_id: work, status: text(run.status, 30), events, artifacts, unknownRunCost,
      usage: { cost: Number.isFinite(usage.cost) ? usage.cost : null, reservedCost: Number.isFinite(usage.reservedCost) ? usage.reservedCost : null } };
  }
  return { PLAN_SCHEMA, EVENT_SCHEMA, ARTIFACT_SCHEMA, EVIDENCE, TYPES, COST_STATUS, validateEvent, validateArtifact, digest, fromV2Run, normalizeCost, text, isObj };
});
