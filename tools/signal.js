#!/usr/bin/env node
/*
 * 向大屏发送一条状态信号（跨平台，零依赖，永远以 0 退出，不会拖慢或阻塞调用它的工具）。
 *
 * 用法：
 *   node signal.js <agent> <start|stream|done|error|info> [任务说明] [--model 名] [--role 名] [--label 显示名]
 *                  [--url http://localhost:8787] [--token 令牌]
 *
 * 环境变量：AI_PANEL_URL、AI_PANEL_TOKEN
 *
 * 作为 Claude Code hooks 使用时，会从标准输入读取 hook 的 JSON，仅取工具名（tool_name）作为任务说明，
 * 不会读取或上传你的提示词内容。
 */
'use strict';
const http = require('http');
const https = require('https');

const argv = process.argv.slice(2);
const pos = [];
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++; } else pos.push(argv[i]);
}
const agent = pos[0], status = pos[1];
let task = pos[2];
if (!agent || !status) { console.error('用法：node signal.js <agent> <start|stream|done|error|info> [任务说明]'); process.exit(0); }

const base = (opt.url || process.env.AI_PANEL_URL || 'http://localhost:8787').replace(/\/+$/, '');
const token = opt.token || process.env.AI_PANEL_TOKEN || '';

function send() {
  const body = JSON.stringify({ agent, status, task, model: opt.model, role: opt.role, label: opt.label });
  let u;
  try { u = new URL(base + '/api/event'); } catch { process.exit(0); }
  const lib = u.protocol === 'https:' ? https : http;
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  if (token) headers['x-admin-token'] = token;
  const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: 800 }, res => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
  req.end(body);
}

if (process.stdin.isTTY) send();
else {
  let buf = '';
  let sent = false;
  const done = () => {
    if (sent) return; sent = true;
    try { const j = JSON.parse(buf); if (!task && j && typeof j.tool_name === 'string') task = j.tool_name; } catch { /* ignore */ }
    send();
  };
  const timer = setTimeout(done, 150);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { if (buf.length < 65536) buf += c; });
  process.stdin.on('end', () => { clearTimeout(timer); done(); });
  process.stdin.on('error', () => { clearTimeout(timer); done(); });
}
