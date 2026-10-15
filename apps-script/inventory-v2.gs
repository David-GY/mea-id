/**
 * MEA Room Inventory v2. Deploy as a SEPARATE Apps Script project from the tracker.
 * Run setupInventoryV2() once against a COPY first. Existing inventory A:F and transaction A:I layouts are preserved.
 * Script properties: INVENTORY_SPREADSHEET_ID, TRACKER_SPREADSHEET_ID,
 * FIREBASE_WEB_API_KEY (optional), ACCESS_TOKEN (optional).
 * The append-only journal is authoritative for new writes; visible tabs are repairable projections.
 */
var MEA_INV = {
  spreadsheet: '1oAMU9MEVxJqWuHCiwMsKsMePYlREYgq_sBi4_2-Ra3Y',
  tracker: '1426S83-4R3b7Ys81thvRETPbmIiNjJtYw853gFhuj-I',
  catalogs: ['Inventory', 'Special Inventory'],
  journal: '_MEA_EVENTS', drafts: '_MEA_DRAFTS', legacy: '_MEA_LEGACY'
};
function invBook_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('INVENTORY_SPREADSHEET_ID') || MEA_INV.spreadsheet); }
function invJson_(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
function invError_(message, code) { var e = new Error(message); e.code = code || 'INVALID'; return e; }
function invText_(v) { return String(v == null ? '' : v).trim(); }
function invQty_(v) { var n = Number(v); if (!Number.isSafeInteger(n) || n < 1 || n > 9999) throw invError_('Quantity must be a whole number from 1 to 9999.'); return n; }
function invId_(v) { var id = invText_(v); if (!/^\d{6}$/.test(id)) throw invError_('A six-digit member ID is required.'); return id; }
function invWithLock_(fn) { var lock = LockService.getScriptLock(); lock.waitLock(30000); try { return fn(); } finally { lock.releaseLock(); } }
function invToken_(p) { var configured = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN'); if (configured && p.token !== configured) throw invError_('Invalid access code.', 'UNAUTHORIZED'); }
function doGet(e) { return invRoute_(e, false); }
function doPost(e) { return invRoute_(e, true); }
function invRoute_(e, post) {
  try {
    var p = Object.assign({}, e && e.parameter || {});
    if (post && e.postData && e.postData.contents) Object.assign(p, JSON.parse(e.postData.contents));
    var action = invText_(e && e.parameter && e.parameter.action || p.action);
    if (action === 'inventory') return invJson_({ok: true, version: 2, items: invCatalog_()});
    if (action === 'history') { invToken_(p); return invJson_({ok: true, records: invHistory_()}); }
    if (!post) throw invError_('This operation requires POST.');
    invToken_(p);
    var result;
    if (action === 'submitOrder') result = invWithLock_(function() { return invSubmit_(p); });
    else if (action === 'returnItems') result = invWithLock_(function() { return invReturn_(p); });
    else if (action === 'googleMember') { var identity = invIdentity_(p.idToken); result = {member: identity.member}; }
    else if (action === 'cartRead' || action === 'cartWrite') {
      var identity = invIdentity_(p.idToken);
      result = invWithLock_(function() { return invDraft_(action, identity, p); });
    } else throw invError_('Unknown action.');
    return invJson_(Object.assign({ok: true}, result));
  } catch (e) { return invJson_({ok: false, error: e.message, code: e.code || 'SERVER_ERROR', retryable: !e.code}); }
}
function invSheet_(name) { var sheet = invBook_().getSheetByName(name); if (!sheet) throw invError_('Run setupInventoryV2 first. Missing ' + name, 'SETUP_REQUIRED'); return sheet; }
function invRows_(name) { var sheet = invSheet_(name); if (sheet.getLastRow() < 2) return []; return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues(); }
function invEnsure_(book, name, header) { var s = book.getSheetByName(name); if (!s) { s = book.insertSheet(name); s.getRange(1, 1, 1, header.length).setValues([header]); s.hideSheet(); } return s; }
function setupInventoryV2() {
  return invWithLock_(function() {
    var book = invBook_();
    invEnsure_(book, MEA_INV.journal, ['Client ID', 'Owner ID', 'Event JSON', 'Server time']);
    invEnsure_(book, MEA_INV.drafts, ['Google UID', 'Member ID', 'Revision', 'Draft JSON', 'Updated at']);
    invEnsure_(book, MEA_INV.legacy, ['Record ID', 'Legacy JSON']);
    MEA_INV.catalogs.forEach(function(name) {
      var s = book.getSheetByName(name); if (!s) return;
      if (s.getMaxColumns() < 7) s.insertColumnsAfter(s.getMaxColumns(), 7 - s.getMaxColumns());
      var label = invText_(s.getRange(4, 7).getValue());
      if (label && label !== 'MEA Item ID') throw invError_(name + ' column G is already occupied.');
      s.getRange(4, 7).setValue('MEA Item ID');
      if (s.getLastRow() < 5) return;
      var rows = s.getRange(5, 1, s.getLastRow() - 4, 7).getValues();
      rows.forEach(function(row, i) { if (invText_(row[1]) && !invText_(row[6])) s.getRange(i + 5, 7).setValue('ITEM-' + Utilities.getUuid()); });
    });
    ['Borrow', 'Consume', 'Return'].forEach(function(name) {
      var s = book.getSheetByName(name); if (!s) throw invError_('Missing existing tab ' + name);
      if (s.getMaxColumns() < 12) s.insertColumnsAfter(s.getMaxColumns(), 12 - s.getMaxColumns());
      var headers = s.getRange(1, 10, 1, 3).getValues()[0];
      ['MEA Record ID', 'MEA Borrow ID', 'MEA Client ID'].forEach(function(label, i) { if (headers[i] && headers[i] !== label) throw invError_(name + ' metadata columns are occupied.'); });
      s.getRange(1, 10, 1, 3).setValues([['MEA Record ID', 'MEA Borrow ID', 'MEA Client ID']]);
    });
    invImportLegacy_();
    return {ok: true};
  });
}
function invCatalog_() {
  var book = invBook_(), items = [], seen = {};
  MEA_INV.catalogs.forEach(function(name) {
    var s = book.getSheetByName(name); if (!s || s.getLastRow() < 5) return;
    if (s.getLastColumn() < 7) throw invError_('Run setupInventoryV2 to assign permanent item IDs.', 'SETUP_REQUIRED');
    s.getRange(5, 1, s.getLastRow() - 4, 7).getDisplayValues().forEach(function(row) {
      if (!invText_(row[1])) return;
      var id = invText_(row[6]);
      if (!id || seen[id]) throw invError_('Missing or duplicate permanent item ID. Run setup or contact SUS.', 'SETUP_REQUIRED');
      seen[id] = true;
      items.push({id: id, title: row[1], qty: row[2], location: row[3], category: row[4], notes: row[5]});
    });
  });
  return items;
}
function invEvents_() { return invRows_(MEA_INV.journal).map(function(row) { return JSON.parse(row[2]); }); }
function invFindEvent_(clientId) {
  return invEvents_().find(function(e) { return e.clientId === clientId; });
}
function invClient_(p) { var id = invText_(p.clientId); if (!/^[A-Za-z0-9-]{8,120}$/.test(id)) throw invError_('A valid retry identifier is required.'); return id; }
function invReplay_(p, type) {
  var prior = invFindEvent_(invClient_(p));
  if (!prior) return null;
  if (prior.idNumber !== invId_(p.idNumber) || prior.type !== type) throw invError_('Retry identifier belongs to another operation.');
  // A retried operation is immutable. Do not reuse a key for edited items or quantities.
  if (prior.request !== invRequestFingerprint_(p, type)) throw invError_('This request changed after submission. Refresh and try again.', 'CHANGED_REQUEST');
  try { invProjectEvent_(prior); } catch (_) { /* projection repaired separately; journal already committed */ }
  return prior.result;
}
function invRequestFingerprint_(p, type) {
  return JSON.stringify(type === 'RETURN' ? [p.borrowId, Number(p.qty)] : [p.caseType, invText_(p.project), invText_(p.committee), (p.items || []).map(function(l) { return [l.id, Number(l.qty), invText_(l.title), invText_(l.location)]; })]);
}
function invAppendEvent_(event) {
  var json = JSON.stringify(event);
  if (json.length > 45000) throw invError_('Order is too large. Split it into smaller checkouts.');
  invSheet_(MEA_INV.journal).appendRow([event.clientId, event.idNumber, json, new Date(event.time)]);
  SpreadsheetApp.flush();
  try { invProjectEvent_(event); } catch (_) { /* journal success must not become a duplicate on retry */ }
  try { invReceipt_(event); } catch (_) { /* receipt failure never rolls back the transaction */ }
  return event.result;
}
function invSubmit_(p) {
  if (p.caseType !== 'BORROWING' && p.caseType !== 'CONSUMING') throw invError_('Choose Borrow or Consume. Returns start from History.');
  var replay = invReplay_(p, 'ORDER'); if (replay) return replay;
  var owner = invId_(p.idNumber), catalog = invCatalog_();
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 100) throw invError_('Choose between 1 and 100 item entries.');
  var seen = {};
  var lines = p.items.map(function(line) {
    var matches = catalog.filter(function(i) { return i.id === line.id; });
    if (matches.length !== 1) throw invError_('An item changed or was removed. Refresh your cart.');
    var item = matches[0], qty = invQty_(line.qty);
    if (seen[item.id]) throw invError_('Duplicate item entry.'); seen[item.id] = true;
    return {recordId: 'REC-' + Utilities.getUuid(), itemId: item.id, item: item.title, location: item.location, qty: qty};
  });
  var member = invMemberById_(owner);
  var event = {name: member.name, email: member.email, type: 'ORDER', clientId: p.clientId, idNumber: owner, time: new Date().toISOString(), caseType: p.caseType,
    project: invText_(p.project).slice(0, 200), committee: invText_(p.committee).slice(0, 200), lines: lines,
    request: invRequestFingerprint_(p, 'ORDER'), result: {logged: lines.length, recordIds: lines.map(function(l) { return l.recordId; })}};
  return invAppendEvent_(event);
}
function invHistory_() {
  var records = invRows_(MEA_INV.legacy).map(function(row) { return JSON.parse(row[1]); });
  var returns = {};
  invEvents_().forEach(function(e) {
    if (e.type === 'RETURN') { returns[e.borrowId] = (returns[e.borrowId] || 0) + e.qty; return; }
    if (e.type === 'ORDER') e.lines.forEach(function(line) {
      records.push({recordId: line.recordId, itemId: line.itemId, item: line.item, qty: line.qty, borrowedQty: e.caseType === 'BORROWING' ? line.qty : 0,
        returnedQty: 0, caseType: e.caseType, idNum: e.idNumber, project: e.project, committee: e.committee, time: e.time, returnable: e.caseType === 'BORROWING', name: e.name || '', email: e.email || ''});
    });
  });
  records.forEach(function(r) {
    if (r.caseType === 'BORROWING') {
      r.returnedQty = Number(r.returnedQty || 0) + Number(returns[r.recordId] || 0);
      r.outstandingQty = Math.max(0, Number(r.borrowedQty) - r.returnedQty);
      r.resolved = r.outstandingQty === 0;
    } else r.resolved = true;
  });
  return records.sort(function(a, b) { return String(b.time).localeCompare(String(a.time)); });
}
function invReturn_(p) {
  var replay = invReplay_(p, 'RETURN'); if (replay) return replay;
  var owner = invId_(p.idNumber), qty = invQty_(p.qty);
  var records = invHistory_().filter(function(r) { return r.recordId === p.borrowId; });
  if (records.length !== 1) throw invError_('Borrowing record not found. Contact SUS.');
  var rec = records[0];
  if (rec.caseType !== 'BORROWING' || !rec.returnable || rec.idNum !== owner) throw invError_('Only the borrower can return this record.');
  if (qty > rec.outstandingQty) throw invError_('Return exceeds the outstanding quantity. Refresh History.');
  return invAppendEvent_({type: 'RETURN', clientId: p.clientId, idNumber: owner, borrowId: rec.recordId, qty: qty,
    time: new Date().toISOString(), item: rec.item, project: rec.project, committee: rec.committee,
    request: invRequestFingerprint_(p, 'RETURN'), result: {remaining: rec.outstandingQty - qty}});
}
function invSafeCell_(v) { var s = String(v == null ? '' : v); return /^[=+@-]/.test(s) ? "'" + s : s; }
function invProjectEvent_(e) {
  var name = e.type === 'RETURN' ? 'Return' : (e.caseType === 'BORROWING' ? 'Borrow' : 'Consume');
  var sheet = invSheet_(name), existing = {};
  if (sheet.getLastRow() > 1) sheet.getRange(2, 10, sheet.getLastRow() - 1, 1).getValues().forEach(function(row) { existing[row[0]] = true; });
  var lines = e.type === 'RETURN' ? [{recordId: 'RETURN-' + e.clientId, item: e.item, qty: e.qty}] : e.lines;
  lines.forEach(function(line) {
    if (existing[line.recordId]) return;
    var member = invMemberById_(e.idNumber);
    sheet.appendRow([new Date(e.time), invSafeCell_(line.item), line.qty, invSafeCell_(e.project), invSafeCell_(e.committee), e.idNumber, invSafeCell_(member.name), invSafeCell_(member.email), false, line.recordId, e.borrowId || '', e.clientId]);
  });
  if (e.type === 'RETURN') {
    var borrow = invSheet_('Borrow');
    var history = invHistory_().find(function(r) { return r.recordId === e.borrowId; });
    if (borrow.getLastRow() > 1) borrow.getRange(2, 10, borrow.getLastRow() - 1, 1).getValues().forEach(function(row, i) { if (row[0] === e.borrowId) borrow.getRange(i + 2, 9).setValue(history.resolved); });
  }
}
function repairInventoryProjections() { return invWithLock_(function() { invEvents_().forEach(invProjectEvent_); }); }
function invImportLegacy_() {
  var known = {};
  invRows_(MEA_INV.legacy).forEach(function(row) { known[row[0]] = true; });
  ['Borrow', 'Consume'].forEach(function(name) {
    var s = invSheet_(name); if (s.getLastRow() < 2) return;
    var rows = s.getRange(2, 1, s.getLastRow() - 1, 12).getValues();
    rows.forEach(function(row, i) {
      if (!invText_(row[1]) || invText_(row[11])) return; // V2 projected rows already have a client ID.
      var recordId = invText_(row[9]) || 'LEGACY-' + Utilities.getUuid();
      if (!row[9]) s.getRange(i + 2, 10).setValue(recordId);
      if (known[recordId]) return;
      var rec = {recordId: recordId, item: invText_(row[1]), qty: row[2], borrowedQty: Number(row[2]) || 0,
        returnedQty: name === 'Borrow' && row[8] === true ? (Number(row[2]) || 0) : 0, name: invText_(row[6]), email: invText_(row[7]), caseType: name === 'Borrow' ? 'BORROWING' : 'CONSUMING', idNum: invText_(row[5]),
        project: invText_(row[3]), committee: invText_(row[4]), time: row[0] instanceof Date ? row[0].toISOString() : invText_(row[0]),
        returnable: false}; // Existing Return rows are not reliably linked: reconciliation is required.
      invSheet_(MEA_INV.legacy).appendRow([recordId, JSON.stringify(rec)]); known[recordId] = true;
    });
  });
}
/** Officer-only editor utility, never routed publicly. Inspect old Return rows first. */
function reconcileLegacyBorrow(recordId, confirmedReturnedQty) {
  return invWithLock_(function() {
    var s = invSheet_(MEA_INV.legacy), rows = invRows_(MEA_INV.legacy);
    var index = rows.findIndex(function(row) { return row[0] === recordId; });
    if (index < 0) throw invError_('Legacy record not found.');
    var rec = JSON.parse(rows[index][1]), qty = Number(confirmedReturnedQty);
    if (rec.caseType !== 'BORROWING' || !Number.isSafeInteger(qty) || qty < 0 || qty > rec.borrowedQty) throw invError_('Invalid reconciled quantity.');
    if (invEvents_().some(function(e) { return e.borrowId === recordId; })) throw invError_('This record already has v2 returns.');
    rec.returnedQty = qty; rec.returnable = true;
    s.getRange(index + 2, 2).setValue(JSON.stringify(rec));
  });
}
function invIdentity_(idToken) {
  if (!idToken) throw invError_('School Google sign-in is required for cloud carts.', 'UNAUTHORIZED');
  var key = PropertiesService.getScriptProperties().getProperty('FIREBASE_WEB_API_KEY');
  if (!key) throw invError_('Google sign-in has not been configured.', 'SETUP_REQUIRED');
  // Google validates the Firebase token against this project's API key. Never trust decoded client claims.
  var response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(key), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({idToken: idToken}), muteHttpExceptions: true});
  var json = JSON.parse(response.getContentText());
  var user = json.users && json.users[0];
  if (response.getResponseCode() !== 200 || !user || user.disabled || !user.emailVerified || !(user.providerUserInfo || []).some(function(p) { return p.providerId === 'google.com'; })) throw invError_('Verify your school Google account again.', 'UNAUTHORIZED');
  var book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('TRACKER_SPREADSHEET_ID') || MEA_INV.tracker);
  var s = book.getSheetByName('MAIN'); if (!s) throw invError_('Member roster unavailable.', 'SETUP_REQUIRED');
  var rows = s.getDataRange().getDisplayValues(), header = -1, idCol = -1, emailCol = -1, nameCol = -1;
  for (var i = 0; i < Math.min(5, rows.length); i++) {
    var normalized = rows[i].map(function(v) { return invText_(v).toLowerCase().replace(/[^a-z0-9]/g, ''); });
    var ec = normalized.findIndex(function(v) { return ['email', 'emailaddress', 'schoolemail', 'ateneoemail'].indexOf(v) >= 0; });
    var ic = normalized.findIndex(function(v) { return ['id', 'idnumber', 'idnum', 'studentid'].indexOf(v) >= 0; });
    if (ec >= 0 && ic >= 0) { header = i; emailCol = ec; idCol = ic; nameCol = normalized.findIndex(function(v) { return ['name', 'fullname'].indexOf(v) >= 0; }); break; }
  }
  if (header < 0) throw invError_('Roster needs labeled ID and school email columns.', 'SETUP_REQUIRED');
  var email = invText_(user.email).toLowerCase();
  var matches = rows.slice(header + 1).filter(function(row) { return invText_(row[emailCol]).toLowerCase() === email; });
  if (matches.length !== 1) throw invError_('School email must match exactly one MEA member. Contact SUS.', 'ROSTER_MISMATCH');
  return {uid: user.localId, member: {idNumber: invId_(matches[0][idCol]), name: nameCol >= 0 ? matches[0][nameCol] : '', level: 'NONE'}};
}
function invValidateDraft_(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw invError_('Invalid cart draft.');
  if (!draft.cart || typeof draft.cart !== 'object' || Array.isArray(draft.cart) || Object.keys(draft.cart).length > 200) throw invError_('Invalid cart entries.');
  var cart = {}, catalog = invCatalog_(), itemMap = {};
  catalog.forEach(function(i) { itemMap[i.id] = i; });
  Object.keys(draft.cart).forEach(function(k) {
    var l = draft.cart[k];
    if (!l || !l.item || !itemMap[l.item.id] || ['BORROWING', 'CONSUMING'].indexOf(l.action) < 0 || k !== JSON.stringify([l.item.id, l.action])) throw invError_('Refresh your cart before syncing.');
    var item = itemMap[l.item.id];
    cart[k] = {item: {id: item.id, stableId: true, title: item.title, location: item.location, category: item.category, notes: item.notes, qtyDisplay: item.qty, qtyAvailable: /^\d+$/.test(item.qty) ? Number(item.qty) : null}, qty: invQty_(l.qty), action: l.action};
    if (l.clientId) cart[k].clientId = invText_(l.clientId);
  });
  return {cart: cart, project: invText_(draft.project).slice(0, 200), committee: invText_(draft.committee).slice(0, 200)};
}
function invDraft_(action, identity, p) {
  var s = invSheet_(MEA_INV.drafts), rows = invRows_(MEA_INV.drafts), index = rows.findIndex(function(row) { return row[0] === identity.uid; });
  if (index >= 0 && invText_(rows[index][1]) !== identity.member.idNumber) throw invError_('Member link changed. Contact SUS.', 'ROSTER_MISMATCH');
  var revision = index < 0 ? 0 : Number(rows[index][2]);
  if (action === 'cartRead') return {revision: revision, draft: index < 0 ? {cart: {}, project: '', committee: ''} : JSON.parse(rows[index][3])};
  if (p.expectedRevision !== revision) throw invError_('Cart changed on another device.', 'CONFLICT');
  var draft = invValidateDraft_(p.draft), json = JSON.stringify(draft);
  if (json.length > 45000) throw invError_('Cart is too large to sync.');
  var row = [identity.uid, identity.member.idNumber, revision + 1, json, new Date()];
  if (index < 0) s.appendRow(row); else s.getRange(index + 2, 1, 1, 5).setValues([row]);
  return {revision: revision + 1};
}

function invMemberById_(id) {
  var book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('TRACKER_SPREADSHEET_ID') || MEA_INV.tracker);
  var sheet = book.getSheetByName('MAIN'); if (!sheet) return {name: '', email: ''};
  var matches = sheet.getDataRange().getDisplayValues().filter(function(row) { return invText_(row[1]) === id; });
  return matches.length === 1 ? {name: invText_(matches[0][2]), email: invText_(matches[0][0])} : {name: '', email: ''};
}
function invReceipt_(event) {
  var member = invMemberById_(event.idNumber);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) return;
  var action = event.type === 'RETURN' ? 'Return' : event.caseType === 'BORROWING' ? 'Borrow' : 'Consume';
  var lines = event.type === 'RETURN' ? [{item: event.item, qty: event.qty}] : event.lines;
  var text = 'Hi ' + (member.name || 'there') + ',\n\nThis confirms your MEA Inventory ' + action.toLowerCase() + ' request:\n\n' + lines.map(function(l) { return l.item + ' × ' + l.qty; }).join('\n') + '\n\nProject/Dept: ' + event.project + '\nCommittee: ' + event.committee + '\nDate: ' + event.time + '\n\nIf anything looks wrong, contact the SUS team.\n— MEA Inventory';
  GmailApp.sendEmail(member.email, 'MEA Inventory Receipt — ' + action, text, {name: 'MEA Inventory'});
}
