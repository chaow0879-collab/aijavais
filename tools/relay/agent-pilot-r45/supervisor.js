'use strict';
// Bounded child process: no shell, allow-listed environment, own process group, a hard
// wall-clock enforced twice (by this supervisor and by coreutils `timeout`, which still
// kills the CLI if this supervisor itself dies), output cap, cancellation, secret redaction.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[REDACTED]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').replace(/\b(sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]');
}
function run({ executable, args, cwd, env, timeoutMs, maxOutputBytes, secrets = [], signal, timeoutBin = '/usr/bin/timeout' }) {
  return new Promise(resolve => {
    const started = Date.now();
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const useWrapper = fs.existsSync(timeoutBin);
    const [cmd, argv] = useWrapper ? [timeoutBin, ['--signal=TERM', '--kill-after=5', secs + 's', executable, ...args]] : [executable, args];
    let child, reason = null, bytes = 0, done = false, hardKill;
    const out = [], err = [];
    try { child = spawn(cmd, argv, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ state: 'BLOCKED', reason: 'SPAWN_FAILED', pid: null }); return; }
    const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const stop = why => { if (done) return; reason = reason || why; killGroup('SIGTERM'); hardKill = hardKill || setTimeout(() => killGroup('SIGKILL'), 2000); };
    const watchdog = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const onAbort = () => stop('CANCELLED');
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const take = list => chunk => { bytes += chunk.length; if (bytes > maxOutputBytes) { stop('OUTPUT_LIMIT'); return; } list.push(chunk); };
    child.stdout.on('data', take(out)); child.stderr.on('data', take(err));
    child.on('error', () => { reason = reason || 'SPAWN_FAILED'; });
    child.on('close', (code, sig) => {
      done = true; clearTimeout(watchdog); clearTimeout(hardKill); signal?.removeEventListener('abort', onAbort);
      // coreutils timeout exits 124 when it had to stop the command itself.
      if (useWrapper && code === 124 && !reason) reason = 'TIMEOUT';
      if (code === 127 && !reason) reason = 'CLI_NOT_FOUND';
      resolve({ pid: child.pid, wrapper: useWrapper ? 'coreutils-timeout' : null, exit_code: code, signal: sig, elapsed_ms: Date.now() - started, reason,
        stdout: redact(Buffer.concat(out).toString('utf8'), secrets), stderr: redact(Buffer.concat(err).toString('utf8'), secrets) });
    });
  });
}
module.exports = { run, redact };
