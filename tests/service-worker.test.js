const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture() {
  const handlers = {}, deleted = [], writes = [], reads = [];
  const scope = 'https://example.test/mea-id/';
  const cache = {keys:async()=>[{url:scope+'index.html'}],match:async key=>{reads.push(key);return 'saved-shell';},put:async(key)=>writes.push(key)};
  const context = vm.createContext({URL,Promise,self:{registration:{scope},location:{origin:'https://example.test'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{claim(){}},skipWaiting(){}},
    caches:{keys:async()=>['other-app','mea-app-v34','mea-app:'+scope+':old'],delete:async key=>deleted.push(key),open:async()=>cache},
    fetch:async()=>({ok:true,clone:()=>({})})});
  vm.runInContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),context);
  return {handlers,deleted,writes,reads,context,scope};
}
test('service worker caches only scoped app shell, never callback credentials or unrelated resources',async()=>{
  const f=fixture();
  for(const path of ['index.html?code=secret','index.html?token=secret','private.json','../other-app/index.html']) {
    let handled=false;f.handlers.fetch({request:{url:f.scope+path,method:'GET'},respondWith(){handled=true;}});assert.equal(handled,false,path);
  }
  let response;const tasks=[];
  f.handlers.fetch({request:{url:f.scope+'inventory.js?v=35',method:'GET'},respondWith:p=>response=p,waitUntil:p=>tasks.push(p)});
  await response;await Promise.all(tasks);assert.deepEqual(f.writes,[f.scope+'inventory.js']);
  f.context.fetch=async()=>{throw new Error('Offline');};
  f.handlers.fetch({request:{url:f.scope+'inventory.js?v=35',method:'GET'},respondWith:p=>response=p,waitUntil(){}});
  assert.equal(await response,'saved-shell');assert.deepEqual(f.reads,[f.scope+'inventory.js']);
});
test('service worker upgrades preserve unrelated same-origin app caches',async()=>{
  const f=fixture();let done;f.handlers.activate({waitUntil:p=>done=p});await done;
  assert.ok(f.deleted.includes('mea-app-v34'));assert.ok(f.deleted.includes('mea-app:'+f.scope+':old'));assert.ok(!f.deleted.includes('other-app'));
});

test('the pinned same-origin auth SDK is available from cache without a network wait',async()=>{
 const f=fixture();let response;
 f.context.fetch=()=>{assert.fail('The cached SDK must not wait on the network');};
 f.handlers.fetch({request:{url:f.scope+'vendor/supabase-2.118.0.js',method:'GET'},respondWith:p=>response=p,waitUntil(){}});
 assert.equal(await response,'saved-shell');assert.deepEqual(f.reads,[f.scope+'vendor/supabase-2.118.0.js']);
});
