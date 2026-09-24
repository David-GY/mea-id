/* Pure SUS Dashboard data model and exception detection. */
(function (root, factory) {
  const api = factory(root && root.MEADashboardRules);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MEADashboardModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (rules) {
  const R = rules || {
    STATES: {
      INVENTORY: 'INVENTORY', WITH_PROJECT: 'WITH_PROJECT', DEPLOYED: 'DEPLOYED',
      MISSING: 'MISSING', NEEDS_PRINTING: 'NEEDS_PRINTING', NOT_REQUIRED: 'NOT_REQUIRED', UNKNOWN: 'UNKNOWN'
    },
    truthy: value => !!value,
    needsDeployment: member => member && member.requiresId === true && member.state !== 'DEPLOYED' && ['INVENTORY', 'WITH_PROJECT'].includes(member.state),
    calculateReadiness: project => project.membersRequiringIds ? Math.round((project.idsDeployed / project.membersRequiringIds) * 100) : 100,
    readinessStatus: project => project.idsMissing || project.blockers ? 'red' : (project.readiness >= 100 ? 'green' : 'yellow'),
    recommendedAction: () => 'Review ID state'
  };

  const STATE_ALIASES = {
    inventory: R.STATES.INVENTORY,
    susinventory: R.STATES.INVENTORY,
    withproject: R.STATES.WITH_PROJECT,
    needsprinting: R.STATES.NEEDS_PRINTING,
    forprinting: R.STATES.NEEDS_PRINTING,
    notrequired: R.STATES.NOT_REQUIRED,
    'in inventory': R.STATES.INVENTORY,
    with_project: R.STATES.WITH_PROJECT,
    'with project': R.STATES.WITH_PROJECT,
    'w/proj': R.STATES.WITH_PROJECT,
    wproj: R.STATES.WITH_PROJECT,
    deployed: R.STATES.DEPLOYED,
    printing: R.STATES.NEEDS_PRINTING,
    'needs printing': R.STATES.NEEDS_PRINTING,
    missing: R.STATES.MISSING,
    'not required': R.STATES.NOT_REQUIRED,
    unknown: R.STATES.UNKNOWN
  };

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function key(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function bool(value) {
    return R.truthy(value);
  }

  function array(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(text).filter(Boolean);
    return text(value).split(/[;,|\n]/).map(s => s.trim()).filter(Boolean);
  }

  function canonicalState(value) {
    const normalized = key(value).replace(/_/g, ' ');
    return STATE_ALIASES[normalized] || STATE_ALIASES[text(value).toLowerCase()] || R.STATES.UNKNOWN;
  }

  function findValue(row, names) {
    const wanted = names.map(key);
    const actual = Object.keys(row || {});
    const match = actual.find(name => wanted.includes(key(name)));
    return match ? row[match] : '';
  }

  function normalizeTabRows(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source.map((row, index) => {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        return Object.assign({ rowNumber: index + 2 }, row);
      }
      return { idNumber: text(row), rowNumber: index + 2 };
    });
    if (source.rows && Array.isArray(source.rows)) return normalizeTabRows(source.rows);
    return [];
  }

  function normalizeRawTabs(response) {
    const source = response.rawTabs || response.tabs || {};
    return {
      main: normalizeTabRows(source.main || source.MAIN || response.main),
      inventory: normalizeTabRows(source.inventory || source.INVENTORY || response.inventory),
      withProject: normalizeTabRows(source.withProject || source['W/Proj'] || source['W/ proj'] || source.wproj || response.withProject),
      deployed: normalizeTabRows(source.deployed || source.DEPLOYED || response.deployed),
      printing: normalizeTabRows(source.printing || source.PRINTING || response.printing),
      access: normalizeTabRows(source.access || source.ACCESS || response.access),
      cbab: normalizeTabRows(source.cbab || source.CBAB || response.cbab)
    };
  }

  function rowId(row) {
    return text(row && (row.idNumber || row.id || row['ID Number'] || row.ID || findValue(row, ['id number', 'id', 'student id'])));
  }

  function rowName(row) {
    return text(row && (row.fullName || row.name || row['Full Name'] || row.Name || findValue(row, ['full name', 'name'])));
  }

  function rowProjects(row) {
    const direct = row && (row.projects || row.projectAssignments || row.project || row.Project);
    if (direct) return array(direct);
    return Object.keys(row || {}).filter(header => {
      const k = key(header);
      return !['idnumber', 'id', 'studentid', 'name', 'fullname', 'nickname', 'department', 'dept', 'requiresid', 'requiresanid', 'state', 'status', 'location', 'rownumber'].includes(k) && !k.includes('timestamp');
    }).filter(header => bool(row[header]) === true || text(row[header]) && !['0', 'false', 'no', 'n'].includes(text(row[header]).toLowerCase()))
      .map(text);
  }

  function stateFromSources(rawStates, explicitState, requiresId) {
    if (explicitState) return canonicalState(explicitState);
    const states = Array.isArray(rawStates) ? rawStates.map(canonicalState) : [];
    if (states.includes(R.STATES.DEPLOYED)) return R.STATES.DEPLOYED;
    if (states.includes(R.STATES.WITH_PROJECT)) return R.STATES.WITH_PROJECT;
    if (states.includes(R.STATES.INVENTORY)) return R.STATES.INVENTORY;
    if (states.includes(R.STATES.NEEDS_PRINTING)) return R.STATES.NEEDS_PRINTING;
    return requiresId === false ? R.STATES.NOT_REQUIRED : R.STATES.MISSING;
  }

  function normalizeMember(input, source) {
    const row = input || {};
    const idNumber = text(row.idNumber || row.id || findValue(row, ['ID Number', 'Student ID', 'ID']));
    const fullName = text(row.fullName || row.name || findValue(row, ['Full Name', 'Name']));
    const nickname = text(row.nickname || findValue(row, ['Nickname', 'Nick Name']));
    const department = text(row.department || row.dept || findValue(row, ['Department', 'Dept']));
    const location = text(row.location || row.idLocation || findValue(row, ['ID Location', 'Location']));
    const requiresRaw = row.requiresId !== undefined ? row.requiresId : findValue(row, ['Requires ID?', 'Requires ID', 'ID Required']);
    const requiresId = bool(requiresRaw);
    const projects = rowProjects(row);
    const sourceStates = array(row.sourceStates || row.states || source || []);
    const state = stateFromSources(sourceStates, row.state || row.status, requiresId);
    // MAIN contains membership metadata, not a mutually exclusive ID state.
    // Also discard these retired warnings from older backend/cache responses.
    const retiredIssues = new Set(['Requires ID? is unclear', 'Requires ID? conflict', 'Requires ID? and state conflict', 'Location/state conflict']);
    const warnings = array(row.warnings || row.dataQualityWarnings || row.issues).filter(issue => !retiredIssues.has(issue));
    const dataIssues = array(row.dataIssues || row.dataIssuesList).filter(issue => !retiredIssues.has(issue));
    if (!idNumber) dataIssues.push('Missing ID number');
    if (!fullName) dataIssues.push('Missing name');
    if (requiresId === true && !projects.length) dataIssues.push('No project assignment');
    if (state === R.STATES.UNKNOWN) dataIssues.push('Invalid or unrecognized state');
    const uniqueIssues = Array.from(new Set(dataIssues));
    return {
      idNumber,
      fullName,
      nickname,
      department,
      location,
      requiresId,
      projects,
      state,
      sourceStates: Array.from(new Set(sourceStates.map(canonicalState))),
      printName: text(row.printName || row.print || findValue(row, ['Print Name', 'Usable Print Name'])),
      warnings: Array.from(new Set(warnings)),
      dataIssues: uniqueIssues,
      tabRows: row.tabRows || {}
    };
  }

  function buildMembers(response, tabs) {
    const inputs = Array.isArray(response.members) ? response.members : (Array.isArray(response.records) ? response.records : []);
    if (inputs.length) return inputs.map(member => normalizeMember(member, member.sourceStates));

    const main = tabs.main;
    const byId = new Map();
    main.forEach(row => {
      const id = rowId(row);
      if (!id) return;
      const existing = byId.get(id) || {};
      byId.set(id, Object.assign({}, existing, row, { idNumber: id, fullName: rowName(row) || existing.fullName }));
    });
    ['inventory', 'withProject', 'deployed', 'printing'].forEach(tab => tabs[tab].forEach(row => {
      const id = rowId(row);
      if (!id) return;
      const member = byId.get(id) || { idNumber: id };
      member.sourceStates = (member.sourceStates || []).concat(tab === 'withProject' ? 'WITH_PROJECT' : tab.toUpperCase());
      if (!member.fullName) member.fullName = rowName(row);
      member.tabRows = Object.assign({}, member.tabRows, { [tab]: row.rowNumber });
      byId.set(id, member);
    }));
    tabs.cbab.forEach(row => {
      const id = rowId(row);
      if (!id) return;
      const member = byId.get(id) || { idNumber: id };
      member.projects = Array.from(new Set([...(member.projects || []), 'CBAB']));
      if (!member.fullName) member.fullName = rowName(row);
      member.tabRows = Object.assign({}, member.tabRows, { cbab: row.rowNumber });
      byId.set(id, member);
    });
    return Array.from(byId.values()).map(row => normalizeMember(row, row.sourceStates));
  }

  function normalizeResponse(response) {
    const safe = response && typeof response === 'object' ? response : {};
    const tabs = normalizeRawTabs(safe);
    const members = buildMembers(safe, tabs);
    const projects = Array.from(new Set(members.flatMap(member => member.projects))).sort((a, b) => a.localeCompare(b));
    return {
      ok: safe.ok !== false,
      revision: safe.revision || safe.cursor || null,
      generatedAt: safe.generatedAt || safe.serverTimestamp || null,
      members,
      projects,
      rawTabs: tabs,
      metadata: safe.metadata || {}
    };
  }

  function totals(members) {
    const list = Array.isArray(members) ? members : [];
    return {
      totalRegistered: list.length,
      inventory: list.filter(m => m.state === R.STATES.INVENTORY).length,
      withProject: list.filter(m => m.state === R.STATES.WITH_PROJECT).length,
      deployed: list.filter(m => m.state === R.STATES.DEPLOYED).length,
      needsPrinting: list.filter(m => m.state === R.STATES.NEEDS_PRINTING).length,
      requiredMissing: list.filter(m => m.requiresId === true && [R.STATES.MISSING, R.STATES.NEEDS_PRINTING, R.STATES.UNKNOWN].includes(m.state)).length,
      dataIssues: list.filter(m => (m.dataIssues || []).length || (m.warnings || []).length).length
    };
  }

  function projectReadiness(members, projectName) {
    const assigned = members.filter(member => member.projects.includes(projectName));
    const required = assigned.filter(member => member.requiresId === true);
    const result = {
      project: projectName,
      totalAssigned: assigned.length,
      membersRequiringIds: required.length,
      idsReady: required.filter(member => [R.STATES.INVENTORY, R.STATES.WITH_PROJECT, R.STATES.DEPLOYED].includes(member.state)).length,
      idsDeployed: required.filter(member => member.state === R.STATES.DEPLOYED).length,
      idsMissing: required.filter(member => [R.STATES.MISSING, R.STATES.NEEDS_PRINTING, R.STATES.UNKNOWN].includes(member.state)).length,
      blockers: assigned.filter(member => (member.dataIssues || []).length || (member.warnings || []).length).length
    };
    result.readiness = R.calculateReadiness(result);
    result.status = R.readinessStatus(result);
    return result;
  }

  function readinessMatrix(members, projects) {
    const names = projects || Array.from(new Set(members.flatMap(member => member.projects)));
    return names.sort((a, b) => a.localeCompare(b)).map(name => projectReadiness(members, name));
  }

  function exception(severity, type, member, explanation, resolution, extra) {
    return Object.assign({
      id: (extra && extra.id) || `${type}:${member && member.idNumber || 'unknown'}:${Math.random().toString(36).slice(2, 8)}`,
      severity,
      type,
      affectedId: member && member.idNumber || (extra && extra.affectedId) || '',
      person: member && member.fullName || '',
      explanation,
      resolution,
      memberId: member && member.idNumber || ''
    }, extra || {});
  }

  function detectExceptions(model) {
    const members = model.members || [];
    const tabs = model.rawTabs || {};
    const out = [];
    const mainById = new Map();
    (tabs.main || []).forEach(row => {
      const id = rowId(row);
      if (id) mainById.set(id, (mainById.get(id) || []).concat(row));
      else out.push(exception('high', 'Missing ID number', null, `MAIN row ${row.rowNumber || '?'} has no ID number.`, 'Complete the ID number or remove the incomplete row.', { rowNumber: row.rowNumber }));
      if (id && !rowName(row)) out.push(exception('high', 'Missing name', { idNumber: id }, `MAIN row ${row.rowNumber || '?'} has no usable name.`, 'Complete the member name in MAIN.', { rowNumber: row.rowNumber }));
    });
    mainById.forEach((rows, id) => {
      if (rows.length > 1) out.push(exception('high', 'Duplicate ID number', { idNumber: id, fullName: rowName(rows[0]) }, `${id} appears ${rows.length} times in MAIN.`, 'Keep one canonical MAIN row and resolve the duplicate before moving the ID.', { rowNumber: rows.map(r => r.rowNumber) }));
    });

    const stateTabNames = ['inventory', 'withProject', 'deployed', 'printing'];
    const stateIds = new Map();
    stateTabNames.forEach(tab => {
      const seen = new Map();
      (tabs[tab] || []).forEach(row => {
        const id = rowId(row);
        if (!id) {
          out.push(exception('high', 'Missing ID number', null, `${tab} row ${row.rowNumber || '?'} has no ID number.`, 'Complete or remove the incomplete state-tab row.', { tab, rowNumber: row.rowNumber }));
          return;
        }
        seen.set(id, (seen.get(id) || []).concat(row));
        stateIds.set(id, (stateIds.get(id) || []).concat(tab));
        if (!mainById.has(id)) out.push(exception('high', 'State ID absent from MAIN', { idNumber: id, fullName: rowName(row) }, `${id} exists in ${tab} but not in MAIN.`, 'Add the member to MAIN or remove the orphaned state row.', { tab, rowNumber: row.rowNumber }));
        if (!rowName(row)) out.push(exception('medium', 'Missing name', { idNumber: id }, `${id} in ${tab} has no usable name.`, 'Complete the name in the state tab or canonical MAIN record.', { tab, rowNumber: row.rowNumber }));
        if (tab === 'printing' && !text(row.printName || rowName(row))) out.push(exception('medium', 'Printing record missing usable print name', { idNumber: id, fullName: rowName(row) }, `${id} is queued for printing without a usable print name.`, 'Set Print Name in PRINTING or complete the member name in MAIN.', { tab, rowNumber: row.rowNumber }));
      });
      seen.forEach((rows, id) => {
        if (rows.length > 1) out.push(exception('high', 'Duplicate entries in state tab', { idNumber: id, fullName: rowName(rows[0]) }, `${id} appears ${rows.length} times in ${tab}.`, 'Keep one state row and remove the duplicate after confirming the correct record.', { tab, rowNumber: rows.map(r => r.rowNumber) }));
      });
    });
    stateIds.forEach((tabsForId, id) => {
      const unique = Array.from(new Set(tabsForId));
      if (unique.length > 1) out.push(exception('high', 'ID appears in multiple state tabs', { idNumber: id }, `${id} appears in ${unique.join(', ')}.`, 'Choose the authoritative state and remove the conflicting rows.', { tabs: unique }));
    });

    members.forEach(member => {
      if (member.requiresId === true && !member.projects.length) out.push(exception('medium', 'Missing project assignment', member, 'This member requires an ID but has no project assignment.', 'Add the relevant project column value in MAIN.', { projectRequired: true }));
      if (member.state === R.STATES.UNKNOWN) out.push(exception('high', 'Invalid or unrecognized state data', member, 'The current state could not be mapped to a supported state.', 'Correct the state value or move the row into a supported state tab.', {}));
    });

    return out.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - ({ high: 0, medium: 1, low: 2 }[b.severity]) || a.type.localeCompare(b.type) || a.affectedId.localeCompare(b.affectedId)));
  }

  function mergeActivity(existing, incoming) {
    const map = new Map((existing || []).map(event => [String(event.eventId || event.id), event]));
    (incoming || []).forEach(event => {
      const id = String(event.eventId || event.id || '');
      if (id) map.set(id, Object.assign({}, map.get(id) || {}, event, { eventId: id }));
    });
    return Array.from(map.values()).sort((a, b) => {
      const at = Date.parse(a.serverTimestamp || a.timestamp || '') || 0;
      const bt = Date.parse(b.serverTimestamp || b.timestamp || '') || 0;
      return bt - at || String(b.eventId).localeCompare(String(a.eventId));
    });
  }

  return {
    canonicalState,
    normalizeResponse,
    normalizeMember,
    totals,
    projectReadiness,
    readinessMatrix,
    detectExceptions,
    mergeActivity,
    rowId,
    rowName
  };
});
