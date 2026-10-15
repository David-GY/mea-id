/* SUSCart interactions. Shared state/navigation live in inventory.js. */
let draftOwner = null;
let draftRevision = 0;
let draftDirty = false;
let draftTimer;
let cloudBusy = false;
let cloudConflict = false;
let accountEpoch = 0;
let firebaseAuth = null;
let verifiedMember = null;
let submitBusy = false;
let returnBusy = false;
let cloudLoaded = false;
let dialogTrigger;
let activeItemId = null;
let undoRemoval = null;
const ACTION_LABEL = {BORROWING: 'Borrow', CONSUMING: 'Consume'};
const uuid = () => crypto.randomUUID();
const esc = escapeHtml;
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (_) { showToast('Device storage is full or unavailable. Keep this page open to avoid losing changes.', true); return false; }
}
function draftKey() { return 'mea_cart_v3:' + draftOwner; }
function draftSnapshot() {
  return {cart: state.cart, project: document.getElementById('project-select').value, committee: document.getElementById('committee-input').value};
}
function saveStatus(text) { document.getElementById('cart-save-status').textContent = text; }
function invalidateAction(action) { Object.values(state.cart).filter(l => !action || l.action === action).forEach(l => delete l.clientId); }
function saveCart() {
  if (!draftOwner) return;
  draftDirty = true;
  const saved = writeLocal(draftKey(), {...draftSnapshot(), dirty: true});
  saveStatus(saved ? (verifiedMember ? 'Saved on this device · waiting to sync' : 'Saved on this device · connect Google to sync across devices') : 'Not saved · device storage unavailable');
  clearTimeout(draftTimer);
  if (verifiedMember && !cloudConflict) draftTimer = setTimeout(syncCloudDraft, 700);
}
window.meaRestoreFields = function() {
  if (!draftOwner) return;
  const saved = readLocal(draftKey(), {});
  const select = document.getElementById('project-select');
  if (saved.project && [...select.options].some(o => o.value === saved.project)) select.value = saved.project;
  document.getElementById('committee-input').value = saved.committee || '';
};
window.meaSwitchAccount = function() {
  clearTimeout(draftTimer);
  accountEpoch++;
  draftOwner = state.lastId?.idNumber || null;
  verifiedMember = null;
  cloudLoaded = false;
  document.getElementById('google-account-status').textContent = '';
  document.getElementById('return-queue')?.replaceChildren();
  historyLoadToken++;
  cloudConflict = false;
  draftRevision = 0;
  undoRemoval = null;
  const saved = draftOwner ? readLocal(draftKey(), {}) : {};
  state.cart = MeaCart.normalize(saved.cart);
  draftDirty = !!saved.dirty;
  document.getElementById('project-select').selectedIndex = 0;
  document.getElementById('committee-input').value = '';
  document.getElementById('history-pending-list').replaceChildren();
  document.getElementById('history-total-list').replaceChildren();
  document.getElementById('cart-feedback').replaceChildren();
  window.meaHistoryRecords = [];
  window.meaRestoreFields();
  saveStatus('Saved on this device · connect Google to sync across devices');
  updateCartBadge();
  if (document.getElementById('workflow-dialog').open) closeWorkflow();
};
window.meaBeforeLogout = function() {
  if (draftOwner) writeLocal(draftKey(), {...draftSnapshot(), dirty: draftDirty});
  if (firebaseAuth) firebaseAuth.signOut().catch(() => {});
};
window.meaReconcileCart = function() {
  if (!draftOwner) return;
  state.cart = MeaCart.reconcile(state.cart, state.inventory);
  if (state.view === 'cart') renderCart();
};
function cartQty(itemId) { return Object.values(state.cart).filter(l => l.item.id === itemId).reduce((n, l) => n + l.qty, 0); }
function updateCartBadge() {
  const count = Object.values(state.cart).reduce((n, l) => n + l.qty, 0);
  const badge = document.getElementById('cart-badge');
  badge.textContent = count;
  badge.style.display = count ? 'flex' : 'none';
  const shortcut = document.getElementById('cart-shortcut');
  shortcut.hidden = !draftOwner || !count || !['catalog', 'home'].includes(state.view);
  shortcut.textContent = `View cart · ${count} ${count === 1 ? 'unit' : 'units'}`;
}
function openWorkflow(html) {
  const dialog = document.getElementById('workflow-dialog');
  if (!dialog.open) dialogTrigger = document.activeElement;
  document.getElementById('workflow-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('workflow-open');
  const focus = dialog.querySelector('[autofocus], input, button:not(.sheet-close)');
  (focus || dialog.querySelector('.sheet-close')).focus();
}
function closeWorkflow() {
  document.getElementById('workflow-dialog').close();
  document.body.classList.remove('workflow-open');
  if (dialogTrigger?.isConnected) dialogTrigger.focus();
  else document.querySelector('#catalog-container [role=button]')?.focus();
}
function quantityControls(qty) {
  return `<div class="qty-stepper"><button type="button" id="sheet-minus" class="qty-btn" aria-label="Decrease quantity">−</button><input id="sheet-quantity" type="number" min="1" max="9999" step="1" inputmode="numeric" value="${qty}" aria-label="Quantity"><button type="button" id="sheet-plus" class="qty-btn" aria-label="Increase quantity">+</button></div>`;
}
function bindQuantity() {
  const input = document.getElementById('sheet-quantity');
  for (const [id, delta] of [['sheet-minus', -1], ['sheet-plus', 1]]) document.getElementById(id).onclick = () => { input.value = Math.min(Number(input.max), Math.max(1, (Number(input.value) || 1) + delta)); input.dispatchEvent(new Event('input')); };
}
function openItemSheet(itemId, selectedAction) {
  if (!draftOwner) { showView('login'); return; }
  const item = state.inventory.find(i => i.id === itemId);
  if (!item) return showToast('This item is no longer in the catalog.', true);
  if (submitBusy) return showToast('Wait for this submission to finish.', true);
  activeItemId = itemId;
  const lines = Object.values(state.cart).filter(l => l.item.id === itemId);
  let action = selectedAction || (lines.length === 1 ? lines[0].action : '');
  const line = action ? state.cart[MeaCart.key(itemId, action)] : null;
  openWorkflow(`<h2 id="workflow-title">${esc(item.title)}</h2>
    <p class="sheet-availability">${esc(MeaCart.availability(item.qtyDisplay ?? item.qtyAvailable).text)}</p>
    <dl class="sheet-facts"><div><dt>Location</dt><dd>${esc(item.location || 'Location unassigned')}</dd></div></dl>
    ${item.notes ? `<div class="sheet-notes">${esc(item.notes)}</div>` : ''}
    <fieldset><legend>What are you doing?</legend><div class="workflow-actions">${MeaCart.actions.map(a => `<label><input type="radio" name="item-action" value="${a}" ${a === action ? 'checked' : ''}> ${ACTION_LABEL[a]}</label>`).join('')}</div></fieldset>
    <div class="sheet-quantity-row"><label for="sheet-quantity">Quantity</label>${quantityControls(line?.qty || 1)}</div>
    <p id="sheet-warning" role="status"></p><p id="sheet-error" role="alert"></p>
    <button type="button" class="btn-primary" id="sheet-save">${line ? 'Update cart' : 'Add to cart'}</button>`);
  bindQuantity();
  const input = document.getElementById('sheet-quantity');
  const warning = () => { document.getElementById('sheet-warning').textContent = item.qtyAvailable != null && Number(input.value) > item.qtyAvailable ? 'This exceeds the last reported quantity. Confirm availability with SUS.' : ''; };
  input.oninput = warning;
  document.querySelectorAll('[name="item-action"]').forEach(radio => radio.onchange = () => {
    action = radio.value;
    const existing = state.cart[MeaCart.key(itemId, action)];
    input.value = existing?.qty || 1;
    document.getElementById('sheet-save').textContent = existing ? 'Update cart' : 'Add to cart';
    warning();
  });
  document.getElementById('sheet-save').onclick = () => {
    try {
      const qty = MeaCart.quantity(input.value);
      const key = MeaCart.key(itemId, action);
      invalidateAction(action);
      state.cart[key] = {item, qty, action};
      saveCart(); closeWorkflow(); updateCartBadge(); renderCatalog();
      showToast(`${item.title} × ${qty} · ${ACTION_LABEL[action]}`);
    } catch (e) { document.getElementById('sheet-error').textContent = e.message; }
  };
}
function changeCartAction(key, action, combine = false) {
  const line = state.cart[key];
  if (submitBusy || !line || line.unavailable || action === line.action) return;
  const targetKey = MeaCart.key(line.item.id, action);
  const target = state.cart[targetKey];
  if (target && !combine) {
    const epoch = accountEpoch;
    openWorkflow(`<h2 id="workflow-title">Combine cart entries?</h2><p>${esc(line.item.title)} already has ${target.qty} under ${ACTION_LABEL[action]}. Move these ${line.qty} too, for a total of ${target.qty + line.qty}?</p><button type="button" class="btn-primary" id="combine-cart">Combine as ${ACTION_LABEL[action]}</button><button type="button" class="btn-secondary" id="cancel-combine">Keep separate</button>`);
    document.getElementById('combine-cart').onclick = () => { closeWorkflow(); if (epoch === accountEpoch) changeCartAction(key, action, true); };
    document.getElementById('cancel-combine').onclick = closeWorkflow;
    return;
  }
  let qty;
  try { qty = MeaCart.quantity(line.qty + (target?.qty || 0)); }
  catch (error) { showToast(error.message, true); return; }
  invalidateAction(line.action); invalidateAction(action);
  delete state.cart[key];
  state.cart[targetKey] = {...line, qty, action, changed: line.changed || target?.changed};
  delete state.cart[targetKey].clientId;
  saveCart(); updateCartBadge(); renderCart();
  document.querySelector(`[data-cart-index="${Object.keys(state.cart).indexOf(targetKey)}"] [data-cart-action="${action}"]`)?.focus();
  showToast(`${line.item.title}: ${ACTION_LABEL[action]} · ${qty}`);
}
function renderCart() {
  const entries = Object.entries(state.cart);
  const container = document.getElementById('cart-list');
  document.getElementById('cart-checkout-btn').disabled = !entries.length;
  container.innerHTML = entries.length ? entries.map(([key, l], index) => `<article class="cart-entry" data-cart-index="${index}">
    <div class="cart-entry-main"><h3>${esc(l.item.title)}</h3><p>${l.qty} ${l.qty === 1 ? 'unit' : 'units'} · ${esc(l.item.location || 'Location unassigned')}</p>
    <div class="cart-action-toggle" role="group" aria-label="Action for ${esc(l.item.title)}">${MeaCart.actions.map(action => `<button type="button" data-cart-action="${action}" aria-pressed="${action === l.action}" ${l.unavailable || submitBusy ? 'disabled' : ''}>${ACTION_LABEL[action]}</button>`).join('')}</div>
    ${l.unavailable ? '<p class="workflow-error">No longer in the catalog. Remove this entry to continue.</p>' : ''}
    ${l.changed ? '<p class="workflow-warning">Quantity changed since you selected this item. Review before submitting.</p>' : ''}</div>
    <div class="cart-entry-actions"><button type="button" class="btn-secondary" data-edit ${l.unavailable ? 'disabled' : ''}>Edit</button><button type="button" class="btn-secondary" data-remove>Remove</button></div></article>`).join('') : '<div class="empty-state"><img class="svg-icon" src="icons/ui/shopping-basket.svg" alt=""><strong>Your cart is empty</strong><p>Choose items to borrow or consume.</p></div>';
  container.querySelectorAll('[data-cart-index]').forEach(row => {
    const [key, line] = entries[Number(row.dataset.cartIndex)];
    row.querySelectorAll('[data-cart-action]').forEach(button => { button.onclick = () => changeCartAction(key, button.dataset.cartAction); });
    row.querySelector('[data-edit]').onclick = () => openItemSheet(line.item.id, line.action);
    row.querySelector('[data-remove]').onclick = () => {
      if (submitBusy) return;
      invalidateAction(line.action);
      undoRemoval = {owner: draftOwner, key, line};
      delete state.cart[key]; saveCart(); updateCartBadge(); renderCart();
      const feedback = document.getElementById('cart-feedback');
      feedback.innerHTML = 'Item removed. <button type="button" class="btn-secondary" id="undo-remove">Undo</button>';
      document.getElementById('undo-remove').onclick = () => {
        if (undoRemoval?.owner !== draftOwner) return;
        invalidateAction(undoRemoval.line.action);
        state.cart[undoRemoval.key] = undoRemoval.line; undoRemoval = null;
        saveCart(); updateCartBadge(); renderCart(); feedback.replaceChildren();
      };
    };
  });
}
function renderCheckout() {
  window.meaRestoreFields();
  document.getElementById('checkout-id-display').textContent = state.lastId?.idNumber || 'Enter your ID first';
  document.getElementById('checkout-summary-body').innerHTML = MeaCart.groups(state.cart).map(g => `<tr class="checkout-group"><th colspan="2">${ACTION_LABEL[g.action]}</th></tr>${g.lines.map(l => `<tr><td>${esc(l.item.title)}${l.unavailable ? ' · unavailable' : ''}</td><td>${l.qty}</td></tr>`).join('')}`).join('') || '<tr><td colspan="2">No items selected</td></tr>';
}
function bindCheckoutForm() {
  document.getElementById('submit-order-btn').onclick = submitOrder;
  ['project-select', 'committee-input'].forEach(id => document.getElementById(id).addEventListener('change', () => { invalidateAction(); saveCart(); }));
  document.getElementById('committee-input').addEventListener('input', () => { invalidateAction(); saveCart(); });
}
function submitGroup(payload) {
  return new Promise((resolve, reject) => google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).submitOrder(payload));
}
async function submitOrder() {
  if (submitBusy) return;
  if (!draftOwner) return showView('login');
  if (!Object.keys(state.cart).length) return showToast('Your cart is empty.', true);
  if (Object.values(state.cart).some(l => l.unavailable)) return showToast('Remove unavailable items before submitting.', true);
  const epoch = accountEpoch, owner = draftOwner, fields = draftSnapshot();
  const groups = MeaCart.groups(state.cart);
  const btn = document.getElementById('submit-order-btn');
  submitBusy = true; btn.disabled = true; btn.textContent = 'Submitting…';
  const outcomes = [];
  try {
    for (const group of groups) {
      if (accountEpoch !== epoch) break;
      // Keep the identifier on the draft until confirmed or durably queued.
      const clientId = group.lines[0].clientId || uuid();
      group.lines.forEach(l => l.clientId = clientId); saveCart();
      try {
        const result = await submitGroup({clientId, idNumber: owner, caseType: group.action, project: fields.project, committee: fields.committee,
          items: group.lines.map(l => ({id: l.item.id, title: l.item.title, location: l.item.location || '', qty: l.qty,
            comment: `[${group.action}] - ${l.qty} ${fields.committee || fields.project}, ${state.lastId.name || owner}`}))});
        if (epoch !== accountEpoch) break;
        if (result?.success === false || result?.ok === false) throw new Error(result.error || 'Submission rejected.');
        group.lines.forEach(l => delete state.cart[MeaCart.key(l.item.id, l.action)]);
        outcomes.push(`${ACTION_LABEL[group.action]}: ${result?.queued ? 'Waiting to sync' : 'Submitted'}`);
      } catch (e) { outcomes.push(`${ACTION_LABEL[group.action]}: Failed — ${e.message}`); }
    }
    if (epoch === accountEpoch) {
      saveCart(); updateCartBadge(); showView('cart');
      document.getElementById('cart-feedback').textContent = outcomes.join(' · ');
    }
  } finally { submitBusy = false; btn.disabled = false; btn.textContent = 'SUBMIT ORDER'; }
}
async function inventoryRequest(action, payload = {}, token = false) {
  const url = getInventoryScriptUrl();
  if (!url) throw new Error('Set up the Inventory Script URL in Settings first.');
  const epoch = accountEpoch;
  const idToken = token ? await firebaseAuth?.currentUser?.getIdToken() : undefined;
  if (epoch !== accountEpoch) throw new Error('Account changed. Try again.');
  if (token && !idToken) throw new Error('Connect your school Google account first.');
  const res = await fetch(url + '?action=' + encodeURIComponent(action), {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify({...payload, token: getInventoryToken(), idToken})});
  const json = await res.json();
  if (!json.ok) { const e = new Error(json.error || 'Request failed.'); e.code = json.code; e.permanent = json.retryable === false; throw e; }
  return json;
}
function returnKey() { return 'mea_returns_v1:' + draftOwner; }
function pendingReturns() { return draftOwner ? readLocal(returnKey(), []) : []; }
function openReturnSheet(recordId) {
  const rec = window.meaHistoryRecords?.find(r => r.recordId === recordId);
  try { MeaCart.validateReturn(rec || {}, 1, draftOwner); } catch (e) { return showToast(e.message, true); }
  const pending = pendingReturns().find(r => r.borrowId === recordId);
  if (pending) return showToast(pending.failed ? 'Return failed. Use Retry in History.' : 'This return is waiting to sync.', true);
  const remaining = MeaCart.outstanding(rec);
  openWorkflow(`<h2 id="workflow-title">Return ${esc(rec.item)}</h2><p>${esc(rec.project || 'Personal')}</p><p>Borrowed: ${rec.borrowedQty ?? rec.qty} · Returned: ${rec.returnedQty || 0} · Remaining: ${remaining}</p><label class="field-label" for="sheet-quantity">Quantity to return</label>${quantityControls(remaining)}<p id="return-error" role="alert"></p><button type="button" class="btn-primary" id="return-confirm">Confirm return</button>`);
  bindQuantity(); document.getElementById('sheet-quantity').max = remaining;
  document.getElementById('return-confirm').onclick = async () => {
    try {
      const qty = MeaCart.validateReturn(rec, document.getElementById('sheet-quantity').value, draftOwner);
      const queue = pendingReturns(); queue.push({clientId: uuid(), borrowId: rec.recordId, qty, idNumber: draftOwner});
      if (!writeLocal(returnKey(), queue)) throw new Error('Could not save return. Free device storage and try again.');
      closeWorkflow(); showToast('Return saved · waiting to sync'); renderReturnQueue(); flushReturns();
    } catch (e) { document.getElementById('return-error').textContent = e.message; }
  };
}
function renderReturnQueue() {
  let el = document.getElementById('return-queue');
  if (!el) { el = document.createElement('div'); el.id = 'return-queue'; el.setAttribute('role', 'status'); document.getElementById('history-pending-list').before(el); }
  el.replaceChildren();
  pendingReturns().forEach(entry => {
    const row = document.createElement('p'); row.textContent = entry.failed ? `Return failed: ${entry.error} ` : `Return of ${entry.qty} units waiting to sync. `;
    if (entry.failed) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn-secondary'; retry.textContent = 'Retry';
      retry.onclick = () => { const q = pendingReturns(); const r = q.find(x => x.clientId === entry.clientId); r.failed = false; writeLocal(returnKey(), q); flushReturns(); }; row.append(retry);
      const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'btn-secondary'; discard.textContent = 'Discard pending return'; discard.onclick = () => { writeLocal(returnKey(), pendingReturns().filter(x => x.clientId !== entry.clientId)); renderReturnQueue(); }; row.append(discard);
    }
    el.append(row);
  });
}
async function flushReturns() {
  if (returnBusy || !draftOwner || !navigator.onLine) return;
  returnBusy = true;
  const epoch = accountEpoch, key = returnKey();
  try {
    for (const entry of pendingReturns().filter(r => !r.failed)) {
      if (epoch !== accountEpoch) break;
      try {
        await inventoryRequest('returnItems', entry);
        writeLocal(key, readLocal(key, []).filter(r => r.clientId !== entry.clientId));
        if (epoch === accountEpoch && state.view === 'history') await renderHistory();
      } catch (e) {
        const queue = readLocal(key, []), row = queue.find(r => r.clientId === entry.clientId);
        if (row && e.permanent) { row.failed = true; row.error = e.message; writeLocal(key, queue); }
        break;
      }
    }
  } finally { returnBusy = false; if (epoch === accountEpoch) renderReturnQueue(); }
}
async function loadFirebase() {
  if (firebaseAuth) return firebaseAuth;
  const config = window.MEA_CONFIG?.firebase;
  if (!config?.apiKey || !config?.authDomain || !config?.projectId) throw new Error('School Google connection is not configured yet. Continue with your ID.');
  for (const file of ['firebase-app-compat.js', 'firebase-auth-compat.js']) {
    if (file.includes('auth') && window.firebase?.auth || file.includes('app-') && window.firebase?.initializeApp) continue;
    await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = 'https://www.gstatic.com/firebasejs/12.4.0/' + file; s.onload = resolve; s.onerror = () => { s.remove(); reject(new Error('Could not load Google sign-in. Check your connection.')); }; document.head.append(s); });
  }
  if (!firebase.apps.length) firebase.initializeApp(config);
  firebaseAuth = firebase.auth();
  return firebaseAuth;
}
async function connectGoogle() {
  const epoch = accountEpoch;
  try {
    const auth = await loadFirebase();
    const provider = new firebase.auth.GoogleAuthProvider(); provider.setCustomParameters({prompt: 'select_account'});
    await auth.signInWithPopup(provider);
    const data = await inventoryRequest('googleMember', {}, true);
    if (epoch !== accountEpoch) return;
    if (draftOwner && String(data.member.idNumber) !== draftOwner) { verifiedMember = null; cloudLoaded = false; document.getElementById('google-account-status').textContent = 'Google disconnected · cart remains on this device'; await auth.signOut(); throw new Error('This Google account belongs to a different member. Log out first to switch accounts.'); }
    if (!draftOwner) {
      // Email verification grants ordinary access only. Officer access still uses the established tracker gate.
      state.lastId = {...data.member, level: 'NONE', found: true}; saveLogin(state.lastId); window.meaSwitchAccount(); renderIdentity(); showView('home');
    }
    verifiedMember = {uid: auth.currentUser.uid, idNumber: data.member.idNumber};
    document.getElementById('google-account-status').textContent = 'School Google connected · cart sync enabled';
    await loadCloudDraft();
  } catch (e) { showToast(e.message, true); document.getElementById('google-login-status').textContent = e.message; if (verifiedMember) saveStatus('Saved on this device · cloud sync unavailable'); }
}
function applyCloudDraft(data) {
  const draft = data.draft || {};
  state.cart = MeaCart.normalize(draft.cart); draftRevision = data.revision; draftDirty = false; cloudConflict = false;
  writeLocal(draftKey(), {...draft, cart: state.cart, dirty: false}); window.meaRestoreFields(); updateCartBadge();
  if (state.view === 'cart') renderCart(); saveStatus('Synced across devices');
}
function resolveDraftConflict(data) {
  cloudConflict = true;
  openWorkflow(`<h2 id="workflow-title">Choose your cart</h2><p>Your device has ${Object.keys(state.cart).length} entries. The saved cloud cart has ${Object.keys(data.draft?.cart || {}).length} entries.</p><p>Choose which version to keep. Nothing is overwritten until you choose.</p><button type="button" class="btn-primary" id="use-cloud">Use saved cloud cart</button><button type="button" class="btn-secondary" id="use-local">Keep this device’s cart</button>`);
  document.getElementById('use-cloud').onclick = () => { applyCloudDraft(data); closeWorkflow(); };
  document.getElementById('use-local').onclick = () => { draftRevision = data.revision; cloudConflict = false; draftDirty = true; closeWorkflow(); syncCloudDraft(); };
}
async function loadCloudDraft() {
  const epoch = accountEpoch;
  const wasLoaded = cloudLoaded;
  const data = await inventoryRequest('cartRead', {}, true);
  if (epoch !== accountEpoch || !verifiedMember) return;
  cloudLoaded = true;
  if (cloudBusy || cloudConflict) return;
  const local = draftSnapshot();
  if (wasLoaded && data.revision === draftRevision) { if (draftDirty) await syncCloudDraft(); return; }
  if ((draftDirty || (!wasLoaded && Object.keys(local.cart).length)) && !MeaCart.sameDraft(local, data.draft)) {
    if (data.revision > 0) resolveDraftConflict(data);
    else { draftRevision = 0; draftDirty = true; await syncCloudDraft(); }
  } else applyCloudDraft(data);
}
async function syncCloudDraft() {
  if (!verifiedMember || !cloudLoaded || !draftDirty || cloudBusy || cloudConflict || !navigator.onLine) return;
  cloudBusy = true; const epoch = accountEpoch, snapshot = JSON.stringify(draftSnapshot());
  try {
    const data = await inventoryRequest('cartWrite', {expectedRevision: draftRevision, draft: JSON.parse(snapshot)}, true);
    if (epoch !== accountEpoch) return;
    draftRevision = data.revision;
    if (snapshot === JSON.stringify(draftSnapshot())) { draftDirty = false; writeLocal(draftKey(), {...JSON.parse(snapshot), dirty: false}); saveStatus('Synced across devices'); }
  } catch (e) {
    if (epoch !== accountEpoch) return;
    saveStatus('Saved on this device · waiting to sync');
    if (e.code === 'CONFLICT') { try { const latest = await inventoryRequest('cartRead', {}, true); if (epoch === accountEpoch && verifiedMember) resolveDraftConflict(latest); } catch (_) {} }
  } finally { cloudBusy = false; if (epoch === accountEpoch && draftDirty && !cloudConflict && navigator.onLine) { clearTimeout(draftTimer); draftTimer = setTimeout(syncCloudDraft, 10000); } }
}
window.meaInstallHelp = function() {
  const embedded = /FBAN|FBAV|Instagram|Line\/|Messenger/i.test(navigator.userAgent);
  openWorkflow(`<h2 id="workflow-title">Install MEA App</h2><p>Keep MEA on your home screen for quick access.</p>${embedded ? '<p class="workflow-warning">Open this page in Safari on Apple devices or Chrome on Android using this browser’s menu.</p>' : ''}${isIOS() ? '<ol class="install-guide"><li><img src="icons/ui/share.svg" alt="" width="24" height="24"> Open the Share menu in Safari.</li><li><img src="icons/ui/plus.svg" alt="" width="24" height="24"> Choose Add to Home Screen.</li><li>Enable Open as Web App if shown, then tap Add.</li></ol>' : '<ol class="install-guide"><li>Open your browser’s menu.</li><li>Choose Install app or Add to Home screen.</li><li>Confirm installation.</li></ol>'}<button type="button" class="btn-secondary" id="install-help-done">Done</button>`);
  document.getElementById('install-help-done').onclick = closeWorkflow;
};
document.addEventListener('DOMContentLoaded', () => {
  window.meaSwitchAccount();
  if (window.MEA_CONFIG?.firebase?.apiKey) loadFirebase().then(auth => auth.onAuthStateChanged(async user => {
    if (!user || !draftOwner || verifiedMember) return;
    const epoch = accountEpoch;
    try {
      const data = await inventoryRequest('googleMember', {}, true);
      if (epoch !== accountEpoch || String(data.member.idNumber) !== draftOwner) return;
      verifiedMember = {uid: user.uid, idNumber: draftOwner};
      document.getElementById('google-account-status').textContent = 'School Google connected · cart sync enabled';
      await loadCloudDraft();
    } catch (_) { saveStatus('Saved on this device · reconnect Google to sync'); }
  })).catch(() => {});
  document.getElementById('workflow-dialog').querySelector('.sheet-close').onclick = closeWorkflow;
  document.getElementById('workflow-dialog').addEventListener('cancel', e => { e.preventDefault(); closeWorkflow(); });
  document.getElementById('workflow-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) closeWorkflow(); });
  document.getElementById('cart-shortcut').onclick = () => showView('cart');
  document.getElementById('google-login').onclick = connectGoogle;
  document.getElementById('google-connect').onclick = connectGoogle;
  document.getElementById('view-history').addEventListener('click', e => { const b = e.target.closest('[data-return-id]'); if (b) openReturnSheet(b.dataset.returnId); });
  document.addEventListener('mea:viewchange', () => { updateCartBadge(); if (state.view === 'history') { renderReturnQueue(); flushReturns(); } });
  window.addEventListener('online', () => { flushReturns(); if (verifiedMember) loadCloudDraft().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && verifiedMember) loadCloudDraft().catch(() => {}); });
  setInterval(() => { flushReturns(); if (verifiedMember && draftDirty) { if (cloudLoaded) syncCloudDraft(); else loadCloudDraft().catch(() => {}); } }, 20000);
  window.addEventListener('storage', e => {
    if (e.key === draftKey()) { const saved = readLocal(draftKey(), {}); state.cart = MeaCart.normalize(saved.cart); draftDirty = !!saved.dirty; window.meaRestoreFields(); updateCartBadge(); if (state.view === 'cart') renderCart(); }
  });
});
