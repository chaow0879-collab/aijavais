'use strict';
const path = require('path'), R = process.argv[2], H = require(path.join(R, 'tests/helpers.js')), PR = require(path.join(R, 'lib/prices.js'));
(async () => {
  const S = await H.boot(); const out = {};
  try {
    const link = (await S.call('POST', '/api/auth/display-link', { label: 'aud', hours: 1 })).json;
    const r = await H.call(S.port, 'GET', link.path, undefined, { cookie: false }), dc = H.cookieFrom(r);
    const g = async (u, cookie) => { const x = await H.call(S.port, 'GET', u, undefined, cookie === undefined ? {} : { cookie }); return x.status + (x.headers.location ? '->' + x.headers.location : ''); };
    out.tasks = { admin: await g('/api/v2/tasks'), anon: await g('/api/v2/tasks', false), display: await g('/api/v2/tasks', dc) };
    out.root = { admin: await g('/'), anon: await g('/', false), display: await g('/', dc) };
    out.panel = { admin: await g('/panel.html'), anon: await g('/panel.html', false), display: await g('/panel.html', dc) };
    out.workspace_for_display = await g('/workspace.html', dc);
    const t = (await S.call('GET', '/api/v2/tasks')).json; out.tasks_keys = Object.keys(t);
  } finally { await S.stop(); }
  // ceiling: unknown model of known platform vs unknown platform
  out.ceiling = { ds_unlisted: PR.resolve({ providerId: 'deepseek', modelId: 'deepseek-unlisted' }), qw_plus: PR.resolve({ providerId: 'dashscope', modelId: 'qwen3.8-plus' }), unknown_platform: PR.resolve({ providerId: 'moonshot', modelId: 'kimi' }), listed_max: PR.resolve({ providerId: 'dashscope', modelId: 'qwen3.8-max' }) };
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
