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
 const c=client();c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();verifiedMember={uid:'one'};firebaseAuth={currentUser:{getIdToken:async()=> 'token'}};state.cart[MeaCart.key('a','BORROWING')]={item:{id:'a'},qty:2,action:'BORROWING'};draftDirty=true;");
 c.data.set('mea_inventory_url','https://example.test');
 c.context.fetch=async()=>({json:async()=>({ok:true,revision:4,draft:{cart:{},project:'SUS',committee:'Cloud'}})});
 await c.context.loadCloudDraft();
 assert.equal(c.run('Object.values(state.cart)[0].qty'),2);assert.equal(c.run('cloudConflict'),true);assert.equal(c.element('workflow-dialog').open,true);
 c.element('use-cloud').onclick();assert.equal(c.run('Object.keys(state.cart).length'),0);assert.equal(c.element('committee-input').value,'Cloud');
});
test('late cloud response cannot load previous account cart into a newly selected member',async()=>{
 const c=client();c.run("state.lastId={idNumber:'100001'}; meaSwitchAccount();verifiedMember={uid:'one'};firebaseAuth={currentUser:{getIdToken:async()=> 'token'}};");c.data.set('mea_inventory_url','https://example.test');
 let resolve; c.context.fetch=()=>new Promise(r=>resolve=r);
 const pending=c.context.loadCloudDraft();await new Promise(r=>setImmediate(r));
 c.run("state.lastId={idNumber:'100002'};meaSwitchAccount()");
 resolve({json:async()=>({ok:true,revision:3,draft:{cart:{},committee:'Previous owner'}})});await pending;
 assert.equal(c.element('committee-input').value,'');assert.equal(c.run('cloudLoaded'),false);
});
