  /* ==================================================================
     MEA ID Tracker — client logic
     ================================================================== */

  // GitHub Pages does not provide Apps Script's google.script.run object. This
  // small local adapter keeps the app usable there while preserving the same
  // call shape for Apps Script deployments. getInventory specifically now
  // fetches LIVE data from the Apps Script backend (action=inventory) when a
  // Script URL is configured, matching how the ID Tracker and Access gate
  // already talk to the same backend — falling back to demo data only when
  // no URL is set yet or the request fails, so the app never breaks.
  if (!window.google || !window.google.script || !window.google.script.run) {
    const demoInventory = [
      { id: 'ITM-100', title: 'Safety Vest', category: 'Safety', qtyAvailable: 5, qtyDisplay: '5' },
      { id: 'ITM-101', title: 'Hard Hat', category: 'Safety', qtyAvailable: 6, qtyDisplay: '6' },
      { id: 'ITM-102', title: 'Wire Spool', category: 'Electrical', qtyAvailable: 7, qtyDisplay: '7' },
      { id: 'ITM-103', title: 'Multimeter', category: 'Electrical', qtyAvailable: 8, qtyDisplay: '8' },
      { id: 'ITM-104', title: 'Toolbox', category: 'Tools', qtyAvailable: 9, qtyDisplay: '9' },
      { id: 'ITM-105', title: 'Extension Cord', category: 'Electrical', qtyAvailable: 10, qtyDisplay: '10' },
      { id: 'ITM-106', title: 'Work Gloves', category: 'Safety', qtyAvailable: 11, qtyDisplay: '11' },
      { id: 'ITM-107', title: 'Clipboard', category: 'General', qtyAvailable: 12, qtyDisplay: '12' },
      { id: 'ITM-108', title: 'Flashlight', category: 'General', qtyAvailable: 13, qtyDisplay: '13' }
    ];

    function getMeaInventoryScriptUrl() {
      try {
        return (localStorage.getItem('mea_inventory_url') || '').trim();
      } catch(e) { return ''; }
    }

    const INVENTORY_CACHE_KEY = 'mea_inventory_cache';

    function getCachedInventory() {
      try {
        const raw = localStorage.getItem(INVENTORY_CACHE_KEY);
        if (!raw) return null;
        return JSON.parse(raw); // { items, syncedAt }
      } catch(e) { return null; }
    }

    function setCachedInventory(items) {
      try {
        localStorage.setItem(INVENTORY_CACHE_KEY, JSON.stringify({ items, syncedAt: Date.now() }));
      } catch(e) {}
    }

    function offlineOrCachedFallback(reason) {
      const cache = getCachedInventory();
      if (cache && cache.items && cache.items.length) {
        const ago = Math.round((Date.now() - cache.syncedAt) / 60000);
        showInventoryDebug('📡 ' + reason + '\n\nShowing your last synced copy from ' + ago + ' minute(s) ago.');
        return cache.items;
      }
      showInventoryDebug(reason + '\n\nNo previously synced copy on this device yet — showing demo items.');
      return demoInventory;
    }

    async function fetchLiveInventory() {
      window.__meaInventoryDebugError = null;
      const url = getMeaInventoryScriptUrl();
      if (!url) {
        showInventoryDebug('No Inventory Script URL configured yet.\n\nGo to Home → ⚙️ Setup → paste your Inventory Apps Script URL into the "Inventory Script URL" field → Save.');
        return demoInventory; // not configured yet — safe fallback
      }

      if (!navigator.onLine) {
        return offlineOrCachedFallback("You're offline.");
      }

      let res, text;
      try {
        res = await fetch(url + '?action=inventory');
        text = await res.text();
      } catch(networkErr) {
        console.error('[MEA Inventory] Network error reaching script:', networkErr);
        return offlineOrCachedFallback('Network error — could not reach the Inventory script.');
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch(parseErr) {
        console.error('[MEA Inventory] Response was not valid JSON:', text);
        showInventoryDebug('Got a response, but it wasn\'t valid JSON (likely an HTML error page from Apps Script).\n\nFirst 400 characters of the response:\n\n' + text.substring(0, 400));
        return demoInventory;
      }

      if (json && json.ok && Array.isArray(json.items)) {
        console.log('[MEA Inventory] Loaded', json.items.length, 'items from the sheet.');
        window.__meaInventoryDebugError = null;
        const mapped = json.items.map((item, i) => {
          const rawQty = String(item.qty || '').trim();
          const numericQty = parseInt(rawQty, 10);
          return {
            id: 'INV-' + i,
            title: item.title || 'Untitled',
            category: item.category || 'Miscellaneous',
            location: item.location || '',
            notes: item.notes || '',
            qtyDisplay: rawQty || '—',
            qtyAvailable: !isNaN(numericQty) ? numericQty : null // null = uncapped (e.g. "*", "2 packs")
          };
        });
        setCachedInventory(mapped); // remember this for the next time we're offline
        return mapped;
      }

      // Script responded with valid JSON but ok:false or unexpected shape
      const errMsg = (json && json.error) ? json.error : 'Unexpected response shape (missing ok/items).';
      console.error('[MEA Inventory] Script returned an error:', errMsg, json);
      showInventoryDebug('Script responded but reported an error:\n\n' + errMsg + '\n\nFull response:\n' + JSON.stringify(json, null, 2));
      return demoInventory;
    }

    function showInventoryDebug(message) {
      window.__meaInventoryDebugError = message;
    }

    const PENDING_ORDERS_KEY = 'mea_pending_orders';

    function getPendingOrders() {
      try { return JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || '[]'); }
      catch(e) { return []; }
    }

    function savePendingOrders(list) {
      try { localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(list)); } catch(e) {}
      updateOrderSyncPill();
    }

    function enqueuePendingOrder(payload) {
      const list = getPendingOrders();
      list.push({ payload, queuedAt: Date.now() });
      savePendingOrders(list);
    }

    function updateOrderSyncPill() {
      const pill = document.getElementById('orderSyncPill');
      if (!pill) return;
      const count = getPendingOrders().length;
      if (count === 0) {
        pill.classList.remove('show');
        return;
      }
      pill.classList.add('show');
      pill.className = 'order-sync-pill show ' + (navigator.onLine ? 'syncing' : 'offline');
      pill.querySelector('.order-sync-text').textContent =
        count + (count === 1 ? ' order' : ' orders') + ' pending' + (navigator.onLine ? ' — tap to sync' : ' — waiting for connection');
    }

    // The actual network call — throws on any failure, used by both the
    // immediate submit path and the retry queue.
    async function trySubmitOrderToSheet(payload) {
      const url = getMeaInventoryScriptUrl();
      if (!url) throw new Error('No Inventory Script URL configured yet — go to Home → ⚙️ Setup.');

      let res, text;
      try {
        // text/plain avoids a CORS preflight against Apps Script, which
        // doesn't support OPTIONS requests.
        res = await fetch(url + '?action=submitOrder', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
        text = await res.text();
      } catch (networkErr) {
        throw new Error('Network error — could not reach the Inventory script.');
      }

      let json;
      try { json = JSON.parse(text); }
      catch (parseErr) { throw new Error('Script returned an unexpected response.'); }

      if (!json || !json.ok) {
        throw new Error((json && json.error) ? json.error : 'Script reported an error.');
      }
      return json;
    }

    let isFlushingOrders = false;
    async function flushPendingOrders() {
      if (isFlushingOrders || !navigator.onLine) return;
      const pending = getPendingOrders();
      if (!pending.length) return;

      isFlushingOrders = true;
      updateOrderSyncPill();

      while (true) {
        const current = getPendingOrders();
        if (!current.length) break;
        try {
          await trySubmitOrderToSheet(current[0].payload);
          const remaining = getPendingOrders();
          remaining.shift();
          savePendingOrders(remaining);
        } catch(err) {
          break; // still failing — stop, keep the rest queued, retry later
        }
      }

      isFlushingOrders = false;
      updateOrderSyncPill();
    }

    window.flushPendingOrders = flushPendingOrders; // exposed for the sync pill's tap handler
    window.updateOrderSyncPill = updateOrderSyncPill; // exposed so boot can show any queue left over from last session
    window.addEventListener('online', () => { flushPendingOrders(); });
    setInterval(() => { if (navigator.onLine) flushPendingOrders(); }, 20000);

    const localMethods = {
      getInventory: () => fetchLiveInventory(),
      getProjectOptions: () => [
        'Personal','STEPS', 'RWGA', 'ACTS', 'MEAMORE', 'FIESTA', 'PRIME', 'ACSC', 'LEADS',
        'ABM', 'MEA CARES', 'TEDx', 'CB', 'IMD', 'MCD', 'HR:TD', 'HR:MEM',
        'YDC', 'EXT', 'FIN', 'SUS'
      ],
      lookupIdNumber: (idNumber) => ({
        found: /^\\d{4,8}$/.test(String(idNumber).trim()),
        idNumber: String(idNumber).trim(), name: '', committee: '',
        status: /^\\d{4,8}$/.test(String(idNumber).trim()) ? 'ACTIVE' : 'UNKNOWN'
      }),
      submitOrder: async (payload) => {
        // Always keep a full local history — this never fails, regardless
        // of network state, so an order is never silently lost.
        const orders = JSON.parse(localStorage.getItem('mea_inventory_orders') || '[]');
        orders.unshift({ ...payload, createdAt: new Date().toISOString() });
        localStorage.setItem('mea_inventory_orders', JSON.stringify(orders));

        // No URL configured yet — nothing to sync to, but don't lose the order.
        if (!getMeaInventoryScriptUrl()) {
          enqueuePendingOrder(payload);
          return { success: true, queued: true, reason: 'not-configured' };
        }

        // Offline — skip straight to the queue, no point trying the network.
        if (!navigator.onLine) {
          enqueuePendingOrder(payload);
          return { success: true, queued: true, reason: 'offline' };
        }

        // Online — try immediately. If it fails for any reason (network
        // blip, server error), queue it instead of losing it; the queue
        // will retry automatically.
        try {
          const json = await trySubmitOrderToSheet(payload);
          return { success: true, queued: false, orderId: 'ORD-' + Date.now(), logged: json.logged };
        } catch(err) {
          enqueuePendingOrder(payload);
          return { success: true, queued: true, reason: 'error', message: err.message };
        }
      }
    };
    const runner = (success, failure) => new Proxy({}, { get: (_, name) => {
      if (name === 'withSuccessHandler') return fn => runner(fn, failure);
      if (name === 'withFailureHandler') return fn => runner(success, fn);
      return (...args) => Promise.resolve().then(() => localMethods[name](...args)).then(success).catch(failure);
    }});
    window.google = { script: { run: runner() } };
  }

  const state = {
    view: 'home',             // home | catalog | cart | checkout
    catalogFormat: 'grid',   // grid | list
    catalogSearch: '',
    catalogSort: 'default',  // default | name | category | location
    inventory: [],
    cart: {},                // { itemId: { item, qty } }
    scanLog: [],             // { idNumber, status, time }
    lastId: null,            // last scanned/entered ID result
    projectOptions: [],
    checkoutCase: 'BORROWING' // BORROWING | CONSUMING | RETURNING
  };

  /* ---------------- Init ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    seedDefaultScriptUrls();

    bindNav();
    bindHome();
    bindHeaderActions();
    bindCatalogToggle();
    bindCheckoutForm();
    bindModal();

    loadInventory();
    loadProjectOptions();
    updateCartBadge();
    showView('home');

    if (window.updateOrderSyncPill) window.updateOrderSyncPill();
    if (navigator.onLine && window.flushPendingOrders) window.flushPendingOrders();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
  });

  /* ---------------- Navigation ---------------- */

  function bindNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
  }

  function showView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    const navBtn = document.querySelector('.nav-btn[data-view="' + view + '"]');
    if (navBtn) navBtn.classList.add('active');

    // The homepage has its own hero header — hide the shared app chrome so
    // it isn't duplicated. Other views share the standard header + bottom nav.
    const isHome = view === 'home';
    document.getElementById('app-header').style.display = isHome ? 'none' : 'flex';
    document.getElementById('bottom-nav').style.display = isHome ? 'none' : 'flex';
    document.getElementById('cart-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';
    document.getElementById('contact-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';

    if (view === 'cart') renderCart();
    if (view === 'checkout') renderCheckout();
    if (view === 'catalog') loadInventory();
  }

  function bindHeaderActions() {
    document.getElementById('cart-icon-btn').addEventListener('click', () => showView('cart'));
    document.getElementById('contact-icon-btn').addEventListener('click', () => toggleModal(true));
  }

  /* ---------------- Home (page 1 layout) ---------------- */

  const TRACKER_CFG_KEY = 'mea_cfg2';           // same localStorage key the ID Tracker reads
  const INVENTORY_URL_KEY = 'mea_inventory_url'; // separate key — different spreadsheet, different script

  // Default Apps Script URLs — pre-fill the Setup panel and unlock the app
  // automatically on first load. Still fully editable at any time.
  const DEFAULT_TRACKER_URL = 'https://script.google.com/macros/s/AKfycbzWJgA5ZJBER5Tmcc-F-lE4XnuFvqXigvUly-TffEpqS7djIxdo5kHuvCvS9sJm3R8o/exec';
  const DEFAULT_INVENTORY_URL = 'https://script.google.com/macros/s/AKfycbw7gPEvtVG_kciag2BSrGEymUL7wTWtGZS8yemKKRTAVv922PyxaArmLOxsUGWyBD-9Ng/exec';

  function getTrackerScriptUrl() {
    try {
      const raw = localStorage.getItem(TRACKER_CFG_KEY);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return (parsed && parsed.url) ? parsed.url.trim() : '';
    } catch(e) { return ''; }
  }

  function saveTrackerScriptUrl(url) {
    let cfg = {};
    try {
      const raw = localStorage.getItem(TRACKER_CFG_KEY);
      if (raw) cfg = JSON.parse(raw) || {};
    } catch(e) {}
    cfg.url = url;
    if (!cfg.cols) cfg.cols = { INVENTORY: 'A', 'W/Proj': 'A', DEPLOYED: 'A' };
    if (!cfg.cooldown) cfg.cooldown = 3;
    localStorage.setItem(TRACKER_CFG_KEY, JSON.stringify(cfg));
  }

  function getInventoryScriptUrl() {
    try {
      return (localStorage.getItem(INVENTORY_URL_KEY) || '').trim();
    } catch(e) { return ''; }
  }

  function saveInventoryScriptUrl(url) {
    localStorage.setItem(INVENTORY_URL_KEY, url);
  }

  // Seeds both URLs with their defaults the very first time the app runs on
  // a device, without ever overwriting a URL the person has already saved
  // (their own edits — including clearing it back to blank — always win).
  function seedDefaultScriptUrls() {
    if (localStorage.getItem(TRACKER_CFG_KEY) === null) {
      saveTrackerScriptUrl(DEFAULT_TRACKER_URL);
    }
    if (localStorage.getItem(INVENTORY_URL_KEY) === null) {
      saveInventoryScriptUrl(DEFAULT_INVENTORY_URL);
    }
  }

  function updateIdTrackerCardState() {
    const idValue = document.getElementById('home-id-input').value.trim();
    const scriptUrl = getTrackerScriptUrl();
    const card = document.getElementById('home-nav-idtracker');
    const sub = document.getElementById('idtracker-sub');

    const ready = !!idValue && !!scriptUrl;
    card.classList.toggle('disabled', !ready);

    if (!scriptUrl) {
      sub.textContent = 'Setup required — tap ⚙️ to add Apps Script URL';
    } else if (!idValue) {
      sub.textContent = 'Enter your ID number above first';
    } else {
      sub.textContent = 'Scan & verify a MEA ID';
    }
  }

  function bindHome() {
    document.getElementById('home-nav-inventory').addEventListener('click', () => {
      captureHomeId();
      showView('catalog');
    });

    document.getElementById('home-nav-idtracker').addEventListener('click', () => {
      const idValue = document.getElementById('home-id-input').value.trim();
      const scriptUrl = getTrackerScriptUrl();

      if (!scriptUrl) {
        showToast('Add your Apps Script URL first — tap ⚙️', true);
        return;
      }
      if (!idValue) {
        showToast('Enter your ID number first', true);
        document.getElementById('home-id-input').focus();
        return;
      }

      // The tracker stays in its original, self-contained document so its
      // NFC, settings, saved IDs, and Google Sheets behavior are untouched.
      captureHomeId();
      window.location.href = 'id-tracker.html?id=' + encodeURIComponent(idValue);
    });

    document.getElementById('home-id-input').addEventListener('input', (e) => {
      try { sessionStorage.setItem('mea_home_id', e.target.value); } catch(err) {}
      updateIdTrackerCardState();
    });

    // Restore the ID typed earlier in this session — e.g. after navigating
    // to id-tracker.html and back, which fully reloads this page.
    try {
      const savedId = sessionStorage.getItem('mea_home_id');
      if (savedId) document.getElementById('home-id-input').value = savedId;
    } catch(e) {}

    document.getElementById('home-menu-btn').addEventListener('click', () => triggerInstall());

    document.getElementById('home-setup-btn').addEventListener('click', () => {
      const panel = document.getElementById('setupPanel');
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        document.getElementById('home-script-url').value = getTrackerScriptUrl();
        document.getElementById('home-inventory-url').value = getInventoryScriptUrl();
      }
    });

    document.getElementById('test-inventory-url-btn').addEventListener('click', async () => {
      const url = document.getElementById('home-inventory-url').value.trim();
      const box = document.getElementById('inventoryTestStatus');
      const btn = document.getElementById('test-inventory-url-btn');

      if (!url) {
        box.textContent = '✕ Enter a URL first.';
        box.className = 'setup-status error';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Testing…';
      box.textContent = '';
      box.className = 'setup-status';

      try {
        const res = await fetch(url + '?action=inventory');
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch(e) {}

        if (json && json.ok && Array.isArray(json.items)) {
          box.textContent = `✓ Connected! Found ${json.items.length} item(s).\n\nFirst item: ${json.items[0] ? JSON.stringify(json.items[0]) : '(none)'}`;
          box.className = 'setup-status ok';
        } else if (json && json.ok === false) {
          box.textContent = `✕ Script responded with an error:\n${json.error || '(no message)'}`;
          box.className = 'setup-status error';
        } else if (text.includes('<html') || text.includes('<!DOCTYPE')) {
          box.textContent = '✕ Got an HTML page instead of JSON.\n\nMost likely cause: the script isn\'t deployed with "Who has access: Anyone", or it needs a fresh "New version" deployment.';
          box.className = 'setup-status error';
        } else {
          box.textContent = '✕ Unexpected response:\n' + text.substring(0, 300);
          box.className = 'setup-status error';
        }
      } catch(err) {
        box.textContent = '✕ Network error: ' + err.message;
        box.className = 'setup-status error';
      }

      btn.disabled = false;
      btn.textContent = 'Test Inventory Connection';
    });

    document.getElementById('save-script-url-btn').addEventListener('click', () => {
      const trackerUrl = document.getElementById('home-script-url').value.trim();
      const inventoryUrl = document.getElementById('home-inventory-url').value.trim();
      const status = document.getElementById('setupStatus');

      if (!trackerUrl && !inventoryUrl) {
        status.textContent = 'Enter at least one Apps Script URL.';
        status.className = 'setup-status error';
        return;
      }
      if (trackerUrl) saveTrackerScriptUrl(trackerUrl);
      if (inventoryUrl) saveInventoryScriptUrl(inventoryUrl);

      status.textContent = 'Saved!';
      status.className = 'setup-status ok';
      updateIdTrackerCardState();
      loadInventory(); // refresh right away so Catalog isn't stuck on stale/demo data
      setTimeout(() => { document.getElementById('setupPanel').style.display = 'none'; }, 900);
    });

    const logoBtn = document.getElementById('logo-home-btn');
    if (logoBtn) logoBtn.addEventListener('click', () => showView('home'));

    updateIdTrackerCardState();
  }

  /**
   * Reads the ID number typed on the homepage and, if present, verifies it
   * right away so it's already attached to state.lastId no matter which
   * destination (Inventory or ID Tracker) the person opens next.
   */
  function captureHomeId() {
    const idValue = document.getElementById('home-id-input').value.trim();
    if (!idValue) return '';

    google.script.run
      .withSuccessHandler(result => {
        state.lastId = result;
      })
      .withFailureHandler(() => {})
      .lookupIdNumber(idValue, 'HOME');

    return idValue;
  }

  /* ---------------- Inventory / catalog ---------------- */

  function loadInventory() {
    google.script.run
      .withSuccessHandler(items => {
        state.inventory = items || [];
        renderCatalog();
      })
      .withFailureHandler(err => showToast(err.message || 'Could not load inventory', true))
      .getInventory();
  }

  function loadProjectOptions() {
    google.script.run
      .withSuccessHandler(options => {
        state.projectOptions = options || [];
        const select = document.getElementById('project-select');
        select.innerHTML = state.projectOptions
          .map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
          .join('');
      })
      .withFailureHandler(() => {})
      .getProjectOptions();
  }

  function bindCatalogToggle() {
    document.getElementById('format-grid-btn').addEventListener('click', () => setCatalogFormat('grid'));
    document.getElementById('format-list-btn').addEventListener('click', () => setCatalogFormat('list'));

    document.getElementById('catalog-search').addEventListener('input', (e) => {
      state.catalogSearch = e.target.value;
      renderCatalog();
    });

    document.getElementById('catalog-sort').addEventListener('change', (e) => {
      state.catalogSort = e.target.value;
      renderCatalog();
    });
  }

  function setCatalogFormat(format) {
    state.catalogFormat = format;
    document.getElementById('format-grid-btn').classList.toggle('active', format === 'grid');
    document.getElementById('format-list-btn').classList.toggle('active', format === 'list');
    renderCatalog();
  }

  // Returns state.inventory filtered by the search box (matches title,
  // category, location, or notes) and sorted per the sort dropdown —
  // Category uses the sheet's own Category column, per request.
  function getVisibleInventory() {
    const q = state.catalogSearch.trim().toLowerCase();
    let items = state.inventory;

    if (q) {
      items = items.filter(item => {
        const haystack = [item.title, item.category, item.location, item.notes]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    const sorted = items.slice();
    if (state.catalogSort === 'name') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (state.catalogSort === 'category') {
      sorted.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));
    } else if (state.catalogSort === 'location') {
      sorted.sort((a, b) => (a.location || '').localeCompare(b.location || '') || a.title.localeCompare(b.title));
    }
    return sorted;
  }

  function renderCatalog() {
    const container = document.getElementById('catalog-container');
    const debugMsg = window.__meaInventoryDebugError;
    const debugHtml = debugMsg
      ? `<div style="grid-column:1/-1;background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.3);border-radius:12px;padding:14px;font-size:11px;font-family:monospace;color:#ffb3b3;white-space:pre-wrap;word-break:break-word;margin-bottom:10px;">⚠ Inventory fetch failed — showing demo items below.\n\n${escapeHtml(debugMsg)}</div>`
      : '';

    if (!state.inventory.length) {
      container.innerHTML = debugHtml + '<div class="empty-state"><img class="svg-icon" src="icons/ui/archive-box.svg" alt="">Inventory is empty</div>';
      return;
    }

    const visible = getVisibleInventory();

    if (!visible.length) {
      container.className = state.catalogFormat === 'grid' ? 'item-grid' : 'item-list';
      container.innerHTML = debugHtml + '<div class="empty-state" style="grid-column:1/-1;"><img class="svg-icon" src="icons/ui/archive-box.svg" alt="">No items match your search</div>';
      return;
    }

    if (state.catalogFormat === 'grid') {
      container.className = 'item-grid';
      container.innerHTML = debugHtml + visible.map(item => `
        <div class="item-card" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-thumb">${locationTag(item.location)}</div>
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${escapeHtml(item.qtyDisplay != null ? item.qtyDisplay : item.qtyAvailable)}</div>
        </div>
      `).join('');
    } else {
      container.className = 'item-list';
      container.innerHTML = debugHtml + visible.map(item => `
        <div class="item-row" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-thumb">${locationTag(item.location)}</div>
          <div class="item-info">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-qty">${item.notes ? escapeHtml(item.notes) : '<span style="opacity:0.5">No notes</span>'}</div>
          </div>
          ${cartQty(item.id) > 0 ? `<div class="in-cart-badge">${cartQty(item.id)} in cart</div>` : ''}
        </div>
      `).join('');
    }
  }

  function cartQty(itemId) {
    return state.cart[itemId] ? state.cart[itemId].qty : 0;
  }

  function addToCart(itemId) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const current = state.cart[itemId] || { item: item, qty: 0 };
    current.qty += 1;
    state.cart[itemId] = current;
    updateCartBadge();
    showToast(item.title + ' added to cart');
  }

  function stepQty(itemId, delta) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const current = state.cart[itemId] || { item: item, qty: 0 };
    current.qty = Math.max(0, current.qty + delta);
    if (current.qty === 0) {
      delete state.cart[itemId];
    } else {
      state.cart[itemId] = current;
    }
    updateCartBadge();
    renderCatalog();
    if (state.view === 'cart') renderCart();
  }

  function setQty(itemId, value) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const qty = Math.max(0, parseInt(value, 10) || 0);
    if (qty === 0) {
      delete state.cart[itemId];
    } else {
      state.cart[itemId] = { item: item, qty: qty };
    }
    updateCartBadge();
    if (state.view === 'cart') renderCart();
  }

  function updateCartBadge() {
    const count = Object.values(state.cart).reduce((sum, c) => sum + c.qty, 0);
    const badge = document.getElementById('cart-badge');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  /* ---------------- Cart view ---------------- */

  function renderCart() {
    const container = document.getElementById('cart-list');
    const entries = Object.values(state.cart);
    const checkoutBtn = document.getElementById('cart-checkout-btn');

    if (!entries.length) {
      container.innerHTML = '<div class="empty-state"><img class="svg-icon" src="icons/ui/shopping-basket.svg" alt="">Your cart is empty</div>';
      checkoutBtn.disabled = true;
      return;
    }
    checkoutBtn.disabled = false;

    container.innerHTML = entries.map(({ item, qty }) => `
      <div class="item-row">
        <div class="item-thumb">${locationTag(item.location)}</div>
        <div class="item-info">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${item.notes ? escapeHtml(item.notes) : '<span style="opacity:0.5">No notes</span>'}</div>
        </div>
        <div class="qty-stepper">
          <button class="qty-btn" onclick="stepQty('${escapeAttr(item.id)}', -1)">−</button>
          <input type="number" min="0" value="${qty}"
                 onchange="setQty('${escapeAttr(item.id)}', this.value)" />
          <button class="qty-btn" onclick="stepQty('${escapeAttr(item.id)}', 1)">+</button>
        </div>
      </div>
    `).join('');
  }

  /* ---------------- Checkout view ---------------- */

  const CASE_HINTS = {
    BORROWING: 'Comment the quantity to be borrowed, project/department, and point person on the quantity column of the item.',
    CONSUMING: 'Comment the quantity to be consumed, project/department, and point person on the quantity column of the item.',
    RETURNING: 'Resolve your comment on the quantity column once borrowed materials have been returned.'
  };

  function renderCheckout() {
    document.getElementById('checkout-id-display').textContent =
      state.lastId && state.lastId.idNumber ? state.lastId.idNumber : 'Not scanned yet';

    if (state.lastId && state.lastId.committee) {
      document.getElementById('committee-input').value = state.lastId.committee;
    }

    const entries = Object.values(state.cart);
    const tbody = document.getElementById('checkout-summary-body');
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="2">No items selected</td></tr>';
    } else {
      tbody.innerHTML = entries.map(({ item, qty }) => `
        <tr><td>${escapeHtml(item.title)}</td><td>${qty}x</td></tr>
      `).join('');
    }
  }

  function bindCheckoutForm() {
    document.getElementById('submit-order-btn').addEventListener('click', submitOrder);

    document.querySelectorAll('.case-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.case-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.checkoutCase = btn.dataset.case;
        document.getElementById('case-hint').textContent = CASE_HINTS[state.checkoutCase];
      });
    });
  }

  function submitOrder() {
    const entries = Object.values(state.cart);
    if (!state.lastId || !state.lastId.idNumber) {
      showToast('Enter your ID number on the Home page first', true);
      showView('home');
      return;
    }
    if (!entries.length) {
      showToast('Your cart is empty', true);
      return;
    }

    const committee = document.getElementById('committee-input').value;
    const project = document.getElementById('project-select').value;
    const pointPerson = (state.lastId && state.lastId.name) ? state.lastId.name : state.lastId.idNumber;

    const payload = {
      idNumber: state.lastId.idNumber,
      caseType: state.checkoutCase, // BORROWING | CONSUMING | RETURNING
      project: project,
      committee: committee,
      items: entries.map(({ item, qty }) => ({
        id: item.id,
        title: item.title,
        qty: qty,
        // Matches the sheet's own comment convention, e.g. "[BORROWING] - 24 ACTS, Renzo Gutierrez"
        comment: `[${state.checkoutCase}] - ${qty} ${committee || project}, ${pointPerson}`
      }))
    };

    const btn = document.getElementById('submit-order-btn');
    btn.disabled = true;
    btn.textContent = 'SUBMITTING…';

    google.script.run
      .withSuccessHandler((result) => {
        if (result && result.queued) {
          showToast('Saved offline — will sync automatically');
        } else {
          showToast('Order submitted');
        }
        state.cart = {};
        updateCartBadge();
        btn.disabled = false;
        btn.textContent = 'SUBMIT ORDER';
        showView('home');
      })
      .withFailureHandler(err => {
        showToast(err.message || 'Could not submit order', true);
        btn.disabled = false;
        btn.textContent = 'SUBMIT ORDER';
      })
      .submitOrder(payload);
  }

  /* ---------------- Contact modal ---------------- */

  function bindModal() {
    document.getElementById('modal-close-btn').addEventListener('click', () => toggleModal(false));
    document.getElementById('modal-backdrop').addEventListener('click', e => {
      if (e.target.id === 'modal-backdrop') toggleModal(false);
    });
  }

  function toggleModal(show) {
    document.getElementById('modal-backdrop').classList.toggle('show', show);
  }

  /* ---------------- Install App (PWA) ---------------- */

  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  window.addEventListener('appinstalled', () => {
    showToast('MEA App installed!');
  });

  async function triggerInstall() {
    if (!deferredInstallPrompt) {
      showToast('App may already be installed, or your browser doesn\'t support installing yet');
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      showToast('Installing MEA App…');
    }
    deferredInstallPrompt = null;
  }

  /* ---------------- Toast ---------------- */

  let toastTimer = null;
  function showToast(message, isError) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  /* ---------------- Utils ---------------- */

  // A curated set of colors that all sit comfortably on the app's dark teal
  // background and stay readable with white text — used to give every
  // distinct storage location its own consistent, recognizable color.
  const LOCATION_PALETTE = [
    '#1a6b6b', '#2a5d9d', '#6b4fa0', '#9d3f6b', '#a05a2a',
    '#5c7a2a', '#2a9d6e', '#4a4a9d', '#9d6b2a', '#2a7d9d',
    '#7a3f9d', '#3f9d5a'
  ];

  function locationColor(location) {
    if (!location) return '#3a4a52'; // neutral slate for unassigned items
    let hash = 0;
    for (let i = 0; i < location.length; i++) {
      hash = (hash * 31 + location.charCodeAt(i)) >>> 0;
    }
    return LOCATION_PALETTE[hash % LOCATION_PALETTE.length];
  }

  function locationTag(location) {
    const text = location && location.trim() ? location.trim() : 'Unassigned';
    const color = locationColor(location);
    return `<div class="loc-tag" style="background:${color}" title="${escapeAttr(text)}">${escapeHtml(text)}</div>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
  function escapeAttr(str) {
    return String(str).replace(/'/g, "\\'");
  }
