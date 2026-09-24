/*
 * SUS Dashboard Apps Script reference implementation
 *
 * Paste this file into the Apps Script project attached to the [SUS] MEA ID
 * tracker spreadsheet. It deliberately contains no deployed URL or token.
 * Keep the existing inventory/order script separate.
 *
 * Supported actions:
 *   login, access, meansList       legacy read compatibility
 *   dashboardData                  normalized MAIN + state-tab snapshot
 *   activity                       incremental ACTIVITY_LOG read
 *   batchMove                      locked, all-or-nothing batch state change
 *   tracker                        legacy single-ID bridge to batchMove
 */

var SUS_DASHBOARD = {
  MAIN: 'MAIN',
  INVENTORY: 'INVENTORY',
  WITH_PROJECT: 'W/Proj',
  DEPLOYED: 'DEPLOYED',
  PRINTING: 'PRINTING',
  ACCESS: 'ACCESS',
  ACTIVITY: 'ACTIVITY_LOG',
  IDEMPOTENCY: 'IDEMPOTENCY_LOG',
  REVISION_PROPERTY: 'TRACKER_REVISION',
  ACTIVITY_HEADERS: [
    'Event ID', 'Server timestamp', 'Actor ID', 'Actor name',
    'Action type', 'Target ID', 'Target name', 'Project',
    'Previous state', 'New state', 'Batch ID', 'Device/client ID',
    'Result', 'Details'
  ],
  IDEMPOTENCY_HEADERS: [
    'Idempotency key', 'Batch ID', 'Actor ID', 'Request hash',
    'Server timestamp', 'Response JSON'
  ]
};

function doGet(e) {
  return route_(e, null);
}

function doPost(e) {
  return route_(e, parseBody_(e));
}

function route_(e, body) {
  var p = Object.assign({}, (e && e.parameter) || {}, body || {});
  var action = String(p.action || '').trim();
  try {
    switch (action) {
      case 'login': return login_(p);
      case 'access': return access_(p);
      case 'meansList': return meansList_();
      case 'dashboardData': requireLevel_(p, ['ADMIN', 'DASHBOARD']); return dashboardData_();
      case 'activity': requireLevel_(p, ['ADMIN', 'DASHBOARD']); return activity_(p);
      case 'batchMove': requireLevel_(p, ['ADMIN']); return batchMove_(p, true);
      case 'tracker': requireLevel_(p, ['ADMIN', 'TRACKER']); return legacyTracker_(p);
      default: return respond_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return respond_({ ok: false, error: String(err && err.message || err) });
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try { return JSON.parse(e.postData.contents); } catch (err) { return {}; }
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function requiredToken_(p) {
  var configured = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN');
  if (configured && String(p.token || '') !== configured) throw new Error('Unauthorized');
}

function requireLevel_(p, levels) {
  requiredToken_(p);
  var actorId = normalizeId_(p.actorId);
  if (!actorId) throw new Error('Missing actor ID');
  var access = accessRecord_(actorId);
  var level = String(access && access.level || '').trim().toUpperCase();
  if (levels.indexOf(level) === -1) throw new Error('Insufficient permission');
}

function activeSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name, required) {
  var sheet = activeSpreadsheet_().getSheetByName(name);
  if (!sheet && required !== false) throw new Error('Required sheet not found: ' + name);
  return sheet;
}

function displayTable_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return { headers: [], rows: [] };
  var values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return { headers: [], rows: [] };
  var headers = values[0].map(function (value, index) { return String(value || '').trim() || ('Column ' + (index + 1)); });
  var rows = values.slice(1).map(function (row, offset) {
    var object = { rowNumber: offset + 2 };
    headers.forEach(function (header, index) { object[header] = row[index] == null ? '' : row[index]; });
    return object;
  });
  return { headers: headers, rows: rows };
}

function normalizeHeader_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function columnIndex_(headers, candidates, fallback) {
  var wanted = candidates.map(normalizeHeader_);
  for (var i = 0; i < headers.length; i++) {
    if (wanted.indexOf(normalizeHeader_(headers[i])) !== -1) return i;
  }
  return fallback == null ? -1 : fallback;
}

function objectValue_(row, headers, candidates) {
  var index = columnIndex_(headers, candidates, -1);
  return index < 0 ? '' : row[headers[index]];
}

function normalizeId_(value) {
  return String(value == null ? '' : value).trim();
}

function parseBool_(value) {
  var text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return null;
  if (['yes', 'y', 'true', '1', 'required', 'needed'].indexOf(text) !== -1) return true;
  if (['no', 'n', 'false', '0', 'not required', 'none'].indexOf(text) !== -1) return false;
  return null;
}

function unique_(items) {
  var out = [];
  (items || []).forEach(function (item) { if (item && out.indexOf(item) === -1) out.push(item); });
  return out;
}

function rowId_(row, headers) {
  return normalizeId_(objectValue_(row, headers, ['ID Number', 'Student ID', 'ID']));
}

function rowName_(row, headers) {
  return normalizeId_(objectValue_(row, headers, ['Full Name', 'Name']));
}

function accessRecord_(id) {
  var sheet = sheet_(SUS_DASHBOARD.ACCESS, false);
  var table = displayTable_(sheet);
  var idIndex = columnIndex_(table.headers, ['ID Number', 'ID', 'Student ID'], 0);
  var levelIndex = columnIndex_(table.headers, ['Level', 'Access Level', 'Role'], 2);
  var nameIndex = columnIndex_(table.headers, ['Name', 'Full Name'], 1);
  for (var i = 0; i < table.rows.length; i++) {
    var row = table.rows[i];
    if (normalizeId_(row[table.headers[idIndex]]) === id) return {
      id: id,
      name: normalizeId_(row[table.headers[nameIndex]]),
      level: normalizeId_(row[table.headers[levelIndex]])
    };
  }
  return null;
}

function login_(p) {
  requiredToken_(p);
  var id = normalizeId_(p.id);
  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN));
  var idIndex = columnIndex_(main.headers, ['ID Number', 'Student ID', 'ID'], 0);
  var nameIndex = columnIndex_(main.headers, ['Full Name', 'Name'], 1);
  for (var i = 0; i < main.rows.length; i++) {
    var row = main.rows[i];
    if (normalizeId_(row[main.headers[idIndex]]) === id) {
      var access = accessRecord_(id);
      return respond_({ ok: true, found: true, idNumber: id, name: normalizeId_(row[main.headers[nameIndex]]), level: access ? access.level : 'NONE' });
    }
  }
  return respond_({ ok: true, found: false, idNumber: id, name: '', level: 'NONE' });
}

function access_(p) {
  requiredToken_(p);
  var id = normalizeId_(p.id);
  var access = accessRecord_(id);
  return respond_({ ok: true, allowed: !!access, idNumber: id, name: access ? access.name : '', level: access ? access.level : 'NONE' });
}

function meansList_() {
  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN));
  return respond_({ ok: true, members: main.rows.map(function (row) {
    return { id: rowId_(row, main.headers), name: rowName_(row, main.headers) };
  }).filter(function (member) { return member.id; }) });
}

function stateName_(tab) {
  if (tab === SUS_DASHBOARD.WITH_PROJECT) return 'WITH_PROJECT';
  return tab.toUpperCase();
}

function buildStateRows_() {
  var names = [SUS_DASHBOARD.INVENTORY, SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED, SUS_DASHBOARD.PRINTING];
  var result = {};
  names.forEach(function (name) {
    var table = displayTable_(sheet_(name, false));
    result[name] = { table: table, rows: table.rows.map(function (row) {
      return {
        idNumber: rowId_(row, table.headers),
        fullName: rowName_(row, table.headers),
        printName: normalizeId_(objectValue_(row, table.headers, ['Print Name', 'Usable Print Name'])),
        rowNumber: row.rowNumber
      };
    }) };
  });
  return result;
}

function mainRecord_(row, headers) {
  var idNumber = rowId_(row, headers);
  var fullName = rowName_(row, headers);
  var nickname = normalizeId_(objectValue_(row, headers, ['Nickname', 'Nick Name']));
  var department = normalizeId_(objectValue_(row, headers, ['Department', 'Dept']));
  var location = normalizeId_(objectValue_(row, headers, ['ID Location', 'Location']));
  var requiresId = parseBool_(objectValue_(row, headers, ['Requires ID?', 'Requires ID', 'ID Required']));
  var known = ['ID Number', 'Student ID', 'ID', 'Full Name', 'Name', 'Nickname', 'Nick Name', 'Department', 'Dept', 'ID Location', 'Location', 'Requires ID?', 'Requires ID', 'ID Required'];
  var projects = headers.filter(function (header) {
    return known.map(normalizeHeader_).indexOf(normalizeHeader_(header)) === -1 && normalizeHeader_(header).indexOf('timestamp') === -1;
  }).filter(function (header) {
    var value = String(row[header] == null ? '' : row[header]).trim().toLowerCase();
    return value && ['0', 'false', 'no', 'n'].indexOf(value) === -1;
  });
  return { idNumber: idNumber, fullName: fullName, nickname: nickname, department: department, location: location, requiresId: requiresId, projects: projects, rowNumber: row.rowNumber };
}

function dashboardData_() {
  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN));
  var states = buildStateRows_();
  var byId = {};
  main.rows.forEach(function (row) {
    var member = mainRecord_(row, main.headers);
    if (!member.idNumber) return;
    if (!byId[member.idNumber]) byId[member.idNumber] = member;
    else byId[member.idNumber].dataIssues = (byId[member.idNumber].dataIssues || []).concat('Duplicate ID number in MAIN');
  });

  Object.keys(states).forEach(function (tab) {
    states[tab].rows.forEach(function (row) {
      if (!row.idNumber) return;
      if (!byId[row.idNumber]) byId[row.idNumber] = { idNumber: row.idNumber, fullName: row.fullName, projects: [], requiresId: null, dataIssues: ['State-tab ID absent from MAIN'] };
      var member = byId[row.idNumber];
      member.sourceStates = (member.sourceStates || []).concat(stateName_(tab));
      member.tabRows = member.tabRows || {};
      member.tabRows[tab] = (member.tabRows[tab] || []).concat(row.rowNumber);
      if (!member.fullName && row.fullName) member.fullName = row.fullName;
      if (tab === SUS_DASHBOARD.PRINTING && row.printName) member.printName = row.printName;
    });
  });

  var members = Object.keys(byId).map(function (id) {
    var member = byId[id];
    member.sourceStates = unique_(member.sourceStates || []);
    member.dataIssues = unique_(member.dataIssues || []);
    if (!member.idNumber) member.dataIssues.push('Missing ID number');
    if (!member.fullName) member.dataIssues.push('Missing name');
    if (member.requiresId === null) member.dataIssues.push('Requires ID? is unclear');
    if (member.requiresId === true && !(member.projects || []).length) member.dataIssues.push('No project assignment');
    var state = 'MISSING';
    if (member.requiresId === false) state = 'NOT_REQUIRED';
    if (member.sourceStates.indexOf('INVENTORY') !== -1) state = 'INVENTORY';
    if (member.sourceStates.indexOf('WITH_PROJECT') !== -1) state = 'WITH_PROJECT';
    if (member.sourceStates.indexOf('DEPLOYED') !== -1) state = 'DEPLOYED';
    if (member.sourceStates.indexOf('PRINTING') !== -1) state = 'NEEDS_PRINTING';
    member.state = state;
    return member;
  });

  var rawTabs = {};
  rawTabs.main = main.rows.map(function (row) { return Object.assign({}, row, { idNumber: rowId_(row, main.headers), fullName: rowName_(row, main.headers) }); });
  rawTabs.inventory = states[SUS_DASHBOARD.INVENTORY].rows;
  rawTabs.withProject = states[SUS_DASHBOARD.WITH_PROJECT].rows;
  rawTabs.deployed = states[SUS_DASHBOARD.DEPLOYED].rows;
  rawTabs.printing = states[SUS_DASHBOARD.PRINTING].rows;
  return respond_({ ok: true, revision: revision_(), generatedAt: new Date().toISOString(), members: members, rawTabs: rawTabs });
}

function revision_() {
  return PropertiesService.getScriptProperties().getProperty(SUS_DASHBOARD.REVISION_PROPERTY) || '0';
}

function incrementRevision_() {
  var props = PropertiesService.getScriptProperties();
  var next = Number(props.getProperty(SUS_DASHBOARD.REVISION_PROPERTY) || 0) + 1;
  props.setProperty(SUS_DASHBOARD.REVISION_PROPERTY, String(next));
  return String(next);
}

function activitySheet_() {
  var sheet = sheet_(SUS_DASHBOARD.ACTIVITY, false);
  if (!sheet) throw new Error('ACTIVITY_LOG sheet is not configured');
  return sheet;
}

function activityEvents_() {
  var table = displayTable_(activitySheet_());
  return table.rows.map(function (row) {
    var event = {};
    SUS_DASHBOARD.ACTIVITY_HEADERS.forEach(function (header) {
      var value = row[header] == null ? '' : row[header];
      var field = header.toLowerCase().replace(/[^a-z0-9]+(.)/g, function (_, c) { return c.toUpperCase(); });
      event[field] = value;
    });
    event.eventId = String(event.eventId || '').trim();
    event.serverTimestamp = event.serverTimestamp || '';
    return event;
  }).filter(function (event) { return event.eventId; });
}

function activity_(p) {
  var events = activityEvents_();
  var cursor = String(p.cursor || '').trim();
  var start = 0;
  if (cursor) {
    var index = events.map(function (event) { return event.eventId; }).indexOf(cursor);
    if (index >= 0) start = index + 1;
    else {
      var cursorTime = Date.parse(cursor);
      if (!isNaN(cursorTime)) events = events.filter(function (event) { return Date.parse(event.serverTimestamp) > cursorTime; });
    }
  }
  var batch = events.slice(start, start + 250);
  return respond_({ ok: true, revision: revision_(), events: batch, nextCursor: batch.length ? batch[batch.length - 1].eventId : cursor });
}

function eventId_() {
  return Utilities.getUuid();
}

function batchId_(p) { return String(p.batchId || Utilities.getUuid()).trim(); }

function idList_(value) {
  if (Array.isArray(value)) return value.map(normalizeId_).filter(Boolean);
  try { return JSON.parse(String(value || '[]')).map(normalizeId_).filter(Boolean); } catch (err) { return String(value || '').split(',').map(normalizeId_).filter(Boolean); }
}

function requestHash_(p) {
  var raw = JSON.stringify({ actorId: normalizeId_(p.actorId), project: normalizeId_(p.project), destination: normalizeId_(p.destination), ids: idList_(p.ids) });
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function idempotencySheet_() {
  var ss = activeSpreadsheet_();
  var sheet = ss.getSheetByName(SUS_DASHBOARD.IDEMPOTENCY);
  if (!sheet) {
    sheet = ss.insertSheet(SUS_DASHBOARD.IDEMPOTENCY);
    sheet.getRange(1, 1, 1, SUS_DASHBOARD.IDEMPOTENCY_HEADERS.length).setValues([SUS_DASHBOARD.IDEMPOTENCY_HEADERS]);
  } else if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, SUS_DASHBOARD.IDEMPOTENCY_HEADERS.length).setValues([SUS_DASHBOARD.IDEMPOTENCY_HEADERS]);
  }
  return sheet;
}

function priorIdempotentResponse_(key, hash) {
  if (!key) return null;
  var table = displayTable_(idempotencySheet_());
  var keyIndex = columnIndex_(table.headers, ['Idempotency key'], 0);
  var hashIndex = columnIndex_(table.headers, ['Request hash'], 3);
  var responseIndex = columnIndex_(table.headers, ['Response JSON'], 5);
  for (var i = 0; i < table.rows.length; i++) {
    var row = table.rows[i];
    if (String(row[table.headers[keyIndex]] || '') === key) {
      if (String(row[table.headers[hashIndex]] || '') !== hash) throw new Error('Idempotency key was reused with a different request');
      try { return JSON.parse(String(row[table.headers[responseIndex]] || '')); } catch (err) { throw new Error('Stored idempotency response is invalid'); }
    }
  }
  return null;
}

function rememberIdempotentResponse_(p, hash, response) {
  var sheet = idempotencySheet_();
  sheet.appendRow([String(p.idempotencyKey || p.batchId || ''), batchId_(p), normalizeId_(p.actorId), hash, new Date(), JSON.stringify(response)]);
}

function trackedColumn_(sheet) {
  var headers = displayTable_(sheet).headers;
  return columnIndex_(headers, ['ID Number', 'Student ID', 'ID'], 0) + 1;
}

function removeIdRows_(sheet, id) {
  if (!sheet || sheet.getLastRow() < 2) return;
  var col = trackedColumn_(sheet);
  var values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (normalizeId_(values[i][0]) === id) sheet.deleteRow(i + 2);
  }
}

function appendStateRow_(sheet, id, member, project) {
  var table = displayTable_(sheet);
  var values = new Array(Math.max(1, sheet.getLastColumn(), table.headers.length)).fill('');
  var idIndex = columnIndex_(table.headers, ['ID Number', 'Student ID', 'ID'], 0);
  var nameIndex = columnIndex_(table.headers, ['Name', 'Full Name'], -1);
  var projectIndex = columnIndex_(table.headers, ['Project', 'Project Assignment'], -1);
  values[idIndex] = id;
  if (nameIndex >= 0) values[nameIndex] = member.fullName || '';
  if (projectIndex >= 0) values[projectIndex] = project || '';
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, values.length).setValues([values]);
}

function appendActivity_(p, member, previousState, nextState, result, details) {
  var sheet = activitySheet_();
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, SUS_DASHBOARD.ACTIVITY_HEADERS.length).setValues([SUS_DASHBOARD.ACTIVITY_HEADERS]);
  var event = {
    eventId: eventId_(),
    serverTimestamp: new Date().toISOString(),
    actorId: normalizeId_(p.actorId), actorName: normalizeId_(p.actorName),
    actionType: 'BATCH_MOVE', targetId: member.idNumber, targetName: member.fullName || '',
    project: normalizeId_(p.project), previousState: previousState, newState: nextState,
    batchId: batchId_(p), deviceClientId: normalizeId_(p.deviceId), result: result, details: details || ''
  };
  sheet.appendRow([
    event.eventId, new Date(event.serverTimestamp), event.actorId, event.actorName,
    event.actionType, event.targetId, event.targetName, event.project,
    event.previousState, event.newState, event.batchId, event.deviceClientId, event.result, event.details
  ]);
  return event;
}

function batchMove_(p, requireProject) {
  var ids = unique_(idList_(p.ids || p.data));
  var destination = normalizeId_(p.destination || p.sheet);
  if (destination === 'W/Proj') destination = SUS_DASHBOARD.WITH_PROJECT;
  if ([SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED].indexOf(destination) === -1) throw new Error('Invalid destination');
  var project = normalizeId_(p.project);
  if (requireProject && !project) throw new Error('Project is required');
  if (!ids.length) throw new Error('No IDs supplied');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var key = normalizeId_(p.idempotencyKey || p.clientId || p.batchId);
    var hash = requestHash_(p);
    var prior = priorIdempotentResponse_(key, hash);
    if (prior) return respond_(prior);

    // Re-read everything after acquiring the lock. This is the authoritative
    // validation snapshot for concurrent officers.
    var snapshotResponse = dashboardData_();
    var snapshot = JSON.parse(snapshotResponse.getContent());
    var members = snapshot.members || [];
    var results = [];
    ids.forEach(function (id) {
      var matches = members.filter(function (member) { return member.idNumber === id; });
      if (matches.length !== 1) { results.push({ idNumber: id, ok: false, result: 'rejected', code: 'MISSING_OR_DUPLICATE_MAIN', reason: 'ID is missing from MAIN or duplicated there.' }); return; }
      var member = matches[0];
      if (member.requiresId !== true) { results.push({ idNumber: id, ok: false, result: 'rejected', code: 'ID_NOT_REQUIRED', reason: 'Member does not require an ID.' }); return; }
      if (requireProject && member.projects.indexOf(project) === -1) { results.push({ idNumber: id, ok: false, result: 'rejected', code: 'PROJECT_MISMATCH', reason: 'Member is not assigned to the selected project.' }); return; }
      if (member.state === 'DEPLOYED' && destination === SUS_DASHBOARD.DEPLOYED) { results.push({ idNumber: id, ok: true, result: 'noop', previousState: member.state, newState: member.state, name: member.fullName }); return; }
      if (['INVENTORY', 'WITH_PROJECT'].indexOf(member.state) === -1) { results.push({ idNumber: id, ok: false, result: 'rejected', code: 'STATE_CONFLICT', reason: 'Current state changed or is not movable: ' + member.state }); return; }
      results.push({ idNumber: id, ok: true, result: 'ready', previousState: member.state, newState: destination === SUS_DASHBOARD.WITH_PROJECT ? 'WITH_PROJECT' : 'DEPLOYED', name: member.fullName });
    });

    var invalid = results.filter(function (result) { return result.ok === false; });
    if (invalid.length) {
      results.forEach(function (result) { if (result.ok) { result.ok = false; result.result = 'rejected'; result.code = 'BATCH_ATOMIC_ABORT'; result.reason = 'Batch was not applied because another record failed validation.'; } });
      var rejectedResponse = { ok: true, accepted: false, atomic: true, batchId: batchId_(p), results: results, events: [], revision: revision_() };
      rememberIdempotentResponse_(p, hash, rejectedResponse);
      return respond_(rejectedResponse);
    }

    var targetSheet = sheet_(destination);
    var stateSheets = [sheet_(SUS_DASHBOARD.INVENTORY, false), sheet_(SUS_DASHBOARD.WITH_PROJECT, false), sheet_(SUS_DASHBOARD.DEPLOYED, false)];
    var events = [];
    results.forEach(function (result) {
      if (result.result === 'noop') return;
      var member = members.filter(function (item) { return item.idNumber === result.idNumber; })[0];
      stateSheets.forEach(function (stateSheet) { removeIdRows_(stateSheet, result.idNumber); });
      appendStateRow_(targetSheet, result.idNumber, member, project);
      var event = appendActivity_(p, member, result.previousState, result.newState, 'SUCCESS', 'Atomic batch move');
      result.result = 'applied';
      events.push(event);
    });
    var response = { ok: true, accepted: true, atomic: true, batchId: batchId_(p), results: results, events: events, revision: incrementRevision_() };
    rememberIdempotentResponse_(p, hash, response);
    return respond_(response);
  } finally {
    lock.releaseLock();
  }
}

function legacyTracker_(p) {
  var target = normalizeId_(p.sheet);
  if ([SUS_DASHBOARD.INVENTORY, SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED].indexOf(target) === -1) throw new Error('Unknown sheet');
  var actor = accessRecord_(normalizeId_(p.actorId));
  var destination = target === SUS_DASHBOARD.INVENTORY ? SUS_DASHBOARD.INVENTORY : target;
  var result = batchMove_({
    action: 'batchMove', actorId: p.actorId, actorName: p.actorName, token: p.token,
    ids: [normalizeId_(p.data)], destination: destination, project: p.project || '',
    idempotencyKey: p.clientId || Utilities.getUuid(), batchId: p.clientId || Utilities.getUuid(), deviceId: p.deviceId || ''
  }, false);
  return result;
}
