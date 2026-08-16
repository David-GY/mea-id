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

    async function fetchLiveInventory() {
      window.__meaInventoryDebugError = null;
      const url = getMeaInventoryScriptUrl();
      if (!url) {
        showInventoryDebug('No Inventory Script URL configured yet.\n\nGo to Home → ⚙️ Setup → paste your Inventory Apps Script URL into the "Inventory Script URL" field → Save.');
        return demoInventory; // not configured yet — safe fallback
      }

      let res, text;
      try {
        res = await fetch(url + '?action=inventory');
        text = await res.text();
      } catch(networkErr) {
        console.error('[MEA Inventory] Network error reaching script:', networkErr);
        showInventoryDebug('Network error — could not reach the URL.\n\n' + networkErr.message + '\n\nURL tried:\n' + url);
        return demoInventory;
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
        return json.items.map((item, i) => {
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

    const localMethods = {
      getInventory: () => fetchLiveInventory(),
      getProjectOptions: () => ['General Operations', 'Field Deployment', 'Workshop Build', 'Community Outreach'],
      lookupIdNumber: (idNumber) => ({
        found: /^\\d{4,8}$/.test(String(idNumber).trim()),
        idNumber: String(idNumber).trim(), name: '', committee: '',
        status: /^\\d{4,8}$/.test(String(idNumber).trim()) ? 'ACTIVE' : 'UNKNOWN'
      }),
      submitOrder: (payload) => {
        const orders = JSON.parse(localStorage.getItem('mea_inventory_orders') || '[]');
        orders.unshift({ ...payload, createdAt: new Date().toISOString() });
        localStorage.setItem('mea_inventory_orders', JSON.stringify(orders));
        return { success: true, orderId: 'LOCAL-' + Date.now() };
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
    inventory: [],
    cart: {},                // { itemId: { item, qty } }
    scanLog: [],             // { idNumber, status, time }
    lastId: null,            // last scanned/entered ID result
    projectOptions: [],
    checkoutCase: 'BORROWING' // BORROWING | CONSUMING | RETURNING
  };

  /* ---------------- Init ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
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

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
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
  }

  function bindHeaderActions() {
    document.getElementById('cart-icon-btn').addEventListener('click', () => showView('cart'));
    document.getElementById('contact-icon-btn').addEventListener('click', () => toggleModal(true));
  }

  /* ---------------- Home (page 1 layout) ---------------- */

  const TRACKER_CFG_KEY = 'mea_cfg2';           // same localStorage key the ID Tracker reads
  const INVENTORY_URL_KEY = 'mea_inventory_url'; // separate key — different spreadsheet, different script

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

    document.getElementById('home-id-input').addEventListener('input', updateIdTrackerCardState);

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
  }

  function setCatalogFormat(format) {
    state.catalogFormat = format;
    document.getElementById('format-grid-btn').classList.toggle('active', format === 'grid');
    document.getElementById('format-list-btn').classList.toggle('active', format === 'list');
    renderCatalog();
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

    if (state.catalogFormat === 'grid') {
      container.className = 'item-grid';
      container.innerHTML = debugHtml + state.inventory.map(item => `
        <div class="item-card" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-thumb"><img class="svg-icon" src="icons/ui/archive-box.svg" alt=""></div>
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${escapeHtml(item.qtyDisplay != null ? item.qtyDisplay : item.qtyAvailable)}</div>
        </div>
      `).join('');
    } else {
      container.className = 'item-list';
      container.innerHTML = debugHtml + state.inventory.map(item => `
        <div class="item-row" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-thumb"><img class="svg-icon" src="icons/ui/archive-box.svg" alt=""></div>
          <div class="item-info">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-qty">${escapeHtml(item.qtyDisplay != null ? item.qtyDisplay : item.qtyAvailable)}</div>
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
        <div class="item-thumb"><img class="svg-icon" src="icons/ui/archive-box.svg" alt=""></div>
        <div class="item-info">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${escapeHtml(item.qtyDisplay != null ? item.qtyDisplay : item.qtyAvailable)}</div>
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
      .withSuccessHandler(() => {
        showToast('Order submitted');
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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
  function escapeAttr(str) {
    return String(str).replace(/'/g, "\\'");
  }
