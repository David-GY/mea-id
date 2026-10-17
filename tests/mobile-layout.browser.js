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
    for (const device of [
      {width: 390, height: 844},
      {width: 412, height: 915},
      {width: 844, height: 390}
    ]) {
      const context = await browser.newContext({viewport: device, screen: device, isMobile: true, hasTouch: true});
      await context.addInitScript(() => {
        localStorage.setItem('mea_google_signed_out', location.search.includes('code=') ? 'false' : 'true');
      });
      const phone = await context.newPage();
      await phone.route('**/*', async route => {
        if (route.request().resourceType() !== 'document' || !route.request().url().includes('code=')) return route.continue();
        const response = await route.fetch();
        // Simulate a desktop-sized viewport restored by the external sign-in round trip.
        const body = (await response.text()).replace('width=device-width, initial-scale=1.0, viewport-fit=cover', 'width=1280, initial-scale=1.0');
        await route.fulfill({response, body});
      });
      await phone.goto(url);
      await phone.locator('#login-id-input').fill('100001');
      await phone.locator('#login-enter-btn').click();
      await phone.waitForFunction(() => state.view === 'home' && !state.lastId.verified);
      const idWidth = await phone.evaluate(() => innerWidth);
      await phone.goto(url + '/?code=fixture-school-return');
      await phone.waitForFunction(() => state.view === 'home' && state.lastId?.verified);
      assert.equal(await phone.evaluate(() => innerWidth), idWidth, 'Gmail return must match ID-only layout width');
      for (const view of ['home', 'settings', 'history', 'catalog']) {
        await phone.evaluate(view => showView(view), view);
        const layout = await phone.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          sidebar: getComputedStyle(document.querySelector('.sidebar-brand')).display,
          frame: getComputedStyle(document.querySelector('.desktop-frame')).transform
        }));
        assert.equal(layout.width, device.width, `${view}: phone viewport must stay at device width`);
        assert.ok(layout.scroll <= device.width + 1, `${view}: callback must not overflow horizontally`);
        assert.equal(layout.sidebar, 'none', `${view}: desktop sidebar must stay hidden`);
        if (device.width < 768) assert.equal(layout.frame, 'none', `${view}: phone must not become a desktop card`);
      }
      await context.close();
    }
    console.log('Sign-in return passed: ID-only matches Gmail with a restored wide viewport, on two portrait phones and landscape.');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
