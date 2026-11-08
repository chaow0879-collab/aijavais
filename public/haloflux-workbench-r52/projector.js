/* AIJAVAIS R52 HALOFLUX event projector | pure, deterministic, no timers of its own.
 * Folds ONE work's append-only events into what the halo may show. Rules:
 *  - single source: only validated events change state; no event => IDLE (never "busy").
 *  - idempotent: same event_id + same content is ignored; same id + different content is a conflict.
 *  - ordered: events apply strictly by seq; later seqs wait in a buffer and gaps are reported.
 *  - causal: parent_event_id must already be applied, otherwise it is flagged.
 *  - retraction: a `retracted` event removes its target and the state is re-folded from scratch.
 *  - unknown types are logged as unrecognized and never change state.
 *  - cost: unknown stays unknown (null); it is never added as 0.
 *  - connection loss / silence make the view stale; nothing advances on its own. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./contract.js'));
  else root.R52Projector = factory(root.R52Contract);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const ACTIVE = new Set(['started', 'working', 'review', 'rework']);
  const MAX_EVENTS = 5000;

  function createProjector(opts) {
    opts = opts || {};
    const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 30000;
    let workId = opts.workId || null;
    const seen = new Map();          // event_id -> digest
    const bySeq = new Map();         // seq -> event (accepted, applied or buffered)
    const applied = [];              // events applied in seq order
    const issues = [];               // conflicts / rejections / causality notes
    let next = 1;
    let connection = opts.connection || 'none';
    let lastEventAt = null, lastSeenAt = Number.isFinite(opts.seenAt) ? opts.seenAt : null;
    let mode = opts.mode || null;    // 'DEMO' | 'LIVE' | 'REPLAY' (set by caller); IDLE when nothing applied

    function note(kind, ev, detail) { if (issues.length < 500) issues.push({ kind, event_id: ev && ev.event_id || null, seq: ev && ev.seq || null, detail: detail || '' }); }

    function ingest(list) {
      const out = { applied: 0, duplicates: 0, conflicts: 0, rejected: 0, buffered: 0, otherWork: 0 };
      for (const raw of Array.isArray(list) ? list : [list]) {
        const v = C.validateEvent(raw);
        if (!v.ok) { out.rejected++; note('rejected', raw && typeof raw === 'object' ? { event_id: typeof raw.event_id === 'string' ? raw.event_id.slice(0, 120) : null, seq: Number.isSafeInteger(raw.seq) ? raw.seq : null } : null, v.error); continue; }
        const ev = v.event;
        if (!workId) workId = ev.work_id;
        if (ev.work_id !== workId) { out.otherWork++; note('other_work', ev, ev.work_id); continue; }
        const d = C.digest(ev);
        if (seen.has(ev.event_id)) {
          if (seen.get(ev.event_id) === d) out.duplicates++;
          else { out.conflicts++; note('conflict', ev, '相同事件 ID 内容不同，保留首次记录'); }
          continue;
        }
        if (bySeq.has(ev.seq)) { out.conflicts++; note('seq_conflict', ev, '序号 ' + ev.seq + ' 已被事件 ' + bySeq.get(ev.seq).event_id + ' 占用'); continue; }
        if (seen.size >= MAX_EVENTS) { out.rejected++; note('limit', ev, '事件数量超过上限'); continue; }
        seen.set(ev.event_id, d); bySeq.set(ev.seq, ev);
        if (ev.seq < next) { out.rejected++; note('late', ev, '迟到事件'); continue; } // cannot happen when seq is unique, kept for safety
        out.buffered++;
      }
      // Apply the contiguous run of buffered events.
      while (bySeq.has(next)) {
        const ev = bySeq.get(next);
        applied.push(ev); next++; out.applied++; out.buffered--;
        lastEventAt = ev.at;
      }
      if (out.applied && !Number.isFinite(opts.seenAt)) lastSeenAt = opts.clock ? opts.clock() : Date.now();
      return out;
    }
    function gaps() {
      const pending = [...bySeq.keys()].filter(s => s >= next).sort((a, b) => a - b);
      if (!pending.length) return [];
      const g = []; let expect = next;
      for (const s of pending) { if (s > expect) g.push({ from: expect, to: s - 1 }); expect = s + 1; }
      return g;
    }
    function fold() {
      const retractedIds = new Set();
      const retractIssues = [];
      const ids = new Set(applied.map(e => e.event_id));
      for (const e of applied) if (e.type === 'retracted') {
        if (ids.has(e.retracts) && e.retracts !== e.event_id) retractedIds.add(e.retracts); else retractIssues.push({ kind: 'retract_unknown', event_id: e.event_id, seq: e.seq, detail: e.retracts });
      }
      const roles = {}, edges = [], log = [], artifacts = [], causality = [];
      const evidence = new Set();
      let phase = 'idle', lastCompleted = null;
      const costs = new Map(); // ledger key -> cost
      const role = id => roles[id] || (roles[id] = { role_id: id, state: 'idle', since_event_id: null, since_seq: null, step_id: null, history: [] });
      const setRole = (id, state, ev) => { const r = role(id); r.state = state; r.since_event_id = ev.event_id; r.since_seq = ev.seq; r.step_id = ev.step_id || r.step_id; r.history.push({ state, event_id: ev.event_id, seq: ev.seq }); };
      const done = new Set();
      const handing = new Map(); // from role -> to role, for explicit hand-offs not yet picked up
      for (const ev of applied) {
        const retracted = retractedIds.has(ev.event_id);
        let cause = 'ok';
        if (ev.parent_event_id) cause = done.has(ev.parent_event_id) ? 'ok' : (ids.has(ev.parent_event_id) ? 'parent_after_child' : 'missing_parent');
        log.push({ event_id: ev.event_id, seq: ev.seq, type: ev.type, recognized: ev.recognized, role_id: ev.role_id, at: ev.at, evidence: ev.evidence, source: ev.source, parent_event_id: ev.parent_event_id, causality: cause, retracted, detail: ev.detail });
        if (cause !== 'ok') causality.push({ event_id: ev.event_id, causality: cause, parent_event_id: ev.parent_event_id });
        done.add(ev.event_id);
        if (retracted || ev.type === 'retracted') continue;
        evidence.add(ev.evidence);
        if (!ev.recognized) continue;
        const def = C.TYPES[ev.type];
        if (ev.cost) { const key = ev.cost.ledger_id || ev.event_id; costs.set(key, { ...ev.cost, role_id: ev.role_id }); }
        switch (ev.type) {
          case 'task_created': if (phase === 'idle') phase = 'created'; break;
          case 'approved': phase = 'approved'; break;
          case 'delivered': phase = 'delivered'; if (ev.artifact_id) artifacts.push({ artifact_id: ev.artifact_id, event_id: ev.event_id }); break;
          case 'accepted': phase = 'accepted'; break;
          case 'cost_reported': break;
          default: {
            if (ev.role_id && def.state) {
              if (ev.type === 'work_started' || ev.type === 'agent_started') {
                // A new role starting right after another one completed is a derived hand-off edge,
                // unless the source already recorded that hand-off explicitly.
                const explicit = lastCompleted && edges.some(e => !e.derived && e.from === lastCompleted.role_id && e.to === ev.role_id);
                if (lastCompleted && lastCompleted.role_id !== ev.role_id && !explicit) edges.push({ from: lastCompleted.role_id, to: ev.role_id, cause_event_id: lastCompleted.event_id, via_event_id: ev.event_id, derived: true });
                lastCompleted = null;
                // The receiver started: an explicit hand-off to it is finished, the sender's step is done.
                for (const [from, to] of handing) if (to === ev.role_id && roles[from] && roles[from].state === 'handoff') { setRole(from, 'completed', ev); handing.delete(from); }
              }
              setRole(ev.role_id, def.state, ev);
              if (ev.type === 'handoff' && ev.to_role_id) { edges.push({ from: ev.role_id, to: ev.to_role_id, cause_event_id: ev.event_id, via_event_id: ev.event_id, derived: false }); role(ev.to_role_id); handing.set(ev.role_id, ev.to_role_id); lastCompleted = { role_id: ev.role_id, event_id: ev.event_id }; }
              if (ev.type === 'completed') lastCompleted = { role_id: ev.role_id, event_id: ev.event_id };
              if (ev.artifact_id && (ev.type === 'completed' || ev.type === 'handoff')) artifacts.push({ artifact_id: ev.artifact_id, event_id: ev.event_id, role_id: ev.role_id });
            }
            if (['cancelled', 'failed', 'blocked', 'interrupted', 'rework_requested'].includes(ev.type) && (!ev.role_id || def.scope === 'any')) {
              const p = { cancelled: 'cancelled', failed: 'failed', blocked: 'blocked', interrupted: 'unknown', rework_requested: 'rework' }[ev.type];
              if (!ev.role_id) {
                phase = p;
                // Task-level stop: every role still active loses its "busy" look; it is NOT marked completed.
                for (const r of Object.values(roles)) if (ACTIVE.has(r.state) || r.state === 'handoff') setRole(r.role_id, p === 'rework' ? 'idle' : p, ev);
                if (p === 'rework') lastCompleted = null;
              } else if (p === 'blocked' || p === 'failed' || p === 'unknown') { if (phase !== 'cancelled') phase = p === 'unknown' ? 'unknown' : phase; }
            }
            if (['work_started', 'agent_started', 'tool_used', 'peer_review', 'handoff', 'completed'].includes(ev.type) && ['approved', 'created', 'idle', 'rework', 'working', 'review'].includes(phase))
              phase = ev.type === 'peer_review' ? 'review' : 'working';
          }
        }
      }
      let known = 0, unknown = 0, upper = 0, reserved = 0;
      for (const c of costs.values()) {
        if (c.status === 'unknown' || c.usd === null) unknown++;
        else if (c.status === 'upper_bound') upper += c.usd;
        else if (c.status === 'reserved') reserved += c.usd;
        else known += c.usd;
      }
      const round = x => Math.round(x * 1e6) / 1e6;
      const byRole = {};
      for (const c of costs.values()) if (c.role_id) { const r = byRole[c.role_id] || (byRole[c.role_id] = { entries: 0, unknown: false, known_usd: 0 }); r.entries++; if (c.status === 'unknown' || c.usd === null) r.unknown = true; else r.known_usd = round(r.known_usd + c.usd); }
      const cost = { entries: costs.size, known_usd: round(known), upper_bound_usd: round(upper), reserved_usd: round(reserved), unknown_count: unknown,
        total_usd: unknown || upper || reserved ? null : round(known), status: unknown ? 'unknown' : (upper || reserved ? 'not_final' : (costs.size ? 'settled' : 'none')) };
      return { roles, edges, log, artifacts, causality, retractIssues, phase, evidence: [...evidence], cost, cost_by_role: byRole };
    }
    function state(now) {
      const f = fold();
      now = now == null ? (opts.clock ? opts.clock() : Date.now()) : now;
      const anyActive = Object.values(f.roles).some(r => ACTIVE.has(r.state));
      const silent = lastSeenAt !== null && now - lastSeenAt > staleMs;
      const stale = connection === 'disconnected' || ((anyActive || f.phase === 'working') && silent);
      const g = gaps();
      const viewMode = applied.length ? (mode || 'REPLAY') : (mode === 'DEMO' ? 'DEMO' : 'IDLE');
      // "busy" is only ever shown when a real (or labelled demo) event says so and the feed is live.
      const busy = applied.length > 0 && anyActive && !stale && !g.length;
      return { work_id: workId, mode: viewMode, connection, stale, busy, gaps: g, next_seq: next, applied: applied.length,
        buffered: [...bySeq.keys()].filter(s => s >= next).length, issues: issues.concat(f.retractIssues), last_event_at: lastEventAt, ...f };
    }
    return {
      ingest, state, gaps,
      setConnection(c) { if (['none', 'connected', 'disconnected'].includes(c)) connection = c; },
      setMode(m) { if (['DEMO', 'LIVE', 'REPLAY'].includes(m)) mode = m; },
      get workId() { return workId; }
    };
  }
  return { createProjector, ACTIVE: [...ACTIVE] };
});
