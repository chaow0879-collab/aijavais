'use strict';
// JSON.parse silently accepts duplicate names (including escaped spellings),
// which can erase permanent jobs. Validate every object before accepting state.
function parseState(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error('REMOTE_DOCUMENT_UNKNOWN');
  const parsed = JSON.parse(text);
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const str = () => {
    const start = at++;
    while (at < text.length) { const c = text[at++]; if (c === '\\') at++; else if (c === '"') return JSON.parse(text.slice(start, at)); }
    throw Error('REMOTE_DOCUMENT_UNKNOWN');
  };
  function value(depth) {
    if (depth > 64) throw Error('REMOTE_DOCUMENT_UNKNOWN');
    ws();
    if (text[at] === '{') {
      at++; ws(); const seen = new Set();
      if (text[at] === '}') { at++; return; }
      while (true) {
        ws(); const key = str();
        if (seen.has(key)) throw Error('REMOTE_DUPLICATE_JSON_KEY');
        seen.add(key); ws(); at++; value(depth + 1); ws();
        if (text[at++] === '}') return;
      }
    }
    if (text[at] === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      while (true) { value(depth + 1); ws(); if (text[at++] === ']') return; }
    }
    if (text[at] === '"') { str(); return; }
    while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
  }
  value(0); return parsed;
}
module.exports = { parseState };
