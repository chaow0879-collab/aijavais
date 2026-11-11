'use strict';
function requireParsed(result, release = process.env.AIJ_RELEASE_VALIDATION === '1') {
  if (result.status === 'FAILED' || (release && result.status !== 'PARSED')) {
    const e = new Error('BLOCKED: independent Office parsing required'); e.code = 'office_parse_blocked'; throw e;
  }
  return { complete: result.status === 'PARSED', status: result.status };
}
module.exports = { requireParsed };
