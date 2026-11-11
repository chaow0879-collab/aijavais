'use strict';
// Loopback-only webhook receiver used for E3 evidence (real Node HTTP, raw-body HMAC).
// It binds 127.0.0.1 and refuses to start on any other address; it never echoes payloads.
const http = require('node:http');
const { verifyDelivery } = require('./intake');
function serve({ secret, r46config, policy, store, onTrigger, clock = Date.now, host = '127.0.0.1' }) {
  if (host !== '127.0.0.1') return Promise.reject(Object.assign(Error('LOOPBACK_ONLY'), { code: 'LOOPBACK_ONLY' }));
  const server = http.createServer((req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'POST' || req.url !== '/github/webhook') return reply(404, { state: 'NOT_FOUND' });
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > policy.max_body_bytes) { reply(413, { state: 'REJECTED', reason: 'BODY_SIZE' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let record;
      try { record = verifyDelivery({ headers: req.headers, body: Buffer.concat(chunks) }, { secret, r46config, policy, store, now: clock() }); }
      catch (e) { return reply(e.code === 'REPLAYED_DELIVERY' ? 409 : 401, { state: 'REJECTED', reason: e.code || 'UNTRUSTED_EVENT' }); }
      try { reply(202, { state: 'ACCEPTED', result: await onTrigger(record) }); } catch { reply(500, { state: 'BLOCKED', reason: 'HANDLER_FAILED' }); }
    });
  });
  return new Promise(resolve => server.listen(0, host, () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/github/webhook' })));
}
module.exports = { serve };
