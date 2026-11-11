'use strict';
// Reuse every Claude assertion byte-for-byte. Only the historical test helper's backend
// reference is rebound in memory, so the temporary Git clone runs the actual final candidate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const mode = process.argv[2];
if (!['--node', '--browser'].includes(mode) || process.argv.length !== 3) {
  throw new Error('Usage: node run-r54-integrated.cjs --node|--browser');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('BLOCKED: backend provenance missing');
const helper = path.join(root, 'tests/haloflux-workbench-r54/overlay.cjs');
const original = fs.readFileSync(helper, 'utf8');
const needle = "const R53_SHA = '397b46c18e25aaddc3e92886693da4ef3f2528d3';";
if (original.split(needle).length !== 2) throw new Error('BLOCKED: original R54 helper changed');
const metadata = {
  mode, backend_sha: head, r54_source: require('./r55-sources.json').r54.head,
  original_helper_sha256: crypto.createHash('sha256').update(original).digest('hex'),
  helper_override: 'TEST_ONLY_IN_MEMORY_BACKEND_REFERENCE',
  level: 'E3_FAKE_REAL_HTTP_SQLITE_LOCAL_MOCK', real_model_calls: 0
};
const out = mode === '--node' ? process.env.R54_OUT : process.env.UI_SHOTS;
if (out) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'r55-r54-' + mode.slice(2) + '-provenance.json'), JSON.stringify(metadata, null, 2));
}
console.log('R55 integrated R54 test provenance:', JSON.stringify(metadata));
const patched = new Module(helper, module);
patched.filename = helper;
patched.paths = Module._nodeModulePaths(path.dirname(helper));
require.cache[helper] = patched;
patched._compile(original.replace(needle, `const R53_SHA = '${head}';`), helper);
patched.loaded = true;
require(path.join(root, 'tests/haloflux-workbench-r54', mode === '--node' ? 'live-contract.test.js' : 'workbench-live.e2e.js'));
