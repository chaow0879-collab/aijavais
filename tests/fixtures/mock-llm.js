'use strict';
/*
 * 测试用模拟模型服务（只用于自动化测试，不是产品功能）。
 * 同时实现 Anthropic Messages（/v1/messages）与 OpenAI Chat Completions（/v1/chat/completions）的流式协议，含工具调用。
 * brain(req) 决定回复：返回 { text, toolCalls: [{ name, arguments }], usage, status, delay, hang }。
 *   req = { protocol, model, system, messages（统一格式）, tools: [name], raw }
 * 模拟模型的输出是脚本化的，不代表任何真实厂商的行为；测试报告里会明确标注“模拟模型驱动”。
 */
const http = require('http');

function toUnified(protocol, body) {
  const messages = [];
  let system = '';
  if (protocol === 'anthropic') {
    system = Array.isArray(body.system) ? body.system.map(b => b.text).join('\n') : (body.system || '');
    for (const m of body.messages || []) {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      if (m.role === 'assistant') messages.push({ role: 'assistant', content: blocks.filter(b => b.type === 'text').map(b => b.text).join(''), toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, arguments: b.input })) });
      else {
        for (const b of blocks) {
          if (b.type === 'tool_result') messages.push({ role: 'tool', toolCallId: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: !!b.is_error });
          else if (b.type === 'text') messages.push({ role: 'user', content: b.text });
        }
      }
    }
    return { system, messages, tools: (body.tools || []).map(t => t.name) };
  }
  for (const m of body.messages || []) {
    if (m.role === 'system') system += m.content;
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content || '', toolCalls: (m.tool_calls || []).map(c => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments || '{}') })) });
    else if (m.role === 'tool') messages.push({ role: 'tool', toolCallId: m.tool_call_id, content: m.content });
    else messages.push({ role: 'user', content: m.content });
  }
  return { system, messages, tools: (body.tools || []).map(t => t.function.name) };
}

function startMockLlm(brain, { port = 0 } = {}) {
  const log = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8');
    req.on('data', c => b += c);
    req.on('end', async () => {
      if (req.method === 'GET' && /\/models$/.test(req.url.split('?')[0])) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] })); }
      const protocol = /\/messages$/.test(req.url) ? 'anthropic' : 'openai';
      let body; try { body = JSON.parse(b || '{}'); } catch { res.writeHead(400); return res.end('{}'); }
      const u = toUnified(protocol, body);
      const entry = { protocol, model: body.model, ...u, raw: body, headers: req.headers };
      log.push(entry);
      let out;
      try { out = (await brain(entry)) || {}; } catch (e) { out = { status: 500, text: String(e.message) }; }
      if (out.status) { res.writeHead(out.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: out.text || 'mock error' } })); }
      if (out.hang) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); return; }
      await new Promise(r => setTimeout(r, out.delay || 0));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = out.text || '';
      const calls = (out.toolCalls || []).map(c => ({ id: c.id || `call_${++n}`, name: c.name, arguments: c.arguments || {} }));
      const usage = out.usage === null ? null : (out.usage || { input: 100, output: 20 });
      const w = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (protocol === 'anthropic') {
        w({ type: 'message_start', message: { usage: usage ? { input_tokens: usage.input, output_tokens: 0, cache_read_input_tokens: usage.cacheRead || 0, cache_creation_input_tokens: usage.cacheWrite || 0 } : {} } });
        let i = 0;
        if (text) { w({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }); for (const ch of chunks(text)) w({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: ch } }); w({ type: 'content_block_stop', index: i }); i++; }
        for (const c of calls) {
          w({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
          for (const ch of chunks(JSON.stringify(c.arguments), 40)) w({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: ch } });
          w({ type: 'content_block_stop', index: i }); i++;
        }
        w({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: usage ? { output_tokens: usage.output } : {} });
        w({ type: 'message_stop' });
      } else {
        for (const ch of chunks(text)) w({ choices: [{ index: 0, delta: { content: ch } }] });
        calls.forEach((c, idx) => {
          const args = JSON.stringify(c.arguments);
          w({ choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
          for (const ch of chunks(args, 40)) w({ choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: ch } }] } }] });
        });
        w({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
        if (usage) w({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, prompt_tokens_details: { cached_tokens: usage.cacheRead || 0 } } });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r({ srv, port: srv.address().port, log, close: () => { srv.closeAllConnections(); srv.close(); } })));
}
function* chunks(s, n = 12) { for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n); }

module.exports = { startMockLlm };
