# SUSCart workflow deployment

The frontend changes are implemented, with a separate versioned room-inventory Apps Script. The live app, deployed Apps Script, and production workbook have not been changed by this implementation.

## Run and verify locally

No build step or package installation is required. From this checkout:

```
node --test tests/*.test.js
node tests/serve-workflow-fixture.js
```

Open http://127.0.0.1:8765 and use sample ID `100001` or `100002`. This isolated fixture intercepts Google requests and uses sample records. It never submits to the production spreadsheet. The fixture's Google connection is simulated, not real authentication. Do not deploy the fixture server.

Verified with 27 Node tests and an isolated Chromium preview: explicit Borrow/Consume selection, both actions for one item, cart restoration after reload, grouped checkout, and partial return from History. Backend tests mock Apps Script services. Physical iPhone/Android installation, real Google authentication, and Apps Script execution against a copied workbook still require deployment verification.

## Backend deployment order

1. Copy the inventory workbook and keep its existing data, formats, and validation. Copy the existing Apps Script project or create a separate staging project. Preserve its original `Code.gs` and deployment version for rollback.
2. Replace the staging inventory code with `apps-script/inventory-v2.gs`. Do not paste it into the ID Tracker project, and do not keep two files defining `doGet`/`doPost`.
3. Set `INVENTORY_SPREADSHEET_ID` to the COPY's ID before running any function. Set `TRACKER_SPREADSHEET_ID` to the existing roster ID. The code's production defaults are documented constants; never run setup with defaults while testing.
4. Run `setupInventoryV2()` in staging. This preserves inventory A:F and transaction A:I, adds inventory permanent IDs in G, transaction references in J:L, and three hidden tabs (`_MEA_EVENTS`, `_MEA_DRAFTS`, `_MEA_LEGACY`). Existing names, emails, return checkboxes, and rows remain intact. Repeat setup after adding new inventory rows without IDs; retain IDs when sorting entire rows.
5. Deploy the staging script as a web app under the existing access policy. Set the preview's Inventory Script URL to the staging `/exec` URL. Test submission, identical retries, partial/full returns, and projection repair against the copied workbook. Receipts are sent to roster emails, as in the old script; use a test roster with test recipients for staging.
6. After staging passes, apply the same code/setup to the production inventory project and workbook, publish a new version on the existing deployment, and verify `?action=inventory` returns `version: 2` and permanent `id` values. Keep the existing `/exec` URL. Then deploy the frontend files and service worker together. Never release the frontend's return feature against the old backend.

### Existing requests and history

Legacy Borrow and Consume rows receive stable record references. Existing resolved Borrow checkboxes remain resolved. Unresolved legacy borrows are displayed but are not returnable until an officer inspects the old Return rows and runs `reconcileLegacyBorrow(recordId, confirmedReturnedQty)` from the script editor. This utility is not available through the public endpoint. No title-based guess links historical returns to borrows.

The journal is authoritative for NEW submissions and returns. Borrow/Consume/Return tabs remain visible projections. If a projection write fails, `repairInventoryProjections()` restores missing rows without duplicating journal events. New full returns update the Borrow tab's existing resolved checkbox. Edit/correct new transactions through a reviewed backend change rather than editing journal JSON by hand.

Quantities are advisory, as in the current logging backend; submitting a request does not reserve stock or automatically deduct catalog quantities. `*` and unit-bearing quantities are displayed as unknown exact counts. No due dates or reminder policy is introduced.

Pre-upgrade device drafts with legacy identifiers may need item reselection after permanent IDs arrive. Removed or unmatched items stay flagged in the cart until removed; they are never rebound by row position. Old queued submissions with obsolete IDs must be reviewed rather than silently mapped to an ambiguous item.

## Optional Google connection

ID-only login and inventory submission continue to work. Their carts stay on that device. ID numbers are identifiers rather than proof of identity; ID-only transactions and return ownership checks cannot prevent someone who knows another member's ID from impersonating that ID. Verified cloud drafts are separately protected.

1. In an MEA-owned Firebase project, enable Authentication > Google and authorize the deployed app's domain (and localhost for development). No Firestore database is needed; drafts live in Sheets behind Apps Script.
2. Put the project's public web-app configuration in `app-config.js` under `MEA_CONFIG.firebase` (`apiKey`, `authDomain`, `projectId`, `appId`, and other supplied public fields). Put the matching API key in the inventory script property `FIREBASE_WEB_API_KEY`. Never add service-account keys or tokens to this repository.
3. Verify the member roster has labeled ID and school-email columns. The backend validates the Firebase token with Google's accounts lookup API, requires a verified Google provider, and matches the email to exactly one member. It ignores client-supplied account IDs for cloud authorization.
4. Test a matching school account, an unknown email, duplicate roster emails, an expired session, popup cancellation, and a different member's connected Google account. School Workspace policy may require administrator approval; ID-only entry remains available.
5. Test local/cloud version choice on first connection, a simultaneous edit from another device, offline edits/reconnection, and logout/account switching. Firebase remembers a valid sign-in; after reload the app verifies its roster match before restoring sync. Google sign-in alone grants no officer privileges.

Cloud draft API: POST `googleMember`, `cartRead`, `cartWrite`, with Firebase `idToken` in the JSON body. `cartWrite` requires `expectedRevision`; a stale revision returns `code: CONFLICT` without changing the draft. The UI asks which version to retain. Cloud sync failures retain the local copy.

Transaction API: POST `submitOrder` with immutable `clientId`, `idNumber`, `caseType`, `project`, `committee`, and item entries; POST `returnItems` with immutable `clientId`, `idNumber`, `borrowId`, and `qty`. Server validation and script locks protect journal writes and outstanding balances. Permanent validation failures return `retryable: false`; transport/server failures remain retryable. Retried committed operations do not create another row or receipt. Receipt failures do not undo transactions; receipts are best effort.

## Rollback

Restore the previous frontend release and Apps Script deployment version together. Preserve added columns and journal tabs to retain audit data. Do not delete them or undo confirmed returns by clearing their rows. Existing cached clients may need one refresh after the service-worker upgrade.
