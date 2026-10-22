const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const model = require('../cart-model');
function client() {
 const elements = new Map(), data = new Map(), intervals=[], timers=new Map();let timerId=0;
 function element(id) {
  if (!elements.has(id)) elements.set(id, {value:'',textContent:'',innerHTML:'',hidden:false,open:false,style:{},dataset:{},options:[{value:'SUS'},{value:'Personal'}],
   classList:{add(){},remove(){},toggle(){}},replaceChildren(){this.innerHTML='';this.textContent='';},querySelectorAll(){return [];},querySelector(){return element('focus');},focus(){},addEventListener(){},setAttribute(){},before(){},append(){},showModal(){this.open=true;},close(){this.open=false;}});
  return elements.get(id);
 }
 const document={getElementById:element,activeElement:null,body:element('body'),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},dispatchEvent(){},createElement:()=>element(randomUUID())};
 const context=vm.createContext({document,console,MeaCart:model,crypto:{randomUUID},navigator:{onLine:true,userAgent:'test'},setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:fn=>intervals.push(fn),URLSearchParams,CustomEvent:class{},Event:class{},
  localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},addEventListener(){},matchMedia:()=>({matches:false}),fetch:async()=>({json:async()=>({ok:true}),text:async()=>'{"ok":true}'})});
 context.window=context;
 vm.runInContext(fs.readFileSync(require.resolve('../inventory.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(require.resolve('../workflow.js'),'utf8'),context);
 const run=code=>vm.runInContext(code,context);
 return {context,run,data,element,intervals,timers};
}

function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const inventoryResponse = title => ({ok:true,items:title ? [{id:'a',title,qty:'8',category:'Tools',location:'Room',notes:''}] : []});
function connect(c) { c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount()"); }

test('foreground checkout pauses background reads writes and queue replay and preserves ambiguous retry IDs',async()=>{
 const c=client();connect(c);c.run("state.cart=MeaCart.normalize({a:{item:{id:'a',title:'A'},qty:1,action:'BORROWING'}});verifiedMember={uid:'one'};cloudLoaded=true;draftDirty=true;schoolAuth={currentUser:{getIdToken:async()=> 'one'}}");
 const reply=deferred(),sent=[];c.context.fetch=async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return {json:async()=>await reply.promise};};
 const first=c.context.submitOrder();for(let i=0;i<6;i++)await Promise.resolve();
 await c.context.syncCloudDraft();await c.context.loadCloudDraft();await c.context.flushReturns();c.context.flushPendingOrders();assert.equal(sent.length,1);assert.match(sent[0].url,/checkout/);
 const id=sent[0].body.groups[0].clientId;reply.reject(new TypeError('Response lost'));await first;assert.equal(c.run('Object.values(state.cart)[0].clientId'),id);
 c.context.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push({url,body});return {json:async()=>({ok:true,results:body.groups.map(group=>({clientId:group.clientId,ok:true}))})};};
 await c.context.submitOrder();assert.equal(sent[1].body.groups[0].clientId,id);assert.equal(c.run('Object.keys(state.cart).length'),0);
});

test('late cloud draft read cannot replace a cart edited while the request was in flight',async()=>{
 const c=client();connect(c);c.run("verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'one'}}");
 const response=deferred();c.context.fetch=async()=>({json:async()=>await response.promise});const reading=c.context.loadCloudDraft();for(let i=0;i<5;i++)await Promise.resolve();
 c.run("state.cart=MeaCart.normalize({a:{item:{id:'a'},qty:2,action:'BORROWING'}});saveCart()");
 response.resolve({ok:true,revision:8,draft:{cart:{}}});await reading;assert.equal(c.run('Object.values(state.cart)[0].qty'),2);
});

test('offline batch replay removes successes, separates permanent failures and retains only retryable groups',async()=>{
 const c=client();connect(c);
 const groups=['a','b','c'].map((id,i)=>({clientId:'offline-group-'+id,caseType:i===1?'CONSUMING':'BORROWING',requestOnly:i===2,items:[{id,qty:1}]}));
 c.data.set('mea_pending_orders',JSON.stringify([{clientId:'offline-batch-1',payload:{clientId:'offline-batch-1',idNumber:'100001',groups}}]));
 let calls=0,sent;c.context.fetch=async(url,options)=>{calls++;sent=JSON.parse(options.body);return {text:async()=>JSON.stringify({ok:true,results:sent.groups.map((group,i)=>({clientId:group.clientId,ok:calls>1 || i===0,error:'Fixture failure',retryable:i!==1}))})};};
 c.context.flushPendingOrders();for(let i=0;i<30;i++)await Promise.resolve();
 const pending=JSON.parse(c.data.get('mea_pending_orders')),failed=JSON.parse(c.data.get('mea_failed_orders'));
 assert.equal(pending[0].payload.groups.length,1);assert.equal(pending[0].payload.groups[0].clientId,'offline-group-c');assert.equal(failed[0].payload.groups[0].clientId,'offline-group-b');
 c.intervals[0]();for(let i=0;i<30;i++)await Promise.resolve();assert.equal(sent.groups.length,1);assert.equal(sent.groups[0].clientId,'offline-group-c');assert.equal(JSON.parse(c.data.get('mea_pending_orders')).length,0);
});

test('special item metadata survives loading and item details explain separate requests',async()=>{
 const c=client();connect(c);
 c.context.fetch=async()=>({text:async()=>JSON.stringify({ok:true,items:[{id:'s',title:'Radio',qty:'6',inventorySection:'Special Inventory',requiresManualVerification:true}]})});
 await c.context.loadInventory();assert.equal(c.run('state.inventory[0].requiresManualVerification'),true);
 assert.match(c.element('catalog-container').innerHTML,/Manual verification required/);
 c.context.openItemSheet('s');assert.match(c.element('workflow-body').innerHTML,/Add special request/);assert.match(c.element('workflow-body').innerHTML,/Reason for borrowing/);
});

test('masterfile access guidance applies only to special MEA ID requests',()=>{
 const c=client();connect(c);
 c.run("state.inventory=[{id:'ids',title:'MEA IDs',requiresManualVerification:true},{id:'radio',title:'Radio',requiresManualVerification:true},{id:'ordinary',title:'MEA IDs'}]");
 c.context.openItemSheet('ids');
 assert.match(c.element('workflow-body').innerHTML,/project\/initiative masterfile/);
 assert.match(c.element('workflow-body').innerHTML,/grant the SUS team access/);
 assert.match(c.element('workflow-body').innerHTML,/aria-describedby="special-masterfile-help"/);
 for(const id of ['radio','ordinary']) {
  c.context.openItemSheet(id);
  assert.doesNotMatch(c.element('workflow-body').innerHTML,/masterfile/);
 }
});

test('offline order replay processes only the active owner and moves permanent failures aside immediately',async()=>{
 const c=client();connect(c);
 c.data.set('mea_pending_orders',JSON.stringify([{clientId:'other-owner',payload:{idNumber:'100002'}},{clientId:'mine-fails',payload:{idNumber:'100001'}},{clientId:'mine-special',payload:{idNumber:'100001',requestOnly:true}}]));
 const sent=[];c.context.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push({url,body});return {text:async()=>JSON.stringify(body.clientId==='mine-fails'?{ok:false,retryable:false,error:'Removed item'}:{ok:true})};};
 c.context.flushPendingOrders();for(let i=0;i<25;i++)await Promise.resolve();
 assert.equal(sent.length,2);assert.ok(sent.every(r=>r.body.idNumber==='100001'));assert.match(sent[1].url,/submitSpecialRequest/);
 assert.equal(JSON.parse(c.data.get('mea_pending_orders'))[0].clientId,'other-owner');assert.equal(JSON.parse(c.data.get('mea_failed_orders'))[0].clientId,'mine-fails');
 c.run('state.lastId=null');c.context.flushPendingOrders();for(let i=0;i<5;i++)await Promise.resolve();assert.equal(sent.length,2);
});

test('pending ID-only orders use a current verified token after school sign-in without saving it',async()=>{
 const c=client();connect(c);c.run("state.lastId.verified=true;verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'current-token'}}");
 c.data.set('mea_pending_orders',JSON.stringify([{clientId:'mine-upgraded',payload:{idNumber:'100001'}}]));
 let sent;c.context.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {text:async()=>'{"ok":true}'};};
 c.context.flushPendingOrders();for(let i=0;i<20;i++)await Promise.resolve();assert.equal(sent.idToken,'current-token');assert.doesNotMatch(c.data.get('mea_pending_orders'),/current-token/);
});

test('mixed ordinary and special checkout uses one endpoint and preserves failed requests',async()=>{
 const c=client();connect(c);c.run("state.cart=MeaCart.normalize({a:{item:{id:'a',title:'Markers'},qty:1,action:'BORROWING'},s:{item:{id:'s',title:'Radio',requiresManualVerification:true},qty:2,action:'BORROWING'}});verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'one'}}");
 const calls=[];c.context.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return {json:async()=>({ok:true,results:body.groups.map(group=>({clientId:group.clientId,ok:!group.requestOnly,error:group.requestOnly?'Needs setup':undefined,retryable:false}))})};};
 await c.context.submitOrder();assert.equal(calls.length,1);assert.match(calls[0].url,/checkout/);
 assert.equal(calls[0].body.groups.length,2);assert.equal(calls[0].body.groups[1].items[0].id,'s');assert.equal(c.run('Object.values(state.cart).length'),1);
 assert.match(c.element('cart-feedback').textContent,/Special request.*Failed/);
});

test('restoring an older cloud or device cart retains fresh special inventory classification',async()=>{
 const c=client();connect(c);c.context.fetch=async()=>({text:async()=>JSON.stringify({ok:true,items:[{id:'s',title:'Radio',qty:'6',requiresManualVerification:true,inventorySection:'Special Inventory'}]})});
 await c.context.loadInventory();
 const draft={cart:{s:{item:{id:'s',title:'Radio'},qty:2,action:'BORROWING'}}};
 c.context.applyCloudDraft({draft,revision:1});assert.equal(c.run('MeaCart.groups(state.cart)[0].requestOnly'),true);
 c.data.set('mea_cart_v3:100001',JSON.stringify(draft));c.run('meaSwitchAccount()');assert.equal(c.run('MeaCart.groups(state.cart)[0].requestOnly'),true);
});

test('special requests stay outside normal transaction history and cannot expose return or edit controls',()=>{
 const c=client();connect(c);c.context.paintHistory({records:[{idNum:'100001',recordId:'s',item:'Radio',qty:2,caseType:'SPECIAL_REQUEST',requestOnly:true,requestStatus:'PENDING',requestedAction:'BORROWING',canReview:true}],projects:[],admin:true});
 assert.match(c.element('history-special-list').innerHTML,/Awaiting verification/);assert.match(c.element('history-special-list').innerHTML,/Review request/);
 assert.doesNotMatch(c.element('history-pending-list').innerHTML,/Radio/);assert.doesNotMatch(c.element('history-total-list').innerHTML,/Radio/);
 assert.doesNotMatch(c.element('history-special-list').innerHTML,/Return items|Edit record/);
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount()");assert.equal(c.element('history-special-list').innerHTML,'');
});

test('startup and catalog share one inventory request and fresh navigation keeps rendered content',async()=>{
 const c=client();connect(c);const response=deferred();let calls=0;
 c.context.fetch=async()=>{calls++;return {text:async()=>JSON.stringify(await response.promise)};};
 const first=c.context.loadInventory(),second=c.context.loadInventory();
 await Promise.resolve();assert.equal(calls,1);
 response.resolve(inventoryResponse('Ready item'));await Promise.all([first,second]);
 assert.match(c.element('catalog-container').innerHTML,/Ready item/);
 await c.context.loadInventory();assert.equal(calls,1);assert.doesNotMatch(c.element('catalog-container').innerHTML,/skeleton/);
});

test('saved inventory paints before a slow forced refresh and a successful empty catalog clears it',async()=>{
 const c=client();connect(c);c.context.fetch=async()=>({text:async()=>JSON.stringify(inventoryResponse('Saved item'))});await c.context.loadInventory();
 const reload=client();for(const [k,v] of c.data)reload.data.set(k,v);connect(reload);
 const response=deferred();reload.context.fetch=async()=>({text:async()=>JSON.stringify(await response.promise)});
 const loading=reload.context.loadInventory({force:true});assert.match(reload.element('catalog-container').innerHTML,/Saved item/);assert.doesNotMatch(reload.element('catalog-container').innerHTML,/skeleton/);
 response.resolve(inventoryResponse(''));await loading;assert.equal(reload.run('state.inventory.length'),0);assert.doesNotMatch(reload.element('catalog-container').innerHTML,/Saved item/);
});

test('old inventory responses cannot overwrite another endpoint or a newer invalidation',async()=>{
 const c=client();connect(c);const response=deferred();c.context.fetch=async()=>({text:async()=>JSON.stringify(await response.promise)});
 const old=c.context.loadInventory();await Promise.resolve();c.data.set('mea_inventory_url','https://other.test');
 c.context.fetch=async()=>({text:async()=>JSON.stringify(inventoryResponse('New endpoint'))});await c.context.loadInventory();response.resolve(inventoryResponse('Wrong endpoint'));await old;
 assert.match(c.element('catalog-container').innerHTML,/New endpoint/);assert.doesNotMatch(c.element('catalog-container').innerHTML,/Wrong endpoint/);
 const stale=deferred();c.context.fetch=async()=>({text:async()=>JSON.stringify(await stale.promise)});const pending=c.context.loadInventory({force:true});await Promise.resolve();
 c.context.invalidateReadData();c.context.fetch=async()=>({text:async()=>JSON.stringify(inventoryResponse('After mutation'))});await c.context.loadInventory();stale.resolve(inventoryResponse('Before mutation'));await pending;
 assert.match(c.element('catalog-container').innerHTML,/After mutation/);
});

test('inventory network failures retain saved content, allow retry, and never become fresh successes',async()=>{
 const c=client();connect(c);c.context.fetch=async()=>({text:async()=>JSON.stringify(inventoryResponse('Saved item'))});await c.context.loadInventory();
 c.context.fetch=async()=>{throw new TypeError('Offline');};await c.context.loadInventory({force:true});assert.match(c.element('catalog-container').innerHTML,/Saved item/);assert.match(c.element('catalog-sync').textContent,/saved copy/i);
 c.context.fetch=async()=>({text:async()=>JSON.stringify(inventoryResponse('Recovered'))});await c.context.loadInventory();assert.match(c.element('catalog-container').innerHTML,/Recovered/);
});

test('history cache paints before revalidation and prefetch shares the navigation request',async()=>{
 const c=client();connect(c);let calls=0;c.context.fetch=async()=>({json:async()=>({ok:true,records:[{recordId:'r',idNum:'100001',item:'Saved loan',caseType:'BORROWING',qty:1}],projects:['SUS']})});await c.context.renderHistory();
 const slow=deferred();c.context.fetch=async()=>{calls++;return {json:async()=>await slow.promise};};
 const preload=c.context.prefetchHistory({force:true}),render=c.context.renderHistory();await Promise.resolve();assert.equal(calls,1);assert.match(c.element('history-pending-list').innerHTML,/Saved loan/);
 slow.resolve({ok:true,records:[],projects:['SUS']});await Promise.all([preload,render]);assert.doesNotMatch(c.element('history-pending-list').innerHTML,/Saved loan/);
});

test('switching away and back rejects old history and does not cache its response',async()=>{
 const c=client();connect(c);const slow=deferred();c.context.fetch=async()=>({json:async()=>await slow.promise});const pending=c.context.renderHistory();await Promise.resolve();
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount();state.lastId={idNumber:'100001'};meaSwitchAccount()");
 slow.resolve({ok:true,records:[{recordId:'r',idNum:'100001',item:'Stale private loan',caseType:'BORROWING',qty:1}],projects:['SUS']});await pending;
 c.context.navigator.onLine=false;await c.context.renderHistory();assert.doesNotMatch(c.element('history-pending-list').innerHTML,/Stale private loan/);
});

test('history authorization denial evicts saved data instead of restoring it offline',async()=>{
 const c=client();connect(c);c.context.fetch=async()=>({json:async()=>({ok:true,records:[{recordId:'r',idNum:'100001',item:'Private loan',caseType:'BORROWING',qty:1}],projects:[]})});await c.context.renderHistory();
 c.context.fetch=async()=>({json:async()=>({ok:false,error:'Denied',code:'UNAUTHORIZED',retryable:false})});await c.context.renderHistory({force:true});assert.match(c.element('history-pending-list').innerHTML,/Denied/);
 c.context.navigator.onLine=false;await c.context.renderHistory();assert.doesNotMatch(c.element('history-pending-list').innerHTML,/Private loan/);assert.equal(c.context.meaHistoryRecords.length,0);
});

test('inventory expires after 30 seconds while history expires after 15 seconds',async()=>{
 const c=client();connect(c);let time=100000,catalog=0,history=0;c.context.Date=class extends Date {static now(){return time;}};
 c.context.fetch=async (url,options)=>url.includes('inventory')?(catalog++,{text:async()=>JSON.stringify(inventoryResponse('Item'))}):(history++,{json:async()=>({ok:true,records:[],projects:[]})});
 await c.context.loadInventory();await c.context.renderHistory();time+=14999;await c.context.loadInventory();await c.context.renderHistory();assert.equal(catalog,1);assert.equal(history,1);
 time++;await c.context.renderHistory();assert.equal(history,2);await c.context.loadInventory();assert.equal(catalog,1);
 time+=15000;await c.context.loadInventory();assert.equal(catalog,2);
});

test('a revision changed in another tab prevents fresh in-memory history from being reused',async()=>{
 const c=client();connect(c);let calls=0;c.context.fetch=async()=>({json:async()=>({ok:true,records:[{recordId:'r',idNum:'100001',item:++calls===1?'Before change':'After change',caseType:'BORROWING',qty:1}],projects:[]})});
 await c.context.renderHistory();c.data.set('mea_read_revision','another-tab-mutation');await c.context.renderHistory();assert.match(c.element('history-pending-list').innerHTML,/After change/);
});

test('an old project response cannot change the selected project or overwrite its records',async()=>{
 const c=client();connect(c);c.run("state.historyTab='project'");c.element('history-project-select').value='SUS';const slow=deferred();
 c.context.fetch=async()=>({json:async()=>await slow.promise});const old=c.context.renderHistory();c.element('history-project-select').value='STEPS';
 c.context.fetch=async()=>({json:async()=>({ok:true,projects:['SUS','STEPS'],records:[{recordId:'s',item:'Steps item',project:'STEPS',caseType:'CONSUMING',qty:1}]})});await c.context.renderHistory();
 slow.resolve({ok:true,projects:['SUS'],records:[{recordId:'r',item:'Sus item',project:'SUS',caseType:'CONSUMING',qty:1}]});await old;
 assert.equal(c.element('history-project-select').value,'STEPS');assert.match(c.element('history-total-list').innerHTML,/Steps item/);assert.doesNotMatch(c.element('history-total-list').innerHTML,/Sus item/);
});

test('confirmed checkout invalidates inventory and history even inside their freshness windows',async()=>{
 const c=client();connect(c);let catalog=0,history=0;
 c.context.fetch=async (url,options)=>url.includes('inventory')?{text:async()=>JSON.stringify(inventoryResponse(++catalog===1?'Before checkout':'After checkout'))}:url.includes('checkout')?{text:async()=>JSON.stringify({ok:true,results:JSON.parse(options.body).groups.map(group=>({clientId:group.clientId,ok:true}))})}:{json:async()=>({ok:true,records:[],projects:[],revision:++history})};
 await c.context.loadInventory();await c.context.renderHistory();c.run("state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'Item'},qty:1,action:'BORROWING'};");
 await c.context.submitOrder();await c.context.loadInventory();await c.context.renderHistory();assert.equal(catalog,2);assert.equal(history,2);
});

test('an offline cold start never offers demo inventory and malformed storage does not prevent retry',async()=>{
 const c=client();connect(c);c.data.set('mea_inventory_cache','{"items":[{"id":"wrong","title":"Legacy demo"}]}');c.context.navigator.onLine=false;
 await c.context.loadInventory();assert.equal(c.run('state.inventory.length'),0);assert.doesNotMatch(c.element('catalog-container').innerHTML,/demo items|Legacy demo|Safety Vest/);
 c.context.navigator.onLine=true;c.context.fetch=async()=>({text:async()=>JSON.stringify(inventoryResponse('Recovered'))});await c.context.loadInventory();assert.match(c.element('catalog-container').innerHTML,/Recovered/);
});

test('replaying multiple returns refreshes visible History once after the queue drains',async()=>{
 const c=client();connect(c);let reads=0,writes=0;
 c.context.fetch=async url=>({json:async()=>url.includes('returnItems')?(writes++,{ok:true}):(reads++,{ok:true,records:[],projects:[]})});
 c.run("state.view='history';writeLocal(returnKey(),[{clientId:'return-100001',borrowId:'r',qty:1},{clientId:'return-100002',borrowId:'s',qty:1}])");
 await c.context.renderHistory();await c.context.flushReturns();await new Promise(setImmediate);
 assert.equal(writes,2);assert.equal(reads,2);assert.equal(c.run('pendingReturns().length'),0);
});

test('a return completed after account switch restarts the current account read instead of leaving skeletons',async()=>{
 const c=client();connect(c);const returned=deferred(),oldHistory=deferred();let reads=0;
 c.context.fetch=async url=>({json:async()=>url.includes('returnItems')?await returned.promise:++reads===1?await oldHistory.promise:{ok:true,records:[{recordId:'b',idNum:'100002',item:'Current account loan',caseType:'BORROWING',qty:1}],projects:[]}});
 c.run("writeLocal(returnKey(),[{clientId:'return-100001',borrowId:'r',qty:1}])");const replay=c.context.flushReturns();await Promise.resolve();
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount();state.view='history'");const pending=c.context.renderHistory();await new Promise(setImmediate);
 returned.resolve({ok:true});await replay;await new Promise(setImmediate);oldHistory.resolve({ok:true,records:[],projects:[]});await pending;
 assert.match(c.element('history-pending-list').innerHTML,/Current account loan/);assert.doesNotMatch(c.element('history-pending-list').innerHTML,/skeleton/);
});

test('History keeps its in-memory snapshot visible when device storage is full',async()=>{
 const c=client();connect(c);c.context.localStorage.setItem=()=>{throw new Error('Quota exceeded');};
 c.context.fetch=async()=>({json:async()=>({ok:true,records:[{recordId:'r',idNum:'100001',item:'Memory loan',caseType:'BORROWING',qty:1}],projects:[]})});await c.context.renderHistory();
 const slow=deferred();c.context.fetch=async()=>({json:async()=>await slow.promise});const pending=c.context.renderHistory({force:true});
 assert.match(c.element('history-pending-list').innerHTML,/Memory loan/);assert.doesNotMatch(c.element('history-pending-list').innerHTML,/skeleton/);
 slow.resolve({ok:true,records:[],projects:[]});await pending;
});

test('Home prefetch reads only the selected server-authorized project after Personal History',async()=>{
 const c=client();connect(c);c.element('history-project-select').value='SUS';const scopes=[];
 c.context.fetch=async(_url,options)=>{const p=JSON.parse(options.body);scopes.push([p.scope,p.project]);return {json:async()=>({ok:true,records:[],projects:['SUS','STEPS']})};};
 await c.context.prefetchHistory();assert.deepEqual(scopes,[['personal',''],['project','SUS']]);
 c.context.invalidateReadData();c.element('history-project-select').value='Private Project';scopes.length=0;await c.context.prefetchHistory();assert.deepEqual(scopes,[['personal','']]);
});

test('old cached history does not reappear after the fresh transaction rollout',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount()");
 const key=c.context.historyCacheKey();assert.match(key,/mea_history_cache_v4:/);
 c.data.set(key.replace('v4:','v3:'),JSON.stringify({records:[{recordId:'LEGACY-old',idNum:'100001',caseType:'BORROWING',item:'Archived item'}],syncedAt:1}));
 c.context.navigator.onLine=false;await c.context.renderHistory();
 assert.doesNotMatch(c.element('history-pending-list').innerHTML,/Archived item/);assert.equal(c.context.meaHistoryRecords.length,0);
});

test('drafts and checkout fields survive reload and stay separated on logout/account switch',()=>{
 const c=client(); c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount(); state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'A'},qty:2,action:'BORROWING'};");
 c.element('project-select').value='SUS';c.element('committee-input').value='Operations';c.run('saveCart()');
 c.run("state.lastId={idNumber:'100002'}; meaSwitchAccount()");
 assert.equal(c.run('Object.keys(state.cart).length'),0);assert.equal(c.element('committee-input').value,'');
 c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount()");
 assert.equal(c.run('Object.values(state.cart)[0].qty'),2);assert.equal(c.element('committee-input').value,'Operations');
 c.run('meaBeforeLogout(); performLogout()');assert.equal(c.run('Object.keys(state.cart).length'),0);
});
test('mixed action checkout preserves rejected group and clears only submitted group',async()=>{
 const c=client();c.run("state.lastId={idNumber:'100001',name:'One'}; meaSwitchAccount(); for(const action of MeaCart.actions)state.cart[MeaCart.key('a',action)]={item:{id:'a',title:'A'},qty:1,action};");
 c.element('project-select').value='SUS';
 c.context.google={script:{run:{withSuccessHandler(ok){return {withFailureHandler(fail){return {checkout(p){ok({ok:true,results:p.groups.map(group=>({clientId:group.clientId,ok:group.caseType!=='CONSUMING',error:'Rejected',retryable:false}))}); }};}};}}}};
 await c.context.submitOrder();
 assert.equal(c.run('Object.keys(state.cart).length'),1); assert.equal(c.run('Object.values(state.cart)[0].action'),'CONSUMING');
 assert.match(c.element('cart-feedback').textContent,/Borrow: Submitted.*Consume: Failed/);
});
test('offline submission keeps fixed retry ID and refuses to clear draft if queue cannot persist',async()=>{
 const c=client();c.context.navigator.onLine=false;c.data.set('mea_inventory_url','https://example.test');
 c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'A'},qty:1,action:'BORROWING'};");
 await c.context.submitOrder();
 assert.equal(c.run('Object.keys(state.cart).length'),0);const queued=JSON.parse(c.data.get('mea_pending_orders'));assert.equal(queued[0].clientId,queued[0].payload.clientId);
 const d=client();d.context.navigator.onLine=false;d.data.set('mea_inventory_url','https://example.test');
 d.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'A'},qty:1,action:'BORROWING'};");
 const set=d.context.localStorage.setItem;d.context.localStorage.setItem=(k,v)=>{if(k==='mea_pending_orders')throw new Error('Quota');set(k,v);};
 await d.context.submitOrder();assert.equal(d.run('Object.keys(state.cart).length'),1);assert.match(d.element('cart-feedback').textContent,/Failed/);
});
test('cloud conflict never overwrites local draft without a choice',async()=>{
 const c=client();let choose;c.context.meaSignInLoading={status:(_,label,action)=>{if(label==='Choose cart')choose=action;}};c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'token'}};state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:2,action:'BORROWING'};draftDirty=true;");
 c.data.set('mea_inventory_url','https://example.test');
 c.context.fetch=async()=>({json:async()=>({ok:true,revision:4,draft:{cart:{},project:'SUS',committee:'Cloud'}})});
 await c.context.loadCloudDraft();
 assert.equal(c.run('Object.values(state.cart)[0].qty'),2);assert.equal(c.run('cloudConflict'),true);assert.equal(c.element('workflow-dialog').open,false);
 choose();assert.equal(c.element('workflow-dialog').open,true);
 c.element('use-cloud').onclick();assert.equal(c.run('Object.keys(state.cart).length'),0);assert.equal(c.element('committee-input').value,'Cloud');
});
test('late cloud response cannot load previous account cart into a newly selected member',async()=>{
 const c=client();c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'token'}};");c.data.set('mea_inventory_url','https://example.test');
 let resolve; c.context.fetch=()=>new Promise(r=>resolve=r);
 const pending=c.context.loadCloudDraft();await new Promise(r=>setImmediate(r));
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount()");
 resolve({json:async()=>({ok:true,revision:3,draft:{cart:{},committee:'Previous owner'}})});await pending;
 assert.equal(c.element('committee-input').value,'');assert.equal(c.run('cloudLoaded'),false);
});


test('cart action switch preserves quantity, saves the draft and invalidates both retry groups',()=>{
 const c=client();c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount(); state.cart[MeaCart.key('a','CONSUMING')]={item:{id:'a',title:'A'},qty:3,action:'CONSUMING',clientId:'old'}; state.cart[MeaCart.key('b','BORROWING')]={item:{id:'b',title:'B'},qty:1,action:'BORROWING',clientId:'other'}; changeCartAction(MeaCart.key('a','CONSUMING'),'BORROWING');");
 assert.equal(c.run("state.cart[MeaCart.key('a','CONSUMING')]"),undefined);
 assert.equal(c.run("state.cart[MeaCart.key('a','BORROWING')].qty"),3);
 assert.equal(c.run('Object.values(state.cart).some(l=>l.clientId)'),false);
 assert.equal(Object.values(JSON.parse(c.data.get('mea_cart_v3:100001')).cart).find(l=>l.item.id==='a').action,'BORROWING');
 c.run("changeCartAction(MeaCart.key('a','BORROWING'),'CONSUMING')");
 assert.equal(c.run("state.cart[MeaCart.key('a','CONSUMING')].qty"),3);
});
test('cart action collision requires confirmation and cannot combine into another account',()=>{
 const c=client();c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount(); for(const action of MeaCart.actions)state.cart[MeaCart.key('a',action)]={item:{id:'a',title:'A'},qty:2,action}; changeCartAction(MeaCart.key('a','CONSUMING'),'BORROWING');");
 assert.equal(c.run('Object.keys(state.cart).length'),2);
 c.element('cancel-combine').onclick();assert.equal(c.run('Object.keys(state.cart).length'),2);
 c.run("changeCartAction(MeaCart.key('a','CONSUMING'),'BORROWING')");c.element('combine-cart').onclick();
 assert.equal(c.run('Object.keys(state.cart).length'),1);assert.equal(c.run('Object.values(state.cart)[0].qty'),4);
 c.run("state.cart[MeaCart.key('a','CONSUMING')]={item:{id:'a',title:'A'},qty:1,action:'CONSUMING'}; changeCartAction(MeaCart.key('a','CONSUMING'),'BORROWING'); state.lastId={idNumber:'100002'}; meaSwitchAccount();");
 c.element('combine-cart').onclick();assert.equal(c.run('Object.keys(state.cart).length'),0);
});

test('guest submits use current Google token without persisting it in an order queue',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');
 c.run("state.lastId={idNumber:'guest:one',name:'Guest',accountKind:'GUEST',guestCode:'G-001',verified:true};meaSwitchAccount();verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'private-token'}};state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'A'},qty:1,action:'BORROWING'};");
 let sent;c.context.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {json:async()=>({ok:true,results:sent.groups.map(group=>({clientId:group.clientId,ok:true}))})};};
 await c.context.submitOrder();assert.equal(sent.idToken,'private-token');assert.equal(sent.idNumber,'guest:one');
 assert.equal(c.run('Object.keys(state.cart).length'),0);
 for(const value of c.data.values())assert.equal(value.includes('private-token'),false);
});
test('guest cannot silently fall back to ID-only submissions and history',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');
 c.run("state.lastId={idNumber:'guest:one',accountKind:'GUEST',verified:true};meaSwitchAccount();state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'A'},qty:1,action:'BORROWING'};");
 await c.context.submitOrder();assert.equal(c.run('Object.keys(state.cart).length'),1);assert.match(c.element('cart-feedback').textContent,/Reconnect/);
 await assert.rejects(c.context.meaHistoryRequest('personal',''),/Reconnect/);
});

test('project history works for ID-only members and shows owned return actions',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount();state.historyTab='project'");c.element('history-project-select').value='SUS';
 c.context.fetch=async()=>({json:async()=>({ok:true,projects:['SUS','Old Dept'],records:[{recordId:'loan',item:'A',idNum:'100001',project:' sus  ',caseType:'BORROWING',qty:3,borrowedQty:3,returnedQty:1,returnable:true,canReturn:true,resolved:false}]})});
 await c.context.renderHistory();assert.match(c.element('history-pending-list').innerHTML,/>Return<\/button>/);assert.match(c.element('history-project-select').innerHTML,/Old Dept/);
 c.context.openReturnSheet('loan');assert.equal(c.element('workflow-dialog').open,true);
});
test('authorization errors clear stale records and do not masquerade as offline history',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount();window.meaHistoryRecords=[{recordId:'stale'}]");
 c.context.fetch=async()=>({json:async()=>({ok:false,error:'Session expired. Reconnect.',code:'UNAUTHORIZED',retryable:false})});
 await c.context.renderHistory();assert.match(c.element('history-pending-list').innerHTML,/Session expired/);assert.doesNotMatch(c.element('history-pending-list').innerHTML,/offline|last synced/);assert.equal(c.context.meaHistoryRecords.length,0);
});
test('officer return dialog accepts server-authorized records but keeps quantity and consume guards',()=>{
 const c=client();c.run("state.lastId={idNumber:'100002',verified:true};meaSwitchAccount();verifiedMember={uid:'officer',officer:true};window.meaHistoryRecords=[{recordId:'loan',item:'A',name:'Borrower',idNum:'100001',caseType:'BORROWING',qty:3,borrowedQty:3,returnedQty:1,canReturn:true,returnable:true}]");
 c.context.openReturnSheet('loan');assert.match(c.element('workflow-body').innerHTML,/Borrower/);
 assert.throws(()=>model.validateReturn({recordId:'x',idNum:'other',caseType:'CONSUMING'},1,'officer',true));
 assert.throws(()=>model.validateReturn({recordId:'x',idNum:'other',caseType:'BORROWING',qty:2},3,'officer',true));
});

test('logout suppresses automatic OAuth restoration even if remote sign-out fails offline',()=>{
 const c=client();c.run("state.lastId={idNumber:'100001'};meaSwitchAccount();schoolAuth={signOut:async()=>{throw new Error('Offline')}};meaBeforeLogout()");
 assert.equal(JSON.parse(c.data.get('mea_google_signed_out')),true);
});

test('project selectors retain normalized selection and deleted records have a separate view',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount();state.historyTab='project'");c.element('history-project-select').value=' sus  ';
 const records=[{recordId:'deleted',item:'Deleted item',idNum:'100001',project:'SUS',caseType:'CONSUMING',qty:1,resolved:true,deleted:true,canDelete:true},{recordId:'active',item:'Active item',idNum:'100001',project:'SUS',caseType:'CONSUMING',qty:1,resolved:true}];
 c.context.fetch=async()=>({json:async()=>({ok:true,projects:['SUS'],records})});await c.context.renderHistory();
 assert.equal(c.element('history-project-select').value,'SUS');assert.match(c.element('history-total-list').innerHTML,/Active item/);assert.doesNotMatch(c.element('history-total-list').innerHTML,/Deleted item/);
 c.run('state.historyShowDeleted=true');await c.context.renderHistory();assert.match(c.element('history-total-list').innerHTML,/Deleted item/);assert.match(c.element('history-total-list').innerHTML,/Restore/);
});
test('record deletion uses verified token, stable retry ID and server revision while leaving balances to the server',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001',verified:true};meaSwitchAccount();verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'verified-token'}};window.meaHistoryRecords=[{recordId:'r',reference:'BR-001',item:'A',project:'SUS',qty:3,canDelete:true,recordRevision:4}]");
 let sent;c.context.fetch=async(url,options)=>{const p=JSON.parse(options.body);if(url.includes('recordDelete')){sent=p;return {json:async()=>({ok:false,error:'Refresh first',code:'CONFLICT',retryable:false})};}return {json:async()=>({ok:true,records:[],projects:['SUS']})};};
 c.context.openRecordChange('delete','r');await c.element('record-confirm').onclick();const first=sent.clientId;assert.equal(sent.expectedRevision,4);assert.equal(sent.idToken,'verified-token');assert.match(c.element('record-error').textContent,/Refresh/);
 await c.element('record-confirm').onclick();assert.equal(sent.clientId,first);
});
test('a claimed client admin role cannot reveal editing when the server capability is absent',()=>{
 const c=client();c.run("state.lastId={idNumber:'100001',level:'ADMIN'};meaSwitchAccount();window.meaHistoryRecords=[{recordId:'r',item:'A',canEdit:false,canDelete:false}]");
 c.context.openRecordChange('edit','r');assert.equal(c.element('workflow-dialog').open,false);
});


test('school restoration upgrades ID-only identity and permissions before syncing drafts',async()=>{
 const c=client();c.run("state.lastId={idNumber:'100001',name:'One'};meaSwitchAccount();inventoryRequest=async()=>({member:{idNumber:'100001',name:'One',level:'ADMIN',accountKind:'MEMBER'},account:{uid:'uid-one',admin:true,projects:['SUS']}});loadCloudDraft=async()=>{};");
 await c.context.restoreSchoolAccount({uid:'uid-one'});
 assert.equal(c.run('state.lastId.verified'),true);assert.equal(c.run('state.lastId.level'),'ADMIN');assert.equal(c.run('verifiedMember.admin'),true);
 assert.match(c.element('home-identity-id').textContent,/Verified member/);
});
test('server identity failures stay visible without upgrading an ID-only account',async()=>{
 const c=client();c.run("state.lastId={idNumber:'100001',name:'One'};meaSwitchAccount();inventoryRequest=async()=>{throw new Error('Member roster unavailable');};");
 await c.context.restoreSchoolAccount({uid:'uid-one'});
 assert.equal(c.run('state.lastId.verified'),undefined);assert.match(c.element('school-auth-error').textContent,/Member roster unavailable/);
 assert.equal(c.element('workflow-dialog').open,true);
});

 test('account options clear verified access and preserve the old cart before ID-only entry',async()=>{
 const c=client();c.run("state.lastId={idNumber:'100001',verified:true,email:'one@student.ateneo.edu'};meaSwitchAccount();state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:2,action:'BORROWING'};verifiedMember={uid:'one'}");
 await c.context.changeAccount('id');
 assert.equal(c.run('state.lastId'),null);assert.equal(c.run('verifiedMember'),null);
 assert.equal(c.run('state.view'),'login');assert.equal(JSON.parse(c.data.get('mea_google_signed_out')),true);
 assert.equal(Object.values(JSON.parse(c.data.get('mea_cart_v3:100001')).cart)[0].qty,2);
 });
 test('changing Google account waits for sign-out before opening sign-in',async()=>{
 const c=client();let finish;let opened=false;c.context.finishSignOut=()=>new Promise(r=>finish=r);c.context.openSignIn=()=>{opened=true;};
 c.run("schoolAuth={signOut:finishSignOut};connectGoogle=openSignIn");const pending=c.context.changeAccount('google');
 assert.equal(opened,false);finish();await pending;assert.equal(opened,true);
 });

test('failed sign-out does not start Google account switching or restore verified access',async()=>{
 const c=client();let opened=false;c.context.openSignIn=()=>{opened=true;};
 c.run("state.lastId={idNumber:'100001',verified:true};meaSwitchAccount();schoolAuth={signOut:async()=>{throw new Error('Offline')}};connectGoogle=openSignIn");
 await c.context.changeAccount('google');assert.equal(opened,false);assert.equal(c.run('state.lastId'),null);assert.equal(JSON.parse(c.data.get('mea_google_signed_out')),true);
});


test('switching each cart row repeatedly preserves display and saved order across reload',()=>{
 const c=client();
 c.run("state.lastId={idNumber:'100001'};meaSwitchAccount();for(const id of ['a','b','c'])state.cart[MeaCart.key(id,'BORROWING')]={item:{id,title:id},qty:2,action:'BORROWING'}");
 for(const id of ['a','b','c']) for(const action of ['CONSUMING','BORROWING','CONSUMING']) {
  c.run(`changeCartAction(MeaCart.key('${id}',state.cart[Object.keys(state.cart).find(k=>state.cart[k].item.id==='${id}')].action),'${action}')`);
  assert.equal(c.run('Object.values(state.cart).map(l=>l.item.id).join()'),'a,b,c');
  assert.equal(Object.values(JSON.parse(c.data.get('mea_cart_v3:100001')).cart).map(l=>l.item.id).join(),'a,b,c');
 }
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount();state.lastId={idNumber:'100001'};meaSwitchAccount()");
 assert.equal(c.run('Object.values(state.cart).map(l=>l.item.id).join()'),'a,b,c');
});

test('confirmed action merges keep the destination position before or after the source',()=>{
 for(const destinationFirst of [true,false]) {
  const c=client();
  c.run(`state.lastId={idNumber:'100001'};meaSwitchAccount();
   for(const [id,action] of ${JSON.stringify(destinationFirst ? [['a','BORROWING'],['b','BORROWING'],['a','CONSUMING'],['c','BORROWING']] : [['a','CONSUMING'],['b','BORROWING'],['a','BORROWING'],['c','BORROWING']])})state.cart[MeaCart.key(id,action)]={item:{id,title:id},qty:2,action};
   changeCartAction(MeaCart.key('a','CONSUMING'),'BORROWING')`);
  assert.equal(c.run('Object.keys(state.cart).length'),4);
  c.element('combine-cart').onclick();
  const expected=destinationFirst?'a,b,c':'b,a,c';
  assert.equal(c.run('Object.values(state.cart).map(l=>l.item.id).join()'),expected);
  assert.equal(c.run("state.cart[MeaCart.key('a','BORROWING')].qty"),4);
  assert.equal(Object.values(JSON.parse(c.data.get('mea_cart_v3:100001')).cart).map(l=>l.item.id).join(),expected);
 }
});

test('returning school sessions verify once without blocking browsing or closing a dialog',async()=>{
 const c=client(),check=deferred();let calls=0,shown=0;
 c.context.pendingCheck=()=>{calls++;return check.promise;};c.context.meaSignInLoading={show(){shown++;},hide(){},status(){}};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one',level:'ADMIN'};meaSwitchAccount();inventoryRequest=pendingCheck");
 c.element('workflow-dialog').open=true;
 const a=c.context.restoreSchoolAccount({uid:'one'}), b=c.context.restoreSchoolAccount({uid:'one'});
 assert.equal(calls,1);assert.equal(shown,0);assert.equal(c.run('canOpenDashboard(state.lastId)'),false);
 check.resolve({member:{idNumber:'100001',level:'ADMIN'},account:{uid:'one',admin:true}});c.run('loadCloudDraft=async()=>{}');await Promise.all([a,b]);
 assert.equal(c.element('workflow-dialog').open,true);assert.equal(c.run('canOpenDashboard(state.lastId)'),true);
 await c.context.restoreSchoolAccount({uid:'one'});assert.equal(calls,1);
});

test('temporary verification failures retry quietly and preserve edits without starting Google',async()=>{
 const c=client();let calls=0,redirects=0;const messages=[];
 c.context.meaSignInLoading={show(){assert.fail('Returning user must not block');},hide(){},status:(...s)=>messages.push(s)};
 c.context.check=async()=>{calls++;if(calls===1)throw new TypeError('Failed to fetch');return {member:{idNumber:'100001'},account:{uid:'one'}};};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();inventoryRequest=check;loadCloudDraft=async()=>{};schoolAuth={currentUser:{uid:'one'}};state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:2,action:'BORROWING'};saveCart()");
 c.context.connectGoogle=()=>redirects++;
 await c.context.restoreSchoolAccount({uid:'one'});
 assert.equal(c.element('workflow-dialog').open,false);assert.equal(c.run('verifiedMember'),null);assert.equal(c.run('Object.values(state.cart)[0].qty'),2);
 const retry=[...c.timers.values()].find(t=>t.ms===5000);assert.ok(retry);await retry.fn();
 assert.equal(calls,2);assert.equal(c.run('verifiedMember.uid'),'one');assert.equal(redirects,0);assert.ok(messages.some(s=>s[1]==='Retry'));
});

test('a session ending during verification invalidates the result and cannot restore access',async()=>{
 const c=client(),check=deferred();c.context.pendingCheck=()=>check.promise;
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one',level:'ADMIN'};meaSwitchAccount();inventoryRequest=pendingCheck;loadCloudDraft=async()=>{}");
 const pending=c.context.restoreSchoolAccount({uid:'one'});await c.context.restoreSchoolAccount(null);
 check.resolve({member:{idNumber:'100001',level:'ADMIN'},account:{uid:'one',admin:true}});await pending;
 assert.equal(c.run('verifiedMember'),null);assert.equal(c.run('canOpenTracker(state.lastId)'),false);
 assert.equal(c.run('state.lastId.googleUid'),'one');
});

test('checkout waits for in-flight verification and sends only one authenticated checkout',async()=>{
 const c=client(),check=deferred();const actions=[];c.data.set('mea_inventory_url','https://example.test');
 c.context.fetch=async(url,opts)=>{const action=new URL(url).searchParams.get('action');actions.push(action);return action==='googleMember'?{json:()=>check.promise}:{json:async()=>({ok:true,results:JSON.parse(opts.body).groups.map(g=>({clientId:g.clientId,ok:true}))})};};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();schoolAuth={currentUser:{uid:'one',getIdToken:async()=> 'token'}};loadCloudDraft=async()=>{};state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a',title:'A'},qty:1,action:'BORROWING'}");
 const restoration=c.context.restoreSchoolAccount({uid:'one'});const checkout=c.context.submitOrder();
 for(let i=0;i<10;i++)await Promise.resolve();assert.deepEqual(actions,['googleMember']);
 check.resolve({ok:true,member:{idNumber:'100001'},account:{uid:'one'}});await Promise.all([restoration,checkout]);
 assert.deepEqual(actions.filter(a=>a!=='inventory'),['googleMember','checkout']);assert.equal(c.run('Object.keys(state.cart).length'),0);
});

test('another school UID cannot silently replace the saved account or its cart',async()=>{
 const c=client();let requests=0;c.context.check=async()=>{requests++;return {};};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();inventoryRequest=check;state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:3,action:'BORROWING'}");
 await c.context.restoreSchoolAccount({uid:'two'});
 assert.equal(requests,0);assert.equal(c.run('verifiedMember'),null);assert.equal(c.run('state.lastId.googleUid'),'one');assert.equal(c.run('Object.values(state.cart)[0].qty'),3);
});

test('expired school sessions offer reconnect without an automatic OAuth redirect or retry loop',async()=>{
 const c=client();let calls=0;const statuses=[];c.context.meaSignInLoading={show(){},hide(){},status:(...s)=>statuses.push(s)};
 c.context.check=async()=>{calls++;throw Object.assign(new Error('Verify school account'),{code:'UNAUTHORIZED'});};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();inventoryRequest=check");await c.context.restoreSchoolAccount({uid:'one'});
 assert.equal(calls,1);assert.equal(c.element('workflow-dialog').open,false);assert.ok(statuses.some(s=>s[1]==='Reconnect'));assert.equal(c.run('schoolRetryTimer'),null);
});

test('network recovery stops automatic retries after three attempts and logout clears the timer',async()=>{
 const c=client();c.context.check=async()=>{throw new TypeError('Offline');};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();schoolAuth={currentUser:{uid:'one'},signOut:async()=>{}};inventoryRequest=check");
 await c.context.restoreSchoolAccount({uid:'one'});
 for(const delay of [5000,15000,30000]){
   const timer=[...c.timers.entries()].find(([,t])=>t.ms===delay);assert.ok(timer);c.timers.delete(timer[0]);await timer[1].fn();
 }
 assert.equal(c.run('schoolRetryTimer'),null);assert.equal(c.run('schoolRetryAttempt'),3);
 c.run('schoolRetryAttempt=0;scheduleSchoolRetry()');assert.notEqual(c.run('schoolRetryTimer'),null);
 c.run('meaBeforeLogout();state.lastId=null;meaSwitchAccount()');assert.equal(c.run('schoolRetryTimer'),null);
});

test('protected checkout cannot follow an account switch while verification is pending',async()=>{
 const c=client(),check=deferred();c.context.check=()=>check.promise;
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();inventoryRequest=check");
 const restoring=c.context.restoreSchoolAccount({uid:'one'}), submitting=c.context.submitCheckout({groups:[]});
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount()");
 check.resolve({member:{idNumber:'100001'},account:{uid:'one'}});await restoring;
 await assert.rejects(submitting,/Account changed/);assert.equal(c.run('state.lastId.idNumber'),'100002');
});


test('checkout stops waiting after ten seconds without sending or losing a draft',async()=>{
 const c=client(),check=deferred();let submissions=0;
 c.context.check=()=>check.promise;c.context.fetch=async()=>{submissions++;return {json:async()=>({ok:true})};};
 c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount();inventoryRequest=check;state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:2,action:'BORROWING'}");
 const restoring=c.context.restoreSchoolAccount({uid:'one'}), checkout=c.context.submitOrder();
 for(let i=0;i<4;i++)await Promise.resolve();const timer=[...c.timers.values()].find(t=>t.ms===10000);assert.ok(timer);timer.fn();await checkout;
 assert.equal(submissions,0);assert.equal(c.run('Object.values(state.cart)[0].qty'),2);assert.equal(c.element('submit-order-btn').disabled,false);
 check.resolve({member:{idNumber:'100001'},account:{uid:'one'}});c.run('loadCloudDraft=async()=>{}');await restoring;assert.equal(submissions,0);
});

test('Supabase session-ending error codes offer reconnect even when HTTP status is 400',()=>{
 for(const code of ['session_expired','session_not_found','refresh_token_not_found','refresh_token_already_used']) {
   const c=client();let label;c.context.meaSignInLoading={status:(_,value)=>label=value};
   c.run("state.lastId={idNumber:'100001',verified:true,googleUid:'one'};meaSwitchAccount()");
   c.context.schoolConnectionFailure({code,status:400,message:'Session unavailable'},true);
   assert.equal(label,'Reconnect');assert.equal(c.run('schoolRetryTimer'),null);assert.equal(c.run('schoolNeedsReconnect'),true);
 }
});

test('special loans expose normal returns and completed special requests share the resolved pile',()=>{
 const c=client();connect(c);
 const base={idNum:'100001',item:'Radio',qty:2,requestOnly:true,requestedAction:'BORROWING'};
 c.context.paintHistory({records:[{...base,recordId:'active-special',caseType:'BORROWING',requestStatus:'VERIFIED',borrowedQty:2,returnedQty:0,outstandingQty:2,resolved:false,returnable:true,canReturn:true},{...base,item:'Returned radio',recordId:'done',caseType:'BORROWING',requestStatus:'VERIFIED',resolved:true},{...base,item:'Declined radio',recordId:'declined',caseType:'SPECIAL_REQUEST',requestStatus:'DECLINED',resolved:true}],projects:[]});
 assert.match(c.element('history-pending-list').innerHTML,/data-return-id="active-special"/);
 assert.match(c.element('history-total-list').innerHTML,/Returned radio/);assert.match(c.element('history-total-list').innerHTML,/Declined radio/);
 assert.doesNotMatch(c.element('history-special-list').innerHTML,/Returned radio|Declined radio|active-special/);
});

test('special acceptance submits verifier notes and warns if the saved decision email fails',async()=>{
 const c=client();connect(c);c.run("verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'token'}};");
 c.context.meaHistoryRecords=[{recordId:'accept',requestOnly:true,canReview:true,item:'Radio',qty:2,recordRevision:3}];
 let sent;c.context.fetch=async(url,options)=>{const action=new URL(url).searchParams.get('action');if(action==='specialRequestReview'){sent=JSON.parse(options.body);return {json:async()=>({ok:true,emailStatus:'FAILED'})};}return {json:async()=>({ok:true,records:[],projects:[]}),text:async()=>JSON.stringify({ok:true,items:[]})};};
 c.context.openSpecialReview('accept');c.element('special-status').value='VERIFIED';c.element('special-note').value='Collect tomorrow.';
 await c.element('special-confirm').onclick();
 assert.equal(sent.note,'Collect tomorrow.');assert.equal(sent.status,'VERIFIED');assert.equal(sent.expectedRevision,3);
 assert.equal(c.element('workflow-dialog').open,false);assert.match(c.element('toast').textContent,/accepted, but the email could not be sent/);
});
