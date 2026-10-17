const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function phone({width = 390, height = 844, coarse = true, type = 'portrait-primary'} = {}) {
  const listeners = {}, viewport = {content: 'width=1280, initial-scale=1.0'};
  const orientation = {type, addEventListener: (event, fn) => { listeners.orientation = fn; }};
  const context = {screen: {width, height, orientation}, matchMedia: () => ({matches: coarse}),
    addEventListener: (event, fn) => { listeners[event] = fn; },
    document: {querySelector: () => viewport, addEventListener: (event, fn) => { listeners[event] = fn; }}};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-viewport.js'), 'utf8'), context);
  return {viewport, listeners, context};
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
