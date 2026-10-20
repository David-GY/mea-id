// Uses the isolated fixture only. Run with the bundled Playwright on NODE_PATH.
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
    browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true});
    const results = [];
    for (const width of [390, 1280]) {
      const context = await browser.newContext({viewport: {width, height: 844}});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => sessionStorage.setItem('fixture-read-delay', '1200'));
      await page.goto(url, {waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => state.lastId?.verified && state.inventory.length && historyFresh.size);
      const cold = await page.evaluate(() => ({usableByMs: performance.now(), inventoryRequests: fixtureLoading.requests.filter(r => r.action === 'inventory').length}));
      await page.reload({waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => state.lastId?.verified);
      await page.waitForFunction(() => fixtureLoading.requests.some(r => r.action === 'history'));
      const catalog = await page.evaluate(async () => {
        const start = performance.now();
        showView('catalog'); showView('home'); showView('catalog');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {paintMs: performance.now() - start, content: document.getElementById('catalog-container').textContent,
          skeletons: document.querySelectorAll('#catalog-container .skeleton').length,
          requests: fixtureLoading.requests.filter(r => r.action === 'inventory').length};
      });
      assert.match(catalog.content, /Whiteboard Markers/); assert.equal(catalog.skeletons, 0); assert.equal(catalog.requests, 1);
      assert.ok(catalog.paintMs < 200, `cached catalog took ${catalog.paintMs}ms`);
      const history = await page.evaluate(async () => {
        const start = performance.now(); showView('history');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {paintMs: performance.now() - start, content: document.getElementById('history-pending-list').textContent,
          skeletons: document.querySelectorAll('#history-pending-list .skeleton').length,
          requests: fixtureLoading.requests.filter(r => r.action === 'history').length};
      });
      assert.match(history.content, /Whiteboard Markers/); assert.equal(history.skeletons, 0); assert.equal(history.requests, 1);
      assert.ok(history.paintMs < 200, `cached history took ${history.paintMs}ms`);
      await page.waitForFunction(() => !inventoryRead.promise && historyFlights.size === 0);
      const refreshed = await page.evaluate(() => ({inventory: fixtureLoading.requests.filter(r => r.action === 'inventory').length,history: fixtureLoading.requests.filter(r => r.action === 'history').length}));
      assert.deepEqual(refreshed, {inventory: 1, history: 1});
      await page.evaluate(() => showView('catalog'));
      await page.getByRole('button', {name: 'Refresh', exact: true}).click();
      await page.waitForFunction(() => fixtureLoading.requests.filter(r => r.action === 'inventory').length === 2 && !inventoryRead.promise);
      await context.setOffline(true);
      await page.evaluate(async () => {showView('catalog');await loadInventory({force:true});});
      assert.match(await page.locator('#catalog-container').textContent(), /Whiteboard Markers/);
      assert.match(await page.locator('#catalog-sync').textContent(), /saved copy/i);
      await page.evaluate(() => showView('history'));
      assert.match(await page.locator('#history-pending-list').textContent(), /Whiteboard Markers/);
      assert.match(await page.locator('#history-pending-list').textContent(), /offline/);
      const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(layout.scroll <= layout.width + 1);
      assert.deepEqual(errors, []);
      results.push({width, simulatedReadDelayMs: 1200, cold, catalog, history, refreshed});
      await context.close();
    }
    console.log(JSON.stringify(results, null, 2));
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => {console.error(error);process.exitCode=1;});
