const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function appearance(saved, blocked = false) {
 const listeners = {}, data = new Map(saved ? [['mea_appearance',saved]] : []);
 const select = {addEventListener:(_,fn)=>listeners.change=fn};
 const root = {dataset:{}};
 const doc = {documentElement:root,querySelector:()=>({setAttribute(){}}),getElementById:()=>select,addEventListener:(_,fn)=>listeners.ready=fn};
 vm.runInNewContext(fs.readFileSync(require.resolve('../appearance.js'),'utf8'),{document:doc,localStorage:{getItem:k=>{if(blocked)throw Error('Storage');return data.get(k)},setItem:(k,v)=>{if(blocked)throw Error('Storage');data.set(k,v)}}});
 listeners.ready();return {root,select,listeners,data};
}
test('appearance defaults to MEA Green and migrates the removed white theme',()=>{
 assert.equal(appearance().root.dataset.appearance,'dark');
 assert.equal(appearance('light').root.dataset.appearance,'garden');
 assert.equal(appearance('invalid').root.dataset.appearance,'dark');
});
test('appearance saves each theme and still switches with unavailable storage',()=>{
 for(const theme of ['dark','garden','coffee','plum']) {
  const a=appearance();a.select.value=theme;a.listeners.change();
  assert.equal(a.root.dataset.appearance,theme);assert.equal(a.data.get('mea_appearance'),theme);
  assert.equal(appearance(a.data.get('mea_appearance')).select.value,theme);
 }
 const a=appearance(null,true);a.select.value='coffee';a.listeners.change();assert.equal(a.root.dataset.appearance,'coffee');
});
