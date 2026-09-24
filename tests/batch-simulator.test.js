const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated in-memory contract test. This deliberately never imports or writes
// a Google Sheet; it models the Apps Script lock/re-read/idempotency boundary.
function makeBatchService(initial) {
  const records = new Map(initial.map(record => [record.idNumber, {...record}]));
  const responses = new Map();
  let eventCount = 0;

  return {
    get(id) { return records.get(id); },
    move(request) {
      if (responses.has(request.idempotencyKey)) return responses.get(request.idempotencyKey);
      const results = request.ids.map(id => {
        const record = records.get(id);
        if (!record) return {idNumber:id, ok:false, reason:'Missing from MAIN'};
        if (!record.projects.includes(request.project)) return {idNumber:id, ok:false, reason:'Project mismatch'};
        if (!['INVENTORY', 'WITH_PROJECT'].includes(record.state)) return {idNumber:id, ok:false, reason:'State conflict'};
        return {idNumber:id, ok:true, previousState:record.state, newState:request.destination};
      });
      if (results.some(result => !result.ok)) {
        const rejected = {ok:true, accepted:false, atomic:true, results:results.map(result => result.ok ? {...result, ok:false, reason:'BATCH_ATOMIC_ABORT'} : result), events:[]};
        responses.set(request.idempotencyKey, rejected);
        return rejected;
      }
      results.forEach(result => {
        records.get(result.idNumber).state = result.newState;
        eventCount += 1;
      });
      const applied = {ok:true, accepted:true, atomic:true, results, events:Array.from({length:results.length}, (_, index) => ({eventId:`e${eventCount - results.length + index + 1}`}))};
      responses.set(request.idempotencyKey, applied);
      return applied;
    },
    eventCount() { return eventCount; }
  };
}

const base = [
  {idNumber:'400001', fullName:'Ready One', projects:['ALPHA'], state:'INVENTORY'},
  {idNumber:'400002', fullName:'Ready Two', projects:['ALPHA'], state:'WITH_PROJECT'},
  {idNumber:'400003', fullName:'Other Project', projects:['BETA'], state:'INVENTORY'}
];

test('successful batch moves every selected record and creates one event per record', () => {
  const service = makeBatchService(base);
  const response = service.move({idempotencyKey:'batch-1', project:'ALPHA', destination:'DEPLOYED', ids:['400001','400002']});
  assert.equal(response.accepted, true);
  assert.ok(response.results.every(result => result.ok));
  assert.equal(service.get('400001').state, 'DEPLOYED');
  assert.equal(service.get('400002').state, 'DEPLOYED');
  assert.equal(service.eventCount(), 2);
});

test('partially invalid batches are rejected atomically with per-record results', () => {
  const service = makeBatchService(base);
  const response = service.move({idempotencyKey:'batch-2', project:'ALPHA', destination:'DEPLOYED', ids:['400001','400003']});
  assert.equal(response.accepted, false);
  assert.equal(response.results.length, 2);
  assert.equal(service.get('400001').state, 'INVENTORY');
  assert.equal(service.eventCount(), 0);
});

test('a concurrent state change is rejected and retrying the same key is idempotent', () => {
  const service = makeBatchService(base);
  service.get('400001').state = 'DEPLOYED'; // newer state after the officer read
  const request = {idempotencyKey:'batch-3', project:'ALPHA', destination:'DEPLOYED', ids:['400001']};
  const first = service.move(request);
  const second = service.move(request);
  assert.equal(first.accepted, false);
  assert.deepEqual(second, first);
  assert.equal(service.eventCount(), 0);
});
