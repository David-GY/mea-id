# SUSCart current deployment

The app remains static on GitHub Pages, with transactions and drafts in the existing inventory Sheets journal. The ID Tracker workbook is read-only for inventory permissions.

## School authentication

Supabase project: https://gxffeavbefmmycmvccsm.supabase.co. Public configuration lives in app-config.js. The inventory backend validates each access token through the fixed project's /auth/v1/user endpoint; SUPABASE_PUBLISHABLE_KEY optionally overrides the embedded public key. Never use a service-role/secret key. Firebase is no longer used.

The app offers Google OAuth with PKCE and email link/code verification. School domain is checked on the server after Supabase confirms the email. MAIN A:C (row 2 headers, row 4 data) classifies roster members; other verified student.ateneo.edu accounts are recorded as guests. Mutable names never determine membership or privileges. UID owns the cloud cart; account switching and explicit conflict choices preserve drafts. A logout suppresses automatic session restoration even offline.

Required dashboard setup:

1. Site URL and the exact MEA redirect have been saved. Set Site URL and allowed redirect to https://david-gy.github.io/mea-id/ (the trailing path matters). Add localhost only for development.
2. Enable Google provider with the project's Google OAuth client. Its authorized callback is https://gxffeavbefmmycmvccsm.supabase.co/auth/v1/callback. Enter Google client secrets only in the Supabase console, never this repository.
3. Configure the passwordless email template to include {{ .Token }} for codes. Include a supported confirmation link for link sign-in. For a custom PKCE token-hash template, use the deployed app's confirmation handling or standard Supabase confirmation URL; do not copy a server-only /auth/confirm route onto static hosting.
4. Configure production SMTP/delivery if the default Supabase sender restricts recipients. Test a real roster member and a non-roster school guest; no synthetic emails are sent by the automated tests.

The supplied public key was verified against /auth/v1/settings. Google was disabled at inspection. The console requires custom SMTP before email templates can be edited. app-config.js emailReady is false so students receive an honest setup message; set it true only after SMTP/templates and a controlled sign-in are verified. No real authentication success is claimed until dashboard setup and end-to-end sign-in are verified.

## Inventory permissions

MAIN I:AB contains project/department membership flags. False/no/0/blank do not grant access. CBAB membership is read from the explicit CBAB roster (ID num header). ACCESS A:C controls global administration: only a unique row with Level Admin grants admin rights. Duplicate or changed permission schemas fail closed. OFFICER_EMAILS is superseded.

- ID-only members may view their assigned project histories and keep existing unverified own-return behavior. Knowing an ID is not proof of identity.
- Verified project members may record returns for their project, delete and restore its history records.
- Verified ACCESS Admin accounts may view all records and edit quantity, project and committee across projects.
- Guests see and return their own eligible loans; no tracker/admin/project membership privileges are inferred from the school domain.

Permissions are re-read for each server operation. Client flags only control presentation. Returned balances and duplicate retry identifiers remain protected under the script lock.

## History corrections

Project names match after trimming, collapsing whitespace and ignoring case. The server supplies allowed project options, including old recorded labels. Personal history stays personal; Admin may choose All records. Authorization errors are explicit and do not masquerade as offline caches.

Delete is reversible: RECORD_DELETE/RECORD_RESTORE events hide or restore records without removing original orders, returns or balances. Deleted records have a dedicated view. Restore an outstanding borrowing record before recording another return. Admin edits use RECORD_EDIT events and cannot reduce borrowed quantity below confirmed returns. Record revision checks reject concurrent changes; fixed retry IDs prevent duplicates. Actor identity and prior values are retained in the journal. Visible projections receive History status in column O only when such an action occurs.

Historical sheet transactions are retained as an archive. The app reads borrow/consume history only from the transaction journal; it does not import old sheet rows or read legacy snapshots. Legacy review, reconciliation, assumed balances and migration utilities have been removed. New borrow/consume submissions and their returns retain the existing validation, authorization and audit trail. No sheet rows are deleted or reset.

Deploy the backend before the frontend. History cache v4 discards the old cached view; existing queued requests remain subject to the normal backend record lookup. No setup or migration is needed for the existing workbook.

## Rollout and rollback

Deploy apps-script/inventory-v2.gs to the existing inventory project, preserving execute-as and access settings. No new setup/migration is required on an already migrated Version 9 workbook. Run integration tests on a copy with receipts suppressed. Publish backend before frontend; service-worker cache is mea-app-v15.

Run node --test tests/*.test.js and node tests/serve-workflow-fixture.js. The fixture intercepts service calls and must never be deployed.

Rollback to the previous frontend commit and backend Version 9 together. Retain journal events and added columns; never overwrite newer real transactions with a workbook backup. Reverting code does not undo confirmed real returns or edits.


## October 20, 2026: Special requests and app audit

Special Inventory metadata is read from its sheet tab. Checkout uses `submitSpecialRequest` separately from `submitOrder`; both accept Borrow/Consume intent but only ordinary orders send receipt emails. Special requests have SR references, their own History section and a separate Special Requests sheet, created automatically on the first request. Verified ACCESS Admin users can mark requests verified or declined with notes. Verification records manual SUS handling only; it does not create a Borrow/Consume transaction or an email. Coordinate any special-item return with SUS. Existing committed special-item orders retain their ordinary returns.

Deploy inventory Apps Script first, preserving the existing deployment settings and branded receipt templates. No setupInventoryV2 call or legacy migration is required. Frontend cache release is mea-app-v36, with caches scoped by application URL. See docs/2026-10-20-app-audit.md for repaired defects, test evidence and remaining limitations.
