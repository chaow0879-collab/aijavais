#!/usr/bin/env node
'use strict';
// node tools/agent-pilot-r45/cli.js preflight
// node tools/agent-pilot-r45/cli.js run --envelope FILE --state-dir DIR [--policy FILE] [--source-repo DIR] [--live]
// node tools/agent-pilot-r45/cli.js verify-outcome FILE
// Default is DRY_RUN. There is no daemon, timer, cron or polling loop here.
const fs = require('node:fs');
const P = require('./policy');
const C = require('./contract');
const { preflight } = require('./preflight');
const { runOnce } = require('./runner');
const readJson = (file, max = 65536) => { const st = fs.statSync(file); if (!st.isFile() || st.size > max) throw Error('INPUT_TOO_LARGE'); return JSON.parse(fs.readFileSync(file, 'utf8')); };
async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = name => { const i = rest.indexOf(name); return i < 0 ? null : rest[i + 1]; };
  if (cmd === 'preflight' && rest.length === 0) return preflight();
  if (cmd === 'verify-outcome' && rest.length === 1) { const o = readJson(rest[0]); const errors = C.outcomeErrors(o); return { ok: !errors.length, errors }; }
  if (cmd === 'run') {
    const known = ['--envelope', '--state-dir', '--policy', '--source-repo', '--fake-cli', '--live'];
    for (let i = 0; i < rest.length; i++) { if (!known.includes(rest[i])) throw Error('UNKNOWN_ARGUMENT'); if (rest[i] !== '--live') i++; }
    const policy = P.loadPolicy(flag('--policy') ? readJson(flag('--policy')) : undefined);
    const live = rest.includes('--live'), fake = flag('--fake-cli');
    const ac = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => ac.abort());
    return runOnce(readJson(flag('--envelope')), { policy, stateDir: flag('--state-dir'), sourceRepo: flag('--source-repo') || process.cwd(),
      mode: live ? 'live' : fake ? 'fake' : 'dry_run', live, fakeExecutable: fake, signal: ac.signal });
  }
  throw Error('USAGE: preflight | run --envelope FILE --state-dir DIR [--live] | verify-outcome FILE');
}
if (require.main === module) main(process.argv.slice(2)).then(r => { console.log(JSON.stringify(r, null, 2)); if (r && r.state && !['SUCCESS', 'DRY_RUN', 'DUPLICATE'].includes(r.state)) process.exitCode = 3; })
  .catch(e => { console.log(JSON.stringify({ state: 'BLOCKED', reason: String(e.message).slice(0, 120), actual_agent_launches: 0 })); process.exitCode = 2; });
module.exports = { main };
