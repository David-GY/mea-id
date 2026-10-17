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

SUS authorized treating unresolved legacy loans as fully unreturned on October 17, 2026. Imported borrowing snapshots with zero recorded returns and a valid whole borrowed quantity from 1 to 9999 now enter the normal return flow. The starting balance is explicitly labeled assumed unreturned, pending verification. Completed loans, previously reconciled balances, deleted records and malformed quantities are not reopened. Historical Return rows are never matched by title.

History retains a read-only review queue for legacy loans still blocked. SUS admins can select Project → All records (Admin) to review all authorized history; personal and project scopes remain unchanged. Eligible assumed loans appear in Outstanding borrows with the existing partial/full return controls and permission checks. New returns use the existing journal, stable borrow IDs and duplicate-safe retry IDs; each return event records whether its baseline was assumed. Original `_MEA_LEGACY` snapshots are unchanged. Returns append normal Return rows and update the original Borrow resolved checkbox on completion. Tests performed on the live app therefore create real transactions. Offline entries are explicitly last-synced data.

Deploy the updated inventory backend before the frontend; no setup or migration utility is needed. Existing cached history may show the old blocked state until it refreshes online. Reverting the backend blocks unreconciled loans again but retains their new journal returns. Before subsequently using `reconcileLegacyBorrow`, inspect both historical and new returns; that utility refuses loans which already have v2 return events.

## Rollout and rollback

Deploy apps-script/inventory-v2.gs to the existing inventory project, preserving execute-as and access settings. No new setup/migration is required on an already migrated Version 9 workbook. Run integration tests on a copy with receipts suppressed. Publish backend before frontend; service-worker cache is mea-app-v15.

Run node --test tests/*.test.js and node tests/serve-workflow-fixture.js. The fixture intercepts service calls and must never be deployed.

Rollback to the previous frontend commit and backend Version 9 together. Retain journal events and added columns; never overwrite newer real transactions with a workbook backup. Reverting code does not undo confirmed real returns or edits.
