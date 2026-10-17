// Run with Playwright available in NODE_PATH. Uses isolated service fixtures only.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

(async () => {
  const server = spawn(process.execPath, [require.resolve('./serve-workflow-fixture')], {
    env: {...process.env, PORT: '0'}, stdio: ['ignore', 'pipe', 'inherit']
  });
  let browser;
  try {
    const [output] = await once(server.stdout, 'data');
    const url = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge'});
    const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true});
    await page.goto(url);
    await page.waitForFunction(() => state.lastId?.verified);
    for (const kind of ['id', 'member', 'guest']) {
      await page.evaluate(kind => {
        state.lastId = {
          idNumber: kind === 'guest' ? 'guest:fixture' : '100001',
          name: 'averylongstudentaccountnamewithoutspaces',
          email: 'averylongstudentaccountname@student.ateneo.edu',
          verified: kind !== 'id', accountKind: kind === 'guest' ? 'GUEST' : 'MEMBER',
          guestCode: 'G-fixture', level: 'NONE'
        };
        renderIdentity(); renderAccountControls();
      }, kind);
      for (const width of [320, 390, 430, 844, 1280]) {
        await page.setViewportSize({width, height: 844});
        for (const view of ['home', 'settings', 'help', 'history', 'catalog']) {
          await page.evaluate(view => showView(view), view);
          const layout = await page.evaluate(() => ({
            viewport: innerWidth,
            scroll: document.documentElement.scrollWidth,
            screen: document.documentElement.clientWidth,
            identityFits: [...document.querySelectorAll('.view.active .identity-block')]
              .every(el => el.scrollWidth <= el.clientWidth + 1)
          }));
          assert.equal(layout.viewport, width, `${kind}/${view}/${width}: viewport expanded`);
          assert.ok(layout.scroll <= layout.screen + 1, `${kind}/${view}/${width}: horizontal overflow`);
          assert.ok(layout.identityFits, `${kind}/${view}/${width}: identity overflow`);
        }
      }
    }
    console.log('Mobile layout passed: ID-only, school member and guest; 5 widths × 5 views.');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
