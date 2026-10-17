const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function phone({width = 390, height = 844, coarse = true, type = 'portrait-primary', touchPoints = coarse ? 1 : 0, saved = null, blocked = false} = {}) {
  const listeners = {}, viewport = {content: 'width=1280, initial-scale=1.0'};
  const storage = new Map(saved ? [['mea_phone_viewport_v1', saved]] : []);
  const orientation = {type, addEventListener: (event, fn) => { listeners.orientation = fn; }};
  const context = {screen: {width, height, orientation}, matchMedia: () => ({matches: coarse}),
    navigator: {maxTouchPoints: touchPoints},
    localStorage: {getItem: key => { if (blocked) throw Error('Storage blocked'); return storage.get(key) || null; },
      setItem: (key, value) => { if (blocked) throw Error('Storage blocked'); storage.set(key, value); }},
    addEventListener: (event, fn) => { listeners[event] = fn; },
    document: {querySelector: () => viewport, addEventListener: (event, fn) => { listeners[event] = fn; }}};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-viewport.js'), 'utf8'), context);
  return {viewport, listeners, context, storage};
}

test('phone layout resets a restored desktop viewport before paint and on sign-in return', () => {
  const f = phone();
  assert.equal(f.viewport.content, 'width=390, initial-scale=1.0, viewport-fit=cover');
  for (const event of ['pageshow', 'mea:viewchange']) {
    f.viewport.content = 'width=1280, initial-scale=1.0';
    f.listeners[event]();
    assert.match(f.viewport.content, /^width=390,/);
    assert.doesNotMatch(f.viewport.content, /user-scalable|maximum-scale/);
  }
});

test('phone rotation follows the physical screen and does not mistake the keyboard for rotation', () => {
  const f = phone();
  f.context.screen.orientation.type = 'landscape-primary';
  f.listeners.orientation();
  assert.match(f.viewport.content, /^width=844,/);
  f.context.screen.orientation.type = 'portrait-primary';
  f.listeners.orientationchange();
  assert.match(f.viewport.content, /^width=390,/);
});

test('desktop and tablet viewports retain their responsive sizing', () => {
  assert.equal(phone({coarse: false}).viewport.content, 'width=1280, initial-scale=1.0');
  assert.equal(phone({width: 1024, height: 1366}).viewport.content, 'width=1280, initial-scale=1.0');
});

test('known phone sizing survives a later sign-in return reporting desktop screen dimensions', () => {
  const first = phone();
  const saved = first.storage.get('mea_phone_viewport_v1');
  assert.equal(saved, '[390,844]');
  const returned = phone({width: 1280, height: 2560, coarse: false, touchPoints: 5, saved});
  assert.match(returned.viewport.content, /^width=390,/);
  returned.context.screen.orientation.type = 'landscape-primary';
  returned.listeners.orientation();
  assert.match(returned.viewport.content, /^width=844,/);
  assert.equal(phone({width: 1280, height: 2560, coarse: false, saved}).viewport.content, 'width=1280, initial-scale=1.0');
});

test('phone touch capability works with a fine primary pointer and on app resume', () => {
  const f = phone({coarse: false, touchPoints: 5});
  assert.match(f.viewport.content, /^width=390,/);
  f.viewport.content = 'width=1280, initial-scale=1.0';
  f.context.document.hidden = false;
  f.listeners.visibilitychange();
  assert.match(f.viewport.content, /^width=390,/);
});

test('blocked or invalid device storage cannot break layout initialization', () => {
  assert.match(phone({blocked: true}).viewport.content, /^width=390,/);
  for (const saved of ['broken', '{}', '[1280,2560]', '[390,-1]', '[390,"844"]']) {
    assert.equal(phone({width: 1280, height: 2560, saved}).viewport.content, 'width=1280, initial-scale=1.0');
  }
});
