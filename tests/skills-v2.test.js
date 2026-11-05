'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SkillRegistry, SKILL_LIMITS } = require('../lib/skills-v2');
const definition = (extra = {}) => ({ skillId: 'custom', name: 'Custom', version: '1.0.0', steps: [{ type: 'prompt', text: 'Review {{input}}' }], ...extra });

test('Skills: built-ins add prompts before execution and check concrete output after execution', async () => {
  const skills = new SkillRegistry();
  const before = await skills.execute('structured-report', { input: 'task', phase: 'before' });
  assert.match(before.prompt, /事实依据/);
  assert.deepEqual(before.checks, []);
  const failed = await skills.execute('structured-report', { input: '   ', phase: 'after' });
  assert.equal(failed.ok, false);
  const passed = await skills.execute('structured-report', { input: 'Report with facts', phase: 'after' });
  assert.equal(passed.ok, true);
  assert.equal(passed.prompt, '');
});

test('Skills: registration persists cloned definitions and enforces immutable version numbers', () => {
  let persisted;
  const skills = new SkillRegistry({ save: list => { persisted = list; } });
  const original = definition();
  const saved = skills.upsert(original);
  original.steps[0].text = 'mutated'; saved.name = 'mutated';
  assert.equal(skills.get('custom').name, 'Custom');
  assert.equal(persisted.find(s => s.skillId === 'custom').steps[0].text, 'Review {{input}}');
  assert.throws(() => skills.upsert(definition({ name: 'Changed' })), { code: 'version_conflict' });
  skills.upsert(definition({ name: 'Changed', version: '1.1.0' }));
  const restored = new SkillRegistry({ initial: persisted });
  assert.equal(restored.get('custom').version, '1.1.0');
  assert.equal(skills.remove('custom'), true);
  assert.equal(skills.remove('custom'), false);
  assert.equal(skills.get('custom'), null);
});

test('Skills: failed persistence leaves memory unchanged', () => {
  const skills = new SkillRegistry({ save: () => { throw Error('disk full'); } });
  assert.throws(() => skills.upsert(definition()), /disk full/);
  assert.equal(skills.get('custom'), null);
});

test('Skills: a full persisted snapshot preserves removal of built-ins across restart', () => {
  let persisted;
  const skills = new SkillRegistry({ save: list => { persisted = list; } });
  skills.remove('quality-review');
  assert.equal(new SkillRegistry({ initial: persisted }).get('quality-review'), null);
  assert.deepEqual(new SkillRegistry({ initial: [] }).list(), []);
});

test('Skills: tools require exact explicit authorization and retain execution evidence', async () => {
  let called = 0;
  const skills = new SkillRegistry({ tools: { async call(id, args, options) {
    called++;
    assert.equal(id, 'builtin.text-stats');
    assert.deepEqual(args, { text: 'concrete input' });
    assert.deepEqual(options.allowedTools, ['builtin.text-stats']);
    assert.equal(options.context.projectId, 'p1');
    return { executionMode: 'builtin', content: { chars: 14 } };
  } } });
  skills.upsert(definition({ steps: [{ type: 'tool', toolId: 'builtin.text-stats', args: { text: '{{input}}' } }] }));
  await assert.rejects(skills.execute('custom', { input: 'concrete input' }), { code: 'tool_forbidden' });
  assert.equal(called, 0);
  const r = await skills.execute('custom', { input: 'concrete input', allowedTools: ['builtin.text-stats'], context: { projectId: 'p1' } });
  assert.equal(called, 1);
  assert.equal(r.outputs[0].result.executionMode, 'builtin');
  assert.equal(r.ok, true);
});

test('Skills: checks distinguish JSON validity, required fields, text containment, and minimum content', async () => {
  const skills = new SkillRegistry();
  skills.upsert(definition({ steps: [
    { type: 'check', check: 'json', requiredKeys: ['title'] },
    { type: 'check', check: 'contains', value: 'title' },
    { type: 'check', check: 'minChars', value: 10 },
  ] }));
  assert.equal((await skills.execute('custom', { input: '{"title":"Report"}' })).ok, true);
  const bad = await skills.execute('custom', { input: 'not JSON' });
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.length, 3);
  assert.equal(bad.checks.filter(c => !c.passed).length, 3);
  assert.equal((await skills.execute('custom', { input: '{"other":"title"}' })).checks[0].passed, false);
});

test('Skills: unsafe executable definitions and argument objects are rejected', () => {
  const skills = new SkillRegistry();
  for (const raw of [
    definition({ skillId: '../escape' }),
    definition({ version: 'latest' }),
    definition({ steps: [{ type: 'shell', command: 'rm -rf /' }] }),
    definition({ steps: [{ type: 'check', check: 'regex', value: '(a+)+' }] }),
    definition({ steps: [{ type: 'tool', toolId: 'builtin.x', args: JSON.parse('{"__proto__":{}}') }] }),
    definition({ steps: [{ type: 'tool', toolId: 'builtin.x', args: { f: () => 1 } }] }),
    definition({ steps: Array.from({ length: SKILL_LIMITS.maxSteps + 1 }, () => ({ type: 'prompt', text: 'x' })) }),
  ]) assert.throws(() => skills.upsert(raw), { code: 'invalid_skill' });
});

test('Skills: prompt expansion and input bounds, missing skill, and cancellation are enforced', async () => {
  const skills = new SkillRegistry();
  skills.upsert(definition());
  assert.equal((await skills.execute('custom', { input: 'facts' })).prompt, 'Review facts');
  await assert.rejects(skills.execute('missing'), { code: 'skill_missing' });
  await assert.rejects(skills.execute('custom', { input: 'x'.repeat(SKILL_LIMITS.maxText + 1) }), { code: 'invalid_input' });
  const aborter = new AbortController(); aborter.abort(new Error('cancelled'));
  await assert.rejects(skills.execute('custom', { signal: aborter.signal }), /cancelled/);
});
