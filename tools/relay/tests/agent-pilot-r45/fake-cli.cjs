'use strict';
// AIJAVAIS_FAKE_CLI test double for the Claude/Codex CLIs. Never contacts any service.
// argv: <mode> <counterFile> ...<real CLI arguments, ignored except for recording>
const fs = require('node:fs');
const path = require('node:path');
const [mode, counter, ...cliArgs] = process.argv.slice(2);
if (counter) fs.appendFileSync(counter, JSON.stringify({ pid: process.pid, args: cliArgs }) + '\n');
const result = extra => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, result: 'FAKE: repository summary', ...extra }) + '\n');
switch (mode) {
  case 'success': result(); break;
  case 'nocost': result({ total_cost_usd: undefined }); break;
  case 'iserror': result({ is_error: true }); break;
  case 'overcost': result({ total_cost_usd: 9 }); break;
  case 'fail': process.stderr.write('something broke\n'); process.exit(3); break;
  case 'unauth': process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); break;
  case 'denied': process.stderr.write('API Error: 403 Forbidden\n'); process.exit(1); break;
  case 'write': fs.writeFileSync(path.join(process.cwd(), 'INJECTED.txt'), 'x'); result(); break;
  case 'env': process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0, result: JSON.stringify({ names: Object.keys(process.env).sort(), home: process.env.HOME, cwd: process.cwd() }) }) + '\n'); break;
  case 'leak': process.stdout.write('token sk-ant-api03-THISISAFAKESECRETVALUE1234 ghp_abcdefghijklmnopqrstuvwxyz0123 Bearer abc.def\n'); result(); break;
  case 'bigout': process.stdout.write('x'.repeat(2 << 20)); break;
  case 'hang': {
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    if (process.env.TMPDIR) fs.writeFileSync(path.join(path.dirname(counter), 'hang-pids.json'), JSON.stringify([process.pid, grandchild.pid]));
    setInterval(() => {}, 1000); break;
  }
  default: process.exit(2);
}
