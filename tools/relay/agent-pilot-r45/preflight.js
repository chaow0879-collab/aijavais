'use strict';
// Read-only preflight. It runs only `--version` style probes (never a model request), reports
// whether credentials are PRESENT (never their values), and labels every item
// VERIFIED / NOT_RUN / BLOCKED. Presence of a credential is not proof it works: only a real,
// authorized run can prove that, and preflight never does one.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Credential variables an independent runner may legitimately receive (e.g. GitHub Secrets).
const CREDENTIAL_ENV = { claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'] };
// Credentials of an interactive host session (like the Claude Code session that wrote this
// tool) are not the runner's credentials and are never inherited or reported as usable.
const HOST_SESSION_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE', 'CLAUDE_CODE_REMOTE_SESSION_ID'];

function which(name, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try { const st = fs.statSync(file); if (st.isFile() && (st.mode & 0o111)) return fs.realpathSync(file); } catch { /* not here */ }
  }
  return null;
}
function probe(executable, args, timeout = 15000) {
  const r = spawnSync(executable, args, { encoding: 'utf8', timeout, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8' }, maxBuffer: 1 << 20 });
  return { ok: r.status === 0 && !r.error, status: r.status, out: String(r.stdout || '').trim().split('\n')[0].slice(0, 200), timedOut: r.error?.code === 'ETIMEDOUT' };
}
function credentialStatus(kind, env = process.env) {
  const present = CREDENTIAL_ENV[kind].filter(k => typeof env[k] === 'string' && env[k].length > 0);
  return { status: present.length ? 'PRESENT_UNVERIFIED' : 'NOT_CONFIGURED', variables: present, note: present.length ? '已配置，但未经真实调用验证有效性' : '未提供官方认证凭据；真实调用必须 NOT_RUN' };
}
function cliStatus(kind, { executable, env = process.env } = {}) {
  const exe = executable || which(kind, env.PATH);
  if (!exe) return { kind, status: 'NOT_RUN', reason: 'CLI_NOT_INSTALLED', path: null, version: null };
  const v = probe(exe, ['--version']);
  if (!v.ok) return { kind, status: 'BLOCKED', reason: v.timedOut ? 'CLI_VERSION_TIMEOUT' : 'CLI_VERSION_FAILED', path: exe, version: null };
  const official = kind === 'claude' ? /\(Claude Code\)\s*$/.test(v.out) : /codex/i.test(v.out) || /^\d+\.\d+\.\d+/.test(v.out);
  // Non-interactive flags this runner relies on must exist in this exact CLI build.
  const r = spawnSync(exe, kind === 'claude' ? ['--help'] : ['exec', '--help'], { encoding: 'utf8', timeout: 15000, env: { PATH: env.PATH || '', HOME: env.HOME || '/tmp', LANG: 'C.UTF-8' } });
  const full = String(r.stdout || '') + String(r.stderr || '');
  const required = kind === 'claude' ? ['--print', '--output-format', '--max-budget-usd', '--permission-mode', '--allowedTools', '--no-session-persistence'] : ['--sandbox', '--json'];
  const missingFlags = required.filter(f => !full.includes(f));
  return { kind, status: official && !missingFlags.length ? 'VERIFIED' : 'BLOCKED', reason: !official ? 'CLI_NOT_OFFICIAL_OR_UNKNOWN' : missingFlags.length ? 'CLI_FLAGS_MISSING' : null,
    path: exe, version: v.out, missing_flags: missingFlags, note: '只执行了 --version/--help，没有调用模型' };
}
function runnerStatus(env = process.env) {
  const hosted = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  return { status: hosted ? 'VERIFIED' : 'NOT_RUN', ephemeral_github_hosted: hosted, runner_os: env.RUNNER_OS || process.platform,
    note: hosted ? 'GitHub-hosted 一次性 Runner（作业结束即销毁）' : '非 GitHub-hosted 一次性 Runner；真实调用默认禁止' };
}
function toolStatus(name, args = ['--version']) {
  const exe = which(name);
  if (!exe) return { name, status: 'NOT_RUN', reason: 'NOT_INSTALLED' };
  const v = probe(exe, args);
  return { name, status: v.ok ? 'VERIFIED' : 'BLOCKED', version: v.out };
}
function preflight({ env = process.env, executables = {} } = {}) {
  const hostSession = HOST_SESSION_MARKERS.some(k => env[k] !== undefined);
  const clis = { claude: cliStatus('claude', { executable: executables.claude, env }), codex: cliStatus('codex', { executable: executables.codex, env }) };
  const creds = { claude: credentialStatus('claude', env), codex: credentialStatus('codex', env) };
  const runner = runnerStatus(env);
  const tools = { node: { name: 'node', status: 'VERIFIED', version: process.version }, git: toolStatus('git'), gh: toolStatus('gh'), timeout: toolStatus('timeout') };
  const liveReady = kind => clis[kind].status === 'VERIFIED' && creds[kind].status === 'PRESENT_UNVERIFIED' && runner.ephemeral_github_hosted;
  return {
    schema: 'aijavais.pilot.preflight/v1', checked_at: new Date().toISOString(), tools, clis, credentials: creds, runner,
    host_session_credentials: hostSession ? 'PRESENT_EXCLUDED' : 'ABSENT',
    live_ready: { claude: liveReady('claude'), codex: liveReady('codex') },
    model_calls_made: 0,
    blocking: ['claude', 'codex'].map(k => liveReady(k) ? null : k + ':' + (clis[k].status !== 'VERIFIED' ? clis[k].reason : creds[k].status !== 'PRESENT_UNVERIFIED' ? 'CREDENTIALS_NOT_CONFIGURED' : 'NOT_EPHEMERAL_RUNNER')).filter(Boolean)
  };
}
module.exports = { preflight, cliStatus, credentialStatus, runnerStatus, which, CREDENTIAL_ENV, HOST_SESSION_MARKERS };
