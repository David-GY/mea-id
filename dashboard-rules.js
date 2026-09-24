/*
 * SUS Dashboard business rules.
 *
 * This file intentionally contains no DOM or Apps Script code.  Keeping the
 * rules pure makes it possible to verify dashboard decisions with fixtures and
 * keeps future backend/client implementations aligned.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MEADashboardRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATES = Object.freeze({
    INVENTORY: 'INVENTORY',
    WITH_PROJECT: 'WITH_PROJECT',
    DEPLOYED: 'DEPLOYED',
    MISSING: 'MISSING',
    NEEDS_PRINTING: 'NEEDS_PRINTING',
    NOT_REQUIRED: 'NOT_REQUIRED',
    UNKNOWN: 'UNKNOWN'
  });

  const AVAILABLE_STATES = Object.freeze([
    STATES.INVENTORY,
    STATES.WITH_PROJECT
  ]);

  function truthy(value) {
    if (typeof value === 'boolean') return value;
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text) return null;
    if (['yes', 'y', 'true', '1', 'required', 'needed'].includes(text)) return true;
    if (['no', 'n', 'false', '0', 'not required', 'none'].includes(text)) return false;
    return null;
  }

  /**
   * A person needs deployment when an ID is required, they are not deployed,
   * and a usable ID is already in Inventory or With Project.
   */
  function needsDeployment(member) {
    return !!member && member.requiresId === true &&
      member.state !== STATES.DEPLOYED &&
      AVAILABLE_STATES.includes(member.state);
  }

  /**
   * Readiness is intentionally deployment-focused: a project is 100% ready
   * only when every assigned member who requires an ID is deployed.  Projects
   * with no required IDs are effectively complete at 100%.  Available but
   * undeployed IDs count toward "IDs ready" but not the percentage.
   */
  function calculateReadiness(project) {
    const required = Number(project && project.membersRequiringIds) || 0;
    const deployed = Number(project && project.idsDeployed) || 0;
    if (!required) return 100;
    return Math.max(0, Math.min(100, Math.round((deployed / required) * 100)));
  }

  function readinessStatus(project) {
    const readiness = calculateReadiness(project);
    const missing = Number(project && project.idsMissing) || 0;
    const blockers = Number(project && project.blockers) || 0;
    if (missing > 0 || blockers > 0) return 'red';
    if (readiness >= 100) return 'green';
    return 'yellow';
  }

  function recommendedAction(member) {
    if (!member) return 'Review record';
    if (member.dataIssues && member.dataIssues.length) return 'Resolve data issue';
    if (member.requiresId === false) return 'No ID required';
    switch (member.state) {
      case STATES.DEPLOYED: return 'No action — deployed';
      case STATES.INVENTORY: return 'Move to With Project';
      case STATES.WITH_PROJECT: return 'Move to Deployed';
      case STATES.NEEDS_PRINTING: return 'Print ID';
      case STATES.MISSING: return 'Investigate missing ID';
      default: return 'Review ID state';
    }
  }

  return {
    STATES,
    AVAILABLE_STATES,
    truthy,
    needsDeployment,
    calculateReadiness,
    readinessStatus,
    recommendedAction
  };
});
