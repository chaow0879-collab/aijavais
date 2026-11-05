'use strict';
// AIJAVAIS is a cross-industry platform: default UI copy, examples and the
// featured template order must not centre one profession or organisation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('default titles, examples and placeholders are profession-neutral', () => {
  const surfaces = ['public/panel.html', 'docs/index.html', 'public/admin.html', 'public/workspace.html', 'public/project-intake.html', 'public/project-intake/app.js', 'public/login.html'];
  // Brand of a specific company/system, and HR-only sample tasks previously used as the default example.
  const banned = [/龙创/, /任职资格管理系统/, /新员工入职引导/, /组织职责优化/, /集团组织架构/];
  for (const file of surfaces) for (const re of banned) assert.doesNotMatch(read(file), re, `${file} contains ${re}`);
  for (const file of ['public/panel.html', 'docs/index.html']) assert.match(read(file), /<title>AIJAVAIS/);
});

test('ready team templates span many domains and HR-type templates are not featured first', () => {
  const t = JSON.parse(read('catalog/team-templates.v1.json'));
  const ready = t.categories.filter(c => c.status === 'ready').map(c => c.templateId);
  assert.ok(ready.length >= 10, 'at least ten ready templates');
  const hr = ['hr-management', 'talent-development', 'org-consulting'];
  assert.ok(ready.filter(id => hr.includes(id)).length / ready.length <= 0.2, 'HR-type templates are a small minority');
  assert.ok(ready.slice(0, 5).every(id => !hr.includes(id)), 'first templates shown are general-purpose');
});
