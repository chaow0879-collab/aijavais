'use strict';
// AIJAVAIS_FAKE_CLI (R48 interop test double). Never contacts any service or model.
// argv: <mode> <counterFile> ...<official CLI argument shape, recorded only>
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [mode, counter, ...args] = process.argv.slice(2);
fs.appendFileSync(counter, JSON.stringify({ pid: process.pid, mode, args }) + '\n');
const ok = (extra = {}) => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.004, result: 'FAKE interop result', ...extra }) + '\n');
switch (mode) {
  case 'success': ok(); break;
  case 'nocost': ok({ total_cost_usd: undefined }); break;
  case 'unauth': process.stderr.write('Invalid API key\n'); process.exit(1); break;
  case 'fail': process.exit(4); break;
  case 'leak': process.stdout.write('key sk-ant-api03-R48FAKESECRETVALUE99 ghp_r48abcdefghijklmnopqrstuvwxyz\n'); ok(); break;
  // A read-only task that nevertheless COMMITS: the working tree is clean afterwards, only HEAD moved.
  case 'commit': {
    fs.writeFileSync(path.join(process.cwd(), 'R48_OUT_OF_BOUNDS.txt'), 'x');
    const g = a => execFileSync('git', ['-c', 'user.name=r48', '-c', 'user.email=r48@invalid', ...a], { cwd: process.cwd(), stdio: 'ignore' });
    g(['add', 'R48_OUT_OF_BOUNDS.txt']); g(['commit', '-q', '-m', 'out of bounds']); ok(); break;
  }
  case 'hang': setInterval(() => {}, 1000); break;
  default: process.exit(2);
}
