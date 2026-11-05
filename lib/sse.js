'use strict';
/*
 * SSE 解析与有限读取（零依赖）。
 * 规则（遵循 WHATWG SSE）：
 *   - 事件以空行结束；同一事件内多行 data: 用 "\n" 连接后一次回调（不再逐行回调）；
 *   - data: 后只去掉一个前导空格；以 ":" 开头的是注释，event:/id:/retry: 行忽略；
 *   - 流结束时若还有未以空行结束的事件，仍然回调一次；
 *   - 单个事件超过 maxEventBytes、整个响应超过 maxTotalBytes 则抛错并停止读取。
 */
const DEFAULTS = Object.freeze({ maxEventBytes: 1 << 20, maxTotalBytes: 8 << 20 });

class LimitError extends Error { constructor(msg) { super(msg); this.name = 'LimitError'; } }

async function parseSSE(body, onData, { maxEventBytes = DEFAULTS.maxEventBytes, maxTotalBytes = DEFAULTS.maxTotalBytes, onBytes } = {}) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', data = [], dataBytes = 0, total = 0;
  const flush = () => {
    if (data.length) { const s = data.join('\n'); data = []; dataBytes = 0; onData(s); }
  };
  const line = l => {
    if (l === '') return flush();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    if (field !== 'data') return;
    let v = i < 0 ? '' : l.slice(i + 1);
    if (v.startsWith(' ')) v = v.slice(1);
    dataBytes += Buffer.byteLength(v) + 1;
    if (dataBytes > maxEventBytes) throw new LimitError('单个事件超过 ' + maxEventBytes + ' 字节上限');
    data.push(v);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (onBytes) onBytes(value.length);
      if (total > maxTotalBytes) throw new LimitError('响应超过 ' + maxTotalBytes + ' 字节上限');
      buf += dec.decode(value, { stream: true });
      if (buf.length > maxEventBytes * 2 && buf.indexOf('\n') < 0) throw new LimitError('单行超过上限');
      let i;
      while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
        // 孤立的 \r 若在缓冲末尾，可能后面紧跟 \n，等待更多数据
        if (buf[i] === '\r' && i === buf.length - 1) break;
        const len = buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1;
        const l = buf.slice(0, i);
        buf = buf.slice(i + len);
        line(l);
      }
    }
    buf += dec.decode();
    if (buf) line(buf.replace(/\r$/, ''));
    flush();
  } catch (e) {
    try { await reader.cancel(); } catch { /* 忽略 */ }
    throw e;
  }
}

/* 最多读取 max 字节文本（错误响应体等），超出部分直接丢弃并取消读取 */
async function readLimitedText(res, max = 4096) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); n += value.length;
    }
  } finally { try { await reader.cancel(); } catch { /* 忽略 */ } }
  return Buffer.concat(chunks).slice(0, max).toString('utf8');
}

module.exports = { parseSSE, readLimitedText, LimitError, DEFAULTS };
