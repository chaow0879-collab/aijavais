'use strict';
// Runs the frozen R45 preflight (read-only: --version/--help, credential presence by name)
// from an exact-SHA assembled tree, so GO/NO_GO uses R45's own code, not a copy.
const path = require('node:path');
const { assemble, cleanup } = require('./sources');
module.exports = repo => {
  const m = assemble(repo);
  try { return { preflight: require(path.join(m.sources.r45.dir, 'tools/agent-pilot-r45/preflight.js')).preflight(), sha: m.sources.r45.sha }; }
  finally { cleanup(m); }
};
