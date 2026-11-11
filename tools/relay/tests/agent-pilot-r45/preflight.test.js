'use strict';
// Preflight never calls a model, never prints a credential value, and never treats the
// interactive host session's credentials as the runner's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../../agent-pilot-r45/preflight');
const H = require('./helpers.cjs');

const script = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o700 }); return f; };

test('credentials: presence only, values never returned', () => {
  const secret = 'sk-ant-api03-VALUE-THAT-MUST-NOT-APPEAR';
  const r = F.credentialStatus('claude', { ANTHROPIC_API_KEY: secret });
  assert.equal(r.status, 'PRESENT_UNVERIFIED'); assert.deepEqual(r.variables, ['ANTHROPIC_API_KEY']);
  assert.doesNotMatch(JSON.stringify(r), /VALUE-THAT/);
  assert.equal(F.credentialStatus('claude', {}).status, 'NOT_CONFIGURED');
  assert.equal(F.credentialStatus('claude', { ANTHROPIC_API_KEY: '' }).status, 'NOT_CONFIGURED');
  assert.equal(F.credentialStatus('codex', { OPENAI_API_KEY: 'x' }).status, 'PRESENT_UNVERIFIED');
});

test('host interactive session credentials are reported as excluded, never usable', () => {
  const r = F.preflight({ env: { PATH: process.env.PATH, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' } });
  assert.equal(r.host_session_credentials, 'PRESENT_EXCLUDED');
  assert.equal(r.credentials.claude.status, 'NOT_CONFIGURED');
  assert.equal(r.live_ready.claude, false); assert.equal(r.model_calls_made, 0);
  assert.doesNotMatch(JSON.stringify(r), /"abc"/);
});

test('CLI detection: official version string and required non-interactive flags', t => {
  const dir = H.tmp(t);
  const flags = '--print --output-format --max-budget-usd --permission-mode --allowedTools --no-session-persistence';
  const good = script(dir, 'claude-good', 'if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; else echo "' + flags + '"; fi');
  assert.equal(F.cliStatus('claude', { executable: good }).status, 'VERIFIED');
  const old = script(dir, 'claude-old', 'if [ "$1" = "--version" ]; then echo "1.0.0 (Claude Code)"; else echo "--print --output-format"; fi');
  const r = F.cliStatus('claude', { executable: old });
  assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'CLI_FLAGS_MISSING'); assert.ok(r.missing_flags.includes('--max-budget-usd'));
  const impostor = script(dir, 'claude-imp', 'echo "hello"');
  assert.equal(F.cliStatus('claude', { executable: impostor }).reason, 'CLI_NOT_OFFICIAL_OR_UNKNOWN');
  const broken = script(dir, 'claude-broken', 'exit 9');
  assert.equal(F.cliStatus('claude', { executable: broken }).reason, 'CLI_VERSION_FAILED');
  assert.equal(F.cliStatus('claude', { env: { PATH: dir } }).reason, 'CLI_NOT_INSTALLED');
});

test('runner environment: only a GitHub-hosted ephemeral runner qualifies', () => {
  assert.equal(F.runnerStatus({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }).ephemeral_github_hosted, true);
  assert.equal(F.runnerStatus({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }).ephemeral_github_hosted, false);
  assert.equal(F.runnerStatus({}).status, 'NOT_RUN');
});

test('real preflight of this machine: honest statuses, zero model calls', () => {
  const r = F.preflight();
  assert.equal(r.model_calls_made, 0);
  for (const k of ['claude', 'codex']) assert.ok(['VERIFIED', 'NOT_RUN', 'BLOCKED'].includes(r.clis[k].status));
  assert.ok(Array.isArray(r.blocking));
  // Without runner credentials, live readiness must be false whatever binaries exist.
  if (r.credentials.claude.status === 'NOT_CONFIGURED') assert.equal(r.live_ready.claude, false);
  if (process.env.R45_PREFLIGHT_OUT) fs.writeFileSync(process.env.R45_PREFLIGHT_OUT, JSON.stringify(r, null, 2));
});
