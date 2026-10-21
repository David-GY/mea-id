// Local-only UI fixture. All Google requests are intercepted; never writes production data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.FIXTURE_ROOT || path.join(__dirname, '..'));
const fixture = `<script>
localStorage.setItem('mea_inventory_url','https://script.google.com/fixture/exec');
localStorage.setItem('mea_cfg2',JSON.stringify({url:'https://script.google.com/tracker-fixture/exec'}));
let records = [{recordId:'borrow-1',item:'Whiteboard Markers',qty:4,borrowedQty:4,returnedQty:1,outstandingQty:3,idNum:'100001',caseType:'BORROWING',project:'SUS',committee:'Operations',resolved:false,returnable:true,time:'2026-10-15T12:00:00Z'}];
const authScenario=new URLSearchParams(location.search).get('fixture-auth');
let authRelease, authCalls=0, authListener, authFailure=authScenario==='retry', sessionEnded=false;
const authGate=authScenario ? new Promise(resolve=>authRelease=resolve) : Promise.resolve();
if(authScenario) {
 localStorage.removeItem('mea_google_signed_out');
 localStorage.setItem('mea_login_v1',JSON.stringify({idNumber:'100001',name:'Test Member',level:'ADMIN',accountKind:'MEMBER',verified:true,googleUid:'test-uid'}));
 document.addEventListener('DOMContentLoaded',()=>{
  const controls=document.createElement('aside');controls.id='fixture-auth-controls';controls.style.cssText='padding:16px;clear:both';
  controls.innerHTML='<p>Isolated session test · <output id="fixture-auth-calls">0</output> account checks</p><button id="fixture-auth-release">Finish verification</button> <button id="fixture-auth-expire">End school session</button> <button id="fixture-auth-refresh">Refresh token</button>';
  document.body.append(controls);
  document.getElementById('fixture-auth-release').onclick=()=>authRelease();
  document.getElementById('fixture-auth-expire').onclick=()=>{sessionEnded=true;authListener?.('SIGNED_OUT',null);};
  document.getElementById('fixture-auth-refresh').onclick=()=>authListener?.('TOKEN_REFRESHED',{user:{id:'test-uid'},access_token:'fixture'});
 });
}
window.fixtureLoading={requests:[],delayMs:Number(sessionStorage.getItem('fixture-read-delay') || 0)};
window.fetch = async (url, options={}) => {
 const action = new URL(url,location.href).searchParams.get('action');
 window.fixtureLoading.requests.push({action,startedAt:performance.now()});
 if(['inventory','history'].includes(action) && window.fixtureLoading.delayMs) await new Promise(resolve=>setTimeout(resolve,window.fixtureLoading.delayMs));
 const payload = options.body ? JSON.parse(options.body) : {};
 let data;
 if(action==='dashboardData') data={ok:true,members:[{idNumber:'100001',name:'Test Member',requiresId:true,state:'INVENTORY',projects:['SUS']}],projects:['SUS'],revision:'fixture',generatedAt:new Date().toISOString()};
 else if(action==='activity') data={ok:true,events:[],nextCursor:'fixture-cursor'};
 else if(action==='login') data={ok:true,found:true,idNumber:new URL(url).searchParams.get('id'),name:'Test Member',level:'NONE'};
 else if(action==='inventory') data={ok:true,items:[{id:'item-1',title:'Whiteboard Markers',qty:'8',location:'Steel Cabinet A',category:'Stationery',notes:'Return reusable markers.'},{id:'item-2',title:'Binder Clips',qty:'2 packs',location:'Steel Cabinet B',category:'Stationery',notes:''},{id:'special-1',itemCode:'IT-109',title:'Walkie Talkie',qty:'6',location:'Brown Cabinet',category:'FIN',inventorySection:'Special Inventory',requiresManualVerification:true,notes:'Check condition with SUS.'}]};
 else if(action==='checkout') {data={ok:true,results:payload.groups.map((group,index)=>{
   if(!group.requestOnly && group.caseType==='CONSUMING' && sessionStorage.getItem('fixture-fail-consume'))return {clientId:group.clientId,ok:false,retryable:false,error:'Fixture: consume rejected'};
   if(group.requestOnly)group.items.forEach((line,i)=>records.unshift({recordId:'special-'+group.clientId+'-'+i,reference:'SR-00'+(index+1),item:'Walkie Talkie',qty:line.qty,idNum:payload.idNumber,caseType:'SPECIAL_REQUEST',requestOnly:true,requestStatus:'PENDING',requestedAction:group.caseType,project:group.project,committee:group.committee,canReview:true,time:new Date().toISOString()}));
   return {clientId:group.clientId,ok:true,logged:group.items.length,requestOnly:group.requestOnly};
 })};}
 else if(action==='submitSpecialRequest') {payload.items.forEach((line,i)=>records.unshift({recordId:'special-request-'+i,reference:'SR-001',item:'Walkie Talkie',qty:line.qty,idNum:payload.idNumber,caseType:'SPECIAL_REQUEST',requestOnly:true,requestStatus:'PENDING',requestedAction:payload.caseType,project:payload.project,committee:payload.committee,canReview:true,time:new Date().toISOString()}));data={ok:true,requestOnly:true,status:'PENDING',logged:payload.items.length};}
 else if(action==='specialRequestReview') {const r=records.find(r=>r.recordId===payload.recordId);r.requestStatus=payload.status;r.reviewNote=payload.note;r.canReview=false;data={ok:true};}
 else if(action==='history') data={ok:true,records,projects:['SUS'],admin:true};
 else if(action==='submitOrder') data=payload.caseType==='CONSUMING' && sessionStorage.getItem('fixture-fail-consume') ? {ok:false,retryable:false,error:'Fixture: consume rejected'} : {ok:true,logged:payload.items.length};
 else if(action==='returnItems') { const r=records.find(r=>r.recordId===payload.borrowId); r.returnedQty+=payload.qty; r.resolved=r.returnedQty>=r.borrowedQty; data={ok:true}; }
 else if(action==='googleMember') {authCalls++;if(authScenario){document.getElementById('fixture-auth-calls').textContent=authCalls;await authGate;if(authFailure){authFailure=false;throw new TypeError('Fixture: connection interrupted');}}records.forEach(r=>{r.canReturn=true;r.canDelete=true;r.canEdit=true;});data={ok:true,member:{idNumber:'100001',name:'Test Member',level:'ADMIN',verified:true},account:{uid:'test-uid',admin:true,officer:true,projects:['SUS']}};}
 else if(['recordDelete','recordRestore','recordEdit'].includes(action)){const r=records.find(r=>r.recordId===payload.recordId);if(action==='recordEdit')Object.assign(r,payload.changes);else r.deleted=action==='recordDelete';r.recordRevision=(r.recordRevision||0)+1;data={ok:true};}
 else if(action==='cartRead') data={ok:true,revision:1,draft:{cart:{},project:'SUS',committee:'Cloud draft'}};
 else if(action==='cartWrite') data={ok:true,revision:2};
 else throw new Error('Fixture blocked request '+url);
 return {ok:true,json:async()=>data,text:async()=>JSON.stringify(data)};
};
window.MEA_CONFIG={supabase:{url:'https://gxffeavbefmmycmvccsm.supabase.co',publishableKey:'fixture'}};
window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:sessionEnded?null:{user:{id:'test-uid'},access_token:'fixture'}}}),signInWithOAuth:async()=>({}),signInWithOtp:async()=>({}),verifyOtp:async()=>({data:{session:{user:{id:'test-uid'},access_token:'fixture'}}}),signOut:async()=>({}),onAuthStateChange:cb=>{authListener=cb;return {data:{subscription:{unsubscribe(){}}}};}}})};

</script>`;
http.createServer((req,res)=>{
 const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(pathname==='/sw.js') {res.writeHead(404);return res.end();}
 const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!target.startsWith(root+path.sep)) {res.writeHead(403);return res.end();}
 try {
 let bytes=fs.readFileSync(target);
 if(path.extname(target)==='.html') bytes=Buffer.from(bytes.toString().replace('<script src="app-config.js?v=15"></script>',fixture+'<script src="app-config.js?v=15"></script>'));
 const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'}[path.extname(target)]||'text/plain';
 res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(bytes);
 } catch(_) {res.writeHead(404);res.end();}
}).listen(Number(process.env.PORT || 8765),'127.0.0.1',function(){console.log('Isolated fixture at http://127.0.0.1:'+this.address().port);});
