const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cart = require('../cart-model');
const source = fs.readFileSync(require.resolve('../apps-script/inventory-v2.gs'), 'utf8');
function fixture(script = source) {
  let serial = 0, held = false, mail = 0; const stats={emails:[],auth:0,opens:0,reads:{},writes:{},locks:0,images:0,logs:[]};
  const properties = {INVENTORY_SPREADSHEET_ID: 'test', TRACKER_SPREADSHEET_ID: 'roster', SUPABASE_PUBLISHABLE_KEY: 'test-key'};
  const books = {};
  class Sheet {
    constructor(rows = [], width = 12) { this.rows = rows; this.width = width; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(1, ...this.rows.map(r => r.length)); }
    getMaxColumns() { return this.width; }
    getMaxRows(){return 1000;} insertRowsAfter(){}
    insertColumnsAfter(_, n) { this.width += n; }
    hideSheet() {} hideColumns() {} showColumns() {}
    appendRow(row) {stats.writes[this.name]=(stats.writes[this.name] || 0)+1; this.rows.push([...row]); }
    getDataRange() { return this.getRange(1, 1, this.rows.length, this.getLastColumn()); }
    getRange(r, c, n = 1, m = 1) {
      const read = () => {stats.reads[this.name]=(stats.reads[this.name] || 0)+1;return Array.from({length:n}, (_,i) => Array.from({length:m}, (_,j) => this.rows[r+i-1]?.[c+j-1] ?? ''));};
      return {clearDataValidations() {}, clearContent: () => this.getRange(r,c,n,m).setValues(Array.from({length:n},()=>Array(m).fill(''))), getValues: read, getDisplayValues: () => read().map(row => row.map(String)), getValue: () => read()[0][0],
        setValue: value => this.getRange(r,c).setValues([[value]]),
        setValues: values => { if(this.failWrites)throw new Error('Transient sheet failure');stats.writes[this.name]=(stats.writes[this.name] || 0)+1;values.forEach((row,i) => row.forEach((v,j) => { this.rows[r+i-1] ||= []; this.rows[r+i-1][c+j-1] = v; })); }};
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
  Object.keys(tabs).forEach(name=>tabs[name].name=name);
  const book = {getSheetByName: name => tabs[name], insertSheet: name => {const sheet=tabs[name]=new Sheet();sheet.name=name;return sheet;}};
  const roster = new Sheet([[],['Email','ID','Full Name','','','','','','SUS'],['SET'], ['one@student.ateneo.edu','100001','One','','','','','',true], ['two@student.ateneo.edu','100002','Two','','','','','',false]]);
  const trackerTabs={MAIN:roster,ACCESS:new Sheet([['ID Number','Name','Level']])};
  books.test = book; books.roster = {getSheetByName: name => trackerTabs[name]};
  const context = vm.createContext({console:{log:x=>stats.logs.push(x)}, Date, JSON, Number, Object, Array, String,
    PropertiesService: {getScriptProperties: () => ({getProperty: key => properties[key]})},
    SpreadsheetApp: {openById: id => {stats.opens++;return books[id];}, flush: () => {}},
    Utilities: {getUuid: () => 'uuid-' + (++serial),formatDate: date => date.toISOString()},
    Session:{getScriptTimeZone:()=> 'Asia/Manila'},
    DriveApp:{getFileById:()=>{stats.images++;return {getBlob:()=> 'fixture-image'};}},
    LockService: {getScriptLock: () => ({waitLock: () => { assert.equal(held,false); stats.locks++;held = true; }, releaseLock: () => { held = false; }})},
    GmailApp: {sendEmail: (...args) => {assert.equal(held,false); stats.emails.push(args); mail++; }},
    ContentService: {MimeType:{JSON:'json'}, createTextOutput: text => ({setMimeType: () => JSON.parse(text)})},
    UrlFetchApp: {fetch: (_, options) => { if(!options) {stats.images++;return {getBlob:()=> 'fixture-logo'};} stats.auth++;const token = options.headers.Authorization.slice(7), email = token === 'two' ? 'two@student.ateneo.edu' : 'one@student.ateneo.edu'; return {getResponseCode: () => token === 'invalid' ? 400 : 200, getContentText: () => JSON.stringify({id:token, email, email_confirmed_at: token !== 'unverified' ? '2026-10-16' : null, identities:[{provider:'google',identity_data:{email,email_verified:true,full_name:'Test Member'}}]})}; }}
  });
  vm.runInContext(script, context);
  context.setupInventoryV2();
  const request = (action,p={}) => context.doPost({parameter:{action},postData:{contents:JSON.stringify(p)}});
  const item = () => context.invCatalog_()[0];
  const order = (overrides={}) => ({clientId:'client-1000001',idNumber:'100001',caseType:'BORROWING',project:'SUS',committee:'Operations',items:[{id:item().id,title:item().title,location:item().location,qty:3}],...overrides});
  return {context,tabs,request,item,order,roster,trackerTabs,properties,stats,mail:()=>mail};
}
test('one mixed checkout shares identity and reads, preserves separate records and sends receipts outside locks', () => {
  const f=fixture();f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-special']);
  const regular=f.item().id;
  const groups=['BORROWING','CONSUMING'].flatMap(caseType=>[false,true].map(requestOnly=>({clientId:'checkout-'+caseType+'-'+requestOnly,caseType,requestOnly,project:'SUS',committee:'Ops',items:[{id:requestOnly?'ITEM-special':regular,qty:1}]})));
  const before={opens:f.stats.opens,auth:f.stats.auth,catalog:f.stats.reads.Inventory || 0,events:f.stats.reads._MEA_EVENTS || 0,locks:f.stats.locks,images:f.stats.images};
  const result=f.request('checkout',{idToken:'one',idNumber:'forged',groups});
  assert.equal(result.ok,true);assert.equal(result.results.length,4);assert.ok(result.results.every(r=>r.ok));
  assert.equal(f.stats.auth-before.auth,1);assert.equal(f.stats.opens-before.opens,2);assert.equal(f.stats.reads.Inventory-before.catalog,1);
  assert.equal((f.stats.reads._MEA_EVENTS || 0)-before.events,0); // empty journal requires no data-range read
  assert.equal(f.stats.locks-before.locks,2);assert.equal(f.stats.images-before.images,2);assert.equal(f.mail(),2);
  assert.equal(f.tabs._MEA_EVENTS.rows.length,5);assert.equal(f.tabs['Special Requests'].rows.length,3);
  assert.ok(result.timings.totalMs>=0);assert.ok(result.timings.authMs>=0);assert.ok(f.stats.logs.every(s=>!s.includes('student.ateneo.edu')));
  assert.equal(f.request('checkout',{idToken:'one',groups}).results.filter(r=>r.ok).length,4);assert.equal(f.mail(),2);assert.equal(f.tabs._MEA_EVENTS.rows.length,5);
});

test('batch checkout reports partial failure and rejects changed retry data and duplicate groups', () => {
  const f=fixture(), regular=f.item().id;
  const groups=[{clientId:'batch-borrow-001',caseType:'BORROWING',requestOnly:false,items:[{id:regular,qty:1}]},{clientId:'batch-consume-01',caseType:'CONSUMING',requestOnly:false,items:[{id:'removed',qty:1}]}];
  const first=f.request('checkout',{idNumber:'100001',groups});assert.equal(first.ok,true);assert.equal(first.results[0].ok,true);assert.equal(first.results[1].retryable,false);
  groups[1].items[0].id=regular;assert.ok(f.request('checkout',{idNumber:'100001',groups}).results.every(r=>r.ok));assert.equal(f.tabs._MEA_EVENTS.rows.length,3);
  groups[0].items[0].qty=2;assert.equal(f.request('checkout',{idNumber:'100001',groups}).results[0].code,'CHANGED_REQUEST');
  assert.equal(f.request('checkout',{idNumber:'100001',groups:[groups[0],groups[0]]}).ok,false);
  assert.equal(f.request('checkout',{idNumber:'100001',groups:[]}).ok,false);
});

test('verified guest batch ownership ignores forged member IDs and validates each request afresh', () => {
  const f=fixture(), groups=[{...f.order(),requestOnly:false}];f.roster.rows=f.roster.rows.filter(r=>r[1]!=='100001');
  const first=f.request('checkout',{idToken:'guest-one',idNumber:'100002',groups});assert.equal(first.results[0].ok,true);
  const event=JSON.parse(f.tabs._MEA_EVENTS.rows[1][2]);assert.equal(event.idNumber,'guest:guest-one');assert.equal(event.verified,true);
  assert.equal(f.request('checkout',{idToken:'invalid',groups}).code,'UNAUTHORIZED');
  assert.equal(f.request('checkout',{idNumber:'100002',groups}).results[0].ok,false);
});

test('special inventory exposes manual handling and rejects new orders without side effects', () => {
  for (const caseType of ['BORROWING', 'CONSUMING']) {
    const f = fixture();
    f.tabs['Special Inventory'].rows.push(['','Walkie Talkie','6','Brown Cabinet','FIN','','ITEM-special-1']);
    const special = f.context.invCatalog_().find(i => i.id === 'ITEM-special-1');
    assert.equal(special.inventorySection, 'Special Inventory');
    assert.equal(special.requiresManualVerification, true);
    assert.equal(f.item().requiresManualVerification, false);
    const references = f.tabs._MEA_REFERENCES.rows.length;
    const result = f.request('submitOrder', f.order({caseType, items: [{id:f.item().id,qty:1},{id:special.id,qty:1,requiresManualVerification:false}]}));
    assert.equal(result.ok,false); assert.equal(result.code,'MANUAL_VERIFICATION_REQUIRED'); assert.equal(result.retryable,false);
    assert.equal(f.tabs._MEA_EVENTS.rows.length,1); assert.equal(f.tabs._MEA_REFERENCES.rows.length,references); assert.equal(f.mail(),0);
  }
});

test('reclassification blocks stale carts while committed retries and returns remain valid', () => {
  const f=fixture(), payload=f.order();
  const first=f.request('submitOrder',payload); assert.equal(first.ok,true);
  f.tabs['Special Inventory'].rows.push(f.tabs.Inventory.rows.pop());
  assert.equal(f.request('submitOrder',payload).recordIds[0],first.recordIds[0]);
  assert.equal(f.request('submitOrder',{...payload,clientId:'client-reclassified'}).code,'MANUAL_VERIFICATION_REQUIRED');
  assert.equal(f.request('returnItems',{idNumber:'100001',clientId:'client-old-return',borrowId:first.recordIds[0],qty:1}).ok,true);
});

test('saved special cart entries are retained and grouped separately after reconciliation', () => {
  const item={id:'special',qtyDisplay:'6'}, key=cart.key(item.id,'BORROWING');
  const result=cart.reconcile({[key]:{item,qty:2,action:'BORROWING'}},[{...item,inventorySection:'Special Inventory',requiresManualVerification:true}]);
  assert.equal(result[key].qty,2); assert.equal(result[key].unavailable,false);
  assert.equal(cart.requiresManualVerification(result[key].item),true);
  assert.equal(cart.requiresManualVerification({inventorySection:'Special Inventory'}),true);
  assert.equal(cart.requiresManualVerification({}),false);
  assert.equal(cart.availability('6',true).text,'6 recorded · verify with SUS');
  assert.equal(cart.groups(result)[0].requestOnly,true);
});

test('special requests have a separate journal and sheet projection, no emails, and no return balance', () => {
  const f=fixture();
  f.tabs['Special Inventory'].rows.push(['','Walkie Talkie','6','Brown Cabinet','FIN','','ITEM-special-1']);
  const payload=f.order({items:[{id:'ITEM-special-1',qty:2}]});
  const result=f.request('submitSpecialRequest',payload);
  assert.equal(result.ok,true);assert.equal(result.requestOnly,true);assert.equal(result.status,'PENDING');
  assert.equal(f.mail(),0);assert.equal(f.tabs.Borrow.rows.length,2);assert.equal(f.tabs.Consume.rows.length,1);
  assert.equal(f.tabs['Special Requests'].rows.length,2);assert.equal(f.tabs['Special Requests'].rows[1][8],'PENDING');
  assert.match(f.tabs['Special Requests'].rows[1][11],/^SR-/);
  assert.equal(f.request('submitSpecialRequest',payload).recordIds[0],result.recordIds[0]);
  assert.equal(f.tabs['Special Requests'].rows.length,2);assert.equal(f.mail(),0);
  const rec=f.request('history',{idNumber:'100001'}).records[0];
  assert.equal(rec.requestOnly,true);assert.equal(rec.canReturn,false);assert.equal(rec.canDelete,false);
  assert.equal(f.request('returnItems',{idNumber:'100001',borrowId:rec.recordId,qty:1,clientId:'special-return-1'}).ok,false);
  assert.equal(f.request('submitSpecialRequest',f.order({clientId:'regular-request'})).ok,false);
  assert.equal(f.request('submitOrder',f.order({clientId:'regular-receipt'})).ok,true);assert.equal(f.mail(),1);
});

test('only verified admins review special requests with revision checks and immutable retries', () => {
  const f=fixture();f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-special-1']);
  const result=f.request('submitSpecialRequest',f.order({items:[{id:'ITEM-special-1',qty:1}]}));
  const review={idNumber:'100001',recordId:result.recordIds[0],expectedRevision:0,status:'VERIFIED',note:'Count and condition checked',clientId:'special-review-1'};
  assert.equal(f.request('specialRequestReview',review).code,'FORBIDDEN');
  assert.equal(f.request('specialRequestReview',{...review,idToken:'one'}).code,'FORBIDDEN');
  f.trackerTabs.ACCESS.rows.push(['100001','One','Admin']);
  assert.equal(f.request('specialRequestReview',{...review,idToken:'one',expectedRevision:3}).code,'CONFLICT');
  assert.equal(f.request('specialRequestReview',{...review,idToken:'one'}).ok,true);
  assert.equal(f.request('specialRequestReview',{...review,idToken:'one'}).ok,true);
  assert.equal(f.request('specialRequestReview',{...review,idToken:'one',status:'DECLINED'}).code,'CHANGED_REQUEST');
  assert.equal(f.tabs['Special Requests'].rows[1][8],'VERIFIED');assert.equal(f.mail(),1);
  assert.equal(f.request('history',{idToken:'one',scope:'officer'}).records[0].requestStatus,'VERIFIED');
});

test('cart keeps independent actions for one item and rejects malformed quantities', () => {
  const item = {id:'stable-a'};
  const draft = cart.normalize({a:{item,qty:2,action:'BORROWING'},b:{item,qty:1,action:'CONSUMING'},c:{item,qty:2,action:'RETURNING'}});
  assert.equal(Object.keys(draft).length,2); assert.equal(cart.groups(draft).length,2);
  for(const value of [0,-1,1.5,'2 packs','',Infinity,10000,true,[1],{}]) assert.throws(()=>cart.quantity(value));
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
  assert.equal(f.context.invHistory_().length,0);
  f.tabs.Inventory.rows.splice(4,0,['','Other','*','Shelf','Other','','other-id']);
  assert.equal(f.context.invCatalog_().find(i=>i.title==='Markers').id,id);
});
test('old sheet rows and snapshots are untouched and excluded from current transactions',()=>{
 const f=fixture();
 f.tabs.Borrow.rows.push([new Date(),'Archived loan',5,'SUS','','100001','One','',false,'LEGACY-archive',false,false]);
 f.tabs.Consume.rows.push([new Date(),'Archived consumption',2,'SUS','','100001']);
 f.tabs.Return.rows.push([new Date(),'Archived return',1,'SUS','','100001']);
 const before=JSON.stringify(['Borrow','Consume','Return'].map(name=>f.tabs[name].rows.slice(1)));
 const oldLoan=JSON.stringify(f.tabs.Borrow.rows[2]);
 f.tabs._MEA_LEGACY={getLastRow(){throw new Error('Archived snapshots must not be read');}};
 f.context.setupInventoryV2();
 assert.equal(JSON.stringify(['Borrow','Consume','Return'].map(name=>f.tabs[name].rows.slice(1))),before);
 assert.equal(f.context.invHistory_().length,0);
 assert.equal(f.request('history',{idNumber:'100001'}).records.length,0);
 assert.equal(f.request('returnItems',{idNumber:'100001',borrowId:'LEGACY-archive',qty:1,clientId:'archive-return-1'}).ok,false);
 assert.equal(f.context.reconcileLegacyBorrow,undefined);assert.equal(f.context.repairLegacyMetadata,undefined);
 const current=f.request('submitOrder',f.order());assert.equal(current.ok,true);
 assert.equal(f.request('history',{idNumber:'100001'}).records.length,1);
 assert.equal(f.request('returnItems',{idNumber:'100001',borrowId:current.recordIds[0],qty:3,clientId:'current-return-1'}).remaining,0);
 assert.equal(JSON.stringify(f.tabs.Borrow.rows[2]),oldLoan);
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

test('projection failures do not lose journal records; repair does not duplicate rows', () => {
  const f=fixture();
  f.tabs.Borrow.failWrites=true;
  assert.equal(f.request('submitOrder',f.order()).ok,true); assert.equal(f.context.invHistory_().length,1);
  f.tabs.Borrow.failWrites=false; f.context.repairInventoryProjections(); f.context.repairInventoryProjections();
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
  assert.equal(f.request('history',{idNumber:'100001'}).records.length,0);
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

test('shared history never exposes another guest UID and consumed rows cannot be returned',()=>{
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
 assert.equal(f.request('history',{idToken:'valid',scope:'officer'}).records.length,1);
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



test('special borrowing reasons persist in journal, history and cloud drafts with immutable retries',()=>{
 const f=fixture();
 f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-reason']);
 const payload=f.order({items:[{id:'ITEM-reason',qty:1,reason:'For event coordination.'}]});
 assert.equal(f.request('submitSpecialRequest',payload).ok,true);
 assert.equal(f.request('history',{idNumber:'100001'}).records[0].reason,'For event coordination.');
 assert.equal(f.request('submitSpecialRequest',{...payload,items:[{id:'ITEM-reason',qty:1,reason:'Changed reason'}]}).code,'CHANGED_REQUEST');
 const key=cart.key('ITEM-reason','BORROWING');
 const draft=f.context.invValidateDraft_({cart:{[key]:{item:{id:'ITEM-reason'},qty:1,action:'BORROWING',reason:'For event coordination.'}}});
 assert.equal(draft.cart[key].reason,'For event coordination.');
 assert.equal(f.mail(),0);
});

test('verified special loans use normal partial returns and resolve only after full return',()=>{
 const f=fixture();f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-resolution']);
 const loan=f.request('submitSpecialRequest',f.order({items:[{id:'ITEM-resolution',qty:3}]}));
 const id=loan.recordIds[0];
 assert.equal(f.request('history',{idNumber:'100001'}).records[0].resolved,false);
 f.trackerTabs.ACCESS.rows.push(['100001','One','Admin']);
 assert.equal(f.request('specialRequestReview',{idToken:'one',recordId:id,expectedRevision:0,status:'VERIFIED',clientId:'accept-resolution'}).ok,true);
 let r=f.request('history',{idNumber:'100001'}).records[0];assert.equal(r.canReturn,true);assert.equal(r.outstandingQty,3);
 assert.equal(f.request('returnItems',{idNumber:'100002',borrowId:id,qty:1,clientId:'unauthorized-special'}).ok,false);
 const partial={idNumber:'100001',borrowId:id,qty:1,clientId:'partial-special'};
 assert.equal(f.request('returnItems',partial).remaining,2);assert.equal(f.request('returnItems',partial).remaining,2);
 r=f.request('history',{idNumber:'100001'}).records[0];assert.equal(r.resolved,false);assert.equal(r.returnedQty,1);
 assert.equal(f.request('returnItems',{...partial,qty:3,clientId:'excess-special'}).ok,false);
 assert.equal(f.request('returnItems',{...partial,qty:2,clientId:'finish-special'}).remaining,0);
 r=f.request('history',{idNumber:'100001'}).records[0];assert.equal(r.resolved,true);assert.equal(r.canReturn,false);
});

test('declined and verified consuming special requests resolve without allowing returns',()=>{
 for(const [status,action] of [['DECLINED','BORROWING'],['VERIFIED','CONSUMING']]) {
  const f=fixture();f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-close']);
  const loan=f.request('submitSpecialRequest',f.order({caseType:action,items:[{id:'ITEM-close',qty:1}]}));
  f.trackerTabs.ACCESS.rows.push(['100001','One','Admin']);
  assert.equal(f.request('specialRequestReview',{idToken:'one',recordId:loan.recordIds[0],expectedRevision:0,status,clientId:'close-special'}).ok,true);
  const r=f.request('history',{idNumber:'100001'}).records[0];assert.equal(r.resolved,true);assert.equal(r.canReturn,false);
  assert.equal(f.request('returnItems',{idNumber:'100001',borrowId:r.recordId,qty:1,clientId:'closed-return'}).ok,false);
 }
});

test('accepting a special request emails the requester with escaped verifier notes exactly once',()=>{
 const f=fixture();f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-email']);
 const loan=f.request('submitSpecialRequest',f.order({items:[{id:'ITEM-email',qty:2}]}));
 assert.equal(f.mail(),0);
 f.trackerTabs.ACCESS.rows.push(['100002','Two','Admin']);
 const review={idToken:'two',recordId:loan.recordIds[0],expectedRevision:0,status:'VERIFIED',note:'Collect at 3 PM.\nReturn by Friday. <script>alert(1)</script>',clientId:'email-accept'};
 const result=f.request('specialRequestReview',review);assert.equal(result.ok,true);assert.equal(result.emailStatus,'SENT');
 assert.equal(f.mail(),1);const [to,subject,plain,options]=f.stats.emails[0];
 assert.equal(to,'one@student.ateneo.edu');assert.match(subject,/Special request accepted/);
 assert.match(plain,/Collect at 3 PM\.\nReturn by Friday/);assert.match(plain,/Verified by: Two/);
 assert.match(options.htmlBody,/&lt;script&gt;/);assert.doesNotMatch(options.htmlBody,/<script>/);
 assert.match(options.htmlBody,/Radio/);assert.match(options.htmlBody,/SR-/);
 assert.equal(f.request('specialRequestReview',review).ok,true);assert.equal(f.mail(),1);
});
test('declining sends no email and email failure does not undo acceptance',()=>{
 for(const status of ['DECLINED','VERIFIED']) {
  const f=fixture();f.tabs['Special Inventory'].rows.push(['','Radio','6','Cabinet','FIN','','ITEM-fail-email']);
  const loan=f.request('submitSpecialRequest',f.order({items:[{id:'ITEM-fail-email',qty:1}]}));
  f.trackerTabs.ACCESS.rows.push(['100002','Two','Admin']);f.context.GmailApp.sendEmail=()=>{throw Error('Mail quota');};
  const r=f.request('specialRequestReview',{idToken:'two',recordId:loan.recordIds[0],expectedRevision:0,status,note:'Collect tomorrow.',clientId:'email-status'});
  assert.equal(r.ok,true);if(status==='VERIFIED')assert.equal(r.emailStatus,'FAILED');
  assert.equal(f.context.invHistory_().find(r=>r.recordId===loan.recordIds[0]).requestStatus,status);
 }
});

test('normal borrow consume and return emails use the shared transparent-logo receipt format',()=>{
 const f=fixture();
 const loan=f.request('submitOrder',f.order());
 assert.equal(loan.ok,true);
 assert.equal(f.request('submitOrder',f.order({clientId:'format-consume',caseType:'CONSUMING'})).ok,true);
 assert.equal(f.request('returnItems',{idNumber:'100001',borrowId:loan.recordIds[0],qty:1,clientId:'format-return'}).ok,true);
 assert.equal(f.stats.emails.length,3);
 for(const [index,action] of ['Borrow','Consume','Return'].entries()) {
  const [to,subject,plain,options]=f.stats.emails[index];
  assert.equal(to,'one@student.ateneo.edu');assert.equal(subject,'MEA Inventory Receipt — '+action);
  assert.match(options.htmlBody,/cid:meaHeader/);assert.match(options.htmlBody,/width="160"/);
  assert.equal(options.inlineImages.meaHeader,'fixture-logo');
  assert.match(options.htmlBody,new RegExp('MEA INVENTORY '+action.toUpperCase()+' RECEIPT'));
  assert.match(options.htmlBody,/Project\/Dept: SUS/);assert.match(options.htmlBody,/cid:meaFooter/);
  assert.doesNotMatch(plain,/Verifier notes/);
 }
});
