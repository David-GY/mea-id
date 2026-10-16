const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../dashboard-model');

test('live state layout reads blank A1 ID headers, skips SET, and resolves W/ proj', () => {
  const tables = {
    INVENTORY: [['', 'Full name'], ['SET', ''], ['100001', 'Member One']],
    'W/ proj': [['', 'Full name'], ['SET', ''], ['100002', 'Member Two']],
    DEPLOYED: [['', 'Full name'], ['SET', ''], ['100003', 'Member Three']],
    PRINTING: [['ID Number', 'Full name', 'ID Name'], ['SET', '', ''], ['100004', 'Member Four', 'Four']]
  };
  const sheets = Object.entries(tables).map(([name, values]) => ({
    getName: () => name, getLastRow: () => values.length,
    getLastColumn: () => values[0].length,
    getDataRange: () => ({ getDisplayValues: () => values })
  }));
  const book = { getSheetByName: name => sheets.find(s => s.getName() === name), getSheets: () => sheets };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => book },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/sus-dashboard-reference.gs'), 'utf8'), context);
  const states = context.buildStateRows_();
  assert.equal(states.INVENTORY.rows[0].idNumber, '100001');
  assert.equal(states['W/Proj'].rows[0].idNumber, '100002');
  assert.equal(states.DEPLOYED.rows[0].idNumber, '100003');
  assert.equal(states.PRINTING.rows[0].printName, 'Four');
  for (const state of Object.values(states)) assert.equal(state.rows.length, 1);
});

test('CBAB roster layout exposes valid IDs as the CBAB project roster', () => {
  const values = [
    ['0', '', 'ID num', 'Full name'],
    ['', '', 'SET', ''],
    ['1', 'President', '230492', 'Joaquim Reign G. Artes'],
    ['2', 'CAO', '244653', 'Kendrick Q. Uy']
  ];
  const sheet = {
    getName: () => 'CBAB', getLastRow: () => values.length,
    getLastColumn: () => values[0].length,
    getDataRange: () => ({ getDisplayValues: () => values })
  };
  const book = { getSheetByName: name => name === 'CBAB' ? sheet : null, getSheets: () => [sheet] };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => book },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/sus-dashboard-reference.gs'), 'utf8'), context);
  const roster = context.projectRoster_('CBAB');
  assert.deepEqual(roster.rows.map(row => row.idNumber), ['230492', '244653']);
  assert.equal(roster.rows[0].fullName, 'Joaquim Reign G. Artes');
});

test('canonical backend states and sheet location labels retain their meaning', () => {
  const data = model.normalizeResponse({ members: [
    { idNumber: '100001', state: 'WITH_PROJECT', location: 'W/ Proj' },
    { idNumber: '100002', state: 'NEEDS_PRINTING', location: 'For Printing' },
    { idNumber: '100003', state: 'INVENTORY', location: 'SUS Inventory' }
  ] });
  assert.deepEqual(data.members.map(m => m.state), ['WITH_PROJECT', 'NEEDS_PRINTING', 'INVENTORY']);
  assert.ok(data.members.every(m => !m.dataIssues.includes('Location/state conflict')));
});


test('ID moves write one cell, preserve spill formulas, and ignore derived trailing rows', () => {
  const writes = [], rows = [['', 'Full name', 'Nickname'], ['SET', '=ARRAYFORMULA(...)'], ['100001'], ['', 'derived text'], ['', 'derived text']];
  const sheet = {
    getLastRow: () => rows.length, getLastColumn: () => 3, getMaxRows: () => 5,
    getDataRange: () => ({getDisplayValues: () => rows}),
    getRange: (r,c,n=1,m=1) => ({
      getDisplayValues: () => Array.from({length:n}, (_,i) => Array.from({length:m}, (_,j) => rows[r+i-1]?.[c+j-1] || '')),
      setValue: value => { writes.push([r,c,value]); rows[r-1] ||= []; rows[r-1][c-1] = value; }
    })
  };
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/sus-dashboard-reference.gs'), 'utf8'), context);
  assert.equal(context.appendStateRow_(sheet, '100002', {fullName:'Do not write'}, 'SUS', 'A'), 4);
  assert.deepEqual(writes, [[4,1,'100002']]);
  assert.equal(rows[1][1], '=ARRAYFORMULA(...)');
  assert.equal(rows[3][1], 'derived text');
});

test('ID append expands a full sheet without touching lookup columns', () => {
  const writes = [], insertions = [];
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => 2, getMaxRows: () => 2,
    getDataRange: () => ({getDisplayValues: () => [['ID Number','Full name'],['100001','One']]}),
    getRange: () => ({getDisplayValues: () => [['100001']], setValue: v => writes.push(v)}),
    insertRowsAfter: (r,n) => insertions.push([r,n])
  };
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/sus-dashboard-reference.gs'), 'utf8'), context);
  assert.equal(context.appendStateRow_(sheet, '100002', null, '', 'A'), 3);
  assert.deepEqual(insertions, [[2,1]]); assert.deepEqual(writes, ['100002']);
});
