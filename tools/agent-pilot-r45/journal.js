'use strict';
// One-shot local journal inside a private state directory. It guarantees, for ONE runner
// host, that a dedupe key is started at most once: CLAIMED -> RUNNING -> terminal, never
// back. Cross-runner exclusivity (remote claim/CAS) is the control plane's job (Codex R46);
// this journal is the last local line of defence, not a distributed lock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function privateDir(dir) {
  const root = path.resolve(dir);
  const base = [os.tmpdir(), process.env.RUNNER_TEMP].filter(Boolean).map(d => path.resolve(d) + path.sep);
  if (!base.some(b => root.startsWith(b))) throw Error('STATE_DIR_MUST_BE_TEMP');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) throw Error('UNSAFE_STATE_DIR');
  return root;
}
// A zombie (killed but not yet reaped, common in containers without an init) is not running.
function isAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').pop()[0] !== 'Z'; } catch { return true; }
}
const writeAtomic = (file, data) => { const tmp = file + '.' + crypto.randomUUID(); fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw Error('CORRUPT_JOURNAL'); } };

class Journal {
  constructor(dir) { this.dir = privateDir(dir); }
  file(kind, key) { if (!/^[a-f0-9]{64}$/.test(key) && kind !== 'dispatch') throw Error('BAD_KEY'); return path.join(this.dir, kind + '-' + key + '.json'); }
  // A dispatch id may only ever describe one piece of work.
  bindDispatch(dispatchId, dedupe) {
    const f = path.join(this.dir, 'dispatch-' + crypto.createHash('sha256').update(dispatchId).digest('hex') + '.json');
    try { fs.writeFileSync(f, JSON.stringify({ dispatch_id: dispatchId, dedupe_key: dedupe }), { mode: 0o600, flag: 'wx' }); return null; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const prev = readJson(f);
    return prev && prev.dedupe_key === dedupe ? null : 'DISPATCH_ID_CONFLICT';
  }
  // Exclusive create: exactly one caller wins. Losers learn whether the work finished.
  claim(key, runId) {
    try {
      fs.writeFileSync(this.file('claim', key), JSON.stringify({ run_id: runId, pid: process.pid, claimed_at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      this.transition(key, 'CLAIMED');
      return { won: true };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const outcome = readJson(this.file('outcome', key));
    if (outcome) return { won: false, state: 'DUPLICATE', previous: outcome };
    const st = readJson(this.file('state', key)), claim = readJson(this.file('claim', key));
    // Claimed but unfinished: still running in a live process on this host, or a crash/restart
    // left it behind. Either way it is never relaunched automatically.
    const alive = claim && Number.isSafeInteger(claim.pid) && claim.pid !== process.pid && isAlive(claim.pid);
    return { won: false, state: alive ? 'IN_PROGRESS' : 'HUMAN_REVIEW_REQUIRED', previous: st };
  }
  transition(key, state) {
    const order = ['CLAIMED', 'RUNNING', 'TERMINAL'];
    const prev = readJson(this.file('state', key));
    const next = state === 'CLAIMED' || state === 'RUNNING' ? state : 'TERMINAL';
    if (prev && order.indexOf(next) <= order.indexOf(prev.state)) throw Error('ILLEGAL_TRANSITION');
    writeAtomic(this.file('state', key), JSON.stringify({ state: next, detail: state, at: new Date().toISOString() }));
  }
  settle(key, outcome) {
    this.transition(key, outcome.state);
    try { fs.writeFileSync(this.file('outcome', key), JSON.stringify(outcome), { mode: 0o600, flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') throw Error('ALREADY_SETTLED'); throw e; }
  }
  audit(entry) { fs.appendFileSync(path.join(this.dir, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 }); }
  saveLog(runId, text) {
    const name = 'log-' + runId.replace(/[^A-Za-z0-9-]/g, '') + '.txt';
    fs.writeFileSync(path.join(this.dir, name), text, { mode: 0o600, flag: 'wx' });
    return { log_file: name, log_sha256: crypto.createHash('sha256').update(text).digest('hex') };
  }
}
module.exports = { Journal, privateDir, isAlive };
