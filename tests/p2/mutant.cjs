// Disposable test worker only; never changes source files or production switches.
const Module = require('node:module'), fs = require('node:fs');
const original = Module._extensions['.js'];
const mutations = {
 approval: ['budget.js', 'approvePaid: input.approvePaid === true', 'approvePaid: true'],
 permission: ['project-engine.js', 'if (!approval.allowedTools.includes(toolId))', 'if (false)'],
 duplicate: ['project-store.js', 'rejectModelRequestDuplicate(previous, paramsHash) {', 'rejectModelRequestDuplicate(previous, paramsHash) { return;'],
 recovery: ['project-store.js', "const knownUnsent = request.state === 'claimed';", 'const knownUnsent = true;'],
 capacity: ['planner/ai-draft.js', "op.responded && op.underlying !== 'pending'", 'op.responded']
};
const [file, from, to] = mutations[process.env.P2_MUTANT];
Module._extensions['.js'] = (m, filename) => {
 if (filename.endsWith('/lib/' + file)) { const s = fs.readFileSync(filename,'utf8'); if (!s.includes(from)) throw Error('Mutation anchor missing'); m._compile(s.replace(from,to),filename); }
 else original(m,filename);
};
