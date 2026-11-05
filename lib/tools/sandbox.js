'use strict';
/*
 * 子进程执行沙箱（代码执行、测试运行、Git、文档转换共用）。
 * 限制：工作目录固定为任务工作区；精简环境变量（不继承服务端的 API Key 等机密）；超时强制结束整个进程组；
 *       标准输出 / 错误各自截断；Linux 上用 ulimit 限制虚拟内存与单文件大小。
 * 已知边界（如实说明）：普通进程无法在不借助容器 / 命名空间的情况下禁止读取工作区以外的文件或访问网络。
 *   因此代码执行属于高风险工具，默认需要人工批准；对外部署建议使用 Docker（见部署文档），在容器内运行。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAFE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];

function safeEnv(workdir, extra = {}) {
  const env = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.HOME = workdir; env.USERPROFILE = workdir; env.NODE_OPTIONS = ''; env.PYTHONDONTWRITEBYTECODE = '1';
  env.LANG = env.LANG || 'C.UTF-8';
  return { ...env, ...extra };
}

/*
 * run(cmd, args, { cwd, timeoutMs, maxOutput, memoryMb, input, env, signal })
 * → { code, signal, timedOut, cancelled, stdout, stderr, ms, truncated }
 */
function run(cmd, args = [], opts = {}) {
  const cwd = opts.cwd;
  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs || 30000, 600000));
  const maxOut = opts.maxOutput || 64 * 1024;
  const mem = opts.memoryMb || 1024;
  return new Promise(resolve => {
    const t0 = Date.now();
    let file = cmd, argv = args;
    if (process.platform === 'linux' && opts.limit !== false) {
      // ulimit：虚拟内存（KB）、单文件 200MB、进程数 256
      file = '/bin/sh';
      argv = ['-c', `ulimit -v ${mem * 1024} 2>/dev/null; ulimit -f ${200 * 1024} 2>/dev/null; ulimit -u 256 2>/dev/null; exec "$0" "$@"`, cmd, ...args];
    }
    let child;
    try { child = spawn(file, argv, { cwd, env: opts.env || safeEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message), ms: 0, error: e.message }); }
    let out = Buffer.alloc(0), err = Buffer.alloc(0), truncated = false, timedOut = false, cancelled = false, done = false;
    const cap = (buf, chunk) => { if (buf.length >= maxOut) { truncated = true; return buf; } const b = Buffer.concat([buf, chunk]); if (b.length > maxOut) { truncated = true; return b.subarray(0, maxOut); } return b; };
    child.stdout.on('data', c => { out = cap(out, c); });
    child.stderr.on('data', c => { err = cap(err, c); });
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, stdout: out.toString('utf8'), stderr: err.toString('utf8') + '\n' + e.message, ms: Date.now() - t0, error: e.message }); });
    child.on('close', (code, sig) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, timedOut, cancelled, stdout: out.toString('utf8'), stderr: err.toString('utf8'), ms: Date.now() - t0, truncated });
    });
    if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/* 工作区路径：拒绝 ..、绝对路径、符号链接逃逸 */
function resolveIn(root, rel) {
  const raw = String(rel || '');
  if (/^([a-zA-Z]:|[\\/])/.test(raw)) throw new Error('不允许使用绝对路径：' + rel);
  const r = raw.replace(/\\/g, '/');
  if (!r || r.split('/').some(p => p === '..')) throw new Error('路径不合法：' + rel);
  const full = path.resolve(root, r);
  const rootReal = fs.realpathSync(root);
  if (full !== rootReal && !full.startsWith(rootReal + path.sep) && !full.startsWith(path.resolve(root) + path.sep)) throw new Error('路径超出工作区：' + rel);
  // 已存在的上级目录不能是指向工作区外的符号链接
  let p = path.dirname(full);
  while (p.length >= rootReal.length) {
    if (fs.existsSync(p)) { const real = fs.realpathSync(p); if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('路径通过符号链接逃逸工作区：' + rel); break; }
    p = path.dirname(p);
  }
  if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) throw new Error('不允许操作符号链接：' + rel);
  return full;
}

/* 可执行程序探测（带缓存） */
const whichCache = new Map();
async function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd], { cwd: process.cwd(), timeoutMs: 5000, limit: false, env: process.env });
  const p = r.code === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
  whichCache.set(cmd, p);
  return p;
}

module.exports = { run, resolveIn, which, safeEnv };
