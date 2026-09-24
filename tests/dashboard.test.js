const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../dashboard-rules.js');
const model = require('../dashboard-model.js');

test('needs deployment is centralized and only accepts required, available IDs', () => {
  assert.equal(rules.needsDeployment({ requiresId: true, state: rules.STATES.INVENTORY }), true);
  assert.equal(rules.needsDeployment({ requiresId: true, state: rules.STATES.WITH_PROJECT }), true);
  assert.equal(rules.needsDeployment({ requiresId: true, state: rules.STATES.DEPLOYED }), false);
  assert.equal(rules.needsDeployment({ requiresId: true, state: rules.STATES.MISSING }), false);
  assert.equal(rules.needsDeployment({ requiresId: false, state: rules.STATES.INVENTORY }), false);
});

test('normalizes raw MAIN and state tabs into one model and derives totals', () => {
  const normalized = model.normalizeResponse({
    ok: true,
    rawTabs: {
      main: [
        { rowNumber: 2, 'ID Number': '100001', Name: 'Ada One', Nickname: 'A', Department: 'SUS', 'Requires ID?': 'Yes', 'PROJECT ALPHA': 'Yes' },
        { rowNumber: 3, 'ID Number': '100002', Name: 'Bea Two', 'Requires ID?': 'Yes', 'PROJECT ALPHA': 'Yes' },
        { rowNumber: 4, 'ID Number': '100003', Name: 'Cal Three', 'Requires ID?': 'No', 'PROJECT ALPHA': 'Yes' }
      ],
      inventory: [{ rowNumber: 2, idNumber: '100001', fullName: 'Ada One' }],
      deployed: [{ rowNumber: 2, idNumber: '100003', fullName: 'Cal Three' }],
      printing: [{ rowNumber: 2, idNumber: '100002', fullName: 'Bea Two', printName: 'Bea Two' }]
    }
  });
  const totals = model.totals(normalized.members);
  assert.equal(totals.totalRegistered, 3);
  assert.equal(totals.inventory, 1);
  assert.equal(totals.deployed, 1);
  assert.equal(totals.needsPrinting, 1);
  assert.equal(totals.requiredMissing, 1);
  assert.equal(normalized.projects[0], 'PROJECT ALPHA');
  const readiness = model.projectReadiness(normalized.members, 'PROJECT ALPHA');
  assert.deepEqual({
    totalAssigned: readiness.totalAssigned,
    membersRequiringIds: readiness.membersRequiringIds,
    idsReady: readiness.idsReady,
    idsDeployed: readiness.idsDeployed,
    idsMissing: readiness.idsMissing,
    readiness: readiness.readiness,
    status: readiness.status
  }, { totalAssigned: 3, membersRequiringIds: 2, idsReady: 1, idsDeployed: 0, idsMissing: 1, readiness: 0, status: 'red' });
});

test('detects duplicate MAIN/state rows, conflicting states, orphans, and incomplete records', () => {
  const data = model.normalizeResponse({
    members: [{ idNumber: '200001', fullName: 'Duplicate Person', requiresId: true, projects: ['ALPHA'], state: 'INVENTORY' }],
    rawTabs: {
      main: [
        { rowNumber: 2, idNumber: '200001', fullName: 'Duplicate Person' },
        { rowNumber: 3, idNumber: '200001', fullName: 'Duplicate Person' },
        { rowNumber: 4, idNumber: '', fullName: '' }
      ],
      inventory: [{ rowNumber: 2, idNumber: '200001', fullName: 'Duplicate Person' }, { rowNumber: 3, idNumber: '200001', fullName: 'Duplicate Person' }],
      deployed: [{ rowNumber: 2, idNumber: '200001', fullName: 'Duplicate Person' }, { rowNumber: 3, idNumber: '200099', fullName: 'Orphan' }],
      printing: [{ rowNumber: 2, idNumber: '200100', fullName: '', printName: '' }]
    }
  });
  const types = model.detectExceptions(data).map(exception => exception.type);
  assert.ok(types.includes('Duplicate ID number'));
  assert.ok(types.includes('Duplicate entries in state tab'));
  assert.ok(types.includes('ID appears in multiple state tabs'));
  assert.ok(types.includes('State ID absent from MAIN'));
  assert.ok(types.includes('Missing ID number'));
  assert.ok(types.includes('Printing record missing usable print name'));
});

test('activity merge is idempotent and preserves newest server ordering', () => {
  const first = [{ eventId: 'e1', serverTimestamp: '2026-01-01T00:00:00Z', actionType: 'MOVE' }];
  const merged = model.mergeActivity(first, [
    { eventId: 'e1', serverTimestamp: '2026-01-01T00:00:00Z', actionType: 'MOVE', details: 'same event' },
    { eventId: 'e2', serverTimestamp: '2026-01-01T00:00:01Z', actionType: 'BATCH_MOVE' }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].eventId, 'e2');
  assert.equal(merged[1].details, 'same event');
});

test('MAIN metadata never creates a state conflict, including cached warnings', () => {
  const data = model.normalizeResponse({ members: [
    { idNumber: '300001', fullName: 'No ID Person', requiresId: false, projects: ['ALPHA'], state: 'DEPLOYED' },
    { idNumber: '300002', fullName: 'Location Conflict', requiresId: true, projects: ['ALPHA'], state: 'INVENTORY', location: 'DEPLOYED' },
    { idNumber: '300003', fullName: 'Cached', requiresId: null, state: 'INVENTORY', dataIssues: ['Requires ID? is unclear', 'Requires ID? and state conflict', 'Location/state conflict'] }
  ] });
  const issues = model.detectExceptions(data).map(exception => exception.type);
  assert.ok(!issues.some(issue => /conflict/i.test(issue)));
  assert.ok(data.members.every(member => member.dataIssues.length === 0));
});

test('only overlapping state tabs produce the multiple-state warning; MAIN is excluded', () => {
  for (const pair of [['inventory', 'deployed'], ['withProject', 'inventory'], ['printing', 'inventory']]) {
    const row = { idNumber: '400001', fullName: 'Member' };
    const data = model.normalizeResponse({ rawTabs: { main: [row], [pair[0]]: [row], [pair[1]]: [row] } });
    assert.equal(model.detectExceptions(data).filter(e => e.type === 'ID appears in multiple state tabs').length, 1);
  }
  const row = { idNumber: '400001', fullName: 'Member' };
  const data = model.normalizeResponse({ rawTabs: { main: [row], inventory: [row] } });
  assert.equal(model.detectExceptions(data).filter(e => e.type === 'ID appears in multiple state tabs').length, 0);
});

test('CBAB roster rows become project assignments without becoming state sources', () => {
  const data = model.normalizeResponse({ rawTabs: {
    main: [{ rowNumber: 4, idNumber: '230492', fullName: 'Joaquim Reign G. Artes', 'Requires ID?': 'Yes' }],
    cbab: [{ rowNumber: 3, idNumber: '230492', fullName: 'Joaquim Reign G. Artes' }],
    inventory: [{ rowNumber: 3, idNumber: '230492', fullName: 'Joaquim Reign G. Artes' }]
  } });
  assert.deepEqual(data.projects, ['CBAB']);
  assert.deepEqual(data.members[0].projects, ['CBAB']);
  assert.deepEqual(data.members[0].sourceStates, ['INVENTORY']);
  assert.equal(model.detectExceptions(data).filter(e => e.type === 'ID appears in multiple state tabs').length, 0);
});

test('reference Apps Script includes locked re-read, idempotency, permissions, and append-only activity paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'sus-dashboard-reference.gs'), 'utf8');
  for (const required of [
    'LockService.getScriptLock()',
    'priorIdempotentResponse_',
    'requireLevel_(p, [\'ADMIN\'])',
    'ACTIVITY_LOG',
    'BATCH_ATOMIC_ABORT',
    'dashboardData_',
    'activity_',
    "case 'deets'",
    "case 'tracker'",
    'function bulkMove()',
    'function stateTable_(',
    "SPREADSHEET_ID: '1426S83-4R3b7Ys81thvRETPbmIiNjJtYw853gFhuj-I'",
    "HOME_SHEET: 'MAIN'",
    'function headerRowIndex_('
  ]) assert.ok(source.includes(required), `missing backend safeguard: ${required}`);
  assert.equal(/AKfycb/.test(source), false);
  assert.equal((source.match(/^function doGet\(/gm) || []).length, 1);
  assert.equal((source.match(/^function doPost\(/gm) || []).length, 1);
  assert.equal((source.match(/^function respond_\(/gm) || []).length, 1);
});
