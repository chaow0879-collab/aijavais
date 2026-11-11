'use strict';
// Test-only MOCK model adapters with ground-truth lifecycle counters.
// They never contact a real vendor and never charge anything. "Underlying"
// counters change only when the adapter's own promise truly settles, so they
// are independent of the service's wrapper promises and slot bookkeeping.
const http = require('node:http');
const sample = require('./ai-draft.cjs');

const okResult = (extra = {}) => ({ text: JSON.stringify(sample()), tokens: 30, inTokens: 20, outTokens: 10, estimated: false, usageComplete: true, ...extra });

// mode: 'ignore'  -> non-cooperative: never looks at opts.signal (worst case)
//       'honor'   -> cooperative: rejects promptly when opts.signal aborts
//       'honor-with-usage' -> cooperative, and the provider reports partial usage on abort
function controlledProvider({ mode = 'ignore' } = {}) {
  const m = { started: 0, underlyingInFlight: 0, peakUnderlyingInFlight: 0, ended: 0, timeline: [] };
  const calls = [];
  const waiters = [];
  const notify = () => { for (const w of waiters.splice(0)) w(); };
  function callModel(runtime, opts) {
    m.started++; m.underlyingInFlight++;
    m.peakUnderlyingInFlight = Math.max(m.peakUnderlyingInFlight, m.underlyingInFlight);
    const call = { index: calls.length, opts, done: false, startedAt: process.hrtime.bigint() };
    m.timeline.push({ event: 'start', index: call.index, inFlight: m.underlyingInFlight });
    const promise = new Promise((resolve, reject) => {
      const finish = (kind, value) => {
        if (call.done) return false;
        call.done = true; m.underlyingInFlight--; m.ended++;
        m.timeline.push({ event: 'end', kind, index: call.index, inFlight: m.underlyingInFlight });
        (kind === 'resolve' ? resolve : reject)(value);
        notify();
        return true;
      };
      call.resolve = (value = okResult()) => finish('resolve', value);
      call.reject = (error = Object.assign(new Error('MOCK provider failure'), { usageUnknown: true })) => finish('reject', error);
    });
    if (mode !== 'ignore' && opts.signal) {
      const onAbort = () => call.reject(mode === 'honor-with-usage'
        ? Object.assign(new Error('MOCK provider stopped on abort'), { tokens: 12, inTokens: 10, outTokens: 2, estimated: false })
        : Object.assign(new Error('MOCK provider stopped on abort'), { usageUnknown: true }));
      if (opts.signal.aborted) queueMicrotask(onAbort); else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    calls.push(call); notify();
    return promise;
  }
  async function until(predicate, label = 'condition', ms = 3000) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
      await new Promise(r => { waiters.push(r); setTimeout(r, 5); });
    }
  }
  const pending = () => calls.filter(c => !c.done);
  return { callModel, calls, metrics: m, until, pending, okResult };
}

// A real local HTTP "provider" (OpenAI-compatible SSE) that holds each request
// open until told to finish. It records whether the request socket was closed
// by the client - the ground truth for "did the outbound request really stop".
async function hangingHttpProvider() {
  const state = { requests: [], open: 0, peakOpen: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const entry = { body: body ? JSON.parse(body) : null, closedByClient: false, finished: false, res };
      state.requests.push(entry); state.open++; state.peakOpen = Math.max(state.peakOpen, state.open);
      res.on('close', () => { if (!entry.finished) entry.closedByClient = true; state.open--; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': pending\n\n');
      entry.finish = (usage = { prompt_tokens: 20, completion_tokens: 10 }) => {
        if (entry.finished || entry.closedByClient) return false;
        entry.finished = true;
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(sample()) } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage }) + '\n\ndata: [DONE]\n\n');
        return true;
      };
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, state, port: server.address().port,
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

// Minimal OpenAI-compatible SSE client used by in-process tests. `honorSignal`
// selects whether the outbound HTTP request is tied to the caller's signal.
function httpCallModel(port, { honorSignal }) {
  return async (runtime, opts) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: runtime.model, stream: true, messages: [{ role: 'user', content: opts.prompt }] }), ...(honorSignal ? { signal: opts.signal } : {}) });
    const raw = await res.text();
    let text = '', usage = null;
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const j = JSON.parse(line.slice(6));
      if (j.choices?.[0]?.delta?.content) text += j.choices[0].delta.content;
      if (j.usage) usage = j.usage;
    }
    return usage ? { text, tokens: usage.prompt_tokens + usage.completion_tokens, inTokens: usage.prompt_tokens, outTokens: usage.completion_tokens, estimated: false, usageComplete: true }
      : { text, usageUnknown: true };
  };
}
module.exports = { controlledProvider, hangingHttpProvider, httpCallModel, okResult };
