  /* ==================================================================
     MEA ID Tracker — client logic
     ================================================================== */

  // GitHub Pages does not provide Apps Script's google.script.run object. This
  // small local adapter keeps the inventory usable there while preserving the
  // same call shape for Apps Script deployments.
  if (!window.google || !window.google.script || !window.google.script.run) {
    const demoInventory = [
      ['ITM-100', 'Safety Vest', 'Safety', 5],
      ['ITM-101', 'Hard Hat', 'Safety', 6],
      ['ITM-102', 'Wire Spool', 'Electrical', 7],
      ['ITM-103', 'Multimeter', 'Electrical', 8],
      ['ITM-104', 'Toolbox', 'Tools', 9],
      ['ITM-105', 'Extension Cord', 'Electrical', 10],
      ['ITM-106', 'Work Gloves', 'Safety', 11],
      ['ITM-107', 'Clipboard', 'General', 12],
      ['ITM-108', 'Flashlight', 'General', 13]
    ].map(([id, title, category, qtyAvailable]) => ({ id, title, category, qtyAvailable }));

    const localMethods = {
      getInventory: () => demoInventory,
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
    projectOptions: []
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
    document.getElementById('bottom-nav').style.display = 'flex';
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

  function bindHome() {
    document.getElementById('home-nav-inventory').addEventListener('click', () => {
      captureHomeId();
      showView('catalog');
    });
    document.getElementById('home-nav-idtracker').addEventListener('click', () => {
      // The tracker stays in its original, self-contained document so its
      // NFC, settings, saved IDs, and Google Sheets behavior are untouched.
      const idValue = document.getElementById('home-id-input').value.trim();
      captureHomeId();
      window.location.href = idValue
        ? 'id-tracker.html?id=' + encodeURIComponent(idValue)
        : 'id-tracker.html';
    });
    document.getElementById('home-menu-btn').addEventListener('click', () => toggleModal(true));

    const logoBtn = document.getElementById('logo-home-btn');
    if (logoBtn) logoBtn.addEventListener('click', () => showView('home'));
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
    if (!state.inventory.length) {
      container.innerHTML = '<div class="empty-state"><span class="emoji">📦</span>Inventory is empty</div>';
      return;
    }

    if (state.catalogFormat === 'grid') {
      container.className = 'item-grid';
      container.innerHTML = state.inventory.map(item => `
        <div class="item-card" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-thumb">📦</div>
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${item.qtyAvailable} in stock</div>
        </div>
      `).join('');
    } else {
      container.className = 'item-list';
      container.innerHTML = state.inventory.map(item => `
        <div class="item-row" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-thumb">📦</div>
          <div class="item-info">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-qty">${item.qtyAvailable} in stock</div>
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
      container.innerHTML = '<div class="empty-state"><span class="emoji">🛒</span>Your cart is empty</div>';
      checkoutBtn.disabled = true;
      return;
    }
    checkoutBtn.disabled = false;

    container.innerHTML = entries.map(({ item, qty }) => `
      <div class="item-row">
        <div class="item-thumb">📦</div>
        <div class="item-info">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${item.qtyAvailable} in stock</div>
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
  }

  function submitOrder() {
    const entries = Object.values(state.cart);
    if (!state.lastId || !state.lastId.idNumber) {
      showToast('Scan or enter an ID number first', true);
      showView('scan');
      return;
    }
    if (!entries.length) {
      showToast('Your cart is empty', true);
      return;
    }

    const payload = {
      idNumber: state.lastId.idNumber,
      project: document.getElementById('project-select').value,
      committee: document.getElementById('committee-input').value,
      items: entries.map(({ item, qty }) => ({ id: item.id, title: item.title, qty: qty }))
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
