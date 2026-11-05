'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { parseSSE, readLimitedText, LimitError } = require('../lib/sse');
const SEC = require('../lib/security');

const streamOf = chunks => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(typeof x === 'string' ? Buffer.from(x) : x); c.close(); } });
const collect = async (chunks, opts) => { const out = []; await parseSSE(streamOf(chunks), d => out.push(d), opts); return out; };

test('SSE：多行 data 合并为一个事件；注释 / event / id 忽略；CRLF 与 CR', async () => {
  assert.deepEqual(await collect(['data: {"a":\n', 'data: 1}\n\n', ': hb\n\n', 'event: x\nid: 7\ndata: two\n\n']), ['{"a":\n1}', 'two']);
  assert.deepEqual(await collect(['data: a\r\n\r\ndata: b\r\rdata:c\n\n']), ['a', 'b', 'c']);
  assert.deepEqual(await collect(['data:  两个空格\n\n']), [' 两个空格'], '只去掉一个前导空格');
  assert.deepEqual(await collect(['data: [DONE]\n\n']), ['[DONE]']);
});

test('SSE：跨块切分（含多字节字符被截断）、流末尾无空行仍回调', async () => {
  const buf = Buffer.from('data: 你好世界\n\ndata: end');
  const out = await collect([buf.slice(0, 8), buf.slice(8, 9), buf.slice(9, 22), buf.slice(22)]);
  assert.deepEqual(out, ['你好世界', 'end']);
  assert.deepEqual(await collect(['data: x\r', '\n\r', '\n']), ['x'], 'CRLF 被拆在两块之间');
});

test('SSE：单事件 / 总量 / 单行上限', async () => {
  await assert.rejects(collect(['data: ' + 'x'.repeat(2000) + '\n\n'], { maxEventBytes: 1000 }), LimitError);
  await assert.rejects(collect(['data: ' + 'a\ndata: '.repeat(600) + 'z\n\n'], { maxEventBytes: 1000 }), LimitError);
  await assert.rejects(collect(['data: a\n\n', 'data: b\n\n', 'data: c\n\n'], { maxTotalBytes: 20 }), /超过/);
  await assert.rejects(collect(['x'.repeat(5000)], { maxEventBytes: 1000 }), LimitError, '没有换行的超长行');
  let bytes = 0; await collect(['data: a\n\n'], { onBytes: n => { bytes += n; } }); assert.equal(bytes, 9);
});

test('readLimitedText：只读上限内的错误体', async () => {
  const r = new Response(streamOf(['a'.repeat(10000)]));
  assert.equal((await readLimitedText(r, 100)).length, 100);
  assert.equal(await readLimitedText({ body: null }), '');
});

test('DNS 超时：解析卡住时在期限内失败，不无限等待', async () => {
  const policy = { ...SEC.policyFromEnv({}), dnsTimeoutMs: 150, lookup: () => new Promise(() => {}) };
  const t0 = Date.now();
  const r = await SEC.resolveTarget('https://slow.example.com/v1', policy);
  assert.equal(r.ok, false); assert.match(r.error, /DNS 解析超时/);
  assert.ok(Date.now() - t0 < 1500);
  await assert.rejects(SEC.pinnedFetch('https://slow.example.com/v1/x', {}, policy), /DNS 解析超时/);
});

test('响应体大小上限：pinnedFetch 超限即中断', async t => {
  const srv = http.createServer((req, res) => { res.writeHead(200); const iv = setInterval(() => res.write('x'.repeat(1000)), 5); res.on('close', () => clearInterval(iv)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const port = srv.address().port;
  const policy = { ...SEC.policyFromEnv({ LOCAL_MODEL_TARGETS: '127.0.0.1:' + port }) };
  const res = await SEC.pinnedFetch(`http://127.0.0.1:${port}/x`, { maxBytes: 5000 }, policy);
  await assert.rejects((async () => { const rd = res.body.getReader(); for (;;) { const { done } = await rd.read(); if (done) return; } })(), /上限|terminated|aborted|premature/i);
  // 默认上限来自 policy
  const p2 = { ...policy, maxResponseBytes: 3000 };
  const r2 = await SEC.pinnedFetch(`http://127.0.0.1:${port}/x`, {}, p2);
  await assert.rejects(r2.text());
});
