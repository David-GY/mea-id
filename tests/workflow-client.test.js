const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const model = require('../cart-model');
function client() {
 const elements = new Map(), data = new Map();
 function element(id) {
  if (!elements.has(id)) elements.set(id, {value:'',textContent:'',innerHTML:'',hidden:false,open:false,style:{},dataset:{},options:[{value:'SUS'},{value:'Personal'}],
   classList:{add(){},remove(){},toggle(){}},replaceChildren(){this.innerHTML='';this.textContent='';},querySelectorAll(){return [];},querySelector(){return element('focus');},focus(){},addEventListener(){},setAttribute(){},before(){},append(){},showModal(){this.open=true;},close(){this.open=false;}});
  return elements.get(id);
 }
 const document={getElementById:element,activeElement:null,body:element('body'),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},dispatchEvent(){},createElement:()=>element(randomUUID())};
 const context=vm.createContext({document,console,MeaCart:model,crypto:{randomUUID},navigator:{onLine:true,userAgent:'test'},setTimeout:()=>1,clearTimeout(){},setInterval(){},URLSearchParams,CustomEvent:class{},Event:class{},
  localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},addEventListener(){},matchMedia:()=>({matches:false}),fetch:async()=>({json:async()=>({ok:true}),text:async()=>'{"ok":true}'})});
 context.window=context;
 vm.runInContext(fs.readFileSync(require.resolve('../inventory.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(require.resolve('../workflow.js'),'utf8'),context);
 const run=code=>vm.runInContext(code,context);
 return {context,run,data,element};
}

test('legacy review queue is scoped, escaped and read-only without changing history records',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');
 c.run("state.lastId={idNumber:'100001'};meaSwitchAccount();state.historyTab='project'");c.element('history-project-select').value='__ALL__';
 const legacy={recordId:'LEGACY-old',item:'<Old item>',name:'Borrower',idNum:'100002',project:'SUS',caseType:'BORROWING',borrowedQty:3,returnedQty:1,outstandingQty:2,returnable:false,canEdit:true,canDelete:true,resolved:false};
 const records=[legacy,{...legacy,recordId:'resolved',resolved:true},{...legacy,recordId:'deleted',deleted:true},{...legacy,recordId:'consume',caseType:'CONSUMING',resolved:true},{...legacy,recordId:'new',returnable:true,canReturn:true}];
 const before=JSON.stringify(records);let calls=0;
 c.context.fetch=async(_,options)=>{calls++;assert.equal(JSON.parse(options.body).scope,'officer');return {json:async()=>({ok:true,admin:true,projects:['SUS'],records})};};
 await c.context.renderHistory();
 const html=c.element('history-legacy-list').innerHTML;
 assert.match(html,/1 record\(s\)/);assert.match(html,/LEGACY-old/);assert.match(html,/Borrower.*100002/);assert.match(html,/&lt;Old item&gt;/);assert.match(html,/Unconfirmed remaining: 2/);assert.match(html,/No linked inventory item/);
 assert.doesNotMatch(html,/<button|data-return-id|data-record-action/);assert.doesNotMatch(c.element('history-pending-list').innerHTML,/LEGACY-old/);
 assert.equal(JSON.stringify(records),before);assert.equal(calls,1);
 c.run("state.lastId={idNumber:'100003'};meaSwitchAccount()");assert.equal(c.element('history-legacy-list').innerHTML,'');
});

test('assumed legacy loans appear in normal outstanding history with return controls and baseline label',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount()");
 const rec={recordId:'LEGACY-one',item:'Old loan',idNum:'100001',caseType:'BORROWING',borrowedQty:4,returnedQty:1,outstandingQty:3,resolved:false,returnable:true,canReturn:true,legacyAssumedUnreturned:true};
 c.context.fetch=async()=>({json:async()=>({ok:true,records:[rec],projects:['SUS']})});await c.context.renderHistory();
 assert.match(c.element('history-pending-list').innerHTML,/starting balance assumed unreturned/);assert.match(c.element('history-pending-list').innerHTML,/Return items/);assert.match(c.element('history-pending-list').innerHTML,/3 remaining/);
 assert.doesNotMatch(c.element('history-legacy-list').innerHTML,/LEGACY-one/);
 c.context.openReturnSheet(rec.recordId);assert.equal(c.element('sheet-quantity').max,3);assert.equal(c.element('workflow-dialog').open,true);
});

test('review queue reports offline data and clears on authorization failure or stale response',async()=>{
 const c=client();c.data.set('mea_inventory_url','https://example.test');c.run("state.lastId={idNumber:'100001'};meaSwitchAccount()");
 c.context.navigator.onLine=false;await c.context.renderHistory();assert.match(c.element('history-legacy-list').innerHTML,/unavailable.*no saved data/);
 c.context.navigator.onLine=true;c.context.fetch=async()=>({json:async()=>({ok:false,error:'Forbidden',code:'FORBIDDEN'})});
 await c.context.renderHistory();assert.match(c.element('history-legacy-list').innerHTML,/Forbidden/);
 let resolve;c.context.fetch=()=>new Promise(r=>resolve=r);const pending=c.context.renderHistory();await new Promise(r=>setImmediate(r));
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount()");resolve({json:async()=>({ok:true,records:[{recordId:'old',idNum:'100001',caseType:'BORROWING',returnable:false}]})});await pending;
 assert.equal(c.element('history-legacy-list').innerHTML,'');
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
 c.context.google={script:{run:{withSuccessHandler(ok){return {withFailureHandler(fail){return {submitOrder(p){ if(p.caseType==='CONSUMING')fail(new Error('Rejected'));else ok({success:true}); }};}};}}}};
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
 const c=client();c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();verifiedMember={uid:'one'};schoolAuth={currentUser:{getIdToken:async()=> 'token'}};state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:2,action:'BORROWING'};draftDirty=true;");
 c.data.set('mea_inventory_url','https://example.test');
 c.context.fetch=async()=>({json:async()=>({ok:true,revision:4,draft:{cart:{},project:'SUS',committee:'Cloud'}})});
 await c.context.loadCloudDraft();
 assert.equal(c.run('Object.values(state.cart)[0].qty'),2);assert.equal(c.run('cloudConflict'),true);assert.equal(c.element('workflow-dialog').open,true);
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
 let sent;c.context.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {json:async()=>({ok:true,logged:1})};};
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
 await c.context.renderHistory();assert.match(c.element('history-pending-list').innerHTML,/Return items/);assert.match(c.element('history-project-select').innerHTML,/Old Dept/);
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
