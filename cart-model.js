/* Shared pure cart rules. No browser or network dependencies. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeaCart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const actions = ['BORROWING', 'CONSUMING'];
  function quantity(value) {
    const n = Number(value);
    if (!['string','number'].includes(typeof value) || !Number.isSafeInteger(n) || n < 1 || n > 9999) throw new Error('Enter a whole quantity from 1 to 9999.');
    return n;
  }
  function key(id, action) {
    if (!actions.includes(action)) throw new Error('Choose Borrow or Consume.');
    return JSON.stringify([String(id), action]);
  }
  function normalize(raw) {
    const result = {};
    Object.values(raw || {}).forEach(line => {
      try {
        if (!line.item || !line.item.id || !actions.includes(line.action)) return;
        result[key(line.item.id, line.action)] = {...line, qty: quantity(line.qty)};
      } catch (_) { /* Discard corrupt entries without losing the other lines. */ }
    });
    return result;
  }
  function groups(cart) {
    return actions.flatMap(action => [false, true].map(requestOnly => ({action, requestOnly, lines: Object.values(cart).filter(l => l.action === action && requiresManualVerification(l.item) === requestOnly)}))).filter(g => g.lines.length);
  }
  function reconcile(cart, inventory) {
    const items = new Map(inventory.map(i => [String(i.id), i]));
    return Object.fromEntries(Object.entries(cart).map(([k, line]) => {
      const fresh = items.get(String(line.item.id));
      return [k, {...line, item: fresh || line.item, unavailable: !fresh,
        changed: !!fresh && (line.changed || fresh.qtyDisplay !== line.item.qtyDisplay)}];
    }));
  }
  function outstanding(rec) { return Math.max(0, Number(rec.borrowedQty ?? rec.qty) - Number(rec.returnedQty || 0)); }
  function validateReturn(rec, qty, id, serverAuthorized = false) {
    qty = quantity(qty);
    if (rec.caseType !== 'BORROWING' || !rec.recordId || rec.returnable === false || (!serverAuthorized && String(rec.idNum) !== String(id))) throw new Error('This borrowing record cannot be returned by this account.');
    if (qty > outstanding(rec)) throw new Error('Quantity exceeds the outstanding balance.');
    return qty;
  }
  function requiresManualVerification(item) {
    return item?.requiresManualVerification === true || item?.inventorySection === 'Special Inventory';
  }
  function availability(raw, manual = false) {
    const text = String(raw ?? '').trim();
    if (manual) return {text: /^\d+$/.test(text) ? text + ' recorded · verify with SUS' : 'Quantity requires verification', value: null};
    return /^\d+$/.test(text) ? {text: text + ' recorded', value: Number(text)} : {text: text && text !== '*' ? text + ' · exact quantity unknown' : 'Quantity unknown', value: null};
  }
  function sameDraft(a, b) {
    const shape = d => ({project: d?.project || '', committee: d?.committee || '', lines: Object.values(d?.cart || {}).map(l => [String(l.item?.id), l.action, Number(l.qty)]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))});
    return JSON.stringify(shape(a)) === JSON.stringify(shape(b));
  }
  return {sameDraft, actions, quantity, key, normalize, groups, reconcile, outstanding, validateReturn, availability, requiresManualVerification};
});
