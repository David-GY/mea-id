/*
 * MEA ID Tracker — consolidated Apps Script backend
 *
 * Bind this script to the [SUS] MEA ID tracker spreadsheet. It is the single
 * tracker deployment for the PWA and keeps the older tracker/deets actions
 * compatible with the Dashboard API:
 *
 *   login, access, meansList  login and legacy read compatibility
 *   tracker                   legacy single-ID move used by id-tracker.html
 *   dashboardData             normalized MAIN + state-tab snapshot
 *   activity                  incremental ACTIVITY_LOG read
 *   deets                     optional MEA Digital Card lookup
 *
 * Required tracker tabs:
 *   MAIN, INVENTORY, W/Proj, DEPLOYED, PRINTING, ACCESS, ACTIVITY_LOG
 * Optional project roster tabs:
 *   CBAB (adds CBAB as a dashboard project option when present)
 *
 * Optional Script Properties:
 *   ACCESS_TOKEN              shared token expected by the PWA
 *   TRACKER_SPREADSHEET_ID    only needed if this project is standalone
 *   DEETS_SPREADSHEET_ID      overrides the Digital Card spreadsheet ID
 *   DEETS_SHEET_NAME          overrides the Digital Card tab name
 *
 * Deploy as a Web App, execute as the sheet owner, and keep the existing /exec
 * URL in the PWA settings. Do not paste this beside another file containing
 * doGet/doPost; duplicate entry points are what caused the previous script to
 * silently disable tracker and deets routes.
 */

var SUS_DASHBOARD = {
  SPREADSHEET_ID: '1426S83-4R3b7Ys81thvRETPbmIiNjJtYw853gFhuj-I',
  MAIN: 'MAIN',
  HOME_SHEET: 'MAIN',
  INVENTORY: 'INVENTORY',
  WITH_PROJECT: 'W/Proj',
  DEPLOYED: 'DEPLOYED',
  PRINTING: 'PRINTING',
  CBAB: 'CBAB',
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

var MEA_DEETS_DEFAULTS = {
  spreadsheetId: '1426S83-4R3b7Ys81thvRETPbmIiNjJtYw853gFhuj-I',
  sheetName: 'MEAns',
  columns: {
    id: 1,
    fullName: 2,
    nickname: 3,
    email: 4,
    batch: 5,
    phone: 6,
    instagram: 7,
    facebook: 8,
    linkedin: 9,
    telegram: 10
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Single web-app entry point
// ═══════════════════════════════════════════════════════════════════════════

function doGet(e) {
  return route_(e, null);
}

function doPost(e) {
  return route_(e, parseBody_(e));
}

function route_(e, body) {
  var p = mergeParams_(e, body);
  var action = String(p.action || '').trim();

  try {
    switch (action) {
      case 'deets':
        return deets_(p);
      case 'login':
        return login_(p);
      case 'access':
        return access_(p);
      case 'meansList':
        requiredToken_(p);
        return meansList_();
      case 'dashboardData':
        requireLevel_(p, ['ADMIN', 'DASHBOARD']);
        return dashboardData_();
      case 'activity':
        requireLevel_(p, ['ADMIN', 'DASHBOARD']);
        return activity_(p);
      case 'tracker':
        requireLevel_(p, ['ADMIN', 'TRACKER']);
        return legacyTracker_(p);
      default:
        return respond_({
          ok: false,
          error: 'Unknown action. Use login, access, meansList, tracker, dashboardData, activity, or deets.'
        });
    }
  } catch (err) {
    return respond_({ ok: false, error: String(err && err.message || err) });
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    var parsed = JSON.parse(e.postData.contents);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function mergeParams_(e, body) {
  var params = {};
  var query = e && e.parameter ? e.parameter : {};
  Object.keys(query).forEach(function (key) {
    if (query[key] !== undefined && query[key] !== null) params[key] = query[key];
  });
  Object.keys(body || {}).forEach(function (key) {
    if (body[key] !== undefined && body[key] !== null) params[key] = body[key];
  });
  return params;
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function respondWithCallback_(obj, callback) {
  var json = JSON.stringify(obj);
  var name = String(callback || '').trim();
  if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(name)) {
    return respond_(obj);
  }
  return ContentService.createTextOutput(name + '(' + json + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function requiredToken_(p) {
  var configured = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN');
  if (configured && String(p.token || '') !== String(configured)) {
    throw new Error('Unauthorized');
  }
}

function requireLevel_(p, levels) {
  requiredToken_(p);
  var actorId = normalizeId_(p.actorId);
  if (!actorId) throw new Error('Missing actor ID');
  var access = accessRecord_(actorId);
  var level = String(access && access.level || '').trim().toUpperCase();
  if (levels.indexOf(level) === -1) throw new Error('Insufficient permission');
}

// ═══════════════════════════════════════════════════════════════════════════
// Spreadsheet and table helpers
// ═══════════════════════════════════════════════════════════════════════════

function activeSpreadsheet_() {
  // Always use the explicit tracker file. This prevents a bound script that
  // was opened from another spreadsheet from silently reading the wrong data.
  var id = PropertiesService.getScriptProperties().getProperty('TRACKER_SPREADSHEET_ID') || SUS_DASHBOARD.SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

function sheet_(name, required) {
  var spreadsheet = activeSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    var normalized = normalizeHeader_(name);
    var matches = spreadsheet.getSheets().filter(function (candidate) {
      return normalizeHeader_(candidate.getName()) === normalized;
    });
    if (matches.length === 1) sheet = matches[0];
  }
  if (!sheet && required !== false) throw new Error('Required sheet not found: ' + name);
  return sheet;
}

function normalizeHeader_(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasHeaderRow_(values) {
  if (!values || !values.length) return false;
  var known = [
    'id', 'idnumber', 'studentid', 'fullname', 'name', 'printname',
    'level', 'accesslevel', 'role', 'eventid', 'servertimestamp',
    'actorid', 'targetid', 'requiresid', 'idrequired'
  ];
  return values[0].some(function (value) {
    return known.indexOf(normalizeHeader_(value)) !== -1;
  });
}

function tableFromValues_(values, headerRow, headerIndex) {
  if (!values || !values.length) return { headers: [], rows: [], headerRow: false };
  var width = values.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
  if (!width) return { headers: [], rows: [], headerRow: headerRow };

  var selectedHeaderIndex = headerRow ? Math.max(0, Math.min(headerIndex == null ? 0 : headerIndex, values.length - 1)) : -1;

  var headers = [];
  for (var h = 0; h < width; h++) {
    var raw = headerRow ? values[selectedHeaderIndex][h] : '';
    headers.push(String(raw == null ? '' : raw).trim() || ('Column ' + (h + 1)));
  }

  var start = headerRow ? selectedHeaderIndex + 1 : 0;
  var rows = values.slice(start).map(function (row, offset) {
    var object = { rowNumber: offset + start + 1 };
    headers.forEach(function (header, index) {
      object[header] = row[index] == null ? '' : row[index];
    });
    return object;
  });
  return { headers: headers, rows: rows, headerRow: headerRow };
}

function displayTable_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) {
    return { headers: [], rows: [], headerRow: false };
  }
  var values = sheet.getDataRange().getDisplayValues();
  return tableFromValues_(values, true, headerRowIndex_(sheet, values));
}

function headerRowIndex_(sheet, values) {
  // MAIN has a frozen title/project row above its actual field headers.
  // Find the first row containing both an ID and a name header so the helper
  // remains correct if the sheet gains another title row later.
  if (sheet && sheet.getName() === SUS_DASHBOARD.MAIN) {
    var limit = Math.min(values.length, 10);
    for (var i = 0; i < limit; i++) {
      var normalized = values[i].map(normalizeHeader_);
      var hasId = normalized.indexOf('id') !== -1 || normalized.indexOf('idnumber') !== -1 || normalized.indexOf('studentid') !== -1;
      var hasName = normalized.indexOf('fullname') !== -1 || normalized.indexOf('name') !== -1;
      if (hasId && hasName) return i;
    }
    return Math.max(0, Math.min(values.length - 1, (sheet.getFrozenRows() || 1) - 2));
  }
  return 0;
}

// State tabs in older tracker sheets are often just a column of IDs without a
// header. Treat the first value as data unless it clearly looks like a header.
function stateTable_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) {
    return { headers: [], rows: [], headerRow: false };
  }
  var values = sheet.getDataRange().getDisplayValues();
  var headerRow = hasHeaderRow_(values);
  return tableFromValues_(values, headerRow, headerRow ? 0 : -1);
}

function columnIndex_(headers, candidates, fallback) {
  var wanted = candidates.map(normalizeHeader_);
  for (var i = 0; i < headers.length; i++) {
    if (wanted.indexOf(normalizeHeader_(headers[i])) !== -1) return i;
  }
  return fallback == null ? -1 : fallback;
}

function objectValue_(row, headers, candidates, fallback) {
  var index = columnIndex_(headers, candidates, fallback == null ? -1 : fallback);
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
  var output = [];
  (items || []).forEach(function (item) {
    if (item && output.indexOf(item) === -1) output.push(item);
  });
  return output;
}

function rowId_(row, headers, fallbackIndex) {
  return normalizeId_(objectValue_(row, headers, ['ID Number', 'ID num', 'Student ID', 'ID'], fallbackIndex));
}

function rowName_(row, headers, fallbackIndex) {
  return normalizeId_(objectValue_(row, headers, ['Full Name', 'Name'], fallbackIndex));
}

function columnNumber_(value) {
  if (typeof value === 'number' && value > 0) return Math.floor(value);
  var letters = String(value || 'A').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return 1;
  var number = 0;
  for (var i = 0; i < letters.length; i++) number = number * 26 + letters.charCodeAt(i) - 64;
  return Math.max(1, number);
}

function canonicalStateTab_(value) {
  var text = normalizeId_(value).toUpperCase();
  if (text === 'INVENTORY') return SUS_DASHBOARD.INVENTORY;
  if (text === 'W/PROJ' || text === 'WPROJ' || text === 'WITH_PROJECT' || text === 'WITH PROJECT') return SUS_DASHBOARD.WITH_PROJECT;
  if (text === 'DEPLOYED') return SUS_DASHBOARD.DEPLOYED;
  if (text === 'PRINTING') return SUS_DASHBOARD.PRINTING;
  return '';
}

function stateName_(tab) {
  return tab === SUS_DASHBOARD.WITH_PROJECT ? 'WITH_PROJECT' : tab.toUpperCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// Login, access, and legacy Digital Card compatibility
// ═══════════════════════════════════════════════════════════════════════════

function accessRecord_(id) {
  var table = displayTable_(sheet_(SUS_DASHBOARD.ACCESS, false));
  var idIndex = columnIndex_(table.headers, ['ID Number', 'ID', 'Student ID'], 0);
  var levelIndex = columnIndex_(table.headers, ['Level', 'Access Level', 'Role'], 2);
  var nameIndex = columnIndex_(table.headers, ['Name', 'Full Name'], 1);
  for (var i = 0; i < table.rows.length; i++) {
    var row = table.rows[i];
    if (normalizeId_(row[table.headers[idIndex]]) === id) {
      return {
        id: id,
        name: normalizeId_(row[table.headers[nameIndex]]),
        level: normalizeId_(row[table.headers[levelIndex]])
      };
    }
  }
  return null;
}

function login_(p) {
  requiredToken_(p);
  var id = normalizeId_(p.id);
  if (!/^\d{6}$/.test(id)) {
    return respond_({ ok: true, found: false, error: 'ID must be a 6-digit number' });
  }

  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN));
  // Older MAIN sheets use column B for ID and C for name; labeled sheets
  // still win through header detection.
  var idIndex = columnIndex_(main.headers, ['ID Number', 'Student ID', 'ID'], 1);
  var nameIndex = columnIndex_(main.headers, ['Full Name', 'Name'], 2);
  for (var i = 0; i < main.rows.length; i++) {
    var row = main.rows[i];
    if (normalizeId_(row[main.headers[idIndex]]) === id) {
      var access = accessRecord_(id);
      return respond_({
        ok: true,
        found: true,
        idNumber: id,
        name: normalizeId_(row[main.headers[nameIndex]]),
        level: access ? String(access.level || '').toUpperCase() : 'NONE'
      });
    }
  }
  return respond_({ ok: true, found: false, idNumber: id, name: '', level: 'NONE' });
}

function access_(p) {
  requiredToken_(p);
  var id = normalizeId_(p.id);
  if (!id) return respond_({ ok: true, allowed: false, error: 'No ID provided' });
  var access = accessRecord_(id);
  return respond_({
    ok: true,
    allowed: !!access,
    idNumber: id,
    name: access ? access.name : '',
    level: access ? String(access.level || '').toUpperCase() : 'NONE'
  });
}

function meansList_() {
  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN));
  var idIndex = columnIndex_(main.headers, ['ID Number', 'Student ID', 'ID'], 1);
  var nameIndex = columnIndex_(main.headers, ['Full Name', 'Name'], 2);
  var members = main.rows.map(function (row) {
    return {
      id: normalizeId_(row[main.headers[idIndex]]),
      name: normalizeId_(row[main.headers[nameIndex]])
    };
  }).filter(function (member) { return member.id && member.name; });
  return respond_({ ok: true, members: members });
}

function deetsConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    spreadsheetId: props.getProperty('DEETS_SPREADSHEET_ID') || MEA_DEETS_DEFAULTS.spreadsheetId,
    sheetName: props.getProperty('DEETS_SHEET_NAME') || MEA_DEETS_DEFAULTS.sheetName,
    columns: MEA_DEETS_DEFAULTS.columns
  };
}

function deets_(p) {
  var memberId = normalizeId_(p.id);
  var callback = p.callback;
  if (!memberId) return respondWithCallback_({ ok: false, success: false, error: 'No ID provided' }, callback);

  try {
    var config = deetsConfig_();
    var sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.sheetName);
    if (!sheet) throw new Error('Sheet "' + config.sheetName + '" not found');
    var rows = sheet.getDataRange().getDisplayValues();
    var c = config.columns;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (normalizeId_(row[c.id - 1]) !== memberId) continue;
      var member = {
        id: normalizeId_(row[c.id - 1]),
        fullName: normalizeId_(row[c.fullName - 1]),
        nickname: normalizeId_(row[c.nickname - 1]),
        email: normalizeId_(row[c.email - 1]),
        batch: normalizeId_(row[c.batch - 1]),
        phone: normalizeId_(row[c.phone - 1]),
        instagram: normalizeId_(row[c.instagram - 1]),
        facebook: normalizeId_(row[c.facebook - 1]),
        linkedin: normalizeId_(row[c.linkedin - 1]),
        telegram: normalizeId_(row[c.telegram - 1])
      };
      return respondWithCallback_({ ok: true, success: true, member: member }, callback);
    }
    return respondWithCallback_({ ok: false, success: false, error: 'Member not found' }, callback);
  } catch (err) {
    return respondWithCallback_({ ok: false, success: false, error: 'Server error: ' + String(err && err.message || err) }, callback);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard read model
// ═══════════════════════════════════════════════════════════════════════════

function buildStateRows_() {
  var names = [SUS_DASHBOARD.INVENTORY, SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED, SUS_DASHBOARD.PRINTING];
  var result = {};
  names.forEach(function (name) {
    var table = stateTable_(sheet_(name, false));
    // Live state tabs have a blank A1 and formula-generated names in B:D.
    var idFallback = 0;
    var nameFallback = table.headerRow ? undefined : 1;
    result[name] = {
      table: table,
      rows: table.rows.filter(function (row) {
        var id = rowId_(row, table.headers, idFallback);
        return id && id.toUpperCase() !== 'SET';
      }).map(function (row) {
        return {
          idNumber: rowId_(row, table.headers, idFallback),
          fullName: rowName_(row, table.headers, nameFallback),
          printName: normalizeId_(objectValue_(row, table.headers, ['Print Name', 'Usable Print Name', 'ID Name'])),
          rowNumber: row.rowNumber
        };
      })
    };
  });
  return result;
}

function mainRecord_(row, headers, headerRow) {
  // MAIN historically used B/C, while newer sheets use labeled columns.
  var idNumber = rowId_(row, headers, headerRow ? 1 : 0);
  var fullName = rowName_(row, headers, headerRow ? 2 : 1);
  var nickname = normalizeId_(objectValue_(row, headers, ['Nickname', 'Nick Name']));
  var department = normalizeId_(objectValue_(row, headers, ['Department', 'Dept']));
  var location = normalizeId_(objectValue_(row, headers, ['ID Location', 'Location']));
  var requiresId = parseBool_(objectValue_(row, headers, ['Requires ID?', 'Requires ID', 'ID Required']));
  var projects = [];
  if (headerRow) {
    var known = [
      'Email', 'Email Address', 'ID Number', 'Student ID', 'ID', 'Full Name', 'Name',
      'Nickname', 'Nick Name', 'Last Name', 'Department', 'Dept', 'Batch', 'Year',
      'Phone', 'ID Location', 'Location', 'Requires ID?', 'Requires ID', 'ID Required'
    ].map(normalizeHeader_);
    projects = headers.filter(function (header) {
      return known.indexOf(normalizeHeader_(header)) === -1 && normalizeHeader_(header).indexOf('timestamp') === -1;
    }).filter(function (header) {
      var value = String(row[header] == null ? '' : row[header]).trim().toLowerCase();
      return value && ['0', 'false', 'no', 'n'].indexOf(value) === -1;
    });
  }
  return {
    idNumber: idNumber,
    fullName: fullName,
    nickname: nickname,
    department: department,
    location: location,
    requiresId: requiresId,
    projects: projects,
    rowNumber: row.rowNumber
  };
}

function projectRoster_(name) {
  var table = displayTable_(sheet_(name, false));
  if (!table.headers.length) return { table: table, rows: [] };
  var idIndex = columnIndex_(table.headers, ['ID Number', 'ID num', 'Student ID', 'ID'], 2);
  var nameIndex = columnIndex_(table.headers, ['Full Name', 'Name'], 3);
  var rows = table.rows.map(function (row) {
    var id = normalizeId_(row[table.headers[idIndex]]);
    if (!id || id.toUpperCase() === 'SET' || !/^\d{6}$/.test(id)) return null;
    return {
      idNumber: id,
      fullName: normalizeId_(row[table.headers[nameIndex]]),
      rowNumber: row.rowNumber
    };
  }).filter(function (row) { return !!row; });
  return { table: table, rows: rows };
}

function isIgnorableMainRow_(row, headers) {
  var id = rowId_(row, headers, 1);
  if (id) return false;
  var first = normalizeId_(row[headers[0]]).toUpperCase();
  // MAIN row 3 is the sheet's formula seed marker, not a member record.
  if (first === 'SET') return true;
  return headers.every(function (header) { return !normalizeId_(row[header]); });
}

function stateForSources_(sources, requiresId) {
  if (sources.indexOf('DEPLOYED') !== -1) return 'DEPLOYED';
  if (sources.indexOf('WITH_PROJECT') !== -1) return 'WITH_PROJECT';
  if (sources.indexOf('INVENTORY') !== -1) return 'INVENTORY';
  if (sources.indexOf('PRINTING') !== -1) return 'NEEDS_PRINTING';
  return requiresId === false ? 'NOT_REQUIRED' : 'MISSING';
}

function dashboardData_() {
  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN));
  var states = buildStateRows_();
  var cbab = projectRoster_(SUS_DASHBOARD.CBAB);
  var byId = {};

  main.rows.forEach(function (row) {
    if (isIgnorableMainRow_(row, main.headers)) return;
    var member = mainRecord_(row, main.headers, main.headerRow);
    if (!member.idNumber) return;
    if (!byId[member.idNumber]) {
      byId[member.idNumber] = member;
    } else {
      byId[member.idNumber].dataIssues = (byId[member.idNumber].dataIssues || []).concat('Duplicate ID number in MAIN');
      byId[member.idNumber].duplicateMainRows = (byId[member.idNumber].duplicateMainRows || []).concat(row.rowNumber);
    }
  });

  Object.keys(states).forEach(function (tab) {
    states[tab].rows.forEach(function (stateRow) {
      if (!stateRow.idNumber) return;
      if (!byId[stateRow.idNumber]) {
        byId[stateRow.idNumber] = {
          idNumber: stateRow.idNumber,
          fullName: stateRow.fullName,
          projects: [],
          requiresId: null,
          dataIssues: ['State-tab ID absent from MAIN']
        };
      }
      var member = byId[stateRow.idNumber];
      member.sourceStates = (member.sourceStates || []).concat(stateName_(tab));
      member.tabRows = member.tabRows || {};
      member.tabRows[tab] = (member.tabRows[tab] || []).concat(stateRow.rowNumber);
      if (!member.fullName && stateRow.fullName) member.fullName = stateRow.fullName;
      if (tab === SUS_DASHBOARD.PRINTING && stateRow.printName) member.printName = stateRow.printName;
    });
  });

  // CBAB is maintained as its own roster tab rather than as a MAIN column.
  // Treat its IDs as project membership only; it is not an additional state
  // source and therefore cannot create a state conflict by itself.
  cbab.rows.forEach(function (projectRow) {
    var member = byId[projectRow.idNumber];
    if (!member) {
      byId[projectRow.idNumber] = {
        idNumber: projectRow.idNumber,
        fullName: projectRow.fullName,
        projects: [SUS_DASHBOARD.CBAB],
        requiresId: null,
        dataIssues: ['Project-tab ID absent from MAIN']
      };
      return;
    }
    member.projects = unique_((member.projects || []).concat(SUS_DASHBOARD.CBAB));
  });

  var members = Object.keys(byId).map(function (id) {
    var member = byId[id];
    member.sourceStates = unique_(member.sourceStates || []);
    member.dataIssues = unique_(member.dataIssues || []);
    if (!member.idNumber) member.dataIssues.push('Missing ID number');
    if (!member.fullName) member.dataIssues.push('Missing name');
    if (member.requiresId === true && !(member.projects || []).length) member.dataIssues.push('No project assignment');
    if (member.sourceStates.length > 1) member.dataIssues.push('ID appears in multiple state tabs');
    member.state = stateForSources_(member.sourceStates, member.requiresId);
    return member;
  });

  var rawTabs = {
    main: main.rows.filter(function (row) {
      return !isIgnorableMainRow_(row, main.headers);
    }).map(function (row) {
      return Object.assign({}, row, {
        idNumber: rowId_(row, main.headers, main.headerRow ? 1 : 0),
        fullName: rowName_(row, main.headers, main.headerRow ? 2 : 1)
      });
    }),
    inventory: states[SUS_DASHBOARD.INVENTORY].rows,
    withProject: states[SUS_DASHBOARD.WITH_PROJECT].rows,
    deployed: states[SUS_DASHBOARD.DEPLOYED].rows,
    printing: states[SUS_DASHBOARD.PRINTING].rows,
    cbab: cbab.rows
  };
  return respond_({
    ok: true,
    revision: revision_(),
    generatedAt: new Date().toISOString(),
    members: members,
    rawTabs: rawTabs
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Activity and idempotency
// ═══════════════════════════════════════════════════════════════════════════

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
      var field = header.toLowerCase().replace(/[^a-z0-9]+(.)/g, function (_, character) {
        return character.toUpperCase();
      });
      event[field] = value;
    });
    event.eventId = String(event.eventId || '').trim();
    return event;
  }).filter(function (event) { return event.eventId; });
}

function activity_(p) {
  var events = activityEvents_();
  var cursor = normalizeId_(p.cursor);
  var start = 0;
  if (cursor) {
    var index = events.map(function (event) { return event.eventId; }).indexOf(cursor);
    if (index >= 0) {
      start = index + 1;
    } else {
      var cursorTime = Date.parse(cursor);
      if (!isNaN(cursorTime)) {
        events = events.filter(function (event) {
          return Date.parse(event.serverTimestamp) > cursorTime;
        });
      }
    }
  }
  var batch = events.slice(start, start + 250);
  return respond_({
    ok: true,
    revision: revision_(),
    events: batch,
    nextCursor: batch.length ? batch[batch.length - 1].eventId : cursor
  });
}

function eventId_() {
  return Utilities.getUuid();
}

function idList_(value) {
  if (Array.isArray(value)) return value.map(normalizeId_).filter(Boolean);
  try {
    var parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(normalizeId_).filter(Boolean) : [];
  } catch (err) {
    return String(value || '').split(',').map(normalizeId_).filter(Boolean);
  }
}

function requestHash_(p) {
  var raw = JSON.stringify({
    actorId: normalizeId_(p.actorId),
    project: normalizeId_(p.project),
    destination: canonicalStateTab_(p.destination || p.sheet),
    ids: unique_(idList_(p.ids || p.data))
  });
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.map(function (byte) {
    return ('0' + (byte & 255).toString(16)).slice(-2);
  }).join('');
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
    if (String(row[table.headers[keyIndex]] || '') !== key) continue;
    if (String(row[table.headers[hashIndex]] || '') !== hash) {
      throw new Error('Idempotency key was reused with a different request');
    }
    try {
      return JSON.parse(String(row[table.headers[responseIndex]] || ''));
    } catch (err) {
      throw new Error('Stored idempotency response is invalid');
    }
  }
  return null;
}

function rememberIdempotentResponse_(key, p, hash, response) {
  if (!key) return;
  idempotencySheet_().appendRow([
    key,
    normalizeId_(p.batchId),
    normalizeId_(p.actorId),
    hash,
    new Date(),
    JSON.stringify(response)
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// State-tab writes
// ═══════════════════════════════════════════════════════════════════════════

function preferredColumn_(sheetName, p) {
  if (sheetName === SUS_DASHBOARD.INVENTORY) return p.colInv || p.col;
  if (sheetName === SUS_DASHBOARD.WITH_PROJECT) return p.colProj || p.col;
  if (sheetName === SUS_DASHBOARD.DEPLOYED) return p.colDep || p.col;
  return p.col;
}

function trackedColumn_(sheet, preferred) {
  var table = stateTable_(sheet);
  if (table.headerRow) {
    var detected = columnIndex_(table.headers, ['ID Number', 'Student ID', 'ID'], -1);
    if (detected >= 0) return detected + 1;
  }
  return columnNumber_(preferred || 'A');
}

function removeIdRows_(sheet, id, preferred) {
  if (!sheet || sheet.getLastRow() < 1) return 0;
  var table = stateTable_(sheet);
  var firstDataRow = table.headerRow ? 2 : 1;
  if (sheet.getLastRow() < firstDataRow) return 0;
  var column = trackedColumn_(sheet, preferred);
  var values = sheet.getRange(firstDataRow, column, sheet.getLastRow() - firstDataRow + 1, 1).getDisplayValues();
  var removed = 0;
  for (var i = values.length - 1; i >= 0; i--) {
    if (normalizeId_(values[i][0]) === id) {
      sheet.deleteRow(firstDataRow + i);
      removed++;
    }
  }
  return removed;
}

function appendStateRow_(sheet, id, member, project, preferred) {
  var table = stateTable_(sheet);
  var targetColumn = trackedColumn_(sheet, preferred);
  var width = Math.max(1, sheet.getLastColumn() || 1, table.headers.length, targetColumn);
  var values = [];
  for (var i = 0; i < width; i++) values.push('');

  var idIndex = table.headerRow
    ? columnIndex_(table.headers, ['ID Number', 'Student ID', 'ID'], targetColumn - 1)
    : targetColumn - 1;
  values[idIndex] = id;

  if (table.headerRow) {
    var nameIndex = columnIndex_(table.headers, ['Name', 'Full Name'], -1);
    var projectIndex = columnIndex_(table.headers, ['Project', 'Project Assignment'], -1);
    if (nameIndex >= 0) values[nameIndex] = member && member.fullName || '';
    if (projectIndex >= 0) values[projectIndex] = project || '';
  }

  var rowNumber = Math.max(sheet.getLastRow() + 1, table.headerRow ? 2 : 1);
  sheet.getRange(rowNumber, 1, 1, width).setValues([values]);
  return rowNumber;
}

function appendActivity_(p, member, previousState, nextState, result, details) {
  var sheet = activitySheet_();
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, SUS_DASHBOARD.ACTIVITY_HEADERS.length).setValues([SUS_DASHBOARD.ACTIVITY_HEADERS]);
  }
  var timestamp = new Date();
  var event = {
    eventId: eventId_(),
    serverTimestamp: timestamp.toISOString(),
    actorId: normalizeId_(p.actorId),
    actorName: normalizeId_(p.actorName),
    actionType: 'BATCH_MOVE',
    targetId: member.idNumber,
    targetName: member.fullName || '',
    project: normalizeId_(p.project),
    previousState: previousState,
    newState: nextState,
    batchId: normalizeId_(p.batchId),
    deviceClientId: normalizeId_(p.deviceId),
    result: result,
    details: details || ''
  };
  sheet.appendRow([
    event.eventId, timestamp, event.actorId, event.actorName,
    event.actionType, event.targetId, event.targetName, event.project,
    event.previousState, event.newState, event.batchId,
    event.deviceClientId, event.result, event.details
  ]);
  return event;
}

function appendOptionalActivity_(p, member, previousState, nextState, result, details) {
  if (!sheet_(SUS_DASHBOARD.ACTIVITY, false)) return null;
  return appendActivity_(p, member, previousState, nextState, result, details);
}

function memberFromMain_(id) {
  var main = displayTable_(sheet_(SUS_DASHBOARD.MAIN, false));
  var idIndex = columnIndex_(main.headers, ['ID Number', 'Student ID', 'ID'], 1);
  var nameIndex = columnIndex_(main.headers, ['Full Name', 'Name'], 2);
  for (var i = 0; i < main.rows.length; i++) {
    var row = main.rows[i];
    if (normalizeId_(row[main.headers[idIndex]]) === id) {
      return mainRecord_(row, main.headers, main.headerRow);
    }
  }
  return { idNumber: id, fullName: '', projects: [], requiresId: null };
}

function stateOccurrences_(id) {
  var states = buildStateRows_();
  var occurrences = [];
  Object.keys(states).forEach(function (tab) {
    states[tab].rows.forEach(function (row) {
      if (row.idNumber === id) occurrences.push(stateName_(tab));
    });
  });
  return unique_(occurrences);
}

function legacyMoveOne_(p, id, destination) {
  var member = memberFromMain_(id);
  var previousStates = stateOccurrences_(id);
  var stateSheets = [SUS_DASHBOARD.INVENTORY, SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED];
  stateSheets.forEach(function (name) {
    removeIdRows_(sheet_(name, false), id, preferredColumn_(name, p));
  });
  var target = sheet_(destination);
  var row = appendStateRow_(target, id, member, p.project || '', preferredColumn_(destination, p));
  var event = appendOptionalActivity_(p, member, previousStates.length ? previousStates.join(',') : 'MISSING', stateName_(destination), 'SUCCESS', 'Legacy tracker move');
  return {
    idNumber: id,
    ok: true,
    row: row,
    previousState: previousStates.length ? previousStates[0] : 'MISSING',
    newState: stateName_(destination),
    event: event
  };
}

function legacyTracker_(p) {
  var id = normalizeId_(p.data);
  var destination = canonicalStateTab_(p.sheet);
  if (!id) throw new Error('No ID supplied');
  if ([SUS_DASHBOARD.INVENTORY, SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED].indexOf(destination) === -1) {
    throw new Error('Unknown tracker destination');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var batchId = normalizeId_(p.clientId) || Utilities.getUuid();
    p.batchId = batchId;
    var result = legacyMoveOne_(p, id, destination);
    return respond_({
      ok: true,
      accepted: true,
      atomic: true,
      batchId: batchId,
      results: [result],
      events: result.event ? [result.event] : [],
      revision: incrementRevision_()
    });
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Locked Dashboard batch write
// ═══════════════════════════════════════════════════════════════════════════

function batchId_(p) {
  return normalizeId_(p.batchId) || Utilities.getUuid();
}

function batchMove_(p) {
  var ids = unique_(idList_(p.ids || p.data));
  var destination = canonicalStateTab_(p.destination || p.sheet);
  if ([SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED].indexOf(destination) === -1) {
    throw new Error('Invalid Dashboard destination');
  }
  var project = normalizeId_(p.project);
  if (!project) throw new Error('Project is required');
  if (!ids.length) throw new Error('No IDs supplied');

  p.batchId = batchId_(p);
  var key = normalizeId_(p.idempotencyKey || p.clientId || p.batchId);
  p.idempotencyKey = key;
  var hash = requestHash_(p);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var prior = priorIdempotentResponse_(key, hash);
    if (prior) return respond_(prior);

    // Preflight every dependency before changing any state row. In
    // particular, a missing ACTIVITY_LOG must not cause a partial move.
    var targetSheet = sheet_(destination);
    var stateSheets = [
      sheet_(SUS_DASHBOARD.INVENTORY, false),
      sheet_(SUS_DASHBOARD.WITH_PROJECT, false),
      sheet_(SUS_DASHBOARD.DEPLOYED, false)
    ];
    activitySheet_();

    // Re-read after the lock: this is the authoritative concurrency snapshot.
    var snapshot = JSON.parse(dashboardData_().getContent());
    var members = snapshot.members || [];
    var results = [];

    ids.forEach(function (id) {
      var matches = members.filter(function (member) { return member.idNumber === id; });
      if (matches.length !== 1) {
        results.push({ idNumber: id, ok: false, result: 'rejected', code: 'MISSING_OR_DUPLICATE_MAIN', reason: 'ID is missing from MAIN or duplicated there.' });
        return;
      }
      var member = matches[0];
      if (member.dataIssues && member.dataIssues.indexOf('Duplicate ID number in MAIN') !== -1) {
        results.push({ idNumber: id, ok: false, result: 'rejected', code: 'DUPLICATE_MAIN', reason: 'ID is duplicated in MAIN.' });
        return;
      }
      if (member.requiresId !== true) {
        results.push({ idNumber: id, ok: false, result: 'rejected', code: 'ID_NOT_REQUIRED', reason: 'Member does not require an ID.' });
        return;
      }
      if ((member.projects || []).indexOf(project) === -1) {
        results.push({ idNumber: id, ok: false, result: 'rejected', code: 'PROJECT_MISMATCH', reason: 'Member is not assigned to the selected project.' });
        return;
      }
      var tabRows = member.tabRows || {};
      var duplicateStateRows = Object.keys(tabRows).some(function (tab) { return (tabRows[tab] || []).length > 1; });
      if ((member.sourceStates || []).length !== 1 || duplicateStateRows) {
        results.push({ idNumber: id, ok: false, result: 'rejected', code: 'STATE_CONFLICT', reason: 'ID has conflicting or duplicate state-tab rows.' });
        return;
      }
      if (member.state === 'DEPLOYED' && destination === SUS_DASHBOARD.DEPLOYED) {
        results.push({ idNumber: id, ok: true, result: 'noop', previousState: member.state, newState: member.state, name: member.fullName });
        return;
      }
      if (['INVENTORY', 'WITH_PROJECT'].indexOf(member.state) === -1) {
        results.push({ idNumber: id, ok: false, result: 'rejected', code: 'STATE_CONFLICT', reason: 'Current state is not movable: ' + member.state });
        return;
      }
      results.push({
        idNumber: id,
        ok: true,
        result: 'ready',
        previousState: member.state,
        newState: destination === SUS_DASHBOARD.WITH_PROJECT ? 'WITH_PROJECT' : 'DEPLOYED',
        name: member.fullName
      });
    });

    var invalid = results.filter(function (result) { return result.ok === false; });
    if (invalid.length) {
      results.forEach(function (result) {
        if (result.ok) {
          result.ok = false;
          result.result = 'rejected';
          result.code = 'BATCH_ATOMIC_ABORT';
          result.reason = 'Batch was not applied because another record failed validation.';
        }
      });
      var rejected = {
        ok: true,
        accepted: false,
        atomic: true,
        batchId: p.batchId,
        results: results,
        events: [],
        revision: revision_()
      };
      rememberIdempotentResponse_(key, p, hash, rejected);
      return respond_(rejected);
    }

    var events = [];
    results.forEach(function (result) {
      if (result.result === 'noop') return;
      var member = members.filter(function (item) { return item.idNumber === result.idNumber; })[0];
      stateSheets.forEach(function (stateSheet, index) {
        var name = [SUS_DASHBOARD.INVENTORY, SUS_DASHBOARD.WITH_PROJECT, SUS_DASHBOARD.DEPLOYED][index];
        removeIdRows_(stateSheet, result.idNumber, preferredColumn_(name, p));
      });
      appendStateRow_(targetSheet, result.idNumber, member, project, preferredColumn_(destination, p));
      var event = appendActivity_(p, member, result.previousState, result.newState, 'SUCCESS', 'Atomic batch move');
      result.result = 'applied';
      events.push(event);
    });

    var response = {
      ok: true,
      accepted: true,
      atomic: true,
      batchId: p.batchId,
      results: results,
      events: events,
      revision: incrementRevision_()
    };
    rememberIdempotentResponse_(key, p, hash, response);
    return respond_(response);
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Optional spreadsheet-bound bulk move utility
// ═══════════════════════════════════════════════════════════════════════════

function notify_(message) {
  try { SpreadsheetApp.getUi().alert(message); } catch (err) {}
}

function bulkMove() {
  var ss = activeSpreadsheet_();
  var bulkSheet = ss.getSheetByName('Bulk Move');
  if (!bulkSheet) {
    notify_('Sheet named "Bulk Move" was not found. Create it and put IDs in column A.');
    return;
  }

  var lastRow = bulkSheet.getLastRow();
  if (lastRow < 1) {
    notify_('Bulk Move is empty. Nothing to move.');
    return;
  }

  var ids = bulkSheet.getRange(1, 1, lastRow, 1).getDisplayValues().map(function (row) {
    return normalizeId_(row[0]);
  }).filter(function (id) {
    return id && ['id', 'id number', 'student id'].indexOf(id.toLowerCase()) === -1;
  });
  ids = unique_(ids);
  if (!ids.length) {
    notify_('No valid IDs found in Bulk Move.');
    return;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var p = { actorId: 'SCRIPT', actorName: 'Bulk Move', project: '', col: 'A' };
    var moved = 0;
    ids.forEach(function (id) {
      legacyMoveOne_(p, id, SUS_DASHBOARD.WITH_PROJECT);
      moved++;
    });
    SpreadsheetApp.flush();
    bulkSheet.clearContents();
    notify_('Bulk Move complete. ' + moved + ' ID(s) moved to W/Proj and the sheet was cleared.');
  } finally {
    lock.releaseLock();
  }
}
