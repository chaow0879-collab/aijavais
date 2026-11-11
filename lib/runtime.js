'use strict';
/*
 * 运行时计数（Visual Event Adapter 的数据侧）：把已规范化的事件信封折算成大屏需要的智能体状态与统计。
 * 不做任何网络 / 文件操作，便于单独测试。
 *
 * 规则：
 *   - source=server：模型调用并发按 spanId 统计；同一个 span 只结算一次（重复的 done / error 被忽略，不会重复计 token）；
 *     厂商返回的用量计入 tokens，估算值计入 estimatedTokens；失败调用若带用量同样结算（成本可能已经产生）。
 *   - source=external / demo：沿用旧的 status 计数（供 signal.js 与演示使用），只计事件数，不进入真实统计。
 *   - 每个 agentId 绑定首次写入时的 来源 + 上报主体（owner），其它来源 / 主体不能写同名 agent。
 */
const MAX_ENDED_SPANS = 10000;

class Runtime {
  constructor({ maxAgents = 200 } = {}) {
    this.maxAgents = maxAgents;
    this.agents = new Map();
    this.totals = { calls: 0, tokens: 0, estimatedTokens: 0, errors: 0, reportedEvents: 0, simulatedEvents: 0 };
    this.endedSpans = new Set();
  }

  /* 写入前的身份校验：返回错误文本或 null */
  check(agentId, source, owner) {
    const a = agentId ? this.agents.get(agentId) : null;
    if (!a) return null;
    if (a.source !== source) return 'agentId "' + agentId + '" 已被其它来源（' + a.source + '）占用，不能以 ' + source + ' 身份写入';
    if ((a.owner || null) !== (owner || null)) return 'agentId "' + agentId + '" 属于其它上报主体，不能写入';
    return null;
  }

  _agent(env, owner) {
    let a = this.agents.get(env.agentId);
    if (a) return a;
    if (this.agents.size >= this.maxAgents) {
      const old = [...this.agents.values()].filter(x => x.status !== 'working').sort((x, y) => x.last - y.last)[0];
      if (old) this.agents.delete(old.id);
    }
    const now = env.timestamp;
    a = {
      id: env.agentId, source: env.source, verification: env.verification, owner: owner || null,
      label: env.agentId, model: '', role: '', status: 'idle', task: '',
      calls: 0, tokens: 0, estimatedTokens: 0, errors: 0, since: now, last: now, ms: 0, live: 0, active: 0, spans: new Set(),
    };
    this.agents.set(a.id, a);
    return a;
  }

  _endSpan(sid) {
    if (!sid) return true;
    if (this.endedSpans.has(sid)) return false;
    this.endedSpans.add(sid);
    if (this.endedSpans.size > MAX_ENDED_SPANS) this.endedSpans.delete(this.endedSpans.values().next().value);
    return true;
  }

  _settle(a, usage) {
    const tk = usage && usage.total;
    if (!(tk > 0)) return undefined;
    if (usage.source === 'provider') { a.tokens += tk; this.totals.tokens += tk; return tk; }
    a.estimatedTokens += tk; this.totals.estimatedTokens += tk;
    return undefined;
  }

  /*
   * 应用一条已规范化的事件。input 为原始事件体（取 label / model / role / task 等展示字段）。
   * 返回 { agent, tokens, ignored }：tokens 为本次计入真实统计的 token（旧大屏字段用），ignored 表示重复结算被忽略。
   */
  apply(env, input = {}, owner = null) {
    const a = this._agent(env, owner);
    const now = env.timestamp;
    a.last = now;
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    if (input.label) a.label = s(input.label, 40);
    if (input.model) a.model = s(input.model, 60);
    if (input.role !== undefined) a.role = s(input.role, 40);
    if (input.task !== undefined) a.task = s(input.task, 80);
    const usage = env.tokenUsage;
    const tk = usage && usage.total;
    let tokens, ignored = false;

    if (env.source === 'server') {
      const et = env.eventType, sid = env.spanId;
      if (et === 'model_start') {
        a.spans.add(sid); a.status = 'working'; a.since = now; a.calls++; this.totals.calls++; a.live = 0;
      } else if (et === 'model_stream') {
        if (a.spans.has(sid) && a.status !== 'working') { a.status = 'working'; a.since = now; }
        if (tk !== undefined) a.live = tk;
      } else if (et === 'model_done' || et === 'model_error') {
        if (!this._endSpan(sid)) ignored = true;
        else {
          a.spans.delete(sid);
          tokens = this._settle(a, usage);
          if (et === 'model_done') {
            if (!a.spans.size) a.status = 'idle';
            a.ms = env.durationMs !== undefined ? env.durationMs : now - a.since;
          } else {
            a.status = a.spans.size ? 'working' : 'error'; a.errors++; this.totals.errors++;
          }
        }
      }
      a.active = a.spans.size;
    } else {
      if (env.source === 'external') this.totals.reportedEvents++; else this.totals.simulatedEvents++;
      const st = env.status;
      if (st === 'start') {
        a.active++; a.status = 'working'; a.since = now; a.calls++; a.live = 0;
      } else if (st === 'stream') {
        if (a.status !== 'working') { a.status = 'working'; a.since = now; }
        if (tk !== undefined) a.live = tk;
      } else if (st === 'done') {
        a.active = Math.max(0, a.active - 1);
        if (!a.active) a.status = 'idle';
        a.ms = env.durationMs !== undefined ? env.durationMs : now - a.since;
        if (tk > 0) { a.tokens += tk; tokens = tk; }
      } else if (st === 'error') {
        a.active = Math.max(0, a.active - 1);
        a.status = a.active ? 'working' : 'error'; a.errors++;
      }
    }
    return { agent: a, tokens, ignored };
  }

  working() { let n = 0; for (const a of this.agents.values()) if (a.status === 'working') n++; return n; }

  /* 超时无动静的 working 智能体回到待机；返回被处理的智能体列表（调用方负责发 activity 事件） */
  sweep(now, idleMs) {
    const out = [];
    for (const a of this.agents.values()) {
      if (a.status === 'working' && now - a.last > idleMs) { a.status = 'idle'; a.active = 0; a.spans.clear(); out.push(a); }
      else if (a.status === 'error' && now - a.last > 30000) a.status = 'idle';
    }
    return out;
  }

  /* 快照用的公开字段（不含 spans / owner 等内部字段） */
  publicAgents(limit = 24) {
    return [...this.agents.values()].sort((x, y) => y.last - x.last).slice(0, limit).map(a => ({
      id: a.id, label: a.label, model: a.model, role: a.role, status: a.status, task: a.task,
      calls: a.calls, tokens: a.tokens, estimatedTokens: a.estimatedTokens, errors: a.errors,
      since: a.since, last: a.last, ms: a.ms, live: a.live, source: a.source, verification: a.verification,
    }));
  }
}

module.exports = { Runtime };
