'use strict';
// #14 package 5 regression barrier: prior P1 / ledger tests captured at the
// audited base 17ec74c must still exist and must not lose assertions, and
// production code must not grow new environment hooks (test-only back doors).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('./fixtures/regression-guard.json');
const ROOT = path.join(__dirname, '..');

test('regression guard: prior P1/ledger tests still exist and keep at least their base assertion count', () => {
  for (const [file, { titles, baseAssertCount }] of Object.entries(guard.files)) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const title of titles) assert.ok(src.includes(title), `${file}: missing prior test "${title}"`);
    const now = (src.match(/assert[.(]/g) || []).length;
    assert.ok(now >= baseAssertCount, `${file}: assertions dropped ${baseAssertCount} -> ${now}`);
  }
  for (const file of Object.keys(guard.files)) assert.match(fs.readFileSync(path.join(__dirname, 'all.test.js'), 'utf8'), new RegExp(file.replace('.', '\\.')), file + ' still part of npm test');
});

test('regression guard: no new environment hooks or test-only switches in production code', () => {
  const files = [path.join(ROOT, 'server.js'), ...fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'lib', f))];
  const seen = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z_]+)/g)) seen.add('process.env.' + m[1]);
    assert.doesNotMatch(src, /NODE_ENV\s*===?\s*['"]test['"]|NODE_TEST_CONTEXT|__TEST_HOOK|globalThis\.__aij/, path.basename(f) + ' contains a test-only switch');
  }
  assert.deepEqual([...seen].sort(), guard.envAllowlist, 'environment surface changed; review for test-only back doors');
});
