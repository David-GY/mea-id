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

test('canonical backend states and sheet location labels retain their meaning', () => {
  const data = model.normalizeResponse({ members: [
    { idNumber: '100001', state: 'WITH_PROJECT', location: 'W/ Proj' },
    { idNumber: '100002', state: 'NEEDS_PRINTING', location: 'For Printing' },
    { idNumber: '100003', state: 'INVENTORY', location: 'SUS Inventory' }
  ] });
  assert.deepEqual(data.members.map(m => m.state), ['WITH_PROJECT', 'NEEDS_PRINTING', 'INVENTORY']);
  assert.ok(data.members.every(m => !m.dataIssues.includes('Location/state conflict')));
});
