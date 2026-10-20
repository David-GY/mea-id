/* ==================================================================
     MEA ID Tracker — client logic
     ================================================================== */

  // GitHub Pages does not provide Apps Script's google.script.run object. This
  // small local adapter keeps the app usable there while preserving the same
  // call shape for Apps Script deployments. Inventory snapshots and refresh
  // state are managed by loadInventory, after stale-response checks.
  if (!window.google || !window.google.script || !window.google.script.run) {

    function getMeaInventoryScriptUrl() {
      try {
        return (localStorage.getItem('mea_inventory_url') || '').trim();
      } catch(e) { return ''; }
    }

    async function fetchLiveInventory() {
      const url = getMeaInventoryScriptUrl();
      if (!url) throw new Error('Set up the Inventory Script URL in Settings first.');
      if (!navigator.onLine) throw new TypeError("You're offline.");

      let res, text;
      try {
        res = await fetch(url + '?action=inventory');
        text = await res.text();
      } catch(networkErr) {
        throw new TypeError('Network error — could not reach the Inventory script.');
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch(parseErr) {
        throw new Error('The inventory script returned an invalid response. Try refreshing.');
      }

      if (json && json.ok && Array.isArray(json.items)) {
        const mapped = json.items.map((item, i) => {
          const rawQty = String(item.qty ?? '').trim();
          const numericQty = MeaCart.availability(rawQty).value;
          return {
            id: item.id || 'legacy:' + JSON.stringify([item.title, item.location, item.category]),
            stableId: !!item.id, itemCode: item.itemCode || '',
            title: item.title || 'Untitled',
            category: item.category || 'Miscellaneous',
            location: item.location || '',
            notes: item.notes || '',
            qtyDisplay: rawQty || '—',
            qtyAvailable: numericQty // null = uncapped (e.g. "*", "2 packs")
          };
        });
        return mapped;
      }

      // Script responded with valid JSON but ok:false or unexpected shape
      const errMsg = (json && json.error) ? json.error : 'Unexpected response shape (missing ok/items).';
      throw new Error(errMsg);
    }

    const PENDING_ORDERS_KEY = 'mea_pending_orders';
    const FAILED_ORDERS_KEY = 'mea_failed_orders';
    const MAX_ORDER_ATTEMPTS = 5;

    function getPendingOrders() {
      try { return JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || '[]'); }
      catch(e) { return []; }
    }

    function savePendingOrders(list) {
      localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(list));
      updateOrderSyncPill();
      document.dispatchEvent(new Event('mea:queuechange'));
    }

    function getFailedOrders() {
      try { return JSON.parse(localStorage.getItem(FAILED_ORDERS_KEY) || '[]'); }
      catch(e) { return []; }
    }

    function saveFailedOrders(list) {
      localStorage.setItem(FAILED_ORDERS_KEY, JSON.stringify(list));
    }

    function enqueuePendingOrder(payload, clientId) {
      const list = getPendingOrders();
      // Reuse the caller's clientId when given (e.g. a failed immediate
      // attempt that may have actually landed server-side) so a later
      // retry carries the same idempotency key instead of a fresh one.
      clientId = clientId || (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
      list.push({ payload, queuedAt: Date.now(), attempts: 0, clientId });
      savePendingOrders(list);
    }

    function updateOrderSyncPill() {
      const pill = document.getElementById('orderSyncPill');
      if (!pill) return;
      const owner = getSavedLogin()?.idNumber;
      const count = getPendingOrders().filter(x => x.payload.idNumber === owner).length;
      const failedCount = getFailedOrders().filter(x => x.payload.idNumber === owner).length;
      if (count === 0 && failedCount === 0) {
        pill.classList.remove('show');
        return;
      }
      pill.classList.add('show');
      pill.className = 'order-sync-pill show ' + (navigator.onLine ? 'syncing' : 'offline');
      const parts = [];
      if (count) parts.push(count + (count === 1 ? ' order' : ' orders') + ' pending');
      if (failedCount) parts.push(failedCount + ' failed — tap to retry');
      pill.querySelector('.order-sync-text').textContent =
        parts.join(', ') + (count && navigator.onLine ? ' — tap to sync' : (count ? ' — waiting for connection' : ''));
    }

    // The actual network call — throws on any failure, used by both the
    // immediate submit path and the retry queue. clientId is an idempotency
    // key: if a retry follows a request that actually succeeded server-side
    // but the response never reached us, a hardened backend can recognize
    // it and skip inserting the order twice.
    async function trySubmitOrderToSheet(payload, clientId) {
      const url = getMeaInventoryScriptUrl();
      if (!url) throw new Error('No Inventory Script URL configured yet — go to Home > Settings.');

      const token = getInventoryToken();
      const body = Object.assign({ clientId: clientId || null }, payload, token ? { token } : {});

      let res, text;
      try {
        // text/plain avoids a CORS preflight against Apps Script, which
        // doesn't support OPTIONS requests.
        res = await fetch(url + '?action=submitOrder', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        text = await res.text();
      } catch (networkErr) {
        throw new Error('Network error — could not reach the Inventory script.');
      }

      let json;
      try { json = JSON.parse(text); }
      catch (parseErr) { throw new Error('Script returned an unexpected response.'); }

      if (!json || !json.ok) {
        const error = new Error((json && json.error) ? json.error : 'Script reported an error.');
        error.permanent = !!(json && json.retryable === false);
        throw error;
      }
      return json;
    }

    let isFlushingOrders = false;
    async function flushPendingOrders() {
      if (isFlushingOrders || !navigator.onLine) return;
      const pending = getPendingOrders();
      if (!pending.length) return;

      isFlushingOrders = true;
      let changed = false;
      updateOrderSyncPill();

      while (true) {
        const current = getPendingOrders();
        if (!current.length) break;
        const item = current[0];
        try {
          await trySubmitOrderToSheet(item.payload, item.clientId);
          invalidateReadData(); changed = true;
          const remaining = getPendingOrders();
          remaining.shift();
          savePendingOrders(remaining);
        } catch(err) {
          // One permanently-failing order (bad data, a removed sheet) would
          // otherwise block every order behind it forever — after
          // MAX_ORDER_ATTEMPTS it moves to a "failed" bucket instead, and
          // the queue keeps moving.
          const remaining = getPendingOrders();
          if (remaining.length && remaining[0].clientId === item.clientId) {
            remaining[0].attempts = (remaining[0].attempts || 0) + 1;
            if (remaining[0].attempts >= MAX_ORDER_ATTEMPTS) {
              const failedItem = remaining.shift();
              const failedQ = getFailedOrders();
              failedQ.push(failedItem);
              saveFailedOrders(failedQ);
              savePendingOrders(remaining);
              continue;
            }
            savePendingOrders(remaining);
          }
          break; // still within retry budget — stop, keep it queued, try again later
        }
      }

      isFlushingOrders = false;
      updateOrderSyncPill();
      if (changed) refreshActiveReadData();
    }

    function retryFailedOrders() {
      const failed = getFailedOrders();
      if (!failed.length) return;
      const q = getPendingOrders();
      failed.forEach(item => { item.attempts = 0; q.push(item); });
      savePendingOrders(q);
      saveFailedOrders([]);
      flushPendingOrders();
    }

    function orderSyncPillClick() {
      if (getFailedOrders().length) { retryFailedOrders(); return; }
      flushPendingOrders();
    }

    window.flushPendingOrders = orderSyncPillClick; // exposed for the sync pill's tap handler
    window.updateOrderSyncPill = updateOrderSyncPill; // exposed so boot can show any queue left over from last session
    window.addEventListener('online', () => { flushPendingOrders(); });
    setInterval(() => { if (navigator.onLine) flushPendingOrders(); }, 20000);

    const PROJECT_OPTIONS = [
      'Personal','STEPS', 'RWGA', 'ACTS', 'MEAMORE', 'FIESTA', 'PRIME', 'ACSC', 'LEADS',
      'ABM', 'MEA CARES', 'TEDx', 'CB', 'IMD', 'MCD', 'HR:TD', 'HR:MEM',
      'YDC', 'EXT', 'FIN', 'SUS', 'COMEALEC'
    ];

    const localMethods = {
      getInventory: () => fetchLiveInventory(),
      getProjectOptions: () => PROJECT_OPTIONS.slice(),
      lookupIdNumber: (idNumber) => ({
        found: /^\d{6}$/.test(String(idNumber).trim()),
        idNumber: String(idNumber).trim(), name: '', level: 'NONE',
        status: /^\d{6}$/.test(String(idNumber).trim()) ? 'ACTIVE' : 'UNKNOWN'
      }),
      submitOrder: async (payload) => {
        // Always keep a full local history — this never fails, regardless
        // of network state, so an order is never silently lost.
        const orders = JSON.parse(localStorage.getItem('mea_inventory_orders') || '[]');
        orders.unshift({ ...payload, createdAt: new Date().toISOString() });
        localStorage.setItem('mea_inventory_orders', JSON.stringify(orders));

        const clientId = payload.clientId || crypto.randomUUID();

        // No URL configured yet — nothing to sync to, but don't lose the order.
        if (!getMeaInventoryScriptUrl()) {
          enqueuePendingOrder(payload, clientId);
          return { success: true, queued: true, reason: 'not-configured' };
        }

        // Offline — skip straight to the queue, no point trying the network.
        if (!navigator.onLine) {
          enqueuePendingOrder(payload, clientId);
          return { success: true, queued: true, reason: 'offline' };
        }

        // Online — try immediately. If it fails for any reason (network
        // blip, server error), queue it instead of losing it; the queue
        // will retry automatically.
        try {
          const json = await trySubmitOrderToSheet(payload, clientId);
          return { success: true, queued: false, orderId: 'ORD-' + Date.now(), logged: json.logged };
        } catch(err) {
          if (err.permanent) throw err;
          enqueuePendingOrder(payload, clientId);
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
    view: 'login',           // login | home | settings | help | history | catalog | cart | checkout
    catalogFormat: 'grid',   // grid | list
    catalogSearch: '',
    catalogSort: 'default',  // default | name | category | location
    catalogCategory: 'all',  // 'all' or one of the sheet's own Category values
    inventory: [],
    cart: {},                // { itemId: { item, qty } }
    scanLog: [],             // { idNumber, status, time }
    lastId: null,            // logged-in ID lookup result: { idNumber, name, role, committee, status }
    projectOptions: [],
    historyTab: 'personal',  // personal | project
    checkoutCase: 'BORROWING' // BORROWING | CONSUMING | RETURNING
  };

  /* =========================================================
     LOGIN PERSISTENCE
     The logged-in ID stays on the device across reloads/relaunches
     until the person taps "Log out" in Settings.
     ========================================================= */
  const LOGIN_KEY = 'mea_login_v1';

  function getSavedLogin() {
    try {
      const raw = localStorage.getItem(LOGIN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }
  function saveLogin(result) {
    try { localStorage.setItem(LOGIN_KEY, JSON.stringify(result)); } catch(e) {}
  }
  function clearLogin() {
    try { localStorage.removeItem(LOGIN_KEY); } catch(e) {}
  }

  /* =========================================================
     PERMISSION MODEL
     Matches the real ACCESS sheet: column C ("Level") holds one of
     Admin / Tracker / Dashboard for people who get elevated access.
     Anyone not listed in ACCESS can still log in (as long as they're
     in MAIN) but gets neither ID Tracker nor SUS Dashboard.
       Admin      → ID Tracker + SUS Dashboard
       Tracker    → ID Tracker only
       Dashboard  → SUS Dashboard only
       (anything else / not listed) → neither
     ========================================================= */
  function canOpenTracker(loginResult) {
    if (!loginResult || loginResult.accountKind === 'GUEST') return false;
    const level = String(loginResult.level || '').trim().toUpperCase();
    return level === 'ADMIN' || level === 'TRACKER';
  }
  function canOpenDashboard(loginResult) {
    if (!loginResult || loginResult.accountKind === 'GUEST') return false;
    const level = String(loginResult.level || '').trim().toUpperCase();
    return level === 'ADMIN' || level === 'DASHBOARD';
  }

  /**
   * Logs an ID number in against the combined Apps Script.
   *   GET <trackerUrl>?action=login&id=<6-digit id>
   * Response: { ok:true, found:true/false, idNumber, name, level }
   * found:false means the ID isn't a valid 6-digit number in MAIN.
   * level is "NONE" (or missing) when the ID isn't in ACCESS at all.
   */
  async function fetchIdLookup(idNumber) {
    const url = getTrackerScriptUrl();
    if (!url) {
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'NOT_CONFIGURED' };
    }
    let res, text;
    try {
      const loginParams = new URLSearchParams({ action: 'login', id: idNumber });
      const token = getTrackerToken();
      if (token) loginParams.set('token', token);
      res = await fetch(url + '?' + loginParams.toString());
      text = await res.text();
    } catch (networkErr) {
      console.error('[MEA Login] Network error during lookup:', networkErr);
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'NETWORK_ERROR' };
    }

    let json;
    try { json = JSON.parse(text); }
    catch (parseErr) {
      console.error('[MEA Login] Lookup response was not valid JSON:', text);
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'ERROR' };
    }

    if (!json || json.ok === false) {
      console.error('[MEA Login] Script reported an error:', json && json.error, json);
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'ERROR' };
    }

    if (json.found) {
      return {
        found: true,
        idNumber: json.idNumber || String(idNumber).trim(),
        name: json.name || '',
        level: (json.level || 'NONE').toUpperCase(),
        status: 'ACTIVE'
      };
    }
    return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'NOT_FOUND' };
  }

  function renderIdentity() {
    const r = state.lastId;
    const idText = r ? (r.accountKind === 'GUEST' ? 'Guest · ' + r.guestCode : r.idNumber + (r.verified ? ' · Verified member' : ' · ID-only')) : '—';
    const nameText = (r && r.name) ? r.name : (r ? 'Unknown Member' : '—');
    ['home', 'settings', 'help', 'history'].forEach(v => {
      const idEl = document.getElementById(v + '-identity-id');
      const nameEl = document.getElementById(v + '-identity-name');
      if (idEl) idEl.textContent = idText;
      if (nameEl) nameEl.textContent = nameText;
    });
  }

  function updateHomeCardStates() {
    const trackerCard = document.getElementById('home-nav-idtracker');
    const trackerSub = document.getElementById('idtracker-sub');
    const dashCard = document.getElementById('home-nav-dashboard');
    const dashSub = document.getElementById('dashboard-sub');
    if (!trackerCard || !dashCard) return;

    const trackerOk = canOpenTracker(state.lastId);
    const dashOk = canOpenDashboard(state.lastId);
    trackerCard.classList.toggle('disabled', !trackerOk);
    dashCard.classList.toggle('disabled', !dashOk);
    document.querySelectorAll('.restricted-dashboard-nav').forEach(btn => {
      btn.classList.toggle('disabled', !dashOk);
      btn.setAttribute('aria-hidden', dashOk ? 'false' : 'true');
    });

    if (!getTrackerScriptUrl()) {
      trackerSub.textContent = 'Setup required — contact an admin';
      dashSub.textContent = 'Setup required — contact an admin';
      return;
    }
    trackerSub.textContent = trackerOk ? 'Choose a destination & move IDs' : 'Restricted — Tracker access required';
    dashSub.textContent = dashOk ? 'Analytics & reports' : 'Restricted — Dashboard access required';
  }

  /* ---------------- Accessibility: keyboard support for role="button" divs ----------------
     A handful of controls (home cards, bottom nav) are non-<button> elements
     for layout reasons; this makes them behave like real buttons for anyone
     navigating by keyboard or screen reader, without touching their click
     handlers, which stay bound the normal way. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[role="button"]');
    if (!el) return;
    e.preventDefault();
    el.click();
  });

  /* ---------------- Init ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    seedDefaultScriptUrls();

    bindNav();
    bindMainNav();
    bindSidebarLogout();
    bindLogin();
    bindHome();
    bindSettings();
    bindHeaderActions();
    bindCatalogToggle();
    document.getElementById('catalog-refresh')?.addEventListener('click', () => loadInventory({force: true}));
    bindCheckoutForm();
    bindModal();
    bindInstallBanner();
    renderContacts();

    loadInventory();
    loadProjectOptions();
    updateCartBadge();

    const saved = getSavedLogin();
    if (saved && saved.idNumber) {
      state.lastId = saved;
      renderIdentity();
      updateHomeCardStates();
      showView(window.location.hash === '#inventory' ? 'catalog' : 'home');
    } else {
      showView('login');
    }

    if (window.updateOrderSyncPill) window.updateOrderSyncPill();
    if (navigator.onLine && window.flushPendingOrders) window.flushPendingOrders();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
  });

  /* ---------------- Navigation ---------------- */

  function bindNav() {
    document.querySelectorAll('#bottom-nav .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
  }

  function bindMainNav() {
    document.querySelectorAll('#bottom-nav-main .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.view === 'history' && (btn.id === 'nav-slot-2' || btn.id === 'nav-slot-3')) {
          setHistoryTab(btn.id === 'nav-slot-2' ? 'personal' : 'project');
          return;
        }
        showView(btn.dataset.mainview);
      });
    });
  }

  // The pinned "Log out" at the bottom of the desktop sidebar — present in
  // both nav bars since either one can be the active sidebar at a time.
  function bindSidebarLogout() {
    document.querySelectorAll('.sidebar-logout-link').forEach(link => {
      link.addEventListener('click', performLogout);
    });
  }

  // Views that use the SUS/MEA identity header + the Home/Settings/Help
  // bottom nav instead of the standard app header + Catalog/Cart/Checkout nav.
  const MAIN_VIEWS = ['home', 'settings', 'help', 'history', 'dashboard', 'activity-log'];

  function showView(view) {
    if ((view === 'dashboard' || view === 'activity-log') && !canOpenDashboard(state.lastId)) {
      showToast('You don\'t have permission to open SUS Dashboard', true);
      return;
    }
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');

    const navBtn = document.querySelector('.nav-btn[data-view="' + view + '"]') ||
                   document.querySelector('.nav-btn[data-mainview="' + view + '"]');
    if (navBtn) navBtn.classList.add('active');

    const isMain = MAIN_VIEWS.includes(view);
    const isLogin = view === 'login';

    // The desktop sidebar is hidden on the login screen. Keep the wide-screen
    // content centered in the viewport until the sidebar is actually visible.
    document.body.classList.toggle('has-desktop-sidebar', !isLogin);

    // Login/Home/Settings/Help/History all use their own top brand block —
    // hide the shared app chrome so it isn't duplicated. Catalog/Cart/
    // Checkout share the standard header + bottom nav.
    document.getElementById('app-header').style.display = (isMain || isLogin) ? 'none' : 'flex';
    document.getElementById('bottom-nav').style.display = (isMain || isLogin) ? 'none' : 'flex';
    document.getElementById('bottom-nav-main').style.display = isMain ? 'flex' : 'none';
    document.getElementById('cart-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';
    document.getElementById('contact-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';

    // History repurposes the Settings/Help nav slots as Personal/Project —
    // relabel them here, and restore the defaults for every other view.
    applyMainNavForView(view);

    if (view === 'settings') {
      document.getElementById('settings-script-url').value = getTrackerScriptUrl();
      const trackerTokenInput = document.getElementById('settings-tracker-token');
      if (trackerTokenInput) trackerTokenInput.value = getTrackerToken();
      document.getElementById('settings-inventory-url').value = getInventoryScriptUrl();
      const tokenInput = document.getElementById('settings-inventory-token');
      if (tokenInput) tokenInput.value = getInventoryToken();
    }
    if (view === 'home') { updateHomeCardStates(); scheduleHistoryPrefetch(); }
    if (view === 'history') setHistoryTab('personal');
    if (view === 'cart') renderCart();
    if (view === 'checkout') renderCheckout();
    if (view === 'catalog') loadInventory();
    document.dispatchEvent(new CustomEvent('mea:viewchange', { detail: { view: view } }));
  }

  // ── History view's Personal/Project tabs ──
  // The History view reuses the Home/Settings/Help bottom nav's slots 2 & 3
  // (normally Settings/Help) as Personal/Project instead, per the design —
  // rather than a fourth, separate nav bar.
  const NAV_SLOT_DEFAULT = {
    2: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/cog.svg" alt=""></span>Settings',
    3: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/contact.svg" alt=""></span>Help'
  };
  const NAV_SLOT_HISTORY = {
    2: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/user.svg" alt=""></span>Personal',
    3: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/folder.svg" alt=""></span>Project'
  };

  function applyMainNavForView(view) {
    const slot2 = document.getElementById('nav-slot-2');
    const slot3 = document.getElementById('nav-slot-3');
    if (!slot2 || !slot3) return;
    const map = view === 'history' ? NAV_SLOT_HISTORY : NAV_SLOT_DEFAULT;
    slot2.innerHTML = map[2];
    slot3.innerHTML = map[3];
  }

  function setHistoryTab(tab) {
    state.historyTab = tab;

    const slot2 = document.getElementById('nav-slot-2');
    const slot3 = document.getElementById('nav-slot-3');
    const homeSlot = document.querySelector('#bottom-nav-main .nav-btn[data-mainview="home"]');
    [homeSlot, slot2, slot3].forEach(b => b && b.classList.remove('active'));
    if (tab === 'project') {
      slot3.classList.add('active');
    } else {
      slot2.classList.add('active');
    }

    const projectSelect = document.getElementById('history-project-select');
    if (projectSelect) projectSelect.style.display = tab === 'project' ? '' : 'none';

    renderHistory();
  }

  // ── History data: fetched from the Inventory Apps Script (action=history),
  // cached locally so History still shows the last-known data offline,
  // exactly like the Catalog's inventory cache.
  function historyProjectKey(v) { return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  // The fingerprint partitions local snapshots; server authorization is still required.
  // Raw access codes and Google tokens never appear in cache keys or snapshots.
  function readSource() { return JSON.stringify([getInventoryScriptUrl(), getInventoryToken()]); }
  function readSourceScope() {
    let a = 2166136261, b = 5381;
    for (const char of readSource()) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  let readRevisionFallback = '';
  function readDataRevision() { try { return readRevisionFallback || localStorage.getItem('mea_read_revision') || ''; } catch (_) { return readRevisionFallback; } }
  let readGeneration = 0;
  function readSnapshot(key, field) {
    try {
      const data = JSON.parse(localStorage.getItem(key));
      return data && data.revision === readDataRevision() && Number.isFinite(data.syncedAt) &&
        Array.isArray(data[field]) && data[field].every(row => row && typeof row === 'object' &&
          (field !== 'items' || typeof row.id === 'string' && typeof row.title === 'string')) ? data : null;
    } catch (_) { return null; }
  }
  function writeSnapshot(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  function invalidateReadData() {
    readGeneration++;
    readRevisionFallback = crypto.randomUUID();
    try { localStorage.setItem('mea_read_revision', readRevisionFallback); readRevisionFallback = ''; } catch (_) {}
    if (inventoryRead) inventoryRead = {...inventoryRead, revision: readDataRevision(), syncedAt: 0, promise: null};
    historyFresh.clear();
    historyFlights.clear();
    historyLoadToken++;
  }
  let historyAccountGeneration = 0;
  const historyFlights = new Map(), historyFresh = new Map();
  function resetHistorySession() {
    historyAccountGeneration++;
    historyLoadToken++;
    historyFlights.clear(); historyFresh.clear();
  }
  function historyContext(tab = state.historyTab, project = document.getElementById('history-project-select')?.value || '') {
    const owner = (state.lastId?.googleUid ? 'google:' + state.lastId.googleUid : 'id:' + (state.lastId?.idNumber || 'anonymous')) + (state.lastId?.verified ? ':verified' : ':id-only');
    return {tab, project: tab === 'project' ? project : '', owner, source: readSource(), revision: readDataRevision(),
      generation: readGeneration, epoch: historyAccountGeneration,
      key: 'mea_history_cache_v4:' + owner + ':' + tab + ':' + (tab === 'project' ? historyProjectKey(project) : '') + ':' + readSourceScope()};
  }
  function historyCacheKey() { return historyContext().key; }
  function historyContextValid(context) {
    return context.epoch === historyAccountGeneration && context.generation === readGeneration &&
      context.source === readSource() && context.revision === readDataRevision();
  }

  function getCachedHistory(context = historyContext()) {
    if (!state.lastId || window.meaHistoryReady?.() === false) return null;
    const memory = historyFresh.get(context.key);
    return memory?.revision === context.revision ? memory : readSnapshot(context.key, 'records');
  }

  function setCachedHistory(records, context, response) {
    const snapshot = {records, projects: response.projects, admin: response.admin, syncedAt: Date.now(), revision: context.revision};
    writeSnapshot(context.key, snapshot);
    historyFresh.set(context.key, snapshot);
    return snapshot;
  }

  function fetchHistoryRecords(options = {}, context = historyContext()) {
    const url = getInventoryScriptUrl();
    if (!url || !state.lastId || window.meaHistoryReady?.() === false) return Promise.resolve({records: [], error: !url ? 'No Inventory Script URL configured yet.' : 'Reconnect your school account to refresh your history.'});
    const memory = historyFresh.get(context.key);
    const cache = memory?.revision === context.revision ? memory : getCachedHistory(context);
    if (!navigator.onLine) return Promise.resolve({...cache, records: cache?.records || [], offline: true});
    const flightKey = JSON.stringify([context.key, context.epoch, context.revision, context.generation]);
    if (historyFlights.has(flightKey)) return historyFlights.get(flightKey);
    if (!options.force && cache && historyFresh.has(context.key) && Date.now() - cache.syncedAt < 15000) return Promise.resolve({...cache, offline: false});
    const promise = Promise.resolve().then(async () => {
      try {
        if (!historyContextValid(context)) return {records: [], discarded: true};
        const json = await window.meaHistoryRequest(context.tab, context.project);
        if (!historyContextValid(context)) return {records: [], discarded: true};
        if (!json?.ok || !Array.isArray(json.records) || !json.records.every(row => row && typeof row === 'object')) throw new Error(json?.error || 'Unexpected response');
        return {...setCachedHistory(json.records, context, json), offline: false};
      } catch (err) {
        if (!historyContextValid(context)) return {records: [], discarded: true};
        historyFresh.delete(context.key);
        const offline = !err.code && (err instanceof TypeError || err.name === 'TypeError' || !navigator.onLine);
        if (!offline) { try { localStorage.removeItem(context.key); } catch (_) {} }
        return {...(offline ? cache : {}), records: offline ? cache?.records || [] : [], offline, error: err.message};
      } finally { if (historyFlights.get(flightKey) === promise) historyFlights.delete(flightKey); }
    });
    historyFlights.set(flightKey, promise);
    return promise;
  }

  async function prefetchHistory(options = {}) {
    if (!state.lastId || !navigator.onLine || window.meaHistoryReady?.() === false) return Promise.resolve();
    const context = historyContext('personal', '');
    const result = await fetchHistoryRecords(options, context);
    const selected = document.getElementById('history-project-select')?.value;
    if (historyContextValid(context) && selected && Array.isArray(result.projects) &&
        result.projects.some(project => historyProjectKey(project) === historyProjectKey(selected))) {
      await fetchHistoryRecords({}, historyContext('project', selected));
    }
    return result;
  }
  function scheduleHistoryPrefetch() {
    const epoch = historyAccountGeneration;
    setTimeout(() => { if (epoch === historyAccountGeneration && state.view === 'home') prefetchHistory(); }, 150);
  }
  function applyHistoryProjects(data) {
    if (!Array.isArray(data.projects)) return;
    const select = document.getElementById('history-project-select'), chosen = select.value, seen = new Set();
    const labels = data.projects.filter(label => { const key = historyProjectKey(label); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    if (data.admin) labels.unshift('__ALL__');
    select.innerHTML = '<option value="">Project/Dept</option>' + labels.map(label => `<option value="${escapeHtml(label)}">${label === '__ALL__' ? 'All records (Admin)' : escapeHtml(label)}</option>`).join('');
    select.value = labels.find(label => historyProjectKey(label) === historyProjectKey(chosen)) || '';
  }

  function historyRowHtml(rec) {
    const when = rec.time ? new Date(rec.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const caseLabel = rec.deleted ? 'Deleted (restorable)' : rec.caseType === 'CONSUMING' ? 'Consumed' : (rec.resolved ? 'Returned' : (Number(rec.returnedQty) > 0 ? 'Partially returned' : 'Borrowed'));
    const canReturn = !rec.deleted && rec.caseType === 'BORROWING' && !rec.resolved && rec.recordId && rec.returnable !== false && (rec.canReturn === true || rec.canReturn === undefined && String(rec.idNum) === String(state.lastId?.idNumber));
    return `
      <div class="history-item">
        <div class="history-item-main">
          <div class="history-item-title">${escapeHtml(rec.item)}${rec.qty ? ' × ' + escapeHtml(rec.qty) : ''}</div>
          <div class="history-item-meta">${escapeHtml(rec.reference || '')}${rec.accountKind === 'GUEST' ? ' · Guest' : ''} · ${escapeHtml(rec.project || '—')}${rec.committee ? ' · ' + escapeHtml(rec.committee) : ''}${state.historyTab === 'project' && rec.name ? ' · ' + escapeHtml(rec.name) : ''}</div>
        </div>
        <div class="history-item-side">
          <div class="history-item-case ${rec.resolved ? 'resolved' : 'pending'}">${caseLabel}</div>
          <div class="history-item-date">${when}</div>
          ${rec.caseType === 'BORROWING' ? `<div>${MeaCart.outstanding(rec)} remaining</div>` : ''}
          ${rec.canEdit && !rec.deleted ? `<button type="button" class="btn-secondary" data-record-action="edit" data-record-id="${escapeHtml(rec.recordId)}">Edit record</button>` : ''}
          ${rec.canDelete ? `<button type="button" class="btn-secondary" data-record-action="${rec.deleted?'restore':'delete'}" data-record-id="${escapeHtml(rec.recordId)}">${rec.deleted?'Restore':'Delete'}</button>` : ''}
          ${canReturn ? `<button type="button" class="btn-secondary history-return" data-return-id="${escapeHtml(rec.recordId)}">Return items</button>` : ''}
        </div>
      </div>`;
  }

  let historyLoadToken = 0;
  async function renderHistory(options = {}) {
    const pendingList = document.getElementById('history-pending-list');
    const totalList = document.getElementById('history-total-list');
    if (!pendingList || !totalList) return;

    document.getElementById('history-deleted-toggle')?.setAttribute('aria-pressed',String(!!state.historyShowDeleted));
    const myToken = ++historyLoadToken; // avoids a slow older fetch overwriting a newer render
    const context = historyContext(), cache = getCachedHistory(context);
    if (cache) paintHistory({...cache, saved: true, offline: !navigator.onLine});
    else {
      const skeletonRow = '<div class="history-item skeleton-row skeleton" style="height:52px;"></div>';
      pendingList.innerHTML = skeletonRow.repeat(2);
      totalList.innerHTML = skeletonRow.repeat(3);
      window.meaHistoryRecords = [];
    }
    const data = await fetchHistoryRecords(options, context);
    if (myToken !== historyLoadToken || !historyContextValid(context) || context.key !== historyCacheKey() || data.discarded) return;
    paintHistory(data);
  }

  function paintHistory({records, projects, admin, offline, error, syncedAt, saved}) {
    const pendingList = document.getElementById('history-pending-list');
    const totalList = document.getElementById('history-total-list');
    applyHistoryProjects({projects, admin});

    if (error && !offline) {
      window.meaHistoryRecords = [];
      pendingList.innerHTML = `<div class="history-empty" role="alert">${escapeHtml(error)}</div>`;
      totalList.innerHTML = ''; return;
    }
    let scoped = records;
    if (state.historyTab === 'personal') {
      const myId = state.lastId && state.lastId.idNumber ? String(state.lastId.idNumber).trim() : '';
      scoped = records.filter(r => String(r.idNum).trim() === myId);
    } else {
      const projectSelect = document.getElementById('history-project-select');
      const chosen = projectSelect ? projectSelect.value : '';
      if (!chosen) {
        pendingList.innerHTML = '<div class="history-empty">Select a Project/Dept above</div>';
        totalList.innerHTML = '<div class="history-empty">Select a Project/Dept above</div>';
        return;
      }
      scoped = chosen==='__ALL__'?records:records.filter(r => historyProjectKey(r.project) === historyProjectKey(chosen));
    }

    window.meaHistoryRecords = records;
    scoped=scoped.filter(r=>!!r.deleted===!!state.historyShowDeleted);
    const pending = scoped.filter(r => r.caseType === 'BORROWING' && !r.resolved);
    const total = scoped.filter(r => r.caseType !== 'BORROWING' || r.resolved);

    const offlineNote = offline
      ? `<div class="history-offline-note"><img class="svg-icon icon-inline" src="icons/ui/wifi.svg" alt="">${error ? 'Could not refresh' : "You're offline"} — showing ${syncedAt ? 'last synced (' + new Date(syncedAt).toLocaleString() + ')' : 'no saved'} data.</div>`
      : saved ? `<div class="history-offline-note">Saved copy · ${new Date(syncedAt).toLocaleString()} · Updating…</div>` : '';

    pendingList.innerHTML = offlineNote + (pending.length
      ? pending.map(historyRowHtml).join('')
      : '<div class="history-empty">No pending requests yet</div>');

    totalList.innerHTML = total.length
      ? total.map(historyRowHtml).join('')
      : '<div class="history-empty">Nothing logged yet</div>';
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

  const INVENTORY_TOKEN_KEY = 'mea_inventory_token';

  function getInventoryToken() {
    try { return (localStorage.getItem(INVENTORY_TOKEN_KEY) || '').trim(); } catch(e) { return ''; }
  }

  function saveInventoryToken(token) {
    try { localStorage.setItem(INVENTORY_TOKEN_KEY, token || ''); } catch(e) {}
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

  /* ---------------- Login ---------------- */

  function bindLogin() {
    const input = document.getElementById('login-id-input');
    const btn = document.getElementById('login-enter-btn');
    const err = document.getElementById('login-error');

    async function attemptLogin() {
      const idValue = input.value.trim();
      err.textContent = '';

      if (!idValue) {
        err.textContent = 'Enter your ID number.';
        return;
      }
      if (!/^\d{6}$/.test(idValue)) {
        err.textContent = 'Enter a valid 6-digit ID number.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'CHECKING…';

      const result = await fetchIdLookup(idValue);

      btn.disabled = false;
      btn.textContent = 'ENTER';

      if (result.status === 'NOT_CONFIGURED') {
        err.textContent = 'ID Tracker isn\'t set up yet — contact an admin.';
        return;
      }
      if (result.status === 'NETWORK_ERROR') {
        err.textContent = 'Could not reach the server. Check your connection.';
        return;
      }
      if (result.status === 'ERROR') {
        err.textContent = 'Something went wrong. Please try again.';
        return;
      }
      if (!result.found) {
        err.textContent = 'ID number not recognized.';
        return;
      }

      state.lastId = result;
      saveLogin(result);
      window.meaSwitchAccount?.();
      renderIdentity();
      input.value = '';
      showView('home');
    }

    btn.addEventListener('click', attemptLogin);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptLogin();
    });
  }

  /* ---------------- Home (page 1 layout) ---------------- */

  function bindHome() {
    document.getElementById('home-nav-inventory').addEventListener('click', () => {
      showView('catalog');
    });

    document.getElementById('home-nav-history').addEventListener('click', () => {
      showView('history');
    });

    const historyProjectSelect = document.getElementById('history-project-select');
    if (historyProjectSelect) {
      historyProjectSelect.addEventListener('change', () => renderHistory());
    }

    document.getElementById('home-nav-idtracker').addEventListener('click', () => {
      if (!getTrackerScriptUrl()) {
        showToast('ID Tracker isn\'t set up yet — contact an admin', true);
        return;
      }
      if (!canOpenTracker(state.lastId)) {
        showToast('You don\'t have permission to open ID Tracker', true);
        return;
      }
      // The tracker stays in its original, self-contained document so its
      // NFC, settings, saved IDs, and Google Sheets behavior are untouched.
      window.location.href = 'id-tracker.html?id=' + encodeURIComponent(state.lastId.idNumber);
    });

    document.getElementById('home-nav-dashboard').addEventListener('click', () => {
      if (!canOpenDashboard(state.lastId)) {
        showToast('You don\'t have permission to open SUS Dashboard', true);
        return;
      }
      showView('dashboard');
    });

    const logoBtn = document.getElementById('logo-home-btn');
    if (logoBtn) logoBtn.addEventListener('click', () => showView('home'));
  }

  /* ---------------- Settings ---------------- */

  function bindSettings() {
    document.getElementById('settings-install-btn').addEventListener('click', () => triggerInstall());

    document.getElementById('settings-save-btn').addEventListener('click', () => {
      const trackerUrl = document.getElementById('settings-script-url').value.trim();
      const trackerToken = document.getElementById('settings-tracker-token').value.trim();
      const inventoryUrl = document.getElementById('settings-inventory-url').value.trim();
      const inventoryToken = document.getElementById('settings-inventory-token').value.trim();
      const status = document.getElementById('settingsStatus');

      if (!trackerUrl && !inventoryUrl) {
        status.textContent = 'Enter at least one Apps Script URL.';
        status.className = 'setup-status error';
        return;
      }
      if (trackerUrl) saveTrackerScriptUrl(trackerUrl);
      saveTrackerToken(trackerToken);
      if (inventoryUrl) saveInventoryScriptUrl(inventoryUrl);
      saveInventoryToken(inventoryToken);

      status.textContent = 'Saved!';
      status.className = 'setup-status ok';
      updateHomeCardStates();
      resetHistorySession();
      loadInventory({force: true});
    });

    document.getElementById('logout-link').addEventListener('click', performLogout);
  }

  /**
   * Logs the current person out from anywhere in the app — the Settings
   * page link (mobile) or either sidebar's pinned "Log out" (desktop).
   */
  function performLogout() {
    window.meaBeforeLogout?.();
    historyLoadToken++;
    clearLogin();
    state.lastId = null;
    state.cart = {};
    window.meaSwitchAccount?.();
    hideInstallBanner();
    const loginInput = document.getElementById('login-id-input');
    const loginErr = document.getElementById('login-error');
    if (loginInput) loginInput.value = '';
    if (loginErr) loginErr.textContent = '';
    showView('login');
  }

  /* ---------------- Inventory / catalog ---------------- */

  function renderCatalogSkeleton() {
    const container = document.getElementById('catalog-container');
    if (!container || state.inventory.length) return; // only show on a genuinely empty first load
    const grid = state.catalogFormat === 'grid';
    container.className = grid ? 'item-grid' : 'item-list';
    const card = grid
      ? '<div class="item-card skeleton-card skeleton"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line w60"></div></div>'
      : '<div class="item-row skeleton-row skeleton"><div class="skeleton-thumb"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line w40"></div></div></div>';
    container.innerHTML = card.repeat(grid ? 9 : 5);
  }

  let inventoryRead = null;
  function setInventorySync(text, busy = false) {
    const note = document.getElementById('catalog-sync');
    if (note) note.textContent = text;
    const button = document.getElementById('catalog-refresh');
    if (button) { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); }
  }
  function paintInventory(items) {
    state.inventory = items;
    renderCategoryChips(); renderCatalog();
  }
  function loadInventory(options = {}) {
    const source = readSource(), revision = readDataRevision(), generation = readGeneration;
    if (!inventoryRead || inventoryRead.source !== source || inventoryRead.revision !== revision) {
      const key = 'mea_inventory_cache_v2:' + readSourceScope();
      const cache = readSnapshot(key, 'items');
      inventoryRead = {source, revision, key, cache, syncedAt: 0, promise: null};
      window.__meaInventoryDebugError = null;
      if (cache) paintInventory(cache.items);
      else { state.inventory = []; renderCategoryChips(); renderCatalogSkeleton(); }
    }
    const entry = inventoryRead;
    if (entry.cache) paintInventory(entry.cache.items);
    if (entry.promise) return entry.promise;
    if (!options.force && entry.syncedAt && Date.now() - entry.syncedAt < 30000) return Promise.resolve(entry.cache?.items);
    setInventorySync(entry.cache ? 'Saved copy · Updating…' : 'Loading inventory…', true);
    const current = () => inventoryRead === entry && source === readSource() && revision === readDataRevision() && generation === readGeneration;
    entry.promise = new Promise((resolve, reject) => {
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).getInventory();
    }).then(items => {
      if (!current()) return;
      if (!Array.isArray(items) || !items.every(item => item && typeof item.id === 'string' && typeof item.title === 'string')) throw new Error('The inventory response was invalid.');
      entry.syncedAt = Date.now();
      entry.cache = {items, syncedAt: entry.syncedAt, revision};
      writeSnapshot(entry.key, entry.cache);
      window.__meaInventoryDebugError = null;
      paintInventory(items); window.meaReconcileCart?.();
      setInventorySync('Updated ' + new Date(entry.syncedAt).toLocaleTimeString());
      return items;
    }).catch(error => {
      if (!current()) return;
      entry.syncedAt = 0;
      window.__meaInventoryDebugError = error.message || 'Could not refresh inventory.';
      if (entry.cache) paintInventory(entry.cache.items);
      else { state.inventory = []; renderCatalog(); }
      setInventorySync(entry.cache ? 'Showing saved copy · ' + new Date(entry.cache.syncedAt).toLocaleString() : 'Could not load inventory · Try Refresh');
    }).finally(() => { if (current()) { entry.promise = null; const button = document.getElementById('catalog-refresh'); if (button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); } } });
    return entry.promise;
  }

  function refreshActiveReadData() {
    if (document.hidden || !navigator.onLine) return;
    if (state.view === 'catalog' || state.view === 'cart') loadInventory();
    if (state.view === 'history') renderHistory();
  }
  function refreshAfterMutation() {
    invalidateReadData();
    refreshActiveReadData();
  }
  window.addEventListener('online', refreshActiveReadData);
  document.addEventListener('visibilitychange', refreshActiveReadData);

  // Category chips let people jump straight to a section of the catalog
  // instead of scrolling or guessing a search term — built from whatever
  // categories actually exist in the sheet right now, so it never goes
  // stale relative to the data.
  function renderCategoryChips() {
    const row = document.getElementById('category-chip-row');
    if (!row) return;
    const categories = Array.from(new Set(
      state.inventory.map(i => (i.category || '').trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    if (!categories.length) { row.innerHTML = ''; return; }
    if (!categories.includes(state.catalogCategory)) state.catalogCategory = 'all';

    const chip = (value, label) => `<button type="button" class="category-chip${state.catalogCategory === value ? ' active' : ''}" data-category="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
    row.innerHTML = chip('all', 'All') + categories.map(c => chip(c, c)).join('');

    row.querySelectorAll('.category-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.catalogCategory = btn.dataset.category;
        row.querySelectorAll('.category-chip').forEach(b => b.classList.toggle('active', b === btn));
        renderCatalog();
      });
    });
  }

  function loadProjectOptions() {
    google.script.run
      .withSuccessHandler(options => {
        // Keep required client-side options available even when an older
        // Apps Script deployment returns its own, incomplete list.
        const liveOptions = Array.isArray(options) ? options : [];
        state.projectOptions = Array.from(new Set([...liveOptions, 'COMEALEC']));
        const select = document.getElementById('project-select');
        select.innerHTML = state.projectOptions
          .map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
          .join('');
        window.meaRestoreFields?.();

        const historySelect = document.getElementById('history-project-select');
        if (historySelect) {
          const placeholder = historySelect.querySelector('option[value=""]');
          historySelect.innerHTML = (placeholder ? placeholder.outerHTML : '<option value="">Project/Dept</option>') +
            state.projectOptions
              .filter(opt => opt !== 'Personal')
              .map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
              .join('');
        }
      })
      .withFailureHandler(() => {})
      .getProjectOptions();
  }

  function bindCatalogToggle() {
    document.getElementById('format-grid-btn').addEventListener('click', () => setCatalogFormat('grid'));
    document.getElementById('format-list-btn').addEventListener('click', () => setCatalogFormat('list'));

    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    searchInput.addEventListener('input', (e) => {
      state.catalogSearch = e.target.value;
      clearBtn.style.display = e.target.value ? 'flex' : 'none';
      renderCatalog();
    });
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.catalogSearch = '';
      clearBtn.style.display = 'none';
      renderCatalog();
      searchInput.focus();
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

    if (state.catalogCategory && state.catalogCategory !== 'all') {
      items = items.filter(item => (item.category || '').trim() === state.catalogCategory);
    }

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
      ? `<div class="inventory-refresh-error" role="status"><img class="svg-icon icon-inline" src="icons/ui/warning.svg" alt="">Could not refresh inventory. ${escapeHtml(debugMsg)}</div>`
      : '';

    const countEl = document.getElementById('catalog-result-count');

    if (!state.inventory.length) {
      if (window.meaRenderEmptyCatalogGame) {
        container.className = 'item-grid';
        container.innerHTML = debugHtml;
        window.meaRenderEmptyCatalogGame(container);
        if (countEl) countEl.textContent = 'No inventory loaded';
        return;
      }
      container.innerHTML = debugHtml + '<div class="empty-state"><img class="svg-icon" src="icons/ui/archive-box.svg" alt="">' + (debugMsg ? 'No saved inventory available. Connect and tap Refresh.' : 'Inventory is empty') + '</div>';
      if (countEl) countEl.textContent = 'Tap an item to borrow or consume';
      return;
    }

    const visible = getVisibleInventory();
    const filtered = !!state.catalogSearch.trim() || state.catalogCategory !== 'all';

    if (countEl) {
      countEl.textContent = filtered
        ? visible.length + (visible.length === 1 ? ' item found' : ' items found')
        : 'Tap an item to borrow or consume';
    }

    if (!visible.length) {
      container.className = state.catalogFormat === 'grid' ? 'item-grid' : 'item-list';
      container.innerHTML = debugHtml + `
        <div class="empty-state" style="grid-column:1/-1;">
          <img class="svg-icon" src="icons/ui/search.svg" alt="">
          No items match${state.catalogCategory !== 'all' ? ' "' + escapeHtml(state.catalogCategory) + '"' : ''}${state.catalogSearch.trim() ? ' "' + escapeHtml(state.catalogSearch.trim()) + '"' : ''}
          <button type="button" class="btn-secondary" style="margin-top:14px;max-width:200px;" onclick="clearCatalogFilters()">Clear filters</button>
        </div>`;
      return;
    }

    if (state.catalogFormat === 'grid') {
      container.className = 'item-grid';
      container.innerHTML = debugHtml + visible.map(item => `
        <div class="item-card" role="button" tabindex="0" onclick="openItemSheet('${escapeAttr(item.id)}')">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${escapeHtml(MeaCart.availability(item.qtyDisplay ?? item.qtyAvailable).text)}</div>
          <div class="item-location">${escapeHtml(item.location || 'Location unassigned')}</div>
          ${cartQty(item.id) ? `<span class="in-cart-badge">${cartQty(item.id)} in cart</span>` : ''}
        </div>
      `).join('');
    } else {
      container.className = 'item-list';
      container.innerHTML = debugHtml + visible.map(item => `
        <div class="item-row" role="button" tabindex="0" onclick="openItemSheet('${escapeAttr(item.id)}')">
          <div class="item-info">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-qty">${escapeHtml(MeaCart.availability(item.qtyDisplay ?? item.qtyAvailable).text)}</div>
            <div class="item-location">${escapeHtml(item.location || 'Location unassigned')}</div>
          </div>
          ${cartQty(item.id) > 0 ? `<div class="in-cart-badge">${cartQty(item.id)} in cart</div>` : ''}
        </div>
      `).join('');
    }
  }

  function clearCatalogFilters() {
    state.catalogSearch = '';
    state.catalogCategory = 'all';
    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    renderCategoryChips();
    renderCatalog();
  }

  /* ---------------- Contacts (shared by the Help view and the Contact modal) ----------------
     Single source of truth so editing the team roster only ever means
     touching one array instead of two identical hand-written HTML blocks. */
  const CONTACTS = [
    { name: 'David Yu',      role: 'SUS Senior Associate', messenger: 'https://fb.com/davidcurtisyu',        telegram: 'https://t.me/davidcurtisyu' },
    { name: 'Kendrick Jin',  role: 'SUS Senior Associate', messenger: 'https://www.fb.com/ken.jin/',          telegram: 'https://t.me/dkrypto' },
    { name: 'Riesha Chan',   role: 'SUS AVP',               messenger: 'https://www.facebook.com/rieeschann', telegram: 'https://t.me/rchchan' },
    { name: 'Hazel Burce',   role: 'VP SUS',                messenger: 'https://www.facebook.com/hazelburce25', telegram: 'https://t.me/hazelburce25' }
  ];

  function contactRowHtml(c) {
    return `
      <div class="contact-row">
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name)}</div>
          <div class="contact-role">${escapeHtml(c.role)}</div>
        </div>
        <div class="contact-btn-group">
          <button class="contact-icon-btn" title="Message ${escapeAttr(c.name)} on Messenger" aria-label="Message ${escapeAttr(c.name)} on Messenger" onclick="window.open('${c.messenger}', '_blank', 'noopener')"><img class="svg-icon" src="icons/ui/messenger.svg" alt=""></button>
          <button class="contact-icon-btn" title="Message ${escapeAttr(c.name)} on Telegram" aria-label="Message ${escapeAttr(c.name)} on Telegram" onclick="window.open('${c.telegram}', '_blank', 'noopener')"><img class="svg-icon" src="icons/ui/telegram.svg" alt=""></button>
        </div>
      </div>`;
  }

  function renderContacts() {
    const html = CONTACTS.map(contactRowHtml).join('');
    const help = document.getElementById('help-contact-list');
    const modal = document.getElementById('modal-contact-list');
    if (help) help.innerHTML = html;
    if (modal) modal.innerHTML = html;
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
    maybeShowInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    showToast('MEA App installed!');
    hideInstallBanner();
  });

  async function triggerInstall() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (choice.outcome === 'accepted') hideInstallBanner();
      return;
    }
    window.meaInstallHelp();
  }

  /* ---------------- Install banner ----------------
     Mobile-only prompt encouraging people to add the app to their home
     screen. Android/Chrome gets a real "Install" button wired to the
     captured beforeinstallprompt event; iOS Safari never fires that event
     at all, so it gets instructions instead (Add to Home Screen is a
     manual step there with no programmatic trigger). Dismissing snoozes
     the banner for 14 days rather than hiding it forever, since people
     often dismiss the first time they see anything new. */
  const INSTALL_DISMISS_KEY = 'mea_install_banner_dismissed_at';
  const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isMobileViewport() {
    return window.matchMedia('(max-width: 767px)').matches;
  }
  function wasInstallBannerRecentlyDismissed() {
    try {
      const at = parseInt(localStorage.getItem(INSTALL_DISMISS_KEY) || '0', 10);
      return at && (Date.now() - at) < INSTALL_SNOOZE_MS;
    } catch(e) { return false; }
  }

  function maybeShowInstallBanner() {
    if (!state.lastId || !isMobileViewport() || isStandalonePwa() || wasInstallBannerRecentlyDismissed()) return;
    const ios = isIOS();
    // Unsupported browsers still get manual installation help. // Android/Chrome with nothing to prompt yet
    const banner = document.getElementById('install-banner');
    if (!banner) return;

    document.getElementById('install-banner-btn').style.display = '';
    document.getElementById('install-banner-btn').textContent = ios || !deferredInstallPrompt ? 'Show steps' : 'Install';
    document.getElementById('install-banner-steps').style.display = ios ? 'flex' : 'none';
    document.getElementById('install-banner-sub').textContent = ios
      ? 'Add it to your home screen for quick, full-screen access.'
      : 'Add it to your home screen for a faster, full-screen experience.';
    banner.classList.add('show');
  }

  function hideInstallBanner() {
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('show');
  }

  function dismissInstallBanner() {
    try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch(e) {}
    hideInstallBanner();
  }

  function bindInstallBanner() {
    const btn = document.getElementById('install-banner-btn');
    const dismiss = document.getElementById('install-banner-dismiss');
    if (btn) btn.addEventListener('click', () => triggerInstall());
    if (dismiss) dismiss.addEventListener('click', dismissInstallBanner);

    // iOS never fires beforeinstallprompt, so it's the only case checked
    // eagerly on load; Android waits for that event (handled above).
    document.addEventListener('mea:viewchange', () => setTimeout(maybeShowInstallBanner, 1200));
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

  function getTrackerToken() {
    try {
      const raw = localStorage.getItem(TRACKER_CFG_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && parsed.token) ? String(parsed.token).trim() : '';
    } catch(e) { return ''; }
  }

  function saveTrackerToken(token) {
    let cfg = {};
    try {
      const raw = localStorage.getItem(TRACKER_CFG_KEY);
      if (raw) cfg = JSON.parse(raw) || {};
    } catch(e) {}
    cfg.token = token || '';
    localStorage.setItem(TRACKER_CFG_KEY, JSON.stringify(cfg));
  }
