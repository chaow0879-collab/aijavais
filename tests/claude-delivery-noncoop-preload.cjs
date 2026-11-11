'use strict';
// TEST-ONLY preload for a disposable server process started by
// tests/ui/claude-delivery.e2e.js (#19). It makes the outbound model adapter
// non-cooperative by dropping the AbortSignal, so a cancelled draft keeps its
// real local HTTP stream open - the condition ProductQA used to reproduce
// QA-GAPS-UX-01. Production code is not modified; the normal adapter honours
// cancellation (it destroys the stream on abort).
const path = require('node:path');
const SEC = require(path.join(__dirname, '..', 'lib', 'security'));
const original = SEC.pinnedFetch;
SEC.pinnedFetch = (url, opts = {}, policy) => {
  const { signal, ...rest } = opts; // eslint-disable-line no-unused-vars
  return original(url, rest, policy);
};
