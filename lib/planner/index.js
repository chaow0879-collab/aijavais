'use strict';
// C1: the single planner. The three former planners live here behind one entry:
//   rules.js     - deterministic rule wizard (also served to the browser at /project-intake/engine.js); always available, the fallback.
//   ai-draft.js  - one budgeted model call that drafts an editable team; an enhancement only (never executes, never bypasses budget).
//   universal.js - one-sentence universal workflow (R53) built on the same rules and the project engine.
// The server never requires public/: browser copies are served from here by exact path (server.js SHARED_ASSETS).
const Rules = require('./rules');
const catalog = require('./catalog.v1.json');
const { UniversalWorkflow, verifyAcceptance } = require('./universal');
const { IntakeDraftService } = require('./ai-draft');
const { ProjectError } = require('../project-store');
const SEC = require('../security');
const CAP = require('../capabilities');

function createPlanner({ store, engine, models, tools, skills, callModel, audit = () => {} }) {
  const Intake = Rules, intakeCatalog = catalog;
  const object = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectError('Expected a JSON object');
    return value;
  };
  function rulePlan(input) {
    object(input);
    for (const k of ['selectedRoleIds', 'selectedStepIds', 'customRoles']) {
      if (input[k] != null && (!Array.isArray(input[k]) || input[k].length > 40 || input[k].some(x => x == null))) throw new ProjectError('Invalid ' + k);
    }
    for (const k of ['answers', 'assignments', 'customDeliverables']) if (input[k] != null) object(input[k]);
    const trustedModels = models.list().map(c => {
      // #9 P2-01/04: verified labels come from the registry's CURRENT snapshot
      // (enabled + ready + successful AND recorded probe), never from lastTest.ok
      // alone. A successful chat probe proves connectivity, never coding, finance
      // or free eligibility.
      const snapshot = typeof models.getCapabilities === 'function' ? models.getCapabilities(c.connectionId) : null;
      const current = c.status === 'available' && c.enabled !== false && c.ready === true;
      const verifiedCapabilities = current ? (snapshot ? snapshot.verified.filter(x => x === 'chat') : ['chat']) : [];
      return { ...c, verifiedCapabilities,
        localityVerified: verifiedCapabilities.includes('chat') && c.pricingMode === 'local' && SEC.checkBaseUrlSyntax(c.baseUrl, models.policy).local === true,
        freeEligibilityVerified: false };
    });
    const registry = tools.list();
    const availableTools = registry.map(t => ({ id: t.toolId, available: true, verified: t.executionMode === 'builtin' }));
    // Template tool IDs (e.g. pdf_read) count as ready only when the capability center finds a real, usable implementation.
    const intakeIds = intakeCatalog.templates.flatMap(t => t.steps.flatMap(s => s.tools || []));
    for (const r of CAP.resolveIntakeTools(intakeIds, { tools: registry })) if (r.status === 'available' && r.toolId && !registry.some(t => t.toolId === r.intakeId)) availableTools.push({ id: r.intakeId, available: true, verified: registry.find(t => t.toolId === r.toolId)?.executionMode === 'builtin' });
    const result = Intake.buildPlan(intakeCatalog, { ...input, availableModels: trustedModels, availableTools });
    if (!result.ok) throw new ProjectError((result.errors || []).join('; '), 'invalid_plan');
    result.toolCheck = CAP.resolveIntakeTools(result.plan.requiredTools || [], { tools: registry });
    return result;
  }
  const drafts = new IntakeDraftService({ store, models, tools, skills, callModel, audit });
  const universal = new UniversalWorkflow({ store, engine, models, tools });
  return { rules: Rules, catalog, rulePlan, drafts, universal, async close() { await drafts.close(); } };
}

module.exports = { createPlanner, Rules, catalog, UniversalWorkflow, verifyAcceptance, IntakeDraftService };
