'use strict';
/* Controlled JavaScript execution — OFF by default.
 * Enabled only when the server administrator sets AIJ_ENABLE_CODE_EXECUTION=1,
 * and every run must still grant the tool explicitly.
 * Isolation layers (all required; otherwise the tool refuses to run):
 *   - `unshare -rn`: new user + network namespace → no network at all;
 *   - Node permission model: file reads/writes only inside a private temp
 *     directory; no child processes, workers, addons or WASI;
 *   - time limit with process-group kill, V8 heap cap, bounded stdout/stderr
 *     and output files, minimal environment (no keys, no proxy settings).
 * This is a controlled runner for trusted-operator deployments, not a hardened
 * multi-tenant sandbox: strong isolation needs a dedicated container/VM runner.
 * Python and shell are deliberately not offered (their file access cannot be
 * confined this way). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const LIMITS = Object.freeze({ maxCodeBytes: 200000, maxInputFiles: 20, maxInputBytes: 2 * 1024 * 1024, timeoutMs: 30000, heapMb: 256, maxStreamBytes: 65536, maxOutputFiles: 10, maxOutputFileBytes: 1024 * 1024 });
class ExecError extends Error { constructor(code, message) { super(message); this.code = code; this.status = 422; } }
const fail = (code, message) => { throw new ExecError(code, message); };

function findUnshare() {
  for (const p of ['/usr/bin/unshare', '/bin/unshare']) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } }
  return null;
}
let probe;
/* Returns { enabled, isolated, reason }. The isolation probe runs once per process. */
function status() {
  const enabled = process.env.AIJ_ENABLE_CODE_EXECUTION === '1';
  if (probe === undefined) {
    const unshare = findUnshare();
    if (!unshare) probe = { isolated: false, reason: '服务器没有 unshare，无法隔离网络' };
    else {
      const r = spawnSync(unshare, ['-rn', process.execPath, '-e', 'process.exit(0)'], { timeout: 5000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      probe = r.status === 0 ? { isolated: true, unshare } : { isolated: false, reason: '当前环境不允许创建隔离命名空间（容器默认安全策略常见）；需要专用隔离运行环境' };
    }
  }
  return { enabled, isolated: probe.isolated, unshare: probe.unshare, reason: !enabled ? '管理员未开启（AIJ_ENABLE_CODE_EXECUTION=1）' : probe.reason || '' };
}
function safeRel(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.length > 200 || s.startsWith('/') || s.split('/').some(x => x === '..' || x === '' || x.startsWith('.')) || !/^[\w一-鿿./-]+$/u.test(s)) fail('invalid_path', '文件路径不合法：' + s);
  return s;
}
function collect(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) collect(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
async function runJavaScript({ code, files = {}, timeoutMs = 10000 }, { signal } = {}) {
  const st = status();
  if (!st.enabled || !st.isolated) fail('tool_unavailable', '受控代码执行不可用：' + st.reason);
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > LIMITS.maxCodeBytes) fail('invalid_code', '代码为空或超过 200 KB');
  const entries = Object.entries(files || {});
  if (entries.length > LIMITS.maxInputFiles || entries.reduce((n, [, v]) => n + Buffer.byteLength(String(v)), 0) > LIMITS.maxInputBytes) fail('input_limit', '输入文件过多或过大');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-exec-'));
  fs.chmodSync(root, 0o700);
  const work = path.join(root, 'work'); fs.mkdirSync(path.join(work, 'out'), { recursive: true });
  try {
    for (const [p, content] of entries) { const rel = safeRel(p); fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), String(content)); }
    fs.writeFileSync(path.join(work, 'main.js'), code);
    const before = new Set(collect(work));
    const limit = Math.max(1000, Math.min(LIMITS.timeoutMs, Math.floor(Number(timeoutMs) || 10000)));
    const args = ['-rn', process.execPath, '--permission', '--allow-fs-read=' + work, '--allow-fs-write=' + work, '--max-old-space-size=' + LIMITS.heapMb, '--disallow-code-generation-from-strings', path.join(work, 'main.js')];
    const t0 = Date.now();
    const result = await new Promise(resolve => {
      const child = spawn(st.unshare, args, { cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: work, TMPDIR: work, NODE_OPTIONS: '' } });
      const out = { stdout: [], stderr: [], bytes: { stdout: 0, stderr: 0 }, truncated: false };
      const take = k => c => { if (out.bytes[k] + c.length > LIMITS.maxStreamBytes) { out.truncated = true; c = c.subarray(0, Math.max(0, LIMITS.maxStreamBytes - out.bytes[k])); } out.bytes[k] += c.length; if (c.length) out[k].push(c); };
      child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
      let timedOut = false, cancelled = false;
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, limit);
      const onAbort = () => { cancelled = true; kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code, sig) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ exitCode: code, signal: sig, timedOut, cancelled, truncated: out.truncated, stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8') }); });
      child.on('error', () => { clearTimeout(timer); resolve({ exitCode: -1, timedOut, cancelled, truncated: false, stdout: '', stderr: '无法启动执行进程' }); });
    });
    if (result.cancelled) fail('aborted', '已取消');
    const created = collect(work).filter(f => !before.has(f) || f.startsWith('out/')).filter(f => f !== 'main.js').slice(0, LIMITS.maxOutputFiles);
    const outputs = created.map(f => { const b = fs.readFileSync(path.join(work, f)); return b.length > LIMITS.maxOutputFileBytes ? { path: f, bytes: b.length, skipped: '超过 1 MB，未保存' } : { path: f, bytes: b.length, buffer: b }; });
    return { ...result, durationMs: Date.now() - t0, outputs, isolation: 'network namespace + Node permission model (fs limited to private temp dir; no child processes/workers)' };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { runJavaScript, codeExecStatus: status, ExecError, CODE_EXEC_LIMITS: LIMITS };
