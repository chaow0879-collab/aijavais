#!/usr/bin/env node
'use strict';
// node tools/agent-interop-r48/cli.js matrix  [--repo DIR] [--out DIR]
// node tools/agent-interop-r48/cli.js gonogo  [--repo DIR] [--out DIR] [--facts FILE]
// Read-only conformance harness. No daemon, no timer, no network writes, no model calls.
const fs = require('node:fs');
const path = require('node:path');
const { runMatrix } = require('./matrix');
const { evaluate } = require('./gonogo');
async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = n => { const i = rest.indexOf(n); return i < 0 ? null : rest[i + 1]; };
  for (let i = 0; i < rest.length; i += 2) if (!['--repo', '--out', '--facts'].includes(rest[i])) throw Error('UNKNOWN_ARGUMENT');
  const repo = path.resolve(flag('--repo') || process.cwd()), out = flag('--out');
  const write = (name, data) => { if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2), { flag: 'wx' }); } };
  if (cmd === 'matrix' || cmd === 'gonogo') {
    const matrix = await runMatrix({ repo });
    write('interop-matrix.json', matrix);
    if (cmd === 'matrix') return matrix;
    const { preflight } = require(path.join(__dirname, 'preflight-loader.js'))(repo);
    const facts = flag('--facts') ? JSON.parse(fs.readFileSync(flag('--facts'), 'utf8')) : {};
    const g = evaluate({ matrix, preflight, facts });
    write('gonogo.json', g);
    return g;
  }
  throw Error('USAGE: matrix | gonogo [--repo DIR] [--out DIR] [--facts FILE]');
}
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r.summary ? { summary: r.summary, sources: r.sources } : { decision: r.decision, blocking: r.blocking }, null, 2)))
  .catch(e => { console.log(JSON.stringify({ state: 'BLOCKED', reason: e.message === 'BLOCKED_SOURCE' ? 'BLOCKED_SOURCE:' + e.detail : String(e.message).slice(0, 160) })); process.exitCode = 2; });
module.exports = { main };
