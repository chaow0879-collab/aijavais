'use strict';
/* 测试用 MCP Server（stdio，官方 SDK 实现）：提供 echo、add、env_probe 三个工具。只用于自动化测试。 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'aij-test-mcp', version: '1.0.0' });
server.registerTool('echo', { title: 'Echo', description: '原样返回文字', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text: 'echo:' + text }] }));
server.registerTool('add', { title: 'Add', description: '两数相加', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
/* 报告进程能看到的环境变量名（用于验证平台机密没有泄露给第三方进程） */
server.registerTool('env_probe', { title: 'Env probe', description: '列出环境变量名与工作目录', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: JSON.stringify({ keys: Object.keys(process.env).sort(), cwd: process.cwd() }) }] }));
server.connect(new StdioServerTransport());
