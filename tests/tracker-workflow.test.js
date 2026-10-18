const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('id-tracker.html', 'utf8');
function functionSource(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const body = html.indexOf('{', start);
  let depth = 1, end = body + 1;
  while (depth && end < html.length) { if (html[end] === '{') depth++; if (html[end] === '}') depth--; end++; }
  return html.slice(start, end);
}
function fixture(online = true) {
  const nodes = new Map(); const writes = [], queue = [], logs = [], notices = [];
  const document = {getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, {value:'', hidden:false, style:{}, classList:{add(){},remove(){}}, focus(){this.focused=true;}});
    return nodes.get(id);
  }};
  const context = vm.createContext({document, window:{scrollTo(){}}, navigator:{onLine:online}, URLSearchParams,
    cfg:{url:'https://example.test/exec',cols:{INVENTORY:'A','W/Proj':'B',DEPLOYED:'C'},cooldown:3},
    toast:(...args)=>notices.push(args), lookupMemberName:()=>'',
    addLog:(...args)=>logs.push(args),saveScan(){},enqueueScan:(...args)=>queue.push(args),
    sheetColParams:()=>({colInv:'A',colProj:'B',colDep:'C'}), authParams:()=>({token:'fixture-token',actorId:'999999'}),
    fetch:async url=>{writes.push(new URL(url));return {ok:true};}, Date, setScanUI(){},
  });
  vm.runInContext(`let activeTab=null, destinationGeneration=0, isScanning=false, nfcReader=null;
    const TABS=['INVENTORY','W/Proj','DEPLOYED'];
    const LABELS={INVENTORY:'INVENTORY','W/Proj':'W/PROJ',DEPLOYED:'DEPLOYED'};
    const DESTINATIONS={INVENTORY:{title:'Inventory',theme:'inventory',icon:'archive-box',description:'Storage'},'W/Proj':{title:'W/Proj',theme:'project',icon:'folder',description:'Project'},DEPLOYED:{title:'Deploy',theme:'deploy',icon:'user',description:'Member'}};
    let lastManualSubmit={data:'',tab:null,ms:0};` + ['chooseDestination','setTab','submitManual','sendToSheets','stopScan','startScan'].map(functionSource).join('\n'),context);
  return {context,nodes,writes,queue,logs,notices,document};
}
test('destination required; chooser clears actor/target input and never writes', async()=>{
  const f=fixture(); f.document.getElementById('manualInput').value='999999';
  await f.context.submitManual();
  assert.equal(f.writes.length,0);assert.equal(f.nodes.get('manualInput').value,'');
  assert.equal(f.nodes.get('trackerOperations').hidden,true);
});
test('each destination sends directly using the existing tracker request contract',async()=>{
  for(const [sheet,col] of [['INVENTORY','A'],['W/Proj','B'],['DEPLOYED','C']]) {
    const f=fixture();f.context.setTab(sheet);f.nodes.get('manualInput').value='260001';
    await f.context.submitManual();assert.equal(f.writes.length,1);
    const p=f.writes[0].searchParams;
    assert.equal(p.get('action'),'tracker');assert.equal(p.get('sheet'),sheet);assert.equal(p.get('col'),col);
    assert.equal(p.get('data'),'260001');assert.equal(p.get('token'),'fixture-token');assert.equal(p.get('actorId'),'999999');
    assert.equal(f.nodes.get('manualInput').value,'');assert.ok(f.nodes.get('manualInput').focused);
  }
});
test('cooldown blocks double sends but allows intentional movement to another destination',async()=>{
  const f=fixture();f.context.setTab('INVENTORY');
  for(let i=0;i<2;i++){f.nodes.get('manualInput').value='260001';await f.context.submitManual();}
  assert.equal(f.writes.length,1);
  f.context.setTab('DEPLOYED');f.nodes.get('manualInput').value='260001';await f.context.submitManual();assert.equal(f.writes.length,2);
});
test('offline send retains selected sheet and existing queue behavior',async()=>{
  const f=fixture(false);f.context.setTab('W/Proj');f.nodes.get('manualInput').value='260002';await f.context.submitManual();
  assert.equal(f.writes.length,0);assert.deepEqual(f.queue,[['W/Proj','B','260002']]);assert.equal(f.logs.length,1);
});
test('changing destination stops scanning and disconnects the old NFC callback',()=>{
  const f=fixture();vm.runInContext('isScanning=true;nfcReader={onreading:()=>{},onreadingerror:()=>{}};var oldReader=nfcReader;',f.context);
  f.context.chooseDestination();assert.equal(f.context.oldReader.onreading,null);assert.equal(f.context.oldReader.onreadingerror,null);
});
test('pending NFC permission cannot activate scanning after leaving destination',async()=>{
  const f=fixture();let resolve;
  f.context.NDEFReader=class {scan(){return new Promise(r=>resolve=r);}};
  f.context.setTab('INVENTORY');const scan=f.context.startScan();f.context.chooseDestination();resolve();await scan;
  assert.equal(vm.runInContext('isScanning',f.context),false);
});
test('Enter uses direct manual submission and approved UI has no review step',()=>{
  assert.match(html,/onkeydown="if\(event.key==='Enter'\) submitManual\(\)"/);
  assert.match(html,/id="trackerOperations" hidden/);assert.doesNotMatch(html,/id="tab-INVENTORY"|Review ID|Confirm deployment/);
});
