'use strict';
// Local GitHub REST emulator for R56 E3 (separate process, 127.0.0.1, node:sqlite). Serves ONLY the
// routes tools/event-handoff-r56/github.js may call, plus /fixture/* seeding. Never reaches github.com.
const http = require('node:http');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const REPO = 'chaow0879-collab/aijavais';
const file = process.argv[2];
const db = new DatabaseSync(file);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, issue INTEGER, html_url TEXT, login TEXT, assoc TEXT, created_at TEXT, body TEXT, pr INTEGER);
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, doc TEXT);
CREATE TABLE IF NOT EXISTS refs(branch TEXT PRIMARY KEY, sha TEXT);
CREATE TABLE IF NOT EXISTS stats(k TEXT PRIMARY KEY, v INTEGER);`);
let fault = null, nextId = 900000;
const bump = k => db.prepare('INSERT INTO stats VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1').run(k);
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const P = '/repos/' + REPO;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => { raw += b; if (raw.length > 1 << 20) req.destroy(); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    let body = null; if (raw) { try { body = JSON.parse(raw); } catch { return send(res, 400, {}); } }
    if (p === '/fixture/fault') { fault = body.mode || null; return send(res, 200, {}); }
    if (p === '/fixture/stats') return send(res, 200, Object.fromEntries(db.prepare('SELECT k,v FROM stats').all().map(r => [r.k, Number(r.v)])));
    if (p === '/fixture/comment') { const id = body.id || nextId++; db.prepare('INSERT INTO comments VALUES(?,?,?,?,?,?,?,?)').run(id, body.issue, body.html_url || `https://github.com/${REPO}/issues/${body.issue}#issuecomment-${id}`, body.login, body.association || 'COLLABORATOR', body.created_at || new Date().toISOString(), body.body, body.pull_request ? 1 : 0); return send(res, 201, { id }); }
    if (p === '/fixture/run') { db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(body.id, JSON.stringify(body)); return send(res, 201, {}); }
    if (p === '/fixture/ref') { db.prepare('INSERT OR REPLACE INTO refs VALUES(?,?)').run(body.branch, body.sha); return send(res, 201, {}); }
    if (!p.startsWith(P)) return send(res, 404, {});
    if (fault === 'timeout') return; // never answers
    if (fault && /^\d{3}$/.test(fault)) { bump('fault_' + fault); return send(res, Number(fault), { message: 'fixture fault' }); }
    const r = p.slice(P.length);
    let m;
    if (req.method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(r))) { bump('read_ref'); const row = db.prepare('SELECT sha FROM refs WHERE branch=?').get(decodeURIComponent(m[1])); return row ? send(res, 200, { object: { sha: row.sha } }) : send(res, 404, {}); }
    if (req.method === 'GET' && (m = /^\/issues\/(\d+)\/comments$/.exec(r))) {
      bump('read_comments'); const page = Number(url.searchParams.get('page')) || 1;
      const rows = db.prepare('SELECT * FROM comments WHERE issue=? ORDER BY created_at, id LIMIT 100 OFFSET ?').all(Number(m[1]), (page - 1) * 100);
      return send(res, 200, rows.map(c => ({ id: Number(c.id), html_url: c.html_url, user: { login: c.login }, author_association: c.assoc, created_at: c.created_at, body: c.body, ...(c.pr ? { pull_request: { url: 'x' } } : {}) })));
    }
    if (req.method === 'GET' && r === '/actions/runs') { bump('read_runs'); const b = url.searchParams.get('branch'); const wr = db.prepare('SELECT doc FROM runs').all().map(x => JSON.parse(x.doc)).filter(x => x.head_branch === b).map(({ jobs, ...x }) => x); return send(res, 200, { total_count: wr.length, workflow_runs: wr }); }
    if (req.method === 'GET' && (m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(r))) { const row = db.prepare('SELECT doc FROM runs WHERE id=?').get(Number(m[1])); return row ? (j => send(res, 200, { total_count: j.length, jobs: j }))(JSON.parse(row.doc).jobs || []) : send(res, 404, {}); }
    if (req.method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(r))) {
      bump('post_report'); const id = nextId++;
      db.prepare('INSERT INTO comments VALUES(?,?,?,?,?,?,?,?)').run(id, Number(m[1]), `https://github.com/${REPO}/issues/${m[1]}#issuecomment-${id}`, 'r56-bridge', 'COLLABORATOR', new Date().toISOString(), body.body, 0);
      return send(res, 201, { id, html_url: `https://github.com/${REPO}/issues/${m[1]}#issuecomment-${id}` });
    }
    send(res, 404, {});
  });
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => { db.close(); process.exit(0); }); });
void fs;
