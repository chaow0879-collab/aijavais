/* AIJAVAIS R52 HALOFLUX projection view | an independent SVG implementation (no code copied from
 * public/panel.html, whose HALOFLUX visual is PolyForm-Noncommercial; see NOTICE.md).
 * Every lit node, beam and particle maps to a projected role state or hand-off edge that names its
 * source_event_id. No events => IDLE (dim ring, no motion). Motion stops when the feed is stale,
 * disconnected, gapped, when the user picks "静态" or when the OS asks for reduced motion. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.R52Halo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const STATE_TEXT = { idle: '待命', started: '已启动', working: '工作中', handoff: '交接中', review: '审核中', rework: '返工中', blocked: '受阻', completed: '已完成本步', cancelled: '已取消', failed: '失败', unknown: '状态未知' };
  const PHASE_TEXT = { idle: '无事件', created: '任务已创建', approved: '已授权', working: '工作中', review: '审核中', rework: '返工中', blocked: '受阻', delivered: '待验收', accepted: '已验收', cancelled: '已取消', failed: '失败', unknown: '中断·未知' };
  const MODE_TEXT = { IDLE: 'IDLE · 没有真实事件', DEMO: 'DEMO · 演示事件，不是真实工作', LIVE: 'LIVE · 来自服务器事件', REPLAY: 'REPLAY · 事件回放' };
  // Pure layout: plan roles first (in plan order), then any role only the events mention.
  function layout(planRoles, projection, size) {
    const S = size || 520, cx = S / 2, cy = S / 2, R = S * 0.24, RN = S * 0.40;
    const ids = (planRoles || []).map(r => r.role_id);
    for (const id of Object.keys((projection && projection.roles) || {})) if (!ids.includes(id)) ids.push(id);
    const n = Math.max(ids.length, 1);
    const nodes = ids.map((id, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      const pr = (projection && projection.roles && projection.roles[id]) || null;
      const role = (planRoles || []).find(r => r.role_id === id);
      return { id, name: role ? role.name : id, inPlan: !!role, x: cx + RN * Math.cos(a), y: cy + RN * Math.sin(a), rx: cx + R * Math.cos(a), ry: cy + R * Math.sin(a),
        state: pr ? pr.state : 'idle', source_event_id: pr ? pr.since_event_id : null, source_seq: pr ? pr.since_seq : null };
    });
    const at = Object.fromEntries(nodes.map(n2 => [n2.id, n2]));
    const edges = ((projection && projection.edges) || []).filter(e => at[e.from] && at[e.to]).map((e, i) => ({ ...e, key: 'e' + i, x1: at[e.from].x, y1: at[e.from].y, x2: at[e.to].x, y2: at[e.to].y }));
    return { size: S, cx, cy, R, nodes, edges };
  }
  function el(tag, attrs, parent) { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v)); if (parent) parent.appendChild(n); return n; }
  const short = s => (s.length > 9 ? s.slice(0, 8) + '…' : s);
  function render(svg, planRoles, projection, opts) {
    opts = opts || {};
    const L = layout(planRoles, projection, opts.size);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', '0 0 ' + L.size + ' ' + L.size);
    const p = projection || { mode: 'IDLE', phase: 'idle', busy: false, stale: false, gaps: [] };
    const live = p.busy && !opts.static;
    svg.setAttribute('data-mode', p.mode); svg.setAttribute('data-phase', p.phase); svg.setAttribute('data-busy', String(!!p.busy));
    svg.setAttribute('data-stale', String(!!p.stale)); svg.setAttribute('class', 'halo' + (live ? ' live' : '') + (opts.static ? ' static' : '') + (p.stale ? ' stale' : ''));
    const defs = el('defs', {}, svg);
    const g = el('radialGradient', { id: 'r52core' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#55e7ff', 'stop-opacity': p.applied ? 0.28 : 0.06 }, g); el('stop', { offset: '100%', 'stop-color': '#08111f', 'stop-opacity': 0 }, g);
    el('circle', { cx: L.cx, cy: L.cy, r: L.R * 1.25, fill: 'url(#r52core)' }, svg);
    // Central ring: two counter-rotating dashed bands; they only spin while `live`.
    el('circle', { cx: L.cx, cy: L.cy, r: L.R, class: 'ring ring-a' }, svg);
    el('circle', { cx: L.cx, cy: L.cy, r: L.R * 0.86, class: 'ring ring-b' }, svg);
    // Beams: ring -> node, lit only for active roles.
    for (const n of L.nodes) el('line', { x1: n.rx, y1: n.ry, x2: n.x, y2: n.y, class: 'beam beam-' + n.state, 'data-role': n.id }, svg);
    // Hand-off edges with travelling particles; each carries its causal event IDs.
    for (const e of L.edges) {
      const line = el('line', { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, class: 'edge' + (e.derived ? ' derived' : ''), 'data-from': e.from, 'data-to': e.to, 'data-cause-event': e.cause_event_id, 'data-via-event': e.via_event_id }, svg);
      el('title', {}, line).textContent = '交接 ' + e.from + ' → ' + e.to + '（来源事件 ' + e.cause_event_id + (e.derived ? '，由完成与启动事件推导' : '') + '）';
      if (live) { const dot = el('circle', { r: 3.2, class: 'particle', cx: e.x1, cy: e.y1 }, svg); el('animateMotion', { dur: '1.6s', repeatCount: 'indefinite', path: 'M' + e.x1 + ',' + e.y1 + ' L' + e.x2 + ',' + e.y2 }, dot); }
    }
    for (const n of L.nodes) {
      const node = el('g', { class: 'node node-' + n.state, 'data-role': n.id, 'data-state': n.state, 'data-source-event': n.source_event_id || '', tabindex: 0, role: 'img',
        'aria-label': n.name + '：' + (STATE_TEXT[n.state] || n.state) + (n.source_event_id ? '（事件 ' + n.source_event_id + '）' : '（没有事件）') }, svg);
      el('circle', { cx: n.x, cy: n.y, r: 24, class: 'node-disc' }, node);
      const t = el('text', { x: n.x, y: n.y + 40, class: 'node-label', 'text-anchor': 'middle' }, node); t.textContent = short(n.name);
      const s = el('text', { x: n.x, y: n.y + 5, class: 'node-state', 'text-anchor': 'middle' }, node); s.textContent = (STATE_TEXT[n.state] || n.state).slice(0, 4);
      el('title', {}, node).textContent = n.name + ' · ' + (STATE_TEXT[n.state] || n.state) + (n.source_event_id ? ' · 来源事件 ' + n.source_event_id + ' #' + n.source_seq : ' · 没有事件');
    }
    const c1 = el('text', { x: L.cx, y: L.cy - 8, class: 'core-mode', 'text-anchor': 'middle' }, svg); c1.textContent = p.mode;
    const c2 = el('text', { x: L.cx, y: L.cy + 14, class: 'core-phase', 'text-anchor': 'middle' }, svg);
    c2.textContent = p.stale ? (p.connection === 'disconnected' ? '连接中断' : '事件延迟') : p.gaps && p.gaps.length ? '等待缺失事件' : (PHASE_TEXT[p.phase] || p.phase);
    return L;
  }
  function describe(planRoles, projection) {
    const L = layout(planRoles, projection, 520);
    const p = projection || { mode: 'IDLE', phase: 'idle' };
    const head = (MODE_TEXT[p.mode] || p.mode) + '；任务状态：' + (PHASE_TEXT[p.phase] || p.phase) + (p.stale ? '；注意：' + (p.connection === 'disconnected' ? '连接已中断，显示的是最后已知状态' : '长时间没有新事件，状态可能已过期') : '') + (p.gaps && p.gaps.length ? '；缺少事件 #' + p.gaps.map(x => x.from + (x.to > x.from ? '–' + x.to : '')).join(',') + '，后续事件暂缓显示' : '');
    return { head, rows: L.nodes.map(n => ({ id: n.id, name: n.name, state: n.state, text: STATE_TEXT[n.state] || n.state, source_event_id: n.source_event_id, inPlan: n.inPlan })) };
  }
  return { layout, render, describe, STATE_TEXT, PHASE_TEXT, MODE_TEXT };
});
