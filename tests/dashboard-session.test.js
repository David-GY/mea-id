const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture() {
  const store = new Map(), elements = new Map();
  const element = id => {if(!elements.has(id))elements.set(id,{hidden:false,value:'',innerHTML:'',textContent:'',querySelectorAll:()=>[],classList:{contains:()=>false},replaceChildren(){this.innerHTML='';},addEventListener(){}});return elements.get(id);};
  const context=vm.createContext({console,URLSearchParams,Date,setTimeout:()=>1,clearTimeout(){},navigator:{onLine:true},
    document:{getElementById:element,addEventListener(){},querySelectorAll:()=>[]},
    localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
    fetch:async()=>({ok:true,text:async()=>JSON.stringify({ok:true,members:[],projects:[]})})});
  context.window=context;context.addEventListener=()=>{};
  context.MEADashboardModel=require('../dashboard-model');
  const login = id => {store.set('mea_login_v1',JSON.stringify({idNumber:id,level:'ADMIN'}));store.set('mea_cfg2',JSON.stringify({url:'https://example.test/tracker'}));};
  login('100001');vm.runInContext(fs.readFileSync(require.resolve('../dashboard.js'),'utf8'),context);
  return {context,store,element,login,api:context.meaDashboard};
}
test('dashboard snapshots and memory are isolated by actor and backend configuration',async()=>{
  const f=fixture();await f.api.load();assert.ok(f.api.getState().data);
  f.login('100002');f.context.navigator.onLine=false;await f.api.load();assert.equal(f.api.getState().data,null);
  f.login('100001');await f.api.load();assert.ok(f.api.getState().data);
  f.store.set('mea_cfg2',JSON.stringify({url:'https://different.test/tracker'}));await f.api.load();assert.equal(f.api.getState().data,null);
});
test('authorization denial evicts dashboard snapshots instead of presenting them as offline data',async()=>{
  const f=fixture();await f.api.load();
  f.context.fetch=async()=>({ok:true,text:async()=>'{"ok":false,"error":"Insufficient permission"}'});
  await f.api.load();assert.equal(f.api.getState().data,null);assert.match(f.element('dashboard-error').textContent,/permission/);
  assert.equal([...f.store.keys()].filter(k=>k.startsWith('mea_dashboard_cache')).length,0);
});
test('a late dashboard response cannot repopulate a reset session, even for the same actor',async()=>{
  const f=fixture();let resolve;f.context.fetch=()=>new Promise(done=>resolve=done);
  const request=f.api.load();f.api.reset();resolve({ok:true,text:async()=>'{"ok":true,"members":[],"projects":[]}'});await request;
  assert.equal(f.api.getState().data,null);assert.equal([...f.store.keys()].filter(k=>k.startsWith('mea_dashboard_cache')).length,0);
});
