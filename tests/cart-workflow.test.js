const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cart = require('../cart-model');
const source = fs.readFileSync(require.resolve('../apps-script/inventory-v2.gs'), 'utf8');
function fixture() {
  let serial = 0, held = false, mail = 0;
  const properties = {INVENTORY_SPREADSHEET_ID: 'test', TRACKER_SPREADSHEET_ID: 'roster', SUPABASE_PUBLISHABLE_KEY: 'test-key'};
  const books = {};
  class Sheet {
    constructor(rows = [], width = 12) { this.rows = rows; this.width = width; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(1, ...this.rows.map(r => r.length)); }
    getMaxColumns() { return this.width; }
    insertColumnsAfter(_, n) { this.width += n; }
    hideSheet() {} hideColumns() {} showColumns() {}
    appendRow(row) { this.rows.push([...row]); }
    getDataRange() { return this.getRange(1, 1, this.rows.length, this.getLastColumn()); }
    getRange(r, c, n = 1, m = 1) {
      const read = () => Array.from({length:n}, (_,i) => Array.from({length:m}, (_,j) => this.rows[r+i-1]?.[c+j-1] ?? ''));
      return {clearDataValidations() {}, clearContent: () => this.getRange(r,c,n,m).setValues(Array.from({length:n},()=>Array(m).fill(''))), getValues: read, getDisplayValues: () => read().map(row => row.map(String)), getValue: () => read()[0][0],
        setValue: value => this.getRange(r,c).setValues([[value]]),
        setValues: values => { values.forEach((row,i) => row.forEach((v,j) => { this.rows[r+i-1] ||= []; this.rows[r+i-1][c+j-1] = v; })); }};
    }
  }
  const catalogHeader = [[],[],[],['','Type','Quantity','Location','Category','Notes']];
  const tabs = {
    Inventory: new Sheet([...catalogHeader.map(r => [...r]), ['', 'Markers', '8', 'Cabinet A', 'Stationery', 'Shared']]),
    'Special Inventory': new Sheet(catalogHeader.map(r => [...r])),
    Borrow: new Sheet([['Time','Item','Qty','Project','Committee','ID Num','Name','Email','Resolved'], [new Date(), 'Old item', 3, 'SUS', '', '100001', 'One', 'one@student.ateneo.edu', true]]),
    Consume: new Sheet([['Time','Item','Qty','Project','Committee','ID Num','Name','Email']]),
    Return: new Sheet([['Time','Item','Qty','Project','Committee','ID Num','Name','Email']])
  };
  const book = {getSheetByName: name => tabs[name], insertSheet: name => tabs[name] = new Sheet()};
  const roster = new Sheet([[],['Email','ID','Full Name','','','','','','SUS'],['SET'], ['one@student.ateneo.edu','100001','One','','','','','',true], ['two@student.ateneo.edu','100002','Two','','','','','',false]]);
  const trackerTabs={MAIN:roster,ACCESS:new Sheet([['ID Number','Name','Level']])};
  books.test = book; books.roster = {getSheetByName: name => trackerTabs[name]};
  const context = vm.createContext({console, Date, JSON, Number, Object, Array, String,
    PropertiesService: {getScriptProperties: () => ({getProperty: key => properties[key]})},
    SpreadsheetApp: {openById: id => books[id], flush: () => {}},
    Utilities: {getUuid: () => 'uuid-' + (++serial)},
    LockService: {getScriptLock: () => ({waitLock: () => { assert.equal(held,false); held = true; }, releaseLock: () => { held = false; }})},
    GmailApp: {sendEmail: () => { mail++; }},
    ContentService: {MimeType:{JSON:'json'}, createTextOutput: text => ({setMimeType: () => JSON.parse(text)})},
    UrlFetchApp: {fetch: (_, options) => { const token = options.headers.Authorization.slice(7), email = token === 'two' ? 'two@student.ateneo.edu' : 'one@student.ateneo.edu'; return {getResponseCode: () => token === 'invalid' ? 400 : 200, getContentText: () => JSON.stringify({id:token, email, email_confirmed_at: token !== 'unverified' ? '2026-10-16' : null, identities:[{provider:'google',identity_data:{email,email_verified:true,full_name:'Test Member'}}]})}; }}
  });
  vm.runInContext(source, context);
  context.setupInventoryV2();
  const request = (action,p={}) => context.doPost({parameter:{action},postData:{contents:JSON.stringify(p)}});
  const item = () => context.invCatalog_()[0];
  const order = (overrides={}) => ({clientId:'client-1000001',idNumber:'100001',caseType:'BORROWING',project:'SUS',committee:'Operations',items:[{id:item().id,title:item().title,location:item().location,qty:3}],...overrides});
  return {context,tabs,request,item,order,roster,trackerTabs,properties,mail:()=>mail};
}
test('cart keeps independent actions for one item and rejects malformed quantities', () => {
  const item = {id:'stable-a'};
  const draft = cart.normalize({a:{item,qty:2,action:'BORROWING'},b:{item,qty:1,action:'CONSUMING'},c:{item,qty:2,action:'RETURNING'}});
  assert.equal(Object.keys(draft).length,2); assert.equal(cart.groups(draft).length,2);
  for(const value of [0,-1,1.5,'2 packs','',Infinity,10000]) assert.throws(()=>cart.quantity(value));
});

test('legacy review selects only active unresolved blocked loans and preserves return guards',()=>{
 const loan={recordId:'LEGACY-one',caseType:'BORROWING',qty:3,returnedQty:0,returnable:false,resolved:false};
 assert.equal(cart.needsLegacyReview(loan),true);
 for(const changes of [{caseType:'CONSUMING'},{returnable:true},{returnable:undefined},{resolved:true},{deleted:true}])assert.equal(cart.needsLegacyReview({...loan,...changes}),false);
 assert.throws(()=>cart.validateReturn(loan,1,'officer',true),/cannot be returned/);
});
test('quantity labels preserve units and zero; reordered catalog preserves references', () => {
  assert.equal(cart.availability('2 packs').value,null); assert.equal(cart.availability('*').value,null); assert.equal(cart.availability('0').value,0);
  const item = {id:'stable-a',qtyDisplay:'4'}, key=cart.key(item.id,'BORROWING');
  const draft = {[key]:{item,qty:1,action:'BORROWING'}};
  const refreshed = cart.reconcile(draft,[{id:'other'}, {...item,qtyDisplay:'3'}]);
  assert.equal(refreshed[key].item.id,'stable-a'); assert.equal(refreshed[key].changed,true);
  assert.equal(cart.reconcile(draft,[])[key].unavailable,true);
});
test('setup preserves names, emails, resolved checkboxes, and permanent IDs', () => {
  const f=fixture(), id=f.item().id;
  f.context.setupInventoryV2();
  assert.equal(f.item().id,id); assert.equal(f.tabs.Borrow.rows[1][6],'One'); assert.equal(f.tabs.Borrow.rows[1][7],'one@student.ateneo.edu'); assert.equal(f.tabs.Borrow.rows[1][8],true);
  const old=f.context.invHistory_()[0]; assert.equal(old.resolved,true); assert.equal(old.returnable,false);
  f.tabs.Inventory.rows.splice(4,0,['','Other','*','Shelf','Other','','other-id']);
  assert.equal(f.context.invCatalog_().find(i=>i.title==='Markers').id,id);
});
test('submissions retry without duplicate rows or receipts; same key cannot mutate request', () => {
  const f=fixture(), payload=f.order();
  assert.equal(f.request('submitOrder',payload).ok,true);
  assert.equal(f.request('submitOrder',payload).ok,true);
  assert.equal(f.tabs.Borrow.rows.length,3); assert.equal(f.mail(),1);
  assert.equal(f.tabs.Borrow.rows[2][6],'One');
  assert.equal(f.request('submitOrder',{...payload,items:[{...payload.items[0],qty:2}]}).code,'CHANGED_REQUEST');
  assert.equal(f.request('submitOrder',{...payload,idNumber:'100002'}).ok,false);
});
test('invalid submission is atomic and Return is not a checkout action', () => {
  const f=fixture(); const payload=f.order(); payload.items.push({id:'missing',qty:1});
  assert.equal(f.request('submitOrder',payload).ok,false); assert.equal(f.tabs._MEA_EVENTS.rows.length,1);
  assert.equal(f.request('submitOrder',f.order({caseType:'RETURNING'})).ok,false);
});
test('partial and full returns reject over-return, other owners, consumed items, and retries', () => {
  const f=fixture(); const created=f.request('submitOrder',f.order()); const borrowId=created.recordIds[0];
  const ret={clientId:'return-1000001',idNumber:'100001',borrowId,qty:1};
  assert.equal(f.request('returnItems',{...ret,idNumber:'100002'}).ok,false);
  assert.equal(f.request('returnItems',ret).remaining,2); assert.equal(f.request('returnItems',ret).remaining,2);
  assert.equal(f.tabs.Return.rows.length,2);
  assert.equal(f.request('returnItems',{...ret,clientId:'return-1000002',qty:3}).ok,false);
  assert.equal(f.request('returnItems',{...ret,clientId:'return-1000003',qty:2}).remaining,0);
  assert.equal(f.tabs.Borrow.rows[2][8],true);
  assert.equal(f.request('returnItems',{...ret,clientId:'return-1000004',qty:1}).ok,false);
  const consumed=f.request('submitOrder',f.order({caseType:'CONSUMING',clientId:'consume-1000001'}));
  assert.equal(f.request('returnItems',{...ret,clientId:'return-1000005',borrowId:consumed.recordIds[0]}).ok,false);
});

test('unresolved legacy loans join normal returns without rewriting their original snapshots',()=>{
 const f=fixture();
 f.tabs.Borrow.appendRow([new Date(),'Old unresolved',4,'SUS','','100001','One','one@student.ateneo.edu',false]);
 f.context.repairLegacyMetadata({dryRun:false});
 const snapshots=JSON.stringify(f.tabs._MEA_LEGACY.rows), borrowBefore=JSON.stringify(f.tabs.Borrow.rows), eventsBefore=JSON.stringify(f.tabs._MEA_EVENTS.rows);
 const history=f.request('history',{idNumber:'100001'});
 const loan=history.records.find(r=>r.item==='Old unresolved');
 assert.equal(loan.legacyAssumedUnreturned,true);assert.equal(loan.returnable,true);assert.equal(loan.canReturn,true);assert.equal(loan.outstandingQty,4);assert.equal(loan.returnedQty,0);
 const completed=history.records.find(r=>r.item==='Old item');assert.equal(completed.resolved,true);assert.equal(completed.canReturn,false);assert.equal(completed.legacyAssumedUnreturned,undefined);
 assert.equal(JSON.stringify(f.tabs.Borrow.rows),borrowBefore);assert.equal(JSON.stringify(f.tabs._MEA_EVENTS.rows),eventsBefore);assert.equal(JSON.stringify(f.tabs._MEA_LEGACY.rows),snapshots);
 const ret={clientId:'legacy-return-001',idNumber:'100001',borrowId:loan.recordId,qty:1};
 assert.equal(f.request('returnItems',{...ret,idNumber:'100002'}).ok,false);
 assert.equal(f.request('returnItems',ret).remaining,3);assert.equal(f.request('returnItems',ret).remaining,3);assert.equal(f.tabs.Return.rows.length,2);
 assert.equal(f.context.invEvents_()[0].legacyAssumedUnreturned,true);
 assert.equal(f.request('returnItems',{...ret,clientId:'legacy-return-002',qty:4}).ok,false);
 assert.equal(f.request('returnItems',{...ret,clientId:'legacy-return-003',qty:3}).remaining,0);
 const returned=f.request('history',{idNumber:'100001'}).records.find(r=>r.recordId===loan.recordId);
 assert.equal(returned.resolved,true);assert.equal(returned.returnedQty,4);assert.equal(returned.canReturn,false);assert.equal(f.tabs.Borrow.rows[2][8],true);
 assert.equal(JSON.stringify(f.tabs._MEA_LEGACY.rows),snapshots);
 assert.equal(f.request('returnItems',{...ret,clientId:'legacy-return-004'}).ok,false);
});

test('assumed legacy balances exclude invalid, completed, consumed, deleted and reconciled loans',()=>{
 const f=fixture(), template={recordId:'LEGACY-case',caseType:'BORROWING',idNum:'100001',project:'SUS',borrowedQty:4,returnedQty:0,returnable:false};
 const cases=[{borrowedQty:0},{borrowedQty:-2},{borrowedQty:1.5},{borrowedQty:'unknown'},{borrowedQty:10000},{returnedQty:4},{returnedQty:1},{caseType:'CONSUMING'},{deleted:true},{returnable:true,returnedQty:2}];
 f.tabs._MEA_LEGACY.rows=[f.tabs._MEA_LEGACY.rows[0],...cases.map((changes,i)=>{const r={...template,...changes,recordId:'LEGACY-case-'+i};return [r.recordId,JSON.stringify(r)];})];
 for(const r of f.context.invHistory_())assert.equal(r.legacyAssumedUnreturned,undefined);
 const reconciled=f.context.invHistory_().find(r=>r.recordId==='LEGACY-case-9');assert.equal(reconciled.returnable,true);assert.equal(reconciled.outstandingQty,2);
});
test('projection failures do not lose journal records; repair does not duplicate rows', () => {
  const f=fixture(), append=f.tabs.Borrow.appendRow.bind(f.tabs.Borrow);
  f.tabs.Borrow.appendRow=()=>{throw new Error('Transient sheet failure');};
  assert.equal(f.request('submitOrder',f.order()).ok,true); assert.equal(f.context.invHistory_().length,2);
  f.tabs.Borrow.appendRow=append; f.context.repairInventoryProjections(); f.context.repairInventoryProjections();
  assert.equal(f.tabs.Borrow.rows.length,3);
});
test('cloud drafts require verified school identity and enforce revision and account isolation', () => {
  const f=fixture(), item=f.item(), key=cart.key(item.id,'BORROWING');
  const draft={cart:{[key]:{item,qty:1,action:'BORROWING'}},project:'SUS',committee:'Ops'};
  assert.equal(f.request('cartRead').ok,false); assert.equal(f.request('cartRead',{idToken:'invalid'}).ok,false); assert.equal(f.request('cartRead',{idToken:'unverified'}).ok,false);
  assert.equal(f.request('cartWrite',{idToken:'one',expectedRevision:0,draft}).revision,1);
  assert.equal(f.request('cartRead',{idToken:'one',uid:'two'}).revision,1);
  assert.equal(f.request('cartRead',{idToken:'two',uid:'one'}).revision,0);
  assert.equal(f.request('cartWrite',{idToken:'one',expectedRevision:0,draft}).code,'CONFLICT');
  assert.equal(f.request('cartWrite',{idToken:'one',expectedRevision:1,draft:{...draft,cart:{bad:{...draft.cart[key],qty:0}}}}).ok,false);
  f.roster.rows.push(['one@student.ateneo.edu','100003','Duplicate']);
  assert.equal(f.request('googleMember',{idToken:'one'}).code,'ROSTER_MISMATCH');
});

test('metadata repair imports checkbox rows once, preserves resolved state and supports dry run', () => {
  const f=fixture();
  f.tabs.Borrow.rows.push([new Date(),'Skipped loan',4,'SUS','','100001','One','one@student.ateneo.edu',true,false,false,false]);
  const audit=f.context.repairLegacyMetadata(); assert.equal(audit.booleanPlaceholders,3);
  assert.equal(f.tabs.Borrow.rows[2][9],false);
  f.context.repairLegacyMetadata({dryRun:false}); f.context.repairLegacyMetadata({dryRun:false});
  assert.match(f.tabs.Borrow.rows[2][9],/^LEGACY-/); assert.equal(f.tabs.Borrow.rows[2][11],'');
  const rows=f.context.invHistory_().filter(r=>r.item==='Skipped loan');
  assert.equal(rows.length,1); assert.equal(rows[0].resolved,true); assert.equal(f.tabs.Borrow.rows[2][8],true);
  assert.match(rows[0].reference,/^BR-/);
});
test('unexpected metadata and duplicate IDs stop repair without clearing data',()=>{
  const f=fixture(); f.tabs.Borrow.rows.push([new Date(),'Problem',1,'','','100001','','',false,'unexpected',false,false]);
  assert.throws(()=>f.context.repairLegacyMetadata({dryRun:false}),/Metadata needs review/);
  assert.equal(f.tabs.Borrow.rows[2][10],false);
  f.tabs.Borrow.rows[2][9]=f.tabs.Borrow.rows[1][9];
  assert.match(f.context.repairLegacyMetadata().issues.join(),/Duplicate/);
});
test('display aliases are stable across repeat setup and sorting and grow beyond 999',()=>{
  const f=fixture(), id=f.item().id, code=f.item().itemCode;
  f.context.setupInventoryV2(); assert.equal(f.item().itemCode,code);
  f.tabs.Inventory.rows.splice(4,0,['','Other','1','Shelf','','','ITEM-other']);
  f.context.setupInventoryV2(); assert.equal(f.context.invCatalog_().find(i=>i.id===id).itemCode,code);
  f.tabs._MEA_REFERENCES.rows.push(['RT','RETURN-high','RT-999']);
  assert.equal(f.context.invWithLock_(()=>f.context.invReference_('RT','RETURN-new')),'RT-1000');
  assert.equal(f.context.invWithLock_(()=>f.context.invReference_('RT','RETURN-new')),'RT-1000');
});
function googleUser(f,uid,email,name='Guest') { f.context.invGoogleUser_=()=>({localId:uid,email,emailVerified:true,displayName:name}); }
test('school identity classifies exact domain guests and rejects malformed or duplicate roster matches',()=>{
  const f=fixture();googleUser(f,'guest-a',' New.Student@student.ateneo.edu ');
  const a=f.request('googleMember',{idToken:'token'}).account;
  assert.equal(a.accountKind,'GUEST'); assert.equal(a.memberId,null);assert.match(a.guestCode,/^G-/);
  assert.equal(f.request('googleMember',{idToken:'token'}).account.guestCode,a.guestCode);assert.equal(f.tabs.Accounts.rows.length,2);
  for(const email of ['guest@gmail.com','x@student.ateneo.edu.example.com','x@sub.student.ateneo.edu','x@@student.ateneo.edu']) {
    googleUser(f,'bad',email);assert.equal(f.request('googleMember',{idToken:'token'}).code,'DOMAIN_NOT_ALLOWED');
  }
  googleUser(f,'one','ONE@student.ateneo.edu');assert.equal(f.request('googleMember',{idToken:'token'}).account.memberId,'100001');
  f.roster.rows.push(['one@student.ateneo.edu','100003','Duplicate']);
  assert.equal(f.request('googleMember',{idToken:'token'}).code,'ROSTER_MISMATCH');
  googleUser(f,'broken','broken@student.ateneo.edu');f.roster.rows.push(['broken@student.ateneo.edu','oops','Bad']);
  assert.equal(f.request('googleMember',{idToken:'token'}).code,'ROSTER_MISMATCH');
});
test('verified guest submissions ignore forged member IDs and protect history and returns',()=>{
  const f=fixture();googleUser(f,'guest-a','guest@student.ateneo.edu');
  const created=f.request('submitOrder',f.order({idToken:'valid',idNumber:'100001'}));assert.equal(created.ok,true);
  const borrowId=created.recordIds[0];assert.equal(f.tabs.Borrow.rows[2][5],'guest:guest-a');
  assert.equal(f.request('history',{idToken:'valid'}).records.length,1);
  assert.equal(f.request('history',{idNumber:'100001'}).records.length,1); // legacy only
  assert.equal(f.request('history',{idToken:'valid',scope:'project',project:'SUS'}).code,'FORBIDDEN');
  googleUser(f,'guest-b','another@student.ateneo.edu');assert.equal(f.request('history',{idToken:'valid'}).records.length,0);
  assert.equal(f.request('returnItems',{idToken:'valid',idNumber:'guest:guest-a',borrowId,qty:1,clientId:'return-guest-b'}).ok,false);
  googleUser(f,'guest-a','guest@student.ateneo.edu');
  const ret={idToken:'valid',borrowId,qty:1,clientId:'return-guest-a'};
  assert.equal(f.request('returnItems',ret).remaining,2);assert.equal(f.request('returnItems',ret).remaining,2);
  assert.equal(f.request('returnItems',{...ret,idToken:undefined,idNumber:'100001'}).ok,false);
});
test('guest promotion keeps previous loans and UID draft with explicit conflict protection',()=>{
  const f=fixture();googleUser(f,'promote','promote@student.ateneo.edu');
  const item=f.item(), key=cart.key(item.id,'BORROWING'), draft={cart:{[key]:{item,qty:1,action:'BORROWING'}},project:'SUS'};
  f.request('cartWrite',{idToken:'valid',expectedRevision:0,draft});
  const created=f.request('submitOrder',f.order({idToken:'valid'}));
  f.roster.rows.push(['promote@student.ateneo.edu','100003','New Member']);
  assert.equal(f.request('googleMember',{idToken:'valid'}).account.accountKind,'MEMBER');
  assert.equal(f.request('cartRead',{idToken:'valid'}).revision,1);
  assert.equal(f.request('cartWrite',{idToken:'valid',expectedRevision:0,draft}).code,'CONFLICT');
  const history=f.request('history',{idToken:'valid'});assert.equal(history.records.length,1);assert.equal(history.records[0].idNum,'100003');
  assert.equal(f.request('returnItems',{idToken:'valid',borrowId:created.recordIds[0],qty:3,clientId:'promote-return'}).remaining,0);
});

test('Supabase verifies current tokens, confirmed Google identity email, provider and ban status',()=>{
  const f=fixture();
  const valid={id:'verified',email:'one@student.ateneo.edu',email_confirmed_at:'2026-10-16',identities:[{provider:'google',identity_data:{email:'one@student.ateneo.edu',email_verified:true}}]};
  let status=200, user=valid;
  f.context.UrlFetchApp.fetch=(url,options)=>{
    assert.equal(url,'https://gxffeavbefmmycmvccsm.supabase.co/auth/v1/user');
    assert.equal(options.headers.Authorization,'Bearer current-token'); assert.equal(options.headers.apikey,'test-key');
    return {getResponseCode:()=>status,getContentText:()=>JSON.stringify(user)};
  };
  assert.equal(f.context.invGoogleUser_('current-token').localId,'verified');
  for(const rejected of [{...valid,banned_until:'2099-01-01'},{...valid,email_confirmed_at:null},{...valid,identities:[{provider:'email'}]},{...valid,email:'different@student.ateneo.edu'},null]) {
    user=rejected;assert.throws(()=>f.context.invGoogleUser_('current-token'),/Verify your school/);
  }
  user=valid;status=401;assert.throws(()=>f.context.invGoogleUser_('current-token'),/Verify your school/);
});

test('shared department history normalizes labels and allows only own or verified officer returns',()=>{
  const f=fixture(); const loan=f.request('submitOrder',f.order({project:'  SUS  Operations  '}));
  f.roster.rows[1].push('SUS Operations'); f.roster.rows[3].push(true);
  const scope={idNumber:'100001',scope:'project',project:'sus operations'};
  const shared=f.request('history',scope); assert.equal(shared.ok,true);assert.equal(shared.records.length,1);
  assert.equal(shared.records[0].canReturn,true);
  assert.equal(f.request('history',{...scope,idNumber:'100002'}).code,'FORBIDDEN');assert.equal('email' in shared.records[0],false);assert.equal('ownerKey' in shared.records[0],false);
  const own=f.request('history',{...scope,idNumber:'100001'});assert.equal(own.records[0].canReturn,true);
  assert.equal(f.request('returnItems',{idNumber:'100002',borrowId:loan.recordIds[0],qty:1,clientId:'other-return-1',officer:true}).ok,false);
  googleUser(f,'officer','two@student.ateneo.edu');f.trackerTabs.ACCESS.rows.push(['100002','Two','Admin']);
  const view=f.request('history',{...scope,idToken:'valid'});assert.equal(view.records[0].canReturn,true);
  const ret={idToken:'valid',borrowId:loan.recordIds[0],qty:1,clientId:'officer-return-1'};
  assert.equal(f.request('returnItems',ret).remaining,2);assert.equal(f.request('returnItems',ret).remaining,2);
  const event=f.context.invEvents_().find(e=>e.type==='RETURN');assert.equal(event.idNumber,'100002');assert.equal(event.onBehalfOf,'100001');
  assert.equal(f.request('history',{...scope,project:'Personal'}).code,'FORBIDDEN');
  assert.equal(f.request('history',{...scope,idNumber:'999999'}).code,'UNAUTHORIZED');
});

test('shared history never exposes another guest UID and consumed or legacy rows cannot be returned',()=>{
  const f=fixture();googleUser(f,'private-guest','guest@student.ateneo.edu');
  f.request('submitOrder',f.order({idToken:'valid',caseType:'CONSUMING'}));
  const shared=f.request('history',{idNumber:'100001',scope:'project',project:'SUS'});
  const guest=shared.records.find(r=>r.accountKind==='GUEST');assert.match(guest.idNum,/^G-/);assert.equal(guest.canReturn,false);
  assert.equal(JSON.stringify(shared).includes('private-guest'),false);
  assert.equal(f.request('history',{idNumber:'100001',scope:'officer'}).code,'FORBIDDEN');
});

test('verified project membership permits delegated returns and reversible deletion with revision checks',()=>{
 const f=fixture(); const loan=f.request('submitOrder',f.order({idNumber:'100002'}));
 assert.equal(f.request('returnItems',{idNumber:'100001',borrowId:loan.recordIds[0],qty:1,clientId:'id-delegation'}).ok,false);
 googleUser(f,'one','one@student.ateneo.edu');
 assert.equal(f.request('returnItems',{idToken:'valid',borrowId:loan.recordIds[0],qty:1,clientId:'team-delegation'}).remaining,2);
 const change={idToken:'valid',recordId:loan.recordIds[0],expectedRevision:0,clientId:'delete-team-row'};
 assert.equal(f.request('recordDelete',change).ok,true);assert.equal(f.request('recordDelete',change).ok,true);
 let record=f.context.invHistory_().find(r=>r.recordId===loan.recordIds[0]);assert.equal(record.deleted,true);assert.equal(record.outstandingQty,2);assert.equal(record.recordRevision,1);
 assert.equal(f.request('returnItems',{idToken:'valid',borrowId:record.recordId,qty:1,clientId:'deleted-return'}).ok,false);
 assert.equal(f.request('recordRestore',{...change,clientId:'stale-restore'}).code,'CONFLICT');
 assert.equal(f.request('recordRestore',{...change,expectedRevision:1,clientId:'restore-team-row'}).ok,true);
 assert.equal(f.request('recordEdit',{...change,expectedRevision:2,clientId:'unauthorized-edit',changes:{qty:5,project:'SUS'}}).code,'FORBIDDEN');
 f.roster.rows[3][8]=false;
 assert.equal(f.request('recordDelete',{...change,expectedRevision:2,clientId:'revoked-delete'}).code,'FORBIDDEN');
});
test('Access Admin controls all projects and audit edits cannot reduce quantity below confirmed returns',()=>{
 const f=fixture(); const loan=f.request('submitOrder',f.order({project:'Unassigned Project'}));
 googleUser(f,'two','two@student.ateneo.edu');f.trackerTabs.ACCESS.rows.push(['100002','Two','Admin']);
 const account=f.request('googleMember',{idToken:'valid'}).account;assert.equal(account.admin,true);
 assert.equal(f.request('history',{idToken:'valid',scope:'officer'}).records.length,2);
 f.request('returnItems',{idToken:'valid',borrowId:loan.recordIds[0],qty:2,clientId:'admin-returns'});
 const change={idToken:'valid',recordId:loan.recordIds[0],expectedRevision:0,clientId:'admin-edit-row',changes:{qty:1,project:'SUS',committee:'A'}};
 assert.equal(f.request('recordEdit',change).ok,false);
 change.changes.qty=4;assert.equal(f.request('recordEdit',change).ok,true);assert.equal(f.request('recordEdit',change).ok,true);
 const r=f.context.invHistory_().find(r=>r.recordId===loan.recordIds[0]);assert.equal(r.qty,4);assert.equal(r.outstandingQty,2);assert.equal(r.project,'SUS');
 assert.equal(f.tabs.Borrow.rows[2][2],4);assert.equal(f.tabs.Borrow.rows[2][3],'SUS');
 f.trackerTabs.ACCESS.rows[1][2]='Dashboard';
 assert.equal(f.request('recordDelete',{...change,expectedRevision:1,clientId:'not-admin-now'}).code,'FORBIDDEN');
});
test('CBAB membership is read from its explicit roster and duplicate Access records fail closed',()=>{
 const f=fixture();f.trackerTabs.CBAB={getDataRange:()=>({getDisplayValues:()=>[['','','ID num','Full name'],['','','SET'],['','','100002','Two']]})};
 googleUser(f,'two','two@student.ateneo.edu');assert.equal(f.request('googleMember',{idToken:'valid'}).account.projects.includes('CBAB'),true);
 f.trackerTabs.ACCESS.rows.push(['100002','Two','Admin'],['100002','Two','None']);assert.equal(f.request('googleMember',{idToken:'valid'}).code,'ROSTER_MISMATCH');
});

test('Supabase confirmed email identity supports email sign-in without trusting client roles',()=>{
 const f=fixture();f.context.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({id:'email-user',email:'one@student.ateneo.edu',email_confirmed_at:'2026-10-16',identities:[{provider:'email',identity_data:{email:'one@student.ateneo.edu'}}],user_metadata:{admin:true,full_name:'Claimed Admin'}})});
 const account=f.request('googleMember',{idToken:'valid'}).account;assert.equal(account.memberId,'100001');assert.equal(account.admin,false);
});


test('numeric sheet member IDs reconnect without permitting actual reassignment',()=>{
 const f=fixture();assert.equal(f.request('googleMember',{idToken:'one'}).ok,true);
 const row=f.tabs.Accounts.rows[1];row[4]=100001;
 assert.equal(f.request('googleMember',{idToken:'one'}).ok,true);
 row[4]=100002;
 assert.equal(f.request('googleMember',{idToken:'one'}).code,'ROSTER_MISMATCH');
});

