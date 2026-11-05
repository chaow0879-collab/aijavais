'use strict';
/* Declarative skills. A skill adds prompts, invokes explicitly authorized tools,
 * or checks concrete text. No command strings, dynamic modules, or eval. */
const LIMITS = Object.freeze({ maxSkills: 100, maxSteps: 24, maxText: 200000, maxPrompt: 24000, maxArgsBytes: 65536, maxOutputBytes: 1000000 });
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const PHASES = new Set(['before', 'after']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class SkillError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillError'; this.code = code; }
}
function fail(code, message) { throw new SkillError(code, message); }
function text(v, label, max, nonempty = false) {
  if (typeof v !== 'string' || v.length > max || (nonempty && !v.trim())) fail('invalid_skill', label + ' is invalid');
  return v;
}
function object(v) { return v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)); }
function safeJson(v, depth = 0, seen = new Set()) {
  if (depth > 8) fail('invalid_skill', 'Tool arguments are nested too deeply');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if ((!Array.isArray(v) && !object(v)) || seen.has(v)) fail('invalid_skill', 'Tool arguments must be finite JSON data');
  seen.add(v);
  if (Object.keys(v).length > 1000) fail('invalid_skill', 'Too many tool argument fields');
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) fail('invalid_skill', 'Unsafe argument property');
    safeJson(v[k], depth + 1, seen);
  }
  seen.delete(v);
}
function versionCompare(a, b) {
  const av = a.split('.').map(Number), bv = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return Math.sign(av[i] - bv[i]);
  return 0;
}
function normalizeSkill(raw) {
  if (!object(raw) || !ID.test(raw.skillId)) fail('invalid_skill', 'skillId must be a lowercase identifier');
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) fail('invalid_skill', 'version must be a semantic version, for example 1.0.0');
  const skill = {
    skillId: raw.skillId,
    name: text(raw.name, 'name', 100, true),
    version: raw.version,
    description: text(raw.description === undefined ? '' : raw.description, 'description', 2000),
    steps: [],
  };
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > LIMITS.maxSteps) fail('invalid_skill', 'A skill requires 1–24 steps');
  for (const s of raw.steps) {
    if (!object(s)) fail('invalid_skill', 'Each step must be an object');
    const phase = s.phase === undefined ? (s.type === 'check' ? 'after' : 'before') : s.phase;
    if (!PHASES.has(phase)) fail('invalid_skill', 'Step phase must be before or after');
    if (s.type === 'prompt') {
      skill.steps.push({ type: 'prompt', phase, text: text(s.text, 'prompt text', LIMITS.maxPrompt, true) });
    } else if (s.type === 'tool') {
      if (typeof s.toolId !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(s.toolId)) fail('invalid_skill', 'Invalid toolId');
      const args = s.args === undefined ? {} : s.args;
      if (!object(args)) fail('invalid_skill', 'Tool args must be an object');
      safeJson(args);
      if (Buffer.byteLength(JSON.stringify(args)) > LIMITS.maxArgsBytes) fail('invalid_skill', 'Tool arguments exceed limit');
      skill.steps.push({ type: 'tool', phase, toolId: s.toolId, args: structuredClone(args) });
    } else if (s.type === 'check') {
      if (!['nonempty', 'minChars', 'contains', 'json'].includes(s.check)) fail('invalid_skill', 'Unsupported check');
      const step = { type: 'check', phase, check: s.check };
      if (s.check === 'minChars') {
        if (!Number.isInteger(s.value) || s.value < 1 || s.value > LIMITS.maxText) fail('invalid_skill', 'minChars requires an integer value');
        step.value = s.value;
      }
      if (s.check === 'contains') step.value = text(s.value, 'contains value', 4000, true);
      if (s.check === 'json' && s.requiredKeys !== undefined) {
        if (!Array.isArray(s.requiredKeys) || s.requiredKeys.length > 100 || s.requiredKeys.some(k => typeof k !== 'string' || !k || k.length > 100 || FORBIDDEN_KEYS.has(k))) fail('invalid_skill', 'Invalid requiredKeys');
        step.requiredKeys = [...new Set(s.requiredKeys)];
      }
      skill.steps.push(step);
    } else fail('invalid_skill', 'Unsupported step type');
  }
  if (skill.steps.filter(s => s.type === 'prompt').reduce((n, s) => n + s.text.length, 0) > LIMITS.maxPrompt) fail('invalid_skill', 'Combined prompt exceeds limit');
  return skill;
}
const DEFAULT_SKILLS = Object.freeze([
  {
    skillId: 'structured-report', name: '结构化报告', version: '1.0.0',
    description: '提供报告结构并检查最终正文非空；内容准确性仍需独立审核。',
    steps: [
      { type: 'prompt', phase: 'before', text: '请以标题、目标、事实依据、分析、可执行建议、风险与待验证项组织报告。区分事实、推断和未验证结果；不得虚构来源或真实执行。' },
      { type: 'check', phase: 'after', check: 'nonempty' },
    ],
  },
  {
    skillId: 'quality-review', name: '交付质量审查', version: '1.0.0',
    description: '提示审核者核对验收标准，并对输出进行最小长度检查；不代替人工验收。',
    steps: [
      { type: 'prompt', phase: 'before', text: '逐项核对项目验收标准、证据、职责边界、费用与安全限制。指出缺陷和所需返工，明确已通过、未通过及未经验证项。不要将模拟执行称为真实执行。' },
      { type: 'check', phase: 'after', check: 'minChars', value: 20 },
    ],
  },
]);
function interpolate(value, input) {
  if (typeof value === 'string') return value.replaceAll('{{input}}', input);
  if (Array.isArray(value)) return value.map(v => interpolate(v, input));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, input)]));
  return value;
}
function abort(signal) { if (signal && signal.aborted) throw signal.reason instanceof Error ? signal.reason : new SkillError('aborted', 'Skill execution aborted'); }

class SkillRegistry {
  constructor({ tools = null, save = null, initial } = {}) {
    this.tools = tools;
    if (save !== null && typeof save !== 'function') fail('invalid_skill', 'save must be a synchronous function');
    this.save = save;
    // An explicitly supplied snapshot is complete, including deliberate deletions
    // of built-ins. An absent snapshot seeds the default skills once.
    const restored = initial === undefined ? DEFAULT_SKILLS : initial;
    this.skills = new Map();
    if (!Array.isArray(restored) || restored.length > LIMITS.maxSkills) fail('invalid_skill', 'initial must be a bounded array');
    for (const raw of restored) {
      const s = normalizeSkill(raw);
      if (this.skills.has(s.skillId)) fail('invalid_skill', 'Duplicate stored skill identifier');
      this.skills.set(s.skillId, s);
    }
    if (this.skills.size > LIMITS.maxSkills) fail('invalid_skill', 'Too many skills');
  }
  list() { return [...this.skills.values()].map(s => structuredClone(s)); }
  get(id) { const s = this.skills.get(id); return s ? structuredClone(s) : null; }
  _commit(next) {
    if (this.save) {
      const result = this.save([...next.values()].map(s => structuredClone(s)));
      if (result && typeof result.then === 'function') fail('save_failed', 'save must be synchronous');
    }
    this.skills = next;
  }
  upsert(raw) {
    const skill = normalizeSkill(raw), old = this.skills.get(skill.skillId);
    if (old && JSON.stringify(old) !== JSON.stringify(skill) && versionCompare(skill.version, old.version) <= 0) fail('version_conflict', 'Changed skills require a higher semantic version');
    const next = new Map(this.skills);
    next.set(skill.skillId, skill);
    if (next.size > LIMITS.maxSkills) fail('invalid_skill', 'Too many skills');
    this._commit(next);
    return structuredClone(skill);
  }
  remove(id) {
    if (!this.skills.has(id)) return false;
    const next = new Map(this.skills); next.delete(id); this._commit(next); return true;
  }
  async execute(id, { input = '', allowedTools = [], context = {}, signal, phase } = {}) {
    const skill = this.get(id);
    if (!skill) fail('skill_missing', 'Skill does not exist');
    if (typeof input !== 'string' || input.length > LIMITS.maxText) fail('invalid_input', 'Skill input must be bounded text');
    if (phase !== undefined && !PHASES.has(phase)) fail('invalid_input', 'phase must be before or after');
    if (!Array.isArray(allowedTools) || allowedTools.length > 100 || allowedTools.some(t => typeof t !== 'string')) fail('invalid_input', 'allowedTools must be a bounded array of tool identifiers');
    const result = { skillId: skill.skillId, version: skill.version, prompt: '', outputs: [], checks: [], ok: true };
    let outputBytes = 0;
    for (let index = 0; index < skill.steps.length; index++) {
      abort(signal);
      const s = skill.steps[index];
      if (phase !== undefined && s.phase !== phase) continue;
      if (s.type === 'prompt') {
        const rendered = interpolate(s.text, input);
        if (result.prompt.length + rendered.length > LIMITS.maxText) fail('output_limit', 'Expanded prompt exceeds limit');
        result.prompt += (result.prompt ? '\n\n' : '') + rendered;
      } else if (s.type === 'tool') {
        if (!this.tools || typeof this.tools.call !== 'function') fail('tool_unavailable', 'Tool registry is not configured');
        if (!allowedTools.includes(s.toolId)) fail('tool_forbidden', 'Skill tool requires explicit authorization: ' + s.toolId);
        const args = interpolate(s.args, input);
        if (Buffer.byteLength(JSON.stringify(args)) > LIMITS.maxArgsBytes) fail('invalid_input', 'Expanded tool arguments exceed limit');
        const output = await this.tools.call(s.toolId, args, { allowedTools: [...allowedTools], context, signal });
        abort(signal);
        outputBytes += Buffer.byteLength(JSON.stringify(output) || 'null');
        if (outputBytes > LIMITS.maxOutputBytes) fail('output_limit', 'Skill tool results exceed limit');
        result.outputs.push({ step: index, toolId: s.toolId, result: output });
      } else {
        let passed = false;
        if (s.check === 'nonempty') passed = input.trim().length > 0;
        else if (s.check === 'minChars') passed = input.trim().length >= s.value;
        else if (s.check === 'contains') passed = input.includes(s.value);
        else if (s.check === 'json') {
          try {
            const parsed = JSON.parse(input);
            passed = !s.requiredKeys || (object(parsed) && s.requiredKeys.every(k => Object.hasOwn(parsed, k)));
          } catch { passed = false; }
        }
        result.checks.push({ step: index, check: s.check, passed });
        if (!passed) result.ok = false;
      }
    }
    return result;
  }
}
module.exports = { SkillRegistry, SkillError, DEFAULT_SKILLS, SKILL_LIMITS: LIMITS, normalizeSkill };
