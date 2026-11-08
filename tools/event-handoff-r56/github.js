'use strict';
// R56 GitHub facts client: a FIXED set of read routes plus one report route, over an injected
// transport. The live transport is compiled OFF (like R46 LiveGitHubState / R51 ProtectedAppState):
// no token is read, no network is touched, env/config cannot open it. Tests use a local HTTP/SQLite
// GitHub emulator through the same routes.
const C = require('../auto-handoff-r46/contract');
const LIVE_TRANSPORT_ENABLED = false;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const BRANCH = /^(?:feat|fix|test|integrate)\/[A-Za-z0-9_./-]{1,100}$/;

class GitHubFacts {
  constructor(transport, { repo, timeoutMs = 5000, maxPages = 10 } = {}) {
    if (typeof transport !== 'function') fail('TRANSPORT_REQUIRED');
    if (repo !== C.REPO) fail('REPO_SCOPE');
    Object.assign(this, { transport, repo, timeoutMs, maxPages });
  }
  async call(method, route, body) {
    const p = '/repos/' + this.repo;
    const ok = method === 'GET' && (/^\/git\/ref\/heads\/[A-Za-z0-9_./-]{1,110}$/.test(route) || /^\/issues\/[1-9][0-9]{0,6}\/comments\?per_page=100&page=[1-9][0-9]?$/.test(route) || /^\/actions\/runs\?branch=[A-Za-z0-9_./%-]{1,160}&per_page=50$/.test(route) || /^\/actions\/runs\/[1-9][0-9]{0,15}\/jobs$/.test(route))
      || method === 'POST' && /^\/issues\/[1-9][0-9]{0,6}\/comments$/.test(route) && body && typeof body.body === 'string' && Object.keys(body).length === 1;
    if (!ok) fail('GITHUB_ROUTE_DENIED');
    let timer;
    try {
      const r = await Promise.race([Promise.resolve().then(() => this.transport(method, p + route, body)), new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('REMOTE_TIMEOUT'), { code: 'REMOTE_TIMEOUT' })), this.timeoutMs); })]);
      if (!r || ![200, 201].includes(r.status)) fail('GITHUB_STATUS_' + (r && r.status));
      return r.data;
    } finally { clearTimeout(timer); }
  }
  async comments(issue) {
    const all = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const list = await this.call('GET', '/issues/' + issue + '/comments?per_page=100&page=' + page);
      if (!Array.isArray(list)) fail('GITHUB_SHAPE');
      all.push(...list.map(c => ({ id: c.id, html_url: c.html_url, user: { login: c.user && c.user.login }, author_association: c.author_association, created_at: c.created_at, body: typeof c.body === 'string' ? c.body.slice(0, 20000) : '', pull_request: !!c.pull_request })));
      if (list.length < 100) return all;
    }
    fail('GITHUB_TOO_MANY_PAGES'); // incomplete is UNKNOWN, never "no comments"
  }
  // One complete, timestamped snapshot for one work item. Any failure -> throws -> UNKNOWN upstream.
  async snapshot(pipeline, item, now) {
    if (!BRANCH.test(item.branch)) fail('BRANCH_SCOPE');
    const ref = await this.call('GET', '/git/ref/heads/' + item.branch);
    const issues = {};
    for (const n of [...new Set([item.issue, pipeline.review_issues.audit, pipeline.review_issues.qa])]) issues[n] = { comments: await this.comments(n) };
    const runs = (await this.call('GET', '/actions/runs?branch=' + encodeURIComponent(item.branch) + '&per_page=50')).workflow_runs;
    if (!Array.isArray(runs)) fail('GITHUB_SHAPE');
    const out = [];
    for (const r of runs.slice(0, 50)) {
      const jobs = r.status === 'completed' && r.conclusion === 'success' ? (await this.call('GET', '/actions/runs/' + r.id + '/jobs')).jobs : [];
      out.push({ id: r.id, name: r.name, html_url: r.html_url, head_sha: r.head_sha, head_branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion,
        head_repository: { full_name: r.head_repository && r.head_repository.full_name, fork: !!(r.head_repository && r.head_repository.fork) }, jobs: (jobs || []).map(j => ({ name: j.name, conclusion: j.conclusion })) });
    }
    return { complete: true, checked_at: now, repository: { full_name: pipeline.repo, id: pipeline.repository_id }, refs: { [item.branch]: ref && ref.object && ref.object.sha || null }, issues, runs: out };
  }
  report(issue, body) { return this.call('POST', '/issues/' + issue + '/comments', { body: String(body).slice(0, 60000) }); }
}
function live() {
  // Compiled guard first: no credential context is touched while it is closed.
  if (!LIVE_TRANSPORT_ENABLED) fail('R56_LIVE_GITHUB_TRANSPORT_DISABLED');
  fail('BLOCKED_APP_IDENTITY');
}
module.exports = { GitHubFacts, live, LIVE_TRANSPORT_ENABLED };
