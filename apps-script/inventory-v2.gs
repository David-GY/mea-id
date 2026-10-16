/**
 * MEA Room Inventory v2. Deploy as a SEPARATE Apps Script project from the tracker.
 * Run setupInventoryV2() once against a COPY first. Existing inventory A:F and transaction A:I layouts are preserved.
 * Script properties: INVENTORY_SPREADSHEET_ID, TRACKER_SPREADSHEET_ID,
 * SUPABASE_PUBLISHABLE_KEY (optional), ACCESS_TOKEN (optional).
 * The append-only journal is authoritative for new writes; visible tabs are repairable projections.
 */
var MEA_INV = {
  supabasePublishableKey: 'sb_publishable_ao8arLQRQskKxvOqhZiIMw_-5h8jGnC',
  spreadsheet: '1oAMU9MEVxJqWuHCiwMsKsMePYlREYgq_sBi4_2-Ra3Y',
  tracker: '1426S83-4R3b7Ys81thvRETPbmIiNjJtYw853gFhuj-I',
  catalogs: ['Inventory', 'Special Inventory'],
  journal: '_MEA_EVENTS', drafts: '_MEA_DRAFTS', legacy: '_MEA_LEGACY', references: '_MEA_REFERENCES', accounts: 'Accounts'
};
function invBook_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('INVENTORY_SPREADSHEET_ID') || MEA_INV.spreadsheet); }
function invJson_(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
function invError_(message, code) { var e = new Error(message); e.code = code || 'INVALID'; return e; }
function invText_(v) { return String(v == null ? '' : v).trim(); }
function invMetadataId_(v, type) {
  if (v === '' || v == null || typeof v === 'boolean') return null;
  if (typeof v !== 'string' || /^(true|false)$/i.test(v.trim())) throw invError_('Unexpected metadata value. Run metadata dry run before repair.', 'METADATA_INVALID');
  var id = v.trim();
  if (!(type === 'record' ? /^(REC|LEGACY|RETURN)-[A-Za-z0-9-]+$/ : /^[A-Za-z0-9-]{8,120}$/).test(id)) throw invError_('Unexpected metadata ID: ' + id, 'METADATA_INVALID');
  return id;
}
/** Editor utility. Default is read-only; pass {dryRun:false} to repair. */
function repairLegacyMetadata(options) {
  return invWithLock_(function() {
    var result = invRepairMetadata_(!options || options.dryRun !== false);
    if (options && options.dryRun === false) { invImportLegacy_(); invBackfillReferences_(); }
    console.log(JSON.stringify(result)); return result;
  });
}
function invRepairMetadata_(dryRun) {
  var changes = [], issues = [], ids = {};
  ['Borrow', 'Consume', 'Return'].forEach(function(name) {
    var s = invSheet_(name); if (s.getLastRow() < 2) return;
    var rows = s.getRange(2, 1, s.getLastRow() - 1, 12).getValues();
    rows.forEach(function(row, i) {
      for (var j = 9; j < 12; j++) {
        if (typeof row[j] === 'boolean') changes.push({sheet: name, row: i + 2, column: j + 1});
        else try { invMetadataId_(row[j], j < 11 ? 'record' : 'client'); }
        catch (_) { issues.push(name + ' row ' + (i + 2) + ' column ' + (j + 1)); }
      }
      if (row[1] && typeof row[9] === 'string' && row[9]) {
        if (ids[row[9]]) issues.push('Duplicate record ID at ' + name + ' row ' + (i + 2));
        ids[row[9]] = true;
      }
    });
  });
  if (!dryRun && issues.length) throw invError_('Metadata needs review: ' + issues.join(', '), 'METADATA_INVALID');
  if (!dryRun) {
    ['Borrow', 'Consume', 'Return'].forEach(function(name) { var s = invSheet_(name); if (s.getLastRow() > 1) s.getRange(2, 10, s.getLastRow() - 1, 3).clearDataValidations(); });
    changes.forEach(function(c) { invSheet_(c.sheet).getRange(c.row, c.column).clearContent(); });
  }
  return {dryRun: dryRun, booleanPlaceholders: changes.length, issues: issues};
}
var invReferenceCache_ = null;
function invLookupReference_(type, id) {
  if (!invReferenceCache_) {
    var sheet = invBook_().getSheetByName(MEA_INV.references); if (!sheet || sheet.getLastRow() < 2) return '';
    invReferenceCache_ = {};
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function(r) {
      var key = r[0] + ':' + r[1];
      if (invReferenceCache_[key]) throw invError_('Duplicate display reference mapping.', 'METADATA_INVALID');
      invReferenceCache_[key] = r[2];
    });
  }
  return invReferenceCache_[type + ':' + id] || '';
}
/** Call only inside the script lock. Canonical IDs never change. */
function invReference_(type, id) {
  var existing = invLookupReference_(type, id); if (existing) return existing;
  var rows = invRows_(MEA_INV.references), max = 0;
  rows.forEach(function(r) { if (r[0] === type) max = Math.max(max, Number(String(r[2]).slice(type.length + 1)) || 0); });
  var code = type + '-' + String(max + 1).padStart(3, '0');
  invSheet_(MEA_INV.references).appendRow([type, id, code]);
  if (invReferenceCache_) invReferenceCache_[type + ':' + id] = code;
  return code;
}
function invDisplayColumns_(s, headerRow, start, labels) {
  var needed = start + labels.length - 1;
  if (s.getMaxColumns() < needed) s.insertColumnsAfter(s.getMaxColumns(), needed - s.getMaxColumns());
  var headers = s.getRange(headerRow, start, 1, labels.length).getValues()[0];
  labels.forEach(function(label, i) { if (headers[i] && headers[i] !== label) throw invError_('Display columns already occupied.', 'METADATA_INVALID'); });
  s.getRange(headerRow, start, 1, labels.length).setValues([labels]);
}
function invBackfillReferences_() {
  MEA_INV.catalogs.forEach(function(name) {
    var s = invBook_().getSheetByName(name); if (!s) return;
    invDisplayColumns_(s, 4, 8, ['Item code']);
    if (s.getLastRow() > 4) s.getRange(5, 1, s.getLastRow() - 4, 7).getValues().forEach(function(r, i) {
      if (r[1] && r[6]) s.getRange(i + 5, 8).setValue(invReference_('IT', r[6]));
    });
    s.hideColumns(7); s.showColumns(8);
  });
  ['Borrow', 'Consume', 'Return'].forEach(function(name) {
    var s = invSheet_(name), type = name === 'Borrow' ? 'BR' : name === 'Consume' ? 'CO' : 'RT';
    invDisplayColumns_(s, 1, 13, ['Reference', 'Original borrow']);
    if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, 12).getValues().forEach(function(r, i) {
      if (!r[1]) return;
      var id = invMetadataId_(r[9], 'record');
      if (!id) { id = 'LEGACY-' + Utilities.getUuid(); s.getRange(i + 2, 10).setValue(id); }
      var borrow = invMetadataId_(r[10], 'record');
      s.getRange(i + 2, 13, 1, 2).setValues([[invReference_(type, id), borrow ? invReference_('BR', borrow) : '']]);
    });
    s.hideColumns(10, 3); s.showColumns(13);
    if (name === 'Return') s.showColumns(14); else s.hideColumns(14);
  });
}
function invTrackerRoles_(id) {
  var book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('TRACKER_SPREADSHEET_ID') || MEA_INV.tracker);
  var main = book.getSheetByName('MAIN'); if (!main) throw invError_('Tracker roster unavailable.', 'ROSTER_UNAVAILABLE');
  var rows = main.getDataRange().getDisplayValues(), header = rows[1] || [], matches = rows.slice(3).filter(function(r) { return invText_(r[1]) === id; });
  if (matches.length !== 1) throw invError_('Member roster link needs review.', 'ROSTER_MISMATCH');
  var projects = header.slice(8).filter(function(label, i) { var v = invText_(matches[0][i + 8]).toLowerCase(); return label && v && ['0','false','no','n'].indexOf(v) < 0; });
  var cbab = book.getSheetByName('CBAB');
  if (cbab) {
    var extra = cbab.getDataRange().getDisplayValues(), index = (extra[0] || []).findIndex(function(h) { return /^id (num|number)$/i.test(invText_(h)); });
    if (index < 0) throw invError_('CBAB roster headers changed.', 'ROSTER_MISMATCH');
    if (extra.slice(1).some(function(r) { return invText_(r[index]) === id; })) projects.push('CBAB');
  }
  var access = book.getSheetByName('ACCESS'), admin = false;
  if (access) {
    var a = access.getDataRange().getDisplayValues();
    if (!a[0] || a[0][0] !== 'ID Number' || a[0][2] !== 'Level') throw invError_('Access sheet headers changed.', 'ROSTER_MISMATCH');
    var entries = a.slice(1).filter(function(r) { return invText_(r[0]) === id; });
    if (entries.length > 1) throw invError_('Duplicate access records need review.', 'ROSTER_MISMATCH');
    admin = !!entries.length && invText_(entries[0][2]).toUpperCase() === 'ADMIN';
  }
  return {admin: admin, projects: Array.from(new Set(projects.map(function(v) { return invText_(v).replace(/\s+/g, ' '); })))};
}
function invManagesProject_(actor, project) {
  return actor.verified && actor.accountKind === 'MEMBER' && (actor.admin === true || invProjectKey_(project) !== 'personal' && (actor.projects || []).some(function(p) { return invProjectKey_(p) === invProjectKey_(project); }));
}
function invViewsProject_(actor, project) {
  return actor.accountKind === 'MEMBER' && (actor.admin === true || invProjectKey_(project) !== 'personal' && (actor.projects || []).some(function(p) { return invProjectKey_(p) === invProjectKey_(project); }));
}
function invUnverified_(id) {
  id = invId_(id); var member = invMemberById_(id);
  if (!member.name && !member.email) throw invError_('Member ID is not in the roster.', 'UNAUTHORIZED');
  var roles = invTrackerRoles_(id);
  return {admin: false, projects: roles.projects, uid: null, ownerKey: 'member:' + id, ownerKeys: ['member:' + id], verified: false, accountKind: 'MEMBER', member: {idNumber: id, name: member.name, email: member.email, level: 'NONE'}};
}
function invOwns_(actor, record) {
  if (record.verified && !actor.verified) return false;
  var key = record.ownerKey || 'member:' + (record.idNumber || record.idNum);
  return (actor.ownerKeys || [actor.ownerKey]).indexOf(key) >= 0;
}
function invClassify_(user) {
  var email = invText_(user.email).toLowerCase();
  if (!/^[^\s@]+@student\.ateneo\.edu$/.test(email)) throw invError_('Use your student.ateneo.edu Google account.', 'DOMAIN_NOT_ALLOWED');
  var book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('TRACKER_SPREADSHEET_ID') || MEA_INV.tracker);
  var sheet = book.getSheetByName('MAIN'); if (!sheet) throw invError_('Member roster unavailable.', 'ROSTER_UNAVAILABLE');
  var rows = sheet.getDataRange().getDisplayValues();
  if (!rows[1] || rows[1][0] !== 'Email' || rows[1][1] !== 'ID' || rows[1][2] !== 'Full Name') throw invError_('Member roster headers changed. Contact SUS.', 'ROSTER_MISMATCH');
  var matches = rows.slice(3).filter(function(r) { return invText_(r[0]).toLowerCase() === email; });
  if (matches.length > 1 || matches.length === 1 && !/^\d{6}$/.test(invText_(matches[0][1]))) throw invError_('School email has an ambiguous member record. Contact SUS.', 'ROSTER_MISMATCH');
  return {email: email, memberId: matches.length ? invId_(matches[0][1]) : null, name: matches.length ? invText_(matches[0][2]) : invText_(user.displayName).slice(0, 200), kind: matches.length ? 'MEMBER' : 'GUEST'};
}
function invResolveAccount_(idToken) {
  var user = invGoogleUser_(idToken), classification = invClassify_(user);
  if (!user.localId || !/^[A-Za-z0-9_-]{1,128}$/.test(user.localId)) throw invError_('Invalid Google identity.', 'UNAUTHORIZED');
  return invWithLock_(function() { return invUpsertAccount_(user, classification); });
}
function invUpsertAccount_(user, c) {
  var rows = invRows_(MEA_INV.accounts), matches = rows.map(function(r, i) { return {row: r, index: i}; }).filter(function(r) { return r.row[0] === user.localId; });
  if (matches.length > 1 || rows.some(function(r) { return r[0] !== user.localId && invText_(r[1]).toLowerCase() === c.email; })) throw invError_('Account link needs SUS review.', 'ROSTER_MISMATCH');
  var old = matches.length ? matches[0].row : null;
  // Email/member reassignment is never silently accepted. Guest promotion is supported.
  if (old && (old[1] !== c.email || old[4] && old[4] !== c.memberId)) throw invError_('Account roster link changed. Contact SUS.', 'ROSTER_MISMATCH');
  var key = c.memberId ? 'member:' + c.memberId : 'guest:' + user.localId;
  var linked = old && old[8] ? JSON.parse(old[8]) : [];
  if (old && old[3] === 'GUEST' && c.kind === 'MEMBER') linked.push('guest:' + user.localId);
  linked = Array.from(new Set(linked));
  var guestCode = old && old[5] || (c.kind === 'GUEST' ? invReference_('G', user.localId) : '');
  var now = new Date(), row = [user.localId, c.email, invSafeCell_(c.name), c.kind, c.memberId || '', guestCode, old ? old[6] : now, now, JSON.stringify(linked)];
  var sheet = invSheet_(MEA_INV.accounts);
  if (old) sheet.getRange(matches[0].index + 2, 1, 1, row.length).setValues([row]); else sheet.appendRow(row);
  var roles = c.kind === 'MEMBER' ? invTrackerRoles_(c.memberId) : {admin:false,projects:[]};
  return {uid: user.localId, ownerKey: key, ownerKeys: [key].concat(linked), verified: true, admin: roles.admin, officer: roles.admin, projects: roles.projects, accountKind: c.kind, memberId: c.memberId, email: c.email, guestCode: guestCode,
    member: {idNumber: c.memberId || key, ownerKey: key, accountKind: c.kind, guestCode: guestCode, name: c.name, email: c.email, level: roles.admin ? 'ADMIN' : 'NONE', verified: true}};
}
function invProjectKey_(v) { return invText_(v).replace(/\s+/g, ' ').toLowerCase(); }
function invHistoryActor_(p) { return p.idToken ? invResolveAccount_(p.idToken) : invUnverified_(p.idNumber); }
function invCanReturn_(actor, r) { return r.caseType === 'BORROWING' && !r.deleted && r.returnable !== false && r.outstandingQty > 0 && (invOwns_(actor, r) || invManagesProject_(actor, r.project)); }
function invScopedHistory_(p, actor) {
  actor = actor || invHistoryActor_(p);
  var records = invHistory_();
  if (p.scope === 'officer' && !(actor.verified && actor.admin)) throw invError_('Verified officer access required.', 'FORBIDDEN');
  var project = invProjectKey_(p.project);
  if (p.scope === 'project' && project && !invViewsProject_(actor, p.project)) throw invError_('This project or department is not assigned to your tracker account.', 'FORBIDDEN');
  return records.filter(function(r) {
    if (p.scope === 'officer') return true;
    if (p.scope === 'project') return !!project && invProjectKey_(r.project) === project;
    return invOwns_(actor, r);
  }).map(function(r) {
    var copy = Object.assign({}, r); copy.canReturn = invCanReturn_(actor, r); copy.canDelete = invManagesProject_(actor, r.project); copy.canEdit = actor.verified && actor.admin === true;
    if (p.scope !== 'project' && p.scope !== 'officer') copy.idNum = actor.member.idNumber;
    else if (String(copy.idNum).indexOf('guest:') === 0) copy.idNum = copy.guestCode || 'Guest';
    delete copy.email; delete copy.ownerKey; delete copy.originalOwnerKey;
    return copy;
  });
}
function invHistoryResponse_(p) {
  var actor = invHistoryActor_(p), projects = {}, labels = [];
  (actor.projects || []).concat(invHistory_().map(function(r) { return r.project; })).forEach(function(label) {
    label = invText_(label).replace(/\s+/g, ' '); var key = invProjectKey_(label);
    if (key && invViewsProject_(actor, label) && !projects[key]) { projects[key] = true; labels.push(label); }
  });
  return {ok:true, records:invScopedHistory_(p, actor), projects:labels.sort(), admin:actor.verified && actor.admin === true};
}
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
    if (action === 'history' && !post) { invToken_(p); return invJson_(invHistoryResponse_(p)); }
    if (!post) throw invError_('This operation requires POST.');
    invToken_(p);
    var result;
    if (action === 'history') return invJson_(invHistoryResponse_(p));
    if (action === 'submitOrder' || action === 'returnItems' || ['recordDelete','recordRestore','recordEdit'].indexOf(action) >= 0) p.actor = p.idToken ? invResolveAccount_(p.idToken) : invUnverified_(p.idNumber);
    if (action === 'submitOrder') result = invWithLock_(function() { return invSubmit_(p); });
    else if (action === 'returnItems') result = invWithLock_(function() { return invReturn_(p); });
    else if (['recordDelete','recordRestore','recordEdit'].indexOf(action) >= 0) result = invWithLock_(function() { return invRecordChange_(action, p); });
    else if (action === 'googleMember') { var identity = invResolveAccount_(p.idToken); result = {member: identity.member, account: identity}; }
    else if (action === 'cartRead' || action === 'cartWrite') {
      var identity = invResolveAccount_(p.idToken);
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
    invEnsure_(book, MEA_INV.references, ['Type', 'Canonical ID', 'Display code']);
    invEnsure_(book, MEA_INV.accounts, ['Google UID', 'Verified email', 'Display name', 'Kind', 'Member ID', 'Guest code', 'First seen', 'Last seen', 'Prior owner keys']);
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
    invRepairMetadata_(false);
    invImportLegacy_();
    invBackfillReferences_();
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
      items.push({id: id, itemCode: invLookupReference_('IT', id), title: row[1], qty: row[2], location: row[3], category: row[4], notes: row[5]});
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
  if (!invOwns_(p.actor || invUnverified_(p.idNumber), prior) || prior.type !== type) throw invError_('Retry identifier belongs to another operation.');
  // A retried operation is immutable. Do not reuse a key for edited items or quantities.
  if (prior.request !== invRequestFingerprint_(p, type)) throw invError_('This request changed after submission. Refresh and try again.', 'CHANGED_REQUEST');
  try { invProjectEvent_(prior); } catch (_) { /* projection repaired separately; journal already committed */ }
  return prior.result;
}
function invRequestFingerprint_(p, type) {
  if (type.indexOf('RECORD_') === 0) return JSON.stringify([p.recordId,p.expectedRevision,p.changes || null]);
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
  var actor = p.actor || invUnverified_(p.idNumber), owner = actor.member.idNumber, catalog = invCatalog_();
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 100) throw invError_('Choose between 1 and 100 item entries.');
  var seen = {};
  var lines = p.items.map(function(line) {
    var matches = catalog.filter(function(i) { return i.id === line.id; });
    if (matches.length !== 1) throw invError_('An item changed or was removed. Refresh your cart.');
    var item = matches[0], qty = invQty_(line.qty);
    if (seen[item.id]) throw invError_('Duplicate item entry.'); seen[item.id] = true;
    var recordId = 'REC-' + Utilities.getUuid();
    return {recordId: recordId, reference: invReference_(p.caseType === 'BORROWING' ? 'BR' : 'CO', recordId), itemId: item.id, item: item.title, location: item.location, qty: qty};
  });
  var member = actor.member;
  var event = {ownerKey: actor.ownerKey, verified: actor.verified, accountKind: actor.accountKind, guestCode: actor.guestCode || '', name: member.name, email: member.email, type: 'ORDER', clientId: p.clientId, idNumber: owner, time: new Date().toISOString(), caseType: p.caseType,
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
      records.push({ownerKey: e.ownerKey || 'member:' + e.idNumber, verified: !!e.verified, accountKind: e.accountKind || 'MEMBER', guestCode: e.guestCode || '', reference: line.reference || invLookupReference_(e.caseType === 'BORROWING' ? 'BR' : 'CO', line.recordId), recordId: line.recordId, itemId: line.itemId, item: line.item, qty: line.qty, borrowedQty: e.caseType === 'BORROWING' ? line.qty : 0,
        returnedQty: 0, caseType: e.caseType, idNum: e.idNumber, project: e.project, committee: e.committee, time: e.time, returnable: e.caseType === 'BORROWING', name: e.name || '', email: e.email || ''});
    });
  });
  invEvents_().filter(function(e) { return e.type.indexOf('RECORD_') === 0; }).forEach(function(e) {
    var record = records.find(function(r) { return r.recordId === e.recordId; }); if(!record)return;
    if(e.type === 'RECORD_EDIT') { record.qty=e.changes.qty; if(record.caseType==='BORROWING')record.borrowedQty=e.changes.qty; record.project=e.changes.project; record.committee=e.changes.committee; }
    else record.deleted=e.type==='RECORD_DELETE';
    record.recordRevision=(record.recordRevision || 0)+1;
  });
  records.forEach(function(r) {
    r.ownerKey = r.ownerKey || 'member:' + r.idNum;
    r.reference = r.reference || invLookupReference_(r.caseType === 'BORROWING' ? 'BR' : 'CO', r.recordId);
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
  var actor = p.actor || invUnverified_(p.idNumber), owner = actor.member.idNumber, qty = invQty_(p.qty);
  var records = invHistory_().filter(function(r) { return r.recordId === p.borrowId; });
  if (records.length !== 1) throw invError_('Borrowing record not found. Contact SUS.');
  var rec = records[0];
  if (rec.caseType !== 'BORROWING' || rec.deleted || !rec.returnable || !(invOwns_(actor, rec) || invManagesProject_(actor, rec.project))) throw invError_('Only the borrower, a verified project member or an admin can return this active record.');
  if (qty > rec.outstandingQty) throw invError_('Return exceeds the outstanding quantity. Refresh History.');
  return invAppendEvent_({ownerKey: actor.ownerKey, verified: actor.verified, accountKind: actor.accountKind, guestCode: actor.guestCode || '', name: actor.member.name, email: actor.member.email, reference: invReference_('RT', 'RETURN-' + p.clientId), borrowReference: rec.reference, onBehalfOf: rec.idNum, borrowerName: rec.name || '', type: 'RETURN', clientId: p.clientId, idNumber: owner, borrowId: rec.recordId, qty: qty,
    time: new Date().toISOString(), item: rec.item, project: rec.project, committee: rec.committee,
    request: invRequestFingerprint_(p, 'RETURN'), result: {remaining: rec.outstandingQty - qty}});
}
function invRecordChange_(action, p) {
  var type = action === 'recordEdit' ? 'RECORD_EDIT' : action === 'recordDelete' ? 'RECORD_DELETE' : 'RECORD_RESTORE';
  var replay = invReplay_(p, type); if (replay) return replay;
  var actor = p.actor, rec = invHistory_().find(function(r) { return r.recordId === p.recordId; });
  if (!rec || !invManagesProject_(actor, rec.project)) throw invError_('Verified project membership or admin access is required.', 'FORBIDDEN');
  if ((rec.recordRevision || 0) !== p.expectedRevision) throw invError_('This record changed. Refresh History before continuing.', 'CONFLICT');
  var changes = null;
  if (type === 'RECORD_EDIT') {
    if (!actor.admin || rec.deleted) throw invError_('Only an admin can edit an active record.', 'FORBIDDEN');
    changes = {qty:invQty_(p.changes && p.changes.qty), project:invText_(p.changes && p.changes.project).slice(0,200), committee:invText_(p.changes && p.changes.committee).slice(0,200)};
    if (!changes.project || changes.qty < Number(rec.returnedQty || 0)) throw invError_('Quantity cannot be below confirmed returns and project cannot be blank.');
  } else if (!!rec.deleted === (type === 'RECORD_DELETE')) throw invError_('This record already has that state. Refresh History.', 'CONFLICT');
  return invAppendEvent_({type:type,clientId:p.clientId,idNumber:actor.member.idNumber,ownerKey:actor.ownerKey,verified:true,accountKind:actor.accountKind,name:actor.member.name,email:actor.email,time:new Date().toISOString(),recordId:rec.recordId,project:rec.project,changes:changes,before:{qty:rec.qty,project:rec.project,committee:rec.committee,deleted:!!rec.deleted},request:invRequestFingerprint_(p,type),result:{recordId:rec.recordId,recordRevision:(rec.recordRevision || 0)+1}});
}
function invProjectRecordChange_(e) {
  var record = invHistory_().find(function(r) { return r.recordId === e.recordId; }); if(!record)return;
  var sheet=invSheet_(record.caseType==='BORROWING'?'Borrow':'Consume');
  if(sheet.getMaxColumns()<15)sheet.insertColumnsAfter(sheet.getMaxColumns(),15-sheet.getMaxColumns());
  var header=sheet.getRange(1,15).getValue(); if(header && header!=='History status')throw invError_('History status column is occupied.');
  sheet.getRange(1,15).setValue('History status');
  if(sheet.getLastRow()<2)return;
  sheet.getRange(2,10,sheet.getLastRow()-1,1).getValues().forEach(function(r,i) { if(r[0]!==record.recordId)return;
    if(e.type==='RECORD_EDIT') { sheet.getRange(i+2,3,1,3).setValues([[record.qty,invSafeCell_(record.project),invSafeCell_(record.committee)]]); if(record.caseType==='BORROWING')sheet.getRange(i+2,9).setValue(record.resolved); }
    sheet.getRange(i+2,15).setValue(record.deleted?'Deleted (restorable)':'Active');
  });
}
function invSafeCell_(v) { var s = String(v == null ? '' : v); return /^[=+@-]/.test(s) ? "'" + s : s; }
function invProjectEvent_(e) {
  if (e.type.indexOf('RECORD_') === 0) return invProjectRecordChange_(e);
  var name = e.type === 'RETURN' ? 'Return' : (e.caseType === 'BORROWING' ? 'Borrow' : 'Consume');
  var sheet = invSheet_(name), existing = {};
  if (sheet.getLastRow() > 1) sheet.getRange(2, 10, sheet.getLastRow() - 1, 1).getValues().forEach(function(row) { existing[row[0]] = true; });
  var lines = e.type === 'RETURN' ? [{recordId: 'RETURN-' + e.clientId, item: e.item, qty: e.qty}] : e.lines;
  lines.forEach(function(line) {
    if (existing[line.recordId]) return;
    var member = {name: e.name || '', email: e.email || ''};
    sheet.appendRow([new Date(e.time), invSafeCell_(line.item), line.qty, invSafeCell_(e.project), invSafeCell_(e.committee), e.idNumber, invSafeCell_(member.name), invSafeCell_(member.email), false, line.recordId, e.borrowId || '', e.clientId, line.reference || e.reference || invReference_(name === 'Return' ? 'RT' : name === 'Borrow' ? 'BR' : 'CO', line.recordId), e.borrowReference || '']);
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
      if (!invText_(row[1]) || invMetadataId_(row[11], 'client')) return; // V2 projected rows already have a client ID.
      var recordId = invMetadataId_(row[9], 'record') || 'LEGACY-' + Utilities.getUuid();
      if (!invMetadataId_(row[9], 'record')) s.getRange(i + 2, 10).setValue(recordId);
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
function invGoogleUser_(idToken) {
  if (!idToken) throw invError_('School Google sign-in is required.', 'UNAUTHORIZED');
  var key = PropertiesService.getScriptProperties().getProperty('SUPABASE_PUBLISHABLE_KEY') || MEA_INV.supabasePublishableKey;
  if (!key) throw invError_('Supabase school sign-in has not been configured.', 'SETUP_REQUIRED');
  var response = UrlFetchApp.fetch('https://gxffeavbefmmycmvccsm.supabase.co/auth/v1/user', {
    method: 'get', headers: {apikey: key, Authorization: 'Bearer ' + idToken}, muteHttpExceptions: true});
  var user;
  try { user = JSON.parse(response.getContentText()) || {}; } catch (_) { throw invError_('School identity service unavailable. Try again.', 'AUTH_UNAVAILABLE'); }
  var email = invText_(user.email).toLowerCase();
  var google = (user.identities || []).find(function(i) {
    return (i.provider === 'email' || i.provider === 'google' && i.identity_data && i.identity_data.email_verified === true) && i.identity_data && invText_(i.identity_data.email).toLowerCase() === email;
  });
  if (response.getResponseCode() !== 200 || !user.id || !user.email_confirmed_at || !google || user.banned_until && new Date(user.banned_until).getTime() > Date.now()) throw invError_('Verify your school Google account again.', 'UNAUTHORIZED');
  return {localId: user.id, email: email, displayName: invText_(google.identity_data.full_name || google.identity_data.name || user.user_metadata && user.user_metadata.full_name || email.split('@')[0]).slice(0,200), emailVerified: true};
}
function invIdentity_(idToken) { return invResolveAccount_(idToken); }
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
  // UID is the verified draft owner; member linkage may legitimately change.
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
  if (event.type.indexOf('RECORD_') === 0) return;
  var member = event.verified ? {name: event.name, email: event.email} : invMemberById_(event.idNumber);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) return;
  var action = event.type === 'RETURN' ? 'Return' : event.caseType === 'BORROWING' ? 'Borrow' : 'Consume';
  var lines = event.type === 'RETURN' ? [{item: event.item, qty: event.qty}] : event.lines;
  var text = 'Hi ' + (member.name || 'there') + ',\n\nThis confirms your MEA Inventory ' + action.toLowerCase() + ' request:\n\n' + lines.map(function(l) { return (l.reference || event.reference || '') + ' ' + l.item + ' × ' + l.qty; }).join('\n') + '\n\nProject/Dept: ' + event.project + '\nAccount: ' + (event.accountKind === 'GUEST' ? 'Guest ' + event.guestCode : 'Member') + (event.type === 'RETURN' ? '\nOriginal borrow: ' + (event.borrowReference || '') + '\nRemaining: ' + event.result.remaining : '') + '\nCommittee: ' + event.committee + '\nDate: ' + event.time + '\n\nIf anything looks wrong, contact the SUS team.\n— MEA Inventory';
  GmailApp.sendEmail(member.email, 'MEA Inventory Receipt — ' + action, text, {name: 'MEA Inventory'});
}
